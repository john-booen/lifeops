import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { FactOperationOptions } from "../src/dataFoundation/factOperation";
import type { TradeCsvTemplate } from "../src/features/trading/csvImport";
import type { TradeDraft } from "../src/features/trading/types";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}));
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { DiskVault } = await import("./helpers/diskVault");
const { readTradeDatabase, recordTradeDrafts, tradeDatabasePath } = await import("../src/features/trading/persistence");
const { readTradeCsv, previewTradeCsv, confirmTradeCsv } = await import("../src/features/trading/csvImport");
const { confirmTradeBackfill, listTradeBackfillNotes, previewTradeBackfill, scanTradeBackfill } = await import("../src/features/trading/backfill");

const folder = DEFAULT_SETTINGS.folders.tradingReviews;
const database = tradeDatabasePath(DEFAULT_SETTINGS.folders);
const mirror = (date: string) => `${folder}/LifeOps交易/${date}.md`;
const priorNote = `${folder}/2026/11月/2026-11-07.md`;
const original = "# 虚构手写交易复盘\n这段原文保留。\n";
const now = new Date("2026-11-08T12:00:00+08:00");
const long: TradeDraft = {
  openedAt: "2026-11-07T00:20:00+08:00", closedAt: "2026-11-07T01:20:00+08:00", market: "A股",
  symbol: "虚构标的", direction: "long", entry: 10, exit: 12, qty: 2, qtyUnit: "股", fees: 1,
  riskAmount: 1.5, notes: "一列 | 两行\n测试", source: { kind: "form" }
};
const short: TradeDraft = {
  openedAt: "2026-11-08T10:00:00+08:00", market: "期货", currency: "CNY", symbol: "IF",
  direction: "short", entry: 5000, exit: 4998, qty: 3, fees: 5, pnl: 2000, source: { kind: "chat" }
};

let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-trades-"));
  vault = new DiskVault(root);
  const settings = { ...structuredClone(DEFAULT_SETTINGS), tradingContractMultipliers: { IF: 300 } };
  store = new LifeOpsStore({ vault } as unknown as App, settings) as unknown as StoreHost;
  runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  await vault.seed(priorNote, original);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function save(drafts: TradeDraft[], operationId?: string) {
  return runtime.executeLocalOperation("local_record_trades", { drafts }, scope => recordTradeDrafts(scope, drafts, now), operationId);
}

const localHost = {
  async saveLocalOperation(name: string, args: Record<string, unknown>, run: (scope: StoreHost) => Promise<unknown>, options?: FactOperationOptions) {
    const result = await runtime.executeLocalOperation(name, args, run, undefined, options);
    if (!result.success) throw new Error(result.output);
  },
  refreshViews: async () => undefined
};

it("saves and undoes the structured rows and both daily mirrors as one recorded operation", async () => {
  expect((await readTradeDatabase(store)).trades).toEqual([]);
  expect(store.getFile(database)).toBeNull();
  const result = await save([long, short]);
  expect(result.success, result.output).toBe(true);
  const actual = (await readTradeDatabase(store)).trades;
  expect(actual).toMatchObject([
    { currency: "CNY", pnl: 3, pnlSource: "computed", rMultiple: 2, planned: null, ruleViolations: [], attachments: [] },
    { currency: "CNY", pnl: 2000, pnlSource: "stated", pnlMismatch: true }
  ]);
  expect(actual[0].id).toMatch(/^trade-\d+-/);
  expect(actual[0].id).not.toBe(actual[1].id);
  expect(await vault.bytes(mirror("2026-11-07"))).toContain("一列 \\| 两行 测试");
  expect(await vault.bytes(mirror("2026-11-08"))).toContain("2000 CNY");
  expect(await vault.bytes(priorNote)).toBe(original);
  await runtime.undoOperation(result.callId);
  expect(store.getFile(database)).toBeNull();
  expect(store.getFile(mirror("2026-11-07"))).toBeNull();
  expect(store.getFile(mirror("2026-11-08"))).toBeNull();
  expect(await vault.bytes(priorNote)).toBe(original);
});

