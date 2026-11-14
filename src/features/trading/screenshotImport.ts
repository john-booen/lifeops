import { recordRevision } from "../../operationIdentity";
import type { LocalOperationHost } from "../serviceHost";
import { normalizeJournalDate } from "../../date";
import { tradeDeduplication } from "./dedup";
import { tradeTime } from "./inputs";
import { readTradeDatabase, recordTradeDrafts } from "./persistence";
import { tradeMultiplier, tradeNumber, tradePnl } from "./pnl";
import { isTradeDraft, isTradeTimestamp, type Trade, type TradeDraft, type TradeMarket } from "./types";

export { SCREENSHOT_MAX_BYTES as TRADE_SCREENSHOT_MAX_BYTES, readScreenshotImage as readTradeScreenshot, type ScreenshotImage as TradeScreenshot } from "../screenshots/image";
export const TRADE_SCREENSHOT_MAX_ROWS = 20;
const MARKETS: Record<string, TradeMarket> = { "a-share": "A股", "us-stock": "美股", futures: "期货", forex: "外汇", crypto: "加密" };

const fields = ["symbol", "market", "direction", "openedAt", "openClockShown", "openedZone", "closedAt", "closedZone",
  "qty", "qtyUnit", "entry", "exit", "fees", "displayedPnl", "currency"] as const;
type ScreenshotFields = typeof fields[number];
type ModelRow = Partial<Record<ScreenshotFields, unknown>>;

/** The provider only supplies candidates. Keep unknown fields and arbitrary text out of the import. */
export function parseTradeScreenshotRows(content: string): ModelRow[] {
  if (content.length > 24_000) throw Error("识别结果太长，请把截图分成几张。");
  let parsed: { rows?: unknown };
  const fenced = /^\s*```(?:json)?\s*([\s\S]+?)\s*```\s*$/iu.exec(content);
  try { parsed = JSON.parse(fenced?.[1] ?? content); } catch { throw Error("没有得到可核对的交易清单，请换一张清晰截图。"); }
  if (!Array.isArray(parsed?.rows) || parsed.rows.length > TRADE_SCREENSHOT_MAX_ROWS) throw Error("每张截图最多识别 20 笔。请核对截图后重试。");
  return parsed.rows.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return {};
    return Object.fromEntries(fields.flatMap<[ScreenshotFields, string | number | boolean]>(field => {
      const value = (row as Record<string, unknown>)[field];
      return typeof value === "string" ? [[field, value.slice(0, 80).trim()]]
        : typeof value === "number" && Number.isFinite(value) || field === "openClockShown" && typeof value === "boolean"
          ? [[field, value as number | boolean]] : [];
    }));
  });
}

export type ScreenshotPreviewRow = { line: number; kind: "invalid"; reason: string }
  | { line: number; kind: "ready" | "duplicate"; draft: TradeDraft; computedPnl?: number; screenshotPnl?: number;
      mismatch: boolean; multiplier: number; inferredTimeZone?: string };
export interface TradeScreenshotPreview {
  rows: ScreenshotPreviewRow[];
  ready: number;
  revision: string;
}

