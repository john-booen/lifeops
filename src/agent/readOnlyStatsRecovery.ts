import { normalizeJournalDate } from "../date";
import { recordRevision } from "../operationIdentity";
import { assertProviderActive } from "../providerRun";
import type { StoreHost } from "../store/settingsSlice";
import { readStats } from "../features/stats/tools";
import { hasPendingFactOperation, waitForFactOperations } from "../dataFoundation/factOperation";
import { readPersonalMemoryWithSources } from "../personalMemorySources";
import { createPersonalMemoryContextFilter, personalMemoryContextRevision } from "../personalMemoryContext";
import { TASK_CATEGORIES } from "../features/tasks/capacity";

export interface StatsRecoveryRead { arguments: Record<string, unknown>; output: string }
type Row = Record<string, unknown>;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function rangeOf(data: Row) {
  const range = data.range as Row | undefined;
  if (!range || typeof range.from !== "string" || typeof range.to !== "string"
    || normalizeJournalDate(range.from) !== range.from || normalizeJournalDate(range.to) !== range.to || range.to < range.from) return;
  return { from: range.from, to: range.to };
}
function taskLine(row: Row, interval = false): string | undefined {
  const { plannedCount: planned, completedPlannedCount: completed, completedCount: total, completionPercent: percent } = row;
  if (!count(planned) || !count(completed) || completed > planned || !count(total)
    || !(percent === null && planned === 0 || finite(percent) && percent >= 0 && percent <= 100)) return;
  const summary = `计划 ${planned} 项，计划内完成 ${completed} 项，${percent === null ? "无计划样本，无法计算完成率" : `计划完成率 ${percent}%`}；区间内登记完成 ${total} 项。`;
  if (!interval) return summary;
  if (row.averageCompletionMin === null && row.completionIntervalSampleCount === 0) return summary + "无有效完成间隔样本。";
  if (!finite(row.averageCompletionMin) || row.averageCompletionMin < 0 || !count(row.completionIntervalSampleCount) || !row.completionIntervalSampleCount) return;
  return summary + `登记到完成平均经过 ${row.averageCompletionMin} 分钟（${row.completionIntervalSampleCount} 个有效样本，含等待和跨日，不是实测工时，不能据此判断拖延或临时需求挤占）。`;
}
function tradeLines(row: Row): string[] | undefined {
  const byCurrency = row.byCurrency as Record<string, Row> | undefined;
  if (!byCurrency) return;
  const lines: string[] = [];
  for (const [currency, name, unit] of [["CNY", "人民币", "元"], ["USD", "美元", "美元"]]) {
    const part = byCurrency[currency];
    if (!part || !count(part.count) || !count(part.knownPnlCount) || !count(part.unknownPnlCount)
      || part.knownPnlCount + part.unknownPnlCount !== part.count) return;
    if (!part.count) lines.push(`${name}：未登记交易，不能据此判断实际盈亏。`);
    else if (!part.knownPnlCount) lines.push(`${name}：登记 ${part.count} 笔，盈亏未记录，无法计算净盈亏。`);
    else {
      if (!finite(part.totalPnl)) return;
      lines.push(`${name}：登记 ${part.count} 笔，已知 ${part.knownPnlCount} 笔净盈亏 ${part.totalPnl} ${unit}`
        + (part.unknownPnlCount ? `，另 ${part.unknownPnlCount} 笔盈亏未知。` : "。"));
    }
  }
  return lines;
}
function formatStats(data: Row, args: Record<string, unknown>): string | undefined {
  const range = rangeOf(data);
  if (!range) return;
  const lines: string[] = [`${range.from} 至 ${range.to} · ${data.domain === "tasks" ? "任务" : "交易"}`];
  const summary = data.domain === "tasks" ? taskLine(data, true) : tradeLines(data);
  if (!summary) return;
  lines.push(...typeof summary === "string" ? [summary] : summary);
  if (data.domain === "trades") {
    if (!count(data.count)) return;
    lines.push(`已登记交易 ${data.count} 笔。`);
    if (typeof data.dateBasis === "string") lines.push(data.dateBasis + "。");
  }
  const category = data.domain === "tasks" && args.groupBy === "category" && data.byCategory && typeof data.byCategory === "object"
    ? Object.entries(data.byCategory).map(([key, value]) => ({ key, ...(value as Row) })) : undefined;
  const groups = category ?? data.groups;
  if (Array.isArray(groups) && groups.length) {
    const grouping: Record<string, string> = { day: "逐日", week: "按周（从下列日期开始，限所问区间）", month: "按月",
      category: "按分类", market: "按市场", symbol: "按品种", model: "按模型", direction: "按方向" };
    lines.push(grouping[String(args.groupBy)] ?? "分组");
    const detail: string[] = [];
    for (const row of groups) {
      if (!row || typeof row !== "object") return;
      let key = row.label ?? row.key ?? row.date;
      if (typeof key !== "string") return;
      if (category && Object.hasOwn(TASK_CATEGORIES, key)) key = TASK_CATEGORIES[key as keyof typeof TASK_CATEGORIES];
      if (args.groupBy === "direction") key = key === "long" ? "做多" : key === "short" ? "做空" : key;
      const label = key.replace(/[\r\n\u0000-\u001f]/gu, " ").trim();
      const values = data.domain === "tasks" ? taskLine(row) : tradeLines(row);
      if (!label || !values) return;
      detail.push(label + "：" + (typeof values === "string" ? values : values.join(" ")));
    }
    // Keep complete numerical rows, never a clipped number or an apparent full list.
    if (detail.join("\n").length <= 12_000) lines.push(...detail);
    else lines.push("分组内容较长，本次先列登记汇总；完整分组尚未整理。");
  }
  if (data.scope) lines.push("以上仅包含当前允许读取的部分记录。");
  return lines.join("\n");
}

