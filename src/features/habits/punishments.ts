import { addDays, formatDate, normalizeJournalDate, weekDates } from "../../date";
import type { HabitDatabase } from "../../store/settingsSlice";
import type { HabitCheckin, HabitDefinition, LifeOpsTask, LifeOpsTaskInput } from "../../types";
import { initialCompensationDebt } from "./compensationDebt";
import { habitRecordedAmount, isHabitRequiredOn, numericHabitPeriods, validateHabitPunishment } from "./targets";

type Period = "day" | "week";
interface HabitGoal { period: Period; goal: number }

export function firstUncheckedHabitDay(database: HabitDatabase, habit: HabitDefinition, today: string): string {
  const previous = (Object.hasOwn(database.habitPunishmentCheckedThrough ?? {}, habit.id)
    ? database.habitPunishmentCheckedThrough?.[habit.id] : undefined)
    ?? (database.habitPunishmentCheckedThrough === undefined ? database.lastPunishmentDate : undefined);
  const afterPrevious = typeof previous === "string" && normalizeJournalDate(previous) === previous ? addDays(previous, 1) : "";
  return [addDays(today, -7), habit.startDate, afterPrevious].sort().at(-1)!;
}

function outcome(habit: HabitDefinition, checkins: HabitCheckin[], date: string, { period, goal }: HabitGoal) {
  const allDays = (period === "day" ? [date] : weekDates(date)).filter(day => day >= habit.startDate && day <= date);
  const days = allDays.filter(day => isHabitRequiredOn(habit, day));
  if (!days.length) return undefined;
  const measuredDays = period === "week" && habit.target?.kind === "number" ? allDays : days;
  const entries = checkins.filter(item => item.habitId === habit.id && measuredDays.includes(item.date));
  const amount = entries.reduce((sum, item) => sum + habitRecordedAmount(habit, item), 0);
  return { amount, failed: amount < goal && !days.every(day => entries.some(item => item.date === day && item.status === "leave")) };
}

export function habitDayGoalMet(habit: HabitDefinition, checkins: HabitCheckin[], date: string): boolean {
  const goal = habit.target?.kind === "number" ? habit.target.perDay : habit.targetCount;
  return goal !== undefined && habitRecordedAmount(habit, checkins.find(item => item.habitId === habit.id && item.date === date)) >= goal;
}

function recentMisses(habit: HabitDefinition, checkins: HabitCheckin[], date: string, goal: HabitGoal): string[] {
  const misses = [date];
  const step = goal.period === "week" ? 7 : 1;
  const limit = Math.min(3660, Math.max(7, habit.frequencyInterval * 7 * 5));
  for (let offset = step; offset <= limit && misses.length < 4; offset += step) {
    const day = addDays(date, -offset);
    if (day < habit.startDate) break;
    const result = outcome(habit, checkins, day, goal);
    if (result?.failed) misses.push(day);
    else if (result) break;
  }
  return misses;
}

export function planHabitPunishments(habits: HabitDefinition[], checkins: HabitCheckin[], tasks: LifeOpsTask[], now: Date): LifeOpsTaskInput[] {
  if (now.getHours() < 21) return [];
  const date = formatDate(now), dueDate = addDays(date, 1);
  const generated: LifeOpsTaskInput[] = [];
  for (const habit of habits) {
    if (!habit.punishment?.enabled) continue;
    const config = validateHabitPunishment(habit.punishment)!;
    const goals: HabitGoal[] = habit.target?.kind === "number" ? numericHabitPeriods(habit)
      : [{ period: habit.frequencyUnit, goal: habit.targetCount }];
    for (const goal of goals) {
      if (goal.period === "week" && now.getDay() !== 0) continue;
      const current = outcome(habit, checkins, date, goal);
      const source = `lifeops-punishment:${encodeURIComponent(habit.id)}:${goal.period}:${date}`;
      if (!current?.failed || tasks.some(task => task.source === source)) continue;
      // Another miss feeds the existing debt until it is completed.
      if (tasks.some(task => task.status === "active" && task.habitPunishment?.habitId === habit.id
        && task.habitPunishment.period === goal.period && task.habitPunishment.rule)) continue;
      const missedDates = recentMisses(habit, checkins, date, goal);
      const level = Math.min(config.rules.length, missedDates.length);
      const rule = config.rules[level - 1];
      const unit = habit.target?.kind === "number" ? habit.target.unit : "次";
      const description = `${habit.name}${goal.period === "week" ? "本周" : "今天"} ${current.amount}/${goal.goal} ${unit}`;
      const dates = missedDates.slice().reverse().join("、");
      const evidence = `${description}。连续 ${missedDates.length === 4 ? "至少 4" : missedDates.length} 个周期未达标（${dates}）。`;
      const task: LifeOpsTaskInput = {
        title: `补偿：${description}`,
        category: "punishment", date: dueDate, dueDate, source,
        note: evidence,
        habitPunishment: { habitId: habit.id, period: goal.period, judgedDate: date, level, missedDates, openEarlier: 0, evidence, rule,
          debt: initialCompensationDebt(rule, dueDate) }
      };
      generated.push(task);
    }
  }
  return generated;
}
