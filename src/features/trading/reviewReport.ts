import { TRADE_REVIEW_LABELS, type TradeReviewData } from "./reviewData";

export const TRADE_REVIEW_MARKER = "<!-- lifeops:trade-review:v1 -->";
export const TRADE_REVIEW_ACTION = "lifeops-trade-review-action";

type Finding = { text: string; tradeIds: string[] };
export type TradeReviewAction = { kind: "task"; title: string } | {
  kind: "rule"; title: string; modelId: string; versionId: string; ruleId: string; revisedText: string;
};
interface ReviewAnalysis { good: Finding[]; issues: Finding[]; suggestions: TradeReviewAction[]; checklist: string[] }

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const plain = (value: unknown, limit: number): string => typeof value === "string" ? value.trim().replace(/[\r\n]+/g, " ").slice(0, limit) : "";

export function parseTradeReviewAction(value: unknown): TradeReviewAction | undefined {
  const action = object(value), title = plain(action?.title, 160);
  if (action?.kind === "task" && title) return { kind: "task", title };
  if (action?.kind !== "rule" || !title) return undefined;
  const modelId = plain(action.modelId, 100), versionId = plain(action.versionId, 100), ruleId = plain(action.ruleId, 100);
  const revisedText = plain(action.revisedText, 400);
  return modelId && versionId && ruleId && revisedText ? { kind: "rule", title, modelId, versionId, ruleId, revisedText } : undefined;
}

export const TRADE_REVIEW_FALLBACK = JSON.stringify({ good: [], issues: [], suggestions: [],
  checklist: ["核对未填写的交易盈亏、平仓时刻和规则依据。"] });

export function parseTradeReviewAnalysis(text: string, data: TradeReviewData): ReviewAnalysis {
  const parsed = object(JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "")));
  if (!parsed || !Array.isArray(parsed.good) || !Array.isArray(parsed.issues) || !Array.isArray(parsed.suggestions) || !Array.isArray(parsed.checklist)) {
    throw new Error("交易复盘分析格式不完整。");
  }
  const ids = new Set(data.evidence.map(row => row.id));
  const findings = (rows: unknown[]): Finding[] => rows.slice(0, 8).flatMap(row => {
    const item = object(row), text = plain(item?.text, 400);
    const rawIds = item?.tradeIds;
    const references = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === "string" && ids.has(id)) : [];
    return text && references.length && Array.isArray(rawIds) && references.length === rawIds.length ? [{ text, tradeIds: [...new Set(references)] }] : [];
  });
  const suggestions = parsed.suggestions.slice(0, 8).flatMap(value => {
    const action = parseTradeReviewAction(value);
    if (!action || action.kind === "rule" && !data.rules.some(rule => rule.modelId === action.modelId
      && rule.versionId === action.versionId && rule.ruleId === action.ruleId)) return [];
    return [action];
  });
  return { good: findings(parsed.good), issues: findings(parsed.issues), suggestions,
    checklist: parsed.checklist.slice(0, 8).map(value => plain(value, 180)).filter(Boolean) };
}

function markdownText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\[\]*_`|]/g, "\\$&");
}
const metric = (value: number | null) => value === null ? "未知" : String(value);
const percent = (value: number | null) => value === null ? "未知" : `${value}%`;

export function renderTradeReview(data: TradeReviewData, analysis: ReviewAnalysis, local = false): string {
  const { period, stats } = data;
  const evidence = new Map(data.evidence.map(row => [row.id, row]));
  const findings = (rows: Finding[]) => rows.map(row => `- ${markdownText(row.text)}（${row.tradeIds.map(id => evidenceLabel(evidence.get(id)!)).join("；")}）`);
  const lines = [`# ${TRADE_REVIEW_LABELS[period.period]}交易复盘 ${period.from} 至 ${period.to}`, "",
    ...(local ? ["> 本地生成的结构化草稿。", ""] : []), "## 本期数字", `- 交易 ${stats.count} 笔。${stats.dateBasis}。`];
  for (const currency of ["CNY", "USD"] as const) {
    const row = stats.byCurrency[currency];
    lines.push(`- ${currency} ${row.count} 笔，盈 ${row.winCount}、亏 ${row.lossCount}、平 ${row.flatCount}、未知 ${row.unknownPnlCount}，胜率 ${percent(row.winPercent)}，总盈亏 ${metric(row.totalPnl)}。`,
      `  - 平均赢 ${metric(row.averageWin)}，平均亏 ${metric(row.averageLoss)}，盈亏比 ${metric(row.payoffRatio)}，利润因子 ${metric(row.profitFactor)}，期望 ${metric(row.expectancy)}，平均 R ${metric(row.averageR)}。`,
      `  - 最大回撤 ${metric(row.maxDrawdown)}，最长连亏 ${metric(row.longestLosingStreak)}，平仓序列省略 ${row.excludedFromClosedSequenceCount} 笔。规则遵守率 ${percent(row.ruleAdherencePercent)}，未核对 ${row.unverifiedRuleCount} 笔，计划外 ${percent(row.outOfPlanPercent)}，计划未知 ${row.unknownPlanCount} 笔。`);
  }
  if (data.filtered) lines.push("- 统计仅使用允许读取的交易。");
  lines.push("", "## 做得好的", ...(analysis.good.length ? findings(analysis.good) : ["- 本期记录未提供足够依据。"]), "", "## 问题");
  lines.push(...findings(analysis.issues));
  for (const row of data.evidence) if (row.ruleViolations.length) {
    lines.push(`- 已核对偏离 ${markdownText(row.ruleViolations.join("、"))}（${evidenceLabel(row)}）。`);
  }
  for (const id of data.largestLossIds) lines.push(`- 本币种较大亏损（${evidenceLabel(evidence.get(id)!)}）。`);
  if (data.additionalViolations) lines.push(`- 另有 ${data.additionalViolations} 笔偏离未在本页展开。`);
  if (!analysis.issues.length && !data.violationCount && !data.largestLossIds.length) lines.push("- 暂无可以引用的偏离或较大亏损记录。");
  lines.push("", "## 交易系统改进建议");
  if (!analysis.suggestions.length) lines.push("- 暂无可核对的规则修改建议。");
  for (const action of analysis.suggestions) {
    const rule = action.kind === "rule" ? data.rules.find(item => item.modelId === action.modelId && item.ruleId === action.ruleId && item.versionId === action.versionId) : undefined;
    lines.push(`- ${markdownText(action.title)}${rule ? `（${markdownText(rule.modelName)} · ${markdownText(rule.ruleId)}）` : ""}`, "",
      `\`\`\`${TRADE_REVIEW_ACTION}`, JSON.stringify(action).replace(/\x60/g, "\\u0060"), "\`\`\`", "");
  }
  lines.push("", "## 下期检查清单", ...analysis.checklist.map(item => `- [ ] ${markdownText(item)}`));
  return lines.join("\n") + "\n";
}

function evidenceLabel(row: TradeReviewData["evidence"][number]): string {
  return `${row.date} ${markdownText(row.label)} · ${row.id} · ${row.pnl === null ? "盈亏未知" : `${row.pnl} ${row.currency}`}`;
}
