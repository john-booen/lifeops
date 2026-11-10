import { TFolder } from "obsidian";
import { truncateContext } from "./agentContext";
import { contextSourceHash, isContextSourcePath } from "./sourceReferences";
import { isVisualCachePath, isVaultPathExcluded } from "./privacy";
import { createPersonalMemorySourceFilter, MEMORY_CONTEXT_OMISSION } from "./personalMemoryContext";
import { readPersonalMemoryWithSources } from "./personalMemorySources";
import { sanitizeVoiceAgentConversationContext, type StoreHost } from "./store/settingsSlice";

export interface RecentMarkdownFile { readonly path: string; readonly hash: string; readonly chunk: string; readonly contributes: boolean }
export interface RecentMarkdownSnapshot { readonly folder: string; readonly limit: number; readonly maxChars: number; readonly text: string; readonly files: readonly RecentMarkdownFile[] }
function candidates(store: StoreHost, folder: string) {
  if (!isContextSourcePath(folder)) return [];
  const directory = store.app.vault.getAbstractFileByPath(folder);
  if (!(directory instanceof TFolder) || directory.path !== folder) return [];
  return store.collectMarkdownFiles(directory, 2).filter(file => isContextSourcePath(file.path)
    && file.path.startsWith(folder + "/") && store.getFile(file.path)?.path === file.path
    && !isVisualCachePath(file.path, store.settings.folders.aiReports)
    && !isVaultPathExcluded(file.path, store.settings.privacy?.excludedVaultPrefixes)
    && (![store.settings.folders.ideas, store.settings.folders.tradingModels].includes(folder) || !file.path.startsWith(folder + "/每日记录/")))
    .sort((a, b) => b.stat.mtime - a.stat.mtime || a.path.localeCompare(b.path));
}

export async function readRecentMarkdownSnapshot(store: StoreHost, folder: string, limit: number, maxChars: number): Promise<RecentMarkdownSnapshot> {
  const files: RecentMarkdownFile[] = [];
  const protect = createPersonalMemorySourceFilter((await readPersonalMemoryWithSources(store)).records, store);
  for (const file of candidates(store, folder).slice(0, limit)) {
    const path = file.path;
    const raw = await store.app.vault.read(file);
    if (file.path !== path || isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)) continue;
    const text = protect(path, raw), body = truncateContext(text, maxChars);
    const rawNormalized = raw.replace(/\n{3,}/g, "\n\n").trim();
    const contributes = body.split(/\n\s*\n/).some(block => block !== MEMORY_CONTEXT_OMISSION && !block.startsWith("...[truncated ")
      && !!sanitizeVoiceAgentConversationContext(block) && rawNormalized.includes(block));
    files.push({ path, hash: contextSourceHash(raw), chunk: text.trim() ? `### ${path}\n\n${body}` : "", contributes });
  }
  return { folder, limit, maxChars, text: files.map(file => file.chunk).filter(Boolean).join("\n\n"), files };
}
