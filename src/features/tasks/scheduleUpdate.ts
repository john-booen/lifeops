import { normalizeJournalDate } from "../../date";
import { timeMinutes, validateTaskSchedule } from "../../taskSchedule";
import type { LifeOpsTask } from "../../types";

export const TASK_PLAN_FIELDS = ["date", "endDate", "time", "startTime", "endTime", "scheduleMode"] as const;

/** Apply only supplied plan fields; task identity, completion and deadline remain untouched. */
export function taskPlanUpdate(before: LifeOpsTask, row: Record<string, unknown>): Partial<LifeOpsTask> {
  const supplied = TASK_PLAN_FIELDS.filter(key => row[key] !== undefined);
  if (!supplied.length) return {};
  if (before.status !== "active") throw Error("已完成的任务不重新排程，本次整批未修改。");
  const patch: Partial<LifeOpsTask> = {};
  for (const key of supplied) {
    const value = row[key];
    if (typeof value !== "string") throw Error("计划日期和时刻须为文字，本次整批未修改。");
    const text = value.trim();
    if (key === "scheduleMode") {
      if (text !== "fixed" && text !== "window") throw Error("任务安排方式须为fixed或window，本次整批未修改。");
      patch.scheduleMode = text;
    } else if (key === "date" || key === "endDate") {
      const date = text ? normalizeJournalDate(text) : "";
      if (text && !date || key === "date" && !date) throw Error("请提供有效的计划日期，本次整批未修改。");
      patch[key] = date;
    } else {
      if (text && timeMinutes(text) === undefined) throw Error("计划时刻须为有效HH:mm，本次整批未修改。");
      patch[key] = text;
    }
  }
  const next = { ...before, ...patch };
  if (patch.time && (next.startTime || next.endTime)) throw Error("这条任务已有计划区间，请修改开始和结束时刻，本次整批未修改。");
  if (next.endDate && next.endDate < next.date) throw Error("计划结束日期不能早于开始日期，本次整批未修改。");
  validateTaskSchedule(next);
  return patch;
}
