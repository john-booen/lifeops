import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import { factRecoveryPath, runFactOperation } from "../src/dataFoundation/factOperation";
import * as operations from "../src/dataFoundation/factOperation";
import { runDerivedOperation } from "../src/dataFoundation/derivedOperation";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), requestUrl: () => { throw Error("No network"); } }));
const { LifeOpsStore } = await import("../src/store"), { DiskVault } = await import("./helpers/diskVault"), { AgentRuntime } = await import("../src/agentRuntime");
const { assertNoteUnderstandingReadResult, noPendingNoteUnderstanding } = await import("../src/noteUnderstandingSource");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>, live: boolean, serial = 0;
const path = "Notes/2026-10-09晚.md", raw = "纯虚构知识：先核对原文，再整理练习。\n";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
const context = () => ({ store, refreshViews: async () => {}, assertCurrent: () => { if (!live) throw Error("Fiction host stopped"); } });
const inspect = () => runtime.executeAiToolCall({ id: `fiction-derived-note-read-${++serial}`, name: "inspect_note_understanding_source", arguments: { path } }, "kimi");
async function holdDerived() {
  const entered = deferred(), release = deferred();
  const operation = runDerivedOperation(store, async scope => { await scope.writeFile(scope.vaultIndexPath(), JSON.stringify({ entries: [] })); entered.resolve(); await release.promise; });
  await entered.promise; return { release, operation };
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-note-derived-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; live = true; runtime = new AgentRuntime(context()); await vault.seed(path, raw); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
describe("fixed note reads retain safety while a live derived refresh settles", () => {
  it("waits for an actual index operation before preparing fresh raw, without creating a memory", async () => {
    const held = await holdDerived(); let settled = false; const read = inspect().then(r => { settled = true; return r; });
    try { await tick(); expect(settled).toBe(false); } finally { held.release.resolve(); await held.operation; }
    const result = await read; expect(result.success, result.output).toBe(true); expect(JSON.parse(result.output).text).toBe(raw); expect(await vault.bytes(path)).toBe(raw); expect((await store.readPersonalMemories()).records).toEqual([]);
  });
  it("retains the old token boundary when its source changes during the derived wait", async () => {
    const result = await inspect(); expect(result.success).toBe(true); const held = await holdDerived(), checked = assertNoteUnderstandingReadResult(result.output, store), rejected = expect(checked).rejects.toThrow(/变化/);
    await tick(); await vault.seed(path, raw + "纯虚构后来修改。\n"); held.release.resolve(); await held.operation; await rejected; expect(await vault.bytes(path)).toBe(raw + "纯虚构后来修改。\n");
  });
  it("rejects a retired host after waiting instead of publishing its cached body", async () => {
    const result = await inspect(); expect(result.success).toBe(true); const held = await holdDerived(), checked = assertNoteUnderstandingReadResult(result.output, store), rejected = expect(checked).rejects.toThrow(/stopped/);
    await tick(); live = false; held.release.resolve(); await held.operation; await rejected;
  });
  it.each(["derived", "fact"] as const)("never trusts a durable %s pending without private live ownership", async purpose => {
    const pending = JSON.stringify({ version: 1, operationId: "fiction-orphan-derived", purpose, status: "pending", entries: [] }); await vault.seed(factRecoveryPath(store), pending);
    await expect(noPendingNoteUnderstanding(store)).rejects.toThrow(/保存尚未结束/); expect(await vault.bytes(factRecoveryPath(store))).toBe(pending); expect(await vault.bytes(path)).toBe(raw);
    const result = await inspect(); expect(result.success).toBe(false); expect(result.output).toContain("有保存或资料整理尚未结束"); expect(result.output).not.toContain(raw);
  });
  it("does not wait for or authorize a live user-fact save", async () => {
    const entered = deferred(), release = deferred(), operation = runFactOperation(store, { operationId: "fiction-note-live-fact" }, async scope => { await scope.writeFile(scope.path(scope.settings.folders.ideas, "other.md"), "纯虚构未完成记录"); entered.resolve(); await release.promise; }, async () => {}); await entered.promise;
    try { await expect(noPendingNoteUnderstanding(store)).rejects.toThrow(/保存尚未结束/); } finally { release.resolve(); await operation; } expect(await vault.bytes(path)).toBe(raw);
  });
  it("rejects its own held derived scope instead of deadlocking", async () => {
    await runDerivedOperation(store, async scope => { await scope.writeFile(scope.vaultIndexPath(), JSON.stringify({ entries: [] })); await expect(noPendingNoteUnderstanding(scope)).rejects.toThrow(/保存尚未结束/); });
  });
  it("does not use the old token after a privacy change during its wait", async () => {
    const result = await inspect(); expect(result.success).toBe(true); const held = await holdDerived(), checked = assertNoteUnderstandingReadResult(result.output, store), rejected = expect(checked).rejects.toThrow(/范围|变化/);
    await tick(); store.settings.privacy!.excludedVaultPrefixes = [path]; held.release.resolve(); await held.operation; await rejected;
  });
  it("bounds a hung index wait without cancelling its writer or modifying its journal", async () => {
    const held = await holdDerived(), pending = await vault.bytes(factRecoveryPath(store)); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); const read = noPendingNoteUnderstanding(store), rejected = expect(read).rejects.toThrow(/资料整理仍在进行/);
    try { await tick(); await vi.advanceTimersByTimeAsync(2_001); await rejected; expect(await vault.bytes(factRecoveryPath(store))).toBe(pending); } finally { vi.useRealTimers(); held.release.resolve(); await held.operation; }
  });
  it("rejects an unknown recovery schema without touching it", async () => {
    const unknown = JSON.stringify({ version: 99, purpose: "derived", status: "pending", entries: [] }); await vault.seed(factRecoveryPath(store), unknown);
    await expect(noPendingNoteUnderstanding(store)).rejects.toThrow(); expect(await vault.bytes(factRecoveryPath(store))).toBe(unknown); expect(await vault.bytes(path)).toBe(raw);
    const result = await inspect(); expect(result.success).toBe(false); expect(result.output).toContain("所选笔记、个人记忆或读取依据"); expect(result.output).not.toContain(raw);
  });
  it("waits when a real derived writer starts inside the asynchronous pending check", async () => {
    const original = operations.hasPendingFactOperation, entered = deferred(); let held: Awaited<ReturnType<typeof holdDerived>>;
    vi.spyOn(operations, "hasPendingFactOperation").mockImplementationOnce(async host => { held = await holdDerived(); entered.resolve(); return original(host); });
    let settled = false; const read = noPendingNoteUnderstanding(store).then(() => { settled = true; }); await entered.promise;
    try { await tick(); expect(settled).toBe(false); } finally { held!.release.resolve(); await held!.operation; } await read;
  });
  it("lets a fixed token finish after index work without changing its original snapshot", async () => {
    const result = await inspect(); expect(result.success).toBe(true); const held = await holdDerived(); let settled = false; const checked = assertNoteUnderstandingReadResult(result.output, store).then(() => { settled = true; });
    try { await tick(); expect(settled).toBe(false); } finally { held.release.resolve(); await held.operation; } await checked; expect(await vault.bytes(path)).toBe(raw);
  });
  it("does not treat a failed index wait as recovered when a later edit prevents its rollback", async () => {
    const held = await holdDerived(), failed = expect(held.operation).rejects.toThrow(/变化/); const read = noPendingNoteUnderstanding(store), rejected = expect(read).rejects.toThrow(/保存尚未结束/);
    await tick(); await vault.seed(store.vaultIndexPath(), "later fictional index edit"); held.release.resolve(); await failed; await rejected;
    expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("pending"); expect(await vault.bytes(store.vaultIndexPath())).toBe("later fictional index edit"); expect(await vault.bytes(path)).toBe(raw);
  });
  it("never returns an old token while a newly queued memory save is incomplete", async () => {
    const result = await inspect(); expect(result.success).toBe(true); const held = await holdDerived(), entered = deferred(), release = deferred(); let settled = false;
    const checked = assertNoteUnderstandingReadResult(result.output, store).finally(() => { settled = true; }), rejected = expect(checked).rejects.toThrow(/变化/);
    const laterRaw = JSON.stringify({ version: 1, records: [] }), later = runFactOperation(store, { operationId: "fiction-queued-memory-save" }, async scope => { await scope.writeFile(scope.personalMemoryPath(), laterRaw); entered.resolve(); await release.promise; }, async () => {});
    held.release.resolve(); await held.operation; await entered.promise;
    try { await tick(); expect(settled).toBe(false); } finally { release.resolve(); await later; } await rejected; expect(await vault.bytes(store.personalMemoryPath())).toBe(laterRaw);
  });
  async function finishBeforePendingReturns() {
    const held = await holdDerived(), original = operations.hasPendingFactOperation;
    vi.spyOn(operations, "hasPendingFactOperation").mockImplementationOnce(async host => {
      const pending = await original(host); expect(pending).toBe(true);
      held.release.resolve(); await held.operation;
      expect(operations.activeFactOperation(store)).toBeUndefined(); return pending;
    });
  }
  it("rechecks strict current pending when the actual derived identity retired before the pending answer", async () => {
    await finishBeforePendingReturns(); await expect(noPendingNoteUnderstanding(store)).resolves.toBeUndefined();
    expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("committed"); expect(await vault.bytes(path)).toBe(raw);
  });
  it("keeps the normal public source read available after the same retired-derived edge", async () => {
    await finishBeforePendingReturns(); const result = await inspect();
    expect(result.success, result.output).toBe(true); expect(JSON.parse(result.output).text).toBe(raw); expect((await store.readPersonalMemories()).records).toEqual([]);
  });
  it("keeps an unchanged fixed token valid when its pending answer outlives the actual derived identity", async () => {
    const result = await inspect(); expect(result.success).toBe(true); await finishBeforePendingReturns();
    await expect(assertNoteUnderstandingReadResult(result.output, store)).resolves.toBeUndefined(); expect(await vault.bytes(path)).toBe(raw);
  });
  it("still rejects an old token whose source changed before the retired-derived recheck", async () => {
    const result = await inspect(); expect(result.success).toBe(true); await finishBeforePendingReturns(); await vault.seed(path, raw + "后来改写。\n");
    await expect(assertNoteUnderstandingReadResult(result.output, store)).rejects.toThrow(/变化/); expect(await vault.bytes(path)).toBe(raw + "后来改写。\n");
  });
  it("does not mistake a new orphan pending for settled work after the private derived identity retired", async () => {
    const held = await holdDerived(), original = operations.hasPendingFactOperation, orphan = JSON.stringify({ version: 1, purpose: "derived", status: "pending", operationId: "fiction-new-orphan-after-derived", entries: [] });
    vi.spyOn(operations, "hasPendingFactOperation").mockImplementationOnce(async host => { const pending = await original(host); held.release.resolve(); await held.operation; await vault.seed(factRecoveryPath(store), orphan); return pending; });
    await expect(noPendingNoteUnderstanding(store)).rejects.toThrow(/保存尚未结束/); expect(await vault.bytes(factRecoveryPath(store))).toBe(orphan); expect(await vault.bytes(path)).toBe(raw);
  });
  it("does not wait for a new live fact save that starts during the retired-derived strict recheck", async () => {
    const held = await holdDerived(), original = operations.hasPendingFactOperation, entered = deferred(), release = deferred(); let fact: Promise<unknown> | undefined;
    vi.spyOn(operations, "hasPendingFactOperation")
      .mockImplementationOnce(async host => { const pending = await original(host); held.release.resolve(); await held.operation; return pending; })
      .mockImplementationOnce(async host => { fact = runFactOperation(store, { operationId: "fiction-after-retired-derived-fact" }, async scope => { await scope.writeFile(scope.path(scope.settings.folders.ideas, "later-fact.md"), "虚构未结束事实"); entered.resolve(); await release.promise; }, async () => {}); await entered.promise; return original(host); });
    try { await expect(noPendingNoteUnderstanding(store)).rejects.toThrow(/保存尚未结束/); }
    finally { release.resolve(); if (fact) await fact; }
    expect(await vault.bytes(path)).toBe(raw);
  });

  it("still rejects a retired host before admitting the settled recheck", async () => {
    const held = await holdDerived(), original = operations.hasPendingFactOperation;
    vi.spyOn(operations, "hasPendingFactOperation").mockImplementationOnce(async host => { const pending = await original(host); held.release.resolve(); await held.operation; live = false; return pending; });
    await expect(noPendingNoteUnderstanding(store, context().assertCurrent)).rejects.toThrow(/stopped/); expect(await vault.bytes(path)).toBe(raw);
  });
  it("retains an unknown schema introduced after the real derived identity retired", async () => {
    const held = await holdDerived(), original = operations.hasPendingFactOperation, unknown = JSON.stringify({ version: 99, purpose: "derived", status: "pending", entries: [] });
    vi.spyOn(operations, "hasPendingFactOperation").mockImplementationOnce(async host => { const pending = await original(host); held.release.resolve(); await held.operation; await vault.seed(factRecoveryPath(store), unknown); return pending; });
    await expect(noPendingNoteUnderstanding(store)).rejects.toThrow(); expect(await vault.bytes(factRecoveryPath(store))).toBe(unknown); expect(await vault.bytes(path)).toBe(raw);
  });

  it.each(["initial", "retired"] as const)("does not admit a new actual fact that starts inside the %s idle WAL read", async edge => {
    if (edge === "retired") await finishBeforePendingReturns();
    else await vault.seed(factRecoveryPath(store), JSON.stringify({ version: 1, operationId: "fiction-idle-before-new-fact", status: "committed", entries: [] }));
    const originalRead = vault.read.bind(vault), entered = deferred(), release = deferred(); let started = false, operation: Promise<unknown> | undefined;
    vi.spyOn(vault, "read").mockImplementation(async file => {
      const captured = await originalRead(file);
      if (!started && file.path === factRecoveryPath(store) && !operations.activeFactOperation(store)) {
        started = true;
        operation = runFactOperation(store, { operationId: "fiction-new-live-fact-during-" + edge }, async scope => { await scope.writeFile(scope.path(scope.settings.folders.ideas, "fact-during-idle-read.md"), "虚构未结束事实"); entered.resolve(); await release.promise; }, async () => {});
        await entered.promise;
      }
      return captured;
    });
    const read = noPendingNoteUnderstanding(store); void read.catch(() => {});
    try { await entered.promise; const pending = await vault.bytes(factRecoveryPath(store)); await expect(read).rejects.toThrow(/保存尚未结束/); expect(await vault.bytes(factRecoveryPath(store))).toBe(pending); }
    finally { release.resolve(); if (operation) await operation; }
    expect(started).toBe(true); expect(await vault.bytes(path)).toBe(raw);
  });
  it.each(["initial", "retired"] as const)("waits for real derived work that starts inside the %s idle WAL read", async edge => {
    if (edge === "retired") await finishBeforePendingReturns();
    else await vault.seed(factRecoveryPath(store), JSON.stringify({ version: 1, operationId: "fiction-idle-before-new-derived", status: "committed", entries: [] }));
    const originalRead = vault.read.bind(vault), entered = deferred(), release = deferred(); let started = false, settled = false, operation: Promise<unknown> | undefined; const events: unknown[] = [];
    vi.spyOn(vault, "read").mockImplementation(async file => {
      const captured = await originalRead(file);
      if (!started && file.path === factRecoveryPath(store) && !operations.activeFactOperation(store)) {
        started = true;
        events.push({ at: "starting-new-derived", active: operations.activeFactOperation(store) });
        operation = runDerivedOperation(store, async scope => { await scope.writeFile(scope.vaultIndexPath(), JSON.stringify({ entries: [] }, null, 2)); expect(operations.activeFactOperation(store)?.purpose).toBe("derived"); events.push({ at: "new-derived-entered", active: operations.activeFactOperation(store) }); entered.resolve(); await release.promise; });
        await entered.promise; events.push({ at: "returning-old-wal", active: operations.activeFactOperation(store) });
      }
      return captured;
    });
    const read = noPendingNoteUnderstanding(store).then(() => { events.push({ at: "helper-resolved", active: operations.activeFactOperation(store) }); settled = true; }); void read.catch(() => {});
    try { await entered.promise; await tick(); expect(settled, JSON.stringify(events)).toBe(false); }
    finally { release.resolve(); if (operation) await operation; }
    await read; expect(started).toBe(true); expect(await vault.bytes(path)).toBe(raw);
  });

});
