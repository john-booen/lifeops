import type { TimeContext } from "./timeContext";
import type { LifeOpsWorkflowId } from "./workflows";
import { formatDate } from "./date";

export type ProactiveLevel = 0 | 1 | 2 | 3 | 4;
export type ProactiveCandidateKind =
  | "daily_brief"
  | "evening_review"
  | "weekly_review"
  | "habit_risk"
  | "trading_discipline"
  | "memory_review"
  | "task_overdue"
  | "sensor_risk"
  | "journal_review"
  | "stalled_idea"
  | "task_overload";

export interface SchedulerSettings {
  enabled: boolean;
  proactiveLevel: ProactiveLevel;
  minMinutesBetweenCandidates: number;
  quietHoursStart: number;
  quietHoursEnd: number;
}

export interface SchedulerContext {
  time: TimeContext;
  now?: Date;
  lastCandidateAt?: string;
  pendingHabitCount?: number;
  habitFailureCount?: number;
  candidateMemoryCount?: number;
  recentTradingSignal?: boolean;
  overdueTaskCount?: number;
  newJournalSignal?: boolean;
  sustainedFatigueRisk?: boolean;
  highRiskActivity?: boolean;
}

export interface ProactiveCandidate {
  id: string;
  kind: ProactiveCandidateKind;
  title: string;
  reason: string;
  priority: "low" | "normal" | "high" | "critical";
  workflowId?: LifeOpsWorkflowId;
  createdAt: string;
  expiresAt: string;
  dedupeKey: string;
  evidenceRefs: string[];
  confidence: number;
  voiceEligible: boolean;
  channel?: "panel" | "notification" | "voice";
  steward?: boolean;
  ideaId?: string;
  summaryPath?: string;
}

export function stewardReminderWindows(now: Date, firstOpen?: string) {
  const opened = firstOpen ? new Date(firstOpen) : undefined;
  const hour = now.getHours(), quiet = isInQuietHours(now, 23, 7);
  return {
    morning: !quiet && hour < 11 && !!opened && formatDate(opened) === formatDate(now)
      && opened.getHours() >= 6 && opened.getHours() < 11,
    evening: !quiet && hour >= 21,
    idea: !quiet && hour >= 14,
    weekly: !quiet && now.getDay() === 0 && hour >= 20,
    overload: !quiet
  };
}

export function stewardCandidate(now: Date, kind: ProactiveCandidateKind, title: string, reason: string,
  details: { priority?: ProactiveCandidate["priority"]; key?: string; ideaId?: string; summaryPath?: string; voiceEligible?: boolean } = {}): ProactiveCandidate {
  const priority = details.priority ?? "normal";
  const entry = candidate(kind, title, reason, priority, now.toISOString(), undefined, [], details.voiceEligible ?? priority === "high");
  const localDay = formatDate(now);
  const dedupeKey = [kind, localDay, details.key].filter(Boolean).join(":");
  return {
    ...entry, id: dedupeKey, dedupeKey, steward: true,
    ...(details.ideaId ? { ideaId: details.ideaId } : {}),
    ...(details.summaryPath ? { summaryPath: details.summaryPath } : {})
  };
}

export const DEFAULT_SCHEDULER_SETTINGS: SchedulerSettings = {
  enabled: false,
  proactiveLevel: 2,
  minMinutesBetweenCandidates: 90,
  quietHoursStart: 23,
  quietHoursEnd: 7
};

