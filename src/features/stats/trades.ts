import { startOfWeek } from "../../date";
import { tradeNumber } from "../trading/pnl";
import type { Trade, TradeCurrency } from "../trading/types";

const currencies: TradeCurrency[] = ["CNY", "USD"];
const currencyNames = { CNY: "人民币", USD: "美元" };
export const TRADE_STAT_GROUPS = ["day", "week", "month", "market", "symbol", "model", "direction"] as const;
export type TradeStatGroup = typeof TRADE_STAT_GROUPS[number];
export interface TradeStatsSettings {
  breakEven?: Partial<Record<TradeCurrency, number>>;
  cnyPerUsd?: number;
}

const stable = (value: number) => Number(value.toPrecision(14));
const sum = (values: readonly number[]) => stable(values.reduce((total, value) => total + value, 0));
const ratio = (top: number, bottom: number) => bottom === 0 ? null : stable(top / bottom);
const pct = (top: number, bottom: number) => bottom === 0 ? null : Math.round(top / bottom * 10_000) / 100;

export function tradeBreakEven(currency: TradeCurrency, configured?: TradeStatsSettings["breakEven"]): number {
  const threshold = configured?.[currency];
  return typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0 ? threshold : currency === "CNY" ? 1 : 0.5;
}

export function tradeStatsDate(trade: Trade): string { return (trade.closedAt ?? trade.openedAt).slice(0, 10); }

function pnlKind(value: number, threshold: number): "win" | "loss" | "flat" {
  return value === 0 || Math.abs(value) < threshold ? "flat" : value > 0 ? "win" : "loss";
}

function closedSequence(trades: readonly Trade[], threshold: number) {
  const closed = trades.filter(trade => trade.closedAt).sort((a, b) => Date.parse(a.closedAt!) - Date.parse(b.closedAt!) || a.id.localeCompare(b.id));
  let balance = 0, peak = 0, drawdown = 0, losing = 0, longest = 0, sequenceCount = 0;
  for (const trade of closed) {
    if (trade.pnl === undefined) { losing = 0; continue; }
    sequenceCount++;
    balance = stable(balance + trade.pnl);
    peak = Math.max(peak, balance);
    drawdown = Math.max(drawdown, stable(peak - balance));
    losing = pnlKind(trade.pnl, threshold) === "loss" ? losing + 1 : 0;
    longest = Math.max(longest, losing);
  }
  return { maxDrawdown: sequenceCount ? drawdown : null, longestLosingStreak: sequenceCount ? longest : null,
    closedSequenceCount: sequenceCount, excludedFromClosedSequenceCount: trades.length - sequenceCount };
}

function currencyStats(trades: readonly Trade[], threshold: number) {
  const known = trades.flatMap(trade => trade.pnl === undefined ? [] : [trade.pnl]);
  const wins = known.filter(value => pnlKind(value, threshold) === "win");
  const losses = known.filter(value => pnlKind(value, threshold) === "loss");
  const grossProfit = sum(wins), grossLoss = sum(losses);
  const avgProfit = ratio(grossProfit, wins.length), avgLoss = ratio(grossLoss, losses.length);
  const net = sum(known);
  const risk = trades.flatMap(trade => trade.rMultiple === undefined ? [] : [trade.rMultiple]);
  const modeled = trades.filter(trade => trade.modelId || trade.modelVersionId);
  const compliant = modeled.filter(trade => trade.ruleCheckStatus === "checked" && !trade.ruleViolations.length).length;
  const knownPlan = trades.filter(trade => trade.planned !== null);
  const outOfPlan = knownPlan.filter(trade => !trade.planned).length;
  return {
    count: trades.length, knownPnlCount: known.length, unknownPnlCount: trades.length - known.length,
    winCount: wins.length, lossCount: losses.length, flatCount: known.length - wins.length - losses.length,
    breakEvenThreshold: threshold, winPercent: pct(wins.length, wins.length + losses.length),
    totalPnl: known.length || !trades.length ? net : null, averageWin: avgProfit, averageLoss: avgLoss,
    payoffRatio: avgProfit === null || avgLoss === null ? null : ratio(avgProfit, -avgLoss),
    profitFactor: ratio(grossProfit, -grossLoss), expectancy: ratio(net, known.length), averageR: ratio(sum(risk), risk.length),
    modelCount: modeled.length, ruleAdherencePercent: pct(compliant, modeled.length),
    violationCount: modeled.filter(trade => trade.ruleViolations.length).length,
    unverifiedRuleCount: modeled.filter(trade => trade.ruleCheckStatus !== "checked" && !trade.ruleViolations.length).length,
    outOfPlanCount: outOfPlan, outOfPlanPercent: pct(outOfPlan, knownPlan.length), unknownPlanCount: trades.length - knownPlan.length,
    ...closedSequence(trades, threshold)
  };
}

