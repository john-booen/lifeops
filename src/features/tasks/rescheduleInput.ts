import { formatDate, normalizeJournalDate } from "../../date";
import { shiftTaskDates, timeMinutes, validateTaskSchedule } from "../../taskSchedule";
import type { LifeOpsTask } from "../../types";

/** A move changes the plan, preserving its span and any independent deadline. */
export function rescheduledTaskPlan(before: LifeOpsTask, args: Record<string, unknown>, baseDate = formatDate(new Date())): Partial<LifeOpsTask> {
  const date = args.date === undefined ? undefined : typeof args.date === "string" ? normalizeJournalDate(args.date, baseDate) : "";
  const time = args.time;
  if (date === "" || date === undefined && time === undefined) throw Error("请明确有效的新日期或时刻。");
  if (time !== undefined && (typeof time !== "string" || timeMinutes(time) === undefined)) throw Error("请提供有效的计划时刻，例如 15:15。");
  if (time !== undefined && before.endTime) throw Error("这条任务已有计划结束时刻，请在事务中核对并修改计划区间。");
  const patch: Partial<LifeOpsTask> = {};
  if (date !== undefined && date !== before.date) {
    const days = (Date.parse(date + "T00:00:00Z") - Date.parse((before.date || baseDate) + "T00:00:00Z")) / 86_400_000;
    if (!Number.isSafeInteger(days)) throw Error("原任务日期无法核对，已保留原安排。");
    patch.date = date;
    if (before.endDate) patch.endDate = shiftTaskDates({...before, date: before.date || baseDate}, days).endDate;
  } else if (date !== undefined) patch.date = date;
  if (typeof time === "string") patch[before.startTime ? "startTime" : "time"] = time;
  validateTaskSchedule({...before, ...patch});
  return patch;
}
