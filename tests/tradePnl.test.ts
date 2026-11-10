import { expect, it } from "vitest";
import { parseTradeMultipliers, tradeMultiplier, tradePnl } from "../src/features/trading/pnl";

it("computes long and short results with quantities, fees, contract multipliers and risk", () => {
  expect(tradePnl({ direction: "long", entry: 1680, exit: 1695, qty: 200, fees: 12.5, riskAmount: 500 }))
    .toMatchObject({ pnl: 2987.5, pnlSource: "computed", rMultiple: 5.975 });
  expect(tradePnl({ direction: "short", entry: 5000, exit: 4998, qty: 3, fees: 5 }, 300))
    .toMatchObject({ pnl: 1795, pnlSource: "computed" });
  expect(tradePnl({ direction: "short", entry: 10, exit: 12, qty: 1, fees: 1, riskAmount: 2 }))
    .toMatchObject({ pnl: -3, pnlSource: "computed", rMultiple: -1.5 });
});

it("keeps a stated result, flags differences above five percent, and leaves missing results unknown", () => {
  const prices = { direction: "long" as const, entry: 200, exit: 300, qty: 1, riskAmount: 50 };
  expect(tradePnl({ ...prices, pnl: 105 })).toMatchObject({ pnl: 105, pnlSource: "stated", rMultiple: 2.1 });
  expect(tradePnl({ ...prices, pnl: 105 }).pnlMismatch).toBeUndefined();
  expect(tradePnl({ ...prices, pnl: 106 })).toMatchObject({ pnl: 106, pnlSource: "stated", pnlMismatch: true });
  expect(tradePnl({ ...prices, pnl: 0 })).toMatchObject({ pnl: 0, pnlSource: "stated", pnlMismatch: true, rMultiple: 0 });
  expect(tradePnl({ ...prices, exit: prices.entry, pnl: -1 })).toMatchObject({ pnl: -1, pnlMismatch: true });
  expect(tradePnl({ direction: "short", entry: 10 })).toMatchObject({ pnl: undefined, pnlSource: "unknown", rMultiple: undefined });
});

it("uses only positive finite configured multipliers and defaults the rest to one", () => {
  const settings = parseTradeMultipliers("if=300\nsi＝50\nBAD=0\nBAD2=-5\nEMPTY=\nNOPE=Infinity\nIF=3=5");
  expect(settings).toEqual({ IF: 300, SI: 50 });
  expect(tradeMultiplier(" if ", settings)).toBe(300);
  expect(tradeMultiplier("VOID", settings)).toBe(1);
  expect(tradeMultiplier("BTC", { BTC: -1 })).toBe(1);
});
