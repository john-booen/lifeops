import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App, TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { recordRevision } from "../src/operationIdentity";
import type { AgentActionSuggestion } from "../src/types";
import type { StoreHost } from "../src/store/settingsSlice";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true },
  Notice: class { constructor(message: string) { notices.push(message); } },
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(),
  requestUrl: () => { throw new Error("No network in confirmation deletion tests"); }
}));

const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { OperationLedger } = await import("../src/dataFoundation/operationLedger");
const { factRecoveryPath, fileRevision, recoverFactOperation } = await import("../src/dataFoundation/factOperation");
const { default: LifeOpsPlugin } = await import("../src/main");
const { DiskVault } = await import("./helpers/diskVault");

let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
let runtime: InstanceType<typeof AgentRuntime>;
let plugin: { unloaded: boolean; lifecycleGeneration: number; executeAgentAction(action: AgentActionSuggestion): Promise<void | string>; undoLatestLifeOpsOperation(): Promise<void> };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
function settled<T>(pending: Promise<T>) { return pending.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error })); }
function closeLifecycle() { plugin.unloaded = true; plugin.lifecycleGeneration += 1; }
async function audit(id: string) { const document = await store.readJson<any>(new OperationLedger(store).filePath, { records: [] }); return document.records.find((record: any) => record.operationId === id); }
async function wal() { return store.getFile(factRecoveryPath(store)) ? JSON.parse(await vault.bytes(factRecoveryPath(store))) : null; }
async function taskBytes() { return [await vault.bytes(store.taskDbPath()), await vault.bytes(store.taskMirrorPath())]; }
async function habitBytes() { return [await vault.bytes(store.habitDbPath()), await vault.bytes(store.habitMirrorPath())]; }
async function taskCard(taskId: string, callId: string) {
  const result = await runtime.executeToolCall({ toolName: "delete_task", arguments: { taskIdOrTitle: taskId }, source: "system", callId });
  expect(result.success).toBe(true); expect(result.actions).toHaveLength(1); return result.actions[0];
}
async function habitCard(name: string) {
  const result = await runtime.executeToolCall({ toolName: "delete_habit", arguments: { name }, source: "kimi", callId: "fictional-habit-delete" });
  expect(result.success).toBe(true); expect(result.actions).toHaveLength(1); return result.actions[0];
}
function pauseRead(path: string) {
  const entered = deferred(), release = deferred(), read = vault.read.bind(vault); let paused = false;
  vi.spyOn(vault, "read").mockImplementation(async (file: TFile) => {
    const raw = await read(file);
    if (!paused && file.path === path) { paused = true; entered.resolve(); await release.promise; }
    return raw;
  });
  return { entered, release };
}
function pauseAfterWrite(path: string) {
  const entered = deferred(), release = deferred(), process = vault.process.bind(vault); let paused = false;
  vi.spyOn(vault, "process").mockImplementation(async (file: TFile, updater: (raw: string) => string) => {
    const result = await process(file, updater);
    if (!paused && file.path === path) { paused = true; entered.resolve(); await release.promise; }
    return result;
  });
  return { entered, release };
}

beforeEach(async () => {
  notices.length = 0; root = await mkdtemp(join(tmpdir(), "lifeops-confirmation-delete-")); vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: () => [] } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault(); runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  // Production Main handlers only; no onload, window, IPC, devices, or service.
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), { app, store, settings: store.settings, unloaded: false, lifecycleGeneration: 1, refreshViews: async () => {} });
});

