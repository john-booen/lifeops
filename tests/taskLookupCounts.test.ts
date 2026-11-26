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
const { formatTaskListReply, TASK_PLANNING_TOOLS } = await import("../src/features/tasks/planTools");
const { taskLookupResolution } = await import("../src/agent/taskLookupResolution");
let root: string, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
const today = "2026-11-12";
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(today + "T12:00:00+08:00"));
  root = await mkdtemp(join(tmpdir(), "lifeops-task-lookup-counts-"));
  store = new LifeOpsStore(createFsApp(root), structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault(); runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  for (const input of [
    { title: "虚构先前单日", date: "2026-11-10" },
    { title: "虚构提前硬截止", date: "2026-11-20", dueDate: "2026-11-11" },
    { title: "虚构跨周已结束", date: "2026-11-01", endDate: "2026-11-11" },
    { title: "虚构跨月进行中", date: "2026-11-01", endDate: "2026-12-01" },
    { title: "虚构今日硬截止", date: "2026-11-15", dueDate: today },
    { title: "虚构今日普通计划", date: today },
    { title: "虚构未来单日", date: "2026-11-20" },
    { title: "虚构无日期", date: "" }
  ]) await store.createTask(input);
  const done = await store.createTask({ title: "虚构已经完成", date: "2026-11-10" }); await store.completeTask(done.id);
});
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });
async function read(args: Record<string, unknown>) {
  const result = await runtime.executeAiToolCall({ name: "list_tasks", arguments: args }, "kimi");
  expect(result.success, result.output).toBe(true); expect(result.actions).toEqual([]);
  return { result, data: JSON.parse(result.output), reply: formatTaskListReply(result.output, today)! };
}
it("counts only overdue active records across dates and returns no subject IDs, titles or pages", async () => {
  const paths = [store.taskDbPath(), store.taskMirrorPath()]; const before = await Promise.all(paths.map(path => store.readPath(path)));
  const { data, reply, result } = await read({ answerMode: "counts", dueStatus: "overdue", limit: 1, offset: 2 });
  expect(data).toEqual({ projection: "counts", date: today, statusAsOf: today, status: "active", count: 3, dueStatus: "overdue" });
  expect(reply).toContain("已逾期 3 项"); expect(reply).not.toContain("今天硬截止");
  expect(result.output).not.toContain("虚构"); expect(result.output).not.toContain('"tasks"');
  expect(await Promise.all(paths.map(path => store.readPath(path)))).toEqual(before);
  expect(taskLookupResolution([{ role: "assistant", content: "", tool_calls: [{ id: "count-only", type: "function", function: { name: "list_tasks", arguments: "{}" } }] },
    { role: "tool", content: result.output, tool_call_id: "count-only" }], new Map([["count-only", result]]),
    [{ name: "update_tasks", description: "虚构修改入口", parameters: { properties: { updates: {} } } }], today, true)).toBeUndefined();
});
it("keeps a paginated overdue factual lookup available before a later legitimate edit", async () => {
  const { data, reply } = await read({ answerMode: "facts", dueStatus: "overdue", limit: 1 });
  expect(data).toMatchObject({ count: 3, nextOffset: 1, truncated: true, statusAsOf: today });
  expect(data.tasks).toHaveLength(1); expect(data.tasks[0].id).toBeTruthy(); expect(reply).toContain("已逾期 3 项");
  const rest = await read({ answerMode: "continue", dueStatus: "overdue", limit: 2, offset: 1 });
  expect(new Set([...data.tasks, ...rest.data.tasks].map(row => row.id)).size).toBe(3);
  expect(rest.data.tasks).toContainEqual(expect.objectContaining({ title: "虚构跨周已结束", endDate: "2026-11-11" }));
});
it("counts hard deadlines alone or the explicitly requested two groups without titles", async () => {
  const single = await read({ answerMode: "counts", dueStatus: "due_today" });
  expect(single.data.count).toBe(1); expect(single.reply).toContain("今天硬截止 1 项"); expect(single.reply).not.toContain("已逾期");
  const both = await read({ answerMode: "counts", dueStatus: "overdue_and_today", limit: 1 });
  expect(both.data.dueGroups).toEqual({ overdue: { count: 3 }, dueToday: { count: 1 } });
  expect(both.reply).toContain("已逾期 3 项；今天硬截止 1 项"); expect(both.result.output).not.toContain("虚构");
  const legacy = await read({ dueStatus: "overdue_and_today", limit: 1 });
  expect(legacy.data.dueGroups.overdue.tasks).toHaveLength(1); expect(legacy.data.dueGroups.dueToday.tasks).toHaveLength(1);
});
it("preserves all-date literal query, current statuses and explicit historical reference dates", async () => {
  const all = await read({ answerMode: "counts", query: "虚构", status: "all", limit: 1, offset: 1 });
  expect(all.data).toMatchObject({ date: null, dateScope: "all", count: 9, status: "all" });
  expect(all.data.tasks).toBeUndefined(); expect(all.reply).toContain("所有日期");
  const old = await read({ answerMode: "counts", date: "2026-11-11", dueStatus: "overdue" });
  expect(old.data.count).toBe(1); expect(old.reply).toContain("不是历史当天的状态快照"); expect(old.reply).toContain(today);
});
it("keeps excluded records out of totals and refuses an unavailable task database", async () => {
  const db = await store.readTaskDb({ readOnly: true });
  const row = db.tasks.find(row => row.title === "虚构先前单日")!;
  await store.updateTask(row.id, task => ({ ...task, sourceNotePath: "虚构私密资料/记录.md" }));
  store.settings.privacy = { ...store.settings.privacy, excludedVaultPrefixes: ["虚构私密资料"] };
  const partial = await read({ answerMode: "counts", dueStatus: "overdue" });
  expect(partial.data.count).toBe(2); expect(partial.reply).toContain("只提供允许读取的记录");
  store.settings.privacy.excludedVaultPrefixes = [store.taskDbPath()];
  const excluded = await runtime.executeAiToolCall({ name: "list_tasks", arguments: { answerMode: "counts", dueStatus: "overdue" } }, "kimi");
  expect(excluded.success).toBe(false); expect(excluded.output).not.toContain('"count"');
});
it.each([{ dueStatus: "overdue", status: "completed" }, { dueStatus: "overdue", category: "punishment" },
  { dueStatus: "unknown" }, { answerMode: "unknown" }])("rejects contradictory or unknown count selectors: %j", async args => {
  const result = await runtime.executeAiToolCall({ name: "list_tasks", arguments: { answerMode: "counts", ...args } }, "kimi");
  expect(result.success).toBe(false);
});
it("withholds malformed counts rather than inventing numbers or dropping the requested filter", () => {
  const base = { projection: "counts", date: today, statusAsOf: today, status: "active", count: 3, dueStatus: "overdue" };
  for (const patch of [{ count: -1 }, { count: 1.5 }, { count: "3" }, { statusAsOf: "bad" }, { dueStatus: "unknown" },
    { dueGroups: { overdue: { count: 3 }, dueToday: { count: -1 } } }]) expect(formatTaskListReply(JSON.stringify({ ...base, ...patch }), today)).toBeUndefined();
  const partial = formatTaskListReply(JSON.stringify({ ...base, count: 0, scope: "只提供允许读取的记录" }), today)!;
  expect(partial).toContain("0 项"); expect(partial).toContain("只提供允许读取的记录");
  expect(TASK_PLANNING_TOOLS[0].parameters.properties).toHaveProperty("answerMode");
});
