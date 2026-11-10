import { readBoundedVaultFile } from "../../legacyMemoryReview";
import { recordRevision } from "../../operationIdentity";
import type { StoreHost } from "../../store/settingsSlice";
import type { LocalOperationHost } from "../serviceHost";
import { tradeDeduplication } from "./dedup";
import { tradeTime } from "./inputs";
import { readTradeDatabase, recordTradeDrafts } from "./persistence";
import { tradeMultiplier } from "./pnl";
import { isConfiguredTradingNote } from "./ruleSources";
import { isTradeVaultPath } from "./sourceFolders";
import { isTradeDraft, TRADE_MARKETS, type Trade, type TradeDraft, type TradeMarket } from "./types";
import { externalCategory, externalFilesForCategory, externalPrefix, resolveExternalSource } from "../externalVault/catalog";

interface BackfillCandidate { draft: TradeDraft; quote: string; original: string }
export interface TradeBackfillScan {
  candidates: BackfillCandidate[];
  unparsed: string[];
  examined: number;
}
export interface TradeBackfillBatch {
  month: string;
  candidates: BackfillCandidate[];
  duplicates: number;
  revision: string;
}

const maxNoteBytes = 32_000;
const optionalNumbers = ["qty", "entry", "exit", "stop", "target", "fees", "pnl", "riskAmount"] as const;
const marketTerms: Record<TradeMarket, RegExp> = {
  "A股": /A\s*股|沪市|深市|沪深|上交所|深交所/i,
  "美股": /美股|纳斯达克|纽交所|NASDAQ|NYSE/i,
  "期货": /期货|上期所|大商所|郑商所|中金所|广期所|CME|COMEX|NYMEX/i,
  "外汇": /外汇|forex/i, "加密": /加密|币圈|crypto|数字货币|比特币|以太坊/i
};

function eligible(store: StoreHost, path: string): boolean {
  if (path.startsWith(externalPrefix + "/")) {
    const source = resolveExternalSource(store, path);
    return !!source && externalCategory(store.settings, source.path) === "trade_review" && path.endsWith(".md");
  }
  const folder = store.settings.folders.tradingReviews;
  return isTradeVaultPath(folder) && isTradeVaultPath(path) && path.endsWith(".md")
    && path.startsWith(folder + "/") && isConfiguredTradingNote(store, path);
}

export function listTradeBackfillNotes(store: StoreHost): string[] {
  return store.app.vault.getMarkdownFiles().map(file => file.path).filter(path => eligible(store, path)).sort();
}

export async function listExternalTradeBackfillNotes(store: StoreHost): Promise<string[]> {
  return (await externalFilesForCategory(store, "trade_review")).map(item => item.reference);
}

function changedSource(): never { throw new Error("原笔记或读取范围已变化，请重新扫描再确认。"); }

async function readBackfillNote(store: StoreHost, path: string): Promise<string> {
  if (path.startsWith(externalPrefix + "/")) {
    const source = resolveExternalSource(store, path);
    if (!source || externalCategory(store.settings, source.path) !== "trade_review") changedSource();
    const raw = await source.reader.read(source.path, maxNoteBytes);
    if (!raw.trim()) throw Error("外部交易复盘正文为空。");
    return raw;
  }
  if (!eligible(store, path) || store.getFile(path)?.path !== path) changedSource();
  const result = await readBoundedVaultFile(store, path, maxNoteBytes, changedSource);
  if (!eligible(store, path) || store.getFile(path)?.path !== path) changedSource();
  if (!("raw" in result) || !result.raw?.trim()) throw new Error("原笔记为空、过大或无法从当前库安全读取。");
  return result.raw;
}

function noteDate(path: string, raw: string): string | undefined {
  return /^(\d{4}-\d{2}-\d{2})(?!\d)/.exec(path.split("/").at(-1) ?? "")?.[1]
    ?? /^#{1,6}\s+(\d{4}-\d{2}-\d{2})(?!\d)/m.exec(normalizedDateText(raw))?.[1];
}

function normalizedDateText(value: string): string {
  return value.replace(/(\d{4})[年/](\d{1,2})[月/](\d{1,2})日?/g, (_all, year: string, month: string, day: string) =>
    year + "-" + month.padStart(2, "0") + "-" + day.padStart(2, "0")).replace(/(\d{4}-\d{2}-\d{2})T(?=\d{2}:)/g, "$1 ");
}

function provenTime(value: unknown, evidence: string, dateHint?: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:$|[ T]\d{2}:\d{2})/.test(value)) throw new Error("开平仓时间不明确。");
  const timestamp = tradeTime(value);
  const date = value.slice(0, 10);
  const time = normalizedDateText(value).slice(11);
  if (!evidence.includes(normalizedDateText(value)) && !(dateHint === date && (!time || evidence.includes(time)))) {
    throw new Error("时间无法在原笔记核对。");
  }
  return timestamp;
}

