import { addDays, formatDate, normalizeJournalDate, todayString } from "../../date";
import type { AiToolCall, AiToolDefinition } from "../../ai";
import { isVaultPathExcluded } from "../../privacy";
import { isTaskOnDate, isTaskOverdue, taskScheduleLabel } from "../../taskSchedule";
import type { LifeOpsToolDefinition, ToolExecutionContext } from "../../toolRegistry";
import { currentSignalValues } from "../journal/signals";
import { todayTaskCounts, type StatsRange } from "../stats/stats";
import { taskCategory, taskDraftRoom, taskEstimates } from "./capacity";
import { prioritizeTasks, todayTaskPlan } from "./priority";
import { advanceCompensationDebt, compensationDueLabel } from "../habits/compensationDebt";

async function planningInputs(context: ToolExecutionContext) {
  const [{ readContextTasks }, { readPersonalMemoryWithSources }, { createPersonalMemoryContextFilter }] = await Promise.all([
    import("../../contextData"), import("../../personalMemorySources"), import("../../personalMemoryContext")
  ]);
  const data = await readContextTasks(context.store);
  if (!data.available) throw Error("任务记录暂不可用。");
  const { store } = context;
  const memoryExcluded = isVaultPathExcluded(store.personalMemoryPath(), store.settings.privacy?.excludedVaultPrefixes);
  const protect = createPersonalMemoryContextFilter(memoryExcluded ? [] : (await readPersonalMemoryWithSources(store)).records);
  return { tasks: data.tasks, protect, scope: data.filtered ? "只提供允许读取的记录" : undefined };
}

