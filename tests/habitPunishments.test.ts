import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, formatDate } from "../src/date";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { HabitPunishmentLifecycle } from "../src/features/habits/punishmentLifecycle";
import { advanceCompensationDebt, compensationDueLabel, summarizeCompensationDebt } from "../src/features/habits/compensationDebt";
import { buildTodayCard } from "../src/features/today/model";
import { validateHabitPunishment, validateHabitTarget } from "../src/features/habits/targets";
import type { LocalOperationHost } from "../src/features/serviceHost";
import type { StoreHost } from "../src/store/settingsSlice";
import type { HabitCheckin, HabitDefinition, HabitInput, PunishmentRule } from "../src/types";
import { buildTaskFromInput } from "../src/vaultApi";

vi.mock("obsidian", () => ({
  App: class {}, Modal: class {}, Setting: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}));

const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { DiskVault } = await import("./helpers/diskVault");
const { planHabitPunishments } = await import("../src/features/habits/punishments");
const { correctYesterdayHabit, runScheduledPunishmentCheck } = await import("../src/features/habits/service");

const sunday = new Date(2026, 10, 15, 21, 0);
const date = formatDate(sunday);
const reflection: PunishmentRule = { kind: "reflection", minChars: 100 };
const money: PunishmentRule = { kind: "save_money", amount: 50, currency: "CNY" };
const run: PunishmentRule = { kind: "extra_exercise", activity: "跑步", amount: 3, unit: "公里" };
const walk: PunishmentRule = { kind: "extra_exercise", activity: "快走", amount: 30, unit: "分钟" };

function config(...rules: PunishmentRule[]) {
  return { enabled: true, rules };
}

function habit(id: string, overrides: Partial<HabitDefinition> = {}): HabitDefinition {
  return { id, name: id, startDate: date, frequencyUnit: "day", frequencyInterval: 1,
    targetCount: 1, penaltyThreshold: 3, color: "", createdAt: "", punishment: config(reflection), ...overrides };
}

function checkin(habitId: string, day: string, value?: number): HabitCheckin {
  return { habitId, date: day, count: 1, status: "done", updatedAt: "", note: "", value };
}

function newDebts(habits: HabitDefinition[], now = sunday) {
  return planHabitPunishments(habits, [], [], now).map((input, index) => buildTaskFromInput(input, now, () => `fictional-${index}`));
}

