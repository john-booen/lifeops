import type { AiToolCall } from "../ai";
import { formatDate, normalizeJournalDate } from "../date";
import { readContextTasks } from "../contextData";
import { taskCapacity, taskEstimates } from "../features/tasks/capacity";
import type { StoreHost } from "../store/settingsSlice";
import { isTaskOnDate, isTaskWindow, taskDayInterval, taskScheduleLabel, timeMinutes } from "../taskSchedule";
import { taskDeadlineInput, taskDeadlineLabel } from "../features/tasks/deadlineInput";

export { TASK_BATCH_TOOL } from "../features/tasks/batchDefinition";

export interface TaskBatchPlan {
  calls: AiToolCall[];
  existing: string[];
  notes: string[];
}
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const key = (title: string) => title.trim().normalize("NFKC");
export class TaskBatchAvailabilityError extends Error {}
export class TaskBatchItemError extends Error {}

/** Only structured tool arguments choose this path; no text pattern routes user intent. */
export async function planTaskBatch(store: StoreHost, call: AiToolCall, now: Date,
  options: { retainPastDate?: boolean } = {}): Promise<TaskBatchPlan> {
  const args = call.arguments;
  if (Object.keys(args).some(k => !["date", "tasks", "availableStart", "availableEnd"].includes(k))
    || typeof args.date !== "string" || !Array.isArray(args.tasks) || !args.tasks.length || args.tasks.length > 20) {
    throw Error("请一次提供一至二十项具体任务和安排日期；尚未保存。");
  }
  const today = formatDate(now), date = normalizeJournalDate(args.date, today);
  if (!date || date < today && !options.retainPastDate) throw Error("请指定今天或未来的日期；不会把新安排排进过去。");
  const suppliedClock = (name: "availableStart" | "availableEnd") => {
    if (args[name] === undefined) return undefined;
    if (typeof args[name] !== "string" || timeMinutes(args[name] as string) === undefined) throw new TaskBatchAvailabilityError("可用时间须为 HH:mm；尚未保存。");
    return timeMinutes(args[name] as string)!;
  };
  const current = date < today ? 1440 : date === today ? Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 5) * 5 : 9 * 60;
  const from = Math.max(current, suppliedClock("availableStart") ?? current);
  const until = suppliedClock("availableEnd") ?? 22 * 60;
  if (args.availableStart !== undefined && args.availableEnd !== undefined
    && suppliedClock("availableEnd")! <= suppliedClock("availableStart")!) throw Error("可用结束时间须晚于开始时间；尚未保存。");
  const titles = new Set<string>();
  const proposed = args.tasks.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("每项任务须有具体名称；尚未保存。");
    const task = value as Record<string, unknown>;
    if (Object.keys(task).some(k => !["title", "estimateMin", "category", "dueDate", "dueTime"].includes(k))
      || typeof task.title !== "string" || !task.title.trim() || task.title.length > 1000
      || task.category !== undefined && (typeof task.category !== "string" || task.category === "punishment")
      || task.estimateMin !== undefined && (typeof task.estimateMin !== "number" || !Number.isInteger(task.estimateMin)
        || task.estimateMin < 1 || task.estimateMin > 720)) throw new TaskBatchItemError("任务名称、分类或分钟估算无效；尚未保存。");
    if (titles.has(key(task.title))) throw Error("本批存在同名任务，请合并重复项；尚未保存。");
    titles.add(key(task.title));
    return { title: task.title.trim(), estimateMin: (task.estimateMin as number | undefined) ?? 30,
      ...taskDeadlineInput(task, undefined, today),
      ...(task.category ? { category: task.category as string } : {}) };
  });
  const data = await readContextTasks(store);
  if (!data.available) throw Error("任务记录暂不可用，未开始批量保存。");
  const estimate = taskEstimates(data.tasks);
  const occupied = data.tasks.filter(t => t.status === "active" && !isTaskWindow(t) && isTaskOnDate(t, date)).flatMap(t => {
    const interval = taskDayInterval(t, date);
    if (interval) return [interval];
    const start = timeMinutes(t.startTime || t.time);
    return start === undefined ? [] : [{ start, end: Math.min(1440, start + estimate(t)) }];
  }).sort((a, b) => a.start - b.start);
  const existing: string[] = [], calls: AiToolCall[] = [];
  let cursor = from, unplaced = 0, lateDeadlines = 0;
  for (const [index, task] of proposed.entries()) {
    const matches = data.tasks.filter(t => t.date === date && key(t.title) === key(task.title));
    if (matches.length) {
      if (matches.some(existing => task.dueDate !== undefined && existing.dueDate !== task.dueDate
        || task.dueTime !== undefined && existing.dueTime !== task.dueTime)) {
        throw Error(`「${task.title}」已存在，但本次必须截止与原记录不同；请明确修改原任务，本批尚未保存。`);
      }
      existing.push(`${task.title}（已存在${matches.length > 1 ? ` ${matches.length} 条` : ""}，未重复创建${matches[0].status === "completed" ? "，已完成" : ""}；${taskScheduleLabel(matches[0]) || "未排时段"}${taskDeadlineLabel(matches[0]) ? `；${taskDeadlineLabel(matches[0])}` : ""}）`);
      const interval = taskDayInterval(matches[0], date);
      if (matches[0].status === "active" && interval) cursor = Math.max(cursor, interval.end + 10);
      continue;
    }
    let start = cursor;
    for (const busy of occupied) {
      if (busy.end <= start) continue;
      if (start + task.estimateMin <= busy.start) break;
      start = busy.end + 10;
    }
    const end = start + task.estimateMin, fits = end <= until && end < 1440;
    if (task.dueDate && (task.dueDate < date || task.dueDate === date && task.dueTime
      && fits && end > timeMinutes(task.dueTime)!)) lateDeadlines++;
    if (!fits) { unplaced++; cursor = 1440; }
    else cursor = end + 10;
    calls.push({ id: `${call.id}:task:${index}`, name: "create_task", arguments: { ...task, date,
      ...(fits ? { startTime: clock(start), endTime: clock(end) } : {}) } });
  }
  const capacity = taskCapacity(data.tasks, now, estimate, date);
  const notes = ["时长均为暂估，任务之间预留10分钟；可随实际进度调整。",
    ...(date < today ? ["处理时已过记录所指日期，仍归原定日期，未倒填过去的时段。"] : []),
    ...(args.availableEnd === undefined ? ["未提供收工时间，暂按22:00作为排程边界。"] : []),
    ...(unplaced ? [`${unplaced}项在剩余时间内放不下，仍保存到${date}但不编造时段；有延后风险，需要缩短、并行或调整安排，未自动改到明天。`] : []),
    ...(lateDeadlines ? [`${lateDeadlines}项按当前安排将晚于必须截止；期限和原定日期都保留，请调整顺序、时长或交付安排，未自动推迟期限。`] : []),
    ...(capacity.typicalCount === null ? ["缺少历史完成量，无法据此判断能力上限。"]
      : proposed.length + capacity.plannedCount > capacity.typicalCount
        ? [`本批高于近期常态约${capacity.typicalCount}项/天，仅作负荷提醒，仍保留全部安排。`] : []),
    ...(data.filtered ? ["只按允许读取的任务核对冲突。"] : [])];
  return { calls, existing, notes };
}

export function taskBatchOutput(plan: TaskBatchPlan, saved: string[], failure?: string): string {
  return [failure ? `本批实际保存${saved.length}项，后续已停止。${failure}` : `本批实际保存${saved.length}项新任务。`,
    ...saved, ...plan.existing.map(text => `已有：${text}`), ...plan.notes,
    ...(failure ? ["未保存的事项没有报成功；可按同一清单重试，已存在项不会重复创建。"] : [])].join("\n");
}
