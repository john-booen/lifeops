import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { addDays, formatDate } from "../src/date";
import { taskCapacity, taskCategory, taskEstimates } from "../src/features/tasks/capacity";
import { prioritizeTasks } from "../src/features/tasks/priority";
import { buildTaskFromInput, parseVaultTasks } from "../src/vaultApi";
import type { StoreHost } from "../src/store/settingsSlice";
import type { LifeOpsTask } from "../src/types";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}));
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { DiskVault } = await import("./helpers/diskVault");
const now = new Date(2026, 10, 12, 10);
const today = formatDate(now);

function task(id: string, overrides: Partial<LifeOpsTask> = {}): LifeOpsTask {
  return { ...buildTaskFromInput({ title: id, date: today, category: "work", estimateMin: 10 }, now, () => id), ...overrides };
}

function completed(id: string, offset: number, estimateMin = 10): LifeOpsTask {
  const date = addDays(today, offset), completedAt = new Date(date + "T18:00:00").toISOString();
  return task(id, { date, status: "completed", completedAt, estimateMin });
}

describe("capacity and task priority", () => {
  it("uses the median and strict P75 count threshold from the last 28 completed days", () => {
    const history = [2, 4, 6, 8].flatMap((count, index) => Array.from({ length: count }, (_, item) => completed(`h-${index}-${item}`, -1 - index)));
    const active = Array.from({ length: 9 }, (_, index) => task(`a-${index}`, { estimateMin: 5 }));
    expect(taskCapacity([...history, ...active.slice(0, 8), completed("outside", -29)], now)).toMatchObject({
      typicalCount: 5, typicalMin: 50, plannedCount: 8, overloaded: false
    });
    expect(taskCapacity([...history, ...active], now)).toMatchObject({ plannedCount: 9, plannedMin: 45, overloaded: true });
  });

  it("detects a duration-only overload and keeps fixed and hard-deadline tasks out of defer suggestions", () => {
    const history = [completed("history", -1, 60)];
    expect(taskCapacity([...history, task("threshold", { estimateMin: 72 })], now).overloaded).toBe(false);
    const result = taskCapacity([...history, task("fixed", { startTime: "10:20", estimateMin: 35 }),
      task("due", { dueDate: today, estimateMin: 30 }), task("flexible", { estimateMin: 30, quadrant: "not-important-not-urgent" }),
      task("future", { date: addDays(today, 1), estimateMin: 999 })], now);
    expect(result).toMatchObject({ overloaded: true, plannedCount: 3, plannedMin: 95, typicalMin: 60, suggestDefer: ["flexible"] });
  });

  it("counts a scheduled day with no completions and distinguishes missing history", () => {
    expect(taskCapacity([task("new")], now)).toMatchObject({ typicalCount: null, typicalMin: null, overloaded: false });
    const historical = task("old", { date: addDays(today, -2), status: "abandoned" });
    expect(taskCapacity([historical, completed("done", -1), task("new")], now)).toMatchObject({ typicalCount: 0.5, typicalMin: 5 });
  });

  it("estimates missing minutes by category and preserves legacy custom categories", () => {
    const estimate = taskEstimates([completed("one", -1, 25), completed("two", -2, 45),
      { ...completed("custom", -3, 55), category: "原有分类" }]);
    expect(taskCategory(task("missing", { category: "" }))).toBe("work");
    expect(estimate(task("missing", { category: "", estimateMin: undefined }))).toBe(35);
    expect(estimate(task("custom", { category: "原有分类", estimateMin: undefined }))).toBe(55);
    expect(estimate(task("no-history", { category: "learning", estimateMin: undefined }))).toBe(30);
    expect(estimate(task("explicit", { estimateMin: 15 }))).toBe(15);
  });

  it("uses concrete reasons for deadlines, importance, near appointments and low energy", () => {
    const overdue = task("过期重要事项", { dueDate: addDays(today, -1), quadrant: "important-urgent", estimateMin: 100 });
    const appointment = task("今天见客户", { startTime: "10:30", quadrant: "important-not-urgent" });
    const penalty = task("补写反思", { date: "", category: "punishment", quadrant: "not-important-not-urgent" });
    const result = prioritizeTasks([overdue, appointment, penalty, completed("done", -1)], now, 2);
    expect(result.map(({ task, score }) => [task.id, score])).toEqual([[appointment.id, 6], [overdue.id, 4], [penalty.id, 1]]);
    expect(result[0].reasons).toEqual(["今天到期", "重要不紧急", "一小时内有安排"]);
    expect(result[1].reasons).toContain("精力偏低，长任务后排");
  });

  it("keeps a multi-day plan in today's load without making it overdue early", () => {
    const yesterday = addDays(today, -1);
    const spanning = task("虚构跨日任务", { date: yesterday, endDate: addDays(today, 1) });
    const hardDeadline = task("虚构必须截止", { ...spanning, id: "hard", dueDate: yesterday });
    expect(taskCapacity([spanning, hardDeadline], now).plannedCount).toBe(2);
    expect(prioritizeTasks([spanning], now)[0].reasons).not.toContain("已逾期");
    expect(prioritizeTasks([hardDeadline], now)[0].reasons).toContain("已逾期");
    expect(prioritizeTasks([spanning], new Date(addDays(today, 2) + "T12:00:00"))[0].reasons).toContain("已逾期");
  });
});

