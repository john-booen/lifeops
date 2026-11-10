import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { todayString } from "../src/date";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}));
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { DiskVault } = await import("./helpers/diskVault");

let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-stats-tool-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
  runtime = new AgentRuntime({ store, refreshViews: async () => {} });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

const stats = (domain: string, range = "today") => runtime.executeAiToolCall({ name: "get_stats", arguments: { domain, range } }, "kimi");

it("uses the real task and habit databases without changing their bytes", async () => {
  const date = todayString();
  const task = await store.createTask({ title: "纯虚构准备统计", date });
  await store.completeTask(task.id);
  const habit = await store.createHabit({ name: "纯虚构跑步", frequencyUnit: "week", frequencyInterval: 1, targetCount: 4, startDate: date });
  await store.recordHabitStatus(habit.id, "done", date);
  const paths = [store.taskDbPath(), store.taskMirrorPath(), store.habitDbPath()];
  const originals = await Promise.all(paths.map(path => vault.bytes(path)));
  const tasks = await stats("tasks"), habits = await stats("habits", "this_week");
  expect(tasks.success, tasks.output).toBe(true);
  expect(JSON.parse(tasks.output)).toMatchObject({ plannedCount: 1, completedCount: 1 });
  expect(habits.success, habits.output).toBe(true);
  expect(JSON.parse(habits.output)).toMatchObject({ habits: [{ name: habit.name, doneCount: 1, targetCount: 4, completionPercent: 25 }] });
  expect(await Promise.all(paths.map(path => vault.bytes(path)))).toEqual(originals);
});

it.each([
  { range: "last_week", from: "2026-10-26", to: "2026-11-01", dates: ["2026-10-25", "2026-10-26", "2026-11-01", "2026-11-02"] },
  { range: "last_month", from: "2026-10-01", to: "2026-10-31", dates: ["2025-10-01", "2026-10-01", "2026-10-31", "2026-11-01"] }
])("reads only the previous calendar period ($range) when asked on a Sunday", async ({ range, from, to, dates }) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 8, 21));
  try {
    for (const date of dates) await store.createTask({ title: `虚构任务 ${date}`, date });
    const result = await stats("tasks", range);
    expect(result.success, result.output).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({ range: { from, to }, plannedCount: 2 });
  } finally {
    vi.useRealTimers();
  }
});

it("counts only allowed journal entries and does not read any journal body", async () => {
  const date = todayString(), morning = store.dailyNotePath(date, "早"), evening = store.dailyNotePath(date, "晚");
  await vault.seed(morning, "纯虚构公开晨间正文");
  await vault.seed(evening, "纯虚构排除的晚间正文");
  store.settings.privacy!.excludedVaultPrefixes = [evening];
  const read = vi.spyOn(vault, "read");
  const result = await stats("journal");
  expect(result.success, result.output).toBe(true);
  expect(JSON.parse(result.output)).toMatchObject({ count: 1, scope: "只统计允许读取的记录" });
  expect(read.mock.calls.some(([file]) => [morning, evening].includes(file.path))).toBe(false);
});

it("returns unavailable instead of zero when task or habit data is excluded", async () => {
  const paths = [store.taskDbPath(), store.habitDbPath()];
  store.settings.privacy!.excludedVaultPrefixes = paths;
  const read = vi.spyOn(vault, "read");
  for (const domain of ["tasks", "habits"]) {
    const result = await stats(domain);
    expect(result.success).toBe(false);
    expect(result.output).toContain("不可用");
  }
  expect(read.mock.calls.some(([file]) => paths.includes(file.path))).toBe(false);
});
