import { addDays, formatDate } from "./date";
import { recentJournalTitles, type JournalTitle } from "./compactContext";
import { personalMemoryReadSnapshot } from "./personalMemory";
import { createPersonalMemoryContextFilter } from "./personalMemoryContext";
import { readPersonalMemoryWithSources } from "./personalMemorySources";
import type { StoreHost } from "./store/settingsSlice";
import { isTaskOverdue, taskCompletionPoint } from "./taskSchedule";
import type { TimeContext } from "./timeContext";
import { getTimeContext } from "./timeContext";
import type { LifeOpsTask, TaskDashboardData } from "./types";
import { dashboardContextData } from "./contextData";

export interface TaskCompletionEvidence {
  taskId: string;
  title: string;
  completedAt: string;
  localDate: string;
}

export interface TaskFactSnapshot {
  observedAt: string;
  sourcePaths: string[];
  activeTasks: number;
  overdueTasks: number;
  completionWindowStart: string;
  completionWindowEnd: string;
  completionEvidence: TaskCompletionEvidence[];
  incompleteCompletionCount: number;
  allowedSourcesOnly?: boolean;
}

export interface InjectedContext {
  availability?: { tasks: boolean; habits: boolean };
  time: {
    iso: string;
    date: string;
    timeOfDay: TimeContext["timeOfDay"];
    dayOfWeek: string;
  };
  taskSummary: {
    totalActive: number;
    overdue: number;
    dueToday: number;
    dueTomorrow: number;
  };
  habitSummary: {
    total: number;
    pendingToday: number;
  };
  userState: {
    /** Compatibility value only. No sleep evidence is currently collected. */
    consecutiveLateNights: number;
    lateNightStatus?: "unknown";
  };
  recentContext: {
    journals?: JournalTitle[];
    lastJournalSummary?: string;
    recentCompletedTasks: string[];
  };
  taskFacts?: TaskFactSnapshot;
}
const injectedDashboards = new WeakMap<InjectedContext, TaskDashboardData>();
export function injectedContextDashboard(context: InjectedContext): TaskDashboardData | undefined { return injectedDashboards.get(context); }
/** Caller must obtain files from the Runtime's private, store-bound commit proof. */
export async function buildInjectedContext(store: StoreHost, now: Date = new Date()): Promise<InjectedContext> {
  const time = getTimeContext(now);
  const date = formatDate(now);
  const dashboard = await store.getTaskDashboard(date, { forContext: true });
  const evidence = dashboardContextData(dashboard);
  const activeTasks = dashboard.tasks.filter((task) => task.status === "active");
  const taskFacts = evidence?.tasks.available === false ? undefined : summarizeTaskFacts(dashboard.tasks, now,
    evidence?.tasks.source ? [evidence.tasks.source.path] : []);
  if (taskFacts && evidence?.tasks.filtered) taskFacts.allowedSourcesOnly = true;
  const habits = dashboard.habits;
  const rawJournal = await store.readDailyPair(date);
  let journal = "";
  if (rawJournal) {
    const memories = await readPersonalMemoryWithSources(store);
    if (memories[personalMemoryReadSnapshot]?.raw != null) journal = createPersonalMemoryContextFilter(memories.records)(rawJournal);
  }

  const context: InjectedContext = {
    ...(evidence ? { availability: { tasks: evidence.tasks.available, habits: evidence.habits.available } } : {}),
    time: {
      iso: now.toISOString(),
      date,
      timeOfDay: time.timeOfDay,
      dayOfWeek: time.weekday
    },
    taskSummary: {
      totalActive: activeTasks.length,
      overdue: activeTasks.filter((task) => isTaskOverdue(task, date)).length,
      dueToday: activeTasks.filter((task) => isTaskOnDate(task, date)).length,
      dueTomorrow: activeTasks.filter((task) => isTaskOnDate(task, addDays(date, 1))).length
    },
    habitSummary: {
      total: habits.length,
      pendingToday: dashboard.habits.filter((habit) => habit.status === "pending").length
    },
    userState: {
      consecutiveLateNights: 0,
      lateNightStatus: "unknown"
    },
    recentContext: {
      journals: recentJournalTitles(store, date),
      lastJournalSummary: summarizeJournal(journal),
      recentCompletedTasks: taskFacts?.completionEvidence.slice(0, 5).map(task => task.title) ?? []
    },
    taskFacts
  };
  injectedDashboards.set(context, dashboard);
  return context;
}
function taskSummaryLine(context: InjectedContext): string {
  return context.availability?.tasks === false ? "- 任务记录未提供，当前任务数量与完成状态未知；不能当成零项。" : `- 任务概况：未完成任务总计 ${context.taskSummary.totalActive} 个（其中过期 ${context.taskSummary.overdue} 个、今天到期 ${context.taskSummary.dueToday} 个、明天到期 ${context.taskSummary.dueTomorrow} 个）。这些分类均包含在未完成总数内，可能重叠，不能相加或当成额外任务。统计不提供具体任务身份。`;
}
function habitSummaryLine(context: InjectedContext): string {
  return context.availability?.habits === false ? "- 习惯记录未提供，当前数量与打卡状态未知；不能当成零项。" : `- 习惯概况：共 ${context.habitSummary.total} 个，今天待打卡 ${context.habitSummary.pendingToday} 个。`;
}
function journalSummaryLine(context: InjectedContext): string { return `- 今日日记片段摘要：${context.recentContext.lastJournalSummary}`; }