describe("task planning through real files", () => {
  let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    root = await mkdtemp(join(tmpdir(), "lifeops-task-planning-"));
    vault = new DiskVault(root);
    store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    await store.initializeVault();
    runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  });
  afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

  it("reports only today's unfinished tasks and leaves both task files intact", async () => {
    await store.createTask({ title: "纯虚构今天待办", date: today, dueDate: today });
    await store.createTask({ title: "纯虚构早前积压", date: addDays(today, -2) });
    const done = await store.createTask({ title: "纯虚构已经完成", date: today });
    await store.completeTask(done.id);
    const originals = await Promise.all([store.taskDbPath(), store.taskMirrorPath()].map(path => vault.bytes(path)));
    const result = await runtime.executeAiToolCall({ name: "list_tasks", arguments: {} }, "kimi");
    expect(result.success, result.output).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({ count: 1, tasks: [{ title: "纯虚构今天待办" }] });
    expect(await Promise.all([store.taskDbPath(), store.taskMirrorPath()].map(path => vault.bytes(path)))).toEqual(originals);
  });

  it("adds the overload line only when creation crosses the limit and preserves estimates in JSON and Markdown", async () => {
    const yesterday = addDays(today, -1);
    vi.setSystemTime(new Date(yesterday + "T18:00:00"));
    const historical = await store.createTask({ title: "纯虚构历史完成", date: yesterday, estimateMin: 60 });
    await store.completeTask(historical.id);
    vi.setSystemTime(now);
    await store.createTask({ title: "纯虚构已有安排", date: today, estimateMin: 60 });
    const result = await runtime.executeAiToolCall({ name: "create_task", arguments: {
      title: "纯虚构新增安排", date: today, estimateMin: 20, category: "原有分类"
    } }, "kimi");
    expect(result.success, result.output).toBe(true);
    expect(result.output).toContain("今天已排 2 个，平时你大约完成 1 个。");
    const saved = (await store.readTaskDb({ readOnly: true })).tasks.find(item => item.title === "纯虚构新增安排")!;
    expect(saved).toMatchObject({ estimateMin: 20, category: "原有分类" });
    expect(parseVaultTasks(await vault.bytes(store.taskMirrorPath())).find(item => item.id === saved.id)).toMatchObject({ estimateMin: 20, category: "原有分类" });
    const plan = await runtime.executeAiToolCall({ name: "plan_today", arguments: {} }, "kimi");
    expect(JSON.parse(plan.output)).toMatchObject({ capacity: { overloaded: true, plannedCount: 2, plannedMin: 80 } });
    await runtime.undoOperation(result.receipt!.operationId);
    expect((await store.readTaskDb({ readOnly: true })).tasks.some(item => item.id === saved.id)).toBe(false);
    expect(parseVaultTasks(await vault.bytes(store.taskMirrorPath())).some(item => item.id === saved.id)).toBe(false);
  });

  it("rejects invalid estimates without changing the database or its projection", async () => {
    const paths = [store.taskDbPath(), store.taskMirrorPath()];
    const before = await Promise.all(paths.map(path => vault.bytes(path)));
    const result = await runtime.executeAiToolCall({ name: "create_task", arguments: { title: "纯虚构无效估计", estimateMin: -5 } }, "kimi");
    expect(result.success).toBe(false);
    expect(await Promise.all(paths.map(path => vault.bytes(path)))).toEqual(before);
  });

  it("creates a task with an estimate alongside legacy fixture records", async () => {
    for (const path of [store.taskDbPath(), store.taskMirrorPath()]) {
      await copyFile(join("fixtures/eval-vault", path), join(root, path));
    }
    const mirror = store.taskMirrorPath();
    await vault.seed(mirror, (await vault.bytes(mirror)).replace(/ · 估计分钟=[\d.]+/gu, ""));
    const initial = (await store.readTaskDb({ readOnly: true })).tasks.find(task => task.estimateMin)!;
    const result = await runtime.executeAiToolCall({ name: "create_task", arguments: {
      title: "见客户", date: addDays(today, 1), startTime: "15:00", estimateMin: 45
    } }, "kimi");
    expect(result.success, result.output).toBe(true);
    expect((await store.readTaskDb({ readOnly: true })).tasks).toContainEqual(
      expect.objectContaining({ title: "见客户", startTime: "15:00", estimateMin: 45 })
    );
    expect(parseVaultTasks(await vault.bytes(store.taskMirrorPath())).find(task => task.id === initial.id)?.estimateMin)
      .toBe(initial.estimateMin);
    await store.createTask({ title: "再次写入", date: addDays(today, 1) });
    expect(await vault.bytes(store.taskMirrorPath())).not.toContain("兼容字段：估计分钟");
  });

  it("preserves a legacy task pair if the existing mirror estimate disagrees", async () => {
    const paths = [store.taskDbPath(), store.taskMirrorPath()];
    for (const path of paths) await copyFile(join("fixtures/eval-vault", path), join(root, path));
    const altered = (await vault.bytes(paths[1])).replace(/ · 估计分钟=[\d.]+/gu, "")
      .replace("ID=task-eval-2026-10-16-1 ·", "估计分钟=999 · ID=task-eval-2026-10-16-1 ·");
    await vault.seed(paths[1], altered);
    const before = await Promise.all(paths.map(path => vault.bytes(path)));
    const result = await runtime.executeAiToolCall({ name: "create_task", arguments: { title: "冲突时拒绝写入" } }, "kimi");
    expect(result.success).toBe(false);
    expect(await Promise.all(paths.map(path => vault.bytes(path)))).toEqual(before);
  });

  it("reschedules the existing task and shifts its interval and deadline with an undo receipt", async () => {
    const original = await store.createTask({ title: "虚构周报", date: today, startTime: "15:00", endTime: "16:00", dueDate: today });
    const moved = await runtime.executeAiToolCall({ name: "reschedule_task", arguments: { taskIdOrTitle: original.title, date: "明天" } }, "kimi");
    expect(moved.success, moved.output).toBe(true);
    expect((await store.readTaskDb()).tasks).toMatchObject([{ id: original.id, date: addDays(today, 1), dueDate: addDays(today, 1),
      startTime: "15:00", endTime: "16:00" }]);
    await runtime.undoOperation(moved.receipt!.operationId);
    expect(await store.getTask(original.id)).toMatchObject({ date: today, dueDate: today });
  });

  it("rejects a capacity-aware preview that exceeds the remaining room", async () => {
    const tomorrow = addDays(today, 1);
    await store.createTask({ title: "已有一项", date: tomorrow });
    const prepareTaskPlan = vi.fn();
    const agent = new AgentRuntime({ store, refreshViews: async () => {}, prepareTaskPlan });
    const result = await agent.executeAiToolCall({ name: "propose_task_plan", arguments: { capacityAware: true,
      tasks: ["一", "二", "三"].map(title => ({ title, date: tomorrow })) } }, "kimi", "安排明天");
    expect(result.output).toContain("可再安排 2 项");
    expect(result.success).toBe(false);
    expect(prepareTaskPlan).not.toHaveBeenCalled();
    expect((await store.readTaskDb()).tasks).toHaveLength(1);
  });
});
