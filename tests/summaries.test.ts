import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage } from "../src/ai";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { FactOperationOptions } from "../src/dataFoundation/factOperation";
import { createPersonalMemory, emptyPersonalMemoryDocument, reviewPersonalMemoryRecord } from "../src/personalMemory";
import type { StoreHost } from "../src/store/settingsSlice";
import type { ProviderRequestOptions } from "../src/types";

vi.mock("obsidian", () => ({
  App: class {}, TFile: class {}, TFolder: class {}, Modal: class {}, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/"), parseYaml: JSON.parse, stringifyYaml: JSON.stringify
}));

const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { DiskVault } = await import("./helpers/diskVault");
const { generatePeriodSummary, runScheduledSummaries, startSummarySchedule, tickSummarySchedule } = await import("../src/features/summaries/service");
const { readSummary, readSummaryScope, summaryPath, renderSummary } = await import("../src/features/summaries/notes");
const { summaryPeriod, summaryBackfillPeriods } = await import("../src/features/summaries/periods");
const { signalDocumentPath } = await import("../src/features/journal/signalStore");
const { fileRevision } = await import("../src/operationIdentity");
type SummaryHost = import("../src/features/summaries/service").SummaryHost;

let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>, host: SummaryHost;
const now = (day: number, hour = 12, minute = 0) => new Date(2026, 10, day, hour, minute);
const summaryText = (level: string) => "虚构资料显示任务按记录完成，计划仍待核对。".repeat(level === "day" ? 18 : 47);
const ask = vi.fn(async (messages: ChatMessage[], options: ProviderRequestOptions) => {
  await options.beforeTextRequest?.();
  return summaryText(JSON.parse(messages[1].content).period.level);
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-summary-"));
  vault = new DiskVault(root);
  const settings = structuredClone(DEFAULT_SETTINGS);
  Object.assign(settings.ai, { provider: "custom", endpoint: "https://synthetic.invalid/chat", model: "synthetic", dataDisclosureAccepted: true });
  const app = { vault } as unknown as App;
  store = new LifeOpsStore(app, settings) as unknown as StoreHost;
  await store.initializeVault();
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
  ask.mockClear();
  host = {
    store, app, register() {}, unloaded: false, refreshViews: async () => undefined,
    async saveLocalOperation(name: string, args: Record<string, unknown>, execute: (scope: StoreHost) => Promise<unknown>, options?: FactOperationOptions) {
      const result = await runtime.executeLocalOperation(name, args, execute, undefined, options);
      if (!result.success) throw Error(result.output);
    },
    withAiFallback: (action: (options: ProviderRequestOptions) => Promise<string>, _fallback: string, options: ProviderRequestOptions) => action(options),
    observeProvider: (_stage: string, _inputSource: string, action: Function, signal?: AbortSignal) =>
      action({ signal }, store, { generateSummary: ask }, () => signal?.throwIfAborted(), () => undefined)
  } as unknown as SummaryHost;
});
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

async function saved(level: "day" | "week" | "month", date: string) {
  return readSummary(store, summaryPeriod(level, date), (await readSummaryScope(store)).hash);
}

