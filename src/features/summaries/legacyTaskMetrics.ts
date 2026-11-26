import { readContextTasks } from "../../contextData";
import { formatDate, normalizeJournalDate } from "../../date";
import type { StoreHost } from "../../store/settingsSlice";
import type { VaultQueryReader } from "../../vaultQueryRead";
import { getStats } from "../stats/stats";
import { taskSummaryMetrics, SUMMARY_TASK_METRIC_BASIS } from "./metrics";
import type { SavedSummary } from "./notes";
import type { SummaryPeriod } from "./periods";

export const summaryTaskMetricNames = ["tasksCompleted", "taskCompletionEvents", "taskCompletionPercent"] as const;

/** Upgrade the read projection only. Historical summary files and task records remain untouched. */
export function legacySummaryTaskMetricReader(store: StoreHost, reader: VaultQueryReader, now: Date) {
  let tasks: ReturnType<typeof readContextTasks> | undefined;
  return async (note: SavedSummary, period: SummaryPeriod) => {
    const through = note.properties.through;
    let metrics = taskSummaryMetrics(null);
    const source: { kind: string; from: string; through: string; partial?: boolean; explanation: string } = {
      kind: "unavailable", from: period.from, through,
      explanation: "旧摘要的任务数字口径未注明；暂无法按原记录核对，任务指标为未知。旧正文保留，不能据其数字覆盖返回指标。"
    };
    if (normalizeJournalDate(through, formatDate(now)) === through && through >= period.from && through <= period.to && through <= formatDate(now)) {
      const data = await (tasks ??= readContextTasks(store));
      for (const read of data.reads ?? []) reader.dependOn(read.path, read.hash);
      if (data.available) {
        const stats = getStats({ domain: "tasks", range: { from: period.from, to: through } }, { tasks: data.tasks }, now);
        if (stats.domain !== "tasks") throw Error("任务指标来源不匹配。");
        metrics = taskSummaryMetrics(stats);
        source.kind = "task_records_read_only"; source.partial = !!data.filtered;
        source.explanation = "任务指标已按当前允许读取的原任务记录、旧摘要原覆盖区间只读重算，可能包含后补记录；旧正文与其他指标保留，不是重新生成摘要。旧正文中的任务数字不能覆盖本次返回指标。";
        if (data.source) reader.contributed(data.source.path, JSON.stringify({ period: period.key, range: stats.range, metrics, partial: source.partial }));
      }
    }
    return { metrics, taskMetricBasis: SUMMARY_TASK_METRIC_BASIS, taskMetricsSource: source };
  };
}
