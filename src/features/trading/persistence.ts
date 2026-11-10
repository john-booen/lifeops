import { randomUUID } from "node:crypto";
import { guardedOperationIdentity, readFactOperation } from "../../dataFoundation/factOperation";
import { recordRevision } from "../../operationIdentity";
import type { StoreHost } from "../../store/settingsSlice";
import type { FolderSettings } from "../../types";
import { tradeMultiplier, tradeNumber, tradePnl } from "./pnl";
import { isTradeVaultPath } from "./sourceFolders";
import { defaultTradeCurrency, isTradeDraft, TRADE_DATABASE_NAME, type Trade, type TradeDatabase, type TradeDraft, type TradePatch } from "./types";

const MIRROR_MARKER = "<!-- lifeops:trade-mirror:v1 -->";

export function tradeDatabasePath(folders: Pick<FolderSettings, "tradingReviews">): string {
  if (!isTradeVaultPath(folders.tradingReviews)) throw new Error("请设置当前库内的交易复盘文件夹。");
  return `${folders.tradingReviews}/${TRADE_DATABASE_NAME}`;
}

export function readTradeDatabase(store: StoreHost): Promise<TradeDatabase> {
  return readFactOperation(store, () => store.readJson<TradeDatabase>(tradeDatabasePath(store.settings.folders), { version: 1, trades: [] }));
}

export async function recordTradeDrafts(store: StoreHost, drafts: readonly TradeDraft[], now = new Date()): Promise<Trade[]> {
  assertTradeWrite(store);
  if (!drafts.length) throw new Error("没有可保存的交易。");
  const timestamp = now.toISOString();
  const added = drafts.map(draft => ({ ...tradeFields(draft, store.settings.tradingContractMultipliers),
    id: `trade-${now.getTime()}-${randomUUID()}`, createdAt: timestamp, updatedAt: timestamp }));
  const previous = await readTradeDatabase(store);
  await persistTradeDatabase(store, { ...previous, trades: [...previous.trades, ...added] }, added);
  return added;
}

export async function updateTrade(store: StoreHost, id: string, patch: TradePatch, now = new Date(), expectedRevision?: string): Promise<Trade> {
  assertTradeWrite(store);
  const database = await readTradeDatabase(store);
  const original = database.trades.find(trade => trade.id === id);
  if (!original || expectedRevision !== undefined && recordRevision(original) !== expectedRevision) {
    throw new Error("这笔交易已变化或无法找到，请重新核对。");
  }
  const { pnlSource, pnlMismatch, rMultiple, pnl, source } = original;
  const draft = { ...original, pnl: pnlSource === "stated" ? pnl : undefined, ...patch, source };
  if (["modelId", "modelVersionId", "market", "symbol", "direction", "qty", "entry", "exit", "stop", "target", "openedAt", "closedAt", "notes", "planned"]
    .some(key => Object.hasOwn(patch, key))) {
    draft.ruleViolations = [];
    draft.ruleCheckStatus = draft.modelId || draft.modelVersionId ? "insufficient" : undefined;
    if (Object.hasOwn(patch, "modelId") && !Object.hasOwn(patch, "modelVersionId")) draft.modelVersionId = undefined;
  }
  const fields = tradeFields(draft, store.settings.tradingContractMultipliers);
  if (!["direction", "entry", "exit", "qty", "fees", "pnl", "symbol"].some(key => Object.hasOwn(patch, key))) {
    Object.assign(fields, { pnlSource, pnlMismatch, pnl, rMultiple: Object.hasOwn(patch, "riskAmount")
      ? tradePnl({ direction: draft.direction, pnl, riskAmount: draft.riskAmount }).rMultiple : rMultiple });
  }
  const updated = { ...original, ...fields, pnlMismatch: fields.pnlMismatch, updatedAt: now.toISOString() };
  await persistTradeDatabase(store, { ...database, trades: database.trades.map(trade => trade.id === id ? updated : trade) }, [original, updated]);
  return updated;
}

