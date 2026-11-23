import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { taskDayInterval, taskScheduleLabel, isTaskOverdue } from "../src/taskSchedule";
import { taskCapacity, taskEstimates } from "../src/features/tasks/capacity";
import { parseVaultTasks } from "../src/vaultApi";
import { todayTaskCounts } from "../src/features/stats/stats";
import { planTaskBatch } from "../src/agent/taskBatch";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { AgentRuntime } = await import("../src/agentRuntime");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
const now = new Date(2026, 10, 23, 10), today = "2026-11-23";
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  root = await mkdtemp(join(tmpdir(), "lifeops-period-window-")); vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
});
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

describe("period completion is different from a single-day work appointment", () => {
  it.each([
    ["week", "2026-11-21", "2026-11-27"],
    ["month", "2026-10-29", "2026-12-02"],
    ["year", "2026-12-28", "2027-01-05"]
  ])("classifies a %s window by overlap without making it tomorrow's appointment", async (_, date, endDate) => {
    const row = await store.createTask({ title: "虚构分批整理蓝纸", date, endDate, startTime: "16:15", endTime: "16:45", estimateMin: 600 });
    const day = date === "2026-12-28" ? "2026-12-30" : today;
    const before = await vault.bytes(store.taskDbPath());
    const board = await store.getTaskDashboard(day, { forContext: true });
    expect(board.today.map(t => t.id)).toContain(row.id);
    expect(board.tomorrow.map(t => t.id)).not.toContain(row.id);
    expect(board.nextSevenDays.map(t => t.id)).toContain(row.id);
    expect(board.calendar.find(item => item.date === day)?.tasks.map(t => t.id)).toContain(row.id);
    expect(taskDayInterval(row, day)).toBeUndefined();
    expect(taskScheduleLabel(row)).toContain("期间完成");
    expect(isTaskOverdue(row, day)).toBe(false);
    expect(await vault.bytes(store.taskDbPath())).toBe(before);
  });
  it("keeps a normal tomorrow appointment and a real overnight interval", async () => {
    const tomorrow = await store.createTask({ title: "虚构明日贴标签", date: "2026-11-24", startTime: "09:00", endTime: "09:30" });
    const overnight = await store.createTask({ title: "虚构跨午夜观察", date: today, endDate: "2026-11-24", startTime: "22:00", endTime: "02:00" });
    const board = await store.getTaskDashboard(today, { forContext: true });
    expect(board.tomorrow.map(t => t.id)).toEqual(expect.arrayContaining([tomorrow.id, overnight.id]));
    expect(taskDayInterval(overnight, today)).toEqual({ start: 1320, end: 1440 });
    expect(taskDayInterval(overnight, "2026-11-24")).toEqual({ start: 0, end: 120 });
  });
  it("does not charge the entire remaining period to each day's capacity", async () => {
    const window = await store.createTask({ title: "虚构本月归档", date: "2026-11-01", endDate: "2026-11-30", estimateMin: 1200 });
    const daily = await store.createTask({ title: "虚构今日贴签", date: today, estimateMin: 20 });
    expect(taskCapacity([window, daily], now)).toMatchObject({ plannedCount: 1, plannedMin: 20, periodCount: 1 });
  });
  it("does not train daily estimates or completion capacity from a whole month's accumulated work", async () => {
    const window = await store.createTask({ title: "虚构已完成月度归档", date: "2026-11-01", endDate: "2026-11-22", estimateMin: 1200 });
    await store.updateTask(window.id, task => ({ ...task, status: "completed", completedAt: "2026-11-22T18:00:00+08:00" }));
    const daily = await store.createTask({ title: "虚构今日零散归档", date: today });
    const rows = (await store.readTaskDb({ readOnly: true })).tasks;
    expect(taskEstimates(rows)(daily)).toBe(30);
    expect(taskCapacity(rows, now)).toMatchObject({ plannedCount: 1, plannedMin: 30, typicalCount: null, typicalMin: null });
  });
  it("uses the planned finish for period statistics even when the hard deadline is in a different month", async () => {
    const row = await store.createTask({ title: "虚构独立截止的月度计划", date: "2026-11-01", endDate: "2026-11-20", dueDate: "2026-12-02" });
    expect(todayTaskCounts([row], "2026-11-20", now).scheduled).toBe(1);
    const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    const result = await runtime.executeAiToolCall({ name: "get_stats", arguments: { domain: "tasks", range: "this_month" } }, "kimi");
    expect(result.success, result.output).toBe(true);
    expect(JSON.parse(result.output).plannedCount).toBe(1);
    expect((await store.getTask(row.id)).dueDate).toBe("2026-12-02");
  });
  it("moves and duplicates a date-only window without dropping its span or deadline", async () => {
    const row = await store.createTask({ title: "虚构一周分批核对", date: "2026-11-21", endDate: "2026-11-27", dueDate: "2026-12-02" });
    await store.moveTaskToDate(row.id, "2026-11-24");
    expect(await store.getTask(row.id)).toMatchObject({ date: "2026-11-24", endDate: "2026-11-30", dueDate: "2026-12-02" });
    await store.duplicateTaskToDate(row.id, "2026-12-01");
    const copy = (await store.readTaskDb({ readOnly: true })).tasks.find(t => t.parentTaskId === row.id)!;
    expect(copy).toMatchObject({ date: "2026-12-01", endDate: "2026-12-07", dueDate: "2026-12-02" });
  });
  it.each([
    { date: "2026-11-27", endDate: "2026-11-21" },
    { date: "", endDate: "2026-11-27" },
    { date: "2026-11-21", endDate: "2026-11-31" }
  ])("rejects invalid date-only windows before canonical writes: %j", async dates => {
    const before = await vault.bytes(store.taskDbPath());
    await expect(store.createTask({ title: "虚构非法期间", ...dates })).rejects.toThrow();
    expect(await vault.bytes(store.taskDbPath())).toBe(before);
  });
  it("lets a hard deadline remain independent of the end of a window", async () => {
    const row = await store.createTask({ title: "虚构带独立交付日", date: "2026-11-21", endDate: "2026-11-30", dueDate: "2026-11-25" });
    expect(isTaskOverdue(row, "2026-11-24")).toBe(false);
    expect(isTaskOverdue(row, "2026-11-26")).toBe(true);
    expect(parseVaultTasks(await vault.bytes(store.taskMirrorPath())).find(t => t.id === row.id)).toMatchObject({ date: row.date, endDate: row.endDate, dueDate: row.dueDate });
  });
  it("persists an explicit window, changes it through the real tool and undoes only that change", async () => {
    const row = await store.createTask({ title: "虚构两日分次整理", date: today, endDate: "2026-11-24", startTime: "22:00", endTime: "02:00", scheduleMode: "window", dueDate: "2026-11-28" });
    const fresh = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    expect(await fresh.getTask(row.id)).toMatchObject({ scheduleMode: "window", startTime: "22:00", endTime: "02:00", dueDate: "2026-11-28" });
    expect(parseVaultTasks(await vault.bytes(store.taskMirrorPath())).find(t => t.id === row.id)).toMatchObject({ scheduleMode: "window" });
    expect(taskDayInterval(await fresh.getTask(row.id), today)).toBeUndefined();
    const runtime = new AgentRuntime({ store: fresh, refreshViews: async () => {} });
    const result = await runtime.executeAiToolCall({ name: "update_tasks", arguments: { updates: [{ taskIdOrTitle: row.id, scheduleMode: "fixed" }] } }, "kimi");
    expect(result.success, result.output).toBe(true);
    expect(taskDayInterval(await fresh.getTask(row.id), today)).toEqual({ start: 1320, end: 1440 });
    await runtime.undoOperation(result.receipt!.operationId);
    expect(await fresh.getTask(row.id)).toMatchObject({ scheduleMode: "window", dueDate: "2026-11-28", endDate: "2026-11-24" });
  });
  it("rejects an invalid explicit mode without changing either task file", async () => {
    const before = await Promise.all([store.taskDbPath(), store.taskMirrorPath()].map(path => vault.bytes(path)));
    const input = { title: "虚构错误方式", date: today, scheduleMode: "daily" };
    await expect(store.createTask(input as never)).rejects.toThrow();
    expect(await Promise.all([store.taskDbPath(), store.taskMirrorPath()].map(path => vault.bytes(path)))).toEqual(before);
  });
  it("saves a cleared explicit window as unscheduled while retaining its independent deadline", async () => {
    const row = await store.createTask({ title: "虚构清空期间安排", date: today, endDate: "2026-12-02", scheduleMode: "window", startTime: "16:15", endTime: "16:45", dueDate: "2026-12-05", dueTime: "18:00" });
    await store.updateTaskDetails(row.id, { title: row.title, date: "", endDate: "", startTime: "", endTime: "", time: "", scheduleMode: "fixed" });
    const fresh = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    expect(await fresh.getTask(row.id)).toMatchObject({ date: "", endDate: "", startTime: "", endTime: "", scheduleMode: "fixed", dueDate: "2026-12-05", dueTime: "18:00" });
    expect((await fresh.getTaskDashboard(today, { forContext: true })).noDate.map(t => t.id)).toContain(row.id);
    expect(parseVaultTasks(await vault.bytes(store.taskMirrorPath())).find(t => t.id === row.id)).toMatchObject({ date: "", endDate: "", scheduleMode: "fixed", dueDate: "2026-12-05" });
  });
  it.each(["window", "fixed"] as const)("creates an explicit %s through the same chat tool and exactly undoes it", async scheduleMode => {
    const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    const result = await runtime.executeAiToolCall({ name: "create_task", arguments: { title: "虚构明确安排蓝纸", date: today, endDate: "2026-11-25", startTime: "16:15", endTime: "16:45", scheduleMode } }, "kimi");
    expect(result.success, result.output).toBe(true);
    const [row] = (await store.readTaskDb({ readOnly: true })).tasks;
    expect(row.scheduleMode).toBe(scheduleMode);
    expect(parseVaultTasks(await vault.bytes(store.taskMirrorPath())).find(t => t.id === row.id)?.scheduleMode).toBe(scheduleMode);
    expect(taskDayInterval(row, "2026-11-24")).toEqual(scheduleMode === "window" ? undefined : { start: 0, end: 1440 });
    await runtime.undoOperation(result.receipt!.operationId);
    expect((await store.readTaskDb({ readOnly: true })).tasks).toEqual([]);
  });
  it.each(["daily", 42, true, null])("rejects invalid chat scheduling mode %j before task writes", async scheduleMode => {
    const before = await Promise.all([store.taskDbPath(), store.taskMirrorPath()].map(path => vault.bytes(path)));
    const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    const result = await runtime.executeAiToolCall({ name: "create_task", arguments: { title: "虚构坏方式蓝纸", date: today, endDate: "2026-11-25", scheduleMode } }, "kimi");
    expect(result.success).toBe(false);
    expect(await Promise.all([store.taskDbPath(), store.taskMirrorPath()].map(path => vault.bytes(path)))).toEqual(before);
  });
  it("offers period work separately in task context and does not block a daily batch", async () => {
    const row = await store.createTask({ title: "虚构分周检查紫纸", date: "2026-11-21", endDate: "2026-11-27", startTime: "16:15", endTime: "16:45", estimateMin: 1200 });
    const context = await store.buildTaskContext(today);
    expect(context).toContain("Period Windows"); expect(context).toContain(row.title);
    const tomorrow = context.slice(context.indexOf("## Tomorrow"), context.indexOf("## Period Windows"));
    expect(tomorrow).not.toContain(row.title);
    const plan = await planTaskBatch(store, { name: "create_task_batch", arguments: { date: today, availableStart: "16:15", tasks: [{ title: "虚构今日贴绿签", estimateMin: 30 }] } }, now);
    expect(plan.calls[0].arguments).toMatchObject({ date: today, startTime: "16:15", endTime: "16:45" });
  });
  it("counts the completion target once instead of calling a month window due every day", async () => {
    const row = await store.createTask({ title: "虚构跨月完成目标", date: "2026-11-21", endDate: "2026-12-02", estimateMin: 1200 });
    expect(todayTaskCounts([row], today, now).scheduled).toBe(0);
    expect(todayTaskCounts([row], "2026-12-02", new Date(2026, 11, 2, 10)).scheduled).toBe(1);
    const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    const result = await runtime.executeAiToolCall({ name: "get_stats", arguments: { domain: "tasks", range: "this_month" } }, "kimi");
    expect(result.success, result.output).toBe(true);
    expect(JSON.parse(result.output).plannedCount).toBe(0);
  });
});
