import type { TFile } from "obsidian";
import type { StoreHost } from "./store/settingsSlice";
import { captureContextSources, contextSourceHash, isContextSourcePath, type CapturedContext } from "./sourceReferences";
import { personalMemoriesToMarkdown } from "./personalMemory";
import { isVaultPathExcluded } from "./privacy";

/** A read was invalidated by a source edit, distinct from permission or disposal. */
export class VaultQuerySourcesChangedError extends Error {}

export interface VaultQueryRead {
  readonly text: string;
  readonly revision: string;
  readonly sources: CapturedContext;
  readonly allowsCandidateObservation?: boolean;
  readonly hasExternalSources?: boolean;
  assertCurrent(): void;
  assertSourcesCurrent(): Promise<void>;
  dispose(): void;
}
export interface VaultQueryReader {
  read(file: TFile): Promise<string>;
  dependOn(path: string, hash: string): void;
  contributed(path: string, fragment: string, hash?: string): void;
  contributeMemory(query: string, prepared: string): Promise<void>;
}

const policy = (store: StoreHost) => JSON.stringify({ folders: store.settings.folders, privacy: store.settings.privacy, externalVaults: store.settings.externalVaults });

export async function produceVaultQueryRead(
  store: StoreHost,
  catalog: () => readonly { path: string; version: string }[],
  build: (reader: VaultQueryReader) => Promise<string>,
  allowsCandidateObservation = true
): Promise<VaultQueryRead> {
  const [{ readPersonalMemoryWithSources }, { personalMemoryContextRevision, confirmedMemoryContextSourcePaths }] = await Promise.all([
    import("./personalMemorySources"), import("./personalMemoryContext")
  ]);
  const capturedPolicy = policy(store);
  const capturedCatalog = JSON.stringify(catalog());
  const raw = new Map<string, string>();
  const hashes = new Map<string, string>();
  let disposed = false;
  const assertCurrent = () => {
    if (disposed || policy(store) !== capturedPolicy) throw Error("查询权限已变化，请重新读取。");
  };
  const allowed = (path: string) => isContextSourcePath(path) && !isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes);
  const dependOn = (path: string, hash: string) => { if (allowed(path)) hashes.set(path, hash); };
  const document = await readPersonalMemoryWithSources(store);
  const memoryRevision = personalMemoryContextRevision(document.records);
  assertCurrent();
  const sources = await captureContextSources(record => build({
    async read(file) {
      const path = file.path;
      assertCurrent();
      if (!allowed(path) || store.getFile(path)?.path !== path) throw Error("查询原文路径无效或已排除。");
      const cached = raw.get(path);
      if (cached !== undefined) return cached;
      const content = await store.app.vault.read(file);
      assertCurrent();
      if (file.path !== path) throw Error("查询原文路径已变化。");
      raw.set(path, content);
      dependOn(path, contextSourceHash(content));
      return content;
    },
    dependOn,
    contributed(path, fragment, hash) {
      if (!allowed(path)) return;
      if (hash) dependOn(path, hash);
      if (hashes.has(path)) record(path, fragment, hashes.get(path));
    },
    async contributeMemory(query, prepared) {
      for (const memory of document.records) {
        const paths = confirmedMemoryContextSourcePaths([memory], query, prepared, store.settings.privacy?.excludedVaultPrefixes);
        const rendered = personalMemoriesToMarkdown([memory], "verified");
        for (const path of paths) {
          let hash = memory.sourceRefs.find(ref => ref.path === path)?.contentHash;
          if (!hash && path !== store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json")) {
            const file = store.getFile(path);
            if (file?.path === path) hash = contextSourceHash(await store.readPath(path));
          }
          if (hash) dependOn(path, hash);
          record(path, rendered.slice(rendered.indexOf("\n") + 1), hash);
        }
      }
    }
  }));
  assertCurrent();
  const revision = contextSourceHash(JSON.stringify([capturedPolicy, capturedCatalog, [...hashes], memoryRevision, sources.text]));
  return Object.freeze({
    text: sources.text, revision, sources, allowsCandidateObservation, assertCurrent,
    dispose() { disposed = true; },
    // A mutation that depends on this read must still use the observed versions.
    async assertSourcesCurrent() {
      assertCurrent();
      if (JSON.stringify(catalog()) !== capturedCatalog) throw new VaultQuerySourcesChangedError("查询范围已变化，请重新读取后再操作。");
      for (const [path, hash] of hashes) {
        if (!allowed(path) || store.getFile(path)?.path !== path || contextSourceHash(await store.readPath(path)) !== hash) {
          throw new VaultQuerySourcesChangedError("查询原文已变化，请重新读取后再操作。");
        }
        assertCurrent();
      }
      if (personalMemoryContextRevision((await readPersonalMemoryWithSources(store)).records) !== memoryRevision) {
        throw Error("查询使用的记忆已变化，请重新读取后再操作。");
      }
      assertCurrent();
    }
  });
}