it("preserves every file on a failed mirror write", async () => {
  const initial = await save([long]);
  expect(initial.success, initial.output).toBe(true);
  const before = await vault.bytes(database);
  const firstMirror = await vault.bytes(mirror("2026-11-07"));
  const create = vault.create.bind(vault);
  vi.spyOn(vault, "create").mockImplementation(async (path, raw) => {
    if (path === mirror("2026-11-08")) throw new Error("虚构写入失败");
    return create(path, raw);
  });
  const failed = await save([{ ...long, symbol: "虚构第二笔" }, short]);
  expect(failed.success).toBe(false);
  expect(await vault.bytes(database)).toBe(before);
  expect(await vault.bytes(mirror("2026-11-07"))).toBe(firstMirror);
  expect(store.getFile(mirror("2026-11-08"))).toBeNull();
});

it("does not read edits to a generated mirror into the database or overwrite an original note", async () => {
  const initial = await save([long]);
  expect(initial.success, initial.output).toBe(true);
  const mirrorPath = mirror("2026-11-07");
  await vault.seed(mirrorPath, (await vault.bytes(mirrorPath)).replace("3 CNY", "99999 CNY"));
  expect((await readTradeDatabase(store)).trades[0].pnl).toBe(3);
  const next = await save([{ ...long, symbol: "另一个虚构标的" }]);
  expect(next.success, next.output).toBe(true);
  expect(await vault.bytes(mirrorPath)).not.toContain("99999 CNY");
  await vault.seed(mirror("2026-11-08"), original);
  const before = await vault.bytes(database);
  const conflict = await save([short]);
  expect(conflict.success).toBe(false);
  expect(await vault.bytes(database)).toBe(before);
  expect(await vault.bytes(mirror("2026-11-08"))).toBe(original);
});

it("checks time zones, unsupported versions and futures currency before saving any rows", async () => {
  for (const invalid of [{ ...long, openedAt: "2026-11-07T00:20:00" }, { ...long, openedAt: "2026-02-30T09:00+08:00" },
    { ...long, attachments: ["../外部.png"] }, { ...short, currency: undefined }, { ...long, qty: 0 }]) {
    expect((await save([long, invalid])).success).toBe(false);
    expect(store.getFile(database)).toBeNull();
  }
  await expect(recordTradeDrafts(store, [long], now)).rejects.toThrow("受保护");
  const unsupported = '{"version":2,"trades":[]}\n';
  await vault.seed(database, unsupported);
  expect((await save([long])).success).toBe(false);
  expect(await vault.bytes(database)).toBe(unsupported);
});

it("serializes concurrent saves and reuses the existing operation receipt on a retry", async () => {
  const [first, second] = await Promise.all([save([long], "local:trade:one"), save([short], "local:trade:two")]);
  expect(first.success, first.output).toBe(true);
  expect(second.success, second.output).toBe(true);
  expect((await save([long], "local:trade:one")).success).toBe(true);
  expect((await readTradeDatabase(store)).trades.map(trade => trade.symbol).sort()).toEqual(["IF", "虚构标的"]);
});

it("retains an unstructured capture separately from both the original review and the trade database", async () => {
  const raw = "虚构交易原话，未说明品种。";
  const result = await runtime.executeLocalOperation("local_recordClassifiedInput", { raw }, scope => scope.recordClassifiedInput({
    kind: "trade", confidence: 1, date: "2026-11-07", title: raw, raw, content: raw, reason: "虚构快速记录"
  }));
  expect(result.success, result.output).toBe(true);
  expect(await vault.bytes(`${DEFAULT_SETTINGS.folders.inbox}/待确认.md`)).toContain(raw);
  expect(await vault.bytes(priorNote)).toBe(original);
  expect(store.getFile(database)).toBeNull();
});

