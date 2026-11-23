import type { AiToolCall } from "../ai";
import type { SummaryQueryRange } from "./summaryQueryScope";

/** Resolve a demonstrative date reference against owned read selections. This
 * changes only a summary read's date parameter, never the user's intent, topic,
 * facts, permissions or a write tool. A new explicit date selection wins. */
export function bindHistoricalDateReference(calls: AiToolCall[], message: string,
  selected: readonly SummaryQueryRange[]): AiToolCall[] {
  const text = message.normalize("NFKC");
  const reference = /(?:这|那)(?:两|二|三|四|五|六|七|八|九|十|\d+)(?:个)?(?:周|星期|月|天)|(?:上述|前述|刚才|此前|同一)(?:的)?(?:日期)?(?:范围|区间)/u;
  // These are date tokens, not an intent router. Future planning references
  // such as “下周建议” do not replace the historical dates being compared.
  const newDates = /\d{4}(?:年|[-/])\d|\d{1,2}月|\d{1,2}[日号]|(?:上|本)(?:个)?(?:周|星期|月)|今天|昨天|前天|最近|过去|去年|前年|明年|后年/u;
  if (!selected.length || selected.length > 8 || !reference.test(text) || newDates.test(text)) return calls;
  // A request for one part of the prior period still needs its own selection.
  if (/(?:其中|第|前一|后一|最后一|最早一)(?:[一二三四五六七八九十\d]+)?(?:周|星期|月|天)/u.test(text)) return calls;
  return calls.flatMap(call => {
    const a = call.arguments;
    const journal = call.name === "query_vault" && a.domain === "journal"
      && (a.operation === "list" && a.query === undefined || a.operation === "search" && typeof a.query === "string" && !!a.query.trim() && a.query.length <= 120)
      && Object.keys(a).every(key => ["domain", "operation", "query", "date", "range", "sort", "limit"].includes(key))
      && (a.limit === undefined || Number.isInteger(a.limit) && Number(a.limit) >= 1 && Number(a.limit) <= 100)
      && (a.sort === undefined || ["newest", "oldest"].includes(String(a.sort)))
      && (a.range === undefined || ["today", "week", "month", "all"].includes(String(a.range)));
    if (call.name !== "get_summaries" && !journal) return [call];
    return selected.map((scope, index) => ({
      ...call, name: "get_summaries", id: call.id ? `${call.id}:checked-range:${index}` : undefined,
      arguments: journal ? { level: scope.level, range: { ...scope.range }, includeOriginals: true,
        ...(typeof a.query === "string" ? { query: a.query } : {}) }
        : { ...a, level: scope.level, range: { ...scope.range } }
    }));
  });
}