export const TASK_PLANNING_TOOLS: LifeOpsToolDefinition[] = [
  {
    name: "list_tasks",
    description: "查未完成任务。只有明确要求按截止状态分组才填 dueStatus。问今天还剩几项或最要紧事项时省略 dueStatus。",
    safety: "safe",
    parameters: { type: "object", additionalProperties: false, properties: {
      date: { type: "string", description: "日期，省略为今天。" },
      status: { type: "string", enum: ["active", "completed", "all"] },
      category: { type: "string", enum: ["punishment"], description: "查补偿待办时可不限定日期。" },
      habitName: { type: "string", description: "只查这一项习惯的补偿时填写习惯名称。" },
      dueStatus: { type: "string", enum: ["overdue_and_today"], description: "仅用于明确要求分别列出逾期和今日到期。" },
      directReply: { type: "boolean", description: "兼容旧客户端；查询结果仍交回本轮继续处理。" },
      order: { type: "string", enum: ["priority"], description: "用户问最要紧的待办时按优先级排序。" },
      limit: { type: "integer", minimum: 1, maximum: 30, description: "列出几项就填几，不改变返回的总数。" }
    } },
    async execute(args, context) {
      const date = args.date === undefined ? todayString() : typeof args.date === "string" ? normalizeJournalDate(args.date) : "";
      const status = args.status === undefined ? "active" : args.status;
      const limit = args.limit === undefined ? 20 : args.limit;
      const penalties = args.category === "punishment";
      const ordered = args.order === "priority";
      const dueGroups = args.dueStatus === "overdue_and_today";
      const habitName = typeof args.habitName === "string" ? args.habitName.trim().normalize("NFKC") : "";
      const anyDate = penalties && args.date === undefined;
      if (!date || typeof status !== "string" || !["active", "completed", "all"].includes(status)
        || (args.category !== undefined && !penalties)
        || (args.dueStatus !== undefined && (!dueGroups || status !== "active" || penalties))
        || (args.order !== undefined && (!ordered || status !== "active" || penalties))
        || (args.habitName !== undefined && (!penalties || !habitName || habitName.length > 40))
        || (args.directReply !== undefined && typeof args.directReply !== "boolean")
        || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 30) {
        return { success: false, output: "任务日期、状态或条数无效。", actions: [] };
      }
      const { tasks, protect, scope } = await planningInputs(context);
      let selectedHabit: string | undefined, enabled: boolean | undefined;
      let visible = tasks;
      if (penalties) {
        const { readContextHabits } = await import("../../contextData");
        const habits = await readContextHabits(context.store);
        context.assertCurrent?.();
        if (habitName) {
          const matches = habits.database.habits.filter(habit => habit.name.trim().normalize("NFKC") === habitName);
          if (!habits.available || matches.length !== 1) {
            return { success: false, output: "不能核对到唯一的习惯。请说出习惯的完整名称。", actions: [] };
          }
          selectedHabit = matches[0].id;
          enabled = matches[0].punishment?.enabled === true;
        }
        visible = advanceCompensationDebt(tasks, habits.database.habits, todayString(), context.store.settings.habitCompensation);
      }
      const estimate = taskEstimates(tasks);
      const orderedItems = (items: typeof tasks) => ordered
        ? prioritizeTasks(items, new Date(), undefined, estimate).map(item => item.task) : items;
      if (dueGroups) {
        context.assertCurrent?.();
        const active = tasks.filter(task => task.status === "active");
        const group = (items: typeof tasks) => ({
          count: items.length,
          tasks: orderedItems(items).slice(0, limit).map(task => ({ title: protect(task.title), time: taskScheduleLabel(task) }))
        });
        return { success: true, output: JSON.stringify({ date, scope, dueGroups: {
          overdue: group(active.filter(task => isTaskOverdue(task, date))),
          dueToday: group(active.filter(task => task.dueDate === date))
        } }), actions: [] };
      }
      const items = visible.filter(task => (anyDate || isTaskOnDate(task, date) || task.dueDate === date)
        && (status === "all" || task.status === status) && (!penalties || task.category === "punishment")
        && (!selectedHabit || task.habitPunishment?.habitId === selectedHabit));
      const selected = orderedItems(items);
      return { success: true, output: JSON.stringify({ date: anyDate ? null : date, status, count: items.length, scope, truncated: items.length > limit,
        ...(ordered ? { order: "priority" } : {}),
        ...(selectedHabit ? { compensationEnabled: enabled } : {}),
        tasks: selected.slice(0, limit).map(task => ({ id: task.id, title: protect(task.title), time: taskScheduleLabel(task),
          quadrant: task.quadrant, category: protect(taskCategory(task)), status: task.status, estimateMin: estimate(task),
          ...(task.habitPunishment?.evidence ? { evidence: protect(task.habitPunishment.evidence), dueDate: task.dueDate,
            ...(penalties ? { compensationDue: compensationDueLabel(task.habitPunishment) } : {}) } : {}) })) }), actions: [] };
    }
  },
  {
    name: "plan_today",
    description: "查排序和超载。答超载须引用 workloadSummary 的今日原排数和常态完成件数。排明天整天用 draftTomorrow=true。新增一项用 create_task。",
    safety: "safe",
    parameters: { type: "object", additionalProperties: false, properties: {
      energy: { type: "number", minimum: 1, maximum: 5, description: "用户明确提供的精力分数，未知就省略。" },
      draftTomorrow: { type: "boolean", description: "用户要规划明天整天的任务时才用 true。" }
    } },
    async execute(args, context) {
      const energy = args.energy;
      if (energy !== undefined && (typeof energy !== "number" || !Number.isFinite(energy) || energy < 1 || energy > 5)) {
        return { success: false, output: "精力分数须为 1 至 5，未知时可省略。", actions: [] };
      }
      if (args.draftTomorrow !== undefined && typeof args.draftTomorrow !== "boolean") {
        return { success: false, output: "明日草案参数无效。", actions: [] };
      }
      const { tasks, protect, scope } = await planningInputs(context);
      const now = new Date();
      const date = formatDate(now);
      const signalEnergy = energy ?? currentSignalValues(await import("../journal/signalStore")
        .then(({ readJournalSignals }) => readJournalSignals(context.store, date)).catch(() => [])).energy ?? undefined;
      const health = await import("../health/store").then(({ readHealthDay }) => readHealthDay(context.store, date)).catch(() => undefined);
      const { capacity, priorities } = todayTaskPlan(tasks, now, signalEnergy, health?.sleepHours);
      const today = todayTaskCounts(tasks, date, now);
      const normal = capacity.typicalCount === null ? "缺少常态完成量" : `平时约完成 ${Math.round(capacity.typicalCount)} 个`;
      const workloadSummary = `今天原排 ${today.scheduled} 个，已完成 ${today.completed} 个。含逾期的未完成负荷 ${capacity.plannedCount} 个，${normal}。`;
      const tomorrow = addDays(date, 1);
      const room = args.draftTomorrow === true ? taskDraftRoom(tasks, tomorrow, capacity.typicalCount) : undefined;
      const draft = room ? { date: tomorrow, maxNewTasks: 8, suggestedNewTasks: room.remaining,
        alreadyScheduled: room.existing.map(task => protect(task.title)),
        instruction: "生成完整确认卡供用户审阅，无需先问是否同意。suggestedNewTasks仅作历史负荷参考，不是数量限制。每项date照抄draft.date。time只填HH:mm开始时间，可省略。避免重复或推断事实，不得擅自删掉用户的必做事项。" } : undefined;
      return { success: true, output: JSON.stringify({ workloadSummary, today, energy: signalEnergy, capacity, draft, scope, tasks: priorities.map(({ task, score, estimateMin, reasons }) => ({
        id: task.id, title: protect(task.title), score, estimateMin, reasons, time: taskScheduleLabel(task),
        ...(task.habitPunishment?.evidence ? { evidence: protect(task.habitPunishment.evidence) } : {})
      })) }), actions: [] };
    }
  }
];