it("records a chat trade when the model supplies only a date for closing", async () => {
  const result = await runtime.executeAiToolCall({ id: "fictional-date-only-trade", name: "record_trade", arguments: { trades: [{
    market: "A股", symbol: "ZTEST1", direction: "long", qty: 10, entry: 20, exit: 22, fees: 1, pnl: 19,
    openedAt: "2026-11-12", closedAt: "2026-11-12"
  }] } }, "kimi", "2026-11-12 的虚构品种 ZTEST1，做多 10 股，开仓 20，平仓 22，手续费 1 元。");
  expect(result.success, result.output).toBe(true);
  expect((await readTradeDatabase(store)).trades).toMatchObject([{ symbol: "ZTEST1", openedAtPrecision: "date", pnl: 19, pnlSource: "computed" }]);
  expect((await readTradeDatabase(store)).trades[0].closedAt).toBeUndefined();
});

it("uses the real trade count for daily goals, undo and the 21:00 compensation check", async () => {
  await store.initializeVault();
  const habit = await store.createHabit({ name: "虚构每日交易", source: "trades", startDate: "2026-11-07", frequencyUnit: "day",
    frequencyInterval: 1, targetCount: 1, target: { kind: "number", unit: "笔", perDay: 2 },
    punishment: { enabled: true, rules: [{ kind: "reflection", minChars: 100 }] } });
  const goal = async () => (await store.getTaskDashboard("2026-11-07")).habits.find(item => item.habit.id === habit.id);
  expect((await save([long])).success).toBe(true);
  expect(await goal()).toMatchObject({ periodDone: 1, periodTarget: 2, periodUnit: "笔", status: "pending", streak: 0 });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(now);
    const stats = await runtime.executeAiToolCall({ name: "get_stats", arguments: { domain: "habits",
      range: { from: "2026-11-07", to: "2026-11-07" } } }, "kimi");
    expect(JSON.parse(stats.output)).toMatchObject({ habits: [{ id: habit.id,
      dailyTradeGoal: { target: 2, actual: 1, remaining: 1, status: "pending" } }] });
  } finally { vi.useRealTimers(); }
  await expect(store.recordHabitStatus(habit.id, "done", "2026-11-07", "", 20, "笔")).rejects.toThrow("自动计算");
  const second = await save([{ ...long, symbol: "第二笔虚构交易" }]);
  expect(second.success, second.output).toBe(true);
  expect(await goal()).toMatchObject({ periodDone: 2, status: "done", streak: 1 });
  const check = (hour: number) => runtime.executeLocalOperation("check_trade_goal", { hour }, scope => scope.checkPunishments(new Date(2026, 10, 7, hour)));
  expect((await check(21)).success).toBe(true);
  expect((await store.readTaskDb()).tasks).toEqual([]);
  await runtime.undoOperation(second.callId);
  expect(await goal()).toMatchObject({ periodDone: 1, status: "pending" });
  expect((await check(20)).success).toBe(true);
  expect((await store.readTaskDb()).tasks).toEqual([]);
  expect((await check(21)).success).toBe(true);
  expect((await check(21)).success).toBe(true);
  expect((await store.readTaskDb()).tasks).toMatchObject([{ category: "punishment", dueDate: "2026-11-08",
    habitPunishment: { habitId: habit.id, judgedDate: "2026-11-07" } }]);
  expect((await store.readHabitDb()).checkins).toEqual([]);
});

