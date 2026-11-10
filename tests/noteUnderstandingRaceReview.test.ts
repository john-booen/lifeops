import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App, TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { memoryContentHash, personalMemorySourceAssessment, reviewPersonalMemoryRecord } from "../src/personalMemory";
import { readPersonalMemoryWithSources } from "../src/personalMemorySources";
import type { StoreHost } from "../src/store/settingsSlice";
import type { AgentActionSuggestion } from "../src/types";

vi.mock("obsidian", () => ({
  App: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  requestUrl: () => { throw new Error("Network forbidden in independent synthetic review"); }
}));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { AgentRuntime } = await import("../src/agentRuntime");
const { OperationLedger } = await import("../src/dataFoundation/operationLedger");
const { factRecoveryPath } = await import("../src/dataFoundation/factOperation");
const { runConfirmedToolAction } = await import("../src/toolRegistry");

let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
let runtime: InstanceType<typeof AgentRuntime>, live: boolean, serial = 0;
const sourcePath = "Notes/纯虚构独立来源核对.md";
const original = "纯虚构本人目前想减少同时开始的事情。\n";
const content = "纯虚构可能希望每次只开始一件事情";
const context = () => ({
  store, refreshViews: async () => {},
  assertCurrent: () => { if (!live) throw new Error("Fictional review host stopped"); }
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function settled<T>(promise: Promise<T>) {
  return promise.then(value => ({ status: "fulfilled" as const, value }), cause => ({ status: "rejected" as const, cause }));
}
async function propose() {
  return runtime.executeAiToolCall({ id: `independent-note-${++serial}`, name: "propose_note_understanding", arguments: {
    path: sourcePath, candidates: [{ kind: "current_state", content, excerpt: original.trim() }]
  } }, "kimi", "只从这篇纯虚构笔记整理待本人核对的理解");
}
async function saveCandidate() {
  const result = await propose();
  expect(result.success, result.output).toBe(true);
  expect(result.actions).toHaveLength(1);
  await runConfirmedToolAction(result.actions[0], context());
  return (await store.readPersonalMemories()).records[0];
}
async function reviewCard(memoryId: string): Promise<AgentActionSuggestion> {
  const result = await runtime.executeAiToolCall({ id: `independent-review-${++serial}`, name: "review_personal_memory",
    arguments: { memoryId, decision: "confirm" } }, "kimi");
  expect(result.success, result.output).toBe(true);
  expect(result.actions).toHaveLength(1);
  return result.actions[0];
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-note-race-independent-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  live = true; runtime = new AgentRuntime(context());
  await vault.seed(sourcePath, original);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("independent fixed-source understanding race review", () => {
  it("does not acknowledge a cached versioned confirmation after its original bytes changed", async () => {
    const record = await saveCandidate(), action = await reviewCard(record.id);
    await runConfirmedToolAction(action, context());
    await vault.seed(sourcePath, `${original}纯虚构第二版已更正上面想法。\n`);
    const writes = vault.writes.length;
    const outcome = await settled(runConfirmedToolAction(action, context()));
    const current = (await readPersonalMemoryWithSources(store)).records.find(item => item.id === record.id)!;
    expect(current[personalMemorySourceAssessment]?.usable).toBe(false);
    expect(vault.writes).toHaveLength(writes);
    expect(outcome.status, "old fixed-source card must not return confirmation success from its durable cache").toBe("rejected");
  });

  it("withholds newly active memory while the post-audit final source guard can still cancel it", async () => {
    const record = await saveCandidate(), action = await reviewCard(record.id);
    const entered = deferred(), release = deferred();
    let auditVerified = false, paused = false;
    const verify = OperationLedger.prototype.verify;
    vi.spyOn(OperationLedger.prototype, "verify").mockImplementation(async function(this: InstanceType<typeof OperationLedger>, ...args) {
      const result = await verify.apply(this, args);
      if (args[0] === `confirmed:${action.id}`) auditVerified = true;
      return result;
    });
    const read = vault.read.bind(vault);
    vi.spyOn(vault, "read").mockImplementation(async (file: TFile) => {
      const raw = await read(file);
      if (auditVerified && !paused && file.path === sourcePath) {
        paused = true; entered.resolve(); await release.promise;
      }
      return raw;
    });
    const saving = settled(runConfirmedToolAction(action, context()));
    let visible = "";
    try {
      await Promise.race([entered.promise, saving.then(() => { throw new Error("Expected final-source guard pause was not reached"); })]);
      visible = await store.buildPersonalMemoryContext(content);
      live = false;
    } finally { release.resolve(); }
    const outcome = await saving;
    expect(outcome.status).toBe("rejected");
    expect((await store.readPersonalMemories()).records.find(item => item.id === record.id)?.status).toBe("candidate");
    expect(visible, "this public fact was exposed before the same confirmation rolled back").not.toContain(content);
  });


  it("does not release a new raw-excerpt card if privacy changes during its final pending check", async () => {
    await saveCandidate();
    const wal = factRecoveryPath(store), read = vault.read.bind(vault);
    let walReads = 0;
    vi.spyOn(vault, "read").mockImplementation(async (file: TFile) => {
      const raw = await read(file);
      if (file.path === wal && ++walReads === 2) store.settings.privacy!.excludedVaultPrefixes = [sourcePath];
      return raw;
    });
    const result = await propose();
    expect(walReads).toBeGreaterThanOrEqual(2);
    expect(result.success, "the final pending check must not release newly excluded source material").toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.output).not.toContain(original.trim());
  });



  it("rejects an external memory edit in the post-WAL source wait and preserves the conflicting bytes", async () => {
    const record = await saveCandidate(), action = await reviewCard(record.id);
    const entered = deferred(), release = deferred();
    let auditVerified = false, paused = false;
    const verify = OperationLedger.prototype.verify;
    vi.spyOn(OperationLedger.prototype, "verify").mockImplementation(async function(this: InstanceType<typeof OperationLedger>, ...args) {
      const result = await verify.apply(this, args);
      if (args[0] === `confirmed:${action.id}`) auditVerified = true;
      return result;
    });
    const read = vault.read.bind(vault);
    vi.spyOn(vault, "read").mockImplementation(async (file: TFile) => {
      const raw = await read(file);
      if (auditVerified && !paused && file.path === sourcePath) {
        paused = true; entered.resolve(); await release.promise;
      }
      return raw;
    });
    const saving = settled(runConfirmedToolAction(action, context()));
    let externalRaw = "";
    try {
      await Promise.race([entered.promise, saving.then(() => { throw new Error("Expected post-WAL source guard pause was not reached"); })]);
      const external = JSON.parse(await vault.bytes(store.personalMemoryPath()));
      const target = external.records.find((item: { id: string }) => item.id === record.id);
      target.content = "纯虚构外部修改后的理解，不可当作原卡确认";
      target.confirmationReceipt.contentHash = memoryContentHash(target.content);
      externalRaw = `${JSON.stringify(external, null, 2)}\n`;
      await vault.seed(store.personalMemoryPath(), externalRaw);
    } finally { release.resolve(); }
    const outcome = await saving;
    expect(outcome.status, "the source guard must not acknowledge a Fact whose memory entry changed externally").toBe("rejected");
    expect(await vault.bytes(store.personalMemoryPath())).toBe(externalRaw);
    const wal = JSON.parse(await vault.bytes(factRecoveryPath(store)));
    expect(wal).toMatchObject({ status: "pending", rollbackRequired: true });
    const projection = await settled(store.buildPersonalMemoryContext(content));
    expect(projection.status === "fulfilled" ? projection.value : "").not.toContain("纯虚构外部修改后的理解");
  });

  it("keeps a fresh module reader behind the old bundle's final source guard on the same Vault", async () => {
    const record = await saveCandidate(), action = await reviewCard(record.id);
    const entered = deferred(), release = deferred();
    let auditVerified = false, paused = false;
    const verify = OperationLedger.prototype.verify;
    vi.spyOn(OperationLedger.prototype, "verify").mockImplementation(async function(this: InstanceType<typeof OperationLedger>, ...args) {
      const result = await verify.apply(this, args);
      if (args[0] === `confirmed:${action.id}`) auditVerified = true;
      return result;
    });
    const read = vault.read.bind(vault);
    vi.spyOn(vault, "read").mockImplementation(async (file: TFile) => {
      const raw = await read(file);
      if (auditVerified && !paused && file.path === sourcePath) {
        paused = true; entered.resolve(); await release.promise;
      }
      return raw;
    });
    const saving = settled(runConfirmedToolAction(action, context()));
    let visible = "", freshPending = false;
    try {
      await Promise.race([entered.promise, saving.then(() => { throw new Error("Expected old-bundle guard pause was not reached"); })]);
      vi.resetModules();
      const freshFact = await import("../src/dataFoundation/factOperation");
      const freshStoreModule = await import("../src/store");
      const freshStore = new freshStoreModule.LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
      freshPending = await freshFact.hasPendingFactOperation(freshStore);
      visible = await freshStore.buildPersonalMemoryContext(content);
      live = false;
    } finally { release.resolve(); }
    const outcome = await saving;
    expect(outcome.status).toBe("rejected");
    expect((await store.readPersonalMemories()).records.find(item => item.id === record.id)?.status).toBe("candidate");
    expect(freshPending, "a reload must see the old in-process operation even when durable WAL already says committed").toBe(true);
    expect(visible).not.toContain(content);
  });
});
