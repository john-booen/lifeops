import { readTradingDocument, tradingDocumentPath } from "../../dataFoundation/tradingPersistence";
import { isVaultPathExcluded } from "../../privacy";
import type { StoreHost } from "../../store/settingsSlice";
import { visibleTradingVersion } from "../../tradingTools";
import { chatTradeDraft, discardUnstatedTradePnl } from "./inputs";
import type { TradeDraft } from "./types";

export async function assessChatTrade(store: StoreHost, row: unknown, userMessage = ""): Promise<TradeDraft> {
  if (!row || typeof row !== "object" || Array.isArray(row)) return chatTradeDraft(row);
  const { ruleChecks, ...fields } = row as Record<string, unknown>;
  const draft = chatTradeDraft(discardUnstatedTradePnl(fields, userMessage), undefined, userMessage);
  if (!draft.modelId && !draft.modelVersionId) return draft;
  const insufficient = { ...draft, ruleCheckStatus: "insufficient" as const };
  if (isVaultPathExcluded(tradingDocumentPath(store), store.settings.privacy?.excludedVaultPrefixes)) return insufficient;
  const document = await readTradingDocument(store).catch(() => undefined);
  if (!document) return insufficient;
  const exact = document.models.find(model => model.id === draft.modelId);
  const candidates = exact ? [exact] : document.models.filter(model => draft.modelId ? model.versions.at(-1)?.title === draft.modelId
    : model.versions.some(version => version.id === draft.modelVersionId));
  if (candidates.length !== 1) return insufficient;
  const model = candidates[0];
  const version = draft.modelVersionId ? model.versions.find(item => item.id === draft.modelVersionId) : model.versions.at(-1);
  if (!version || !visibleTradingVersion(store, version, document)) return insufficient;
  const checks = new Map<string, "pass" | "violation">();
  const duplicate = new Set<string>();
  for (const check of Array.isArray(ruleChecks) ? ruleChecks : []) {
    if (!check || typeof check.id !== "string" || !["pass", "violation"].includes(check.status)
      || typeof check.quote !== "string" || !check.quote.trim() || !userMessage.includes(check.quote)) continue;
    if (checks.has(check.id)) duplicate.add(check.id);
    checks.set(check.id, check.status);
  }
  const rules = version.rules ?? [];
  const verified = rules.filter(rule => rule.checkable && checks.has(rule.id) && !duplicate.has(rule.id));
  return { ...draft, modelId: model.id, modelVersionId: version.id,
    ruleViolations: verified.filter(rule => checks.get(rule.id) === "violation").map(rule => rule.id),
    ruleCheckStatus: rules.length > 0 && verified.length === rules.length ? "checked" : "insufficient" };
}
