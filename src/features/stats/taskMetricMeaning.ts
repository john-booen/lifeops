import { normalizeJournalDate } from "../../date";
import { TASK_METRIC_DEFINITIONS } from "./definitions";

/** Metric definitions are product facts, not free-form model interpretation. */
export function taskMetricMeaning(output: string): string | undefined {
  let row;
  try { row = JSON.parse(output); } catch { return; }
  if (!row || row.domain !== "tasks" || !row.range || typeof row.range.from !== "string" || typeof row.range.to !== "string"
    || normalizeJournalDate(row.range.from) !== row.range.from || normalizeJournalDate(row.range.to) !== row.range.to
    || row.range.from > row.range.to || JSON.stringify(row.metricDefinitions) !== JSON.stringify(TASK_METRIC_DEFINITIONS)
    || ![row.plannedCount,row.completedPlannedCount,row.completionIntervalSampleCount].every(value=>Number.isSafeInteger(value)&&value>=0)
    || row.completedPlannedCount>row.plannedCount
    || !(row.completionPercent===null&&row.plannedCount===0||Number.isFinite(row.completionPercent)&&row.completionPercent>=0&&row.completionPercent<=100)
    || !(row.averageCompletionMin===null&&row.completionIntervalSampleCount===0||Number.isFinite(row.averageCompletionMin)&&row.averageCompletionMin>=0&&row.completionIntervalSampleCount>0)) return;
  return [
    `${row.range.from} 至 ${row.range.to} · 任务统计口径`,
    `区间内计划 ${row.plannedCount} 项，计划内完成 ${row.completedPlannedCount} 项；${row.completionPercent===null?"没有计划样本，无法计算计划完成率":`计划完成率 ${row.completionPercent}%`}。`,
    TASK_METRIC_DEFINITIONS.completionPercent.description,
    row.averageCompletionMin===null?"没有有效登记到完成的间隔样本。":`登记到完成平均经过 ${row.averageCompletionMin} 分钟，有效样本 ${row.completionIntervalSampleCount} 条。`,
    TASK_METRIC_DEFINITIONS.averageCompletionMin.description,
    "实际工作、等待或睡眠各占多久尚未测量。",
    TASK_METRIC_DEFINITIONS.plannedTime.description,
    "以上只说明允许读取的登记记录，不代表未登记的现实活动。"+(row.scope?"本次部分记录不在允许范围内。":"")
  ].join("\n\n");
}
