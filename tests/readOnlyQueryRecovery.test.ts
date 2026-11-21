import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { ProviderRunFailure, providerRunStart } from "../src/providerRun";
import type { AiChatResult, AiToolCall } from "../src/ai";
import type { OperationLedgerDocument } from "../src/dataFoundation/operationLedger";
import type { StoreHost } from "../src/store/settingsSlice";
import { fileRevision } from "../src/operationIdentity";

vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {},
  Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: vi.fn(),
  parseYaml: JSON.parse, stringifyYaml: JSON.stringify
}));
const { createFsApp } = await import("./helpers/fsApp");
const { LifeOpsStore } = await import("../src/store");
const { LifeOpsAi } = await import("../src/ai");
const { default: Plugin } = await import("../src/main");
const { AgentRuntime } = await import("../src/agentRuntime");
const { tradeDatabasePath } = await import("../src/features/trading/persistence");
const { requestUrl } = await import("obsidian");
const { factRecoveryPath, hasPendingFactOperation } = await import("../src/dataFoundation/factOperation");
let root = "";
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  if (root) await rm(root, { recursive: true, force: true });
});
type Context = { store: StoreHost; plugin: InstanceType<typeof Plugin>; app: ReturnType<typeof createFsApp> };
const message = "对照这个月与上个月的任务完成情况和交易净盈亏，分别列区间和任务数，人民币和美元分开，不保存任何记录。";
const ranges = [{ from: "2026-10-01", to: "2026-10-31" }, { from: "2026-11-01", to: "2026-11-12" }];
const taskCalls = (): AiToolCall[] => ranges.map((range, index) => ({ id: "fictional-month-read-" + index,
  name: "get_stats", arguments: { domain: "tasks", range } }));
async function scenario(options: { calls?: AiToolCall[]; beforeFailure?: (ctx: Context) => void | Promise<void>; error?: Error } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-12T12:00:00+08:00"));
  root = await mkdtemp(join(tmpdir(), "lifeops-read-only-recovery-"));
  const app = createFsApp(root), settings = structuredClone(DEFAULT_SETTINGS);
  settings.ai = { ...settings.ai, provider: "custom", endpoint: "https://fictional.invalid", model: "synthetic-read-only",
    apiKey: "fictional-fixture-key", fallbackProvider: "off", dataDisclosureAccepted: true };
  settings.privacy = { ...settings.privacy, plaintextCredentialStorageAccepted: true, excludedVaultPrefixes: [] };
  const store = new LifeOpsStore(app, settings) as unknown as StoreHost; await store.initializeVault();
  const completed = await store.createTask({ title: "虚构十月纸样", date: "2026-10-04" });
  await store.updateTask(completed.id, row => ({ ...row, createdAt: "2026-10-04T08:00:00+08:00",
    status: "completed", completedAt: "2026-10-05T17:00:00+08:00" }));
  const pending = await store.createTask({ title: "虚构十一月纸盒", date: "2026-11-04" });
  const before = await store.readPath(store.taskDbPath());
  const run = providerRunStart(settings.ai); run.status = "failed";
  const interrupted = options.error ?? new ProviderRunFailure(run, "response_incomplete");
  const turn: AiChatResult = { content: "", toolCalls: options.calls ?? taskCalls() };
  let plugin: InstanceType<typeof Plugin>;
  const model = vi.spyOn(LifeOpsAi.prototype, "agentTurnStream").mockImplementation(async () => {
    await options.beforeFailure?.({ store, plugin, app }); throw interrupted;
  }).mockResolvedValueOnce(turn);
  plugin = Object.assign(Object.create(Plugin.prototype), {
    app, store, settings: store.settings, lifecycleGeneration: 1, unloaded: false,
    ai: new LifeOpsAi(store.settings), updateStatusBar: async () => {}, refreshViews: async () => {},
    lifeOpsEvents: { publish: () => {} }, buildSemanticContext: async () => ""
  }) as InstanceType<typeof Plugin>;
  return { app, store, plugin, model, before, pending,
    run: (options: { signal?: AbortSignal } = {}) => plugin.submitAgentMessageStream(message, [], undefined, { source: "text", ...options }) };
}

