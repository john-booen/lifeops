import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { formatDate } from "../src/date";
import type { FactOperationOptions } from "../src/dataFoundation/factOperation";
import { LifeOpsEventBus } from "../src/lifeOpsEventBus";
import { ProactiveLifecycle } from "../src/proactiveLifecycle";
import { decideProactiveDelivery, emptyProactivePolicyState, recordProactiveDelivery } from "../src/proactivePolicy";
import { stewardCandidate, type ProactiveCandidate } from "../src/scheduler";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, Modal: class {}, ItemView: class {}, WorkspaceLeaf: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/"), parseYaml: JSON.parse, stringifyYaml: JSON.stringify,
  setIcon: vi.fn()
}));

const { AgentRuntime } = await import("../src/agentRuntime");
const { LifeOpsStore } = await import("../src/store");
const { LifeOpsView } = await import("../src/lifeOpsView");
const { DiskVault } = await import("./helpers/diskVault");
const { listIdeas } = await import("../src/features/ideas/notes");
const { collectStewardCandidates, deliverStewardReminder, queueTaskOverload, runStewardReminders, startStewardReminders, withWeeklySummary } = await import("../src/features/review/reminders");
const { buildTodayCard } = await import("../src/features/today/model");
const { learningPath } = await import("../src/features/learning/store");
const { readSummaryScope, renderSummary, summaryPath } = await import("../src/features/summaries/notes");
const { summaryPeriod } = await import("../src/features/summaries/periods");
type ReviewHost = import("../src/features/review/service").ReviewHost;

const now = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);
let root: string, store: StoreHost, vault: InstanceType<typeof DiskVault>, runtime: InstanceType<typeof AgentRuntime>;
let host: ReviewHost, delivered: ProactiveCandidate[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-steward-reminders-"));
  vault = new DiskVault(root);
  const settings = structuredClone(DEFAULT_SETTINGS);
  const app = { vault } as unknown as App;
  store = new LifeOpsStore(app, settings) as unknown as StoreHost;
  await store.initializeVault();
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
  delivered = [];
  host = {
    app, store, settings, unloaded: false, proactiveCycleRunning: false, lifeOpsEvents: new LifeOpsEventBus(),
    proactiveLifecycle: { generation: 1, isCurrent: () => true, schedule: vi.fn() },
    dispatchProactiveCandidate: (candidate: ProactiveCandidate) => delivered.push(candidate),
    refreshViews: async () => undefined,
    async saveLocalOperation(name: string, args: Record<string, unknown>, execute: (scope: StoreHost) => Promise<unknown>, options?: FactOperationOptions) {
      const result = await runtime.executeLocalOperation(name, args, execute, undefined, options);
      if (!result.success) throw Error(result.output);
    }
  } as unknown as ReviewHost;
});
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

async function seedIdea(title: string, lastProgress: string, reminders: string[] = []) {
  const path = store.path(store.settings.folders.ideas, title + ".md");
  const original = "虚构想法正文。";
  await vault.seed(path, "---\n" + JSON.stringify({
    lifeops: "idea", status: "exploring", created: "2026-10-01", lastProgress, nextReview: "2026-11-01",
    nextAction: "核对虚构例子", sources: [], ideaReminderDays: reminders
  }) + "\n---\n\n" + original + "\n");
  return { path, original };
}

async function seedCompletedTask(day: number) {
  const task = await store.createTask({ title: "虚构已完成任务", date: formatDate(now(day, 0)), estimateMin: 30 });
  await store.updateTask(task.id, previous => ({ ...previous, status: "completed", completedAt: now(day, 10).toISOString() }));
}

