import { PHONE_INBOX_PATH } from "../features/phoneInbox/model";
import { TFile, normalizePath } from "obsidian";
import { guardDerivedMethods, guardReadonlyDerivedMethods, runDerivedOperation } from "../dataFoundation/derivedOperation";
import { isGuardedOperationScope } from "../dataFoundation/factOperation";
import { removeKnowledgeGraphSource, upsertKnowledgeGraphSource } from "../dataFoundation/knowledgeGraph";
import { RecoveryCapacityError } from "../dataFoundation/recoveryEncoding";
import {
  emptySourceManifest,
  markSourceDeleted,
  renameSource,
  sourceNeedsProcessing,
  upsertSource,
  type SourceManifest
} from "../dataFoundation/sourceManifest";
import {
  deriveSourceMemories,
  mergeSourceMemories,
  renameSourceMemoryEvidence,
  staleSourceMemories
} from "../dataFoundation/sourceMemory";
import { isVaultPathExcluded } from "../privacy";
import type {
  KnowledgeChunkIndex,
  KnowledgeGraph,
  StoreHost,
  VaultIndex,
  VaultIndexEntry,
  VectorIndex
} from "./settingsSlice";
import {
  emptyKnowledgeChunkIndex,
  emptyKnowledgeGraph,
  emptyVaultIndex,
  emptyVectorIndex,
  extractFrontmatter,
  extractTags,
  extractTitle,
  splitKnowledgeChunks,
  summarizeMarkdownForIndex
} from "./settingsSlice";

type StoreConstructor = { prototype: object };
const sourceQueues = new WeakMap<object, Promise<void>>();

export interface SourceSliceApi {
  sourceManifestPath(): string;
  readSourceManifest(): Promise<SourceManifest>;
  writeSourceManifest(manifest: SourceManifest): Promise<void>;
  isManagedSourcePath(path: string): boolean;
  upsertVaultSource(path: string): Promise<{ changed: boolean; sourceId?: string; chunks: number }>;
  removeVaultSource(path: string): Promise<boolean>;
  renameVaultSource(oldPath: string, newPath: string): Promise<boolean>;
  syncVaultSources(): Promise<{ addedOrChanged: number; deleted: number; unchanged: number }>;
}

const sourceSlice = {
sourceManifestPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Index", "source-manifest.json");
  },

async readSourceManifest(this: StoreHost): Promise<SourceManifest> {
    return this.readJson<SourceManifest>(this.sourceManifestPath(), emptySourceManifest());
  },

async writeSourceManifest(this: StoreHost, manifest: SourceManifest): Promise<void> {
    await this.writeJson(this.sourceManifestPath(), manifest);
  },

isManagedSourcePath(this: StoreHost, path: string): boolean {
    const normalized = normalizePath(path);
    const generatedRoot = normalizePath(this.settings.folders.aiReports);
    return normalized !== PHONE_INBOX_PATH && normalized.endsWith(".md")
      && normalized !== generatedRoot
      && !normalized.startsWith(`${generatedRoot}/`)
      && !isVaultPathExcluded(normalized, this.settings.privacy?.excludedVaultPrefixes);
  },

async upsertVaultSource(this: StoreHost, path: string): Promise<{ changed: boolean; sourceId?: string; chunks: number }> {
    return enqueueSourceOperation(this, () => upsertVaultSourceInternal(this, path));
  },

async removeVaultSource(this: StoreHost, path: string): Promise<boolean> {
    return enqueueSourceOperation(this, () => removeVaultSourceInternal(this, path));
  },

async renameVaultSource(this: StoreHost, oldPath: string, newPath: string): Promise<boolean> {
    return enqueueSourceOperation(this, async () => {
      const oldNormalized = normalizePath(oldPath);
      const newNormalized = normalizePath(newPath);
      const manifest = await this.readSourceManifest();
      const renamed = renameSource(manifest, oldNormalized, newNormalized);
      await removeSourceDerivatives(this, oldNormalized);
      if (renamed.entry) {
        await this.writeMemoryIndex(renameSourceMemoryEvidence(
          await this.readMemoryIndex(),
          renamed.entry.sourceId,
          oldNormalized,
          newNormalized
        ));
        await this.writeSourceManifest(renamed.manifest);
      }
      const upserted = await upsertVaultSourceInternal(this, newNormalized);
      return Boolean(renamed.entry || upserted.sourceId);
    });
  },

