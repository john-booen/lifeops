import type { StoreHost } from "./store/settingsSlice";
import { findJournalFilesForDate } from "./journalResolver";
import { contextSourceHash, isContextSourcePath } from "./sourceReferences";

export interface JournalContextFile { readonly path: string; readonly raw: string; readonly chunk: string; readonly hash: string }
export interface JournalContextSnapshot { readonly date: string; readonly policy: string; readonly text: string; readonly files: readonly JournalContextFile[] }
function policy(store: StoreHost): string { return JSON.stringify({ root: store.settings.folders.dailyRoot, excluded: store.settings.privacy?.excludedVaultPrefixes ?? [] }); }
function matches(store: StoreHost, date: string) {
  return findJournalFilesForDate(store.app.vault.getMarkdownFiles().filter(file => isContextSourcePath(file.path) && store.isManagedSourcePath(file.path))
    .map(file => ({ path: file.path, file })), store.settings.folders.dailyRoot, date);
}
function assertPolicy(store: StoreHost, captured: string): void { if (policy(store) !== captured) throw new Error("日记来源权限或目录变化，已停止旧摘要。"); }
export async function readJournalContext(store: StoreHost, date: string): Promise<JournalContextSnapshot> {
  const captured = policy(store), selected = matches(store, date), files: JournalContextFile[] = [];
  for (const match of selected) {
    assertPolicy(store, captured);
    if (!store.isManagedSourcePath(match.path) || store.getFile(match.path)?.path !== match.path) throw new Error("日记来源身份无法核对。");
    const raw = await store.readPath(match.path);
    assertPolicy(store, captured);
    if (!store.isManagedSourcePath(match.path) || store.getFile(match.path)?.path !== match.path) throw new Error("日记来源身份无法核对。");
    const chunk = !raw.trim() ? "" : selected.length > 1 ? `### ${match.file.basename}\n\n${raw}` : raw;
    files.push({ path: match.path, raw, chunk, hash: contextSourceHash(raw) });
  }
  return { date, policy: captured, text: files.map(file => file.chunk).filter(Boolean).join("\n\n"), files };
}
