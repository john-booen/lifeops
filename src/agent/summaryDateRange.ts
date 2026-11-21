import type { AiToolCall, ChatMessage } from "../ai";
import { formatDate, journalDateToken, normalizeJournalDate } from "../date";

/** Ground a model's year in a literal, unambiguous month/day range. Leave
 * explicit or contextual years, cross-year ranges and partial reads alone. */
export function requestedSummaryDates(calls: AiToolCall[], message: string, now: Date,
  history: Pick<ChatMessage, "role" | "content">[] = []): AiToolCall[] {
  const text = message.normalize("NFKC");
  const yearContext = /(?:\d{4}(?:年|[-/])|去年|前年|明年|后年|那年|当年)/u;
  if (yearContext.test(text) || history.some(row => yearContext.test(row.content.normalize("NFKC")))) return calls;
  const pairs = [...text.matchAll(new RegExp(`(${journalDateToken})\\s*(?:到|至|—|–|~|～|-)\\s*(${journalDateToken})`, "gu"))]
    .filter(match => match[1].includes("月") && match[2].includes("月"));
  if (pairs.length !== 1) return calls;
  const [from, to] = pairs[0].slice(1).map(token => normalizeJournalDate(token, formatDate(now)));
  if (!from || !to || to < from) return calls;
  return calls.map(call => {
    const range = call.arguments.range;
    if (call.name !== "get_summaries" || !range || typeof range !== "object" || Array.isArray(range)) return call;
    const current = range as Record<string, unknown>;
    if (typeof current.from !== "string" || typeof current.to !== "string"
      || normalizeJournalDate(current.from) !== current.from || normalizeJournalDate(current.to) !== current.to
      || current.from.slice(4) !== from.slice(4) || current.to.slice(4) !== to.slice(4)
      || current.from === from && current.to === to) return call;
    return { ...call, arguments: { ...call.arguments, range: { ...current, from, to } } };
  });
}
