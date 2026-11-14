import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentRuntime } from "../src/agentRuntime";
import { factRecoveryPath, fileRevision, hasInterruptedFactOperation, hasPendingFactOperation, inspectFactRecovery, recoverFactOperation } from "../src/dataFoundation/factOperation";
import type { StoreHost } from "../src/store/settingsSlice";
import { OperationLedger } from "../src/dataFoundation/operationLedger";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: AgentRuntime;
const historicalText = '"\\\n'.repeat(700_000);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-large-ledger-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
  await vault.seed(new OperationLedger(store).filePath, JSON.stringify({ version: 1, records: [], preservedHistoricalExtension: historicalText }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("undo with substantial existing history", () => {
  it("recovers recent undo headroom while retaining exact snapshots of completed reversions", async () => {
    const path = store.path(store.settings.folders.ideas, "纯虚构大账本最近记录.md");
    const id = "fiction-save-before-compaction";
    const ledgerPath = new OperationLedger(store).filePath;
    await vault.seed(path, "旧记录");
    await vault.seed(ledgerPath, JSON.stringify({ version: 1, records: [] }));
    expect((await runtime.executeLocalOperation("append_note", {}, scope => scope.writeFile(path, "新记录"), id)).success).toBe(true);
    const ledger = JSON.parse(await vault.bytes(ledgerPath));
    const oldId = "fiction-already-reverted-large";
    const saved = ledger.records[0];
    const oldUndo = { kind: "restore_file", path, content: "虚构反复记录".repeat(1_000_000), existed: true };
    ledger.records.unshift({ ...saved, operationId: oldId, status: "reverted",
      result: { ...saved.result, undo: oldUndo }, revertedAt: saved.updatedAt });
    await vault.seed(ledgerPath, JSON.stringify(ledger) + "\n");
    expect(Buffer.byteLength(await vault.bytes(ledgerPath))).toBeGreaterThan(16 * 1024 * 1024);
    const result = await runtime.executeToolCall({ toolName: "undo_latest_operation", arguments: {}, source: "system",
      confirmedByUser: true, callId: "fiction-undo-after-compaction" });
    expect(result.success, result.output).toBe(true);
    expect(await vault.bytes(path)).toBe("旧记录");
    const audit = JSON.parse(await vault.bytes(ledgerPath));
    const old = audit.records.find((record: { operationId: string }) => record.operationId === oldId);
    const raw = gunzipSync(Buffer.from(old.archivedRevertedUndo.data, "base64"));
    expect(raw.toString("utf8") === JSON.stringify(oldUndo)).toBe(true);
    expect(raw.length).toBe(old.archivedRevertedUndo.utf8Bytes);
    expect(fileRevision(raw.toString("utf8"))).toBe(old.archivedRevertedUndo.sha256);
    expect(old.result.undo).toBeUndefined();
    expect(audit.records.find((record: { operationId: string }) => record.operationId === id).status).toBe("reverted");
    const reopened = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    expect(await recoverFactOperation(reopened)).toBe("none");
    expect((await new OperationLedger(reopened).readSettledOperations([oldId, id])).reverted).toEqual(new Set([oldId, id]));
  });

  it("retains a recreated deleted note when the undo fails at its final guard, settling both audits and WAL", async () => {
    const path = store.path(store.settings.folders.ideas, "纯虚构删除撤销回滚.md"), original = "原亲写内容\r\n";
    await vault.seed(path, original);
    const id = "fiction-deleted-note-undo-rollback";
    expect((await runtime.executeLocalOperation("delete_note", {}, scope => scope.deleteFile(path), id)).success).toBe(true);
    expect(store.getFile(path)).toBeNull();
    let checks = 0;
    const result = await runtime.executeToolCall({ toolName: "undo_latest_operation", arguments: {}, source: "system",
      confirmedByUser: true, callId: "fiction-deleted-note-undo-tool" }, {
      assertCurrent: () => undefined,
      assertBeforeCommit: async () => { if (++checks === 2) throw new Error("纯虚构撤销末次检查取消"); }
    });
    expect(result.success).toBe(false);
    expect(checks).toBe(2);
    expect(store.getFile(path)).toBeNull();
    const raw = await vault.bytes(factRecoveryPath(store)), wal = inspectFactRecovery(store, raw);
    expect(wal.status).toBe("rolled_back");
    const entry = wal.entries.find(value => value.path === path)!;
    expect(entry.before).toBeNull();
    expect(entry.after).toBe(original);
    expect(entry.retained).toHaveLength(1);
    expect(await vault.bytes(entry.retained![0].path)).toBe(original);
    expect(entry.retained![0].expectedHash).toBe(fileRevision(original));
    const audit = JSON.parse(await vault.bytes(new OperationLedger(store).filePath));
    expect(audit.records.find((row: any) => row.operationId === id).status).toBe("verified");
    expect(audit.records.find((row: any) => row.operationId === "fiction-deleted-note-undo-tool").status).toBe("failed");
    expect(await hasPendingFactOperation(store)).toBe(false);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
  it("refuses an oversized direct undo before changing facts, audit or WAL, and keeps ordinary saves available", async () => {
    const path = store.path(store.settings.folders.ideas, "纯虚构容量拒绝.md");
    await vault.seed(path, "原文\r\n");
    const id = "fiction-undo-logical-capacity";
    expect((await runtime.executeLocalOperation("append_note", {}, scope => scope.writeFile(path, "已保存原文\n"), id)).success).toBe(true);
    const ledgerPath = new OperationLedger(store).filePath;
    const document = JSON.parse(await vault.bytes(ledgerPath));
    document.preservedHistoricalExtension = "x".repeat(17 * 1024 * 1024);
    await vault.seed(ledgerPath, JSON.stringify(document, null, 2) + "\n");
    const before = await vault.bytes(path), audit = await vault.bytes(ledgerPath), wal = await vault.bytes(factRecoveryPath(store));
    const writes = vault.writes.length;
    await expect(runtime.undoOperation(id)).rejects.toThrow("安全撤销容量");
    expect(await vault.bytes(path)).toBe(before);
    expect(await vault.bytes(ledgerPath)).toBe(audit);
    expect(await vault.bytes(factRecoveryPath(store))).toBe(wal);
    expect(vault.writes).toHaveLength(writes);
    const fresh = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    expect(await hasInterruptedFactOperation(fresh)).toBe(false);
    expect(await hasPendingFactOperation(fresh)).toBe(false);
    const other = fresh.path(fresh.settings.folders.ideas, "纯虚构仍可正常保存.md");
    const result = await new AgentRuntime({ store: fresh, refreshViews: async () => undefined })
      .executeLocalOperation("append_note", {}, scope => scope.writeFile(other, "新记录\n"), "fiction-save-after-capacity-refusal");
    expect(result.success).toBe(true);
    expect(await vault.bytes(path)).toBe(before);
    expect(await vault.bytes(other)).toBe("新记录\n");
    const after = JSON.parse(await vault.bytes(ledgerPath));
    expect(after.preservedHistoricalExtension).toBe(document.preservedHistoricalExtension);
    expect(after.records.find((row: any) => row.operationId === id).status).toBe("verified");
  });

  it("settles an undo tool capacity refusal without changing facts or WAL or leaving an executing claim", async () => {
    const path = store.path(store.settings.folders.ideas, "纯虚构工具容量拒绝.md");
    await vault.seed(path, "原文");
    const id = "fiction-tool-undo-logical-capacity";
    await runtime.executeLocalOperation("append_note", {}, scope => scope.writeFile(path, "已保存原文"), id);
    const ledgerPath = new OperationLedger(store).filePath, document = JSON.parse(await vault.bytes(ledgerPath));
    document.preservedHistoricalExtension = "x".repeat(17 * 1024 * 1024);
    await vault.seed(ledgerPath, JSON.stringify(document));
    const before = await vault.bytes(path), wal = await vault.bytes(factRecoveryPath(store));
    const result = await runtime.executeToolCall({ toolName: "undo_latest_operation", arguments: {}, source: "system",
      confirmedByUser: true, callId: "fiction-capacity-refused-undo-tool" });
    expect(result.success).toBe(false);
    expect(result.actions ?? []).toEqual([]);
    expect(await vault.bytes(path)).toBe(before);
    expect(await vault.bytes(factRecoveryPath(store))).toBe(wal);
    const audit = JSON.parse(await vault.bytes(ledgerPath));
    expect(audit.preservedHistoricalExtension).toBe(document.preservedHistoricalExtension);
    expect(audit.records.find((row: any) => row.operationId === id).status).toBe("verified");
    expect(audit.records.find((row: any) => row.operationId === "fiction-capacity-refused-undo-tool").status).toBe("failed");
    expect(audit.records.some((row: any) => row.status === "executing")).toBe(false);
    expect(await hasPendingFactOperation(store)).toBe(false);
  });

  it("rolls back a first small write when a later oversized snapshot is refused without poisoning the recovery journal", async () => {
    const first = store.path(store.settings.folders.ideas, "纯虚构小段.md"), large = store.path(store.settings.folders.ideas, "纯虚构大段.md");
    const originalLarge = "a".repeat(9 * 1024 * 1024);
    await vault.seed(first, "保留小段");
    await vault.seed(large, originalLarge);
    const result = await runtime.executeLocalOperation("append_note", {}, async scope => {
      await scope.writeFile(first, "修改小段");
      await scope.writeFile(large, "b".repeat(9 * 1024 * 1024));
    }, "fiction-later-snapshot-over-capacity");
    expect(result.success).toBe(false);
    expect(await vault.bytes(first)).toBe("保留小段");
    expect(await vault.bytes(large)).toBe(originalLarge);
    const wal = inspectFactRecovery(store, await vault.bytes(factRecoveryPath(store)));
    expect(wal.status).toBe("rolled_back");
    expect(wal.entries.map(entry => entry.path)).toEqual([first]);
    expect(await hasInterruptedFactOperation(store)).toBe(false);
    expect(await recoverFactOperation(store)).toBe("none");
  });

  it("does not count an identical first-write before/previous twice near the aggregate bound", async () => {
    const history='"\\\n'.repeat(950_000);
    await vault.seed(new OperationLedger(store).filePath, JSON.stringify({version:1,records:[],preservedHistoricalExtension:history}));
    const path=store.path(store.settings.folders.ideas,"纯虚构重复快照边界.md");await vault.seed(path,"原亲写内容\r\n");
    const saved=await runtime.executeLocalOperation("append_note",{},scope=>scope.writeFile(path,"原亲写内容\r\n追加\n"),"large-history-redundant-previous");
    expect(saved.success).toBe(true);await expect(runtime.undoOperation("large-history-redundant-previous")).resolves.toBe(true);
    const fresh=new LifeOpsStore({vault} as unknown as App,structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    const audit=await fresh.readJson<any>(new OperationLedger(fresh).filePath,{});expect(audit.preservedHistoricalExtension).toBe(history);
    expect(audit.records.find((r:any)=>r.operationId==="large-history-redundant-previous").status).toBe("reverted");
    expect(await vault.bytes(path)).toBe("原亲写内容\r\n");const raw=await vault.bytes(factRecoveryPath(fresh));
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(16*1024*1024);expect(inspectFactRecovery(fresh,raw).status).toBe("committed");
    expect(await recoverFactOperation(fresh)).toBe("none");
  });
  it("undoes a small note without dropping history or exceeding the physical recovery limit", async () => {
    const path = store.path(store.settings.folders.ideas, "原亲写记录.md");
    await vault.seed(path, "原亲写段落\r\n");
    const saved = await runtime.executeLocalOperation("append_note", {}, scope => scope.writeFile(path, "原亲写段落\r\n新增段落\n"), "large-history-note");
    expect(saved.success).toBe(true);
    await expect(runtime.undoOperation("large-history-note")).resolves.toBe(true);
    expect(await vault.bytes(path)).toBe("原亲写段落\r\n");
    const audit = await store.readJson<any>(new OperationLedger(store).filePath, {});
    expect(audit.preservedHistoricalExtension).toBe(historicalText);
    expect(audit.records.find((r: any) => r.operationId === "large-history-note").status).toBe("reverted");
    const raw = await vault.bytes(factRecoveryPath(store));
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(inspectFactRecovery(store, raw).status).toBe("committed");
    expect(await recoverFactOperation(store)).toBe("none");
  });
  it.each(["kept", "restored"])("reads a compressed pending undo in a fresh Store and %s the correct audit state", async expected => {
    const path = store.path(store.settings.folders.ideas, "纯虚构待恢复.md");
    await vault.seed(path, "原文\r\n");
    expect((await runtime.executeLocalOperation("append_note", {}, scope => scope.writeFile(path, "原文\r\n追加\n"), "large-history-pending")).success).toBe(true);
    await runtime.undoOperation("large-history-pending");
    const auditBefore = await vault.bytes(new OperationLedger(store).filePath);
    const wire = JSON.parse(await vault.bytes(factRecoveryPath(store)));
    expect(wire.version).toBe(2); wire.status = "pending";
    if (expected === "restored") wire.rollbackRequired = true;
    await vault.seed(factRecoveryPath(store), JSON.stringify(wire));
    const fresh = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    expect(await hasPendingFactOperation(fresh)).toBe(true);
    expect(await hasInterruptedFactOperation(fresh)).toBe(expected === "restored");
    expect(await recoverFactOperation(fresh)).toBe(expected);
    expect(await hasPendingFactOperation(fresh)).toBe(false);
    expect(await vault.bytes(path)).toBe(expected === "kept" ? "原文\r\n" : "原文\r\n追加\n");
    const audit = await fresh.readJson<any>(new OperationLedger(fresh).filePath, {});
    expect(audit.preservedHistoricalExtension).toBe(historicalText);
    expect(audit.records.find((r: any) => r.operationId === "large-history-pending").status).toBe(expected === "kept" ? "reverted" : "verified");
    if (expected === "kept") expect(await vault.bytes(new OperationLedger(fresh).filePath)).toBe(auditBefore);
    expect(Buffer.byteLength(await vault.bytes(factRecoveryPath(fresh)))).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
  it("preserves all files if a later human edit conflicts with an encoded pending rollback", async () => {
    const path = store.path(store.settings.folders.ideas, "纯虚构冲突.md");
    await vault.seed(path, "原文");
    await runtime.executeLocalOperation("append_note", {}, scope => scope.writeFile(path, "追加后的原文"), "large-history-conflict");
    await runtime.undoOperation("large-history-conflict");
    const wire = JSON.parse(await vault.bytes(factRecoveryPath(store))); wire.status = "pending"; wire.rollbackRequired = true;
    const raw = JSON.stringify(wire); await vault.seed(factRecoveryPath(store), raw);
    await vault.seed(path, "后来亲写内容");
    const audit = await vault.bytes(new OperationLedger(store).filePath);
    await expect(recoverFactOperation(store)).rejects.toThrow("停止覆盖");
    expect(await vault.bytes(path)).toBe("后来亲写内容");
    expect(await vault.bytes(new OperationLedger(store).filePath)).toBe(audit);
    expect(await vault.bytes(factRecoveryPath(store))).toBe(raw);
  });
  it("rejects an invalid plain UTF8 snapshot before touching files, audit or the WAL", async () => {
    const path = store.path(store.settings.folders.ideas, "纯虚构非法快照.md");
    await vault.seed(path, "原文");
    await runtime.executeLocalOperation("append_note", {}, scope => scope.writeFile(path, "追加后的原文"), "large-history-invalid-utf8");
    await runtime.undoOperation("large-history-invalid-utf8");
    const wire = JSON.parse(await vault.bytes(factRecoveryPath(store))); wire.status = "pending"; wire.rollbackRequired = true;
    wire.entries.find((entry: any) => entry.path === path).before = "\ud800";
    wire.entries.find((entry: any) => entry.path === path).beforeHash = fileRevision("\ud800");
    const raw = JSON.stringify(wire); await vault.seed(factRecoveryPath(store), raw);
    const audit = await vault.bytes(new OperationLedger(store).filePath), writes = vault.writes.length;
    await expect(recoverFactOperation(store)).rejects.toThrow("恢复记录无法安全读取");
    expect(await vault.bytes(path)).toBe("原文");
    expect(await vault.bytes(new OperationLedger(store).filePath)).toBe(audit);
    expect(await vault.bytes(factRecoveryPath(store))).toBe(raw);
    expect(vault.writes).toHaveLength(writes);
  });
});
