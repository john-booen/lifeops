import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
  normalizePath: (s: string) => s.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { createFsApp } = await import("./helpers/fsApp");
const { formatTaskListReply, repeatedTaskListPriority } = await import("../src/features/tasks/planTools");
let root: string, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
const date = "2068-11-21";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-task-lookup-pages-"));
  store = new LifeOpsStore(createFsApp(root), structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault(); runtime = new AgentRuntime({ store, refreshViews: async () => {} });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function query(args: Record<string, unknown>) {
  const result = await runtime.executeAiToolCall({ name: "list_tasks", arguments: { date, ...args } }, "kimi");
  expect(result.success, result.output).toBe(true); return JSON.parse(result.output);
}
it("finds all eleven target tasks even when they come after the first twenty unrelated tasks", async () => {
  for (let i = 0; i < 24; i++) await store.createTask({ title: "虚构无关纸袋" + i, date });
  const ids = [];
  for (let i = 0; i < 11; i++) ids.push((await store.createTask({ title: "虚构区间纸样" + i, date })).id);
  const before = await store.readPath(store.taskDbPath());
  const data = await query({ query: "虚构区间纸样" });
  expect(data.count).toBe(11); expect(data.truncated).toBe(false); expect(data.tasks.map((row: { id: string }) => row.id)).toEqual(ids);
  expect(await store.readPath(store.taskDbPath())).toBe(before);
});
it("offers a bounded next page and returns the rest without dropping or repeating IDs", async () => {
  for (let i = 0; i < 35; i++) await store.createTask({ title: "虚构纸样" + i, date });
  const first = await query({}); expect(first).toMatchObject({ count: 35, truncated: true, nextOffset: 20 });
  const rest = await query({ offset: first.nextOffset });
  expect(rest).toMatchObject({ count: 35, offset: 20, truncated: false }); expect(rest.nextOffset).toBeUndefined();
  expect(rest.tasks).toHaveLength(15);
  const ids = [...first.tasks, ...rest.tasks].map((row: { id: string }) => row.id);
  expect(new Set(ids).size).toBe(35);
});
it("matches literal title text without regular expression expansion and keeps date/status filters", async () => {
  const row = await store.createTask({ title: "虚构纸样[甲]", date });
  await store.createTask({ title: "虚构纸样甲", date });
  await store.createTask({ title: "虚构纸样[甲]", date: "2068-11-22" });
  const data = await query({ query: "[甲]" }); expect(data.tasks.map((task: { id: string }) => task.id)).toEqual([row.id]);
  await store.completeTask(row.id); expect((await query({ query: "[甲]" })).count).toBe(0);
  expect((await query({ query: "[甲]", status: "completed" })).tasks[0].id).toBe(row.id);
});
it.each([{ offset: -1 }, { offset: 0.5 }, { offset: "20" }, { query: " " }, { query: 3 }, { query: "x".repeat(1001) }])("rejects malformed task lookup: %j", async args => {
  const result = await runtime.executeAiToolCall({ name: "list_tasks", arguments: { date, ...args } }, "kimi");
  expect(result.success).toBe(false);
});
it("labels filtered totals and later page positions and never merges different filters", () => {
  const base = { date, status: "active", count: 35, tasks: [{ title: "虚构纸样" }], offset: 20, query: "纸样" };
  expect(formatTaskListReply(JSON.stringify(base), date)).toContain("匹配「纸样」");
  expect(formatTaskListReply(JSON.stringify(base), date)).toContain("第 21–21 个");
  expect(formatTaskListReply(JSON.stringify({ ...base, tasks: [] }), date)).toContain("没有更多任务");
  const args = { date, order: "priority", directReply: true, limit: 3 };
  expect(repeatedTaskListPriority([{ name: "list_tasks", arguments: { ...args, query: "纸样" } },
    { name: "list_tasks", arguments: { ...args, query: "纸袋" } }], date)).toBeUndefined();
});

it("uses the same verified priority answer when a model redundantly asks for a wider ordinary list", () => {
  const priority = { name: "list_tasks", arguments: { order: "priority", limit: 2, directReply: true } };
  const wider = { name: "list_tasks", arguments: { date, status: "active", limit: 30 } };
  expect(repeatedTaskListPriority([priority, wider], date)).toBe(priority);
  expect(repeatedTaskListPriority([priority, { ...wider, arguments: { ...wider.arguments, directReply: false } }], date)).toBeUndefined();
  expect(repeatedTaskListPriority([priority, { ...wider, arguments: { ...wider.arguments, query: "纸样" } }], date)).toBeUndefined();
});
