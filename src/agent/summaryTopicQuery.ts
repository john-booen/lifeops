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

/** Drop only a model-added suffix after a substantial literal Chinese task topic. */
export function requestedTaskTopics(calls: AiToolCall[], message: string): AiToolCall[] {
  const text = message.normalize("NFKC").toLocaleLowerCase();
  if (text.length > 4000) return calls;
  return calls.map(call => {
    const query = call.arguments.query;
    if (call.name !== "list_tasks" || typeof query !== "string" || query.length > 120) return call;
    const normalized = query.normalize("NFKC").toLocaleLowerCase();
    if (text.includes(normalized)) return call;
    for (let end = normalized.length - 1; end >= 4; end--) {
      const literal = normalized.slice(0, end);
      if ((literal.match(/\p{Script=Han}/gu) ?? []).length >= 4 && text.includes(literal)) {
        return { ...call, arguments: { ...call.arguments, query: literal } };
      }
    }
    return call;
  });
}