it("keeps missing trade data unknown and prevents automatic penalties against corrupted or excluded data", async () => {
  await store.initializeVault();
  const habit = await store.createHabit({ name: "虚构交易目标", source: "trades", startDate: "2026-11-07", frequencyUnit: "day",
    frequencyInterval: 1, targetCount: 1, target: { kind: "number", unit: "笔", perDay: 2 },
    punishment: { enabled: true, rules: [{ kind: "reflection", minChars: 100 }] } });
  await vault.seed(database, "{damaged");
  expect((await store.getTaskDashboard("2026-11-07")).habits.find(item => item.habit.id === habit.id)).toMatchObject({ periodUnavailable: true });
  const result = await runtime.executeLocalOperation("check_unknown_trade_goal", {}, scope => scope.checkPunishments(new Date(2026, 10, 7, 21)));
  expect(result.success, result.output).toBe(true);
  expect((await store.readTaskDb()).tasks).toEqual([]);
  expect(await vault.bytes(database)).toBe("{damaged");
  store.settings.privacy!.excludedVaultPrefixes = [database];
  const stats = await runtime.executeAiToolCall({ name: "get_stats", arguments: { domain: "habits", range: "today" } }, "kimi");
  expect(JSON.parse(stats.output)).toMatchObject({ habits: [], tradeGoals: "交易记录暂不可用，交易目标进度未知" });
});

it("returns calculated trade metrics through the tool and respects protected records", async () => {
  const usd: TradeDraft = { ...short, market: "美股", currency: "USD", symbol: "US-TEST", pnl: 5, source: { kind: "backfill", ref: priorNote } };
  expect((await save([long, usd])).success).toBe(true);
  const query = () => runtime.executeAiToolCall({ name: "get_stats", arguments: { domain: "trades", groupBy: "market",
    range: { from: "2026-11-07", to: "2026-11-08" } } }, "kimi");
  const first = await query();
  expect(first.success, first.output).toBe(true);
  expect(JSON.parse(first.output)).toMatchObject({ count: 2, byCurrency: { CNY: { totalPnl: 3 }, USD: { totalPnl: 5 } } });
  store.settings.privacy!.excludedVaultPrefixes = [priorNote];
  expect(JSON.parse((await query()).output)).toMatchObject({ count: 1, scope: "只统计允许读取的记录" });
  store.settings.privacy!.excludedVaultPrefixes = [database];
  expect((await query()).success).toBe(false);
});

const csvTemplate: TradeCsvTemplate = { name: "虚构模板", market: "A股", columns: {
  openedAt: "时间", symbol: "品种", direction: "方向", qty: "数量", entry: "开仓价", exit: "平仓价", fees: "费用", pnl: "净盈亏", currency: "币种", notes: "备注"
} };
const csvHeader = "时间,品种,方向,数量,开仓价,平仓价,费用,净盈亏,币种,备注";

it("previews UTF-8 CSV, mapped numbers, alternate directions and the exact one-minute duplicate boundary", () => {
  const input = [csvHeader,
    '2026-11-07T09:00:00+08:00,ABC,买入,2,"1,000",1002,1,,人民币,"有逗号, 并有\n换行和""引号"""',
    "2026-11-07T01:01:00Z,abc,BUY,2,1000,1002,1,,CNY,",
    "2026-11-07T09:01:01+08:00,ABC,Long,2,1000,1002,1,,RMB,",
    "2026-11-07T09:00:30+08:00,ABC,S,2,1000,1002,1,(5),USD,",
    "2026-11-07T09:00:30+08:00,ABC,多,3,1000,1002,1,,CNY,",
    "2026-11-07T09:00:30+08:00,ABC,HOLD,2,1000,1002,1,,CNY,",
    "2026-11-07,ABC,多头,2,1000,1002,1,,CNY,",
    "2026-11-07T09:00:30+08:00,XYZ,买开,,1000,1002,1,,CNY,",
    "2026-11-07T09:00:30+08:00,XYZ,买开,,1000,1002,1,,CNY,"
  ].join("\r\n");
  const table = readTradeCsv("\ufeff" + input, "虚构.csv");
  expect(table.rows).toHaveLength(9);
  expect(table.rows[0].at(-1)).toBe('有逗号, 并有\n换行和"引号"');
  const preview = previewTradeCsv(table, csvTemplate, []);
  expect(preview).toMatchObject({ ready: 7, duplicates: 1, invalid: 1 });
  expect(preview.rows[0]).toMatchObject({ kind: "ready", currency: "CNY", pnl: 3, pnlSource: "computed" });
  expect(preview.rows[1]).toMatchObject({ kind: "duplicate", line: 3 });
  expect(preview.rows[3]).toMatchObject({ kind: "ready", currency: "USD", pnl: -5, pnlSource: "stated", draft: { direction: "short" } });
  expect(preview.rows[6]).toMatchObject({ kind: "ready", draft: { openedAtPrecision: "date" } });
  expect(() => readTradeCsv('时间,品种\n2026-11-07,"未闭合', "坏.csv")).toThrow("未闭合");
  expect(() => previewTradeCsv(table, { ...csvTemplate, columns: { ...csvTemplate.columns, qty: "旧列" } }, [])).toThrow("缺少模板使用的列");
});