it("shares the current debt between home and the morning brief, without writing a second assessment", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now(12, 21));
  await store.createHabit({ name: "虚构储蓄", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1,
    startDate: "2026-11-12", punishment: { enabled: true, rules: [{ kind: "save_money", amount: 50, currency: "CNY" }] } });
  await store.checkPunishments(now(12, 21));
  vi.setSystemTime(now(16, 8));
  const today = "2026-11-16", point = now(16, 8);
  const before = await vault.bytes(store.taskDbPath());
  const card = buildTodayCard(await store.getTaskDashboard(today), [], point);
  expect(card.compensationSummary).toBe("欠 1 项 · 最长已拖 3 天 · 应存 200 元");
  startStewardReminders(host);
  await runStewardReminders(host, point);
  const brief = delivered.find(item => item.kind === "daily_brief")!;
  expect(brief).toMatchObject({ voiceEligible: true, reason: expect.stringMatching(/^补偿欠 1 项，最长已拖 3 天，应存 200 元。/u) });
  expect(await vault.bytes(store.taskDbPath())).toBe(before);
  const announce = vi.fn();
  const view = Object.assign(Object.create(LifeOpsView.prototype), { speakStewardReminder: announce });
  Object.assign(host.app, { workspace: { getLeavesOfType: () => [{ view }] } });
  host.settings.realtimeVoice.speakReplies = false;
  deliverStewardReminder(host, brief);
  expect(announce).not.toHaveBeenCalled();
  host.settings.realtimeVoice.speakReplies = true;
  deliverStewardReminder(host, brief);
  expect(announce).toHaveBeenCalledExactlyOnceWith("早间简报。" + brief.reason);

  const [task] = (await store.readTaskDb()).tasks;
  await store.completeTask(task.id);
  const next = now(17, 8);
  const state = emptyProactivePolicyState();
  const after = await collectStewardCandidates(store, state, next, undefined);
  expect(after.find(item => item.kind === "daily_brief")?.reason).toMatch(/^目前没有未完成的补偿。/u);
  store.settings.privacy = { ...store.settings.privacy, excludedVaultPrefixes: [store.settings.folders.tasks] };
  const excluded = await collectStewardCandidates(store, state, next, undefined);
  expect(excluded.find(item => item.kind === "daily_brief")?.reason).toMatch(/^补偿欠账暂时无法核对。/u);
});

it("uses the same readable device sleep as the today card when sorting the morning brief", async () => {
  const point = now(16, 8), date = formatDate(point);
  await store.createTask({ title: "虚构长任务", date, estimateMin: 120, quadrant: "important-not-urgent" });
  await store.createTask({ title: "虚构短任务", date, estimateMin: 30 });
  await store.appendHealthEntry({ date, sleepHours: 5 });
  const state = emptyProactivePolicyState();
  const brief = async () => (await collectStewardCandidates(store, state, point, undefined))
    .find(item => item.kind === "daily_brief")?.reason;
  expect(await brief()).toContain("设备睡眠 5 小时");
  expect(await brief()).toContain("优先做：虚构短任务、虚构长任务。");
  expect(await brief()).toContain("近期完成记录不足，暂无法判断任务负荷。");
  const excludedVaultPrefixes = [store.settings.folders.health];
  store.settings.privacy = { ...store.settings.privacy, excludedVaultPrefixes };
  const withoutSleep = await brief();
  expect(withoutSleep).not.toContain("设备睡眠");
  expect(withoutSleep).toContain("优先做：虚构长任务、虚构短任务。");
  excludedVaultPrefixes.push(store.settings.folders.tasks);
  const withoutTasks = await brief();
  expect(withoutTasks).toContain("任务记录暂不可用。");
  expect(withoutTasks).not.toContain("虚构长任务");
});

it("keeps not-yet-due period work out of the evening unfinished list", async () => {
  const point = now(23, 21); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(point);
  await store.createTask({ title: "虚构周内蓝纸", date: "2026-11-21", endDate: "2026-11-27", estimateMin: 600 });
  await store.createTask({ title: "虚构今晚收尾", date: "2026-11-21", endDate: "2026-11-23" });
  const candidates = await collectStewardCandidates(store, emptyProactivePolicyState(), point, undefined);
  const reason = candidates.find(item => item.kind === "evening_review")?.reason;
  expect(reason).toContain("还有 1 项今日或逾期任务"); expect(reason).toContain("虚构今晚收尾"); expect(reason).not.toContain("虚构周内蓝纸");
});

