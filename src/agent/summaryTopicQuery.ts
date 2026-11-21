import type { AiToolCall } from "../ai";

/** Prefer literal topic words over extra model-invented AND filters. If this
 * turn names no proposed term, retain the contextual query rather than guess. */
export function requestedSummaryTopics(calls: AiToolCall[], message: string): AiToolCall[] {
  const text = message.normalize("NFKC").toLocaleLowerCase();
  return calls.map(call => {
    const query = call.arguments.query;
    if (call.name !== "get_summaries" || typeof query !== "string" || query.length > 120) return call;
    const terms = query.trim().split(/\s+/u);
    if (terms.length < 2 || terms.length > 8) return call;
    const literal = terms.filter(term => text.includes(term.normalize("NFKC").toLocaleLowerCase()));
    if (!literal.length || literal.length === terms.length) return call;
    return { ...call, arguments: { ...call.arguments, query: literal.join(" ") } };
  });
}