async syncVaultSources(this: StoreHost): Promise<{ addedOrChanged: number; deleted: number; unchanged: number }> {
    try {
      return await runDerivedOperation(this, scope => enqueueSourceOperation(scope, () =>
        syncSourceFiles(scope, path => upsertVaultSourceInternal(scope, path), path => removeVaultSourceInternal(scope, path))));
    } catch (error) {
      if (!(error instanceof RecoveryCapacityError) || isGuardedOperationScope(this)) throw error;
      // The full sync has rolled back. Keep each source and its derivatives in a
      // single recovery record so completed sources can be reused on retry.
      return syncSourceFiles(this, path => this.upsertVaultSource(path), path => this.removeVaultSource(path));
    }
  }
};

export function applySourceSlice(Store: StoreConstructor): void {
  Object.assign(Store.prototype, sourceSlice);
  guardDerivedMethods(Store.prototype, ["upsertVaultSource", "removeVaultSource", "renameVaultSource"]);
  guardReadonlyDerivedMethods(Store.prototype, ["readSourceManifest"]);
}

async function syncSourceFiles(store: StoreHost, upsert: (path: string) => Promise<{ changed: boolean }>,
  remove: (path: string) => Promise<boolean>) {
  const managedFiles = () => store.app.vault.getMarkdownFiles().filter(file => store.isManagedSourcePath(file.path));
  let manifest = await store.readSourceManifest();
  let addedOrChanged = 0;
  let deleted = 0;
  let unchanged = 0;
  for (const file of managedFiles()) {
    const existing = manifest.entries.find(entry => entry.path === file.path);
    if (!sourceNeedsProcessing(existing, file.stat)) {
      unchanged++;
      continue;
    }
    if ((await upsert(file.path)).changed) addedOrChanged++;
    else unchanged++;
    manifest = await store.readSourceManifest();
  }
  const currentPaths = new Set(managedFiles().map(file => normalizePath(file.path)));
  for (const entry of manifest.entries) {
    if (entry.status === "active" && !currentPaths.has(normalizePath(entry.path)) && await remove(entry.path)) deleted++;
  }
  return { addedOrChanged, deleted, unchanged };
}

async function enqueueSourceOperation<T>(store: StoreHost, operation: () => Promise<T>): Promise<T> {
  const key = store as object;
  const previous = sourceQueues.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  sourceQueues.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sourceQueues.get(key) === queued) sourceQueues.delete(key);
  }
}

async function upsertVaultSourceInternal(
  store: StoreHost,
  path: string
): Promise<{ changed: boolean; sourceId?: string; chunks: number }> {
  const normalized = normalizePath(path);
  if (!store.isManagedSourcePath(normalized)) return { changed: false, chunks: 0 };
  const file = store.getFile(normalized);
  if (!(file instanceof TFile) || file.extension !== "md") return { changed: false, chunks: 0 };

  const content = await store.app.vault.cachedRead(file);
  const category = store.classifyIndexCategory(file.path);
  const indexEntry = buildIndexEntry(file, content, category);
  const chunks = splitKnowledgeChunks(indexEntry, content);
  const manifest = await store.readSourceManifest();
  const sourceInput = {
    path: file.path,
    category,
    content,
    mtime: file.stat.mtime,
    size: file.stat.size,
    chunkIds: chunks.map((chunk) => chunk.id)
  };
  const upserted = upsertSource(manifest, sourceInput);
  let nextManifest = upserted.manifest;

  const index = await store.readJson<VaultIndex>(store.vaultIndexPath(), emptyVaultIndex());
  const nextEntries = [...index.entries.filter((entry) => entry.path !== file.path), indexEntry]
    .sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
  await store.writeJson(store.vaultIndexPath(), {
    generatedAt: new Date().toISOString(),
    vaultName: store.app.vault.getName(),
    totalMarkdownFiles: store.app.vault.getMarkdownFiles().filter((item) => store.isManagedSourcePath(item.path)).length,
    indexedFiles: nextEntries.length,
    entries: nextEntries
  } satisfies VaultIndex);

  const chunkIndex = await store.readJson<KnowledgeChunkIndex>(store.chunkIndexPath(), emptyKnowledgeChunkIndex());
  const currentSourceChunks = chunkIndex.chunks.filter((chunk) => chunk.path === file.path);
  if (upserted.changed || JSON.stringify(currentSourceChunks) !== JSON.stringify(chunks)) {
    const nextChunks = [...chunkIndex.chunks.filter((chunk) => chunk.path !== file.path), ...chunks];
    await store.writeJson(store.chunkIndexPath(), {
      generatedAt: new Date().toISOString(),
      chunks: nextChunks
    } satisfies KnowledgeChunkIndex);
  }

  if (upserted.changed) {
    const graph = await store.readJson<KnowledgeGraph>(store.knowledgeGraphPath(), emptyKnowledgeGraph());
    await store.writeJson(store.knowledgeGraphPath(), upsertKnowledgeGraphSource(graph, indexEntry, content, chunks));
    await removeVectorSource(store, file.path);

    const derivedMemories = deriveSourceMemories(upserted.entry, indexEntry, chunks);
    await store.writeMemoryIndex(mergeSourceMemories(
      await store.readMemoryIndex(),
      upserted.entry.sourceId,
      derivedMemories
    ));
    nextManifest = upsertSource(nextManifest, {
      ...sourceInput,
      memoryIds: derivedMemories.map((memory) => memory.id)
    }).manifest;
  }

  await store.writeSourceManifest(nextManifest);
  return {
    changed: upserted.changed,
    sourceId: upserted.entry.sourceId,
    chunks: chunks.length
  };
}

