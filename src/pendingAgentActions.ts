import type { AgentActionSuggestion } from "./types";

export const PENDING_ACTION_CONFLICT_NOTICE = "已保留你尚未处理的原确认卡。新回复中同编号的不同建议没有替换它，请处理原卡后再生成新建议。";

/** A displayed card keeps its meaning until the user handles it. New IDs append in order. */
export function mergePendingAgentActions(
  existing: AgentActionSuggestion[],
  incoming: AgentActionSuggestion[]
): { actions: AgentActionSuggestion[]; conflictingIds: string[] } {
  const actions = existing.slice();
  const byId = new Map(existing.map(action => [action.id, action]));
  const conflictingIds = new Set<string>();
  for (const action of incoming) {
    const prior = byId.get(action.id);
    if (prior) {
      if (stableContent(prior) !== stableContent(action)) conflictingIds.add(action.id);
      continue;
    }
    actions.push(action);
    byId.set(action.id, action);
  }
  return { actions, conflictingIds: [...conflictingIds] };
}

function stableContent(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableContent).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableContent(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
