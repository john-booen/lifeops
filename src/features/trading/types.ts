import { normalizeJournalDate } from "../../date";
import { isTradeVaultPath } from "./sourceFolders";

export const TRADE_MARKETS = ["A股", "美股", "期货", "外汇", "加密"] as const;
export const TRADE_DATABASE_NAME = "LifeOps交易记录.json";
export type TradeMarket = (typeof TRADE_MARKETS)[number];
export type TradeCurrency = "CNY" | "USD";
export function defaultTradeCurrency(market: TradeMarket): TradeCurrency | undefined {
  return market === "期货" ? undefined : market === "A股" ? "CNY" : "USD";
}

export interface Trade {
  id: string;
  openedAt: string;
  openedAtPrecision?: "date";
  closedAt?: string;
  market: TradeMarket;
  symbol: string;
  direction: "long" | "short";
  qty?: number;
  qtyUnit?: string;
  entry?: number;
  exit?: number;
  stop?: number;
  target?: number;
  fees?: number;
  pnl?: number;
  pnlSource: "stated" | "computed" | "unknown";
  pnlMismatch?: boolean;
  currency: TradeCurrency;
  riskAmount?: number;
  rMultiple?: number;
  modelId?: string;
  modelVersionId?: string;
  planned: boolean | null;
  ruleViolations: string[];
  ruleCheckStatus?: "checked" | "insufficient";
  emotion?: string;
  notes?: string;
  attachments: string[];
  source: { kind: "chat" | "form" | "csv" | "backfill"; ref?: string; backfillKey?: string };
  createdAt: string;
  updatedAt: string;
}

type DefaultedFields = "currency" | "planned" | "ruleViolations" | "attachments";
export type TradeDraft = Omit<Trade, DefaultedFields | "id" | "pnlSource" | "pnlMismatch" | "rMultiple" | "createdAt" | "updatedAt">
  & Partial<Pick<Trade, DefaultedFields>>;
export type TradePatch = Partial<Omit<TradeDraft, "source">>;
export interface TradeDatabase { version: 1; trades: Trade[] }

const numericFields = ["qty", "entry", "exit", "stop", "target", "fees", "pnl", "riskAmount"] as const;
const textFields = ["qtyUnit", "modelId", "modelVersionId", "emotion", "notes"] as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && !!item.trim());

export function isTradeTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    && !!normalizeJournalDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

function isTradeSource(value: unknown): value is Trade["source"] {
  return object(value) && ["chat", "form", "csv", "backfill"].includes(value.kind as string)
    && (value.ref === undefined || typeof value.ref === "string")
    && (value.backfillKey === undefined || value.kind === "backfill" && typeof value.ref === "string"
      && isTradeVaultPath(value.ref) && typeof value.backfillKey === "string" && /^[a-f0-9]{64}$/.test(value.backfillKey));
}

export function isTradeDraft(value: unknown): value is TradeDraft {
  if (!object(value) || !isTradeTimestamp(value.openedAt) || !TRADE_MARKETS.includes(value.market as TradeMarket)
    || typeof value.symbol !== "string" || !value.symbol.trim() || /[\r\n]/.test(value.symbol)
    || (value.direction !== "long" && value.direction !== "short") || !isTradeSource(value.source)) return false;
  if (value.closedAt !== undefined && (!isTradeTimestamp(value.closedAt) || Date.parse(value.closedAt) < Date.parse(value.openedAt))) return false;
  if (value.openedAtPrecision !== undefined && value.openedAtPrecision !== "date") return false;
  if (numericFields.some(key => value[key] !== undefined && !finite(value[key]))
    || (finite(value.qty) && value.qty <= 0) || (finite(value.riskAmount) && value.riskAmount <= 0)
    || textFields.some(key => value[key] !== undefined && typeof value[key] !== "string")) return false;
  return (value.currency === undefined || value.currency === "CNY" || value.currency === "USD")
    && (value.planned === undefined || value.planned === null || typeof value.planned === "boolean")
    && (value.ruleViolations === undefined || strings(value.ruleViolations))
    && (value.ruleCheckStatus === undefined || value.ruleCheckStatus === "checked" || value.ruleCheckStatus === "insufficient")
    && (value.attachments === undefined || strings(value.attachments) && value.attachments.every(isTradeVaultPath));
}

export function validTradeDatabase(value: unknown): value is TradeDatabase {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.trades)) return false;
  const ids = new Set<string>();
  for (const record of value.trades) {
    if (!object(record)) return false;
    const { id, createdAt, updatedAt, pnlSource, pnlMismatch, rMultiple } = record;
    if (!isTradeDraft(record) || typeof id !== "string" || !id.trim() || ids.has(id)
      || !isTradeTimestamp(createdAt) || !isTradeTimestamp(updatedAt)
      || record.currency === undefined || record.planned === undefined
      || !record.ruleViolations || !record.attachments
      || (pnlSource === "unknown" ? record.pnl !== undefined : !["stated", "computed"].includes(pnlSource as string) || !finite(record.pnl))
      || (pnlMismatch !== undefined && typeof pnlMismatch !== "boolean") || (rMultiple !== undefined && !finite(rMultiple))) return false;
    ids.add(id);
  }
  return true;
}
