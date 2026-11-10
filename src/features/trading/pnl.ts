import type { Trade, TradeDraft } from "./types";

type TradePrices = Pick<TradeDraft, "direction" | "entry" | "exit" | "qty" | "fees" | "pnl" | "riskAmount">;
type TradeResult = Pick<Trade, "pnl" | "pnlSource" | "pnlMismatch" | "rMultiple">;

export function tradePnl(input: TradePrices, multiplier = 1): TradeResult {
  const { direction, entry, exit, qty, fees = 0, pnl: stated, riskAmount } = input;
  const computed = entry === undefined || exit === undefined || qty === undefined ? undefined
    : (direction === "long" ? exit - entry : entry - exit) * qty * multiplier - fees;
  const pnl = stated ?? computed;
  const pnlSource = stated !== undefined ? "stated" : computed !== undefined ? "computed" : "unknown";
  const pnlMismatch = stated !== undefined && computed !== undefined
    && (computed === 0 ? stated !== 0 : Math.abs(stated - computed) / Math.abs(computed) > 0.05 + Number.EPSILON);
  const rMultiple = pnl === undefined || riskAmount === undefined ? undefined : pnl / riskAmount;
  if ((computed !== undefined && !Number.isFinite(computed)) || (rMultiple !== undefined && !Number.isFinite(rMultiple))) {
    throw new Error("计算后的盈亏或 R 超出范围，请核对数字。");
  }
  return { pnl, pnlSource, ...(pnlMismatch ? { pnlMismatch } : {}), rMultiple };
}

export function parseTradeMultipliers(input: string): Record<string, number> {
  const entries: [string, number][] = [];
  for (const line of input.split(/\r?\n/)) {
    const [rawSymbol, rawValue, extra] = line.split(/[=＝]/);
    const symbol = rawSymbol.trim().toUpperCase();
    const value = Number(rawValue);
    if (symbol && extra === undefined && Number.isFinite(value) && value > 0) entries.push([symbol, value]);
  }
  return Object.fromEntries(entries);
}

export function tradeMultiplier(symbol: string, multipliers?: Record<string, number>): number {
  const key = symbol.trim().toUpperCase();
  const value = multipliers && Object.hasOwn(multipliers, key) ? multipliers[key] : 1;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

export function tradeNumber(value: number): string { return Number(value.toPrecision(12)).toString(); }
