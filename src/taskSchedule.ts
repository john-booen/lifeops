import { addDays, formatDate, normalizeJournalDate, todayString } from "./date";
import type { LifeOpsTask } from "./types";

type Schedule = Pick<LifeOpsTask, "date" | "endDate" | "time" | "startTime" | "endTime" | "estimateMin" | "scheduleMode">;
export type TaskTimeGroup = "morning" | "afternoon" | "evening" | "spanning" | "boundary" | "unscheduled" | "window";

/** Older multi-day tasks are availability windows, not days of continuous work.
 * Preserve the unambiguous legacy evening-to-next-morning appointment. No files
 * are migrated or rewritten to derive this presentation. */
export function taskScheduleMode(task: Pick<LifeOpsTask, "date" | "endDate" | "startTime" | "endTime" | "scheduleMode">): "fixed" | "window" {
  if (task.scheduleMode) return task.scheduleMode;
  if (!task.date || !task.endDate || task.endDate <= task.date) return "fixed";
  const start = timeMinutes(task.startTime), end = timeMinutes(task.endTime);
  return task.endDate === addDays(task.date, 1) && start !== undefined && end !== undefined && end <= start ? "fixed" : "window";
}

export const isTaskWindow = (task: Pick<LifeOpsTask, "date" | "endDate" | "startTime" | "endTime" | "scheduleMode">) => taskScheduleMode(task) === "window";

/** Daily obligations and completion metrics use the window's target once,
 * while calendar availability still spans every date in the window. */
export function taskPlannedDate(task: LifeOpsTask): string {
  return isTaskWindow(task) ? task.endDate || task.date || task.dueDate : task.date || task.dueDate;
}

export function isTaskScheduledForDay(task: LifeOpsTask, date: string): boolean {
  return isTaskWindow(task) ? taskPlannedDate(task) === date || task.dueDate === date : isTaskOnDate(task, date) || task.dueDate === date;
}

export function isTaskOnDate(task: Pick<LifeOpsTask, "date" | "endDate">, date: string): boolean {
  return Boolean(task.date && task.date <= date && date <= (task.endDate || task.date));
}

export function shiftTaskDates(task: Pick<LifeOpsTask, "date" | "endDate" | "dueDate">, days: number) {
  return {
    date: addDays(task.date || todayString(), days),
    endDate: task.endDate ? addDays(task.endDate, days) : "",
    dueDate: task.dueDate ? addDays(task.dueDate, days) : ""
  };
}

export function taskDeadlineDate(task: Pick<LifeOpsTask, "dueDate" | "date" | "endDate">): string {
  return task.dueDate || (task.date && task.endDate >= task.date ? task.endDate : task.date);
}

export function isTaskOverdue(task: Pick<LifeOpsTask, "dueDate" | "date" | "endDate">, date: string): boolean {
  const deadline = taskDeadlineDate(task);
  return Boolean(deadline && deadline < date);
}

/** A date supplied by the user has no clock. A timestamp follows the device's local day. */
export function taskCompletionPoint(completedAt: string): { date: string; timestamp?: number } | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(completedAt)) {
    return normalizeJournalDate(completedAt) === completedAt ? { date: completedAt } : undefined;
  }
  const timestamp = new Date(completedAt);
  return Number.isFinite(timestamp.getTime()) ? { date: formatDate(timestamp), timestamp: timestamp.getTime() } : undefined;
}

export const taskCompletionDay = (completedAt: string) => taskCompletionPoint(completedAt)?.date ?? "";