export function generateProactiveCandidates(
  context: SchedulerContext,
  settings: SchedulerSettings = DEFAULT_SCHEDULER_SETTINGS
): ProactiveCandidate[] {
  const now = context.now ?? new Date();
  if (shouldSuppressProactiveCandidate(context, settings, now)) return [];
  const createdAt = now.toISOString();
  const candidates: ProactiveCandidate[] = [];
  const hour = now.getHours();

  if (context.time.timeOfDay === "morning" && hour >= 7 && hour < 10) {
    candidates.push(candidate("daily_brief", "今日简报", "现在是上午，适合先看今日任务、习惯和重点风险。", "normal", createdAt, "daily_startup_briefing"));
  }
  if (context.time.timeOfDay === "evening" && hour >= 20) {
    candidates.push(candidate("evening_review", "晚间复盘", "现在接近收尾时间，适合做轻量复盘并整理明天的第一步。", "normal", createdAt, "nightly_consolidation"));
  }
  if (context.time.isWeeklyReviewDay && hour >= 18) {
    candidates.push(candidate("weekly_review", "周复盘", "今天是周复盘日，可以把本周任务、习惯、交易和记忆候选收束一次。", "high", createdAt, "weekly_review"));
  }
  if ((context.habitFailureCount ?? 0) >= 2 || (context.pendingHabitCount ?? 0) >= 3) {
    candidates.push(candidate("habit_risk", "习惯风险", "近期习惯未完成或今天待完成项偏多，可以先查原因、调小下一步；是否补做由你决定。", "normal", createdAt));
  }
  if ((context.overdueTaskCount ?? 0) > 0) {
    candidates.push(candidate(
      "task_overdue",
      "过期任务需要处理",
      `当前有 ${context.overdueTaskCount} 项过期任务，适合决定完成、延期或取消。`,
      "high",
      createdAt,
      undefined,
      ["task-dashboard:overdue"]
    ));
  }
  if (context.recentTradingSignal || context.time.isTradingWindow) {
    candidates.push(candidate("trading_discipline", "交易纪律提醒", "当前可能处于交易或复盘敏感时段，优先检查计划、风控和情绪。", "high", createdAt, "trading_review"));
  }
  if (context.sustainedFatigueRisk && context.highRiskActivity) {
    candidates.push(candidate(
      "sensor_risk",
      "先确认状态再继续",
      "多次观察出现可能疲劳迹象，同时检测到高风险工作情境；建议先确认本人感受并检查风险。",
      "critical",
      createdAt,
      undefined,
      ["situation:possible-fatigue", "situation:high-risk-activity"],
      true
    ));
  }
  if (context.newJournalSignal) {
    candidates.push(candidate(
      "journal_review",
      "新日记可以轻量复盘",
      "检测到今天新增或修改了日记，可以在合适的时候提炼事件和待确认记忆。",
      "low",
      createdAt,
      "nightly_consolidation",
      ["vault:journal-change"]
    ));
  }
  if ((context.candidateMemoryCount ?? 0) > 0) {
    candidates.push(candidate("memory_review", "候选记忆确认", "有待确认的候选记忆，适合由用户决定确认、改写或归档。", "low", createdAt, "memory_candidate_review"));
  }

  return candidates.sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority)).slice(0, 3);
}

export function shouldSuppressProactiveCandidate(
  context: SchedulerContext,
  settings: SchedulerSettings = DEFAULT_SCHEDULER_SETTINGS,
  now = context.now ?? new Date()
): boolean {
  if (!settings.enabled) return true;
  if (settings.proactiveLevel < 2) return true;
  if (isInQuietHours(now, settings.quietHoursStart, settings.quietHoursEnd) && !context.time.isWeeklyReviewDay) return true;
  if (!context.lastCandidateAt) return false;
  const last = Date.parse(context.lastCandidateAt);
  if (Number.isNaN(last)) return false;
  return now.getTime() - last < settings.minMinutesBetweenCandidates * 60_000;
}

export function isInQuietHours(now: Date, startHour: number, endHour: number): boolean {
  const hour = now.getHours();
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

function candidate(
  kind: ProactiveCandidateKind,
  title: string,
  reason: string,
  priority: ProactiveCandidate["priority"],
  createdAt: string,
  workflowId?: LifeOpsWorkflowId,
  evidenceRefs: string[] = [],
  voiceEligible = false
): ProactiveCandidate {
  return {
    id: `${kind}_${createdAt.replace(/\D/g, "").slice(0, 14)}`,
    kind,
    title,
    reason,
    priority,
    workflowId,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 24 * 60 * 60_000).toISOString(),
    dedupeKey: `${kind}:${createdAt.slice(0, 10)}`,
    evidenceRefs,
    confidence: evidenceRefs.length > 1 ? 0.82 : evidenceRefs.length === 1 ? 0.72 : 0.62,
    voiceEligible
  };
}

function priorityRank(priority: ProactiveCandidate["priority"]): number {
  if (priority === "critical") return 4;
  if (priority === "high") return 3;
  if (priority === "normal") return 2;
  return 1;
}