it("imports only the confirmed CSV preview, checks concurrent duplicates, and undoes the complete batch", async () => {
  const input = [csvHeader,
    "2026-11-07T09:00:00+08:00,ABC,买,2,10,12,1,,CNY,",
    "2026-11-07T09:00:30+08:00,ABC,买,2,10,12,1,,CNY,",
    "2026-11-08T10:00:00+08:00,DEF,空,1,20,19,0,1,USD,",
    "2026-11-08T10:00:00+08:00,DEF,空,坏数据,20,19,0,1,USD,"
  ].join("\n");
  const table = readTradeCsv(input, "虚构.csv");
  const preview = previewTradeCsv(table, csvTemplate, []);
  expect(preview).toMatchObject({ ready: 2, duplicates: 1, invalid: 1 });
  expect(store.getFile(database)).toBeNull();
  const first = await save([{ ...long, openedAt: "2026-11-07T09:00:01+08:00", closedAt: undefined, symbol: "ABC" }]);
  expect(first.success).toBe(true);
  await expect(confirmTradeCsv(localHost, table, csvTemplate, preview)).rejects.toThrow("重新预览");
  expect((await readTradeDatabase(store)).trades).toHaveLength(1);
  const current = previewTradeCsv(table, csvTemplate, (await readTradeDatabase(store)).trades);
  expect(current).toMatchObject({ ready: 1, duplicates: 2, invalid: 1 });
  expect(await confirmTradeCsv(localHost, table, csvTemplate, current)).toBe(1);
  expect((await readTradeDatabase(store)).trades).toMatchObject([{ symbol: "ABC" }, { symbol: "DEF", source: { kind: "csv", ref: "虚构.csv" } }]);
  await runtime.undoLatestOperation();
  expect((await readTradeDatabase(store)).trades).toHaveLength(1);
  expect(store.getFile(mirror("2026-11-08"))).toBeNull();
});

