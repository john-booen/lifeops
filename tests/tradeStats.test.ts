import { expect, it } from "vitest";
import { tradeStats, TRADE_STAT_GROUPS } from "../src/features/stats/trades";
import type { Trade, TradeCurrency } from "../src/features/trading/types";

const range = { from: "2026-01-01", to: "2026-02-28" };
const china = [100, -30, 50, -20, -10, 0.5, -0.5, 40, undefined, -20];
const america = [10, -4, 5, -2, -3, 0.25, -0.25, 20, 1, -1];

function sample(currency: TradeCurrency, pnl: number | undefined, index: number): Trade {
  const day = currency === "USD" && index >= 8 ? `2026-02-0${index - 7}` : `2026-01-${String(index + 1).padStart(2, "0")}`;
  const openedAt = `${day}T09:00:00+08:00`, closedAt = `${day}T10:00:00+08:00`;
  return { id: `${currency}-${index}`, openedAt, closedAt, currency, pnl,
    market: currency === "CNY" ? "A股" : "美股", symbol: currency === "CNY" ? "CN-TEST" : "US-TEST",
    direction: index % 2 ? "short" : "long", pnlSource: pnl === undefined ? "unknown" : "stated",
    rMultiple: currency === "CNY" ? [1, -0.5, 2][index] : undefined,
    planned: index < 3 ? false : index < 8 ? true : null,
    modelId: index < 6 ? "fictional-model" : undefined,
    ruleCheckStatus: index < 6 ? [3, 4].includes(index) ? "insufficient" : "checked" : undefined,
    ruleViolations: index === 1 ? ["fictional-rule"] : [], attachments: [], source: { kind: "form" },
    createdAt: openedAt, updatedAt: closedAt };
}

const twenty = [...china.map((pnl, i) => sample("CNY", pnl, i)), ...america.map((pnl, i) => sample("USD", pnl, i))];

it("matches a hand-calculated twenty-trade example with independent currency balances", () => {
  const result = tradeStats([...twenty].reverse(), range);
  expect(result.count).toBe(20);
  const { CNY, USD } = result.byCurrency;
  expect(CNY).toMatchObject({ count: 10, knownPnlCount: 9, unknownPnlCount: 1, winCount: 3, lossCount: 4, flatCount: 2,
    winPercent: 42.86, totalPnl: 110, averageLoss: -20, profitFactor: 2.375, maxDrawdown: 30, longestLosingStreak: 2,
    closedSequenceCount: 9, excludedFromClosedSequenceCount: 1, modelCount: 6, ruleAdherencePercent: 50,
    violationCount: 1, unverifiedRuleCount: 2, outOfPlanCount: 3, outOfPlanPercent: 37.5, unknownPlanCount: 2 });
  expect(CNY.averageWin).toBeCloseTo(190 / 3);
  expect(CNY.payoffRatio).toBeCloseTo(190 / 3 / 20);
  expect(CNY.expectancy).toBeCloseTo(110 / 9);
  expect(CNY.averageR).toBeCloseTo(2.5 / 3);
  expect(USD).toMatchObject({ count: 10, winCount: 4, lossCount: 4, flatCount: 2, winPercent: 50, totalPnl: 26,
    averageWin: 9, averageLoss: -2.5, payoffRatio: 3.6, profitFactor: 3.6, expectancy: 2.6,
    averageR: null, maxDrawdown: 5, longestLosingStreak: 2, ruleAdherencePercent: 50, outOfPlanPercent: 37.5 });
  expect(result.convertedUsd).toBeUndefined();
});

it("groups by each planned dimension and uses closing dates across months", () => {
  const crossMonth = { ...twenty[18], openedAt: "2026-01-31T09:00:00+08:00" };
  const trades = [...twenty.slice(0, 18), crossMonth, twenty[19]];
  for (const group of TRADE_STAT_GROUPS) {
    const result = tradeStats(trades, range, group);
    expect(result.groups!.reduce((total, row) => total + row.byCurrency.CNY.count + row.byCurrency.USD.count, 0)).toBe(20);
  }
  const monthly = tradeStats(trades, range, "month");
  expect(monthly.groups).toMatchObject([
    { key: "2026-01", byCurrency: { CNY: { count: 10, totalPnl: 110 }, USD: { count: 8, totalPnl: 26 } } },
    { key: "2026-02", byCurrency: { CNY: { count: 0 }, USD: { count: 2, totalPnl: 0 } } }
  ]);
  const february = tradeStats(trades, { from: "2026-02-01", to: "2026-02-28" });
  expect(february.count).toBe(2);
});

it("separates no data, unknown pnl, wins without losses and a configured USD conversion", () => {
  expect(tradeStats([], range).byCurrency.USD).toMatchObject({ count: 0, totalPnl: 0, winPercent: null, maxDrawdown: null, profitFactor: null });
  expect(tradeStats([sample("USD", undefined, 0)], range).byCurrency.USD).toMatchObject({ count: 1, unknownPnlCount: 1, totalPnl: null });
  expect(tradeStats([sample("USD", 5, 0)], range).byCurrency.USD).toMatchObject({ winPercent: 100, averageLoss: null,
    profitFactor: null, payoffRatio: null, maxDrawdown: 0, longestLosingStreak: 0 });
  expect(tradeStats([{ ...sample("USD", 5, 0), closedAt: undefined }], range).byCurrency.USD).toMatchObject({ totalPnl: 5,
    maxDrawdown: null, longestLosingStreak: null, excludedFromClosedSequenceCount: 1 });
  expect(tradeStats(twenty, range, undefined, { breakEven: { CNY: 0.5 } }).byCurrency.CNY).toMatchObject({ winCount: 4, lossCount: 5, flatCount: 0 });
  expect(() => tradeStats(twenty, range, undefined, {}, true)).toThrow("手动汇率");
  expect(tradeStats(twenty, range, undefined, { cnyPerUsd: 5 }, true).convertedUsd).toEqual({ totalPnl: 48, cnyPerUsd: 5,
    rateLabel: "1 USD = 5 CNY", unknownPnlCount: 1 });
});