const todayUnfinishedQuestions = [
  /^我?今天还?有(?:哪些|什么)(?:任务|待办)还?(?:没做完?|没(?:有)?完成|未完成)$/u,
  /^我?今天(?:还?有)?(?:哪些|什么)(?:没做完?|没(?:有)?完成|未完成)的(?:任务|待办)$/u,
  /^我?今天还?剩下?(?:哪些|什么)(?:任务|待办)$/u
];
const dueGroupsRequest = /^(?:请)?(?:把|将)?(?:已|已经)?逾期的?(?:任务|待办)?(?:和|跟|与|以及|、)(?:今天|今日)到期的?(?:任务|待办)?(?:各自|分别|分开)(?:列(?:出|出来|一下)?|说(?:一下)?|显示)$/u;
const todayPriorityQuestion = /^(?:请问[，, ]*)?(?:我)?(?:今天|今日)(?:应当|应该|该|要)?先做(?:什么|哪些(?:任务|待办|事)?)[。！？!?]?$/u;

export function asksForTodayPriorities(message: string): boolean {
  return todayPriorityQuestion.test(message.trim());
}

export function todayTaskListQuestion(message: string, date: string): Record<string, unknown> | undefined {
  const text = message.trim().replace(/^请问[，, ]*/u, "").replace(/[。！？!?]+$/u, "");
  const parts = text.split(/[。！？!?]+\s*/u);
  const [first, second] = parts;
  const unfinished = todayUnfinishedQuestions.some(pattern => pattern.test(first));
  if (parts.length === 1 && dueGroupsRequest.test(first) || parts.length === 2 && unfinished && dueGroupsRequest.test(second)) {
    return { date, status: "active", dueStatus: "overdue_and_today" };
  }
  if (parts.length === 1 && unfinished) return { date, status: "active" };
}

export function taskCompletionRateQuestion(message: string): StatsRange | undefined {
  const period = /^(?:请问[，, ]*|我(?:的)?)?(这周|本周|上周|这月|本月|这个月|上个月)(?:的)?(?:任务|待办)完成率(?:是)?(?:多少|怎样|怎么样)[。？！?!]?$/u.exec(message.trim())?.[1];
  if (!period) return;
  if (period === "这周" || period === "本周") return "this_week";
  if (period === "上周") return "last_week";
  return period === "上个月" ? "last_month" : "this_month";
}