it("scans only allowed local notes, reports unsupported rows, and confirms separately by month", async () => {
  Object.assign(vault, { adapter: { getBasePath: () => root } });
  const october = folder + "/2026-10-08.md", november = folder + "/2026-11-09.md";
  const other = folder + "/无交易的计划.md", excluded = folder + "/排除.md", linked = folder + "/链接.md";
  const model = DEFAULT_SETTINGS.folders.tradingModels + "/计划.md";
  const octoberQuote = "A股 OCT8 做多，数量 2 股，开仓 10，平仓 12，手续费 1。";
  const novemberQuote = "美股 NOV9 空单，2026-11-09T09:10:00-05:00 开仓，1 股，开仓 20，平仓 18。";
  await vault.seed(october, "# 虚构十月\n" + octoberQuote);
  await vault.seed(november, "# 虚构十一月\n" + novemberQuote);
  await vault.seed(other, "虚构计划，没有实际成交。");
  await vault.seed(excluded, "应被过滤的虚构笔记。");
  await vault.seed(model, "不属于回填范围的虚构模型。");
  await vault.seed(mirror("2026-11-08"), "生成目录中的虚构数据。");
  await symlink(vault.diskPath(model), vault.diskPath(linked));
  store.settings.privacy!.excludedVaultPrefixes = [excluded];
  const paths = listTradeBackfillNotes(store);
  expect(paths).toEqual([october, priorNote, november, other, linked].sort());
  const analyze = vi.fn(async (text: string, date?: string) => {
    if (text.includes(octoberQuote)) return JSON.stringify({ kind: "trade", trades: [
      { quote: octoberQuote, openedAt: date, symbol: "OCT8", market: "A股", direction: "long", qty: 2, qtyUnit: "股", entry: 10, exit: 12, fees: 1 },
      { quote: octoberQuote, openedAt: date, symbol: "OCT8", market: "A股", direction: "long", qty: 2000 }
    ] });
    if (text.includes(novemberQuote)) return JSON.stringify({ kind: "trade", trades: [
      { quote: novemberQuote, openedAt: "2026-11-09T09:10:00-05:00", symbol: "NOV9", market: "美股", direction: "short", qty: 1, entry: 20, exit: 18 }
    ] });
    return JSON.stringify({ kind: "other", trades: [] });
  });
  const request = new AbortController();
  const scan = await scanTradeBackfill(store, [...paths, excluded, model, mirror("2026-11-08")], analyze, request.signal);
  expect(analyze).toHaveBeenCalledTimes(4);
  expect(scan).toMatchObject({ examined: 5, unparsed: [october, linked], candidates: [{ draft: { symbol: "OCT8" } }, { draft: { symbol: "NOV9" } }] });
  expect(store.getFile(database)).toBeNull();
  const pending = previewTradeBackfill(scan, "2026-10", []);
  expect(await confirmTradeBackfill(localHost, store, scan, pending)).toBe(1);
  const first = (await readTradeDatabase(store)).trades;
  expect(first).toMatchObject([{ symbol: "OCT8", openedAtPrecision: "date", pnl: 3, source: { kind: "backfill", ref: october } }]);
  const rerun = await scanTradeBackfill(store, [october], analyze, request.signal);
  expect(previewTradeBackfill(rerun, "2026-10", first)).toMatchObject({ candidates: [], duplicates: 1 });
  await expect(confirmTradeBackfill(localHost, store, scan, pending)).rejects.toThrow("重新预览");
  expect(await confirmTradeBackfill(localHost, store, scan, previewTradeBackfill(scan, "2026-11", first))).toBe(1);
  expect((await readTradeDatabase(store)).trades).toHaveLength(2);
  await runtime.undoLatestOperation();
  expect((await readTradeDatabase(store)).trades).toEqual(first);
  expect(await vault.bytes(october)).toBe("# 虚构十月\n" + octoberQuote);
  expect(await vault.bytes(november)).toBe("# 虚构十一月\n" + novemberQuote);
});

it("rejects a changed note and stops a cancelled scan before reading a second note", async () => {
  Object.assign(vault, { adapter: { getBasePath: () => root } });
  const source = folder + "/2026-09-08.md";
  const quote = "外汇 EURUSD 做空，开仓 1.1，平仓 1.08。";
  await vault.seed(source, quote);
  const request = new AbortController();
  const result = JSON.stringify({ kind: "trade", trades: [{ quote, openedAt: "2026-09-08", market: "外汇", direction: "short", symbol: "EURUSD", entry: 1.1, exit: 1.08 }] });
  const cancelled = vi.fn(async () => { request.abort(); return result; });
  await expect(scanTradeBackfill(store, [source, priorNote], cancelled, request.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(cancelled).toHaveBeenCalledTimes(1);
  const scan = await scanTradeBackfill(store, [source], async () => result, new AbortController().signal);
  const preview = previewTradeBackfill(scan, "2026-09", []);
  expect(preview.candidates).toHaveLength(1);
  await vault.seed(source, quote + "\n已更新原笔记。");
  await expect(confirmTradeBackfill(localHost, store, scan, preview)).rejects.toThrow("重新扫描");
  expect(store.getFile(database)).toBeNull();
});
