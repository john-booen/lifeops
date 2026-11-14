import { formatDate } from "../../date";
import { taskDeadlineDate, timeMinutes } from "../../taskSchedule";
import type { LifeOpsTask } from "../../types";
import { taskCapacity, taskCategory, taskEstimates, tasksDueBy } from "./capacity";

export function todayTaskPlan(tasks: readonly LifeOpsTask[], now: Date, energy?: number, sleepHours?: number) {
  const estimate = taskEstimates(tasks);
  return {
    capacity: taskCapacity(tasks, now, estimate),
    priorities: prioritizeTasks(tasksDueBy(tasks, formatDate(now)), now, energy, estimate, sleepHours)
  };
}

export function prioritizeTasks(tasks: readonly LifeOpsTask[], now: Date, energy?: number,
  estimate: (task: LifeOpsTask) => number = taskEstimates(tasks), sleepHours?: number) {
  const today = formatDate(now), minuteNow = now.getHours() * 60 + now.getMinutes();
  return tasks.filter(task => task.status === "active").map(task => {
    let score = 0;
    const reasons: string[] = [];
    const due = taskDeadlineDate(task);
    if (due && due < today) { score += 3; reasons.push("已逾期"); }
    if (due === today) { score += 2; reasons.push("今天到期"); }
    if (task.quadrant === "important-urgent") { score += 3; reasons.push("重要且紧急"); }
    if (task.quadrant === "important-not-urgent") { score += 2; reasons.push("重要不紧急"); }
    const time = (task.date === today ? task.startTime || task.time || task.endTime : "")
      || (task.dueDate === today ? task.dueTime : "");
    const scheduledMinute = timeMinutes(time);
    if (scheduledMinute !== undefined) {
      const remaining = scheduledMinute - minuteNow;
      if (remaining >= 0 && remaining <= 60) { score += 2; reasons.push("一小时内有安排"); }
    }
    if (taskCategory(task) === "punishment") { score += 1; reasons.push("惩罚任务"); }
    const estimateMin = estimate(task);
    if (estimateMin > 90) {
      if (energy !== undefined && energy <= 2) { score -= 2; reasons.push("精力偏低，长任务后排"); }
      else if (energy === undefined && sleepHours !== undefined && sleepHours < 6) { score -= 2; reasons.push("昨晚睡眠记录少于 6 小时，长任务后排"); }
    }
    return { task, score, estimateMin, reasons };
  }).sort((left, right) => right.score - left.score || left.task.sortOrder - right.task.sortOrder
    || left.task.id.localeCompare(right.task.id));
}