it("preserves useful read-only month statistics when the subsequent model answer is incomplete", async () => {
  const ctx = await scenario(), result = await ctx.run();
  expect(await ctx.store.readPath(ctx.store.taskDbPath())).toBe(ctx.before);
  expect(ctx.model).toHaveBeenCalledTimes(2);
  const ledger = await ctx.store.readJson<OperationLedgerDocument>(ctx.store.path(ctx.store.settings.folders.aiReports, "Operations", "operation-ledger.json"), { version: 1, records: [] });
  const reads = ledger.records.filter(row => row.toolName === "get_stats" && row.status === "verified");
  expect(reads).toHaveLength(2);
  expect(reads.map(row => JSON.parse(row.result!.output).plannedCount)).toEqual([1, 1]);
  expect(result.actions).toEqual([]); expect(result.receipts ?? []).toEqual([]);
  for (const value of ["2026-10-01", "2026-10-31", "2026-11-01", "2026-11-12", "100%", "0%"]) expect(result.reply).toContain(value);
  expect(result.reply).toContain("1980 分钟"); expect(result.reply).toContain("不是实测工时");
  expect(result.reply).toMatch(/中断|未完成/);
});

it("reports separate currency samples and dated groups without inventing unknown profit", async () => {
  const range = { from: "2026-10-01", to: "2026-11-12" };
  const ctx = await scenario({ calls: [
    { id: "fictional-grouped-tasks", name: "get_stats", arguments: { domain: "tasks", range, groupBy: "day" } },
    { id: "fictional-grouped-trades", name: "get_stats", arguments: { domain: "trades", range, groupBy: "month" } }
  ] });
  const runtime = new AgentRuntime({ store: ctx.store, refreshViews: async () => {} });
  const saved = await runtime.executeAiToolCall({ id: "fictional-seed-trades", name: "record_trade", arguments: { trades: [
    { market: "A股", symbol: "FICT-CNY", direction: "long", openedAt: "2026-10-09", pnl: 120 },
    { market: "美股", symbol: "FICT-USD", direction: "long", openedAt: "2026-11-09", pnl: -30 },
    { market: "美股", symbol: "FICT-UNKNOWN", direction: "long", openedAt: "2026-11-10" }
  ] } }, "kimi");
  expect(saved.success, saved.output).toBe(true);
  const tradePath = tradeDatabasePath(ctx.store.settings.folders), before = await ctx.store.readPath(tradePath);
  const result = await ctx.run();
  expect(result.reply).toContain("2026-10-04"); expect(result.reply).toContain("2026-10-05");
  expect(result.reply).toContain("2026-10："); expect(result.reply).toContain("2026-11：");
  expect(result.reply).toContain("120 元"); expect(result.reply).toContain("-30 美元");
  expect(result.reply).toContain("另 1 笔盈亏未知");
  expect(result.receipts ?? []).toEqual([]); expect(ctx.model).toHaveBeenCalledTimes(2);
  expect(await ctx.store.readPath(tradePath)).toBe(before);
  expect(await ctx.store.readPath(ctx.store.taskDbPath())).toBe(ctx.before);
});

it.each(["privacy", "unload", "credentials", "vault"])("withholds old statistics after %s changes", async kind => {
  const ctx = await scenario({ beforeFailure: async ({ store, plugin }) => {
    if (kind === "privacy") store.settings.privacy!.excludedVaultPrefixes = [store.taskDbPath()];
    if (kind === "unload") Object.assign(plugin, { unloaded: true });
    if (kind === "credentials") store.settings.ai.dataDisclosureAccepted = false;
    if (kind === "vault") {
      const other = join(root, "other"); await mkdir(other);
      const replacement = new LifeOpsStore(createFsApp(other), structuredClone(store.settings));
      Object.assign(plugin, { store: replacement });
    }
  } });
  await expect(ctx.run()).rejects.toBeDefined(); expect(ctx.model).toHaveBeenCalledTimes(2);
  expect(await ctx.store.readPath(ctx.store.taskDbPath())).toBe(ctx.before);
});

it("honors cancellation after the successful statistics instead of publishing a late recovery", async () => {
  const controller = new AbortController();
  const ctx = await scenario({ beforeFailure: () => controller.abort() });
  await expect(ctx.run({ signal: controller.signal })).rejects.toBeDefined();
  expect(ctx.model).toHaveBeenCalledTimes(2); expect(await ctx.store.readPath(ctx.store.taskDbPath())).toBe(ctx.before);
});

it("rereads updated records instead of repeating the pre-failure numbers", async () => {
  const ctx = await scenario({ beforeFailure: async ({ store }) => {
    const task = (await store.readTaskDb()).tasks.find(row => row.title === "虚构十一月纸盒")!;
    await store.updateTask(task.id, row => ({ ...row, status: "completed", completedAt: "2026-11-12T10:00:00+08:00" }));
  } });
  const result = await ctx.run();
  expect(result.reply.match(/计划完成率 100%/gu)).toHaveLength(2);
  expect(result.reply).not.toContain("计划完成率 0%"); expect(result.reply).toContain("重新核对");
  expect((await ctx.store.readTaskDb()).tasks.find(row => row.id === ctx.pending.id)?.status).toBe("completed");
  expect(result.receipts ?? []).toEqual([]); expect(ctx.model).toHaveBeenCalledTimes(2);
});

