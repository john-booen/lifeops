import { activityNotePath } from "../src/activityRecords";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentRuntime } from "../src/agentRuntime";
import { todayString } from "../src/date";
import type { StoreHost } from "../src/store/settingsSlice";
import type { HabitDefinition, HabitInput, LifeOpsTask, LifeOpsTaskQuadrant } from "../src/types";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, ItemView: class {}, WorkspaceLeaf: class {},
  setIcon: vi.fn(), normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { applyStatusBarPanel } = await import("../src/panel/statusBar");

let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: AgentRuntime;
const date = "2026-09-14";
const input: HabitInput = { name: "阅读", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1, startDate: "2026-08-16", penaltyThreshold: 100 };
function reopen() {
  store = new LifeOpsStore({ vault: new DiskVault(root) } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
}
async function operation(work: (scope: StoreHost) => Promise<unknown>, id?: string) {
  const result = await runtime.executeLocalOperation("basic-local-test", {}, work, id);
  expect(result.success, result.output).toBe(true);
  return result;
}
async function createHabit(overrides: Partial<HabitInput> = {}) {
  let habit!: HabitDefinition;
  await operation(async scope => { habit = await scope.createHabit({ ...input, ...overrides }); });
  return habit;
}
async function item(habitId: string) {
  return (await store.getTaskDashboard(date)).habits.find(entry => entry.habit.id === habitId)!;
}

// Render the real panel methods, replacing only the native element boundary.
// This exercises their date selection and visible statistics without a browser or devices.
class Element {
  readonly children: Element[] = [];
  readonly style = { setProperty: vi.fn() };
  constructor(readonly options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {}
  createDiv(options: Element["options"] = {}) { const child = new Element(options); this.children.push(child); return child; }
  createSpan(options: Element["options"] = {}) { return this.createDiv(options); }
  createEl(_tag: string, options: Element["options"] = {}) { return this.createDiv(options); }
  texts(): string[] { return [this.options.text ?? "", ...this.children.flatMap(child => child.texts())]; }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
}
function panel() {
  class Panel {}
  applyStatusBarPanel(Panel);
  return Object.assign(new Panel(), { smallAddButton: vi.fn(), renderCalendarEvent: vi.fn() }) as any;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 14, 10));
  root = await mkdtemp(join(tmpdir(), "lifeops-basic-local-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
});
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

describe("local task and habit daily-use checks with actual files", () => {
  it("keeps date and four-quadrant views after reopening, including explicitly clearing a date", async () => {
    const quadrants: LifeOpsTaskQuadrant[] = ["important-urgent", "important-not-urgent", "not-important-urgent", "not-important-not-urgent"];
    const tasks: LifeOpsTask[] = [];
    for (const [index, quadrant] of quadrants.entries()) {
      await operation(async scope => { tasks.push(await scope.createTask({ title: `本地任务 ${index}`, quadrant, date: index === 0 ? date : "2026-09-15" })); });
    }
    await operation(scope => scope.updateTaskDetails(tasks[2].id, { title: tasks[2].title, date: "" }));
    reopen();
    const board = await store.getTaskDashboard(date);
    expect(board.today.map(task => task.id)).toEqual([tasks[0].id]);
    expect(board.tomorrow.map(task => task.id).sort()).toEqual([tasks[1].id, tasks[3].id].sort());
    expect(board.noDate.map(task => task.id)).toEqual([tasks[2].id]);
    for (const [index, quadrant] of quadrants.entries()) expect(board.quadrants[quadrant].map(task => task.id)).toEqual([tasks[index].id]);
  });

  it("uses the local completion day on both the task dashboard and real calendar renderer", async () => {
    // In Shanghai this is 00:30 on September 15 while the persisted UTC day is still September 14.
    vi.setSystemTime(new Date(2026, 8, 15, 0, 30));
    expect(todayString()).toBe("2026-09-15");
    let task!: LifeOpsTask;
    await operation(async scope => { task = await scope.createTask({ title: "凌晨完成的无日期任务", date: "" }); });
    await operation(scope => scope.completeTask(task.id));
    reopen();
    const current = await store.getTaskDashboard("2026-09-15");
    const previous = await store.getTaskDashboard("2026-09-14");
    expect.soft(current.completedToday.map(entry => entry.id)).toEqual([task.id]);
    expect.soft(previous.completedToday).toEqual([]);
    const view = panel();
    view.renderDayCalendar(new Element(), current, "2026-09-15");
    expect.soft(view.renderCalendarEvent.mock.calls.map((call: any[]) => call[1].id)).toEqual([task.id]);
    view.renderCalendarEvent.mockClear();
    view.renderDayCalendar(new Element(), previous, "2026-09-14");
    expect(view.renderCalendarEvent).not.toHaveBeenCalled();
  });

  it("renders every hour, explicit ranges and goal-only tasks without omitting early plans", async () => {
    const plans = [
      { title: "清晨区间", startTime: "02:00", endTime: "03:00" },
      { title: "上午区间", startTime: "09:00", endTime: "12:00" },
      { title: "仅完成目标", endTime: "12:00" },
      { title: "旧时刻仍保留", time: "12:00" }
    ];
    for (const plan of plans) await operation(scope => scope.createTask({ ...plan, date }));
    const view = panel(), container = new Element();
    view.renderDayCalendar(container, await store.getTaskDashboard(date), date);
    expect(container.texts()).toContain("00:00");
    expect(container.texts()).toContain("23:00");
    expect(container.texts()).toContain("计划 09:00–12:00");
    expect(container.texts()).toContain("未排区间／仅目标");
    expect(view.renderCalendarEvent.mock.calls.map((call: any[]) => call[1].title).sort()).toEqual(plans.map(plan => plan.title).sort());
  });

  it("persists completed, missed and leave days separately from an unrecorded day, including their heatmap labels", async () => {
    const habit = await createHabit();
    await operation(scope => scope.recordHabitStatus(habit.id, "done", "2026-09-11", "读完一章"));
    await operation(scope => scope.recordHabitStatus(habit.id, "missed", "2026-09-12", "当天没有读"));
    await operation(scope => scope.recordHabitStatus(habit.id, "leave", "2026-09-13", "休息一天"));
    reopen();
    const saved = await item(habit.id);
    expect(saved.status).toBe("pending");
    expect(saved.history.map(entry => [entry.date, entry.status, entry.note])).toEqual([
      ["2026-09-11", "done", "读完一章"], ["2026-09-12", "missed", "当天没有读"], ["2026-09-13", "leave", "休息一天"]
    ]);
    const el = new Element();
    panel().renderHabitHeatmap(el, saved);
    const titles = el.all().map(node => node.options.attr?.title).filter(Boolean);
    expect(titles).toHaveLength(84);
    expect(titles).toEqual(expect.arrayContaining(["2026-09-11 完成", "2026-09-12 未完成", "2026-09-13 请假", "2026-09-14 未打卡"]));
  });

  it("changes and clears today's checkin while keeping history, and can restore the cleared record", async () => {
    const habit = await createHabit();
    await operation(scope => scope.recordHabitStatus(habit.id, "done", "2026-09-13", "昨天的记录"));
    await operation(scope => scope.recordHabitStatus(habit.id, "missed", date, "还没完成"));
    await operation(scope => scope.recordHabitStatus(habit.id, "done", date, "后来完成了"));
    const before = await vault.bytes(store.habitDbPath());
    const cleared = await operation(scope => scope.clearHabitCheckin(habit.id, date));
    reopen();
    expect((await item(habit.id)).status).toBe("pending");
    expect((await item(habit.id)).history.map(entry => entry.note)).toEqual(["昨天的记录"]);
    await runtime.undoOperation(cleared.callId);
    expect(await vault.bytes(store.habitDbPath())).toBe(before);
    expect((await item(habit.id)).history.find(entry => entry.date === date)?.note).toBe("后来完成了");
  });

  it("shows the persisted 7 and 30 day statistics for once-daily habits", async () => {
    const habit = await createHabit();
    for (const recorded of ["2026-08-16", "2026-08-31", "2026-09-09", "2026-09-11", "2026-09-14"]) {
      await operation(scope => scope.recordHabitStatus(habit.id, "done", recorded));
    }
    await operation(scope => scope.recordHabitStatus(habit.id, "missed", "2026-09-12"));
    await operation(scope => scope.recordHabitStatus(habit.id, "leave", "2026-09-13"));
    reopen();
    const el = new Element();
    panel().renderHabitDetail(el, await item(habit.id));
    expect(el.texts()).toEqual(expect.arrayContaining(["7天 3/7", "30天 5/30", "完成率 17%", "未完成 1 次", "请假 1 次"]));
  });

  it("excludes pre-start and non-required dates from daily interval statistics", async () => {
    const habit = await createHabit({ startDate: "2026-09-10", frequencyInterval: 2 });
    await operation(scope => scope.recordHabitStatus(habit.id, "done", "2026-09-10"));
    await operation(scope => scope.recordHabitStatus(habit.id, "done", "2026-09-14"));
    reopen();
    const saved = await item(habit.id), el = new Element();
    panel().renderHabitDetail(el, saved);
    expect(saved.requiredToday).toBe(true);
    expect(el.texts()).toEqual(expect.arrayContaining(["7天 2/3", "30天 2/3", "完成率 67%"]));
    expect((await store.getTaskDashboard("2026-09-13")).habits[0].requiredToday).toBe(false);
  });

  it("shows device readings as measured days and counts only days that meet the daily goal", async () => {
    const habit = await createHabit({ name: "虚构设备步数", source: "health:steps", startDate: "2026-09-10",
      target: { kind: "number", unit: "步", perDay: 3000 } });
    const before = new Element();
    panel().renderHabitDetail(before, await item(habit.id));
    expect(before.texts()).toContain("有读数 0 天");
    expect(before.texts()).toContain("完成率 暂无数据");
    await store.appendHealthEntry({ date: "2026-09-11", steps: 0 });
    await store.appendHealthEntry({ date: "2026-09-13", steps: 3500 });
    await store.recordHabitStatus(habit.id, "leave", "2026-09-12");
    reopen();
    const detail = new Element();
    panel().renderHabitDetail(detail, await item(habit.id));
    expect(detail.texts()).toEqual(expect.arrayContaining(["有读数 2 天", "7天 1/2", "完成率 50%"]));
    expect(detail.all().map(node => node.options.attr?.title)).toEqual(expect.arrayContaining([
      "2026-09-11 0/3000 步", "2026-09-12 请假", "2026-09-13 3500/3000 步", "2026-09-14 未记录"
    ]));
  });

  it("retains weekly progress across dates and a restart without requiring a daily checkin after reaching the weekly target", async () => {
    const habit = await createHabit({ frequencyUnit: "week", targetCount: 3, startDate: date });
    await operation(scope => scope.recordHabitStatus(habit.id, "done", date));
    await operation(scope => scope.recordHabitStatus(habit.id, "done", "2026-09-15"));
    await operation(scope => scope.recordHabitStatus(habit.id, "done", "2026-09-15"));
    reopen();
    const saved = (await store.getTaskDashboard("2026-09-16")).habits[0];
    expect(saved.periodDone).toBe(3);
    expect(saved.periodTarget).toBe(3);
    expect(saved.requiredToday).toBe(false);
    expect(saved.status).toBe("done");
    expect(saved.checkin).toBeUndefined();
    expect(saved.history).toHaveLength(2);
  });

  it("rolls back checkin data and its readable snapshot if writing the associated habit record fails", async () => {
    const habit = await createHabit();
    const dbBefore = await vault.bytes(store.habitDbPath()), mirrorBefore = await vault.bytes(store.habitMirrorPath());
    const create = vault.create.bind(vault);
    vault.create = async (path, content) => {
      if (path === activityNotePath(store, "habits", date)) throw new Error("synthetic daily-note disk failure");
      return create(path, content);
    };
    const result = await runtime.executeLocalOperation("local-record-habit", { habitId: habit.id, date }, scope => scope.recordHabitStatus(habit.id, "done", date));
    expect(result.success).toBe(false);
    expect(await vault.bytes(store.habitDbPath())).toBe(dbBefore);
    expect(await vault.bytes(store.habitMirrorPath())).toBe(mirrorBefore);
    expect(store.getFile(store.dailyNotePath(date, "早"))).toBeNull();
    reopen();
    expect((await item(habit.id)).status).toBe("pending");
  });
});
