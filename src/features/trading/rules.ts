import { safeProjectPath } from "../../projectContinuity";

export const TRADING_RULE_KINDS = ["entry", "exit", "risk", "discipline"] as const;
export type TradingRuleKind = (typeof TRADING_RULE_KINDS)[number];
export interface TradingRule {
  id: string;
  text: string;
  kind: TradingRuleKind;
  checkable: boolean;
  sourcePath: string;
  quote: string;
  reviewPath?: string;
}

export function validTradingRules(value: unknown): value is TradingRule[] {
  if (!Array.isArray(value) || value.length > 20) return false;
  const ids = new Set<string>();
  for (const rule of value) {
    if (!rule || typeof rule !== "object" || typeof rule.id !== "string" || !rule.id || ids.has(rule.id)
      || typeof rule.text !== "string" || !rule.text.trim() || rule.text.length > 400
      || !TRADING_RULE_KINDS.includes(rule.kind) || typeof rule.checkable !== "boolean"
      || typeof rule.sourcePath !== "string" || !safeProjectPath(rule.sourcePath)
      || (rule.reviewPath !== undefined && (typeof rule.reviewPath !== "string" || !safeProjectPath(rule.reviewPath)))
      || typeof rule.quote !== "string" || !rule.quote.trim() || rule.quote.length > 600) return false;
    ids.add(rule.id);
  }
  return true;
}

export function formatTradingRule(rule: TradingRule): string {
  const kinds: Record<TradingRuleKind, string> = { entry: "入场", exit: "退出", risk: "风险", discipline: "纪律" };
  return `${rule.id} · ${kinds[rule.kind]}${rule.checkable ? " · 可核对" : " · 需人工判断"} · ${rule.text}（原规则 ${rule.sourcePath}${rule.reviewPath ? `，复盘建议 ${rule.reviewPath}` : ""}）`;
}
