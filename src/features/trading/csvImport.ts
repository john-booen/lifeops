import { parseCsvGrid } from "../../csv";
import { recordRevision } from "../../operationIdentity";
import type { StoreHost } from "../../store/settingsSlice";
import type { LocalOperationHost } from "../serviceHost";
import { tradeDeduplication } from "./dedup";
import { tradeTime } from "./inputs";
import { readTradeDatabase, recordTradeDrafts } from "./persistence";
import { tradeMultiplier, tradePnl } from "./pnl";
import { defaultTradeCurrency, isTradeDraft, TRADE_MARKETS, type Trade, type TradeCurrency, type TradeDraft, type TradeMarket } from "./types";

export const TRADE_CSV_FIELDS = {
  openedAt: "开仓时间", symbol: "品种", direction: "方向", market: "市场", qty: "数量", qtyUnit: "数量单位",
  entry: "入场价", exit: "出场价", closedAt: "平仓时间", fees: "手续费", pnl: "盈亏", currency: "币种", notes: "备注"
} as const;
export type TradeCsvField = keyof typeof TRADE_CSV_FIELDS;
export interface TradeCsvTemplate {
  name: string;
  columns: Partial<Record<TradeCsvField, string>>;
  market?: TradeMarket;
  currency?: TradeCurrency;
}
export interface TradeCsvTable { name: string; headers: string[]; rows: string[][] }
type CsvRow = { line: number; kind: "ready" | "duplicate"; draft: TradeDraft; currency: TradeCurrency; pnl?: number; pnlSource: Trade["pnlSource"] }
  | { line: number; kind: "invalid"; reason: string };
export interface TradeCsvPreview { rows: CsvRow[]; ready: number; duplicates: number; invalid: number; revision: string }

const MAX_ROWS = 2000;
export const TRADE_CSV_MAX_BYTES = 2 * 1024 * 1024;

export function readTradeCsv(text: string, name: string): TradeCsvTable {
  if (Buffer.byteLength(text, "utf8") > TRADE_CSV_MAX_BYTES) throw new Error("交易 CSV 太大，请分成较小文件。");
  if (text.includes("\ufffd")) throw new Error("CSV 编码无法识别，请另存为 UTF-8。");
  const [head, ...rawRows] = parseCsvGrid(text, true);
  const headers = head?.map(cell => cell.trim()) ?? [];
  const rows = rawRows.filter(row => row.some(cell => !!cell.trim()));
  if (!headers.length || headers.some(cell => !cell) || new Set(headers).size !== headers.length) throw new Error("CSV 表头需完整，列名不能重复。");
  if (!rows.length) throw new Error("CSV 没有交易数据行。");
  if (rows.length > MAX_ROWS) throw new Error(`一次最多预览 ${MAX_ROWS} 笔，请拆分文件。`);
  return { name: name.split(/[/\\]/).at(-1)?.slice(0, 200) || "交易.csv", headers, rows };
}

const directionMap = new Map<string, TradeDraft["direction"]>([
  ...["long", "buy", "b", "多", "做多", "多头", "买", "买入", "买开"].map(value => [value, "long"] as const),
  ...["short", "sell", "s", "空", "做空", "空头", "卖", "卖出", "卖开"].map(value => [value, "short"] as const)
]);
const currencies = new Map<string, TradeCurrency>([["CNY", "CNY"], ["RMB", "CNY"], ["人民币", "CNY"], ["元", "CNY"],
  ["USD", "USD"], ["美元", "USD"], ["美金", "USD"], ["US$", "USD"]]);

function numeric(value: string, label: string): number | undefined {
  if (!value) return undefined;
  const normalized = value.startsWith("(") && value.endsWith(")") ? `-${value.slice(1, -1)}` : value;
  if (!/^[+-]?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) throw new Error(`${label}不是有效数字。`);
  const number = Number(normalized.replace(/,/g, ""));
  if (!Number.isFinite(number)) throw new Error(`${label}不是有效数字。`);
  return number;
}

function csvTime(raw: string) {
  if (!/^\d{4}[-/]\d{2}[-/]\d{2}/.test(raw)) throw new Error("时间应使用完整的日期或带时区的时间。");
  return tradeTime(raw.replace(/^(\d{4})\/(\d{2})\/(\d{2})/, "$1-$2-$3"));
}