export function formatContextForInstructions(context: InjectedContext): string {
  const lines = [
    "## Injected LifeOps Facts",
    "- 只把以下内容当作客观事实；不要把它们当成用户情绪标签。",
    `- 当前时间：${context.time.iso}`,
    `- 当前日期：${context.time.date}，${context.time.dayOfWeek}，时段=${context.time.timeOfDay}`,
    taskSummaryLine(context),
    habitSummaryLine(context),
    "- 连续熬夜：缺少可核实的睡眠记录，未知；当前时间和任务文字不能证明睡眠或连续熬夜。"
  ];
  if (context.recentContext.lastJournalSummary) {
    lines.push(journalSummaryLine(context));
  }
  const facts = context.taskFacts;
  if (facts) {
    if (facts.sourcePaths.length) lines.push(`- 任务状态来源：${facts.sourcePaths.join("、")}；读取时间：${facts.observedAt}。`);
    if (facts.allowedSourcesOnly) lines.push("- 本轮仅统计允许提供的任务记录，不能代表被排除的事项或完整总数。");
    lines.push(`- 今日已核实完成（${context.time.date}）：${facts.completionEvidence.filter(item => item.localDate === context.time.date).length} 个。只统计有效完成日期落在本地今日的已完成任务；回答的首句、清单和结尾必须与此一致。`);
    const completed = facts.completionEvidence.slice(0, 5);
    lines.push(`- 近7个本地日有完成日期的任务（${facts.completionWindowStart} 至 ${facts.completionWindowEnd}）：${facts.completionEvidence.length} 个。`);
    for (const task of completed) {
      lines.push(`  - ${task.title} [task:${task.taskId}]；完成${task.completedAt.length === 10 ? "日期" : "时间"}=${task.completedAt}；本地日期=${task.localDate}`);
    }
    if (facts.completionEvidence.length > completed.length) lines.push(`- 上面仅展示最新 ${completed.length} 条完成依据，不是完整清单；不要用展示条数替代总数。`);
    if (facts.incompleteCompletionCount) {
      lines.push(`- ${facts.incompleteCompletionCount} 个已标记完成的任务，完成日期缺失或无效，未计入近期完成数；这不是全部历史完成数。`);
    }
  } else {
    lines.push("- 完成记录：缺少可核实的任务状态与完成时间，未知。用户表达和 AI 回复不作为完成依据。");
  }
  return lines.join("\n");
}

function isTaskOnDate(task: LifeOpsTask, date: string): boolean {
  return task.date === date || task.dueDate === date;
}

/** Task status is evidence; text claims and updatedAt are not completion timestamps. */
export function summarizeTaskFacts(tasks: LifeOpsTask[], now: Date, sourcePaths: string[]): TaskFactSnapshot {
  const date = formatDate(now);
  const start = addDays(date, -6);
  const byId = new Map<string, LifeOpsTask>();
  for (const task of tasks) {
    if (!byId.has(task.id)) byId.set(task.id, task);
  }
  const distinct = [...byId.values()];
  const active = distinct.filter(task => task.status === "active");
  const completionEvidence: TaskCompletionEvidence[] = [];
  let incompleteCompletionCount = 0;
  for (const task of distinct) {
    if (task.status !== "completed") continue;
    const completedAt = task.completedAt || "";
    const point = taskCompletionPoint(completedAt);
    const invalidTime = point?.timestamp !== undefined && (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(completedAt)
      || point.timestamp > now.getTime() || Number(completedAt.slice(11, 13)) > 23
      || new Date(`${completedAt.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== completedAt.slice(0, 10));
    if (!task.id || !point || point.date > date || invalidTime) {
      incompleteCompletionCount += 1;
      continue;
    }
    if (point.date < start) continue;
    completionEvidence.push({ taskId: task.id, title: task.title, completedAt, localDate: point.date });
  }
  completionEvidence.sort((a, b) => b.localDate.localeCompare(a.localDate) || Date.parse(b.completedAt) - Date.parse(a.completedAt));
  return {
    observedAt: now.toISOString(), sourcePaths, activeTasks: active.length,
    overdueTasks: active.filter(task => isTaskOverdue(task, date)).length,
    completionWindowStart: start, completionWindowEnd: date,
    completionEvidence, incompleteCompletionCount
  };
}

function summarizeJournal(markdown: string): string {
  return flattenJournal(markdown).slice(0, 220);
}
function flattenJournal(markdown: string): string { return markdown.replace(/[#>*`_\-\[\]]/g, " ").replace(/\s+/g, " ").trim(); }
