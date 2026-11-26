import type { AiToolCall, ChatMessage } from "../ai";
import { addDays, formatDate, normalizeJournalDate } from "../date";
import { ISO_DATE_INTERVAL_PATTERN, resolveStatsRange, type StatsRange } from "../features/stats/stats";
import { serializedDateRange } from "../features/stats/rangeInput";

const interval = new RegExp(ISO_DATE_INTERVAL_PATTERN);
function compatibleRange(value: unknown, requested: {from:string;to:string}, now: Date): boolean {
  if (value === undefined || ["today","week","month","all"].includes(String(value))) return true;
  try {
    const decoded = serializedDateRange(value) ?? value;
    if (typeof decoded === "string") { if (!interval.test(decoded)) return false; }
    else if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)
      || Object.keys(decoded).sort().join(",") !== "from,to"
      || typeof (decoded as Record<string,unknown>).from !== "string" || typeof (decoded as Record<string,unknown>).to !== "string") return false;
    const range = resolveStatsRange(decoded as StatsRange,now);
    return range.from === requested.from && range.to === requested.to;
  } catch { return false; }
}

const token = String.raw`(?:\d{4}年)?\d{1,2}月\d{1,2}[日号]|\d{4}-\d{2}-\d{2}`;
function literalRange(message: string, now: Date, history: Pick<ChatMessage, "role" | "content">[]) {
  const text = message.normalize("NFKC");
  if (!/^(?:请)?(?:帮我)?(?:只)?(?:查|读|读取|核对|回顾)/u.test(text)
    || !/(?:原始日记|日记.{0,5}(?:原文|原话))/u.test(text)
    || /去年|前年|明年|后年|那年|当年|文件名|文件路径|目录|清单|[几\d一二三四五六七八九十]+篇/u.test(text)) return;
  const pairs = [...text.matchAll(new RegExp(`(${token})\\s*(?:到|至|—|–|~|～)\\s*(${token})`, "gu"))];
  if (pairs.length !== 1 || new RegExp(token, "u").test(text.replace(pairs[0][0], " "))) return;
  const [left, right] = pairs[0].slice(1), explicitYear = /^\d{4}(?:年|-)/u.test(left);
  if (!explicitYear && history.some(row => /去年|前年|明年|后年|那年|当年/u.test(row.content)
    || [...row.content.matchAll(/(\d{4})(?:年|[-/])/gu)].some(m => Number(m[1]) !== now.getFullYear()))) return;
  const day = (value: string, reference: string) => {
    const year = value.match(/^(\d{4})年/u);
    return normalizeJournalDate(year ? value.slice(year[0].length) : value, year ? year[1] + reference.slice(4) : reference);
  };
  const from = day(left, formatDate(now)), to = from && day(right, from);
  if (!from || !to || to <= from || to > addDays(from, 27)) return;
  return { from, to };
}

/** The user asked to read dated originals, not just discover file names.
 * Use the existing bounded evidence reader instead of fishing through lists. */
export function preferJournalOriginalReads(calls: AiToolCall[], message: string, now: Date,
  history: Pick<ChatMessage, "role" | "content">[] = []): AiToolCall[] {
  const range = literalRange(message, now, history);
  if (!range) return calls;
  const allowed = new Set(["domain", "operation", "range", "date", "limit", "sort"]);
  return calls.map(call => {
    const a = call.arguments;
    // A topic search inside an explicit original-reading window must retain
    // that window too. The evidence reader supplies full matching originals
    // and an owned date selection that a later "these two weeks" can resume.
    if (call.name === "query_vault" && a.domain === "journal" && a.operation === "search"
      && typeof a.query === "string" && a.query.trim() && a.query.length <= 120
      && Object.keys(a).every(key => allowed.has(key) || key === "query")
      && compatibleRange(a.range,range,now)
      && (a.limit === undefined || Number.isInteger(a.limit) && Number(a.limit) >= 1 && Number(a.limit) <= 100)
      && (a.sort === undefined || ["newest", "oldest"].includes(String(a.sort)))) {
      return { ...call, name: "get_summaries", arguments: { level: "day", range, includeOriginals: true, query: a.query } };
    }
    if (call.name !== "query_vault" || a.domain !== "journal" || a.operation !== "list"
      || Object.keys(a).some(key => !allowed.has(key))
      || !compatibleRange(a.range,range,now)
      || a.limit !== undefined && (!Number.isInteger(a.limit) || Number(a.limit) < 1 || Number(a.limit) > 100)
      || a.sort !== undefined && !["newest", "oldest"].includes(String(a.sort))) return call;
    return { ...call, name: "get_summaries", arguments: { level: "day", range, includeOriginals: true } };
  });
}
