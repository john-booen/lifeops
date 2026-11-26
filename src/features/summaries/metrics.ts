/** Shared schema stays usable in tool catalogues and headless runtimes without Obsidian. */
export const SUMMARY_TASK_METRIC_BASIS = "completion_registration_distinct_v1";
export type SummaryMetrics = {
  taskCompletionPercent: number | null;
  tasksCompleted: number | null;
  /** Absent on legacy summaries; never infer distinct task IDs from events. */
  taskCompletionEvents?: number | null;
  energy: number | null;
  tradePnlCny: number | null;
  tradePnlUsd: number | null;
};
export const summaryMetricNames = ["tasksCompleted", "taskCompletionEvents", "taskCompletionPercent", "energy", "tradePnlCny", "tradePnlUsd"] as const satisfies readonly (keyof SummaryMetrics)[];
export type TaskMetrics = Pick<SummaryMetrics, "tasksCompleted" | "taskCompletionEvents" | "taskCompletionPercent">;
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
export function taskSummaryMetrics(stats: { completedTaskCount?: unknown; completedCount?: unknown; completionPercent?: unknown } | null): TaskMetrics {
  return { tasksCompleted: numeric(stats?.completedTaskCount), taskCompletionEvents: numeric(stats?.completedCount),
    taskCompletionPercent: numeric(stats?.completionPercent) };
}
