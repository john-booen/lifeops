import { mkdtemp, readFile, rm } from "node:fs/promises";
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
const { confirmTradeScreenshot, parseTradeScreenshotRows, previewTradeScreenshot, readTradeScreenshot } = await import("../src/features/trading/screenshotImport");
const { readTradeDatabase } = await import("../src/features/trading/persistence");
const { collectTradeReview } = await import("../src/features/trading/reviewData");
const { renderTradeReview } = await import("../src/features/trading/reviewReport");
const { OperationLedger } = await import("../src/dataFoundation/operationLedger");
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

async function prepareFictionalScreenshot(currency: "CNY" | "USD") {
  const stem = currency === "USD" ? "equity-match" : "futures-mismatch";
  const name = stem + ".png";
  const image = await readTradeScreenshot(await readFile(join("tests/fixtures/trade-screenshots", name)));
  const match = currency === "USD";
  const rows = parseTradeScreenshotRows(JSON.stringify({ rows: [match ? {
    symbol: "FICT-A", market: "us-stock", direction: "long", currency, openedAt: "2026-10-12T09:30:00-04:00",
    openedZone: "-04:00", openClockShown: true, closedAt: "2026-10-12T15:30:00-04:00", closedZone: "-04:00",
    qty: 10, qtyUnit: "shares", entry: 100, exit: 110, fees: 2.5, displayedPnl: 97.5
  } : {
    symbol: "FICT-F", market: "futures", direction: "short", currency, openedAt: "2026-10-13T09:30:00+08:00",
    openedZone: "+08:00", openClockShown: true, closedAt: "2026-10-13T10:05:00+08:00", closedZone: "+08:00",
    qty: 2, qtyUnit: "contracts", entry: 250, exit: 245, fees: 3, displayedPnl: 94
  }] }));
  const preview = previewTradeScreenshot(rows, image.digest, (await readTradeDatabase(store)).trades, store.settings.tradingContractMultipliers);
  return { preview, confirm: () => confirmTradeScreenshot(host, rows, image.digest, preview, [1], () => {}) };
}

const summaryLevels = ["day", "week", "month"] as const;

it.each([
  { change: "complete", before: { tasksCompleted: 0, taskCompletionPercent: 0 }, after: { tasksCompleted: 1, taskCompletionPercent: 50 } },
  { change: "add-plan", before: { tasksCompleted: 1, taskCompletionPercent: 50 }, after: { tasksCompleted: 1, taskCompletionPercent: 33.33 } },
  { change: "reopen", before: { tasksCompleted: 1, taskCompletionPercent: 50 }, after: { tasksCompleted: 0, taskCompletionPercent: 0 } }
].flatMap(row => summaryLevels.map(level => ({ ...row, level }))))("refreshes same-day $level task figures after $change without another model call when unchanged", async row => {
  const { level } = row;
  const date = "2026-11-12", point = now(12), period = summaryPeriod(level, date);
  const first = await store.createTask({ title: "虚构纸盒甲", date });
  await store.createTask({ title: "虚构纸盒乙", date });
  if (row.change !== "complete") {
    await store.updateTask(first.id, task => ({ ...task, status: "completed", completedAt: now(12, 10).toISOString() }));
  }
  expect((await generatePeriodSummary(host, period, point)).status).toBe("saved");
  expect((await saved(level, date))?.properties.metrics).toMatchObject(row.before);
  if (row.change === "add-plan") await store.createTask({ title: "虚构纸盒丙", date });
  else await store.updateTask(first.id, task => row.change === "complete"
    ? { ...task, status: "completed", completedAt: now(12, 10).toISOString() }
    : { ...task, status: "active", completedAt: "" });
  expect((await generatePeriodSummary(host, period, point)).status).toBe("saved");
  const note = (await saved(level, date))!;
  expect(note.properties.metrics).toMatchObject(row.after);
  if (level === "week") expect(note.text).toContain(`完成任务 ${row.after.tasksCompleted} 项，计划完成率 ${row.after.taskCompletionPercent}%。`);
  const inputs = JSON.parse(ask.mock.calls.at(-1)![0][1].content);
  expect(inputs.stats.tasks).toMatchObject({ completedCount: row.after.tasksCompleted, completionPercent: row.after.taskCompletionPercent });
  expect((await generatePeriodSummary(host, period, point)).status).toBe("existing");
  expect(ask).toHaveBeenCalledTimes(2);
});