describe("bounded habit judgments", () => {
  it.each([
    { kind: "custom", text: "任意规则" },
    { ...reflection, text: "额外动作" },
    { ...money, currency: "EUR" },
    { ...run, amount: 3.01 },
    { ...walk, amount: 30.01 }
  ])("rejects a disallowed rule (%j)", rule => {
    expect(() => validateHabitPunishment({ enabled: true, rules: [rule] })).toThrow();
  });

  it("requires an explicit positive numeric goal and a unit", () => {
    expect(() => validateHabitTarget({ kind: "number", unit: "公里", perDay: 0 })).toThrow();
    expect(() => validateHabitTarget({ kind: "number", unit: "", perWeek: 5 })).toThrow();
    expect(validateHabitTarget({ kind: "number", unit: " 公里 ", perWeek: 5 })).toMatchObject({ unit: "公里", perWeek: 5 });
  });

  it("evaluates weekly amounts on Sunday at 21:00 and counts off-day records toward the week", () => {
    const target = habit("周目标", { startDate: addDays(date, -6), frequencyInterval: 2,
      target: { kind: "number", unit: "公里", perWeek: 5 } });
    const entries = [checkin(target.id, addDays(date, -5), 3)];
    expect(planHabitPunishments([target], entries, [], new Date(2026, 10, 14, 21))).toEqual([]);
    expect(planHabitPunishments([target], entries, [], new Date(2026, 10, 15, 20, 59))).toEqual([]);
    expect(planHabitPunishments([target], entries, [], sunday)[0]).toMatchObject({
      category: "punishment", dueDate: addDays(date, 1), habitPunishment: { period: "week", level: 1 }
    });
    expect(planHabitPunishments([target], [...entries, checkin(target.id, date, 2)], [], sunday)).toEqual([]);
  });

  it("caps exercise independently by unit and allocates today's allowance to older debts first", () => {
    const habits = [
      habit("一", { punishment: config(run) }), habit("二", { punishment: config(run) }),
      habit("快走", { punishment: config(walk) }), habit("跳绳", { punishment: config({ ...walk, activity: "跳绳" }) })
    ];
    const [oldest, runner, walker, skipping] = newDebts(habits);
    oldest.habitPunishment!.judgedDate = addDays(date, -1);
    const tasks = advanceCompensationDebt([runner, skipping, walker, oldest], habits, date);
    expect(tasks.map(task => task.habitPunishment?.rule)).toEqual([{ ...run, amount: 2 }, { ...walk, activity: "跳绳" }, walk, run]);
    expect(compensationDueLabel(tasks[0].habitPunishment!)).toBe("跑步 2 公里、超量转存 20 元");
    expect(summarizeCompensationDebt(tasks, date)).toMatchObject({ due: { CNY: 20 }, exercise: { 公里: 5, 分钟: 60 } });
  });

  it("shares twice the original goal between debts from one habit and deducts exercise completed today", () => {
    const target = habit("虚构两期跑步", { startDate: addDays(date, -2),
      target: { kind: "number", unit: "公里", perDay: 1, perWeek: 4 }, punishment: config(run) });
    const [older, newer] = newDebts([target]);
    older.habitPunishment!.judgedDate = addDays(date, -1);
    const tasks = advanceCompensationDebt([newer, older], [target], date);
    expect(tasks.map(task => task.habitPunishment?.rule)).toEqual([{ ...run, amount: 0 }, { ...run, amount: 2 }]);
    expect(tasks.map(task => task.habitPunishment?.debt?.overflowCny)).toEqual([60, 20]);
    const completed = { ...tasks[1], status: "completed" as const, completedAt: sunday.toISOString() };
    const [pending] = advanceCompensationDebt([newer, completed], [target], date);
    expect(pending.habitPunishment?.rule).toMatchObject({ amount: 0 });
    expect(pending.habitPunishment?.debt?.overflowCny).toBe(60);
  });

  it("increases the same debt past the third day instead of replacing it with a review reminder", () => {
    const target = habit("日目标", { punishment: config(money) });
    const initial = newDebts([target]);
    const fourth = new Date(2026, 10, 20, 21);
    expect(planHabitPunishments([target], [], initial, fourth)).toEqual([]);
    const advanced = advanceCompensationDebt(initial, [target], formatDate(fourth));
    expect(advanced[0].id).toBe(initial[0].id);
    expect(advanced[0].habitPunishment?.rule).toEqual({ ...money, amount: 250 });
    expect(advanceCompensationDebt(advanced, [target], formatDate(fourth))[0]).toBe(advanced[0]);
  });

  it("opens a new debt only after the previous one is completed", () => {
    const target = habit("日目标", { startDate: addDays(date, -2) });
    const prior = planHabitPunishments([target], [], [], new Date(2026, 10, 13, 21))[0];
    const active = buildTaskFromInput(prior, sunday, () => "previous");
    const entries = [checkin(target.id, addDays(date, -1))];
    expect(planHabitPunishments([target], entries, [active], sunday)).toEqual([]);
    expect(planHabitPunishments([target], entries, [{ ...active, status: "completed" }], sunday)[0].habitPunishment)
      .toMatchObject({ level: 1, openEarlier: 0 });
    expect(planHabitPunishments([target], [{ ...checkin(target.id, date), status: "leave" }], [], sunday)).toEqual([]);
  });

  it("charges defaults immediately and uses rate changes only for future overflow", () => {
    const noRate = habit("虚构跑步", { punishment: config({ ...run, amount: 1 }) });
    const day = addDays(date, 4);
    const accrued = advanceCompensationDebt(newDebts([noRate]), [noRate], day);
    expect(accrued[0].habitPunishment?.rule).toMatchObject({ amount: 2 });
    expect(accrued[0].habitPunishment?.debt).toMatchObject({ overflowUnits: 2, overflowCny: 40 });
    const settings = { exerciseOverflowCny: { 公里: 35 } };
    expect(advanceCompensationDebt(accrued, [noRate], day, settings)[0]).toBe(accrued[0]);
    const next = advanceCompensationDebt(accrued, [noRate], addDays(day, 1), settings);
    expect(summarizeCompensationDebt(next, addDays(day, 1))).toMatchObject({ due: { CNY: 75 }, exercise: { 公里: 2 } });
    const time = habit("虚构快走", { punishment: config({ ...walk, amount: 10 }),
      target: { kind: "number", unit: "分钟", perDay: 2 } });
    const [timeDebt] = advanceCompensationDebt(newDebts([time]), [time], date);
    expect(compensationDueLabel(timeDebt.habitPunishment!)).toBe("快走 4 分钟、超量转存 18 元");
  });

  it("continues reflection past the configured tiers with a default of 100 words and respects later edits", () => {
    const target = habit("虚构反思", { punishment: config({ ...reflection, minChars: 180 }) });
    const day = addDays(date, 6);
    const accrued = advanceCompensationDebt(newDebts([target]), [target], day);
    expect(accrued[0].habitPunishment?.rule).toMatchObject({ minChars: 680 });
    const edited = { ...target, punishment: config({ ...reflection, minChars: 180, dailyIncrease: 30 }) };
    expect(advanceCompensationDebt(accrued, [edited], addDays(day, 1))[0].habitPunishment?.rule).toMatchObject({ minChars: 710 });
  });
});