it("reports unavailable evening sources and distinguishes missing device readings from a measured zero", async () => {
  const point = now(16, 21), date = formatDate(point);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(point);
  const state = emptyProactivePolicyState();
  const review = async () => (await collectStewardCandidates(store, state, point, undefined))
    .find(item => item.kind === "evening_review")?.reason;
  await store.createTask({ title: "虚构未完任务", date });
  await store.createHabit({ name: "虚构手动习惯", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1, startDate: date });
  await store.createHabit({ name: "虚构设备计步", source: "health:steps", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1,
    startDate: date, target: { kind: "number", unit: "步", perDay: 3000 } });
  await store.createHabit({ name: "虚构交易目标", source: "trades", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1,
    startDate: date, target: { kind: "number", unit: "笔", perDay: 2 } });
  const excludedVaultPrefixes = [store.settings.folders.tradingReviews];
  store.settings.privacy = { ...store.settings.privacy, excludedVaultPrefixes };
  const missing = await review();
  expect(missing).toContain("交易目标 虚构交易目标 暂不可用");
  expect(missing).toContain("习惯已完成 0/1 项。1 项设备习惯缺少读数。");
  await store.appendHealthEntry({ date, steps: 0 });
  expect(await review()).toContain("习惯已完成 0/2 项。");
  excludedVaultPrefixes.push(store.settings.folders.tasks, store.settings.folders.habits);
  const excluded = await review();
  expect(excluded).toContain("任务和补偿记录暂不可用。习惯和交易目标记录暂不可用。");
  expect(excluded).not.toContain("虚构");
  expect(excluded).not.toContain("0");
});

it("includes a reached weekly goal and reports excused habits separately in evening review", async () => {
  const point = now(16, 21), date = formatDate(point);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(point);
  const weekly = await store.createHabit({ name: "虚构每周剪纸", frequencyUnit: "week",
    frequencyInterval: 1, targetCount: 1, startDate: date });
  const excused = await store.createHabit({ name: "虚构请假习惯", frequencyUnit: "day",
    frequencyInterval: 1, targetCount: 1, startDate: date });
  await store.recordHabitStatus(weekly.id, "done", date);
  await store.recordHabitStatus(excused.id, "leave", date);
  const board = await store.getTaskDashboard(date);
  expect(board.habits.find(row => row.habit.id === weekly.id)).toMatchObject({ requiredToday: false, status: "done" });
  const candidates = await collectStewardCandidates(store, emptyProactivePolicyState(), point, undefined);
  const review = candidates.find(item => item.kind === "evening_review")?.reason;
  expect(review).toContain("习惯已完成 1/1 项。1 项习惯已请假。");
});