function csvDraft(row: string[], table: TradeCsvTable, template: TradeCsvTemplate, columns: Map<TradeCsvField, number>): TradeDraft {
  if (row.length > table.headers.length) throw new Error("数据列数超过表头，请核对引号或分隔符。");
  const cell = (key: TradeCsvField) => row[columns.get(key) ?? -1]?.trim() ?? "";
  const symbol = cell("symbol"), direction = directionMap.get(cell("direction").toLowerCase());
  const market = cell("market") || template.market;
  if (!symbol || !direction) throw new Error("缺少品种或无法识别方向。");
  if (!market || !TRADE_MARKETS.includes(market as TradeMarket)) throw new Error("请核对交易市场。");
  const rawCurrency = cell("currency");
  const currency = rawCurrency ? currencies.get(rawCurrency.toUpperCase()) : template.currency;
  if (rawCurrency && !currency || market === "期货" && !currency) throw new Error("币种应为 CNY 或 USD，期货须选交易所币种。");
  const opened = csvTime(cell("openedAt")), closed = cell("closedAt") ? csvTime(cell("closedAt")) : undefined;
  if (closed?.openedAtPrecision) throw new Error("请提供平仓时刻或留空。");
  const draft: TradeDraft = { ...opened, closedAt: closed?.openedAt, market: market as TradeMarket, symbol, direction, currency,
    qty: numeric(cell("qty"), "数量"), qtyUnit: cell("qtyUnit") || undefined, entry: numeric(cell("entry"), "入场价"),
    exit: numeric(cell("exit"), "出场价"), fees: numeric(cell("fees"), "手续费"), pnl: numeric(cell("pnl"), "盈亏"),
    notes: cell("notes") || undefined, source: { kind: "csv", ref: table.name } };
  if (!isTradeDraft(draft)) throw new Error("请核对数量、时刻和交易字段。");
  return draft;
}

export function previewTradeCsv(table: TradeCsvTable, template: TradeCsvTemplate, existing: readonly Trade[], multipliers?: Record<string, number>): TradeCsvPreview {
  const columns = new Map<TradeCsvField, number>();
  for (const [key, name] of Object.entries(template.columns)) {
    if (!name || !Object.hasOwn(TRADE_CSV_FIELDS, key)) continue;
    const index = table.headers.indexOf(name);
    if (index < 0) throw new Error(`文件缺少模板使用的列「${name}」。`);
    columns.set(key as TradeCsvField, index);
  }
  if (!["openedAt", "symbol", "direction"].every(key => columns.has(key as TradeCsvField)) || !columns.has("market") && !template.market) {
    throw new Error("请选择开仓时间、品种和方向的列，并选择市场列或默认市场。");
  }
  const index = tradeDeduplication(existing);
  const rows: CsvRow[] = table.rows.map((cells, rowIndex) => {
    const line = rowIndex + 2;
    try {
      const draft = csvDraft(cells, table, template, columns);
      const currency = draft.currency ?? defaultTradeCurrency(draft.market)!;
      const { pnl, pnlSource } = tradePnl(draft, tradeMultiplier(draft.symbol, multipliers));
      if (index.duplicate(draft)) return { line, kind: "duplicate", draft, currency, pnl, pnlSource };
      index.add(draft);
      return { line, kind: "ready", draft, currency, pnl, pnlSource };
    } catch (error) {
      return { line, kind: "invalid", reason: error instanceof Error ? error.message : "无法解析这一行。" };
    }
  });
  const count = (kind: CsvRow["kind"]) => rows.filter(row => row.kind === kind).length;
  return { rows, ready: count("ready"), duplicates: count("duplicate"), invalid: count("invalid"), revision: recordRevision(rows) };
}

export async function confirmTradeCsv(host: LocalOperationHost, table: TradeCsvTable, template: TradeCsvTemplate, preview: TradeCsvPreview,
  assertCurrent?: () => void): Promise<number> {
  if (!preview.ready) throw new Error("没有可导入的交易。");
  const selection = structuredClone({ table, template, revision: preview.revision, count: preview.ready });
  await host.saveLocalOperation("manual_trade_csv_batch", { file: selection.table.name, preview: selection.revision, count: selection.count }, async store => {
    const current = previewTradeCsv(selection.table, selection.template, (await readTradeDatabase(store)).trades, store.settings.tradingContractMultipliers);
    if (current.revision !== selection.revision || current.ready !== selection.count) throw new Error("交易记录已变化，请重新预览再确认。");
    const drafts = current.rows.flatMap(row => row.kind === "ready" ? [row.draft] : []);
    await recordTradeDrafts(store, drafts);
  }, { assertCurrent });
  await host.refreshViews().catch(() => undefined);
  return selection.count;
}