describe("habit changes through the real store and operation ledger", () => {
  let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
  let lifecycle: HabitPunishmentLifecycle | undefined;
  let host: LocalOperationHost;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(sunday);
    root = await mkdtemp(join(tmpdir(), "lifeops-habit-punishments-"));
    vault = new DiskVault(root);
    store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    await store.initializeVault();
    runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    host = {
      async saveLocalOperation(name, args, execute, options) {
        const result = await runtime.executeLocalOperation(name, args, execute, undefined, options);
        if (!result.success) throw Error(result.output);
      },
      refreshViews: vi.fn(async () => {})
    };
  });
  afterEach(async () => { lifecycle?.stop(); lifecycle = undefined; vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

  it.each(["assistant", "panel", "no user task", "unrelated task added later", "target task edited later"])(
    "only undoes the user task across a scheduled compensation write (%s)", async kind => {
      await store.createHabit({ name: "虚构阅读", frequencyUnit: "day", frequencyInterval: 1,
        targetCount: 1, startDate: date, punishment: config(reflection) });
      const title = "虚构蓝色样品盒贴标签";
      if (kind === "panel") {
        const task = { title, date, time: "15:00" };
        await host.saveLocalOperation("local_createTask", { arguments: [task] }, scope => scope.createTask(task));
      } else if (kind !== "no user task") {
        const result = await runtime.executeAiToolCall({ name: "create_task", arguments: { title, date, time: "15:00" } }, "kimi");
        expect(result.success, result.output).toBe(true);
      }
      await runScheduledPunishmentCheck(host, store, sunday, () => {});
      const compensation = (await store.readTaskDb()).tasks.find(task => task.category === "punishment");
      expect(compensation).toBeDefined();
      let later: Awaited<ReturnType<StoreHost["createTask"]>> | undefined;
      if (kind === "unrelated task added later") later = await store.createTask({ title: "虚构外部新增" });
      if (kind === "target task edited later") {
        const target = (await store.readTaskDb()).tasks.find(task => task.title === title)!;
        await store.updateTaskDetails(target.id, { title, note: "虚构补充说明" });
      }
      const before = await vault.bytes(store.taskDbPath());
      const habits = await vault.bytes(store.habitDbPath());

      const result = await runtime.executeAiToolCall({ name: "undo_latest_operation", arguments: {} }, "kimi", "撤销刚才那个");

      if (kind === "no user task" || kind === "target task edited later") {
        expect(result.success).toBe(false);
        expect(await vault.bytes(store.taskDbPath())).toBe(before);
      } else {
        expect(result.success, result.output).toBe(true);
        expect(result.output).toContain(title);
        expect((await store.readTaskDb()).tasks).toEqual([compensation, ...(later ? [later] : [])]);
        expect(await vault.bytes(store.taskMirrorPath())).not.toContain(title);
      }
      expect(await vault.bytes(store.habitDbPath())).toBe(habits);
    }
  );

  it("undoes selected task A after user task B and automatic compensation C", async () => {
    const add = (title: string) => runtime.executeAiToolCall({ name: "create_task", arguments: { title, date } }, "kimi");
    const first = await add("虚构任务甲");
    expect(first.success, first.output).toBe(true);
    expect((await add("虚构任务乙")).success).toBe(true);
    await store.createHabit({ name: "虚构出门检查", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1,
      startDate: date, punishment: config(reflection) });
    await runScheduledPunishmentCheck(host, store, sunday, () => {});
    const before = (await store.readTaskDb()).tasks;
    expect(before).toHaveLength(3);
    await expect(runtime.undoOperation(first.receipt!.operationId)).resolves.toBe(true);
    expect((await store.readTaskDb()).tasks).toEqual(before.slice(1));
    expect(await vault.bytes(store.taskMirrorPath())).not.toContain("虚构任务甲");
    expect(await vault.bytes(store.taskMirrorPath())).toContain("虚构任务乙");
  });

  it("restores the prior revision of an earlier task reschedule without changing another task", async () => {
    const first = await store.createTask({ title: "虚构排练甲", date });
    const other = await store.createTask({ title: "虚构排练乙", date });
    const rescheduled = await runtime.executeAiToolCall({
      name: "reschedule_task", arguments: { taskIdOrTitle: first.id, date: addDays(date, 1) }
    }, "kimi");
    expect(rescheduled.success, rescheduled.output).toBe(true);
    await store.updateTaskDetails(other.id, { title: other.title, note: "后来补上的说明" });
    const before = await store.readTaskDb();
    await runtime.undoOperation(rescheduled.receipt!.operationId);
    const after = await store.readTaskDb();
    expect(after.tasks).toEqual([first, before.tasks.find(task => task.id === other.id)]);
  });

  it("records actual amounts and rates separately through the model tools, and undoes the last value", async () => {
    const call = (name: string, args: Record<string, unknown>) => runtime.executeAiToolCall({ name, arguments: args }, "kimi");
    expect((await call("create_habit", { name: "虚构跑步", target: { kind: "number", unit: "公里", perDay: 5 } })).success).toBe(true);
    expect((await call("complete_habit", { name: "虚构跑步" })).success).toBe(false);
    expect((await call("complete_habit", { name: "虚构跑步", value: 5, unit: "分钟" })).success).toBe(false);
    expect((await call("complete_habit", { name: "虚构跑步", value: 2, unit: "公里" })).success).toBe(true);
    const board = await store.getTaskDashboard(date);
    expect(board.habits[0]).toMatchObject({ status: "pending", periodDone: 2, periodTarget: 5, periodUnit: "公里" });
    const completed = await call("complete_habit", { name: "虚构跑步", value: 3, unit: "公里" });
    expect(completed.output).toContain("累计 5 公里");
    expect((await store.readHabitDb()).checkins[0]).toMatchObject({ count: 2, value: 5 });
    const stats = await call("get_stats", { domain: "habits", range: "today" });
    expect(JSON.parse(stats.output).habits[0]).toMatchObject({ doneCount: 2, valueTotal: 5, completionPercent: 100, goals: [{ met: 1, periods: 1 }] });
    expect(await vault.bytes(store.habitMirrorPath())).toContain("5 公里");
    const [habit] = (await store.readHabitDb()).habits;
    await expect(store.updateHabitDetails(habit.id, { ...habit, target: { kind: "number", unit: "分钟", perDay: 5 } }))
      .rejects.toThrow("保留原单位");
    await runtime.undoOperation(completed.receipt!.operationId);
    expect((await store.readHabitDb()).checkins[0]).toMatchObject({ count: 1, value: 2 });
  });

  it("creates one next-day compensation at the scheduled minute and clears it when completed", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(2026, 10, 15, 20, 59));
    const input: HabitInput = { name: "虚构习惯", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1,
      startDate: date, punishment: config(reflection) };
    const target = await store.createHabit(input);
    lifecycle = new HabitPunishmentLifecycle((now, current) => runScheduledPunishmentCheck(host, store, now, current));
    lifecycle.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect((await store.readTaskDb()).tasks).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(host.refreshViews).toHaveBeenCalledTimes(1));
    const [task] = (await store.readTaskDb()).tasks;
    expect(task).toMatchObject({ category: "punishment", status: "active", dueDate: addDays(date, 1),
      habitPunishment: { habitId: target.id, level: 1, missedDates: [date] } });
    expect((await store.readHabitDb()).lastPunishmentDate).toBe(date);
    await runScheduledPunishmentCheck(host, store, sunday, () => {});
    expect((await store.readTaskDb()).tasks).toHaveLength(1);
    const list = async () => {
      const result = await runtime.executeAiToolCall({ name: "list_tasks", arguments: { category: "punishment" } }, "kimi");
      expect(result.success, result.output).toBe(true);
      return JSON.parse(result.output);
    };
    expect(await list()).toMatchObject({ count: 1, tasks: [{ evidence: expect.stringContaining(date) }] });
    await store.updateTaskDetails(task.id, { title: task.title, note: "用户补充备注" });
    expect((await list()).tasks[0].evidence).toContain(date);
    const done = await runtime.executeAiToolCall({ name: "complete_task", arguments: { taskIdOrTitle: task.id } }, "kimi");
    expect(done.success, done.output).toBe(true);
    expect(await list()).toMatchObject({ count: 0 });
    await runtime.undoOperation(done.receipt!.operationId);
    expect(await list()).toMatchObject({ count: 1 });
  });

  it("checks missed days at morning startup and corrects only yesterday's selected debt", async () => {
    const first = await store.createHabit({ name: "虚构两次检查", frequencyUnit: "day", frequencyInterval: 1, targetCount: 2,
      startDate: date, punishment: config(reflection) });
    const other = await store.createHabit({ name: "虚构另一习惯", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1,
      startDate: date, punishment: config(money) });
    const morning = new Date(2026, 10, 16, 8);
    vi.setSystemTime(morning);
    lifecycle = new HabitPunishmentLifecycle((now, current) => runScheduledPunishmentCheck(host, store, now, current));
    lifecycle.start();
    await vi.waitFor(() => expect(host.refreshViews).toHaveBeenCalledOnce());
    const tasks = (await store.readTaskDb()).tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks.map(task => task.habitPunishment?.judgedDate)).toEqual([date, date]);
    expect((await store.readHabitDb()).habitPunishmentCheckedThrough).toEqual({ [first.id]: date, [other.id]: date });
    const selected = tasks.find(task => task.habitPunishment?.habitId === first.id)!;
    const card = buildTodayCard(await store.getTaskDashboard(formatDate(morning)), [], morning);
    expect(card.penalties.every(penalty => penalty.canCorrectYesterday)).toBe(true);
    await correctYesterdayHabit(host, selected.id);
    expect((await store.readHabitDb()).checkins).toMatchObject([{ habitId: first.id, date, status: "done", count: 2 }]);
    const active = () => store.readTaskDb().then(db => db.tasks.filter(task => task.status === "active"));
    expect(await active()).toMatchObject([{ habitPunishment: { habitId: other.id } }]);
    await runScheduledPunishmentCheck(host, store, morning, () => {});
    expect(await active()).toHaveLength(1);
    const undone = await runtime.executeAiToolCall({ name: "undo_latest_operation", arguments: {} }, "kimi");
    expect(undone.success, undone.output).toBe(true);
    expect((await store.readHabitDb()).checkins).toEqual([]);
    expect(await active()).toHaveLength(2);
  });

  it("limits catch-up to seven past days and reuses the prior check date for an existing database", async () => {
    const old = addDays(date, -14);
    const target = await store.createHabit({ name: "虚构跨夜习惯", frequencyUnit: "day", frequencyInterval: 1,
      targetCount: 1, startDate: old, punishment: config(reflection) });
    await store.writeHabitDb({ ...(await store.readHabitDb()), lastPunishmentDate: old });
    const morning = new Date(2026, 10, 15, 8);
    vi.setSystemTime(morning);
    await runScheduledPunishmentCheck(host, store, morning, () => {});
    expect((await store.readTaskDb()).tasks).toMatchObject([{ habitPunishment: { habitId: target.id, judgedDate: addDays(date, -7) } }]);
    expect((await store.readHabitDb()).habitPunishmentCheckedThrough).toEqual({ [target.id]: addDays(date, -1) });
  });

  it("accrues money and words for three days, records payment once, and restores the debt on undo", async () => {
    await store.createHabit({ ...habit("虚构存钱"), punishment: config(money) });
    await store.createHabit({ ...habit("虚构反思"), punishment: config({ ...reflection, dailyIncrease: 40 }) });
    await runScheduledPunishmentCheck(host, store, sunday, () => {});
    const third = new Date(2026, 10, 19, 21);
    vi.setSystemTime(third);
    const day = formatDate(third);
    await runScheduledPunishmentCheck(host, store, third, () => {});
    const before = await vault.bytes(store.taskDbPath());
    const habitsBefore = await vault.bytes(store.habitDbPath());
    await runScheduledPunishmentCheck(host, store, third, () => {});
    expect(await vault.bytes(store.taskDbPath())).toBe(before);
    expect(await vault.bytes(store.habitDbPath())).toBe(habitsBefore);
    const board = await store.getTaskDashboard(day);
    expect(buildTodayCard(board, [], third).compensationSummary).toBe("欠 2 项 · 最长已拖 3 天 · 应存 200 元 · 反思 220 字");
    const moneyTask = board.tasks.find(task => task.habitPunishment?.rule?.kind === "save_money")!;
    const reflectionTask = board.tasks.find(task => task.habitPunishment?.rule?.kind === "reflection")!;
    const complete = (taskId: string) => runtime.executeAiToolCall({ name: "complete_task", arguments: { taskIdOrTitle: taskId } }, "kimi");
    const paid = await complete(moneyTask.id);
    expect(paid.success, paid.output).toBe(true);
    const done = await complete(reflectionTask.id);
    expect(done.success, done.output).toBe(true);
    const settled = await store.getTaskDashboard(day);
    expect(buildTodayCard(settled, [], third).compensationSummary).toBe("");
    expect(summarizeCompensationDebt(settled.tasks, day)).toMatchObject({ count: 0, saved: { CNY: 200 } });
    expect(await runtime.undoOperation(done.receipt!.operationId)).toBe(true);
    expect(await runtime.undoOperation(paid.receipt!.operationId)).toBe(true);
    const reopened = await store.getTaskDashboard(day);
    expect(summarizeCompensationDebt(reopened.tasks, day)).toMatchObject({ count: 2, due: { CNY: 200 }, saved: {} });
  });

  it("starts a legacy debt from its stored amount without retroactive charges or changes to old reviews", async () => {
    const initialDate = new Date(2026, 10, 12, 21);
    const oldTask = newDebts([habit("旧存钱", { startDate: "2026-11-12", punishment: config(money) })], initialDate)[0];
    const old = { ...oldTask.habitPunishment!, rule: { ...money, amount: 125 }, debt: undefined };
    const debt = { ...oldTask, habitPunishment: old };
    const review = { ...oldTask, id: "fictional-review", habitPunishment: { ...old, rule: undefined } };
    const migrated = advanceCompensationDebt([debt, review], [], date);
    expect(migrated[0].habitPunishment?.rule).toMatchObject({ amount: 125 });
    expect(migrated[1]).toBe(review);
    expect(advanceCompensationDebt(migrated, [], date)[0]).toBe(migrated[0]);
    expect(advanceCompensationDebt(migrated, [], addDays(date, 1))[0].habitPunishment?.rule).toMatchObject({ amount: 175 });
  });

  it("migrates already assessed debts from their stored amounts and keeps paid overflow prices", () => {
    const habitRule = { ...run, amount: 1, overflowCnyPerUnit: 25 };
    const target = habit("虚构旧跑步", { punishment: config(habitRule) });
    const [task] = newDebts([target]);
    const judged = task.habitPunishment!;
    const debt = { base: habitRule, appliedOn: addDays(date, 2), overflowUnits: 2 };
    const legacy = { ...task, habitPunishment: { ...judged, rule: { ...habitRule, amount: 2 }, debt } };
    const paid = { ...legacy, id: "fictional-old-paid", status: "completed" as const, completedAt: sunday.toISOString() };
    const day = addDays(date, 6);
    const edited = { ...target, punishment: config({ ...habitRule, overflowCnyPerUnit: 35 }) };
    const assessed = advanceCompensationDebt([legacy, paid], [edited], day);
    expect(assessed[0].habitPunishment?.debt).toMatchObject({ appliedOn: day, overflowCny: 50 });
    expect(assessed[1]).toBe(paid);
    expect(summarizeCompensationDebt(assessed, day)).toMatchObject({ due: { CNY: 50 }, saved: { CNY: 50 } });
    expect(advanceCompensationDebt(assessed, [edited], day)[0]).toBe(assessed[0]);
    const nextDay = addDays(day, 1);
    expect(summarizeCompensationDebt(advanceCompensationDebt(assessed, [edited], nextDay), nextDay))
      .toMatchObject({ due: { CNY: 85 }, saved: { CNY: 50 } });
  });

  it("converts a legacy outstanding unpriced balance once without adding missed daily increases", () => {
    const exercise = { ...run, amount: 1 };
    const target = habit("虚构待折算", { punishment: config(exercise) });
    const [task] = newDebts([target]);
    const day = addDays(date, 7);
    const legacy = { ...task, habitPunishment: { ...task.habitPunishment!, rule: { ...exercise, amount: 2 },
      debt: { base: exercise, appliedOn: addDays(date, 2), overflowUnits: 2 } } };
    const [assessed] = advanceCompensationDebt([legacy], [target], day);
    expect(compensationDueLabel(assessed.habitPunishment!)).toBe("跑步 2 公里、超量转存 40 元");
    expect(advanceCompensationDebt([assessed], [target], day)[0]).toBe(assessed);
  });

  it("keeps the count-based target and stores an explicitly measured amount and unit", async () => {
    const habit = await store.createHabit({ name: "虚构按次跑步", frequencyUnit: "week", frequencyInterval: 1, targetCount: 4,
      startDate: addDays(date, -6), target: { kind: "boolean" } });
    const call = (name: string, args: Record<string, unknown>) => runtime.executeAiToolCall({ name, arguments: args }, "kimi");
    expect((await call("complete_habit", { name: habit.name, value: 5 })).success).toBe(false);
    const measured = await call("complete_habit", { name: habit.name, value: 5, unit: "公里" });
    expect(measured.success, measured.output).toBe(true);
    expect((await store.readHabitDb()).checkins[0]).toMatchObject({ count: 1, value: 5, valueUnit: "公里" });
    const stats = await call("get_stats", { domain: "habits", range: "this_week" });
    expect(JSON.parse(stats.output).habits[0]).toMatchObject({ completionPercent: 25, valueTotal: 5, valueUnit: "公里" });
    expect((await call("complete_habit", { name: habit.name, value: 30, unit: "分钟" })).success).toBe(false);
    expect((await store.readHabitDb()).checkins[0]).toMatchObject({ count: 1, value: 5, valueUnit: "公里" });
  });

  it("rejects a freeform compensation through ordinary task creation", async () => {
    const result = await runtime.executeAiToolCall({ name: "create_task", arguments: {
      title: "任意自定义补偿", category: "punishment"
    } }, "kimi");
    expect(result.success).toBe(false);
    await expect(store.createTask({ title: "任意自定义补偿", category: "punishment" })).rejects.toThrow("习惯规则");
    expect((await store.readTaskDb()).tasks).toEqual([]);
  });
});