describe("scoped Ledger undo recovery boundaries", () => {
  it("restores exact business and Ledger bytes after cancelling an already reverted Ledger, then permits undo retry", async () => {
    const path = store.path(store.settings.folders.ideas, "fiction-reverted-ledger-cancel.md"), operationId = "fiction-reverted-ledger-cancel";
    await vault.seed(path, "纯虚构撤销前的原文");
    expect((await runtime.executeLocalOperation("fiction-reverted-ledger-source", {}, scope => scope.writeFile(path, "纯虚构已保存的正文"), operationId)).success).toBe(true);
    const ledgerPath = new OperationLedger(store).filePath, beforeLedger = await vault.bytes(ledgerPath), gate = pauseAfterWrite(ledgerPath);
    const pending = settled(plugin.undoLatestLifeOpsOperation()); await gate.entered.promise;
    expect(await vault.bytes(path)).toBe("纯虚构撤销前的原文");
    expect((await audit(operationId)).status).toBe("reverted");
    expect(JSON.parse(await vault.bytes(ledgerPath)).revertedOperationHashes).toContain(fileRevision(operationId));
    const inFlight = await wal(); expect(inFlight.status).toBe("pending"); expect(inFlight.entries.some((entry: any) => entry.path === ledgerPath)).toBe(true);

    closeLifecycle(); gate.release.resolve(); await pending;
    expect(await vault.bytes(path)).toBe("纯虚构已保存的正文"); expect(await vault.bytes(ledgerPath)).toBe(beforeLedger);
    expect((await audit(operationId)).status).toBe("verified");
    expect(JSON.parse(await vault.bytes(ledgerPath)).revertedOperationHashes).not.toContain(fileRevision(operationId));
    const rolledBack = await wal(); expect(rolledBack.status).toBe("rolled_back"); expect(rolledBack.rollbackRequired).toBe(true);
    expect(notices.some(message => message.includes("已撤销最近一次写入"))).toBe(false);

    plugin.unloaded = false; plugin.lifecycleGeneration += 1;
    await plugin.undoLatestLifeOpsOperation();
    expect(await vault.bytes(path)).toBe("纯虚构撤销前的原文"); expect((await audit(operationId)).status).toBe("reverted");
    expect(JSON.parse(await vault.bytes(ledgerPath)).revertedOperationHashes).toContain(fileRevision(operationId)); expect((await wal()).status).toBe("committed");
  });

  it("recovers durable rollbackRequired after a real rollback write fails, using a fresh Store and a normal undo retry", async () => {
    const path = store.path(store.settings.folders.ideas, "fiction-undo-recovery-retry.md"), operationId = "fiction-undo-recovery-retry";
    await vault.seed(path, "纯虚构恢复重试的原文");
    expect((await runtime.executeLocalOperation("fiction-undo-recovery-source", {}, scope => scope.writeFile(path, "纯虚构应保留的已保存正文"), operationId)).success).toBe(true);
    const ledgerPath = new OperationLedger(store).filePath, beforeLedger = await vault.bytes(ledgerPath), entered = deferred(), release = deferred();
    const process = vault.process.bind(vault); let paused = false, failedRollback = false;
    const processSpy = vi.spyOn(vault, "process").mockImplementation(async (file: TFile, updater: (raw: string) => string) => {
      if (file.path === path && plugin.unloaded && !failedRollback) {
        // This is a real rollback attempt, after its cancellation intent has
        // reached disk. Fail the native write before it changes this file.
        const recovery = await wal(); expect(recovery.status).toBe("pending"); expect(recovery.rollbackRequired).toBe(true);
        failedRollback = true; throw new Error("纯虚构回滚磁盘写入中断");
      }
      const result = await process(file, updater);
      if (file.path === ledgerPath && !paused) { paused = true; entered.resolve(); await release.promise; }
      return result;
    });
    const pending = settled(plugin.undoLatestLifeOpsOperation()); await entered.promise;
    expect((await audit(operationId)).status).toBe("reverted"); closeLifecycle(); release.resolve(); await pending;
    expect(failedRollback).toBe(true);
    const interruptedRaw = await vault.bytes(factRecoveryPath(store)), interrupted = JSON.parse(interruptedRaw);
    expect(interrupted.operationId).toBe(`undo:${operationId}`); expect(interrupted.status).toBe("pending"); expect(interrupted.rollbackRequired).toBe(true);
    expect(await vault.bytes(path)).toBe("纯虚构恢复重试的原文"); expect(await vault.bytes(ledgerPath)).toBe(beforeLedger);
    expect((await audit(operationId)).status).toBe("verified"); expect(notices.some(message => message.includes("已撤销最近一次写入"))).toBe(false);

    processSpy.mockRestore();
    const fresh = new LifeOpsStore(store.app, structuredClone(store.settings)) as unknown as StoreHost;
    expect(await recoverFactOperation(fresh, { expectedRaw: interruptedRaw })).toBe("restored");
    expect(await vault.bytes(path)).toBe("纯虚构应保留的已保存正文"); expect(await vault.bytes(ledgerPath)).toBe(beforeLedger);
    expect((await wal()).status).toBe("rolled_back");
    const resumed = new AgentRuntime({ store: fresh, refreshViews: async () => {} });
    expect(await resumed.undoLatestOperation()).toBe(operationId);
    expect(await vault.bytes(path)).toBe("纯虚构恢复重试的原文"); expect((await audit(operationId)).status).toBe("reverted");
    expect(JSON.parse(await vault.bytes(ledgerPath)).revertedOperationHashes).toContain(fileRevision(operationId)); expect((await wal()).status).toBe("committed");
  });

  it("allows deletion of the approved habit after an unrelated habit receives a new actual checkin", async () => {
    const target = await store.createHabit({ name: "纯虚构批准删除的习惯", frequencyUnit: "day", frequencyInterval: 1, targetCount: 2, penaltyThreshold: 3, color: "#27ae60" });
    const other = await store.createHabit({ name: "纯虚构必须保留的新打卡习惯", frequencyUnit: "day", frequencyInterval: 1, targetCount: 3, penaltyThreshold: 3, color: "#2980b9" });
    await store.recordHabitStatus(target.id, "done", "2026-10-07", "纯虚构原目标打卡");
    const action = await habitCard(target.name);
    await store.recordHabitStatus(other.id, "done", "2026-10-07", "纯虚构无关新打卡");
    const before = structuredClone(await store.readHabitDb()); await plugin.executeAgentAction(action);
    const after = await store.readHabitDb();
    expect(after.habits).toEqual(before.habits.filter(habit => habit.id !== target.id));
    expect(after.checkins).toEqual(before.checkins.filter(checkin => checkin.habitId !== target.id));
    expect(after.checkins.find(checkin => checkin.habitId === other.id)?.note).toBe("纯虚构无关新打卡");
    expect((await audit(`confirmed:${action.id}`)).status).toBe("verified"); expect((await wal()).status).toBe("committed");
    const fresh = new LifeOpsStore(store.app, structuredClone(store.settings)) as unknown as StoreHost;
    expect(await fresh.readHabitDb()).toEqual(after); expect(await fresh.readPath(fresh.habitMirrorPath())).toContain(other.name);
  });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("actual confirmation deletion boundaries", () => {
  it("deletes an unchanged approved task and habit, and restores exact bytes through actual Main undo", async () => {
    const task = await store.createTask({ title: "纯虚构批准任务A" }), keep = await store.createTask({ title: "纯虚构保留任务B" });
    const beforeTasks = await taskBytes(), action = await taskCard(task.id, "fiction-approved-delete");
    await plugin.executeAgentAction(action);
    expect((await store.readTaskDb()).tasks.map(record => record.id)).toEqual([keep.id]);
    expect((await audit(`confirmed:${action.id}`)).status).toBe("verified"); expect((await wal()).status).toBe("committed");
    await plugin.undoLatestLifeOpsOperation(); expect(await taskBytes()).toEqual(beforeTasks);
    expect((await audit(`confirmed:${action.id}`)).status).toBe("reverted");

    const habit = await store.createHabit({ name: "纯虚构批准习惯", frequencyUnit: "day", frequencyInterval: 1, targetCount: 2, penaltyThreshold: 3, color: "#27ae60" });
    await store.recordHabitStatus(habit.id, "done", "2026-10-07", "纯虚构原打卡");
    const beforeHabits = await habitBytes(), habitAction = await habitCard(habit.name);
    await plugin.executeAgentAction(habitAction); expect((await store.readHabitDb()).habits).toEqual([]); expect((await store.readHabitDb()).checkins).toEqual([]);
    await plugin.undoLatestLifeOpsOperation(); expect(await habitBytes()).toEqual(beforeHabits);
    expect((await audit(`confirmed:${habitAction.id}`)).status).toBe("reverted");
  });

  it("cannot retarget approved A to B while the actual original Ledger claim is waiting", async () => {
    const a = await store.createTask({ title: "纯虚构原批准A" }), b = await store.createTask({ title: "纯虚构不得删除B" });
    const originalRecords = (await store.readTaskDb()).tasks, beforeBytes = await taskBytes();
    const action = await taskCard(a.id, "fiction-retarget-delete"), approved = structuredClone(action), entered = deferred(), release = deferred();
    const claim = OperationLedger.prototype.claim;
    vi.spyOn(OperationLedger.prototype, "claim").mockImplementation(async function (this: InstanceType<typeof OperationLedger>, input) {
      const actual = await claim.call(this, input);
      if (input.operationId === `confirmed:${approved.id}`) { entered.resolve(); await release.promise; }
      return actual;
    });
    const pending = settled(plugin.executeAgentAction(action)); await entered.promise;
    expect((await audit(`confirmed:${approved.id}`)).arguments.taskIds).toEqual([a.id]);
    action.taskIds = [b.id]; action.expectedTargetRevisions = { [`task:${b.id}`]: recordRevision(originalRecords.find(record => record.id === b.id)!) }; action.content = `- ${b.title}`;
    release.resolve(); const outcome = await pending, after = (await store.readTaskDb()).tasks;
    // Rejecting the changed card or preserving the exact original approval are
    // both safe. B must survive; the persisted claim must describe any deletion.
    expect(after.find(record => record.id === b.id)).toEqual(originalRecords.find(record => record.id === b.id));
    const record = await audit(`confirmed:${approved.id}`);
    if (outcome.ok) {
      expect(after.some(record => record.id === a.id)).toBe(false); expect(record.status).toBe("verified"); expect(record.arguments.taskIds).toEqual([a.id]);
      expect((await wal()).operationId).toBe(`confirmed:${approved.id}`); expect((await wal()).status).toBe("committed");
    } else { expect(await taskBytes()).toEqual(beforeBytes); expect(record.status).not.toBe("verified"); }
  });

  it.each(["new", "changed"] as const)("rejects the old habit deletion card after a %s actual checkin", async change => {
    const habit = await store.createHabit({ name: "纯虚构保留新打卡", frequencyUnit: "day", frequencyInterval: 1, targetCount: 3, penaltyThreshold: 3, color: "#27ae60" });
    if (change === "changed") await store.recordHabitStatus(habit.id, "done", "2026-10-07", "纯虚构原打卡");
    const action = await habitCard(habit.name), originalDefinition = structuredClone((await store.readHabitDb()).habits[0]);
    await store.recordHabitStatus(habit.id, "done", "2026-10-07", "纯虚构卡后新增或更正的打卡");
    expect((await store.readHabitDb()).habits[0]).toEqual(originalDefinition);
    const beforeBytes = await habitBytes(), current = structuredClone(await store.readHabitDb()), outcome = await settled(plugin.executeAgentAction(action));
    expect({ rejected: !outcome.ok, database: await store.readHabitDb() }).toEqual({ rejected: true, database: current });
    expect(await habitBytes()).toEqual(beforeBytes); expect((await audit(`confirmed:${action.id}`))?.status).not.toBe("verified");
    const recovery = await wal(); if (recovery?.operationId === `confirmed:${action.id}`) expect(recovery.status).toBe("rolled_back");
  });

  it.each(["read", "last-write"] as const)("cancels actual Main deletion when lifecycle closes during the %s", async boundary => {
    const a = await store.createTask({ title: "纯虚构取消应保留任务" }); await store.createTask({ title: "纯虚构原其它任务" });
    const action = await taskCard(a.id, `fiction-cancel-delete-${boundary}`), before = await taskBytes();
    const gate = boundary === "read" ? pauseRead(store.taskDbPath()) : pauseAfterWrite(store.taskMirrorPath());
    const pending = settled(plugin.executeAgentAction(action)); await gate.entered.promise;
    if (boundary === "last-write") {
      expect(JSON.parse(await vault.bytes(store.taskDbPath())).tasks.some((task: any) => task.id === a.id)).toBe(false);
      expect((await wal()).status).toBe("pending");
    }
    closeLifecycle(); gate.release.resolve(); const outcome = await pending;
    expect({ rejected: !outcome.ok, bytes: await taskBytes(), status: (await audit(`confirmed:${action.id}`))?.status }).toEqual({ rejected: true, bytes: before, status: "failed" });
    const recovery = await wal(); if (recovery?.operationId === `confirmed:${action.id}`) expect(recovery.status).toBe("rolled_back");
  });

  it.each(["read", "last-write"] as const)("cancels actual Main undo when lifecycle closes during the %s", async boundary => {
    const path = store.path(store.settings.folders.ideas, "fiction-undo-boundary.md"), operationId = `fiction-cancel-undo-${boundary}`;
    await vault.seed(path, "纯虚构原记录");
    const saved = await runtime.executeLocalOperation("fiction-undo-source", {}, scope => scope.writeFile(path, "纯虚构已核验新记录"), operationId);
    expect(saved.success).toBe(true); expect((await audit(operationId)).status).toBe("verified");
    const gate = boundary === "read" ? pauseRead(path) : pauseAfterWrite(path), pending = settled(plugin.undoLatestLifeOpsOperation());
    await gate.entered.promise;
    if (boundary === "last-write") { expect(await vault.bytes(path)).toBe("纯虚构原记录"); expect((await wal()).status).toBe("pending"); }
    closeLifecycle(); gate.release.resolve(); await pending;
    expect({ bytes: await vault.bytes(path), originalAudit: (await audit(operationId)).status, reportedSuccess: notices.some(message => message.includes("已撤销最近一次写入")) })
      .toEqual({ bytes: "纯虚构已核验新记录", originalAudit: "verified", reportedSuccess: false });
    const recovery = await wal(); if (recovery?.operationId === `undo:${operationId}`) expect(recovery.status).toBe("rolled_back");
  });
});
