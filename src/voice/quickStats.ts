import type { AiToolDefinition } from "../ai";

const labels: Record<string, string> = {
  today: "今天", this_week: "这周", last_week: "上周", last_7d: "最近七天",
  this_month: "这个月", last_month: "上个月", last_30d: "最近三十天"
};

export function voiceStatsTool(tool: AiToolDefinition): AiToolDefinition {
  return { ...tool,
    description: tool.description + " 只问一项完成数、指定习惯次数或打卡、今天交易目标时用 voiceAnswer，直接口头报读回结果。",
    parameters: { ...tool.parameters, properties: {
      ...(tool.parameters.properties as Record<string, unknown>),
      voiceAnswer: { type: "string", enum: ["completed_tasks", "habit_count", "habit_checkin", "daily_trade_goal"] },
      habitName: { type: "string", description: "查询指定习惯时填写名称。" }
    } }
  };
}

interface HabitRead {
  name: string;
  doneCount: number;
  dailyTradeGoal?: { target: number; status: "leave" }
    | { target: number; actual: number; remaining: number; status: "met" | "pending" };
}

function matchingHabits(habits: HabitRead[], name: string): HabitRead[] {
  const key = name.normalize("NFKC").toLocaleLowerCase().trim();
  const matching = (habit: HabitRead) => habit.name.normalize("NFKC").toLocaleLowerCase();
  const exact = habits.filter(habit => matching(habit) === key);
  return exact.length ? exact : habits.filter(habit => matching(habit).includes(key));
}

export function formatVoiceStats(output: string, args: Record<string, unknown>): string | undefined {
  const { domain, voiceAnswer, range, habitName } = args;
  const label = typeof range === "string" && Object.hasOwn(labels, range) ? labels[range] : undefined;
  if (!voiceAnswer || !label || args.groupBy !== undefined) return;
  let stats: { domain: string; completedTaskCount?: number; completedCount?: number; habits?: HabitRead[]; scope?: string; tradeGoals?: string };
  try { stats = JSON.parse(output); } catch { return; }
  if (!stats || stats.domain !== domain) return;
  const scope = stats.scope ? "。按允许读取的记录计算" : "";
  if (voiceAnswer === "completed_tasks" && domain === "tasks") {
    const tasks=stats.completedTaskCount,events=stats.completedCount;
    if (!Number.isSafeInteger(tasks)||!Number.isSafeInteger(events)||tasks!<0||events!<tasks!) return;
    return `${label}已完成 ${tasks} 个任务${tasks!==events?`（共 ${events} 次完成记录）`:""}${scope}。`;
  }
  if (domain !== "habits" || !Array.isArray(stats.habits)) return;
  const selected = typeof habitName === "string" && habitName.trim() ? matchingHabits(stats.habits, habitName) : [];
  if (voiceAnswer === "daily_trade_goal" && range === "today") {
    if (stats.tradeGoals) return stats.tradeGoals + "。";
    const goals = (selected.length ? selected : stats.habits).flatMap(habit =>
      habit.dailyTradeGoal ? [{ name: habit.name, goal: habit.dailyTradeGoal }] : []);
    if (!goals.length || goals.length > 3 || typeof habitName === "string" && selected.length !== 1) return;
    return goals.map(({ name, goal }) => {
      if (goal.status === "leave") return `「${name}」今天已请假`;
      if (goal.status === "met") return `「${name}」今天已达标，完成 ${goal.actual} 笔`;
      return `「${name}」今天完成 ${goal.actual} 笔，还差 ${goal.remaining} 笔`;
    }).join("。") + scope + "。";
  }
  if (selected.length !== 1 || !Number.isFinite(selected[0].doneCount)) return;
  const [habit] = selected;
  if (voiceAnswer === "habit_count") return `${label}「${habit.name}」已记录 ${habit.doneCount} 次${scope}。`;
  if (voiceAnswer === "habit_checkin" && range === "today") {
    return `今天${habit.doneCount > 0 ? "已给" : "还没给"}「${habit.name}」打卡${scope}。`;
  }
}