it.each(summaryLevels)("does not save a %s summary if task figures change during generation", async level => {
  const date = "2026-11-12", point = now(12), period = summaryPeriod(level, date);
  const task = await store.createTask({ title: "虚构生成中完成的纸盒", date });
  ask.mockImplementationOnce(async (messages, options) => {
    await options.beforeTextRequest?.();
    await store.updateTask(task.id, row => ({ ...row, status: "completed", completedAt: now(12, 10).toISOString() }));
    return summaryText(JSON.parse(messages[1].content).period.level);
  });
  await expect(generatePeriodSummary(host, period, point)).rejects.toThrow("任务统计在摘要生成期间有变化");
  expect(await saved(level, date)).toBeUndefined();
  expect((await generatePeriodSummary(host, period, point)).status).toBe("saved");
  expect((await saved(level, date))?.properties.metrics).toMatchObject({ tasksCompleted: 1, taskCompletionPercent: 100 });
});

it.each(summaryLevels)("keeps a hand-edited %s summary byte-for-byte when task figures change", async level => {
  const date = "2026-11-12", point = now(12), period = summaryPeriod(level, date);
  const task = await store.createTask({ title: "虚构手写周报纸盒", date });
  const { path } = await generatePeriodSummary(host, period, point);
  const edited = (await vault.bytes(path)) + "\n虚构的手写复盘，不要覆盖。\n";
  await store.writeFile(path, edited);
  await store.updateTask(task.id, row => ({ ...row, status: "completed", completedAt: now(12, 10).toISOString() }));
  expect((await generatePeriodSummary(host, period, point)).status).toBe("existing");
  expect(await vault.bytes(path)).toBe(edited);
  expect(ask).toHaveBeenCalledOnce();
});

it.each(summaryLevels)("keeps the prior %s summary and a new task if figures change immediately before commit", async level => {
  const date = "2026-11-12", point = now(12), period = summaryPeriod(level, date);
  const task = await store.createTask({ title: "虚构提交前纸盒甲", date });
  const { path } = await generatePeriodSummary(host, period, point);
  const original = await vault.bytes(path);
  await store.updateTask(task.id, row => ({ ...row, status: "completed", completedAt: now(12, 10).toISOString() }));
  const save = host.saveLocalOperation.bind(host);
  host.saveLocalOperation = (name, args, execute, options) => save(name, args, async operation => {
    const result = await execute(operation);
    await store.createTask({ title: "虚构提交前新计划乙", date });
    return result;
  }, options);
  await expect(generatePeriodSummary(host, period, point)).rejects.toThrow();
  expect(await vault.bytes(path)).toBe(original);
  expect((await store.readTaskDb({ readOnly: true })).tasks.map(row => row.title)).toContain("虚构提交前新计划乙");
  host.saveLocalOperation = save;
  expect((await generatePeriodSummary(host, period, point)).status).toBe("saved");
  expect((await saved(level, date))?.properties.metrics).toMatchObject({ tasksCompleted: 1, taskCompletionPercent: 50 });
});

it.each(summaryLevels)("reconciles a same-day %s summary with English screenshots and their actual computed currencies", async level => {
  const date = level === "day" ? "2026-10-12" : "2026-10-14";
  const point = new Date(2026, 9, 14, 12), period = summaryPeriod(level, date);
  store.settings.tradingContractMultipliers = { "FICT-F": 10 };
  const { path } = await generatePeriodSummary(host, period, point);
  expect((await saved(level, date))?.properties.metrics).toMatchObject({ tradePnlCny: 0, tradePnlUsd: 0 });

  const usd = await prepareFictionalScreenshot("USD");
  expect(usd.preview.rows[0]).toMatchObject({ kind: "ready", computedPnl: 97.5, draft: { currency: "USD" } });
  expect((await readTradeDatabase(store)).trades).toEqual([]);
  await usd.confirm();
  const cny = await prepareFictionalScreenshot("CNY");
  expect(cny.preview.rows[0]).toMatchObject({ kind: "ready", screenshotPnl: 94, computedPnl: 97, draft: { currency: "CNY" } });
  await cny.confirm();
  const receipt = (await new OperationLedger(store).latestReversible())!.operationId;

  expect((await generatePeriodSummary(host, period, point)).status).toBe("saved");
  const cnyInPeriod = level === "day" ? 0 : 97;
  const note = (await saved(level, date))!;
  expect(note.properties.metrics).toMatchObject({ tradePnlCny: cnyInPeriod, tradePnlUsd: 97.5 });
  if (level === "week") expect(note.text).toContain("交易净盈亏为 CNY 97，USD 97.5。");
  expect(JSON.parse(ask.mock.calls.at(-1)![0][1].content).stats.trades.byCurrency).toMatchObject({ CNY: { totalPnl: cnyInPeriod }, USD: { totalPnl: 97.5 } });
  const tradeReview = await collectTradeReview(store, "week", point);
  expect(tradeReview.stats).toMatchObject({ count: 2, byCurrency: { CNY: { totalPnl: 97 }, USD: { totalPnl: 97.5 } } });
  const report = renderTradeReview(tradeReview, { good: [], issues: [], checklist: [], suggestions: [] });
  expect(report).toMatch(/CNY 1 笔.*总盈亏 97。/u);
  expect(report).toMatch(/USD 1 笔.*总盈亏 97\.5。/u);
  expect((await generatePeriodSummary(host, period, point)).status).toBe("existing");

  await runtime.undoOperation(receipt);
  expect((await generatePeriodSummary(host, period, point)).status).toBe(level === "day" ? "existing" : "saved");
  expect((await saved(level, date))?.properties.metrics).toMatchObject({ tradePnlCny: 0, tradePnlUsd: 97.5 });
  const edited = (await vault.bytes(path)) + "\n虚构手写补充。\n";
  await store.writeFile(path, edited);
  await (await prepareFictionalScreenshot("CNY")).confirm();
  expect((await generatePeriodSummary(host, period, point)).status).toBe("existing");
  expect(await vault.bytes(path)).toBe(edited);
});