export async function deleteTrade(store: StoreHost, id: string, expectedRevision: string): Promise<Trade> {
  assertTradeWrite(store);
  const database = await readTradeDatabase(store);
  const original = database.trades.find(trade => trade.id === id);
  if (!original || recordRevision(original) !== expectedRevision) throw new Error("确认卡对应的交易已变化，请重新核对。");
  await persistTradeDatabase(store, { ...database, trades: database.trades.filter(trade => trade.id !== id) }, [original]);
  return original;
}

function assertTradeWrite(store: StoreHost): void {
  const identity = guardedOperationIdentity(store);
  if (!identity || identity.purpose === "derived") throw new Error("交易必须从受保护的保存操作写入。");
}

async function persistTradeDatabase(store: StoreHost, database: TradeDatabase, changed: readonly Trade[]): Promise<void> {
  const dates = new Set(changed.map(tradeDay));
  const mirrors = [...dates].map(date => ({ date, path: `${store.settings.folders.tradingReviews}/LifeOps交易/${date}.md` }));
  for (const { path } of mirrors) {
    if (store.getFile(path) && !(await store.readPath(path)).startsWith(MIRROR_MARKER + "\n")) {
      throw new Error("每日交易表的位置已有其他笔记，请先核对。原文已保留。");
    }
  }
  await store.writeJson(tradeDatabasePath(store.settings.folders), database);
  for (const { date, path } of mirrors) await store.writeFile(path, renderTradeDay(date, database.trades));
}

function tradeFields(draft: TradeDraft, multipliers: Record<string, number> | undefined): Omit<Trade, "id" | "createdAt" | "updatedAt"> {
  if (!isTradeDraft(draft)) throw new Error("请核对交易的品种、市场、方向、带时区的时间和数字。");
  const currency = draft.currency ?? defaultTradeCurrency(draft.market);
  if (!currency) throw new Error("期货交易请按交易所选择 CNY 或 USD。");
  const { openedAt, openedAtPrecision, closedAt, market, direction, qty, qtyUnit, entry, exit, stop, target, fees, riskAmount,
    modelId, modelVersionId, planned, ruleViolations, ruleCheckStatus, emotion, notes, attachments, source } = draft;
  const symbol = draft.symbol.trim();
  return {
    openedAt, openedAtPrecision, closedAt, market, symbol, direction,
    qty, qtyUnit, entry, exit, stop, target, fees, riskAmount, currency,
    ...tradePnl(draft, tradeMultiplier(symbol, multipliers)), modelId, modelVersionId, planned: planned ?? null,
    ruleViolations: [...new Set(ruleViolations ?? [])], ruleCheckStatus: ruleCheckStatus ?? (modelId || modelVersionId ? "insufficient" : undefined),
    emotion, notes, attachments: [...new Set(attachments ?? [])],
    source: { kind: source.kind, ref: source.ref, ...(source.backfillKey ? { backfillKey: source.backfillKey } : {}) }
  };
}

function tradeDay(trade: Trade): string { return trade.openedAt.slice(0, 10); }

function renderTradeDay(date: string, trades: readonly Trade[]): string {
  const rows = trades.filter(trade => tradeDay(trade) === date).sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
  const lines = [MIRROR_MARKER, `# ${date} 交易记录`, "",
    "> 由 LifeOps 交易数据生成。编辑这里不会写回交易记录，下次生成时会刷新表格。", "",
    "| 开仓时间 | 市场 | 品种 | 方向 | 数量 | 进场 | 出场 | 盈亏 | R | 备注 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const trade of rows) {
    const qty = trade.qty === undefined ? undefined : `${trade.qty}${trade.qtyUnit ? " " + trade.qtyUnit : ""}`;
    const pnl = trade.pnl === undefined ? undefined : `${tradeNumber(trade.pnl)} ${trade.currency}`;
    const values = [trade.openedAtPrecision ? "时间未记" : trade.openedAt.slice(11), trade.market, trade.symbol, trade.direction === "long" ? "多" : "空",
      qty, trade.entry, trade.exit, pnl, trade.rMultiple === undefined ? undefined : tradeNumber(trade.rMultiple), trade.notes];
    lines.push(`| ${values.map(tableCell).join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
}

function tableCell(value: string | number | undefined): string {
  return String(value ?? "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\|[\]*_`]/g, "\\$&").replace(/[\r\n]+/g, " ");
}