it("generates an idempotent daily summary from code metrics, signals and only user conversation, with undo", async () => {
  const date = "2026-11-12";
  const path = store.path(store.settings.folders.dailyRoot, "2026", "11", date + "晚.md");
  const raw = "精力四分。未提取的私人原文。";
  await vault.seed(path, raw);
  const signal = { date, period: "晚", energy: 4, mood: null, stress: null, sleepHours: null, sleepQuality: null,
    keyEvents: [], plans: [], ideas: [], worries: [], quotes: [{ field: "energy", text: "精力四分" }], sources: [{ path, sha256: fileRevision(raw) }] };
  await vault.seed(signalDocumentPath(store, date), JSON.stringify({ version: 1, date, 晨: [], 晚: [signal] }));
  await store.appendAgentConversation("我决定周末写虚构计划。", "助手编造了一项任务。", date);
  const task = await store.createTask({ title: "虚构任务", date });
  await store.updateTask(task.id, old => ({ ...old, status: "completed", completedAt: now(12, 10).toISOString() }));
  const period = summaryPeriod("day", date);
  const actual = await generatePeriodSummary(host, period, now(12, 23, 30));
  expect(actual.status).toBe("saved");
  const note = await saved("day", date);
  expect(note?.properties).toMatchObject({ complete: true, generatedBy: "model", metrics: { energy: 4, tasksCompleted: 1, taskCompletionPercent: 100 } });
  const input = ask.mock.calls[0][0][1].content;
  expect(input).toContain("我决定周末写虚构计划");
  expect(input).toContain("虚构任务");
  expect(input).not.toMatch(/助手编造|未提取的私人原文/);
  expect(await generatePeriodSummary(host, period, now(13))).toMatchObject({ status: "existing" });
  expect(ask).toHaveBeenCalledOnce();
  expect(await vault.bytes(path)).toBe(raw);
  await runtime.undoLatestOperation();
  expect(store.getFile(actual.path)).toBeNull();
});

it("catches up the previous day, fills the Sunday 21:30 report after the 23:30 daily, and preserves edits", async () => {
  const sunday = "2026-11-15", saturday = "2026-11-14";
  await runScheduledSummaries(host, now(15, 21, 29));
  expect(await saved("day", saturday)).toBeDefined();
  expect(await saved("day", sunday)).toBeUndefined();
  expect(await saved("week", sunday)).toBeUndefined();
  await runScheduledSummaries(host, now(15, 21, 30));
  expect((await saved("week", sunday))?.properties).toMatchObject({ complete: false, inputCount: 1 });
  await runScheduledSummaries(host, now(15, 23, 30));
  expect((await saved("day", sunday))?.properties.complete).toBe(true);
  expect((await saved("week", sunday))?.properties).toMatchObject({ complete: true, inputCount: 2 });
  const path = summaryPath(store, summaryPeriod("week", sunday));
  const edited = (await vault.bytes(path)).replace('"inputCount":2', '"inputCount":2,"userTag":"手写补充保留"');
  await store.writeFile(path, edited);
  expect((await saved("week", sunday))?.edited).toBe(true);
  await runScheduledSummaries(host, now(16, 8));
  expect(await vault.bytes(path)).toBe(edited);
});

it("keeps confirmed health metrics and coverage in local daily and weekly summaries", async () => {
  await store.appendHealthEntry({ date: "2026-11-14", steps: 0, weightKg: 68.5, restingHeartRate: 63 });
  await store.appendHealthEntry({ date: "2026-11-15", sleepHours: 7.25, runningKm: 2.4, weightKg: 69.5 });
  ask.mockResolvedValueOnce("too short").mockResolvedValueOnce("too short");
  const day = await generatePeriodSummary(host, summaryPeriod("day", "2026-11-15"), now(15, 23, 30));
  expect(day.generatedBy).toBe("local");
  const daily = await saved("day", "2026-11-15");
  expect(daily?.text).toContain("平均睡眠 7.25 小时（1 天）。累计跑步 2.4 公里（1 天）。平均体重 69.5 kg（1 天）。");
  expect(daily?.text).not.toContain("静息心率");
  ask.mockResolvedValueOnce("too short").mockResolvedValueOnce("too short");
  const week = await generatePeriodSummary(host, summaryPeriod("week", "2026-11-15"), now(15, 23, 30));
  expect(week.generatedBy).toBe("local");
  const weekly = await saved("week", "2026-11-15");
  expect(weekly?.text).toContain("健康记录覆盖 2 天。");
  expect(weekly?.text).toContain("累计步数 0 步（1 天）。");
  expect(weekly?.text).toContain("平均体重 69 kg（2 天）。平均静息心率 63 次/分（1 天）。");
});