export function timeMinutes(value: string | undefined): number | undefined {
  if (!value || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return undefined;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

/** Validate new plans; never interpret or convert a historical `time` field. */
export function validateTaskSchedule(task: Schedule): void {
  if (task.scheduleMode !== undefined && task.scheduleMode !== "fixed" && task.scheduleMode !== "window") throw new Error("请选择有效的任务安排方式。");
  if (task.estimateMin !== undefined && (!Number.isFinite(task.estimateMin) || task.estimateMin <= 0)) {
    throw new Error("估计时长须为大于零的分钟数，也可以留空。");
  }
  for (const value of [task.startTime, task.endTime]) {
    if (value !== undefined && (typeof value !== "string" || (value && timeMinutes(value) === undefined))) {
      throw new Error("计划时刻须为有效的 HH:mm，也可以清空。");
    }
  }
  if (!task.startTime && !task.endTime && !task.endDate && task.scheduleMode !== "window") return;
  if (normalizeJournalDate(task.date) !== task.date || !task.date
    || (task.endDate && normalizeJournalDate(task.endDate) !== task.endDate)) {
    throw new Error("请先选择有效的安排日期，再填写计划时刻。");
  }
  const endDate = task.endDate || task.date;
  if (endDate < task.date) throw new Error("计划结束日期不能早于开始日期。");
  if (task.startTime && task.endTime && endDate === task.date && task.endTime <= task.startTime) {
    throw new Error("计划结束须晚于开始；跨天安排请填写结束日期。");
  }
}

/** Half-open occupied interval on a specific day. A target alone occupies no time. */
export function taskDayInterval(task: Schedule, date: string): { start: number; end: number } | undefined {
  if (isTaskWindow(task)) return undefined;
  const start = timeMinutes(task.startTime), end = timeMinutes(task.endTime);
  if (start === undefined || end === undefined || !task.date || normalizeJournalDate(task.date) !== task.date) return undefined;
  const endDate = task.endDate || task.date;
  if (normalizeJournalDate(endDate) !== endDate || endDate < task.date || (endDate === task.date && end <= start)) return undefined;
  if (date < task.date || date > endDate) return undefined;
  const from = date === task.date ? start : 0, to = date === endDate ? end : 24 * 60;
  return to > from ? { start: from, end: to } : undefined;
}

export function taskTimeGroup(task: Schedule, date: string): TaskTimeGroup {
  if (isTaskWindow(task)) return "window";
  if (task.startTime && timeMinutes(task.startTime) !== undefined && task.endTime === "00:00"
    && task.endDate === date && task.date < date) return "boundary";
  const interval = taskDayInterval(task, date);
  if (interval) {
    if (interval.end <= 12 * 60) return "morning";
    if (interval.start >= 12 * 60 && interval.end <= 18 * 60) return "afternoon";
    if (interval.start >= 18 * 60) return "evening";
    return "spanning";
  }
  // A known start is a point; it does not claim an occupied duration.
  const start = timeMinutes(task.startTime);
  if (start !== undefined && !task.endTime && date === task.date) {
    return start < 12 * 60 ? "morning" : start < 18 * 60 ? "afternoon" : "evening";
  }
  return "unscheduled";
}

export function taskScheduleLabel(task: Schedule): string {
  if (isTaskWindow(task)) return `期间完成 ${task.date}${task.startTime ? ` ${task.startTime}` : ""} → ${task.endDate || task.date}${task.endTime ? ` ${task.endTime}` : ""} · 分次推进，未排工作区间`;
  if (task.startTime && task.endTime) {
    return task.endDate && task.endDate !== task.date
      ? `计划 ${task.date} ${task.startTime} → ${task.endDate} ${task.endTime}`
      : `计划 ${task.startTime}–${task.endTime}`;
  }
  if (task.startTime) return `计划 ${task.startTime} 开始 · 结束未定`;
  if (task.endTime) return `希望 ${task.endDate && task.endDate !== task.date ? `${task.endDate} ` : ""}${task.endTime} 前完成 · 未排区间`;
  return task.time ? `原安排 ${task.time} · 区间未确认` : "";
}

/** Timeline position is derived only from a real planned interval or explicit start. */
export function taskTimelineStart(task: Schedule, date: string): number | undefined {
  if (isTaskWindow(task)) return undefined;
  const interval = taskDayInterval(task, date);
  if (interval) return interval.start;
  return !task.endTime && date === task.date ? timeMinutes(task.startTime) : undefined;
}