function parseBackfillRow(value: unknown, raw: string, path: string, original: string): BackfillCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("没有读到交易字段。");
  const row = value as Record<string, unknown>;
  const { quote, symbol, market, direction, currency } = row;
  if (typeof quote !== "string" || quote.length < 6 || quote.length > 2000 || !raw.includes(quote)
    || typeof symbol !== "string" || !symbol.trim() || !quote.toUpperCase().includes(symbol.trim().toUpperCase())
    || !TRADE_MARKETS.includes(market as TradeMarket) || !marketTerms[market as TradeMarket].test(raw)
    || !(direction === "long" && /做多|多头|多单|买开|(?<![平做买卖])多(?!次|少|余)|\b(?:long|buy)\b/i.test(quote)
      || direction === "short" && /做空|空头|空单|卖开|(?<![平做买卖])空(?!仓)|\b(?:short|sell)\b/i.test(quote))) {
    throw new Error("找不到可以核对的交易原话。");
  }
  const timeEvidence = normalizedDateText(quote), date = noteDate(path, raw);
  const opened = provenTime(row.openedAt, timeEvidence, date);
  const closed = row.closedAt === undefined ? undefined : provenTime(row.closedAt, timeEvidence, date);
  if (closed?.openedAtPrecision) throw new Error("平仓时刻不完整。");
  if (currency !== undefined && !(currency === "CNY" && /CNY|RMB|人民币|元/i.test(raw)
    || currency === "USD" && /USD|美元|美金|US\$/i.test(raw))) throw new Error("币种无法在原笔记核对。");
  const amountEvidence = quote.replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
  const amounts = new Set((amountEvidence.match(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/g) ?? []).map(Number));
  const draft: TradeDraft = { ...opened, closedAt: closed?.openedAt, symbol: symbol.trim(), market: market as TradeMarket,
    direction, currency, source: { kind: "backfill", ref: path } };
  for (const key of optionalNumbers) {
    const number = row[key];
    if (number === undefined) continue;
    if (typeof number !== "number" || !amounts.has(number)) throw new Error("交易数字无法在原话核对。");
    draft[key] = number;
  }
  if (typeof row.qtyUnit === "string" && row.qtyUnit.trim() && quote.includes(row.qtyUnit)) draft.qtyUnit = row.qtyUnit;
  if (!isTradeDraft(draft) || draft.market === "期货" && !draft.currency) throw new Error("交易信息不完整。");
  draft.source.backfillKey = recordRevision([path, draft.openedAtPrecision === "date" ? draft.openedAt.slice(0, 10) : Date.parse(draft.openedAt),
    draft.symbol.toUpperCase(), draft.direction, draft.qty, draft.entry, draft.exit, draft.pnl]);
  return { draft, quote, original };
}

export async function scanTradeBackfill(store: StoreHost, paths: readonly string[], analyze: (text: string, date?: string) => Promise<string>,
  signal: AbortSignal, onProgress?: (examined: number) => void): Promise<TradeBackfillScan> {
  const scan: TradeBackfillScan = { candidates: [], unparsed: [], examined: 0 };
  for (const path of [...new Set(paths)].filter(path => eligible(store, path))) {
    signal.throwIfAborted();
    try {
      const raw = await readBackfillNote(store, path);
      signal.throwIfAborted();
      if (!eligible(store, path)) changedSource();
      const reply = await analyze(raw, noteDate(path, raw));
      signal.throwIfAborted();
      const parsed = JSON.parse(reply.trim().replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/gi, ""));
      if (!Array.isArray(parsed?.trades) || parsed.trades.length > 100
        || parsed.kind !== (parsed.trades.length ? "trade" : "other")) throw new Error("没有读到明确的交易清单。");
      if (!eligible(store, path)) changedSource();
      const original = recordRevision(raw);
      let partial = false;
      for (const row of parsed.trades) {
        try { scan.candidates.push(parseBackfillRow(row, raw, path, original)); }
        catch { partial = true; }
      }
      if (partial) scan.unparsed.push(path);
    } catch {
      signal.throwIfAborted();
      scan.unparsed.push(path);
    }
    scan.examined++;
    onProgress?.(scan.examined);
  }
  return scan;
}

export function previewTradeBackfill(scan: TradeBackfillScan, month: string, existing: readonly Trade[], multipliers?: Record<string, number>): TradeBackfillBatch {
  const index = tradeDeduplication(existing);
  const keys = new Set(existing.map(trade => trade.source.backfillKey).filter(Boolean));
  const candidates: BackfillCandidate[] = [];
  let duplicates = 0;
  for (const candidate of scan.candidates) {
    const draft = candidate.draft;
    if (draft.openedAt.slice(0, 7) !== month) continue;
    if (keys.has(draft.source.backfillKey) || index.duplicate(draft)) { duplicates++; continue; }
    index.add(draft);
    keys.add(draft.source.backfillKey);
    candidates.push(candidate);
  }
  const revisions = candidates.map(candidate => [candidate, tradeMultiplier(candidate.draft.symbol, multipliers)]);
  return { month, candidates, duplicates, revision: recordRevision([month, revisions, duplicates]) };
}

export async function confirmTradeBackfill(host: LocalOperationHost, base: StoreHost, scan: TradeBackfillScan, preview: TradeBackfillBatch,
  assertCurrent?: () => void): Promise<number> {
  if (!preview.candidates.length) throw new Error("这月没有可回填的交易。");
  const { month, revision } = preview;
  const selection = structuredClone(scan);
  const sources = new Map(preview.candidates.map(candidate => [candidate.draft.source.ref!, candidate.original]));
  const assertSources = async () => {
    for (const [path, original] of sources) {
      assertCurrent?.();
      if (recordRevision(await readBackfillNote(base, path)) !== original) changedSource();
    }
  };
  await host.saveLocalOperation("manual_trade_backfill", { month, preview: revision, count: preview.candidates.length }, async store => {
    const current = previewTradeBackfill(selection, month, (await readTradeDatabase(store)).trades, store.settings.tradingContractMultipliers);
    if (current.revision !== revision) throw new Error("交易记录已变化，请重新预览再确认。");
    await assertSources();
    await recordTradeDrafts(store, current.candidates.map(candidate => candidate.draft));
  }, { assertCurrent, assertBeforeCommit: assertSources });
  await host.refreshViews().catch(() => undefined);
  return preview.candidates.length;
}
