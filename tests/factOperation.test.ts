import { activityNotePath } from "../src/activityRecords";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentRuntime } from "../src/agentRuntime";
import { OperationLedger } from "../src/dataFoundation/operationLedger";
import { factRecoveryPath, fileRevision, preflightFactOperationChanges, recoverFactOperation, runFactOperation } from "../src/dataFoundation/factOperation";
import type { StoreHost } from "../src/store/settingsSlice";
import type { AiToolCall } from "../src/ai";
import { assertRecordRevision, recordRevision } from "../src/operationIdentity";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: AgentRuntime;
const date = "2026-09-09";
function note(name: string) { return store.path(store.settings.folders.ideas, `${name}.md`); }
async function operation(work: (scope: StoreHost) => Promise<unknown>, id = "test-operation") {
  return runtime.executeLocalOperation("test-user-operation", { test: true }, work, id);
}
async function ledger() { return store.readJson<any>(store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json"), { records: [] }); }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-fact-operation-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; runtime = new AgentRuntime({ store, refreshViews: async () => undefined }); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("real-file operation boundary", () => {
  it.each([1, 2])("retries one write conflict and preserves later edits (conflicts=%s)", async conflicts => {
    const path = note("retry-conflict");
    await vault.seed(path, "原文");
    let attempts = 0;
    const result = await operation(async scope => {
      const before = await scope.readPath(path);
      attempts++;
      if (attempts <= conflicts) await vault.seed(path, before + " 外部编辑" + attempts);
      await scope.writeFile(path, before + " 本次追加");
    });
    expect(attempts).toBe(2);
    expect(result.success).toBe(conflicts === 1);
    if (conflicts === 1) {
      expect(await vault.bytes(path)).toBe("原文 外部编辑1 本次追加");
      await runtime.undoOperation("test-operation");
      expect(await vault.bytes(path)).toBe("原文 外部编辑1");
    } else {
      expect(result.output).toMatch(/资料.*改动/);
      expect(await vault.bytes(path)).toBe("原文 外部编辑1 外部编辑2");
    }
  });

  it.each(["original", "", null])("keeps distinct intermediate intent and distinguishes missing/empty before=%s", async before => {
    const path = note("intermediate-intent");
    if (before !== null) await vault.seed(path, before);
    const snapshots: any[] = [], process = vault.process.bind(vault), create = vault.create.bind(vault);
    const observe = async () => snapshots.push(JSON.parse(await vault.bytes(factRecoveryPath(store))).entries.find((entry: any) => entry.path === path));
    vault.process = async (file, updater) => { if (file.path === path) await observe(); return process(file, updater); };
    vault.create = async (filePath, contents) => { if (filePath === path) await observe(); return create(filePath, contents); };
    const writes = before === null ? ["", "second", "third"] : ["first", before, "third"];
    const result = await operation(async scope => { for (const contents of writes) await scope.writeFile(path, contents); });
    expect(result.success).toBe(true); expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).toMatchObject({ before, beforeHash: fileRevision(before), after: writes[0] });
    expect(Object.hasOwn(snapshots[0], "previous")).toBe(false);
    expect(Object.hasOwn(snapshots[0], "previousHash")).toBe(false);
    expect(snapshots[1]).toMatchObject({ before, previous: writes[0], previousHash: fileRevision(writes[0]), after: writes[1] });
    expect(Object.hasOwn(snapshots[2], "previous")).toBe(before === null);
    expect(Object.hasOwn(snapshots[2], "previousHash")).toBe(before === null);
    if (before === null) expect(snapshots[2].previous).toBe(writes[1]);
    await runtime.undoOperation("test-operation");
    if (before === null) expect(store.getFile(path)).toBeNull();
    else expect(await vault.bytes(path)).toBe(before);
  });
  it("returns a failed result if a later tool's audit claim is corrupt, preserving earlier successful work", async () => {
    const first = await runtime.executeAiToolCall({ name: "create_task", arguments: { title: "给客户打电话", date } }, "kimi", "/todo 给客户打电话");
    expect(first.success, first.output).toBe(true);
    const before = await vault.bytes(store.taskDbPath());
    const path = store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
    await vault.seed(path, '{"version":2,"records":[]}');
    const second = await runtime.executeAiToolCall({ name: "create_task", arguments: { title: "整理资料", date } }, "kimi", "/todo 整理资料");
    expect(second.success).toBe(false);
    expect(await vault.bytes(store.taskDbPath())).toBe(before);
    expect(await vault.bytes(path)).toBe('{"version":2,"records":[]}');
  });
  it.each(["task", "habit"])("rejects stale %s form contents while preserving the newer record", async kind => {
    if (kind === "task") {
      const target = await store.createTask({ title: "原任务", date });
      const expected = recordRevision(target);
      await store.updateTaskDetails(target.id, { title: "后来修改的任务" });
      const before = await vault.bytes(store.taskDbPath());
      const result = await operation(async scope => {
        assertRecordRevision(await scope.getTask(target.id), expected);
        await scope.updateTaskDetails(target.id, { title: "旧表单内容" });
      });
      expect(result.success).toBe(false); expect(await vault.bytes(store.taskDbPath())).toBe(before);
    } else {
      const target = await store.createHabit({ name: "原习惯", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
      const expected = recordRevision(target);
      await store.updateHabitDetails(target.id, { name: "后来修改的习惯", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
      const before = await vault.bytes(store.habitDbPath());
      const result = await operation(async scope => {
        assertRecordRevision((await scope.getHabitDefinitions()).find(h => h.id === target.id), expected);
        await scope.updateHabitDetails(target.id, { name: "旧表单内容", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
      });
      expect(result.success).toBe(false); expect(await vault.bytes(store.habitDbPath())).toBe(before);
    }
  });
  it("keeps existing habit metadata, root extensions and full history during an ordinary checkin", async () => {
    const habit = await store.createHabit({ name: "散步", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    const database = await store.readHabitDb();
    await vault.seed(store.habitDbPath(), JSON.stringify({ ...database, extension: { keep: true }, habits: [{ ...habit, custom: "preserve" }],
      checkins: [{ habitId: habit.id, date: "2026-08-01", status: "done", count: 1, note: "old history", updatedAt: "2026-08-01T00:00:00.000Z" }] }));
    expect((await operation(scope => scope.recordHabitStatus(habit.id, "done", date))).success).toBe(true);
    const saved = JSON.parse(await vault.bytes(store.habitDbPath()));
    expect(saved.extension).toEqual({ keep: true });
    expect(saved.habits[0].custom).toBe("preserve");
    expect(saved.checkins).toHaveLength(2);
    expect(saved.checkins[0].note).toBe("old history");
  });
  it("assigns missing tool IDs per call and preserves the ID on retries", async () => {
    const call: AiToolCall = { name: "create_task", arguments: { title: "给客户打电话", date } };
    const first = await runtime.executeAiToolCall(call, "kimi", "/todo 给客户打电话");
    const retry = await runtime.executeAiToolCall(call, "kimi", "/todo 给客户打电话");
    const second = await runtime.executeAiToolCall({ name: "create_task", arguments: { title: "给客户打电话", date } }, "kimi", "/todo 给客户打电话");
    expect(first.success, first.output).toBe(true); expect(retry.success, retry.output).toBe(true); expect(second.success, second.output).toBe(true);
    expect(first.callId).toBe(retry.callId); expect(second.callId).not.toBe(first.callId);
    expect(call.id).toBe(first.callId);
    expect((await store.readTaskDb()).tasks).toHaveLength(2);
  });
  it("rolls back an entire health CSV batch if a later row fails", async () => {
    const result = await operation(async scope => {
      await scope.appendHealthEntry({ date, sleepHours: 7, note: "第一条" });
      await scope.appendHealthEntry({ date, sleepHours: 8, note: "第二条" });
      throw new Error("third CSV row failed");
    });
    expect(result.success).toBe(false);
    expect(store.getFile(store.path(store.settings.folders.health, `${date}.md`))).toBeNull();
    expect(store.getFile(store.dailyNotePath(date, "早"))).toBeNull();
  });
  it("persists the original and intended content before changing the business file", async () => {
    const path = note("existing");
    await vault.seed(path, "original\r\n");
    const process = vault.process.bind(vault);
    vault.process = async (file, updater) => {
      if (file.path === path) {
        const intent = JSON.parse(await vault.bytes(factRecoveryPath(store)));
        expect(intent.status).toBe("pending");
        expect(intent.entries[0]).toMatchObject({ path, before: "original\r\n", after: "changed", beforeHash: fileRevision("original\r\n") });
      }
      return process(file, updater);
    };
    expect((await operation(scope => scope.writeFile(path, "changed"))).success).toBe(true);
    expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("committed");
    expect((await ledger()).records[0].result.undo.kind).toBe("restore_guarded_files");
  });
  it("rolls back every file when a later business write fails", async () => {
    const left = note("left"), right = note("right");
    await vault.seed(left, "left original");
    await vault.seed(right, "right original");
    const process = vault.process.bind(vault);
    let failed = false;
    vault.process = async (file, updater) => {
      if (file.path === right && !failed) { failed = true; throw new Error("synthetic disk failure"); }
      return process(file, updater);
    };
    const result = await operation(async scope => { await scope.writeFile(left, "new left"); await scope.writeFile(right, "new right"); });
    expect(result.success).toBe(false);
    expect(await vault.bytes(left)).toBe("left original");
    expect(await vault.bytes(right)).toBe("right original");
    expect((await ledger()).records[0].status).toBe("failed");
    expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("rolled_back");
  });
  it("removes a newly created note if a later step throws", async () => {
    const path = note("new");
    expect((await operation(async scope => { await scope.writeFile(path, "new data"); throw new Error("later step failed"); })).success).toBe(false);
    expect(store.getFile(path)).toBeNull();
  });
  it("restores a previously empty file as empty instead of deleting it", async () => {
    const path = note("empty");
    await vault.seed(path, "");
    await operation(async scope => { await scope.writeFile(path, "filled"); throw new Error("abort"); });
    expect(await vault.bytes(path)).toBe("");
  });
  it("refuses all rollback changes when another editor has changed a touched file", async () => {
    const left = note("left"), right = note("right");
    await vault.seed(left, "left original"); await vault.seed(right, "right original");
    const result = await operation(async scope => {
      await scope.writeFile(left, "our left"); await scope.writeFile(right, "our right");
      await vault.seed(right, "external edit"); throw new Error("abort");
    });
    expect(result.success).toBe(false);
    expect(await vault.bytes(left)).toBe("our left");
    expect(await vault.bytes(right)).toBe("external edit");
    expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("pending");
    expect((await operation(scope => scope.writeFile(note("blocked"), "no"), "next")).success).toBe(false);
    expect(store.getFile(note("blocked"))).toBeNull();
  });
  it("rolls back when final audit persistence fails after business writes", async () => {
    const path = note("original"); await vault.seed(path, "before");
    const process = vault.process.bind(vault);
    let failed = false;
    vault.process = async (file, updater) => {
      if (file.path.endsWith("operation-ledger.json") && !failed && JSON.parse(await vault.bytes(factRecoveryPath(store))).entries.length) {
        failed = true; throw new Error("audit save failure");
      }
      return process(file, updater);
    };
    expect((await operation(scope => scope.writeFile(path, "after"))).success).toBe(false);
    expect(await vault.bytes(path)).toBe("before");
  });
  it("preserves a finalized operation if only the final journal update fails", async () => {
    const path = note("finished");
    const process = vault.process.bind(vault);
    vault.process = async (file, updater) => {
      if (file.path === factRecoveryPath(store)) {
        const text = updater(await vault.bytes(file.path));
        if (JSON.parse(text).status === "committed") throw new Error("journal tail failed");
      }
      return process(file, updater);
    };
    expect((await operation(scope => scope.writeFile(path, "saved"))).success).toBe(true);
    expect((await ledger()).records[0].status).toBe("verified");
    expect(await vault.bytes(path)).toBe("saved");
    vault.process = process;
    expect(await recoverFactOperation(store)).toBe("kept");
    expect(await vault.bytes(path)).toBe("saved");
  });
  it("does not overwrite a file that appeared after a missing-file read", async () => {
    const path = note("appeared");
    const result = await operation(async scope => {
      expect(await scope.readPath(path)).toBe("");
      await vault.seed(path, "external new file");
      await scope.writeFile(path, "stale creation");
    });
    expect(result.success).toBe(false);
    expect(await vault.bytes(path)).toBe("external new file");
  });
  it("serializes separate operations so each reads the previous completed result", async () => {
    const path = note("counter"); await vault.seed(path, "0");
    const results = await Promise.all(["a", "b"].map(id => operation(async scope => {
      const old = Number(await scope.readPath(path));
      await scope.writeFile(path, String(old + 1));
    }, id)));
    expect(results.every(r => r.success)).toBe(true);
    expect(await vault.bytes(path)).toBe("2");
  });
  it("deduplicates an operation ID and rejects a reused ID with different inputs", async () => {
    const path = note("once");
    let runs = 0;
    const work = async (scope: StoreHost) => { runs++; await scope.appendFile(path, "one\n"); };
    expect((await operation(work)).success).toBe(true);
    expect((await operation(work)).success).toBe(true);
    expect(runs).toBe(1);
    expect((await runtime.executeLocalOperation("test-user-operation", { test: false }, work, "test-operation")).success).toBe(false);
    expect(await vault.bytes(path)).toBe("one\n");
  });
  it("allows a retry after a completely rolled-back failed operation", async () => {
    const path = note("retry");
    await operation(async scope => { await scope.appendFile(path, "one\n"); throw new Error("abort"); });
    expect((await operation(scope => scope.appendFile(path, "one\n"))).success).toBe(true);
    expect(await vault.bytes(path)).toBe("one\n");
  });
  it.each(["../outside.md", "/outside.md", ".obsidian/data.json", "灵感/.hidden.json", "灵感/data.bin"])("rejects an unsupported write path: %s", async path => {
    expect((await operation(scope => scope.writeFile(path, "unexpected"))).success).toBe(false);
    expect(vault.writes.some(write => write.path === path)).toBe(false);
  });
});

describe("whole-operation undo", () => {
  it("rejects preflight outside a guarded write, without changing existing data", async () => {
    const path = note("虚构范围");
    await vault.seed(path, "保留原文");
    await expect(preflightFactOperationChanges(store, [{
      path, before: "保留原文", after: null, beforeHash: fileRevision("保留原文"), afterHash: fileRevision(null)
    }])).rejects.toThrow("撤销容量核对缺少当前保存范围");
    expect(await vault.bytes(path)).toBe("保留原文");
    expect(store.getFile(factRecoveryPath(store))).toBeNull();
  });

  it("retains bytes removed by undo and never irreversibly unlinks them", async () => {
    const path = note("new note");
    await operation(scope => scope.writeFile(path, "saved bytes"));
    await runtime.undoOperation("test-operation");
    expect(store.getFile(path)).toBeNull();
    const journal = JSON.parse(await vault.bytes(factRecoveryPath(store)));
    expect(journal.entries[0].retained).toHaveLength(1);
    expect(await vault.bytes(journal.entries[0].retained[0].path)).toBe("saved bytes");
    expect(vault.writes.some(write => write.kind === "delete")).toBe(false);
  });
  it("preserves an edit made in the final removal race", async () => {
    const path = note("racing note");
    await operation(scope => scope.writeFile(path, "our new note"));
    const rename = vault.rename.bind(vault);
    vault.rename = async (file, destination) => {
      if (file.path === path) await vault.seed(path, "user edit just before removal");
      return rename(file, destination);
    };
    await expect(runtime.undoOperation("test-operation")).rejects.toThrow();
    expect(await vault.bytes(path)).toBe("user edit just before removal");
    const journal = JSON.parse(await vault.bytes(factRecoveryPath(store)));
    expect(await vault.bytes(journal.entries[0].retained[0].path)).toBe("user edit just before removal");
    expect((await ledger()).records[0].status).toBe("verified");
  });
  it("does not resurrect a reverted action when the old request is retried", async () => {
    const path = note("reverted");
    const work = (scope: StoreHost) => scope.writeFile(path, "do not resurrect");
    await operation(work);
    await runtime.undoOperation("test-operation");
    const retry = await operation(work);
    expect(retry.success).toBe(false);
    expect(retry.output).toContain("撤销");
    expect(store.getFile(path)).toBeNull();
  });
  it("restores every side effect of completing a repeating task and logging it", async () => {
    await store.initializeVault();
    const task = await store.createTask({ title: "重复学习", date, repeatUnit: "day", repeatInterval: 1 });
    const taskBefore = await vault.bytes(store.taskDbPath()), boardBefore = await vault.bytes(store.taskMirrorPath());
    const result = await operation(scope => scope.completeTaskAndLog(task.id, date, "已学习"));
    expect(result.success).toBe(true);
    expect((await store.readTaskDb()).tasks).toHaveLength(2);
    expect(await store.readPath(activityNotePath(store, "tasks", date))).toContain("重复学习");
    expect(await store.readDailyPair(date)).toBe("");
    const undo = (await ledger()).records[0].result.undo;
    expect(undo.files.map((file: any) => file.path)).toEqual(expect.arrayContaining([store.taskDbPath(), store.taskMirrorPath(), activityNotePath(store, "tasks", date)]));
    await runtime.undoOperation(result.callId);
    expect(await vault.bytes(store.taskDbPath())).toBe(taskBefore);
    expect(await vault.bytes(store.taskMirrorPath())).toBe(boardBefore);
    expect(store.getFile(store.dailyNotePath(date, "早"))).toBeNull();
  });
  it("refuses undo before touching any file if one file was edited later", async () => {
    const left = note("left"), right = note("right");
    await vault.seed(left, "old left"); await vault.seed(right, "old right");
    await operation(async scope => { await scope.writeFile(left, "our left"); await scope.writeFile(right, "our right"); });
    await vault.seed(right, "later user edit");
    await expect(runtime.undoOperation("test-operation")).rejects.toThrow();
    expect(await vault.bytes(left)).toBe("our left"); expect(await vault.bytes(right)).toBe("later user edit");
    expect((await ledger()).records[0].status).toBe("verified");
  });
  it("restores a successfully undone file if a later undo write fails", async () => {
    const left = note("left"), right = note("right");
    await vault.seed(left, "old left"); await vault.seed(right, "old right");
    await operation(async scope => { await scope.writeFile(left, "our left"); await scope.writeFile(right, "our right"); });
    const process = vault.process.bind(vault); let failed = false;
    vault.process = async (file, updater) => {
      if (file.path === left && !failed) { failed = true; throw new Error("undo interrupted"); }
      return process(file, updater);
    };
    await expect(runtime.undoOperation("test-operation")).rejects.toThrow();
    expect(await vault.bytes(left)).toBe("our left"); expect(await vault.bytes(right)).toBe("our right");
    expect((await ledger()).records[0].status).toBe("verified");
  });
  it("rejects older undo records without a saved post-write version", async () => {
    const path = note("legacy"); await vault.seed(path, "later user edit");
    const audit = new OperationLedger(store);
    await audit.claim({ operationId: "legacy", toolName: "legacy", source: "system", arguments: {} });
    await audit.verify("legacy", { success: true, output: "old", actions: [], undo: { kind: "restore_file", path, content: "old", existed: true } });
    await expect(runtime.undoOperation("legacy")).rejects.toThrow("旧操作");
    expect(await vault.bytes(path)).toBe("later user edit");
  });
});

describe("durable recovery", () => {
  async function interrupted(current: string | null, extras: Record<string, unknown> = {}) {
    const path = note("interrupted");
    if (current !== null) await vault.seed(path, current);
    await vault.seed(factRecoveryPath(store), JSON.stringify({ version: 1, operationId: "interrupted", status: "pending", entries: [{ path, before: "original", after: "intended", previous: "original", beforeHash: fileRevision("original"), afterHash: fileRevision("intended"), previousHash: fileRevision("original") }], ...extras }));
    return path;
  }
  it.each(["original", "intended"])("recovers when the interrupted write left %s bytes", async current => {
    const path = await interrupted(current);
    expect(await recoverFactOperation(store)).toBe("restored");
    expect(await vault.bytes(path)).toBe("original");
    expect(await recoverFactOperation(store)).toBe("none");
  });
  it("rejects unexpected bytes and leaves the recovery record pending", async () => {
    const path = await interrupted("user's later content");
    const before = await vault.bytes(factRecoveryPath(store));
    await expect(recoverFactOperation(store)).rejects.toThrow();
    expect(await vault.bytes(path)).toBe("user's later content");
    expect(await vault.bytes(factRecoveryPath(store))).toBe(before);
  });
  it("checks the inspected WAL after waiting for the Fact lock and leaves a replacement untouched", async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => enter = resolve), waiting = new Promise<void>(resolve => release = resolve);
    const holding = runFactOperation(store, { operationId: "holding" }, async () => { enter(); await waiting; }, async () => {});
    await entered;
    const path = await interrupted("intended"), expectedRaw = await vault.bytes(factRecoveryPath(store));
    const recovering = recoverFactOperation(store, { expectedRaw });
    const rejected = expect(recovering).rejects.toThrow();
    const foreign = note("another-operation"); await vault.seed(foreign, "intended");
    const other = JSON.parse(expectedRaw); other.operationId = "another-operation"; other.entries[0].path = foreign;
    const replacement = JSON.stringify(other); await vault.seed(factRecoveryPath(store), replacement);
    const before = vault.writes.length; release(); await holding; await rejected;
    expect(await vault.bytes(path)).toBe("intended"); expect(await vault.bytes(factRecoveryPath(store))).toBe(replacement);
    expect(await vault.bytes(foreign)).toBe("intended");
    expect(vault.writes.length).toBe(before);
  });
  it("rechecks inspected WAL after audit reads before restoring any fact", async () => {
    const path = await interrupted("intended"), walPath = factRecoveryPath(store), expectedRaw = await vault.bytes(walPath);
    const auditPath = new OperationLedger(store).filePath; await vault.seed(auditPath, '{"version":1,"records":[]}');
    const replacement = `${expectedRaw}\n`, original = vault.read.bind(vault); let replaced = false;
    vault.read = async file => {
      const result = await original(file);
      if (file.path === auditPath && !replaced) { replaced = true; await vault.seed(walPath, replacement); }
      return result;
    };
    await expect(recoverFactOperation(store, { expectedRaw })).rejects.toThrow();
    expect(await vault.bytes(path)).toBe("intended"); expect(await vault.bytes(walPath)).toBe(replacement);
  });
  it("awaits the optional protected recovery guard inside the Fact lock before restoring or settling bytes", async () => {
    let enter!: () => void, release!: () => void, changed = false, checks = 0;
    const entered = new Promise<void>(resolve => enter = resolve), waiting = new Promise<void>(resolve => release = resolve);
    const holding = runFactOperation(store, { operationId: "protected-recovery-lock" }, async () => { enter(); await waiting; }, async () => {});
    await entered;
    const path = await interrupted("intended"), expectedRaw = await vault.bytes(factRecoveryPath(store));
    const recovering = recoverFactOperation(store, { expectedRaw, assertBeforeRecoveryWrite: async () => {
      checks++; await Promise.resolve(); if (changed) throw new Error("Protected input changed");
    } });
    const rejected = expect(recovering).rejects.toThrow("Protected input changed");
    expect(checks).toBe(0); changed = true; const writes = vault.writes.length; release(); await holding; await rejected;
    expect(checks).toBe(1); expect(vault.writes.length).toBe(writes);
    expect(await vault.bytes(path)).toBe("intended"); expect(await vault.bytes(factRecoveryPath(store))).toBe(expectedRaw);
  });
  it.each([
    ["future recovery format", 999],
    ["v3 recovery format without ledgerUndo", 3]
  ])("rejects %s without any recovery write", async (_kind, version) => {
    const path = await interrupted("intended", { version });
    const auditPath = new OperationLedger(store).filePath, audit = '{"version":1,"records":[]}\n';
    await vault.seed(auditPath, audit);
    const before = await vault.bytes(factRecoveryPath(store)), writes = vault.writes.length;
    await expect(recoverFactOperation(store)).rejects.toThrow("版本");
    expect(vault.writes.length).toBe(writes);
    expect(await vault.bytes(path)).toBe("intended");
    expect(await vault.bytes(auditPath)).toBe(audit);
    expect(await vault.bytes(factRecoveryPath(store))).toBe(before);
  });
  it("rejects a damaged snapshot hash without changing the target", async () => {
    const path = await interrupted("intended");
    const journal = JSON.parse(await vault.bytes(factRecoveryPath(store)));
    journal.entries[0].before = "tampered";
    await vault.seed(factRecoveryPath(store), JSON.stringify(journal));
    await expect(recoverFactOperation(store)).rejects.toThrow();
    expect(await vault.bytes(path)).toBe("intended");
  });
  it("releases an interrupted claim only after recovery actually restored the files", async () => {
    const path = await interrupted("intended");
    const audit = new OperationLedger(store);
    const request = { operationId: "interrupted", toolName: "test", source: "system" as const, arguments: {} };
    await audit.claim(request);
    expect((await audit.claim(request)).kind).toBe("busy");
    await recoverFactOperation(store);
    expect(await vault.bytes(path)).toBe("original");
    expect((await audit.claim(request)).kind).toBe("execute");
  });
  it("does not allow writes that escape a completed scope", async () => {
    let escaped: StoreHost | undefined;
    await runFactOperation(store, { operationId: "scope" }, async scoped => { escaped = scoped; }, async () => undefined);
    await expect(escaped!.writeFile(note("late"), "late content")).rejects.toThrow();
    expect(store.getFile(note("late"))).toBeNull();
  });
});
