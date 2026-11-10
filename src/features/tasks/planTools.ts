import { addDays, formatDate, normalizeJournalDate, todayString } from "../../date";
import type { AiToolDefinition } from "../../ai";
import { isVaultPathExcluded } from "../../privacy";
import { taskScheduleLabel } from "../../taskSchedule";
import type { LifeOpsToolDefinition, ToolExecutionContext } from "../../toolRegistry";
import { currentSignalValues } from "../journal/signals";
import { todayTaskCounts } from "../stats/stats";
import { taskCategory, taskDraftRoom, taskEstimates } from "./capacity";
import { todayTaskPlan } from "./priority";
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
    description: "只读查询任务，默认今日未完成。用户只要清单才设 directReply=true。用户要求改期应调用 reschedule_task。问习惯未达标或补偿时设 category=punishment。",
    safety: "safe",
    parameters: { type: "object", additionalProperties: false, properties: {
      date: { type: "string", description: "日期，省略为今天。" },
      status: { type: "string", enum: ["active", "completed", "all"] },
      category: { type: "string", enum: ["punishment"], description: "查补偿待办时可不限定日期。" },
      habitName: { type: "string", description: "只查这一项习惯的补偿时填写习惯名称。" },
      directReply: { type: "boolean", description: "只列清单时为 true。需要建议或后续动作时省略。" },
      limit: { type: "integer", minimum: 1, maximum: 30 }
    } },
    async execute(args, context) {
      const date = args.date === undefined ? todayString() : typeof args.date === "string" ? normalizeJournalDate(args.date) : "";
      const status = args.status === undefined ? "active" : args.status;
      const limit = args.limit === undefined ? 20 : args.limit;
      const penalties = args.category === "punishment";
      const habitName = typeof args.habitName === "string" ? args.habitName.trim().normalize("NFKC") : "";
      const anyDate = penalties && args.date === undefined;
      if (!date || typeof status !== "string" || !["active", "completed", "all"].includes(status)
        || (args.category !== undefined && !penalties)
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
        visible = advanceCompensationDebt(tasks, habits.database.habits, todayString());
      }
      const estimate = taskEstimates(tasks);
      const items = visible.filter(task => (anyDate || task.date === date || task.dueDate === date)
        && (status === "all" || task.status === status) && (!penalties || task.category === "punishment")
        && (!selectedHabit || task.habitPunishment?.habitId === selectedHabit));
      return { success: true, output: JSON.stringify({ date: anyDate ? null : date, status, count: items.length, scope, truncated: items.length > limit,
        ...(selectedHabit ? { compensationEnabled: enabled } : {}),
        tasks: items.slice(0, limit).map(task => ({ id: task.id, title: protect(task.title), time: taskScheduleLabel(task),
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
      const { capacity, priorities } = todayTaskPlan(tasks, now, signalEnergy);
      const today = todayTaskCounts(tasks, date, now);
      const normal = capacity.typicalCount === null ? "缺少常态完成量" : `平时约完成 ${Math.round(capacity.typicalCount)} 个`;
      const workloadSummary = `今天原排 ${today.scheduled} 个，已完成 ${today.completed} 个。含逾期的未完成负荷 ${capacity.plannedCount} 个，${normal}。`;
      const tomorrow = addDays(date, 1);
      const room = args.draftTomorrow === true ? taskDraftRoom(tasks, tomorrow, capacity.typicalCount) : undefined;
      const draft = room ? { date: tomorrow, maxNewTasks: room.remaining, alreadyScheduled: room.existing.map(task => protect(task.title)),
        instruction: "生成确认卡供用户审阅，无需先问是否同意。每项 date 照抄 draft.date。time 只填 HH:mm 开始时间，可省略。用现有资料拟出具体下一步，避免重复现有任务或推断事实。" } : undefined;
      return { success: true, output: JSON.stringify({ workloadSummary, today, energy: signalEnergy, capacity, draft, scope, tasks: priorities.map(({ task, score, estimateMin, reasons }) => ({
        id: task.id, title: protect(task.title), score, estimateMin, reasons, time: taskScheduleLabel(task),
        ...(task.habitPunishment?.evidence ? { evidence: protect(task.habitPunishment.evidence) } : {})
      })) }), actions: [] };
    }
  }
];

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

export function formatTaskListReply(output: string, today: string): string | undefined {
  let list: { date: string; status: string; count: number; tasks: Array<{ title: string; time?: string }>; scope?: string; truncated?: boolean };
  try { list = JSON.parse(output); } catch { return undefined; }
  if (!list || typeof list.date !== "string" || !Number.isSafeInteger(list.count) || list.count < 0
    || !Array.isArray(list.tasks) || list.tasks.some(task => typeof task?.title !== "string")) return undefined;
  const day = list.date === today ? "今天" : list.date;
  const status = list.status === "active" ? "未完成任务" : list.status === "completed" ? "已完成任务" : "任务";
  const lines = [`${day}有 ${list.count} 个${status}。`,
    ...list.tasks.map((task, index) => `${index + 1}. ${task.title}${task.time ? `（${task.time}）` : ""}`)];
  if (list.truncated) lines.push(`以上是前 ${list.tasks.length} 个。`);
  if (list.scope) lines.push(list.scope + "。");
  return lines.join("\n");
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
  let plan: { tasks: Array<{ title: string; time?: string; reasons: string[] }>; scope?: string };
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
  return lines.join("。") + scope + "。";
}