const finiteField = (row: ModelRow, field: ScreenshotFields): number | undefined => {
  const value = row[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw Error("有金额、价格或数量无法核对。");
  return value;
};

function explicitOffset(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const zone = value.toUpperCase().trim().replace("−", "-");
  if (zone === "Z" || zone === "UTC" || zone === "GMT") return "+00:00";
  const match = /^(?:UTC|GMT)?([+-])((?:0\d|1[0-4])):?([0-5]\d)$/u.exec(zone);
  if (match && (match[2] !== "14" || match[3] === "00")) return `${match[1]}${match[2]}:${match[3]}`;
}

const marketTimeZones: Partial<Record<TradeMarket, string>> = { 美股: "America/New_York", A股: "Asia/Shanghai" };

function offsetForLocalClock(date: string, time: string, timeZone: string): string {
  const normalized = time.length === 5 ? time + ":00" : time;
  const utc = new Date(date + "T" + normalized + "Z");
  if (Number.isNaN(utc.getTime()) || normalizeJournalDate(date) !== date) throw Error("截图中的日期或时刻无效。");
  const format = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" });
  const offsets = [...new Set([-24, 0, 24].map(hours => explicitOffset(format.formatToParts(new Date(+utc + hours * 3600000))
    .find(part => part.type === "timeZoneName")?.value)).filter((value): value is string => !!value))];
  const matches = offsets.filter(offset => format.format(new Date(date + "T" + normalized + offset)).startsWith(date + " " + normalized));
  if (matches.length !== 1) throw Error("该时刻遇到夏令时切换，请提供截图中的明确时区。");
  return matches[0];
}

function screenshotTimestamp(value: unknown, printedZone: unknown, marketZone?: string): { timestamp: string; inferred?: string } {
  const text = typeof value === "string" ? value : "";
  const clock = /^(\d{4}-\d{2}-\d{2})[ T]((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)(?:\s*(Z|(?:UTC|GMT)?[+−-]\d{2}:?\d{2}|UTC|GMT))?$/iu.exec(text);
  if (!clock) throw Error("缺少截图上明确显示的日期或时刻。");
  const printed = explicitOffset(printedZone);
  if (printedZone && !printed || printed && clock[3] && explicitOffset(clock[3]) !== printed) {
    throw Error("截图上显示的时区无效或互相冲突。");
  }
  const explicit = printed;
  if (!explicit && !marketZone) throw Error("无法从交易市场推定时区，请提供明确时区。");
  const zone = explicit || offsetForLocalClock(clock[1], clock[2], marketZone!);
  const timestamp = `${clock[1]}T${clock[2]}${zone}`;
  if (!isTradeTimestamp(timestamp)) throw Error("截图中的日期或时区无效。");
  return { timestamp, ...(!explicit ? { inferred: marketZone } : {}) };
}

function screenshotOpening(row: ModelRow, marketZone?: string): Pick<TradeDraft, "openedAt" | "openedAtPrecision"> & { inferred?: string } {
  const date = row.openedAt;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(date) || row.openClockShown !== false) {
    const open = screenshotTimestamp(date, row.openedZone, marketZone);
    return { ...tradeTime(open.timestamp), inferred: open.inferred };
  }
  const printed = explicitOffset(row.openedZone);
  if (row.openedZone && !printed) throw Error("截图上显示的时区无效。");
  if (printed === undefined && marketZone === undefined) return tradeTime(date);
  if (normalizeJournalDate(date) !== date) throw Error("截图中的日期无效。");
  const inferred = printed === undefined ? marketZone : undefined;
  const offset = inferred ? offsetForLocalClock(date, "00:00:00", inferred) : printed;
  // The ledger uses midnight to store a date. Keep it in the source market to
  // avoid rejecting a same-day close when the computer is in another zone.
  return { openedAt: `${date}T00:00:00${offset}`, openedAtPrecision: "date" as const, inferred };
}

function screenshotDraft(row: ModelRow, digest: string, multipliers?: Record<string, number>) {
  const market = typeof row.market === "string" && Object.hasOwn(MARKETS, row.market) ? MARKETS[row.market] : undefined;
  if (!market || typeof row.symbol !== "string" || !/^[A-Z0-9][A-Z0-9.\/_:-]{0,31}$/iu.test(row.symbol)
    || row.direction !== "long" && row.direction !== "short" || (row.currency !== "CNY" && row.currency !== "USD")) {
    throw Error("缺少可核对的品种、市场、持仓方向或币种。");
  }
  const marketZone = marketTimeZones[market] ?? (market === "期货" && row.currency === "CNY" ? "Asia/Shanghai" : undefined);
  const { inferred: openingZone, ...open } = screenshotOpening(row, marketZone);
  const close = row.closedAt === undefined ? undefined : screenshotTimestamp(row.closedAt, row.closedZone, marketZone);
  const inferredTimeZone = openingZone || close?.inferred;
  const draft: TradeDraft = {
    ...open, closedAt: close?.timestamp, market, direction: row.direction,
    symbol: row.symbol.toUpperCase(), currency: row.currency, qty: finiteField(row, "qty"),
    qtyUnit: typeof row.qtyUnit === "string" && /^[a-z][a-z -]{0,19}$/iu.test(row.qtyUnit) ? row.qtyUnit : undefined,
    entry: finiteField(row, "entry"), exit: finiteField(row, "exit"), fees: finiteField(row, "fees"),
    // Existing versions can still open the ledger after a program-only rollback.
    source: { kind: "form", ref: `trade-screenshot:${digest}` }
  };
  if (!isTradeDraft(draft) || draft.fees !== undefined && draft.fees < 0) throw Error("交易时间、费用或数量不合法。");
  const screenshotPnl = finiteField(row, "displayedPnl"), multiplier = tradeMultiplier(draft.symbol, multipliers);
  const computedPnl = tradePnl(draft, multiplier).pnl;
  const mismatch = screenshotPnl !== undefined && computedPnl !== undefined && Math.abs(screenshotPnl - computedPnl) > 0.005;
  if (screenshotPnl !== undefined) {
    const reported = `截图显示盈亏 ${tradeNumber(screenshotPnl)} ${draft.currency}`;
    if (computedPnl === undefined) draft.notes = reported + "。交易字段不足，盈亏暂未入账。";
    else if (mismatch) draft.notes = reported + "。按本地重算值入账。";
  }
  if (inferredTimeZone) draft.notes = [draft.notes, "截图时区按市场推定为 " + inferredTimeZone + "。"].filter(Boolean).join(" ");
  return { draft, computedPnl, screenshotPnl, mismatch, multiplier, inferredTimeZone };
}

function sameScreenshotOpening(left: TradeDraft, right: TradeDraft): boolean {
  if (left.openedAtPrecision !== right.openedAtPrecision) return false;
  return left.openedAtPrecision === "date"
    ? left.openedAt.slice(0, 10) === right.openedAt.slice(0, 10) : Date.parse(left.openedAt) === Date.parse(right.openedAt);
}

export function previewTradeScreenshot(rows: readonly ModelRow[], digest: string, existing: readonly Trade[],
  multipliers?: Record<string, number>): TradeScreenshotPreview {
  if (!/^[a-f0-9]{64}$/u.test(digest) || rows.length > TRADE_SCREENSHOT_MAX_ROWS) throw Error("截图确认已失效，请重新选择。");
  const dedup = tradeDeduplication(existing);
  const mapped: ScreenshotPreviewRow[] = rows.map((row, i) => {
    const line = i + 1;
    try {
      const value = screenshotDraft(row, digest, multipliers);
      const duplicate = dedup.duplicate(value.draft) || existing.some(trade => trade.source.ref === value.draft.source.ref
        && trade.symbol === value.draft.symbol && trade.direction === value.draft.direction && sameScreenshotOpening(trade, value.draft)
        && trade.qty === value.draft.qty && trade.entry === value.draft.entry && trade.exit === value.draft.exit);
      if (!duplicate) dedup.add(value.draft);
      return { line, kind: duplicate ? "duplicate" : "ready", ...value };
    } catch (error) {
      return { line, kind: "invalid", reason: error instanceof Error ? error.message : "交易行无法识别。" };
    }
  });
  return { rows: mapped, ready: mapped.filter(row => row.kind === "ready").length, revision: recordRevision(mapped) };
}

export async function confirmTradeScreenshot(host: LocalOperationHost, rows: readonly ModelRow[], digest: string,
  preview: TradeScreenshotPreview, lines: readonly number[], assertCurrent: () => void): Promise<number> {
  const ready = new Set(preview.rows.flatMap(row => row.kind === "ready" ? [row.line] : []));
  const picked = [...new Set(lines)].sort((a, b) => a - b);
  if (!picked.length || picked.some(line => !ready.has(line))) throw Error("请选择要保存的交易。");
  assertCurrent();
  const selection = structuredClone({ rows, digest, revision: preview.revision, lines: picked });
  await host.saveLocalOperation("manual_trade_screenshot_batch", { preview: selection.revision, lines: picked }, async store => {
    const current = previewTradeScreenshot(selection.rows, selection.digest, (await readTradeDatabase(store)).trades,
      store.settings.tradingContractMultipliers);
    assertCurrent();
    if (current.revision !== selection.revision) throw Error("交易记录或乘数已经变化，请重新核对截图。");
    await recordTradeDrafts(store, current.rows.flatMap(row => row.kind === "ready" && selection.lines.includes(row.line) ? [row.draft] : []));
  }, { assertCurrent });
  await host.refreshViews().catch(() => undefined);
  return picked.length;
}
