import { formatDate, normalizeJournalDate } from "../../date";
import { fileRevision } from "../../operationIdentity";
import type { LifeOpsTask, TaskDashboardData } from "../../types";
import { currentSignalValues, type JournalSignal, type SignalField, type SignalSource } from "../journal/signals";
import { todayTaskCounts } from "../stats/stats";
import { todayTaskPlan } from "../tasks/priority";
import { compensationDaysLate, compensationDueLabel, compensationSummaryLine, summarizeCompensationDebt } from "../habits/compensationDebt";

export interface JournalPlanChoice {
  title: string;
  text: string;
  when: string | null;
  journalDate: string;
  date: string;
  source: SignalSource;
}

const normalizedTitle = (title: string) => title.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();

export function journalPlanTaskSource(plan: JournalPlanChoice): string {
  return `lifeops-journal-plan:${fileRevision(JSON.stringify([plan.source.path, plan.journalDate, plan.text, plan.when]))}`;
}

export function existingJournalPlanTask(tasks: readonly LifeOpsTask[], plan: JournalPlanChoice): LifeOpsTask | undefined {
  const source = journalPlanTaskSource(plan), title = normalizedTitle(plan.title);
  return tasks.find(task => task.status !== "abandoned" && (task.source === source || normalizedTitle(task.title) === title
    && (plan.date ? task.date === plan.date || task.dueDate === plan.date : task.status === "active" || task.date === plan.journalDate)));
}

export function journalPlanChoices(signals: readonly JournalSignal[]): JournalPlanChoice[] {
  const choices = new Map<string, JournalPlanChoice>();
  for (const signal of signals) {
    for (const plan of signal.plans) {
      const title = plan.text.replace(/\s+/gu, " ").trim();
      if (!title) continue;
      const date = plan.when ? normalizeJournalDate(plan.when, signal.date) : "";
      const key = JSON.stringify([normalizedTitle(title), date]);
      if (!choices.has(key)) choices.set(key, { ...plan, title, journalDate: signal.date, date, source: signal.sources[0] });
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

export function buildTodayCard(board: TaskDashboardData, signals: readonly JournalSignal[], now: Date) {
  const values = currentSignalValues(signals);
  const latest = signals.slice().reverse();
  const status = STATUS_FIELDS.map(({ field, label, unit }) => {
    const note = latest.find(signal => signal[field] !== null);
    const quote = note?.quotes.find(quote => quote.field === field)?.text;
    return { label, value: values[field] === null ? "未记录" : `${values[field]}${unit}`, quote };
  });
  const date = board.date;
  const { completed, total } = todayTaskCounts(board.tasks, date, now);
  const { capacity, priorities } = todayTaskPlan(board.tasks, now, values.energy ?? undefined);
  const today = formatDate(now);
  return {
    date, status, completed, total, capacity,
    priorities: priorities.slice(0, 3).map(({ task, reasons }) => ({ id: task.id, title: task.title, reasons })),
    habits: board.habits.map(item => ({
      id: item.habit.id, title: item.habit.name, done: item.periodDone, target: item.periodTarget,
      period: item.periodLabel, unit: item.periodUnit ?? "次", unavailable: item.periodUnavailable
    })),
    compensationSummary: compensationSummaryLine(summarizeCompensationDebt(board.tasks, today)),
    penalties: board.tasks.filter(task => task.status === "active" && task.category === "punishment" && task.habitPunishment)
      .map(task => {
        const penalty = task.habitPunishment!;
        return { id: task.id, title: task.title, dueDate: task.dueDate, evidence: penalty.evidence,
          due: compensationDueLabel(penalty), daysLate: compensationDaysLate(penalty, today) };
      }),
    plans: journalPlanChoices(signals).map(plan => ({ plan, added: !!existingJournalPlanTask(board.tasks, plan) }))
  };
}

export type TodayCardData = ReturnType<typeof buildTodayCard> & { ideaCandidateCount?: number; quizDueCount?: number };