it.each(summaryLevels)("does not save a %s summary if a confirmed trade changes its totals during generation", async level => {
  const date = level === "day" ? "2026-10-12" : "2026-10-14";
  const point = new Date(2026, 9, 14, 12), period = summaryPeriod(level, date);
  const screenshot = await prepareFictionalScreenshot("USD");
  ask.mockImplementationOnce(async (messages, options) => {
    await options.beforeTextRequest?.();
    await screenshot.confirm();
    return summaryText(JSON.parse(messages[1].content).period.level);
  });
  await expect(generatePeriodSummary(host, period, point)).rejects.toThrow("交易统计在摘要生成期间有变化");
  expect(await saved(level, date)).toBeUndefined();
  expect((await generatePeriodSummary(host, period, point)).status).toBe("saved");
  expect((await saved(level, date))?.properties.metrics.tradePnlUsd).toBe(97.5);
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

it("starts the same scheduling phase in a replacement store using its own activation date", async () => {
  await startSummarySchedule(host, now(12, 23, 30));
  expect((await saved("day", "2026-11-12"))?.properties.complete).toBe(true);
  const replacement = new LifeOpsStore(host.app, structuredClone(store.settings)) as unknown as StoreHost;
  replacement.settings.folders.aiReports = store.path(store.settings.folders.aiReports, "虚构新摘要库");
  host.store = replacement;
  await tickSummarySchedule(host, now(12, 23, 31));
  const path = replacement.path(replacement.settings.folders.aiReports, "摘要", "调度.json");
  expect(await replacement.readJson(path, null)).toEqual({ version: 1, from: "2026-11-12" });
  const scope = await readSummaryScope(replacement);
  expect((await readSummary(replacement, summaryPeriod("day", "2026-11-12"), scope.hash))?.properties.complete).toBe(true);
  expect(await readSummary(replacement, summaryPeriod("day", "2026-11-11"), scope.hash)).toBeUndefined();
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

it.each([
  { level: "day", from: "2026-11-09", to: "2026-11-10", present: "2026-11-09", missing: "2026-11-10" },
  { level: "week", from: "2026-11-02", to: "2026-11-15", present: "2026-W45", missing: "2026-W46" },
  { level: "month", from: "2026-10-01", to: "2026-11-30", present: "2026-10", missing: "2026-11" }
] as const)("names the missing $level period when a comparison has only one readable summary", async row => {
  const period = summaryPeriod(row.level, row.from);
  const scope = (await readSummaryScope(store)).hash;
  const metrics = { taskCompletionPercent: null, tasksCompleted: 2, energy: null, tradePnlCny: null, tradePnlUsd: null };
  const original = renderSummary(period, period.to, scope, metrics, 1, true, "model", "虚构的可读取摘要。");
  await vault.seed(summaryPath(store, period), original);
  const result = await runtime.executeAiToolCall({ id: "partial-" + row.level, name: "get_summaries",
    arguments: { level: row.level, range: { from: row.from, to: row.to } } }, "kimi");
  expect(result.success).toBe(true);
  expect(JSON.parse(result.output)).toMatchObject({
    summaries: [{ period: row.present }], missingPeriods: [row.missing], coverage: expect.stringContaining("原始记录")
  });
  expect(await vault.bytes(summaryPath(store, period))).toBe(original);
});

it("reports both the read window and missing summaries for a long empty range", async () => {
  const result = await runtime.executeAiToolCall({ id: "long-empty-summary-range", name: "get_summaries",
    arguments: { level: "day", range: { from: "2026-11-01", to: "2026-11-30" } } }, "kimi");
  const output = JSON.parse(result.output);
  expect(output.summaries).toEqual([]);
  expect(output.missingPeriods).toHaveLength(14);
  expect(output.missingPeriods[0]).toBe("2026-11-17");
  expect(output.coverage).toContain("最近 14 个周期");
  expect(output.coverage).toContain("原始记录");
});
