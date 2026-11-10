import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { StoreHost } from "../src/store/settingsSlice";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { formatDate } from "../src/date";
vi.mock("obsidian", () => ({ App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class { open() {} },
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {}, setIcon: vi.fn(),
  normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), requestUrl: () => { throw Error("Network forbidden"); } }));
const { LifeOpsStore } = await import("../src/store"), { DiskVault } = await import("./helpers/diskVault"), { AgentRuntime } = await import("../src/agentRuntime");
const { ProjectJobRunner } = await import("../src/projectJobRunner"), { TaskPlanReviewRegistry } = await import("../src/taskPlanReviewRegistry");
const { projectJobPath } = await import("../src/projectJobRepository");
const { default: LifeOpsPlugin } = await import("../src/main");
const { createPersonalMemory, reviewPersonalMemoryRecord } = await import("../src/personalMemory");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runner: InstanceType<typeof ProjectJobRunner>, registry: InstanceType<typeof TaskPlanReviewRegistry>;
let clock: Date, loaded: boolean, source: string;
const tasks = () => [{ title: "纯虚构对话任务甲", date: "明天", time: "09:30", category: "虚构学习" }, { title: "纯虚构对话任务乙" }];
const prepare = () => registry.prepare(tasks(), "请安排两项虚构学习任务", [source]);
beforeEach(async () => {
  clock = new Date("2026-10-05T03:00:00.000Z"); loaded = true; root = await mkdtemp(join(tmpdir(), "lifeops-task-plan-review-")); vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; await store.initializeVault();
  const guard = () => { if (!loaded) throw Error("纯虚构插件已关闭"); };
  runner = new ProjectJobRunner(store, new AgentRuntime({ store, refreshViews: async () => {} }), () => clock, guard);
  registry = new TaskPlanReviewRegistry(store, () => runner, guard, () => clock);
  source = store.path(store.settings.folders.ideas, "纯虚构对话来源.md"); await vault.seed(source, "纯虚构依据第一版");
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
it("previews complete absolute dates without writes or exposing execution authority", async () => {
  const before = vault.writes.length, input = tasks(), action = await registry.prepare(input, "纯虚构原请求", [source]); input[0].title = "之后误改";
  expect(vault.writes.length).toBe(before); expect(action.content).toContain("2026-10-06"); expect(action.content).toContain("09:30"); expect(action.content).toContain("虚构学习");
  expect(action.content).toContain("未设时间"); expect(JSON.stringify(action)).not.toMatch(/baseline|authorization|operationId|planHash/);
  const result = await registry.start({ ...action, id: "proposal:fictional-call:0" });
  expect(result.snapshot.document.job?.userMessage).toBe("纯虚构原请求"); expect((await store.readTaskDb()).tasks[0].title).toBe("纯虚构对话任务甲");
  expect(result.snapshot.document.job?.status).toBe("completed"); expect((await store.readTaskDb()).tasks.every(t => t.status === "active")).toBe(true);
});
it.each(["title", "description", "content", "date", "taskPlanToken"] as const)("refuses tampered %s without consuming the genuine card", async key => {
  const action = await prepare(), before = vault.writes.length;
  expect(() => registry.start({ ...action, [key]: "纯虚构替换" })).toThrow("失效"); expect(vault.writes.length).toBe(before);
  await registry.start(action); expect((await store.readTaskDb()).tasks).toHaveLength(2);
});
it("refuses extra targeting fields and cross-registry copies, then rejects replay", async () => {
  const action = await prepare(), before = vault.writes.length;
  expect(() => registry.start({ ...action, taskIds: ["fiction"] } as any)).toThrow();
  expect(() => new TaskPlanReviewRegistry(store, () => runner).start(action)).toThrow(); expect(vault.writes.length).toBe(before);
  await registry.start(action); expect(() => registry.start(action)).toThrow(); expect((await store.readTaskDb()).tasks).toHaveLength(2);
});
it("consumes concurrent clicks synchronously before queued authorization", async () => {
  const action = await prepare(), pending = registry.start(action); expect(() => registry.start(action)).toThrow(); await pending;
  expect((await store.readTaskDb()).tasks).toHaveLength(2);
});
it("reuses a retried proposal without hidden cards and refuses changed meaning under the same call ID", async () => {
  const first = await registry.prepare(tasks(), "原请求", [source], "same-model-call");
  for (let i = 0; i < 20; i++) expect(await registry.prepare(tasks(), "原请求", [source], "same-model-call")).toEqual(first);
  await expect(registry.prepare([{ title: "纯虚构改换计划" }], "原请求", [source], "same-model-call")).rejects.toThrow();
  const pair = await Promise.all([registry.prepare(tasks(), "另一原请求", [source], "concurrent-call"), registry.prepare(tasks(), "另一原请求", [source], "concurrent-call")]);
  expect(pair[0]).toEqual(pair[1]); await registry.start(first); expect((await store.readTaskDb()).tasks).toHaveLength(2);
});
it("rejects changed sources and expired authorization before any Job or task write", async () => {
  const action = await prepare(); await vault.seed(source, "纯虚构依据第二版"); const before = vault.writes.length;
  await expect(registry.start(action)).rejects.toThrow(); expect(vault.writes.length).toBe(before);
  await expect(vault.bytes(projectJobPath(store))).rejects.toMatchObject({ code: "ENOENT" }); const fresh = await prepare(); clock = new Date(clock.getTime() + 24 * 60 * 60 * 1000);
  expect(() => registry.start(fresh)).toThrow(); expect((await store.readTaskDb()).tasks).toHaveLength(0);
});
it("invalidates old cards after clear or unload and stops an already aborted click before queue", async () => {
  const action = await prepare(); registry.clear(); expect(() => registry.start(action)).toThrow();
  const unloaded = await prepare(); loaded = false; expect(() => registry.start(unloaded)).toThrow("关闭"); loaded = true;
  const fresh = await prepare(), controller = new AbortController(), before = vault.writes.length; controller.abort();
  await expect(registry.start(fresh, controller.signal)).rejects.toThrow(); expect(vault.writes.length).toBe(before);
});
it("preserves pending cards at the limit and releases only the exact dismissed payload", async () => {
  const cards = []; for (let i = 0; i < 16; i++) cards.push(await prepare()); const before = vault.writes.length;
  await expect(prepare()).rejects.toThrow("较多"); registry.dismiss({ ...cards[0], content: "误改" }); await expect(prepare()).rejects.toThrow("较多");
  registry.dismiss(cards[0]); await prepare(); expect(vault.writes.length).toBe(before); await registry.start(cards[1]); expect((await store.readTaskDb()).tasks).toHaveLength(2);
});
it("uses the local creation day rather than the UTC date", async () => {
  clock = new Date(2026, 9, 6, 0, 5); const action = await prepare(); expect(action.date).toBe(formatDate(clock)); expect(action.content).toContain("2026-10-07");
});
it("routes the production model proposal through host context and first-party confirmation without a generic nested Fact", async () => {
  const plugin: any = Object.assign(Object.create(LifeOpsPlugin.prototype), { app: store.app, store, settings: store.settings,
    refreshViews: vi.fn(async () => {}), projectJobRunner: runner, taskPlanReviews: registry, unloaded: false, lifecycleGeneration: 0 });
  const before = vault.writes.length;
  const result = await plugin.executeToolCalls([{ id: "fictional-model-plan", name: "propose_task_plan", arguments: { tasks: tasks() } }], "纯虚构原始用户消息", undefined, undefined, undefined, [source]);
  expect(result.results[0].success).toBe(true); expect(result.actions[0].id).toBe("proposal:fictional-model-plan:0"); expect(vault.writes.length).toBe(before);
  const receipt = await plugin.executeAgentAction(result.actions[0]); expect(receipt).toContain("全部保存"); expect(receipt).toContain("仍未完成");
  expect((await store.readTaskDb()).tasks).toHaveLength(2);
  await expect(plugin.executeAgentAction(result.actions[0])).rejects.toThrow(); expect((await store.readTaskDb()).tasks).toHaveLength(2);
});
it("binds host-supplied sources and refuses model-supplied authority or a headless confirmation", async () => {
  const plugin: any = Object.assign(Object.create(LifeOpsPlugin.prototype), { app: store.app, store, settings: store.settings,
    refreshViews: vi.fn(async () => {}), projectJobRunner: runner, unloaded: false, lifecycleGeneration: 0 });
  const result = await plugin.executeToolCalls([{ id: "fictional-bound-plan", name: "propose_task_plan", arguments: { tasks: tasks() } }], "纯虚构用户消息", undefined, undefined, undefined, [source]);
  await vault.seed(source, "纯虚构宿主来源变化"); const before = vault.writes.length;
  await expect(plugin.executeAgentAction(result.actions[0])).rejects.toThrow(); expect(vault.writes.length).toBe(before);
  const bare = new AgentRuntime({ store, refreshViews: async () => {} });
  expect((await bare.executeAiToolCall({ id: "fictional-headless", name: "propose_task_plan", arguments: { tasks: tasks() } }, "kimi", "原请求")).success).toBe(false);
  const denied = await plugin.executeToolCalls([{ id: "fictional-authority", name: "propose_task_plan", arguments: { tasks: tasks(), confirmedByUser: true } }], "原请求");
  expect(denied.results[0].success).toBe(false); expect(vault.writes.length).toBe(before);
});
it("binds a tool batch's exact queried path even when it was absent from initial context", async () => {
  const plugin: any = Object.assign(Object.create(LifeOpsPlugin.prototype), { app: store.app, store, settings: store.settings,
    refreshViews: vi.fn(async () => {}), projectJobRunner: runner, unloaded: false, lifecycleGeneration: 0 });
  const result = await plugin.executeToolCalls([{ id: "fiction-query", name: "query_vault", arguments: { domain: "note", operation: "get", path: source } },
    { id: "fiction-plan", name: "propose_task_plan", arguments: { tasks: tasks() } }], "纯虚构安排请求");
  expect(result.actions).toHaveLength(1); await vault.seed(source, "纯虚构查询后变化"); const before = vault.writes.length;
  await expect(plugin.executeAgentAction(result.actions[0])).rejects.toThrow(); expect(vault.writes.length).toBe(before); expect((await store.readTaskDb()).tasks).toHaveLength(0);
});
it("does not issue a writable plan after an unbound query or a duplicate model call ID", async () => {
  const plugin: any = Object.assign(Object.create(LifeOpsPlugin.prototype), { app: store.app, store, settings: store.settings, refreshViews: vi.fn(async () => {}), unloaded: false });
  const result = await plugin.executeToolCalls([{ id: "fiction-search", name: "query_vault", arguments: { domain: "note", operation: "search", query: "纯虚构" } },
    { id: "fiction-plan", name: "propose_task_plan", arguments: { tasks: tasks() } }], "纯虚构安排请求");
  expect(result.actions).toHaveLength(0); expect(result.results[1].success).toBe(false);
  const before = vault.writes.length, duplicated = await plugin.executeToolCalls([{ id: "duplicate", name: "create_task", arguments: { title: "纯虚构勿写" } },
    { id: "duplicate", name: "propose_task_plan", arguments: { tasks: tasks() } }], "创建任务：纯虚构勿写");
  expect(duplicated.results.every((r: any) => !r.success)).toBe(true); expect(vault.writes.length).toBe(before);
});
it("refuses forgotten content and invalidates an old card after memory or privacy correction", async () => {
  const memory = createPersonalMemory({ kind: "user_rule", content: "纯虚构已遗忘安排" });
  const forgotten = reviewPersonalMemoryRecord([memory], memory.id, { decision: "forget" });
  await vault.seed(store.personalMemoryPath(), JSON.stringify({ version: 1, records: forgotten })); const before = vault.writes.length;
  await expect(registry.prepare([{ title: "纯虚构已遗忘安排" }], "请安排虚构任务")).rejects.toThrow("遗忘"); expect(vault.writes.length).toBe(before);
  const action = await prepare(); store.settings.privacy!.excludedVaultPrefixes.push(source); const original = vault.writes.length;
  await expect(registry.start(action)).rejects.toThrow(); expect(vault.writes.length).toBe(original);
});