it.each([
  { startup: "overnight", openedAt: now(12, 20) },
  { startup: "before dawn", openedAt: now(13, 5, 45) }
])("delivers one morning brief with an $startup startup, including across wakeups and reopen", async ({ openedAt }) => {
  const legacyState = { ...emptyProactivePolicyState(), firstOpen: openedAt.toISOString() };
  await store.writeProactivePolicyState(legacyState);
  let cycle: Promise<void> | undefined;
  const lifecycle = new ProactiveLifecycle(() => { cycle = runStewardReminders(host); }, () => () => undefined);
  Object.assign(host, { proactiveLifecycle: lifecycle });
  vi.useFakeTimers();
  vi.setSystemTime(openedAt);
  lifecycle.setEnabled(true);
  try {
    startStewardReminders(host);
    await vi.advanceTimersByTimeAsync(0);
    await cycle;
    vi.setSystemTime(now(13, 6, 54));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await cycle;
    expect(delivered).toEqual([]);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await Promise.all([cycle, runStewardReminders(host)]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await cycle;
    expect(delivered.map(item => item.dedupeKey)).toEqual(["daily_brief:2026-11-13"]);

    const reopened = { ...host, store: new LifeOpsStore(host.app, host.settings) } as unknown as ReviewHost;
    vi.setSystemTime(now(13, 8));
    startStewardReminders(reopened);
    await runStewardReminders(reopened);
    expect(delivered.map(item => item.dedupeKey)).toEqual(["daily_brief:2026-11-13"]);
  } finally {
    lifecycle.stop();
  }
  expect((await store.readProactivePolicyState()).deliveries.map(item => item.dedupeKey))
    .toEqual(["daily_brief:2026-11-13"]);
  expect((await store.readProactiveCandidates(10)).map(item => item.dedupeKey))
    .toEqual(["daily_brief:2026-11-13"]);
});

it("skips morning brief delivery while disabled and after the window, and keeps evening review", async () => {
  const firstTick = now(13, 7);
  host.settings.proactive.enabled = false;
  startStewardReminders(host);
  await runStewardReminders(host, firstTick);
  expect((await store.readProactivePolicyState()).deliveries).toEqual([]);

  host.settings.proactive.enabled = true;
  await runStewardReminders(host, now(13, 11));
  expect(delivered).toEqual([]);
  await runStewardReminders(host, now(13, 21));
  expect(delivered.map(item => item.dedupeKey)).toEqual(["evening_review:2026-11-13"]);
});

it("simulates three calendar days with real saved reminders, strict quiet hours, and same-kind cooldown", async () => {
  const older = await seedIdea("虚构旧想法", "2026-10-02", ["2026-11-12"]);
  await seedIdea("虚构较新想法", "2026-10-19");
  await seedCompletedTask(12);
  const priority = await store.createTask({ title: "虚构优先任务", date: "2026-11-13", quadrant: "important-urgent" });
  startStewardReminders(host);
  await runStewardReminders(host, now(13, 6, 59));
  expect(delivered).toEqual([]);
  await runStewardReminders(host, now(13, 7));
  await runStewardReminders(host, now(13, 14));
  await runStewardReminders(host, now(13, 21));
  await runStewardReminders(host, now(13, 23));
  expect(delivered.map(item => item.kind)).toEqual(["daily_brief", "stalled_idea", "evening_review"]);
  expect(delivered[0].reason).toContain("虚构优先任务");

  await runStewardReminders(host, now(14, 5, 45));
  await runStewardReminders(host, now(14, 9));
  const first = await store.createTask({ title: "虚构首条提醒任务", date: "2026-11-14" });
  queueTaskOverload(host, first.id, "今天已排 5 个，平时大约完成 3 个。", now(14, 14));
  await runStewardReminders(host, now(14, 14));
  const second = await store.createTask({ title: "虚构第二条提醒任务", date: "2026-11-14" });
  queueTaskOverload(host, second.id, "今天已排 3 个，平时大约完成 1 个。", now(14, 14, 30));
  await runStewardReminders(host, now(14, 14, 30));
  await store.updateTask(priority.id, previous => ({ ...previous, status: "completed", completedAt: now(14, 15).toISOString() }));
  await runStewardReminders(host, now(14, 15, 30));
  await runStewardReminders(host, now(14, 21));
  expect(delivered.slice(3).map(item => item.kind)).toEqual(["daily_brief", "task_overload", "stalled_idea", "task_overload", "evening_review"]);
  expect(delivered[6].reason).toContain("今天已排 2 个");

  await runStewardReminders(host, now(15, 8));
  await runStewardReminders(host, now(15, 14));
  await runStewardReminders(host, now(15, 19, 59));
  await runStewardReminders(host, now(15, 20));
  await runStewardReminders(host, now(15, 21));
  expect(delivered.slice(8).map(item => item.kind)).toEqual(["daily_brief", "stalled_idea", "weekly_review", "evening_review"]);
  expect(delivered[9]).toMatchObject({ priority: "high", voiceEligible: true, reason: expect.stringContaining("继续、暂停还是放弃") });
  expect(delivered[10].reason).toContain("下周学习");
  const week = summaryPeriod("week", "2026-11-15"), summary = summaryPath(store, week);
  const scope = await readSummaryScope(store);
  await vault.seed(summary, renderSummary(week, week.to, scope.hash,
    { taskCompletionPercent: 25, tasksCompleted: 1, energy: null, tradePnlCny: null, tradePnlUsd: null },
    7, true, "model", "虚构周摘要"));
  expect(await withWeeklySummary(store, [delivered[10]])).toMatchObject([{ summaryPath: summary, reason: expect.stringContaining("本周摘要已可查看") }]);
  const state = await store.readProactivePolicyState();
  expect(state.deliveries).toHaveLength(12);
  for (const day of [13, 14, 15]) {
    const events = state.deliveries.filter(row => formatDate(new Date(row.deliveredAt)) === formatDate(now(day, 0)));
    expect(events.length).toBeLessThanOrEqual(6);
    expect(events.every(row => new Date(row.deliveredAt).getHours() >= 7 && new Date(row.deliveredAt).getHours() < 23)).toBe(true);
  }
  const ideas = await listIdeas(store);
  expect(ideas.find(idea => idea.path === older.path)?.ideaReminderDays).toEqual(["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
  expect(await vault.bytes(older.path)).toContain(older.original);
  expect(ideas.find(idea => idea.path !== older.path)?.ideaReminderDays).toEqual([]);
  expect((await store.readProactiveCandidates(20)).filter(item => item.steward)).toHaveLength(12);
});

it("keeps the Sunday task count current when a weekly summary is still a draft", async () => {
  const point = now(15, 20), date = formatDate(point);
  const week = summaryPeriod("week", date), path = summaryPath(store, week);
  const scope = await readSummaryScope(store);
  await seedCompletedTask(12);
  await seedCompletedTask(15);
  const metrics = { taskCompletionPercent: 100, tasksCompleted: 1, energy: null, tradePnlCny: null, tradePnlUsd: null };
  await vault.seed(path, renderSummary(week, "2026-11-14", scope.hash, metrics, 6, false, "model", "虚构周摘要草稿"));
  const candidates = await collectStewardCandidates(store, emptyProactivePolicyState(), point, undefined);
  const weekly = candidates.find(item => item.kind === "weekly_review")!;
  expect(weekly.reason).toContain("本周已完成 2 项任务。");
  expect(weekly.reason).toContain("本周摘要草稿已可查看。");
  expect(weekly.summaryPath).toBe(path);
  await vault.seed(path, renderSummary(week, date, scope.hash, { ...metrics, tasksCompleted: 2 }, 7, true, "model", "虚构最终周摘要"));
  expect(await withWeeklySummary(store, [weekly])).toMatchObject([{ summaryPath: path, reason: expect.stringContaining("本周摘要已可查看。") }]);
  store.settings.privacy = { ...store.settings.privacy, excludedVaultPrefixes: [store.settings.folders.aiReports] };
  expect(await withWeeklySummary(store, [weekly])).toMatchObject([{ summaryPath: undefined, reason: expect.stringContaining("本周摘要暂未生成。") }]);
});

it.each(["excluded", "malformed"] as const)("delivers both Sunday reminders with %s learning data", async (condition) => {
  const point = now(15, 21), path = learningPath(store);
  await seedCompletedTask(12);
  const original = JSON.stringify({ version: 1, tracks: condition === "malformed" ? "虚构格式错误" : [] });
  await vault.seed(path, original);
  if (condition === "excluded") store.settings.privacy = { ...store.settings.privacy, excludedVaultPrefixes: [path] };
  startStewardReminders(host);
  await runStewardReminders(host, point);
  expect(delivered.map(candidate => candidate.kind)).toEqual(["evening_review", "weekly_review"]);
  expect(delivered[1].reason).toContain("本周已完成 1 项任务。");
  expect(delivered[1].reason).toContain("下周学习计划暂时无法读取。");
  expect(await vault.bytes(path)).toBe(original);
});

it("queues an overload once, after a real chat task is saved and verified", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now(15, 12));
  for (const day of [12, 13, 14]) {
    const task = await store.createTask({ title: "虚构已完成任务 " + day, date: formatDate(now(day, 0)), estimateMin: 30 });
    await store.updateTask(task.id, previous => ({ ...previous, status: "completed", completedAt: now(day, 10).toISOString() }));
  }
  await store.createTask({ title: "虚构今日已有任务", date: "2026-11-15", estimateMin: 20 });
  const onTaskOverload = vi.fn();
  const chat = new AgentRuntime({ store, refreshViews: async () => undefined, onTaskOverload });
  const call = { id: "synthetic-overload", name: "create_task", arguments: { title: "虚构今天新任务", date: "今天", estimateMin: 30 } };
  expect((await chat.executeAiToolCall(call, "kimi")).success).toBe(true);
  expect(onTaskOverload).toHaveBeenCalledOnce();
  const [id, reason] = onTaskOverload.mock.calls[0];
  expect((await store.getTask(id))?.title).toBe("虚构今天新任务");
  expect(reason).toContain("今天已排 2 个");
  expect((await chat.executeAiToolCall(call, "kimi")).success).toBe(true);
  expect(onTaskOverload).toHaveBeenCalledOnce();
});

it.each(["before collection", "before persistence"] as const)("skips delayed overload when the trigger is completed %s", async (when) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const point = now(15, 13);
  vi.setSystemTime(point);
  await seedCompletedTask(12);
  const task = await store.createTask({ title: "虚构已撤销的超载项", date: "2026-11-15", estimateMin: 120 });
  startStewardReminders(host);
  queueTaskOverload(host, task.id, "今天已排 1 个，平时大约完成 1 个。", point);
  if (when === "before collection") {
    await store.completeTask(task.id);
  } else {
    const save = host.saveLocalOperation.bind(host);
    vi.spyOn(host, "saveLocalOperation").mockImplementationOnce(async (...args) => {
      await store.completeTask(task.id);
      await save(...args);
    });
  }
  await runStewardReminders(host, point);
  expect((await store.getTask(task.id))?.status).toBe("completed");
  expect(delivered).toEqual([]);
  expect((await store.readProactivePolicyState()).deliveries).toEqual([]);
});

