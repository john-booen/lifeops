import { memorySourcePolicy } from "../personalMemorySources";
import { isOwnedStoredQueryRead } from "../storedQueryRead";
import type { StoreHost } from "../store/settingsSlice";
import type { VaultQueryRead } from "../vaultQueryRead";

/** A prior read's date selection, never its answer, evidence or authorization. */
export interface SummaryQueryRange { level: "day" | "week" | "month"; range: { from: string; to: string } }
export type SummaryQueryScope = object;
const scopes = new WeakMap<SummaryQueryScope, { vault: object; policy: string; selection: SummaryQueryRange }>();
const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;

export function captureSummaryQueryScope(store: StoreHost, read: VaultQueryRead): SummaryQueryScope | undefined {
  if (!isOwnedStoredQueryRead(store, read, "get_summaries")) return;
  try {
    read.assertCurrent();
    const data = JSON.parse(read.text), range = data?.range;
    if (!["day", "week", "month"].includes(data?.level) || !day(range?.from) || !day(range?.to) || range.from > range.to) return;
    const token = Object.freeze({});
    scopes.set(token, { vault: store.app.vault, policy: memorySourcePolicy(store), selection: { level: data.level, range: { from: range.from, to: range.to } } });
    return token;
  } catch { return; }
}

export function summaryQuerySelections(store: StoreHost, tokens: readonly SummaryQueryScope[]): SummaryQueryRange[] {
  // Refuse an incomplete selection rather than silently carry only one side of a comparison.
  if (!tokens.length || tokens.length > 8) return [];
  const selected = new Map<string, SummaryQueryRange>();
  for (const token of tokens) {
    const owned = scopes.get(token);
    if (!owned || owned.vault !== store.app.vault || owned.policy !== memorySourcePolicy(store)) return [];
    selected.set(JSON.stringify(owned.selection), structuredClone(owned.selection));
  }
  return [...selected.values()];
}