it("allows a title-only sync when freshly computed statistics remain unchanged", async () => {
  let changed = "", hooked = false;
  const ctx = await scenario({ beforeFailure: async ({ store, app }) => {
    const original = store.readPath.bind(store); let calls = 0;
    vi.spyOn(store, "readPath").mockImplementation(async path => {
      const result = await original(path);
      if (path === store.taskDbPath() && ++calls === 1) {
        const next = JSON.parse(result); next.tasks[1].title = "虚构同步刚更新的标题";
        changed = JSON.stringify(next, null, 2) + "\n";
        await app.vault.modify(app.vault.getFileByPath(store.taskDbPath())!, changed); hooked = true;
      }
      return result;
    });
  } });
  const result = await ctx.run();
  expect(hooked).toBe(true); expect(result.reply).toContain("重新核对");
  expect(await ctx.store.readPath(ctx.store.taskDbPath())).toBe(changed); expect(ctx.model).toHaveBeenCalledTimes(2);
});

it("withholds results when measured records change between fresh local reads", async () => {
  let changed = "", hooked = false;
  const ctx = await scenario({ beforeFailure: async ({ store, app }) => {
    const original = store.readPath.bind(store); let calls = 0;
    vi.spyOn(store, "readPath").mockImplementation(async path => {
      const result = await original(path);
      if (path === store.taskDbPath() && ++calls === 2) {
        const next = JSON.parse(result); next.tasks[1].status = "completed"; next.tasks[1].completedAt = "2026-11-12T12:00:00+08:00";
        changed = JSON.stringify(next, null, 2) + "\n";
        await app.vault.modify(app.vault.getFileByPath(store.taskDbPath())!, changed); hooked = true;
      }
      return result;
    });
  } });
  await expect(ctx.run()).rejects.toBeDefined(); expect(hooked).toBe(true);
  expect(await ctx.store.readPath(ctx.store.taskDbPath())).toBe(changed); expect(ctx.model).toHaveBeenCalledTimes(2);
});

it("does not turn an attempted write into a read-only fallback or retry it", async () => {
  const ctx = await scenario({ calls: [...taskCalls(), { id: "fictional-missing-update", name: "update_tasks",
    arguments: { updates: [{ taskIdOrTitle: "不存在的虚构任务", title: "不应创建的任务" }] } }] });
  await expect(ctx.run()).rejects.toBeDefined();
  expect(await ctx.store.readPath(ctx.store.taskDbPath())).toBe(ctx.before); expect(ctx.model).toHaveBeenCalledTimes(2);
});

it("does not call empty records a zero completion performance", async () => {
  const ctx = await scenario({ calls: [{ id: "fictional-empty-month", name: "get_stats",
    arguments: { domain: "tasks", range: { from: "2025-10-01", to: "2025-10-31" } } }] });
  const result = await ctx.run();
  expect(result.reply).toContain("无计划样本，无法计算完成率");
  expect(result.reply).not.toContain("完成率 0%"); expect(result.reply).toContain("未登记情况未知");
});

it("waits for a live fact transaction before reporting its committed statistics", async () => {
  let pending: Promise<unknown> | undefined, released = false, earlyReads = 0;
  const ctx = await scenario({ beforeFailure: async ({ store }) => {
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    pending = runtime.executeLocalOperation("fictional_delayed_change", {}, async scope => {
      const task = (await scope.readTaskDb()).tasks.find(row => row.title === "虚构十一月纸盒")!;
      await scope.updateTask(task.id, row => ({ ...row, status: "completed", completedAt: "2026-11-12T12:00:00+08:00" }));
      started(); await held;
    });
    await ready;
    const read = store.readPath.bind(store);
    vi.spyOn(store, "readPath").mockImplementation(async path => {
      if (!released && path === store.taskDbPath()) earlyReads++;
      return read(path);
    });
    setTimeout(() => { released = true; release(); }, 25);
  } });
  const result = await ctx.run(); await pending;
  expect(released).toBe(true); expect(earlyReads).toBe(0);
  expect(result.reply.match(/计划完成率 100%/gu)).toHaveLength(2);
  expect(result.receipts ?? []).toEqual([]); expect(ctx.model).toHaveBeenCalledTimes(2);
});

