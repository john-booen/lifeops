import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentRuntime } from "../src/agentRuntime";
import { OperationLedger, planLedgerRevertV1, type OperationLedgerRecord } from "../src/dataFoundation/operationLedger";
import { factRecoveryPath, fileRevision, hasInterruptedFactOperation, hasPendingFactOperation, inspectFactRecovery, recoverFactOperation, runFactOperation } from "../src/dataFoundation/factOperation";
import { encodeFactRecovery, MAX_RECOVERY_BYTES } from "../src/dataFoundation/recoveryEncoding";
import { ledgerUndoAfter } from "../src/dataFoundation/ledgerUndoRecovery";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: AgentRuntime;
const history = "原历史保留🙂".repeat(450_000);
const operationId = "fiction-ledger-delta-original", toolId = "fiction-ledger-delta-tool";
const original = "原亲写内容🙂\r\n", saved = "原亲写内容🙂\r\n已保存的补充\n";
const fresh = () => new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-ledger-delta-")); vault = new DiskVault(root); store = fresh();
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
  await vault.seed(new OperationLedger(store).filePath, JSON.stringify({ version: 1, records: [], preservedHistoricalExtension: history }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function saveFixture() {
  const paths = [store.path(store.settings.folders.ideas, "纯虚构原记录甲.md"), store.path(store.settings.folders.ideas, "纯虚构原记录乙.md")];
  for (const path of paths) await vault.seed(path, original);
  expect((await runtime.executeLocalOperation("append_notes", {}, async scope => {
    for (const path of paths) await scope.writeFile(path, saved);
  }, operationId)).success).toBe(true);
  return paths;
}
async function saveAndUndo(tool = false) {
  const paths = await saveFixture();
  if (tool) expect((await runtime.executeToolCall({ toolName: "undo_latest_operation", arguments: {}, source: "system", confirmedByUser: true, callId: toolId })).success).toBe(true);
  else await expect(runtime.undoOperation(operationId)).resolves.toBe(true);
  const walPath = factRecoveryPath(store), ledgerPath = new OperationLedger(store).filePath;
  const wire = JSON.parse(await vault.bytes(walPath)), document = inspectFactRecovery(store, await vault.bytes(walPath));
  expect(wire.version).toBe(3); expect(document.ledgerUndo?.kind).toBe("ledger-revert-v1");
  expect(document.entries.map(e => e.path).sort()).toEqual([...paths].sort());
  return { paths, walPath, ledgerPath, wire, document };
}

// Real fsync, large snapshots and subprocess recovery can exceed five seconds on hosted Intel disks.
describe("extended ledger undo", { timeout: 30_000 }, () => {
  it.each([
    ["settled", 1_550_000], ["intent-only", 1_550_000], ["intent-only", 2_620_000],
    ["ledger-finished", 1_550_000], ["cancel-after-ledger", 1_550_000]
  ] as const)("preserves the large original ledger and settles %s (%i repeats) with an old-readable journal", async (stage, repetitions) => {
    const ledgerPath = new OperationLedger(store).filePath, walPath = factRecoveryPath(store);
    const preserved = "虚构 🙂\r\n".repeat(repetitions);
    await vault.seed(ledgerPath, JSON.stringify({ version: 1, records: [], preservedHistoricalExtension: preserved }));
    const paths = await saveFixture();
    const originalLedger = await vault.bytes(ledgerPath), writes = vault.process.bind(vault);
    expect(Buffer.byteLength(originalLedger)).toBeGreaterThan(MAX_RECOVERY_BYTES);
    let pendingRaw: string | undefined;
    vault.process = (file, update) => writes(file, current => {
      const next = update(current);
      if (file.path === walPath) {
        const wire = JSON.parse(next);
        if (wire.version === 4 && wire.entries.length === paths.length) pendingRaw = next;
      }
      return next;
    });
    await expect(runtime.undoOperation(operationId)).resolves.toBe(true);
    vault.process = writes;
    expect(pendingRaw).toBeDefined();
    const pending = JSON.parse(pendingRaw!);
    expect(pending.status).toBe("pending");
    expect(pending.ledgerUndo.kind).toBe("ledger-revert-v2");
    expect(Buffer.byteLength(pendingRaw!)).toBeLessThan(MAX_RECOVERY_BYTES);
    if (stage === "settled") {
      const finalWire = { ...pending, status: "committed" };
      expect(() => inspectFactRecovery(fresh(), JSON.stringify(finalWire))).toThrow();
      const oversized = structuredClone(pending);
      oversized.ledgerUndo.before.utf8Bytes = 64 * 1024 * 1024;
      expect(() => inspectFactRecovery(fresh(), JSON.stringify(oversized))).toThrow();
    }
    if (stage !== "settled") {
      if (stage === "intent-only") {
        await vault.seed(ledgerPath, originalLedger);
        for (const path of paths) await vault.seed(path, saved);
      }
      if (stage === "cancel-after-ledger") pending.rollbackRequired = true;
      await vault.seed(walPath, JSON.stringify(pending));
      const reopened = fresh();
      expect(await hasPendingFactOperation(reopened)).toBe(true);
      expect(await hasInterruptedFactOperation(reopened)).toBe(true);
      const work = vi.fn(async () => undefined);
      await expect(runFactOperation(reopened, { operationId: "fictional-before-recovery" }, work, async () => {})).rejects.toThrow("检查并恢复未完成操作");
      expect(work).not.toHaveBeenCalled();
      const protectedLedger = await vault.bytes(ledgerPath), protectedJournal = await vault.bytes(walPath);
      const nextRuntime = new AgentRuntime({ store: reopened, refreshViews: async () => undefined });
      const nextTask = { toolName: "create_task", source: "system" as const, callId: "fictional-before-recovery", arguments: { title: "虚构暂缓任务" } };
      const started = await nextRuntime.executeToolCall(nextTask);
      expect(started.success).toBe(false);
      expect(started.output).toContain("检查并恢复未完成操作");
      const localWork = vi.fn(async () => undefined);
      const local = await nextRuntime.executeLocalOperation("local_createTask", {}, localWork);
      expect(local.output).toContain("检查并恢复未完成操作");
      expect(localWork).not.toHaveBeenCalled();
      expect(await vault.bytes(ledgerPath)).toBe(protectedLedger);
      expect(await vault.bytes(walPath)).toBe(protectedJournal);
      expect(await recoverFactOperation(reopened)).toBe(stage === "ledger-finished" ? "kept" : "restored");
      const verified = await new OperationLedger(reopened).claim({ operationId: nextTask.callId, toolName: nextTask.toolName,
        source: nextTask.source, arguments: nextTask.arguments });
      expect(verified.record.attempts).toBe(1);
      await new OperationLedger(reopened).failClaim(verified.record, "纯虚构测试结束");
    }
    const rolledBack = stage === "intent-only" || stage === "cancel-after-ledger";
    const settledRaw = await vault.bytes(walPath), terminal = JSON.parse(settledRaw);
    expect(terminal.version).toBe(1);
    expect(terminal.status).toBe(rolledBack ? "rolled_back" : "committed");
    expect(terminal.ledgerUndo).toBeUndefined();
    expect(inspectFactRecovery(fresh(), settledRaw).entries.map(entry => entry.path).sort()).toEqual([...paths].sort());
    for (const path of paths) expect(await vault.bytes(path)).toBe(rolledBack ? saved : original);
    const audit = JSON.parse(await vault.bytes(ledgerPath));
    expect(audit.preservedHistoricalExtension === preserved).toBe(true);
    expect(audit.records.find((record: OperationLedgerRecord) => record.operationId === operationId)?.status).toBe(rolledBack ? "verified" : "reverted");
    expect(await hasPendingFactOperation(fresh())).toBe(false);
  }, 90_000);

  it("settles a refused undo-tool commit and preserves the original snapshots and failed claim", async () => {
    const ledgerPath = new OperationLedger(store).filePath, walPath = factRecoveryPath(store);
    await vault.seed(ledgerPath, JSON.stringify({ version: 1, records: [], preservedHistoricalExtension: "纯虚构记录".repeat(1_120_000) }));
    const paths = await saveFixture();
    const before = JSON.parse(await vault.bytes(ledgerPath));
    const checks = vi.fn(async () => undefined).mockRejectedValueOnce(new Error("虚构提交取消"));
    const result = await runtime.executeToolCall({ toolName: "undo_latest_operation", arguments: {}, source: "system",
      confirmedByUser: true, callId: toolId }, { assertCurrent: () => undefined, assertBeforeCommit: checks });
    expect(result.success).toBe(false);
    expect(result.output).toContain("虚构提交取消");
    expect(checks).toHaveBeenCalledOnce();
    for (const path of paths) expect(await vault.bytes(path)).toBe(saved);
    const audit = JSON.parse(await vault.bytes(ledgerPath)), terminal = JSON.parse(await vault.bytes(walPath));
    expect(audit.records[0]).toEqual(before.records[0]);
    expect(audit.records.find((record: OperationLedgerRecord) => record.operationId === toolId)?.status).toBe("failed");
    expect(terminal).toMatchObject({ version: 1, status: "rolled_back", rollbackRequired: true, rollbackComplete: true });
    expect(await recoverFactOperation(fresh())).toBe("none");
  }, 90_000);
});

describe("independent ledger undo recovery base", { timeout: 30_000 }, () => {
  it.each([false, true])("normally undoes a ledger above half the limit with tool=%s, preserving history and exact original text", async tool => {
    const s = await saveAndUndo(tool);
    const delta = s.document.ledgerUndo!;
    expect(Buffer.byteLength(delta.before)).toBeGreaterThan(MAX_RECOVERY_BYTES / 2);
    expect(Object.hasOwn(delta, "after")).toBe(false);
    expect(ledgerUndoAfter(delta, s.document)).toBe(await vault.bytes(s.ledgerPath));
    for (const path of s.paths) expect(await vault.bytes(path)).toBe(original);
    const audit = JSON.parse(await vault.bytes(s.ledgerPath));
    expect(audit.preservedHistoricalExtension).toBe(history);
    expect(audit.records.find((r: any) => r.operationId === operationId).status).toBe("reverted");
    if (tool) expect(audit.records.find((r: any) => r.operationId === toolId).status).toBe("verified");
    expect(Buffer.byteLength(await vault.bytes(s.walPath))).toBeLessThanOrEqual(MAX_RECOVERY_BYTES);
    expect(await recoverFactOperation(fresh())).toBe("none");
    expect(await hasPendingFactOperation(fresh())).toBe(false);
  });

  it.each(["intent-only", "business-only", "ledger-finished", "cancel-after-ledger"])("recovers the %s durable stage in a fresh Store", async stage => {
    const s = await saveAndUndo(); s.wire.status = "pending";
    if (stage !== "ledger-finished" && stage !== "cancel-after-ledger") await vault.seed(s.ledgerPath, s.document.ledgerUndo!.before);
    if (stage === "intent-only") for (const path of s.paths) await vault.seed(path, saved);
    if (stage === "cancel-after-ledger") s.wire.rollbackRequired = true;
    await vault.seed(s.walPath, JSON.stringify(s.wire));
    const reopened = fresh(), kept = stage === "ledger-finished";
    expect(await recoverFactOperation(reopened)).toBe(kept ? "kept" : "restored");
    for (const path of s.paths) expect(await vault.bytes(path)).toBe(kept ? original : saved);
    const audit = JSON.parse(await vault.bytes(s.ledgerPath)); expect(audit.preservedHistoricalExtension).toBe(history);
    expect(audit.records.find((r: any) => r.operationId === operationId).status).toBe(kept ? "reverted" : "verified");
    expect(await hasPendingFactOperation(reopened)).toBe(false);
  });

  it.each(["later-business", "later-business-equals-before", "later-ledger", "bad-before-hash", "bad-after-hash", "bad-kind", "bad-time", "outside-path"])("rejects %s without changing any other file or releasing an audit", async kind => {
    const s = await saveAndUndo(); s.wire.status = "pending";
    if (kind === "later-business") await vault.seed(s.paths[1], "后来亲写的内容");
    if (kind === "later-business-equals-before") await vault.seed(s.paths[1], saved);
    if (kind === "later-ledger") { const audit = JSON.parse(await vault.bytes(s.ledgerPath)); audit.laterUserField = "后来编辑"; await vault.seed(s.ledgerPath, JSON.stringify(audit)); }
    if (kind === "bad-before-hash") s.wire.ledgerUndo.beforeHash = "0".repeat(64);
    if (kind === "bad-after-hash") s.wire.ledgerUndo.afterHash = "0".repeat(64);
    if (kind === "bad-kind") s.wire.ledgerUndo.kind = "ledger-revert-v2";
    if (kind === "bad-time") s.wire.ledgerUndo.timestamp = "2026-02-30T00:00:00.000Z";
    if (kind === "outside-path") s.wire.ledgerUndo.path = "../原记录.json";
    await vault.seed(s.walPath, JSON.stringify(s.wire));
    const paths = [...s.paths, s.ledgerPath, s.walPath], before = await Promise.all(paths.map(p => vault.bytes(p))), writes = vault.writes.length;
    await expect(recoverFactOperation(fresh())).rejects.toThrow();
    expect(await Promise.all(paths.map(p => vault.bytes(p)))).toEqual(before); expect(vault.writes.length).toBe(writes);
  });

  it("checks kept sources inside the native journal write boundary", async () => {
    Object.assign(vault, { adapter: { getBasePath: () => root } });
    const s = await saveAndUndo(); s.wire.status = "pending"; const raw = JSON.stringify(s.wire); await vault.seed(s.walPath, raw);
    const process = vault.process.bind(vault); let changed = false;
    vault.process = async (file, updater) => {
      if (file.path === s.walPath && !changed) { changed = true; await vault.seed(s.paths[1], "结算前后来亲写"); }
      return process(file, updater);
    };
    const ledgerBefore = await vault.bytes(s.ledgerPath);
    await expect(recoverFactOperation(fresh())).rejects.toThrow();
    expect(changed).toBe(true); expect(await vault.bytes(s.paths[0])).toBe(original); expect(await vault.bytes(s.paths[1])).toBe("结算前后来亲写");
    expect(await vault.bytes(s.ledgerPath)).toBe(ledgerBefore); expect(await vault.bytes(s.walPath)).toBe(raw);
  });

  it("keeps all rollback sources protected inside the first native ledger write", async () => {
    Object.assign(vault, { adapter: { getBasePath: () => root } });
    const s = await saveAndUndo(); s.wire.status = "pending"; s.wire.rollbackRequired = true;
    const raw = JSON.stringify(s.wire); await vault.seed(s.walPath, raw);
    const process = vault.process.bind(vault); let changed = false;
    vault.process = async (file, updater) => {
      if (file.path === s.ledgerPath && !changed) { changed = true; await vault.seed(s.paths[1], "回滚前后来亲写"); }
      return process(file, updater);
    };
    const ledgerBefore = await vault.bytes(s.ledgerPath);
    await expect(recoverFactOperation(fresh())).rejects.toThrow();
    expect(changed).toBe(true); expect(await vault.bytes(s.paths[0])).toBe(original); expect(await vault.bytes(s.paths[1])).toBe("回滚前后来亲写");
    expect(await vault.bytes(s.ledgerPath)).toBe(ledgerBefore); expect(await vault.bytes(s.walPath)).toBe(raw);
  });

  it("durably marks direct undo rollback after ledger readback failure before a simulated stop", async () => {
    const paths = await saveFixture(), ledgerPath = new OperationLedger(store).filePath, walPath = factRecoveryPath(store);
    const before = await vault.bytes(ledgerPath), read = vault.read.bind(vault), process = vault.process.bind(vault);
    let failedRead = false, durableStop = false;
    vault.read = async file => {
      const text = await read(file);
      if (!failedRead && file.path === ledgerPath && JSON.parse(text).records.find((r: any) => r.operationId === operationId)?.status === "reverted") {
        failedRead = true; throw Error("纯虚构历史读回失败");
      }
      return text;
    };
    vault.process = async (file, updater) => {
      let stop = false;
      const result = await process(file, text => {
        const next = updater(text);
        if (file.path === walPath && !durableStop) { const wire = JSON.parse(next); stop = wire.version === 3 && wire.status === "pending" && wire.rollbackRequired === true; }
        return next;
      });
      if (stop) { durableStop = true; throw Error("纯虚构停止在回滚意图落盘之后"); }
      return result;
    };
    await expect(runtime.undoOperation(operationId)).rejects.toThrow();
    expect(failedRead).toBe(true); expect(durableStop).toBe(true);
    vault.read = read; vault.process = process;
    const wire = JSON.parse(await vault.bytes(walPath)); expect(wire.status).toBe("pending"); expect(wire.rollbackRequired).toBe(true);
    expect(JSON.parse(await vault.bytes(ledgerPath)).records.find((r: any) => r.operationId === operationId).status).toBe("reverted");
    expect(await recoverFactOperation(fresh())).toBe("restored");
    expect(await vault.bytes(ledgerPath)).toBe(before); for (const path of paths) expect(await vault.bytes(path)).toBe(saved);
    expect(await hasPendingFactOperation(fresh())).toBe(false);
  });

  it.each(["missing-claim", "wrong-claim", "changed-attempts", "failed-result", "truthy-success", "missing-actions", "result-has-undo", "missing-base", "invalid-base-utf8", "base-extra-gzip-member", "base-expansion-limit", "control-limit"])("rejects v3 %s before writes or claim release", async kind => {
    const s = await saveAndUndo(true); s.wire.status = "pending";
    if (kind === "missing-claim") delete s.wire.undoToolClaim;
    if (kind === "wrong-claim") s.wire.undoToolClaim.operationId = "fiction-another-claim";
    if (kind === "changed-attempts") s.wire.undoToolClaim.attempts++;
    if (kind === "failed-result") s.wire.ledgerUndo.toolResult.success = false;
    if (kind === "truthy-success") s.wire.ledgerUndo.toolResult.success = "true";
    if (kind === "missing-actions") delete s.wire.ledgerUndo.toolResult.actions;
    if (kind === "result-has-undo") s.wire.ledgerUndo.toolResult.undo = { kind: "restore_guarded_files", files: [] };
    if (kind === "missing-base") delete s.wire.ledgerUndo.before;
    if (kind === "invalid-base-utf8") s.wire.ledgerUndo.before = "\ud800";
    if (kind === "base-extra-gzip-member") { const bytes = Buffer.from(s.wire.ledgerUndo.before.data, "base64"); s.wire.ledgerUndo.before.data = Buffer.concat([bytes, Buffer.alloc(2)]).toString("base64"); }
    if (kind === "base-expansion-limit") s.wire.ledgerUndo.before.utf8Bytes = MAX_RECOVERY_BYTES + 1;
    if (kind === "control-limit") s.wire.extra = "x".repeat(MAX_RECOVERY_BYTES);
    await vault.seed(s.walPath, JSON.stringify(s.wire));
    const paths = [...s.paths, s.ledgerPath, s.walPath], before = await Promise.all(paths.map(p => vault.bytes(p))), writes = vault.writes.length;
    await expect(recoverFactOperation(fresh())).rejects.toThrow();
    expect(await Promise.all(paths.map(p => vault.bytes(p)))).toEqual(before); expect(vault.writes.length).toBe(writes);
  });

  it.each(["foreign-schema", "wrong-version", "invalid-tombstone", "duplicate-target", "duplicate-claim"])("refuses the %s ledger base before a recovery plan can be used", async kind => {
    const s = await saveAndUndo(true), delta = s.document.ledgerUndo!, base = JSON.parse(delta.before);
    if (kind === "foreign-schema") base.schemaVersion = 1;
    if (kind === "wrong-version") base.version = 2;
    if (kind === "invalid-tombstone") base.revertedOperationHashes = ["damaged"];
    if (kind === "duplicate-target") base.records.push(structuredClone(base.records.find((r: any) => r.operationId === operationId)));
    if (kind === "duplicate-claim") base.records.push(structuredClone(base.records.find((r: any) => r.operationId === toolId)));
    const writes = vault.writes.length;
    expect(() => planLedgerRevertV1(base, operationId, delta.timestamp,
      { claim: s.document.undoToolClaim!, result: delta.toolResult! })).toThrow();
    expect(vault.writes.length).toBe(writes);
  });

  it("settles cancelled tool rollback and accepts only its exact released failed claim after reopening", async () => {
    const path = store.path(store.settings.folders.ideas, "纯虚构取消.md"); await vault.seed(path, original);
    await runtime.executeLocalOperation("append_note", {}, scope => scope.writeFile(path, saved), operationId);
    let checks = 0;
    const result = await runtime.executeToolCall({ toolName: "undo_latest_operation", arguments: {}, source: "system", confirmedByUser: true, callId: toolId }, {
      assertCurrent: () => undefined, assertBeforeCommit: async () => { if (++checks === 2) throw Error("纯虚构末次取消"); }
    });
    expect(result.success).toBe(false); expect(checks).toBe(2); expect(await vault.bytes(path)).toBe(saved);
    const walPath = factRecoveryPath(store), ledgerPath = new OperationLedger(store).filePath;
    const wire = JSON.parse(await vault.bytes(walPath)); expect(wire.version).toBe(3); expect(wire.rollbackComplete).toBe(true);
    const before = await vault.bytes(ledgerPath), audit = JSON.parse(before);
    expect(audit.records.find((r: any) => r.operationId === operationId).status).toBe("verified");
    expect(audit.records.find((r: any) => r.operationId === toolId).status).toBe("failed");
    wire.status = "pending"; await vault.seed(walPath, JSON.stringify(wire));
    expect(await recoverFactOperation(fresh())).toBe("restored"); expect(await vault.bytes(ledgerPath)).toBe(before);
    expect(await hasPendingFactOperation(fresh())).toBe(false);
  }, 90_000); // Repeated multi-megabyte ledger snapshots under coverage.

  it("retains the independent payload bound when business snapshots also consume capacity", async () => {
    const s = await saveAndUndo(), text = "A".repeat(4 * 1024 * 1024), after = "B".repeat(4 * 1024 * 1024);
    const extra = { path: store.path(store.settings.folders.ideas, "纯虚构额外载荷.md"), before: text, after,
      beforeHash: fileRevision(text), afterHash: fileRevision(after) };
    expect(() => encodeFactRecovery({ ...s.document, entries: [...s.document.entries, extra] })).toThrow("恢复记录无法安全读取");
  });

  it("journals an audit-only guarded undo through the same v3 boundary", async () => {
    const path = new OperationLedger(store).filePath, document = JSON.parse(await vault.bytes(path));
    document.records.push({ operationId, toolName: "fiction-noop", source: "system", fingerprint: "fixture", status: "verified", attempts: 1,
      arguments: {}, createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
      result: { success: true, output: "纯虚构", actions: [], undo: { kind: "restore_guarded_files", files: [] } } });
    await vault.seed(path, JSON.stringify(document)); await expect(runtime.undoOperation(operationId)).resolves.toBe(true);
    const wire = JSON.parse(await vault.bytes(factRecoveryPath(store))); expect(wire.version).toBe(3); expect(wire.entries).toEqual([]);
    expect(wire.status).toBe("committed"); expect(JSON.parse(await vault.bytes(path)).records[0].status).toBe("reverted");
  });
});
