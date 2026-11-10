import { isVaultPathExcluded } from "../../privacy";
import type { StoreHost } from "../../store/settingsSlice";
import { readTradeDatabase, tradeDatabasePath } from "../trading/persistence";
import type { TradeDatabase } from "../trading/types";

export async function readTradeStatsData(store: StoreHost) {
  const path = tradeDatabasePath(store.settings.folders), excluded = store.settings.privacy?.excludedVaultPrefixes;
  if (isVaultPathExcluded(path, excluded)) throw new Error("交易记录已排除，无法计算。");
  const database = await readTradeDatabase(store);
  return selectTradeStatsData(store, path, database);
}

export function selectTradeStatsData(store: StoreHost, path: string, database: TradeDatabase) {
  const excluded = store.settings.privacy?.excludedVaultPrefixes;
  if (isVaultPathExcluded(path, excluded)) throw new Error("交易记录已排除，无法计算。");
  const trades = database.trades.filter(trade => trade.source.kind !== "backfill" || !trade.source.ref || !isVaultPathExcluded(trade.source.ref, excluded));
  return { path, trades, filtered: trades.length < database.trades.length,
    settings: { breakEven: store.settings.tradingBreakEven, cnyPerUsd: store.settings.tradingCnyPerUsd } };
}
