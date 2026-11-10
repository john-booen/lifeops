import { expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { getTradingSourceFolders, parseTradingSourceFolders } from "../src/features/trading/sourceFolders";

it("uses the existing review and model folders for old settings and respects an explicitly empty list", () => {
  expect(getTradingSourceFolders(DEFAULT_SETTINGS)).toEqual(["LifeOps/TradeReview", "LifeOps/Knowledge/TradeRules"]);
  const folders = { ...DEFAULT_SETTINGS.folders, tradingReviews: "虚构复盘" };
  expect(getTradingSourceFolders({ folders })).toEqual(["虚构复盘", "LifeOps/Knowledge/TradeRules"]);
  expect(getTradingSourceFolders({ folders, tradingSourceFolders: [] })).toEqual([]);
});

it("round-trips selected current-vault folders and ignores unsafe paths", () => {
  const input = " 虚构复盘/\n样例\\交易\n虚构复盘\n/外部\nC:\\资料\n../外部\n输出/.obsidian\n.\n";
  const selection = parseTradingSourceFolders(input);
  expect(selection).toEqual(["虚构复盘", "样例/交易"]);
  expect(getTradingSourceFolders({ ...DEFAULT_SETTINGS, tradingSourceFolders: selection })).toEqual(selection);
});
