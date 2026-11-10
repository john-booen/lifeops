import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { runDerivedOperation } from "../src/dataFoundation/derivedOperation";
import { factRecoveryPath, fileRevision, runFactOperation } from "../src/dataFoundation/factOperation";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function anotherStore() {
  return new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
}
function startInitialization(target = anotherStore()) {
  let settled = false;
  // Attach the rejection handler immediately, including on the old failing code.
  const result = target.initializeVault().then(
    () => { settled = true; return { ok: true as const }; },
    error => { settled = true; return { ok: false as const, error }; }
  );
  return { result, settled: () => settled };
}
async function diskSnapshot(folder = ""): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      snapshot[`${path}/`] = "directory";
      Object.assign(snapshot, await diskSnapshot(path));
    } else snapshot[path] = (await readFile(join(root, path))).toString("base64");
  }
  return snapshot;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-init-queue-"));
  vault = new DiskVault(root);
  store = anotherStore();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("Vault initialization distinguishes live saves from durable interruption", () => {
  it("waits for a pending derived save across Store instances before initializing", async () => {
    const source = store.path(store.settings.folders.ideas, "fiction-source.md");
    const original = "# Fictional source\n\nKeep the original user bytes.\n";
    await vault.seed(source, original);
    const entered = deferred(), release = deferred();
    const saving = runDerivedOperation(store, async scope => {
      await scope.rebuildVaultIndex();
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("pending");
    const before = await diskSnapshot(), writes = vault.writes.length;
    const initializing = startInitialization();
    try {
      await tick();
      expect(initializing.settled()).toBe(false);
      expect(await diskSnapshot()).toEqual(before);
      expect(vault.writes.length).toBe(writes);
    } finally { release.resolve(); await saving; await initializing.result; }
    expect(await initializing.result).toEqual({ ok: true });
    expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("committed");
    expect(await vault.bytes(source)).toBe(original);
    expect(store.getFile(store.personalMemoryPath())).not.toBeNull();
  });

  it("also waits for a later derived save queued while initialization is waiting", async () => {
    const firstEntered = deferred(), firstRelease = deferred();
    const secondEntered = deferred(), secondRelease = deferred();
    const first = runDerivedOperation(store, async scope => {
      await scope.writeFile(scope.vaultIndexPath(), JSON.stringify({ entries: [], marker: "first" }));
      firstEntered.resolve(); await firstRelease.promise;
    });
    await firstEntered.promise;
    const initializing = startInitialization();
    const second = runDerivedOperation(store, async scope => {
      await scope.writeFile(scope.vaultIndexPath(), JSON.stringify({ entries: [], marker: "second" }));
      secondEntered.resolve(); await secondRelease.promise;
    });
    firstRelease.resolve(); await first; await secondEntered.promise;
    const before = await diskSnapshot(), writes = vault.writes.length;
    try {
      await tick();
      expect(initializing.settled()).toBe(false);
      expect(await diskSnapshot()).toEqual(before);
      expect(vault.writes.length).toBe(writes);
    } finally { secondRelease.resolve(); await second; await initializing.result; }
    expect(await initializing.result).toEqual({ ok: true });
    expect(JSON.parse(await vault.bytes(store.vaultIndexPath())).marker).toBe("second");
  });

  it("waits for the final live guard after the disk journal says committed", async () => {
    const entered = deferred(), release = deferred();
    let checks = 0;
    const saving = runDerivedOperation(store, async scope => {
      await scope.writeFile(scope.vaultIndexPath(), JSON.stringify({ entries: [] }));
    }, { assertBeforeCommit: async () => {
      if (++checks === 2) { entered.resolve(); await release.promise; }
    } });
    await entered.promise;
    expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("committed");
    const before = await diskSnapshot(), writes = vault.writes.length;
    const initializing = startInitialization();
    try {
      await tick();
      expect(await diskSnapshot()).toEqual(before);
      expect(vault.writes.length).toBe(writes);
      expect(initializing.settled()).toBe(false);
    } finally { release.resolve(); await saving; await initializing.result; }
    expect(await initializing.result).toEqual({ ok: true });
  });

  it.each([false, true])("refuses durable pending without a live queue, leaving every byte intact (rollbackRequired=%s)", async rollbackRequired => {
    const path = store.vaultIndexPath(), before = JSON.stringify({ entries: [], marker: "original" });
    const after = JSON.stringify({ entries: [], marker: "interrupted" });
    await vault.seed(path, after);
    await vault.seed(factRecoveryPath(store), JSON.stringify({
      version: 1, operationId: "derived:fiction-interrupted", purpose: "derived", status: "pending", rollbackRequired,
      entries: [{ path, before, after, beforeHash: fileRevision(before), afterHash: fileRevision(after) }]
    }));
    const snapshot = await diskSnapshot(), writes = vault.writes.length;
    await expect(anotherStore().initializeVault()).rejects.toThrow("已暂停初始化");
    expect(await diskSnapshot()).toEqual(snapshot);
    expect(vault.writes.length).toBe(writes);
  });

  it("rechecks durable interruption when a live save ends with failed rollback", async () => {
    const path = store.vaultIndexPath();
    await vault.seed(path, JSON.stringify({ entries: [], marker: "original" }));
    const entered = deferred(), release = deferred();
    const saving = runDerivedOperation(store, async scope => {
      await scope.writeFile(path, JSON.stringify({ entries: [], marker: "failed" }));
      entered.resolve(); await release.promise;
      throw new Error("fictional save failed");
    });
    const failure = expect(saving).rejects.toThrow("fictional rollback failed");
    await entered.promise;
    const process = vault.process.bind(vault);
    vi.spyOn(vault, "process").mockImplementation(async (file, updater) => {
      if (file.path === path) throw new Error("fictional rollback failed");
      return process(file, updater);
    });
    const snapshot = await diskSnapshot(), writes = vault.writes.length;
    const initializing = startInitialization();
    release.resolve(); await failure;
    const result = await initializing.result;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("已暂停初始化");
    expect(await diskSnapshot()).toEqual(snapshot);
    expect(vault.writes.length).toBe(writes);
  });

  it("does not wait for its own guarded save scope", async () => {
    await store.initializeVault();
    const snapshot = await diskSnapshot(), writes = vault.writes.length;
    await runFactOperation(store, { operationId: "fiction-init-scope" }, async scope => {
      await scope.initializeVault();
    }, async () => undefined);
    expect(await diskSnapshot()).toEqual(snapshot);
    expect(vault.writes.length).toBe(writes);
  });
});