async function removeVaultSourceInternal(store: StoreHost, path: string): Promise<boolean> {
  const normalized = normalizePath(path);
  const manifest = await store.readSourceManifest();
  const deleted = markSourceDeleted(manifest, normalized);
  const existed = Boolean(deleted.entry);
  await removeSourceDerivatives(store, normalized);
  if (deleted.entry) {
    await store.writeMemoryIndex(staleSourceMemories(
      await store.readMemoryIndex(),
      deleted.entry.sourceId,
      "source deleted"
    ));
  }
  if (existed) await store.writeSourceManifest(deleted.manifest);
  return existed;
}

function buildIndexEntry(file: TFile, content: string, category: string): VaultIndexEntry {
  return {
    path: file.path,
    title: extractTitle(content, file.basename),
    category,
    tags: extractTags(content),
    frontmatter: extractFrontmatter(content),
    mtime: file.stat.mtime,
    size: file.stat.size,
    summary: summarizeMarkdownForIndex(content)
  };
}

async function removeSourceDerivatives(store: StoreHost, path: string): Promise<void> {
  const index = await store.readJson<VaultIndex>(store.vaultIndexPath(), emptyVaultIndex());
  const entries = index.entries.filter((entry) => entry.path !== path);
  await store.writeJson(store.vaultIndexPath(), {
    ...index,
    generatedAt: new Date().toISOString(),
    totalMarkdownFiles: store.app.vault.getMarkdownFiles().filter((file) => store.isManagedSourcePath(file.path)).length,
    indexedFiles: entries.length,
    entries
  } satisfies VaultIndex);

  const chunkIndex = await store.readJson<KnowledgeChunkIndex>(store.chunkIndexPath(), emptyKnowledgeChunkIndex());
  await store.writeJson(store.chunkIndexPath(), {
    generatedAt: new Date().toISOString(),
    chunks: chunkIndex.chunks.filter((chunk) => chunk.path !== path)
  } satisfies KnowledgeChunkIndex);

  const graph = await store.readJson<KnowledgeGraph>(store.knowledgeGraphPath(), emptyKnowledgeGraph());
  await store.writeJson(store.knowledgeGraphPath(), removeKnowledgeGraphSource(graph, path));
  await removeVectorSource(store, path);
}

async function removeVectorSource(store: StoreHost, path: string): Promise<void> {
  const vectorIndex = await store.readJson<VectorIndex>(store.vectorIndexPath(), emptyVectorIndex());
  if (!vectorIndex.entries.some((entry) => entry.path === path)) return;
  await store.writeJson(store.vectorIndexPath(), {
    ...vectorIndex,
    generatedAt: new Date().toISOString(),
    entries: vectorIndex.entries.filter((entry) => entry.path !== path)
  } satisfies VectorIndex);
}