export function formatTaskCompletionRate(output: string): string {
  const { range, completionPercent, completedPlannedCount, plannedCount, scope } = JSON.parse(output) as {
    range: { from: string; to: string }; completionPercent: number | null; completedPlannedCount: number; plannedCount: number; scope?: string;
  };
  const period = `${range.from} 至 ${range.to}`;
  const coverage = scope ? "只统计允许读取的记录。" : "";
  return completionPercent === null
    ? `${period} 暂无可核对的计划任务，无法计算完成率。${coverage}`
    : `${period} 计划任务完成率为 ${completionPercent}%，完成 ${completedPlannedCount} 项，共计划 ${plannedCount} 项。${coverage}`;
}

export function habitCompensationQuestion(message: string): string | undefined {
  return /^(?:我的)?([^，,。；;！？?\r\n]{1,30}?)(?:没有|没|未)达标(?:会怎么样|会怎样|怎么办)[？?。]?$/u.exec(message.trim())?.[1]?.trim();
}

export function formatHabitCompensationReply(name: string, output: string): string | undefined {
  let data: { count: number; scope?: string; compensationEnabled?: boolean; tasks: { compensationDue?: string }[] };
  try { data = JSON.parse(output); } catch { return; }
  if (typeof data?.compensationEnabled !== "boolean" || !Number.isSafeInteger(data.count) || !Array.isArray(data.tasks)) return;
  const requirements = data.tasks.flatMap(task => task.compensationDue ? [task.compensationDue] : []);
  if (data.count && requirements.length) {
    return `「${name}」已有 ${data.count} 项补偿待办。当前要做：${requirements.join("；")}。${data.scope ? "只统计允许读取的记录。" : ""}`;
  }
  if (data.count) return `「${name}」还有 ${data.count} 项旧补偿提醒，可在习惯页查看。`;
  return data.compensationEnabled ? `「${name}」已开启补偿。晚上核对未达标时会安排补偿待办，目前没有查到未完成的补偿。`
    : `「${name}」目前没有开启补偿，也没有查到未完成的补偿。`;
}

interface TaskListGroup {
  count: number;
  tasks: Array<{ title: string; time?: string }>;
}

function validTaskListGroup(group: TaskListGroup | undefined): group is TaskListGroup {
  return Boolean(group && Number.isSafeInteger(group.count) && group.count >= 0
    && Array.isArray(group.tasks) && group.tasks.every(task => typeof task?.title === "string"));
}

function taskListLines(tasks: TaskListGroup["tasks"]): string[] {
  return tasks.map((task, index) => `${index + 1}. ${task.title}${task.time ? `（${task.time}）` : ""}`);
}

function dueGroupLines(label: string, group: TaskListGroup): string[] {
  const lines = [`${label} ${group.count} 项。`, ...taskListLines(group.tasks)];
  if (group.count > group.tasks.length) lines.push(`以上是前 ${group.tasks.length} 项。`);
  return lines;
}

