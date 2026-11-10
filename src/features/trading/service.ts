import { Notice, type App } from "obsidian";
import { recordRevision } from "../../operationIdentity";
import type { StoreHost } from "../../store/settingsSlice";
import type { LocalOperationHost } from "../serviceHost";
import { TradeEntryModal } from "./form";
import { tradeReceiptText } from "./inputs";
import { readTradeDatabase, recordTradeDrafts, updateTrade } from "./persistence";
import type { Trade } from "./types";

export interface TradeFormHost extends LocalOperationHost { app: App; store: StoreHost }

export async function openTradeForm(host: TradeFormHost, id?: string): Promise<void> {
  const original = id ? (await readTradeDatabase(host.store)).trades.find(trade => trade.id === id) : undefined;
  if (id && !original) throw new Error("这笔交易已不存在，请刷新记录。");
  const expected = original && recordRevision(original);
  new TradeEntryModal(host.app, async (draft, patch) => {
    let saved: Trade | undefined;
    if (original) {
      if (!Object.keys(patch).length) return;
      await host.saveLocalOperation("local_update_trade", { id: original.id, patch, expected }, async store => {
        saved = await updateTrade(store, original.id, patch, new Date(), expected);
      });
    } else {
      await host.saveLocalOperation("local_record_trade", { draft }, async store => {
        [saved] = await recordTradeDrafts(store, [draft]);
      });
    }
    if (saved) new Notice(tradeReceiptText(saved, original ? "已改" : "已记"));
    await host.refreshViews().catch(() => undefined);
  }, original).open();
}
