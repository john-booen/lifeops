import { formatDate, startOfWeek } from "../../date";
import { readTradingDocument, tradingDocumentPath, tradingDocumentRevision } from "../../dataFoundation/tradingPersistence";
import { recordRevision } from "../../operationIdentity";
import { isVaultPathExcluded } from "../../privacy";
import type { StoreHost } from "../../store/settingsSlice";
import { visibleTradingVersion } from "../../tradingTools";
import { readTradeStatsData, selectTradeStatsData } from "../stats/tradeData";
import { tradeBreakEven, tradeStats, tradeStatsDate } from "../stats/trades";
import { tradeLabel } from "./inputs";
import type { Trade, TradeDatabase } from "./types";

export const TRADE_REVIEW_PERIODS = ["day", "week", "month"] as const;
export type TradeReviewPeriod = typeof TRADE_REVIEW_PERIODS[number];
export const TRADE_REVIEW_LABELS: Record<TradeReviewPeriod, string> = { day: "日", week: "周", month: "月" };

export function tradeReviewPeriod(period: TradeReviewPeriod, now: Date) {
  const to = formatDate(now);
  const from = period === "day" ? to : period === "week" ? startOfWeek(to) : `${to.slice(0, 7)}-01`;
  const slug = period === "day" ? to : period === "week" ? `周-${from}` : `月-${to.slice(0, 7)}`;
  return { from, to, slug, period };
}

function evidenceTrade(trade: Trade, root: string) {
  return { id: trade.id, label: tradeLabel(trade), date: tradeStatsDate(trade), market: trade.market, currency: trade.currency,
    pnl: trade.pnl ?? null, planned: trade.planned, modelId: trade.modelId, versionId: trade.modelVersionId,
    ruleViolations: trade.ruleViolations, ruleCheckStatus: trade.ruleCheckStatus, notes: trade.notes?.slice(0, 400),
    mirrorPath: `${root}/LifeOps交易/${trade.openedAt.slice(0, 10)}.md` };
}

export async function collectTradeReview(store: StoreHost, period: TradeReviewPeriod, now = new Date()) {
  const policy = reviewPolicy(store);
  const periodData = tradeReviewPeriod(period, now), input = await readTradeStatsData(store);
  const trades = input.trades.filter(trade => { const date = tradeStatsDate(trade); return date >= periodData.from && date <= periodData.to; });
  const violations = trades.filter(trade => trade.ruleViolations.length);
  const biggestLosses = (["CNY", "USD"] as const).flatMap(currency => {
    const threshold = tradeBreakEven(currency, input.settings.breakEven);
    return trades.filter(trade => trade.currency === currency && typeof trade.pnl === "number" && trade.pnl < 0 && -trade.pnl >= threshold)
      .sort((a, b) => a.pnl! - b.pnl! || a.id.localeCompare(b.id)).slice(0, 5);
  });
  const strengths = trades.filter(trade => trade.ruleCheckStatus === "checked" && !trade.ruleViolations.length && trade.planned !== false).slice(0, 5);
  const selected = [...new Map([...violations.slice(0, 30), ...biggestLosses, ...strengths].map(trade => [trade.id, trade])).values()];
  const evidence = selected.map(trade => evidenceTrade(trade, store.settings.folders.tradingReviews));
  const modelsPath = tradingDocumentPath(store);
  const models = selected.some(trade => trade.modelVersionId) && !isVaultPathExcluded(modelsPath, store.settings.privacy?.excludedVaultPrefixes)
    ? await readTradingDocument(store).catch(() => undefined) : undefined;
  const versions = new Set(selected.flatMap(trade => trade.modelVersionId ? [trade.modelVersionId] : []));
  const rules = models?.models.flatMap(model => model.versions.filter(version => versions.has(version.id) && visibleTradingVersion(store, version, models))
    .flatMap(version => (version.rules ?? []).map(rule => ({ modelId: model.id, versionId: version.id, modelName: version.title, ruleId: rule.id, text: rule.text })))) ?? [];
  const publicData = { period: periodData, stats: tradeStats(input.trades, periodData, undefined, input.settings),
    evidence, rules, violationCount: violations.length, additionalViolations: Math.max(0, violations.length - 30),
    largestLossIds: biggestLosses.map(trade => trade.id), filtered: input.filtered };
  if (reviewPolicy(store) !== policy) throw new Error("复盘资料权限已变化，请重新读取。");
  return { ...publicData, tradePath: input.path, tradeRevision: recordRevision(input), modelRevision: models && tradingDocumentRevision(models), policy };
}

export type TradeReviewData = Awaited<ReturnType<typeof collectTradeReview>>;

export async function assertTradeReviewCurrent(store: StoreHost, review: TradeReviewData): Promise<void> {
  if (reviewPolicy(store) !== review.policy) throw new Error("复盘资料权限已变化，请重新生成。");
  const raw = await store.readJson<TradeDatabase>(review.tradePath, { version: 1, trades: [] });
  if (recordRevision(selectTradeStatsData(store, review.tradePath, raw)) !== review.tradeRevision
    || review.modelRevision && tradingDocumentRevision(await readTradingDocument(store)) !== review.modelRevision) {
    throw new Error("复盘依据的交易或规则已变化，请重新生成。");
  }
}

function reviewPolicy(store: StoreHost): string {
  return recordRevision([store.settings.folders, store.settings.privacy, store.settings.tradingSourceFolders]);
}

export function formatRecordedTradeDiscipline(output: string): string | undefined {
  const { evidence, rules, filtered } = JSON.parse(output) as Pick<TradeReviewData, "evidence" | "rules" | "filtered">;
  if (!Array.isArray(evidence) || !Array.isArray(rules)) return;
  for (const trade of evidence) {
    const rule = rules.find(item => item.modelId === trade.modelId && item.versionId === trade.versionId
      && trade.ruleViolations.includes(item.ruleId));
    if (!rule) continue;
    const { label, date } = trade;
    const scope = filtered ? "在可读取的记录里，" : "";
    return `${scope}${date} 的 ${label}有一条已记录的违规。对应的是「${rule.modelName}」中的「${rule.text.replace(/[。！？.!?]+$/u, "")}」。下次在 LifeOps 的交易备注记下这条规则是否触发和当时的处理，再用该笔回执核对。`;
  }
}

export function tradeReviewPromptData(review: TradeReviewData, focus?: "rules"): string {
  if (focus === "rules") {
    const evidence = review.evidence.filter(trade => trade.ruleViolations.length).map(trade => ({
      id: trade.id, date: trade.date, label: trade.label, modelId: trade.modelId, versionId: trade.versionId,
      ruleViolations: trade.ruleViolations, notes: trade.notes
    }));
    return JSON.stringify({ period: review.period, evidence, rules: review.rules, violationCount: review.violationCount,
      additionalViolations: review.additionalViolations, filtered: review.filtered });
  }
  const { tradePath: _tradePath, tradeRevision: _tradeRevision, modelRevision: _modelRevision, policy: _policy, ...input } = review;
  return JSON.stringify(input);
}