/** Recompute local statistics twice; never reuse stale model prose, repeat a
 * provider request, or replay a business write after generation failed. */
export async function recoverReadOnlyStats(store: StoreHost, reads: StatsRecoveryRead[], now: Date,
  assertCurrent: () => void, signal?: AbortSignal): Promise<string | undefined> {
  if (!reads.length || reads.some(read => !["tasks", "trades"].includes(String(read.arguments.domain))
    || read.arguments.combineUsd === true || read.arguments.rankByNetPnl === true)) return;
  const settings = recordRevision(store.settings);
  const current = () => {
    assertProviderActive(signal); assertCurrent();
    if (recordRevision(store.settings) !== settings) throw Error("统计读取设置已变化。");
  };
  const unique = [...new Map(reads.map(read => [recordRevision(read.arguments), read])).values()];
  const settled = async () => {
    await waitForFactOperations(store, { signal, assertCurrent: current });
    if (await hasPendingFactOperation(store)) return false;
    current(); return true;
  };
  const readRound = async () => {
    const outputs: string[] = [];
    for (const read of unique) {
      current();
      const result = await readStats(store, structuredClone(read.arguments), now);
      current();
      if (!result.success || result.actions.length || "receipt" in result && result.receipt !== undefined) return;
      const original = JSON.parse(read.output) as Row, fresh = JSON.parse(result.output) as Row;
      if (original.domain !== fresh.domain || recordRevision(rangeOf(original)) !== recordRevision(rangeOf(fresh)) || !rangeOf(fresh)) return;
      outputs.push(result.output);
    }
    return outputs;
  };
  current();
  if (!await settled()) return;
  const memory = await readPersonalMemoryWithSources(store);
  current();
  const first = await readRound();
  if (!await settled()) return;
  const second = first && await readRound();
  if (!await settled()) return;
  current();
  if (!first || !second || first.length !== second.length || first.some((value, index) => value !== second[index])) return;
  const latestMemory = await readPersonalMemoryWithSources(store);
  current();
  if (personalMemoryContextRevision(memory.records, now) !== personalMemoryContextRevision(latestMemory.records, now)) return;
  const blocks = second.map((output, index) => formatStats(JSON.parse(output), unique[index].arguments));
  if (blocks.some(block => !block)) return;
  current();
  const report = ["模型后续分析中断，先列出重新核对的登记统计摘要：", ...blocks,
    "这里只覆盖已登记记录，未登记情况未知；其余分析尚未完成。"].join("\n\n");
  return createPersonalMemoryContextFilter(latestMemory.records)(report) === report ? report : undefined;
}