it("can construct the native synthetic interruption from a genuine no-egress configuration failure", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.ai = { ...settings.ai, provider: "custom", endpoint: "https://fictional.invalid", model: "synthetic-read-only",
    apiKey: "fictional-fixture-key", fallbackProvider: "off", dataDisclosureAccepted: true };
  settings.privacy = { ...settings.privacy, excludedVaultPrefixes: settings.privacy?.excludedVaultPrefixes ?? [], plaintextCredentialStorageAccepted: false };
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("No transport allowed"));
  let failure: unknown;
  try { await new LifeOpsAi(settings).agentTurnStream([{ role: "user", content: "虚构预检" }], () => {}, { preferFinite: true }); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ProviderRunFailure);
  expect((failure as ProviderRunFailure).code).toBe("configuration");
  const ErrorType = (failure as Error).constructor as new (run: ReturnType<typeof providerRunStart>, code: "response_incomplete") => Error;
  expect(new ErrorType((failure as ProviderRunFailure).providerRun, "response_incomplete")).toBeInstanceOf(ProviderRunFailure);
  expect(fetchSpy).not.toHaveBeenCalled(); expect(requestUrl).not.toHaveBeenCalled();
});

it("does not automatically settle an interrupted durable write to display read-only statistics", async () => {
  let journal = "", note = "";
  const ctx = await scenario({ beforeFailure: async ({ store, app }) => {
    note = store.path(store.settings.folders.ideas, "虚构中断笔记.md");
    await app.vault.seed(note, "intended");
    journal = JSON.stringify({ version: 1, operationId: "fictional-interrupted", status: "pending", rollbackRequired: true,
      entries: [{ path: note, before: "original", after: "intended", previous: "original",
        beforeHash: fileRevision("original"), afterHash: fileRevision("intended"), previousHash: fileRevision("original") }] });
    await app.vault.seed(factRecoveryPath(store), journal);
    expect(await hasPendingFactOperation(store)).toBe(true);
  } });
  await expect(ctx.run()).rejects.toBeDefined();
  expect(await ctx.store.readPath(factRecoveryPath(ctx.store))).toBe(journal);
  expect(await ctx.store.readPath(note)).toBe("intended");
  expect(await ctx.store.readPath(ctx.store.taskDbPath())).toBe(ctx.before); expect(ctx.model).toHaveBeenCalledTimes(2);
});

it("does not revive a forgotten model label in a locally recovered grouped report", async () => {
  const ctx = await scenario({ calls: [{ id: "fictional-forgotten-model-read", name: "get_stats",
    arguments: { domain: "trades", range: ranges[0], groupBy: "model" } }] });
  const runtime = new AgentRuntime({ store: ctx.store, refreshViews: async () => {} });
  const content = "虚构已遗忘策略";
  const saved = await runtime.executeAiToolCall({ id: "fictional-forgotten-trade", name: "record_trade", arguments: {
    trades: [{ market: "A股", symbol: "FICT-FORGOTTEN", direction: "long", openedAt: "2026-10-09", pnl: 120, modelId: content }]
  } }, "kimi");
  expect(saved.success, saved.output).toBe(true);
  const memory = await ctx.store.upsertPersonalMemory({ kind: "user_rule", content, sourceRefs: [] });
  await ctx.store.reviewPersonalMemory(memory.id, { decision: "forget" });
  await expect(ctx.run()).rejects.toBeDefined(); expect(ctx.model).toHaveBeenCalledTimes(2);
});

it("renders task categories as ordinary labels with the original grouped completion numbers", async () => {
  const ctx = await scenario({ calls: [{ id: "fictional-category-recovery", name: "get_stats",
    arguments: { domain: "tasks", range: { from: "2026-10-01", to: "2026-11-12" }, groupBy: "category" } }] });
  const result = await ctx.run();
  expect(result.reply).toContain("按分类"); expect(result.reply).toContain("工作：计划 2 项");
  expect(result.reply).toContain("计划完成率 50%"); expect(result.reply).not.toContain("work：");
  expect(ctx.model).toHaveBeenCalledTimes(2);
});

it("replaces an incomplete streamed fragment with fresh facts instead of appending it to the report", async () => {
  const ctx = await scenario(), snapshots: string[] = [];
  ctx.model.mockImplementationOnce(async (_messages, onText) => {
    onText("虚构错误半句：净盈亏9999元");
    const run = providerRunStart(ctx.store.settings.ai); run.status = "failed";
    throw new ProviderRunFailure(run, "response_incomplete");
  });
  const result = await ctx.plugin.submitAgentMessageStream(message, [], text => snapshots.push(text), { source: "text" });
  expect(snapshots.some(text => text.includes("9999"))).toBe(true);
  expect(snapshots.at(-1)).toBe(result.reply); expect(result.reply).not.toContain("9999");
  expect(result.reply).toContain("计划完成率 100%"); expect(ctx.model).toHaveBeenCalledTimes(2);
});