it("appends the code-calculated health counts to a valid model summary", async () => {
  const date = "2026-11-15";
  await store.appendHealthEntry({ date, sleepHours: 7.25, steps: 0 });
  ask.mockResolvedValueOnce(summaryText("day"));
  const report = await generatePeriodSummary(host, summaryPeriod("day", date), now(15, 23, 30));
  expect(report.generatedBy).toBe("model");
  const note = await saved("day", date);
  expect(note?.text).toContain("健康记录覆盖 1 天。平均睡眠 7.25 小时（1 天）。累计步数 0 步（1 天）。");
});

it("states that health coverage is unavailable when all records in the period are excluded", async () => {
  const date = "2026-11-15";
  await store.appendHealthEntry({ date, sleepHours: 7.25 });
  store.settings.privacy = { ...store.settings.privacy, excludedVaultPrefixes: [store.path(store.settings.folders.health, date + ".md")] };
  ask.mockResolvedValueOnce("too short").mockResolvedValueOnce("too short");
  const report = await generatePeriodSummary(host, summaryPeriod("day", date), now(15, 23, 30));
  expect(report.generatedBy).toBe("local");
  const note = await saved("day", date);
  expect(note?.text).toContain("这个时段暂无可读的健康记录。");
  expect(note?.text).not.toContain("7.25");
});

it("catches up the previous day even when the first launch is after 23:30", async () => {
  await runScheduledSummaries(host, now(12, 23, 47));
  expect((await saved("day", "2026-11-11"))?.properties.complete).toBe(true);
  expect((await saved("day", "2026-11-12"))?.properties.complete).toBe(true);
});

it("accepts a new request when the previous summary request is already cancelled", async () => {
  const date = "2026-11-12", period = summaryPeriod("day", date);
  const cancelled = new AbortController();
  let started!: () => void, finish!: () => void, replacementStarted!: () => void, finishReplacement!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { finish = resolve; });
  const replacementWaiting = new Promise<void>(resolve => { replacementStarted = resolve; });
  const replacementHeld = new Promise<void>(resolve => { finishReplacement = resolve; });
  ask.mockImplementationOnce(async (_messages, options) => {
    started();
    await held;
    options.signal?.throwIfAborted();
    return summaryText("day");
  }).mockImplementationOnce(async () => {
    replacementStarted();
    await replacementHeld;
    return summaryText("day");
  });
  const original = generatePeriodSummary(host, period, now(12, 23, 30), cancelled.signal);
  const rejection = expect(original).rejects.toThrow();
  await waiting;
  cancelled.abort();
  const replacement = generatePeriodSummary(host, period, now(12, 23, 30));
  finish();
  await rejection;
  await replacementWaiting;
  try {
    expect(generatePeriodSummary(host, period, now(12, 23, 30))).toBe(replacement);
  } finally { finishReplacement(); }
  expect(await replacement).toMatchObject({ status: "saved" });
  expect(ask).toHaveBeenCalledTimes(2);
  expect((await saved("day", date))?.properties.complete).toBe(true);
});

it("starts automatic summaries at installation and leaves earlier history for confirmed backfill", async () => {
  await startSummarySchedule(host, now(12, 22));
  expect(ask).not.toHaveBeenCalled();
  await tickSummarySchedule(host, now(12, 23, 30));
  expect((await saved("day", "2026-11-12"))?.properties.complete).toBe(true);
  expect(await saved("day", "2026-11-11")).toBeUndefined();
  expect(ask).toHaveBeenCalledOnce();
});

it("leaves a note untouched when the user edits it while a replacement is generating", async () => {
  const date = "2026-11-12", period = summaryPeriod("day", date);
  const { path } = await generatePeriodSummary(host, period, now(12, 15));
  const edited = (await vault.bytes(path)) + "\n手写补充在模型返回前保存。\n";
  ask.mockImplementationOnce(async (_messages, options) => {
    await options.beforeTextRequest?.();
    await store.writeFile(path, edited);
    return summaryText("day");
  });
  await expect(generatePeriodSummary(host, period, now(12, 23, 30))).rejects.toThrow("摘要位置已有新内容");
  expect(await vault.bytes(path)).toBe(edited);
});

