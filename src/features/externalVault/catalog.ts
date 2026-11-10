import { fileRevision } from "../../operationIdentity";
import { isVaultPathExcluded } from "../../privacy";
import type { StoreHost, VaultIndexEntry } from "../../store/settingsSlice";
import type { LifeOpsSettings } from "../../types";
import { normalizeExternalVault, ReadOnlyExternalVault, type ExternalMarkdownFile, type ExternalVaultSettings } from "./readOnly";

export const externalPrefix = "external-vault";
export const externalSourcePath = (vault: string, path: string) => externalPrefix + "/" + vault + "/" + path;
export const defaultExternalFolders = [
  "LifeOps/Journal", "LifeOps/TradeReview", "LifeOps/Knowledge/TradeRules", "LifeOps/Knowledge/Ideas", "LifeOps/Knowledge/Courses"
];

export function externalVaultSettings(settings: Pick<LifeOpsSettings, "externalVaults">): ExternalVaultSettings[] {
  const result = new Map<string, ExternalVaultSettings>();
  for (const raw of Array.isArray(settings.externalVaults) ? settings.externalVaults : []) {
    try {
      const config = normalizeExternalVault(raw);
      if (!result.has(config.name)) result.set(config.name, config);
    } catch { /* Old or invalid settings stay inactive until fixed in the UI. */ }
  }
  return [...result.values()];
}

export function externalVaultScope(store: StoreHost): string {
  return fileRevision(JSON.stringify([store.settings.externalVaults, store.settings.folders, store.settings.privacy?.excludedVaultPrefixes]));
}

export function externalVaultReader(store: StoreHost, config: ExternalVaultSettings): ReadOnlyExternalVault {
  return new ReadOnlyExternalVault(config, store.settings.privacy?.excludedVaultPrefixes);
}

export function resolveExternalSource(store: StoreHost, reference: string) {
  const [prefix, name, ...segments] = reference.split("/");
  if (prefix !== externalPrefix || !segments.length) return undefined;
  const config = externalVaultSettings(store.settings).find(item => item.name === name);
  if (!config) return undefined;
  const reader = externalVaultReader(store, config);
  const path = segments.join("/");
  if (!reader.allows(path)) return undefined;
  return { config, path, reader };
}

export function externalCategory(settings: LifeOpsSettings, path: string): "journal" | "trade_review" | "trade_model" | "idea" | "learning" | "note" {
  const belongs = (folders: string[]) => folders.some(folder => path === folder || path.startsWith(folder + "/"));
  if (belongs([settings.folders.dailyRoot, defaultExternalFolders[0]])) return "journal";
  if (belongs([settings.folders.tradingReviews, defaultExternalFolders[1]])) return "trade_review";
  if (belongs([settings.folders.tradingModels, defaultExternalFolders[2]])) return "trade_model";
  if (belongs([settings.folders.ideas, defaultExternalFolders[3]])) return "idea";
  if (belongs([defaultExternalFolders[4]])) return "learning";
  return "note";
}

export function externalJournalRoot(settings: LifeOpsSettings, path: string): string {
  const root = settings.folders.dailyRoot;
  return path.startsWith(root + "/") ? root : defaultExternalFolders[0];
}

const indexPath = (store: StoreHost, name: string) => store.path(store.settings.folders.aiReports, "Index", "external-" + name + ".json");

export async function readExternalTitles(store: StoreHost, config: ExternalVaultSettings, files: ExternalMarkdownFile[]): Promise<Map<string, string>> {
  const path = indexPath(store, config.name);
  if (isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes) || !store.getFile(path)) return new Map();
  const doc = await store.readJson<{ scope?: string; entries?: Array<ExternalMarkdownFile & { title?: string }> }>(path, {});
  if (doc.scope !== externalVaultScope(store) || !Array.isArray(doc.entries)) return new Map();
  const current = new Map(files.map(file => [file.path, file]));
  return new Map(doc.entries.flatMap(entry => {
    const file = current.get(entry?.path);
    return file && file.mtime === entry.mtime && file.size === entry.size && typeof entry.title === "string"
      ? [[file.path, entry.title] as const] : [];
  }));
}

export async function indexedExternalVault(store: StoreHost, config: ExternalVaultSettings, now = new Date()) {
  const destination = indexPath(store, config.name);
  if (isVaultPathExcluded(destination, store.settings.privacy?.excludedVaultPrefixes)) throw Error("外部索引位置已排除。");
  const scope = externalVaultScope(store);
  const reader = externalVaultReader(store, config);
  const files = await reader.listMarkdown();
  const { extractTitle, splitKnowledgeChunks } = await import("../../store/settingsSlice");
  const entries = [];
  for (const file of files) {
    const category = externalCategory(store.settings, file.path);
    const raw = await reader.read(file.path).catch(() => undefined);
    if (raw === undefined) { entries.push({ ...file, category, unreadable: true }); continue; }
    const title = extractTitle(raw, file.path.split("/").at(-1)!.slice(0, -3));
    const entry: VaultIndexEntry = { ...file, title, category, tags: [], frontmatter: {}, summary: "" };
    const chunks = splitKnowledgeChunks(entry, raw).map(({ order, heading, keywords }) => ({ order, heading, keywords }));
    entries.push({ ...file, title, category, sha256: fileRevision(raw), chunks });
  }
  if (externalVaultScope(store) !== scope || isVaultPathExcluded(destination, store.settings.privacy?.excludedVaultPrefixes)) {
    throw Error("索引期间外部库范围已变化。");
  }
  await store.writeJson(destination, { version: 1, vaultName: config.name, generatedAt: now.toISOString(), scope, entries });
  return { name: config.name, files: entries.length, unreadable: entries.filter(entry => "unreadable" in entry).length };
}

export async function externalFilesForCategory(store: StoreHost, category: ReturnType<typeof externalCategory>) {
  const configs = externalVaultSettings(store.settings);
  const catalogs = await Promise.all(configs.map(async config => ({
    config, files: await externalVaultReader(store, config).listMarkdown().catch(() => [] as ExternalMarkdownFile[])
  })));
  return catalogs.flatMap(({ config, files }) => files.filter(file => externalCategory(store.settings, file.path) === category)
    .map(file => ({ config, file, reference: externalSourcePath(config.name, file.path) })));
}