export function formatTaskListReply(output: string, today: string): string | undefined {
  let list: TaskListGroup & { date: string; status: string; scope?: string; truncated?: boolean; order?: string;
    dueGroups?: { overdue: TaskListGroup; dueToday: TaskListGroup } };
  try { list = JSON.parse(output); } catch { return undefined; }
  if (list?.dueGroups && typeof list.date === "string") {
    const { overdue, dueToday } = list.dueGroups;
    if (!validTaskListGroup(overdue) || !validTaskListGroup(dueToday)) return undefined;
    const label = list.date === today ? "今天到期" : `${list.date} 到期`;
    const lines = [...dueGroupLines("已逾期", overdue), ...dueGroupLines(label, dueToday)];
    if (list.scope) lines.push(list.scope + "。");
    return lines.join("\n");
  }
  if (!validTaskListGroup(list) || typeof list.date !== "string") return undefined;
  const day = list.date === today ? "今天" : list.date;
  const status = list.status === "active" ? "未完成任务" : list.status === "completed" ? "已完成任务" : "任务";
  if (list.order === "priority") {
    const first = list.tasks.map(task => task.title).join("、");
    return `${day}还有 ${list.count} 项${status}。${first ? "先做：" + first + "。" : ""}${list.scope ? list.scope + "。" : ""}`;
  }
  const lines = [`${day}有 ${list.count} 个${status}。`,
    ...taskListLines(list.tasks)];
  if (list.truncated) lines.push(`以上是前 ${list.tasks.length} 个。`);
  if (list.scope) lines.push(list.scope + "。");
  return lines.join("\n");
}

export function repeatedTaskListPriority(calls: readonly AiToolCall[], today: string): AiToolCall | undefined {
  if (calls.length < 2) return;
  const first = calls.find(call => call.name === "list_tasks" && call.arguments.order === "priority"
    && call.arguments.directReply === true && typeof call.arguments.limit === "number"
    && Number.isInteger(call.arguments.limit) && call.arguments.limit >= 1 && call.arguments.limit <= 30);
  if (!first) return;
  const date = (call: AiToolCall) => call.arguments.date === undefined ? today : typeof call.arguments.date === "string"
    ? normalizeJournalDate(call.arguments.date, today) : "";
  const selectedDate = date(first);
  if (selectedDate && calls.every(call => call.name === "plan_today"
    ? selectedDate === today && Object.keys(call.arguments).length === 0
    : call.name === "list_tasks" && call.arguments.directReply === true
    && call.arguments.category === undefined && call.arguments.dueStatus === undefined && call.arguments.habitName === undefined
    && (call.arguments.status === undefined || call.arguments.status === "active") && date(call) === selectedDate
    && (call.arguments.order === undefined && call.arguments.limit === undefined
      || call.arguments.order === "priority" && call.arguments.limit === first.arguments.limit))) return first;
}

export function voiceTaskPriorityTool(tool: AiToolDefinition): AiToolDefinition {
  return { ...tool, description: tool.description + " 语音只问今天先做哪几项时，用 voicePriorityCount 直接播报排序和理由。",
    parameters: { ...tool.parameters, properties: {
      ...(tool.parameters.properties as Record<string, unknown>),
      voicePriorityCount: { type: "integer", minimum: 1, maximum: 3, description: "只问前几项时，填用户要的数量。" }
    } }
  };
}

export function formatVoiceTaskPriorities(output: string, args: Record<string, unknown>): string | undefined {
  const count = args.voicePriorityCount;
  if (args.draftTomorrow === true || typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 3) return;
  return formatTaskPriorities(output, count);
}

export function formatTaskPriorities(output: string, count: number, includeEnergy = false): string | undefined {
  let plan: { tasks: Array<{ title: string; time?: string; reasons: string[] }>; scope?: string; energy?: number };
  try { plan = JSON.parse(output); } catch { return; }
  if (!Array.isArray(plan?.tasks)) return;
  const selected = plan.tasks.slice(0, count);
  if (selected.some(task => typeof task?.title !== "string" || !Array.isArray(task.reasons))) return;
  const scope = plan.scope ? "。按允许读取的记录排序" : "";
  if (!selected.length) return `今天没有查到需要优先处理的到期待办${scope}。`;
  const lines = selected.map(({ title, time, reasons }, index) => {
    const details = [time, ...reasons.slice(0, 2)].filter(Boolean).join("，");
    return `${index === 0 ? "先做" : "然后做"}「${title}」${details ? `，${details}` : ""}`;
  });
  const energy = includeEnergy && typeof plan.energy === "number" && Number.isFinite(plan.energy)
    ? `计划按精力 ${plan.energy} 分排序。` : "";
  return lines.join("。") + scope + "。" + energy;
}