it("does not write into a replacement store after preparing summary inputs in the old store", async () => {
  const date = "2026-11-12", period = summaryPeriod("day", date);
  const replacement = new LifeOpsStore(host.app, structuredClone(store.settings)) as unknown as StoreHost;
  const start = vi.mocked(ask).mockImplementationOnce(async (_messages, options) => {
    await options.beforeTextRequest?.();
    host.store = replacement;
    return summaryText("day");
  });
  const path = summaryPath(store, period);
  await expect(generatePeriodSummary(host, period, now(12, 23, 30))).rejects.toThrow("摘要");
  expect(start).toHaveBeenCalledOnce();
  expect(store.getFile(path)).toBeNull();
  expect(await generatePeriodSummary(host, period, now(12, 23, 30))).toMatchObject({ status: "saved" });
});

it("removes a forgotten phrase before shortening earlier summaries for the model", async () => {
  const memory = createPersonalMemory({ kind: "core_profile", content: "虚构须遗忘的特殊说明" });
  await vault.seed(store.personalMemoryPath(), JSON.stringify({
    ...emptyPersonalMemoryDocument(), records: reviewPersonalMemoryRecord([memory], memory.id, { decision: "forget" })
  }));
  const daily = summaryPeriod("day", "2026-11-14");
  const scope = await readSummaryScope(store);
  const metrics = { taskCompletionPercent: null, tasksCompleted: 0, energy: null, tradePnlCny: null, tradePnlUsd: null };
  const original = renderSummary(daily, daily.to, scope.hash, metrics, 0, true, "model",
    "前".repeat(946) + memory.content + "\n\n保留这段虚构记录。");
  await vault.seed(summaryPath(store, daily), original);
  await generatePeriodSummary(host, summaryPeriod("week", "2026-11-15"), now(15, 21, 30));
  const input = ask.mock.calls[0][0][1].content;
  expect(input).not.toContain("虚构须遗");
  expect(input).toContain("保留这段虚构记录");
  expect(await vault.bytes(summaryPath(store, daily))).toBe(original);
});

it("opens prior-month comparisons through the read-only tool and respects later source exclusions", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now(1, 0));
  const scope = (await readSummaryScope(store)).hash;
  const week = summaryPeriod("week", "2026-10-05");
  const metrics = { taskCompletionPercent: null, tasksCompleted: 2, energy: null, tradePnlCny: null, tradePnlUsd: null };
  await vault.seed(summaryPath(store, week), renderSummary(week, week.to, scope, metrics, 7, true, "model", "虚构十月周摘要。"));
  await runScheduledSummaries(host, now(1, 0));
  const monthly = (await saved("month", "2026-10-31"))!;
  expect(monthly.properties).toMatchObject({ from: "2026-10-01", to: "2026-10-31", inputCount: 2, complete: true });
  expect(ask.mock.calls.some(([messages]) => messages[1].content.includes("虚构十月周摘要"))).toBe(true);
  const query = (id: string) => runtime.executeAiToolCall({ id, name: "get_summaries", arguments: { level: "month", range: "last_month" } }, "kimi");
  const result = await query("monthly-synthetic-1");
  expect(JSON.parse(result.output).summaries).toMatchObject([{ path: monthly.path, period: "2026-10" }]);
  store.settings.privacy!.excludedVaultPrefixes = [store.settings.folders.dailyRoot];
  expect(JSON.parse((await query("monthly-synthetic-2")).output).summaries).toEqual([]);
  expect(await vault.bytes(monthly.path)).toContain(monthly.text);
});

it("uses ISO week numbers at the year boundary and fills eight complete weeks in order", () => {
  expect(summaryPeriod("week", "2027-01-01")).toMatchObject({ key: "2026-W53", from: "2026-12-28", to: "2027-01-03" });
  const periods = summaryBackfillPeriods(now(17));
  expect(periods.filter(period => period.level === "day")).toHaveLength(56);
  expect(periods.filter(period => period.level === "week")).toHaveLength(8);
  expect(periods[55].to).toBe("2026-11-15");
  expect(periods.at(-1)?.to).toBe("2026-11-15");
});