function groupKey(trade: Trade, group: TradeStatGroup): string {
  const date = tradeStatsDate(trade);
  switch (group) {
    case "day": return date;
    case "week": return startOfWeek(date);
    case "month": return date.slice(0, 7);
    case "market": return trade.market;
    case "symbol": return trade.symbol.toUpperCase();
    case "model": return trade.modelId || trade.modelVersionId || "未指定";
    case "direction": return trade.direction;
  }
}

export function tradeStats(trades: readonly Trade[], range: { from: string; to: string }, group?: TradeStatGroup,
  settings: TradeStatsSettings = {}, combineUsd = false) {
  if (group && !TRADE_STAT_GROUPS.includes(group)) throw new Error("交易统计分组无效。");
  const filtered = trades.filter(trade => { const date = tradeStatsDate(trade); return date >= range.from && date <= range.to; });
  const by = (records: readonly Trade[]) => {
    const statsFor = (currency: TradeCurrency) => currencyStats(records.filter(trade => trade.currency === currency), tradeBreakEven(currency, settings.breakEven));
    return { CNY: statsFor("CNY"), USD: statsFor("USD") };
  };
  const byCurrency = by(filtered);
  const groups = new Map<string, Trade[]>();
  if (group) for (const trade of filtered) {
    const key = groupKey(trade, group);
    const items = groups.get(key);
    if (items) items.push(trade);
    else groups.set(key, [trade]);
  }
  const cnyPerUsd = settings.cnyPerUsd;
  if (combineUsd && !(typeof cnyPerUsd === "number" && Number.isFinite(cnyPerUsd) && cnyPerUsd > 0)) {
    throw new Error("请先设置手动汇率，即 1 USD 等于多少 CNY。");
  }
  const known = byCurrency.CNY.knownPnlCount + byCurrency.USD.knownPnlCount;
  return { count: filtered.length, dateBasis: "按平仓日期归组，平仓日期不明时用开仓日期",
    byCurrency, ...(group ? { groupBy: group, groups: [...groups.keys()].sort().map(key => ({ key, byCurrency: by(groups.get(key)!) })) } : {}),
    ...(combineUsd ? { convertedUsd: { totalPnl: known || !filtered.length
      ? stable((byCurrency.CNY.totalPnl ?? 0) / cnyPerUsd! + (byCurrency.USD.totalPnl ?? 0)) : null,
      cnyPerUsd, rateLabel: `1 USD = ${cnyPerUsd} CNY`, unknownPnlCount: filtered.length - known } } : {}) };
}

export function formatMarketWinRates(output: string): string | undefined {
  const data = JSON.parse(output) as { domain: string; groupBy: string; range: { from: string; to: string }; scope?: string;
    groups?: Array<{ key: string; byCurrency: Record<TradeCurrency, Pick<ReturnType<typeof currencyStats>, "count" | "winPercent" | "winCount" | "lossCount">> }> };
  if (data.domain !== "trades" || data.groupBy !== "market" || !Array.isArray(data.groups)) return;
  const lines = data.groups.map(({ key, byCurrency }) => {
    const present = currencies.filter(currency => byCurrency[currency]?.count > 0);
    const results = present.map(currency => {
      const { winPercent, winCount, lossCount } = byCurrency[currency];
      const result = winPercent === null ? "暂无可计算胜率" : `${winPercent}%（盈利 ${winCount} 笔，亏损 ${lossCount} 笔）`;
      return present.length > 1 ? `${currencyNames[currency]} ${result}` : result;
    });
    return `${key}：${results.join("，")}`;
  });
  const { from, to } = data.range;
  return [`${from} 至 ${to}，胜率按盈利笔数除以盈利与亏损笔数，持平不计。`,
    ...(lines.length ? lines : ["这段时间暂无交易记录。"]), ...(data.scope ? ["只统计允许读取的记录。"] : [])].join("\n");
}

interface ModelPnlGroup {
  key: string;
  label?: string;
  byCurrency: Record<TradeCurrency, { knownPnlCount: number; totalPnl: number | null }>;
}

export function formatTradeModelLeaders(groups: readonly ModelPnlGroup[], range: { from: string; to: string }, partial: boolean): string {
  const lines = currencies.map(currency => {
    const eligible = groups.flatMap(group => {
      const { knownPnlCount, totalPnl } = group.byCurrency[currency];
      return group.key === "未指定" || knownPnlCount === 0 || totalPnl === null ? [] : [{ name: group.label ?? group.key, totalPnl }];
    });
    if (!eligible.length) return `${currencyNames[currency]}没有带净盈亏的模型记录。`;
    const best = eligible.reduce((maximum, group) => Math.max(maximum, group.totalPnl), -Infinity);
    const leaders = eligible.filter(group => group.totalPnl === best).map(group => `「${group.name}」`);
    return `${currencyNames[currency]}${leaders.join("、")}${leaders.length === 1 ? "排名第一" : "并列第一"}，净盈亏 ${tradeNumber(best)} ${currency}。`;
  });
  return `${range.from} 至 ${range.to} 的模型净盈亏排名\n\n${lines.join("\n")}${partial ? "\n仅统计允许读取的交易记录。" : ""}`;
}
