import { addDays, formatDate } from "../../date";
import type { LifeOpsTask } from "../../types";
import { taskCompletionEvents } from "../stats/stats";

export const TASK_CATEGORIES = {
  work: "工作", life: "生活", learning: "学习", trading: "交易", idea: "想法", punishment: "惩罚"
} as const;

export function taskCategory(task: Pick<LifeOpsTask, "category">): string {
  return typeof task.category === "string" ? task.category.trim() || "work" : "work";
}

type Estimate = (task: LifeOpsTask) => number;

function quantile(values: number[], fraction: number): number {
  const sorted = values.slice().sort((left, right) => left - right);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

export function taskEstimates(tasks: readonly LifeOpsTask[]): Estimate {
  const byCategory = new Map<string, number[]>();
  for (const task of tasks) {
    const minutes = task.estimateMin;
    if (task.status !== "completed" || minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) continue;
    const category = taskCategory(task);
    const history = byCategory.get(category);
    if (history) history.push(minutes);
    else byCategory.set(category, [minutes]);
  }
  const medians = new Map([...byCategory].map(([category, values]) => [category, quantile(values, 0.5)]));
  return task => {
    const minutes = task.estimateMin;
    return minutes !== undefined && Number.isFinite(minutes) && minutes > 0 ? minutes : medians.get(taskCategory(task)) ?? 30;
  };
}

export function tasksDueBy(tasks: readonly LifeOpsTask[], date: string): LifeOpsTask[] {
  return tasks.filter(task => {
    const due = task.dueDate || task.date;
    return task.status === "active" && !!due && due <= date;
  });
}

export function taskCapacity(tasks: readonly LifeOpsTask[], now: Date, estimate: Estimate = taskEstimates(tasks), planDate?: string) {
  const today = formatDate(now);
  const range = { from: addDays(today, -28), to: addDays(today, -1) };
  const history = new Map<string, { count: number; minutes: number }>();
  for (const task of tasks) {
    const date = task.date || task.dueDate;
    if (date >= range.from && date <= range.to && !history.has(date)) history.set(date, { count: 0, minutes: 0 });
  }
  for (const event of taskCompletionEvents(tasks, range, now)) {
    const day = history.get(event.date) ?? { count: 0, minutes: 0 };
    day.count++;
    day.minutes += estimate(event.task);
    history.set(event.date, day);
  }
  const planned = planDate === undefined ? tasksDueBy(tasks, today) : tasks.filter(task => task.status === "active"
    && (task.dueDate === planDate || !!task.date && task.date <= planDate && planDate <= (task.endDate || task.date)
      || planDate === today && !!(task.dueDate || task.date) && (task.dueDate || task.date) <= today));
  const plannedCount = planned.length, plannedMin = planned.reduce((sum, task) => sum + estimate(task), 0);
  const counts = [...history.values()].map(day => day.count), minutes = [...history.values()].map(day => day.minutes);
  const typicalCount = counts.length ? quantile(counts, 0.5) : null;
  const typicalMin = minutes.length ? quantile(minutes, 0.5) : null;
  const countLimit = counts.length ? quantile(counts, 0.75) + 2 : Infinity;
  const minuteLimit = minutes.length ? quantile(minutes, 0.75) * 1.2 : Infinity;
  const overloaded = plannedCount > countLimit || plannedMin > minuteLimit;
  const suggestDefer: string[] = [];
  if (overloaded) {
    const rank = { "not-important-not-urgent": 0, "not-important-urgent": 1, "important-not-urgent": 2, "important-urgent": 3 };
    const candidates = planned.filter(task => !task.startTime && !task.endTime && !task.time && !task.dueTime && !task.dueDate)
      .sort((left, right) => rank[left.quadrant] - rank[right.quadrant] || right.date.localeCompare(left.date)
        || estimate(right) - estimate(left) || left.sortOrder - right.sortOrder);
    let count = plannedCount, remainingMin = plannedMin;
    for (const task of candidates) {
      if (count <= countLimit && remainingMin <= minuteLimit) break;
      suggestDefer.push(task.id);
      count--;
      remainingMin -= estimate(task);
    }
  }
  return { overloaded, plannedCount, typicalCount, plannedMin, typicalMin, suggestDefer };
}

export function taskOverloadNotice(before: readonly LifeOpsTask[], after: readonly LifeOpsTask[], now: Date): string {
  const capacity = taskCapacity(after, now);
  if (!capacity.overloaded || capacity.typicalCount === null || taskCapacity(before, now).overloaded) return "";
  return `今天已排 ${capacity.plannedCount} 个，平时你大约完成 ${Math.round(capacity.typicalCount)} 个。`;
}

export function taskDraftRoom(tasks: readonly LifeOpsTask[], date: string, typicalCount: number | null) {
  const limit = Math.max(1, Math.floor(typicalCount ?? 3));
  const existing = tasks.filter(task => task.status === "active" && (task.date === date || task.dueDate === date));
  return { existing, remaining: Math.max(0, limit - existing.length) };
}
