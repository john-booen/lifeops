import type { HealthDay } from "../health/model";
import { clockFromMatch, clockMatches } from "../../clockText";
import { addDays, formatDate, journalDateToken, normalizeJournalDate } from "../../date";
import { fileRevision } from "../../operationIdentity";
import type { LifeOpsTask, TaskDashboardData } from "../../types";
import { currentSignalValues, type JournalSignal, type SignalField, type SignalSource } from "../journal/signals";
import { todayTaskCounts } from "../stats/stats";
import { todayTaskPlan } from "../tasks/priority";
import { compensationDaysLate, compensationDueLabel, compensationSummaryLine, summarizeCompensationDebt } from "../habits/compensationDebt";
import { isManualHabitSource } from "../habits/targets";

export interface JournalPlanChoice {
  title: string;
  text: string;
  when: string | null;
  journalDate: string;
  date: string;
  time?: string;
  source: SignalSource;
}

const normalizedTitle = (title: string) => title.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
const planDateAndClock = new RegExp(`^(${journalDateToken})\\s*(.+)$`, "u");

export function journalPlanTaskSource(plan: JournalPlanChoice): string {
  return `lifeops-journal-plan:${fileRevision(JSON.stringify([plan.source.path, plan.journalDate, plan.text, plan.when]))}`;
}

export function existingJournalPlanTask(tasks: readonly LifeOpsTask[], plan: JournalPlanChoice): LifeOpsTask | undefined {
  const source = journalPlanTaskSource(plan), title = normalizedTitle(plan.title);
  const matchesSchedule = (task: LifeOpsTask) => {
    if (plan.time) return task.date === plan.date && (task.startTime || task.time) === plan.time;
    if (plan.date) return task.date === plan.date || task.dueDate === plan.date;
    return task.status === "active" || task.date === plan.journalDate;
  };
  return tasks.find(task => task.status !== "abandoned" && (task.source === source || normalizedTitle(task.title) === title
    && matchesSchedule(task)));
}

function readPlanSchedule(when: string | null, journalDate: string): Pick<JournalPlanChoice, "date" | "time"> {
  if (!when) return { date: "" };
  const date = normalizeJournalDate(when, journalDate);
  if (date) return { date };
  const parts = planDateAndClock.exec(when.normalize("NFKC").trim());
  if (!parts) return { date: "" };
  const [, day, rest] = parts;
  const dateWithClock = normalizeJournalDate(day, journalDate);
  const [clock] = clockMatches(rest);
  if (!dateWithClock || clock?.[0] !== rest) return { date: "" };
  const dayPeriod = day.endsWith("早") ? "早上" : /[晚夜]$/u.test(day) ? "晚上" : undefined;
  const clockWithPeriod = dayPeriod && !clock[1] ? clockMatches(dayPeriod + rest)[0] : clock;
  const time = clockWithPeriod ? clockFromMatch(clockWithPeriod) : null;
  return time ? { date: dateWithClock, time } : { date: "" };
}

export function journalPlanChoices(signals: readonly JournalSignal[]): JournalPlanChoice[] {
  const choices = new Map<string, JournalPlanChoice>();
  for (const signal of signals) {
    for (const plan of signal.plans) {
      const title = plan.text.replace(/\s+/gu, " ").trim();
      if (!title) continue;
      const schedule = readPlanSchedule(plan.when, signal.date);
      const key = JSON.stringify([normalizedTitle(title), schedule.date, schedule.time]);
      if (!choices.has(key)) choices.set(key, { ...plan, title, journalDate: signal.date, ...schedule, source: signal.sources[0] });
    }
  }
  return [...choices.values()];
}

const STATUS_FIELDS: Array<{ field: SignalField; label: string; unit: string }> = [
  { field: "energy", label: "精力", unit: "/5" },
  { field: "mood", label: "情绪", unit: "/5" },
  { field: "sleepHours", label: "睡眠", unit: " 小时" },
  { field: "sleepQuality", label: "睡眠质量", unit: "/5" }
];

export function correctableYesterdayHabit(board: TaskDashboardData, task: LifeOpsTask, today: string) {
  const penalty = task.habitPunishment;
  if (task.status !== "active" || task.category !== "punishment" || penalty?.period !== "day"
    || penalty.judgedDate !== addDays(today, -1)) return;
  const habit = board.habits.find(item => item.habit.id === penalty.habitId)?.habit;
  if (habit && isManualHabitSource(habit.source)) return habit;
}

export function buildTodayCard(board: TaskDashboardData, signals: readonly JournalSignal[], now: Date, health?: HealthDay) {
  const values = currentSignalValues(signals);
  const latest = signals.slice().reverse();
  const status = STATUS_FIELDS.map(({ field, label, unit }) => {
    const note = latest.find(signal => signal[field] !== null);
    const quote = note?.quotes.find(quote => quote.field === field)?.text;
    return { label, value: values[field] === null ? "未记录" : `${values[field]}${unit}`, quote };
  });
  const date = board.date;
  const { completed, total } = todayTaskCounts(board.tasks, date, now);
  const { capacity, priorities } = todayTaskPlan(board.tasks, now, values.energy ?? undefined, health?.sleepHours);
  const today = formatDate(now);
  return {
    date, status, completed, total, capacity,
    ...(health && (health.sleepHours !== undefined || health.steps !== undefined) ? { health: { sleepHours: health.sleepHours, steps: health.steps } } : {}),
    priorities: priorities.slice(0, 3).map(({ task, reasons }) => ({ id: task.id, title: task.title, reasons })),
    habits: board.habits.map(item => ({
      id: item.habit.id, title: item.habit.name, done: item.periodDone, target: item.periodTarget,
      period: item.periodLabel, unit: item.periodUnit ?? "次", unavailable: item.periodUnavailable,
      ...(item.healthCoveragePartial ? { healthCoveragePartial: true } : {}),
      ...(item.healthUnrecorded ? { healthUnrecorded: true } : {})
    })),
    compensationSummary: compensationSummaryLine(summarizeCompensationDebt(board.tasks, today)),
    penalties: board.tasks.filter(task => task.status === "active" && task.category === "punishment" && task.habitPunishment)
      .map(task => {
        const penalty = task.habitPunishment!;
        return { id: task.id, title: task.title, dueDate: task.dueDate, evidence: penalty.evidence,
          due: compensationDueLabel(penalty), daysLate: compensationDaysLate(penalty, today),
          canCorrectYesterday: !!correctableYesterdayHabit(board, task, today) };
      }),
    plans: journalPlanChoices(signals).map(plan => ({ plan, added: !!existingJournalPlanTask(board.tasks, plan) }))
  };
}

export type TodayCardData = ReturnType<typeof buildTodayCard> & { ideaCandidateCount?: number; quizDueCount?: number };
