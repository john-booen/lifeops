import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { todayString } from "../src/date";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, TFile: class {}, TFolder: class {}, Modal: class {}, Notice: class {}, Setting: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), requestUrl: vi.fn()
}));

const { LifeOpsStore } = await import("../src/store");
const { createFsApp } = await import("./helpers/fsApp");
const { AgentRuntime } = await import("../src/agentRuntime");
const { healthRows } = await import("../src/features/health/model");
const { recordHealthEntries, readHealthDay, healthNotePath } = await import("../src/features/health/store");
const { readStats } = await import("../src/features/stats/tools");
const { projectHealthHabitProgress } = await import("../src/features/health/habits");
const { readScreenshotImage } = await import("../src/features/screenshots/image");
const { recognizeHealthScreenshot } = await import("../src/features/health/screenshot");
const { getTodayCard } = await import("../src/features/today/service");
const { automaticHabitDayDisplay } = await import("../src/features/habits/targets");
const { readHabitContextWithEvidence } = await import("../src/store/agentSlice");
const { addDays, startOfWeek } = await import("../src/date");

let root: string, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
let date: string, previous: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-health-records-"));
  store = new LifeOpsStore(createFsApp(root), structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
  runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  date = todayString();
  previous = addDays(date, -1);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

it("shares the existing health note writer, deduplicates readings, aggregates latest daily metrics, and undoes corrections", async () => {
  const path = healthNotePath(store, date);
  const legacy = `## ${date}\n- 睡眠小时：5.5\n- 步数：6550\n`;
  await store.writeFile(path, legacy);
  const entries = [{ date, steps: 7000, runningKm: 4.2, restingHeartRate: 66 }, { date: previous, sleepHours: 8, steps: 1000 }];
  const apply = (id: string) =>
    runtime.executeLocalOperation("manual_health_screenshot", { entries }, scope => recordHealthEntries(scope, entries), id);
  const saved = await apply("synthetic-health-screenshot");
  expect(saved.success, saved.output).toBe(true);
  expect(await store.readPath(path)).toContain(legacy);
  expect(await readHealthDay(store, date)).toEqual({ date, sleepHours: 5.5, steps: 7000, runningKm: 4.2, restingHeartRate: 66 });
  const stats = await readStats(store, { domain: "health", range: { from: previous, to: date } }, new Date());
  expect(stats.success).toBe(true);
  expect(JSON.parse(stats.output)).toMatchObject({
    recordedDays: 2, sleepHours: { average: 6.75, recordedDays: 2 },
    steps: { total: 8000, recordedDays: 2 }, restingHeartRate: { average: 66, recordedDays: 1 },
    weightKg: { average: null, recordedDays: 0 }
  });
  const board = await store.getTaskDashboard();
  expect((await getTodayCard(store, board)).health).toEqual({ sleepHours: 5.5, steps: 7000 });
  const unchanged = await store.readPath(path);
  expect((await apply("synthetic-health-duplicate")).receipt).toBeUndefined();
  expect(await store.readPath(path)).toBe(unchanged);
  expect(await runtime.undoOperation("synthetic-health-screenshot")).toBe(true);
  expect(await store.readPath(path)).toBe(legacy);
});

it("links opted-in habits to daily snapshots without stacking data or overriding a manual check-in", async () => {
  const habit = await store.createHabit({ name: "虚构跑步计划", source: "health:runningKm", frequencyUnit: "day",
    frequencyInterval: 1, targetCount: 1, startDate: previous, target: { kind: "number", unit: "公里", perDay: 3 } });
  await store.recordHabitStatus(habit.id, "leave", previous, "请假");
  await store.appendHealthEntry({ date, runningKm: 2 });
  await store.appendHealthEntry({ date, runningKm: 3.4 });
  await store.appendHealthEntry({ date: previous, runningKm: 4 });
  const { checkins: actual } = await store.readHabitDb();
  const dashboard = await store.getTaskDashboard();
  expect(dashboard.habits.find(row => row.habit.id === habit.id)?.periodDone).toBe(3.4);
  expect(await store.getDashboardStats()).toMatchObject({ habitDone: 1, habitTotal: 1 });
  const reread = vi.spyOn(store, "getTaskDashboard");
  expect(await store.getDashboardStats(undefined, Promise.resolve(dashboard))).toMatchObject({ date, habitDone: 1, habitTotal: 1 });
  expect(reread).not.toHaveBeenCalled();
  reread.mockRestore();
  expect((await readHabitContextWithEvidence(store, date)).text).toContain("3.4/3 公里");
  const { checkins: projection, partial } = await projectHealthHabitProgress(store, await store.readHabitDb());
  expect(partial).toBe(false);
  expect(projection).toEqual([actual[0], expect.objectContaining({ date, habitId: habit.id, status: "done", value: 3.4 })]);
  expect((await store.readHabitDb()).checkins).toEqual(actual);
  store.settings.privacy = { excludedVaultPrefixes: [healthNotePath(store, date)] };
  expect(await projectHealthHabitProgress(store, await store.readHabitDb())).toEqual({ checkins: actual, partial: true });
  const read = await readStats(store, { domain: "health", range: "today" }, new Date());
  expect(read.success).toBe(true);
  expect(JSON.parse(read.output)).toMatchObject({ recordedDays: 0, scope: "只统计允许读取的记录" });
  const habitStats = await readStats(store, { domain: "habits", range: "today" }, new Date());
  expect(habitStats.success).toBe(true);
  expect(JSON.parse(habitStats.output)).toMatchObject({ scope: "只统计允许读取的记录" });
  expect((await readHabitContextWithEvidence(store, date)).text).toContain("只统计可读的健康记录");
  const partialDashboard = await store.getTaskDashboard(date);
  expect((await getTodayCard(store, partialDashboard)).habits.find(row => row.id === habit.id)?.healthCoveragePartial).toBe(true);
});

it("does not turn gaps in a device habit into failures or count a below-goal reading in its streak", async () => {
  const start = addDays(startOfWeek(date), -7);
  const habit = await store.createHabit({ name: "虚构设备跑步", source: "health:runningKm", frequencyUnit: "day",
    frequencyInterval: 1, targetCount: 1, startDate: start, target: { kind: "number", unit: "公里", perDay: 3 } });
  const manuallyTracked = await store.createHabit({ name: "虚构手动跑步", frequencyUnit: "day",
    frequencyInterval: 1, targetCount: 1, startDate: start, target: { kind: "number", unit: "公里", perDay: 3 } });
  await store.appendHealthEntry({ date: start, runningKm: 1.2 });
  await store.recordHabitStatus(habit.id, "missed", addDays(start, 1));
  await store.appendHealthEntry({ date: previous, runningKm: 1.2 });
  await store.appendHealthEntry({ date, runningKm: 3.4 });
  const earlier = await store.getDashboardStats(addDays(start, 2));
  expect(earlier.weeklyFailures[habit.name]).toBe(2);
  expect(earlier.weeklyFailures[manuallyTracked.name]).toBe(3);
  const today = await store.getTaskDashboard(date);
  const history = today.habits.find(row => row.habit.id === habit.id);
  expect(history).toMatchObject({ streak: 1, status: "done" });
  expect(automaticHabitDayDisplay(habit, history?.history.find(row => row.date === previous)))
    .toEqual({ status: "pending", label: "1.2/3 公里" });
  expect(automaticHabitDayDisplay(habit)).toEqual({ status: "pending", label: "未记录" });
  const stats = await readStats(store, { domain: "habits", range: { from: start, to: addDays(start, 2) } }, new Date());
  const results = JSON.parse(stats.output).habits;
  expect(results.find((item: { id: string }) => item.id === habit.id)).toMatchObject({ completionPercent: 0,
    coverage: { recordedDays: 2, unrecordedDays: 1 },
    goals: [{ period: "day", periods: 2, unknownPeriods: 1, missedDates: [start, addDays(start, 1)] }] });
  expect(results.find((item: { id: string }) => item.id === manuallyTracked.id)).toMatchObject({ completionPercent: 0,
    goals: [{ period: "day", periods: 3, missedDates: [start, addDays(start, 1), addDays(start, 2)] }] });
});

it("keeps field-looking lines entered as free text out of numerical records", async () => {
  const note = "步数记在别处\n- 步数：99000\n- 静息心率：52 次/分";
  const exercise = "休息\r- 跑步距离：120 公里";
  const entries = [{ date, steps: 1250, note, exercise }];
  const result = await runtime.executeLocalOperation("local_appendHealthEntry", { entries }, scope => recordHealthEntries(scope, entries));
  expect(result.success).toBe(true);
  expect(await readHealthDay(store, date)).toEqual({ date, steps: 1250 });
  expect(await store.readPath(healthNotePath(store, date))).toContain("  - 静息心率：52 次/分");
  expect(await store.readPath(healthNotePath(store, date))).toContain("  - 跑步距离：120 公里");
});

it("does not save or report a health entry with a malformed subjective score", async () => {
  const path = healthNotePath(store, date);
  await store.appendHealthEntry({ date, steps: 750 });
  const before = await store.readPath(path);
  for (const [entries, label] of [
    [[{ date, runningKm: 4.5, energy: NaN }], "精力"],
    [[{ date, runningKm: 4.5, fatigue: 12 }], "疲劳"]
  ] as const) {
    const saved = await runtime.executeLocalOperation("local_appendHealthEntry", { entries }, scope => recordHealthEntries(scope, entries));
    expect(saved.success).toBe(false);
    expect(saved.output).toContain(label);
    expect(await store.readPath(path)).toBe(before);
  }
});

it("does not count metrics in properties, comments or code samples in an existing health note", async () => {
  const note = ["---", "- 体重：45 kg", "---", "## 手填", "- 步数：850", "~~~markdown", "- 步数：41234", "~~~",
    "<!--", "- 静息心率：69 次/分", "-->", "%%", "- 跑步距离：4 公里", "%%", "- 睡眠小时：7"].join("\r\n");
  await store.writeFile(healthNotePath(store, date), note);
  expect(await readHealthDay(store, date)).toEqual({ date, steps: 850, sleepHours: 7 });
});

it("preserves the prior health notes when a batch would append inside an unfinished block", async () => {
  const original = "## 手填\n- 步数：850\n<!--\n虚构备注没写完\n";
  const path = healthNotePath(store, date);
  const earlierPath = healthNotePath(store, previous);
  await store.writeFile(path, original);
  expect(await readHealthDay(store, date)).toEqual({ date, steps: 850 });
  const stats = await readStats(store, { domain: "health", range: "today" }, new Date());
  expect(stats.success).toBe(true);
  expect(JSON.parse(stats.output)).toMatchObject({
    recordedDays: 1, steps: { total: 850, recordedDays: 1 }, scope: "只统计允许读取的记录"
  });
  const entries = [{ date: previous, steps: 720 }, { date, note: "虚构运动备注" }];
  const saved = await runtime.executeLocalOperation("manual_health_csv_batch", { entries }, scope => recordHealthEntries(scope, entries));
  expect(saved.success).toBe(false);
  expect(saved.output).toContain("未闭合的属性、注释或代码块");
  expect(await store.readPath(path)).toBe(original);
  expect(store.getFile(earlierPath)).toBeNull();
});

it("keeps verified days when one health note cannot be safely read", async () => {
  await store.appendHealthEntry({ date, sleepHours: 7.5 });
  await store.writeFile(healthNotePath(store, previous), "虚构长记录\n".repeat(40_000));
  const result = await readStats(store, { domain: "health", range: { from: previous, to: date } }, new Date());
  expect(result.success).toBe(true);
  expect(JSON.parse(result.output)).toMatchObject({ recordedDays: 1, scope: "只统计允许读取的记录",
    sleepHours: { average: 7.5, recordedDays: 1 } });
});

it("requires health-specific disclosure and validates extracted dates and numerical fields", async () => {
  const image = readScreenshotImage(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0));
  const raw = JSON.stringify({ rows: [{ date: "2026-02-30", runningKm: 2.4, sleepMinutes: 430, weightKg: -56,
    steps: 6000.5, restingHeartRate: 60, account: "synthetic" }, { date, steps: 0, weightKg: 0.001, restingHeartRate: 0.001 }] });
  expect(healthRows(raw)).toEqual([{ date: "", sleepHours: 7.17, runningKm: 2.4, restingHeartRate: 60 }, { date, steps: 0 }]);
  const fetch = vi.fn(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: raw } }] }));
  vi.stubGlobal("fetch", fetch);
  const settings = store.settings;
  const guard = () => {};
  settings.privacy = { excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
  settings.vision = { ...settings.vision, provider: "openai-compatible", endpoint: "https://fiction.invalid/v1/chat/completions",
    apiKey: "fixture-health-token", model: "fixture-health-model", tradeScreenshotDisclosureAccepted: true };
  await expect(recognizeHealthScreenshot(settings, image, {}, guard)).rejects.toThrow("允许发送");
  expect(fetch).not.toHaveBeenCalled();
  settings.vision.healthScreenshotDisclosureAccepted = true;
  await expect(recognizeHealthScreenshot(settings, image, {}, guard)).resolves.toEqual(healthRows(raw));
  expect(fetch).toHaveBeenCalledTimes(1);
});
