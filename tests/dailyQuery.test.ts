import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentRuntime } from "../src/agentRuntime";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (path: string) => path }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const date = "2026-11-06";
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: AgentRuntime;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-daily-query-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as any, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
  runtime = new AgentRuntime({ store, refreshViews: async () => {} });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const query = (id: string, args: Record<string, unknown>) => runtime.executeAiToolCall({ id, name: "query_vault", arguments: { operation: "list", ...args } }, "kimi");

it("retrieves tasks after the default prompt limit without modifying the task records", async () => {
  for (let index = 0; index < 17; index++) await store.createTask({ title: `纯虚构待办${index}`, date });
  await store.createTask({ title: "其他日期事项", date: "2026-11-07" });
  const before = await vault.bytes(store.taskDbPath());
  const first = await query("first", { domain: "task", date, limit: 12 });
  expect(first.success, first.output).toBe(true);
  expect(first.output).toContain("共17项"); expect(first.output).toContain("offset=12");
  const second = await query("second", { domain: "task", date, offset: 12 });
  expect(second.success, second.output).toBe(true);
  expect(second.output.match(/纯虚构待办/g)).toHaveLength(5);
  expect(second.output).not.toContain("其他日期事项");
  expect(await vault.bytes(store.taskDbPath())).toBe(before);
});

it("calculates recorded weekly habit counts from the local database", async () => {
  const habit = await store.createHabit({ name: "纯虚构阅读", frequencyUnit: "week", frequencyInterval: 1, targetCount: 5, startDate: "2026-10-01", penaltyThreshold: 3, color: "#123456" });
  const data = await store.readHabitDb();
  await store.writeHabitDb({ ...data, checkins: [
    { date: "2026-11-03", status: "done", count: 2 }, { date: "2026-11-04", status: "done", count: 1 },
    { date: "2026-11-05", status: "missed", count: 0 }, { date: "2026-11-06", status: "leave", count: 0 },
    { date: "2026-11-01", status: "done", count: 99 }
  ].map(item => ({ ...item, habitId: habit.id, updatedAt: "2026-11-06T01:00:00Z", note: "", status: item.status as "done" | "missed" | "leave" })) });
  const before = await vault.bytes(store.habitDbPath());
  const result = await query("habit-week", { domain: "habit", range: "week", date });
  expect(result.success, result.output).toBe(true);
  expect(result.output).toContain("2026-11-02 至 2026-11-06");
  expect(result.output).toContain("已完成2天/3次 · 已记未完成1天 · 请假1天");
  expect(await vault.bytes(store.habitDbPath())).toBe(before);
});

it("treats an excluded habit database as unavailable rather than zero records", async () => {
  store.settings.privacy!.excludedVaultPrefixes = [store.habitDbPath()];
  const result = await query("habit-excluded", { domain: "habit", range: "week", date });
  expect(result.success, result.output).toBe(true);
  expect(result.output).toContain("状态未知"); expect(result.output).not.toContain("0项");
});