it("does not persist a pending reminder if its lifecycle was disabled during data collection", async () => {
  const original = store.getTaskDashboard.bind(store);
  const current = vi.spyOn(host.proactiveLifecycle, "isCurrent");
  vi.spyOn(store, "getTaskDashboard").mockImplementationOnce(async (...args) => {
    const board = await original(...args);
    current.mockReturnValue(false);
    return board;
  });
  startStewardReminders(host);
  await runStewardReminders(host, now(15, 8));
  expect(delivered).toEqual([]);
  expect((await store.readProactivePolicyState()).deliveries).toEqual([]);
});

it("rechecks reminders after setup replaces the active store during a save", async () => {
  const point = now(15, 8);
  const replacement = new LifeOpsStore(host.app, host.settings);
  const save = host.saveLocalOperation.bind(host);
  const pending = vi.spyOn(host, "saveLocalOperation").mockImplementationOnce((name, args, execute, options) =>
    save(name, args, async scope => {
      await execute(scope);
      host.store = replacement;
    }, options));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  startStewardReminders(host);
  try {
    await runStewardReminders(host, point);
    expect(pending).toHaveBeenCalledOnce();
    expect(delivered).toEqual([]);
    expect((await store.readProactivePolicyState()).deliveries).toEqual([]);
    expect(await store.readProactiveCandidates(10)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(host.proactiveLifecycle.schedule).toHaveBeenCalledTimes(2);
    await runStewardReminders(host, point);
    await runStewardReminders(host, point);
    expect(delivered.map(item => item.kind)).toEqual(["daily_brief"]);
    expect((await store.readProactivePolicyState()).deliveries).toHaveLength(1);
  } finally {
    warn.mockRestore();
  }
});

it("caps all steward channels at six reminders and keeps automated writes out of conversational undo", async () => {
  const point = now(15, 21);
  let state = emptyProactivePolicyState();
  for (let index = 0; index < 6; index++) {
    const reminder = stewardCandidate(now(15, 8), "task_overload", "虚构提醒", "虚构事实", { key: String(index) });
    state = recordProactiveDelivery(state, reminder, "panel", now(15, 8));
  }
  const next = stewardCandidate(point, "evening_review", "虚构晚间检查", "虚构事实");
  expect(decideProactiveDelivery(next, state, { ...DEFAULT_SETTINGS.proactive, dailyLimit: 20 }, point).reason).toBe("daily_limit");
  const userPath = "虚构操作.md";
  await runtime.executeLocalOperation("user_edit", {}, scope => scope.writeFile(userPath, "虚构手动操作"));
  startStewardReminders(host);
  await runStewardReminders(host, now(15, 8));
  await runtime.undoLatestOperation();
  expect(store.getFile(userPath)).toBeNull();
  expect((await store.readProactivePolicyState()).deliveries).toHaveLength(1);
});

it("speaks high priority reminders only during an idle, active voice session", () => {
  const speak = vi.fn();
  vi.stubGlobal("window", { speechSynthesis: { speak, speaking: false, pending: false } });
  vi.stubGlobal("SpeechSynthesisUtterance", class { lang = ""; constructor(readonly text: string) {} });
  let sessionPhase = "stopped";
  let currentTurn: { phase: string } | null = null;
  const view = {
    agentVoiceRuntime: { snapshot: () => ({ sessionPhase, currentTurn, inputQueue: [] }) },
    controller: { settings: { realtimeVoice: { language: "zh-CN" } } }
  } as unknown as InstanceType<typeof LifeOpsView>;
  const announce = () => LifeOpsView.prototype.speakStewardReminder.call(view, "虚构高优先级提醒");
  announce();
  sessionPhase = "listening"; currentTurn = { phase: "playing" };
  announce();
  expect(speak).not.toHaveBeenCalled();
  currentTurn = null;
  announce();
  expect(speak).toHaveBeenCalledOnce();
  expect(speak.mock.calls[0][0]).toMatchObject({ text: "虚构高优先级提醒", lang: "zh-CN" });
});
