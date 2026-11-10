import { addDays, formatDate, normalizeJournalDate } from "../../date";
import type { HabitDefinition, HabitPunishmentTask, LifeOpsTask, PunishmentRule } from "../../types";
import { EXERCISE_DAY_CAP, EXERCISE_SINGLE_CAP } from "./targets";

type Exercise = Extract<PunishmentRule, { kind: "extra_exercise" }>;
type Currency = Extract<PunishmentRule, { kind: "save_money" }>["currency"];
type Amounts = Partial<Record<Currency, number>>;

const currencyNames: Record<Currency, string> = { CNY: "元", USD: "美元", SGD: "新元" };
const bounded = (n: number) => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, n));
const decimal = (n: number) => bounded(Math.round(bounded(n) * 100) / 100);
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;
const dayGap = (from: string, to: string) => bounded(dayNumber(to) - dayNumber(from)) || 0;
const isDay = (day: string) => Boolean(day && normalizeJournalDate(day) === day);
const finitePositive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

function exerciseFraction(rule?: PunishmentRule): number {
  return rule?.kind === "extra_exercise" && Object.hasOwn(EXERCISE_DAY_CAP, rule.unit)
    ? (finitePositive(rule.amount) ? rule.amount : 0) / EXERCISE_DAY_CAP[rule.unit] : 0;
}

function exerciseBase(rule: Exercise, habit?: HabitDefinition): Exercise {
  const original = habit?.target?.kind === "number" && habit.target.unit === rule.unit
    && finitePositive(habit.target.perDay) ? habit.target.perDay : rule.amount;
  return { ...rule, dailyLimit: Math.min(finitePositive(rule.dailyLimit) ? rule.dailyLimit : original * 2, EXERCISE_SINGLE_CAP[rule.unit]) };
}

export function initialCompensationDebt(rule: PunishmentRule, dueDate: string, habit?: HabitDefinition): NonNullable<HabitPunishmentTask["debt"]> {
  return { base: rule.kind === "extra_exercise" ? exerciseBase(rule, habit) : rule, appliedOn: dueDate };
}

export function compensationDaysLate(penalty: HabitPunishmentTask, day: string): number {
  return isDay(penalty.judgedDate) ? dayGap(addDays(penalty.judgedDate, 1), day) : 0;
}

function overflowMoney(penalty: HabitPunishmentTask): number {
  const base = penalty.debt?.base;
  return base?.kind === "extra_exercise" && finitePositive(base.overflowCnyPerUnit)
    ? decimal((penalty.debt?.overflowUnits ?? 0) * base.overflowCnyPerUnit) : 0;
}

export function compensationRuleLabel(rule: PunishmentRule): string {
  if (rule.kind === "save_money") return `存 ${rule.amount} ${currencyNames[rule.currency]}`;
  if (rule.kind === "reflection") return `写反思至少 ${rule.minChars} 字`;
  return `${rule.activity} ${rule.amount} ${rule.unit}`;
}

export function compensationDueLabel(penalty: HabitPunishmentTask): string {
  const rule = penalty.rule;
  const parts = rule && (rule.kind !== "extra_exercise" || rule.amount > 0) ? [compensationRuleLabel(rule)] : [];
  const base = penalty.debt?.base;
  if (base?.kind === "extra_exercise" && penalty.debt?.overflowUnits) {
    parts.push(finitePositive(base.overflowCnyPerUnit)
      ? `超量转存 ${overflowMoney(penalty)} 元`
      : `超量 ${penalty.debt.overflowUnits} ${base.unit}，待设置存钱折算`);
  }
  return parts.join("、");
}

/**
 * Each active task owns one debt. Moving a task does not restart its clock.
 * Legacy debts start accruing at first assessment; historical amounts stay intact.
 * Exercise is allocated oldest first, after today's completed exercise, under both
 * a per-task limit and the existing shared safety budget. Overflow never returns
 * to the physical obligation after another task is cleared.
 */
export function advanceCompensationDebt(tasks: readonly LifeOpsTask[], habits: readonly HabitDefinition[], day: string): LifeOpsTask[] {
  if (!isDay(day)) return tasks.slice();
  const habitsById = new Map(habits.map(habit => [habit.id, habit]));
  const active = tasks.filter(task => task.status === "active" && task.habitPunishment?.rule && isDay(task.habitPunishment.judgedDate))
    .sort((a, b) => a.habitPunishment!.judgedDate.localeCompare(b.habitPunishment!.judgedDate)
      || a.createdAt.localeCompare(b.createdAt));
  let exerciseUsed = tasks.reduce((sum, task) => task.status === "completed" && task.completedAt
    && formatDate(new Date(task.completedAt)) === day ? sum + exerciseFraction(task.habitPunishment?.rule) : sum, 0);
  const replacements = new Map<string, LifeOpsTask>();
  for (const task of active) {
    const penalty = task.habitPunishment!, rule = penalty.rule!;
    if (rule.kind === "extra_exercise" && !Object.hasOwn(EXERCISE_SINGLE_CAP, rule.unit)) continue;
    const habit = habitsById.get(penalty.habitId);
    const firstDue = addDays(penalty.judgedDate, 1);
    const debt = penalty.debt ?? initialCompensationDebt(rule, day > firstDue ? day : firstDue, habit);
    const elapsed = dayGap(debt.appliedOn, day);
    const appliedOn = day > debt.appliedOn ? day : debt.appliedOn;
    let base = debt.base;
    let nextRule = rule, overflow = debt.overflowUnits ?? 0;
    if (rule.kind === "save_money" && base.kind === "save_money") {
      const step = base.dailyIncrease ?? (base.currency === "CNY" ? 50 : base.amount);
      if (elapsed) nextRule = { ...rule, amount: decimal(rule.amount + elapsed * step) };
    } else if (rule.kind === "reflection" && base.kind === "reflection") {
      if (elapsed) nextRule = { ...rule, minChars: bounded(rule.minChars + elapsed * (base.dailyIncrease ?? base.minChars)) };
    } else if (rule.kind === "extra_exercise" && base.kind === "extra_exercise" && Object.hasOwn(EXERCISE_DAY_CAP, rule.unit)) {
      if (base.overflowCnyPerUnit === undefined) {
        const approved = habit?.punishment?.rules.find(candidate => candidate.kind === "extra_exercise"
          && candidate.activity === rule.activity && candidate.unit === rule.unit && finitePositive(candidate.overflowCnyPerUnit));
        if (approved?.kind === "extra_exercise") base = { ...base, overflowCnyPerUnit: approved.overflowCnyPerUnit };
      }
      const limit = Math.min(finitePositive(base.dailyLimit) ? base.dailyLimit : base.amount * 2, EXERCISE_SINGLE_CAP[rule.unit]);
      const available = Math.floor(Math.max(0, 1 - exerciseUsed) * EXERCISE_DAY_CAP[rule.unit] * 100 + 1e-8) / 100;
      const requested = bounded(rule.amount + elapsed * base.amount);
      const amount = Math.min(requested, limit, available);
      overflow = bounded(Math.round(bounded(overflow + requested - amount) * 1e6) / 1e6);
      if (amount !== rule.amount) nextRule = { ...rule, amount };
      exerciseUsed += exerciseFraction(nextRule);
    }
    if (penalty.debt && appliedOn === debt.appliedOn && base === debt.base && nextRule === rule && overflow === (debt.overflowUnits ?? 0)) continue;
    replacements.set(task.id, { ...task, habitPunishment: { ...penalty, rule: nextRule,
      debt: { base, appliedOn, ...(overflow > 0 ? { overflowUnits: overflow } : {}) } } });
  }
  return tasks.map(task => replacements.get(task.id) ?? task);
}

export function summarizeCompensationDebt(tasks: readonly LifeOpsTask[], day: string) {
  let count = 0, maxDays = 0, reflection = 0, pendingConversion = 0;
  const due: Amounts = {}, saved: Amounts = {};
  const exercise = { 公里: 0, 分钟: 0 };
  const addMoney = (totals: Amounts, currency: Currency, amount: number) => {
    totals[currency] = decimal((totals[currency] ?? 0) + amount);
  };
  for (const task of tasks) {
    const penalty = task.habitPunishment;
    const rule = penalty?.rule;
    if (!penalty || !rule) continue;
    const cash = overflowMoney(penalty);
    if (task.status === "completed") {
      if (rule.kind === "save_money") addMoney(saved, rule.currency, rule.amount);
      if (cash > 0) addMoney(saved, "CNY", cash);
    }
    if (task.status !== "active") continue;
    count++;
    maxDays = Math.max(maxDays, compensationDaysLate(penalty, day));
    if (rule.kind === "save_money") addMoney(due, rule.currency, rule.amount);
    else if (rule.kind === "reflection") reflection = bounded(reflection + rule.minChars);
    else if (Object.hasOwn(exercise, rule.unit)) exercise[rule.unit] = decimal(exercise[rule.unit] + rule.amount);
    if (cash > 0) addMoney(due, "CNY", cash);
    if (penalty.debt?.overflowUnits && penalty.debt.base.kind === "extra_exercise"
      && !finitePositive(penalty.debt.base.overflowCnyPerUnit)) pendingConversion++;
  }
  return { count, maxDays, due, reflection, exercise, pendingConversion, saved };
}

export function formatCompensationMoney(totals: Amounts): string {
  return (Object.keys(currencyNames) as Currency[]).flatMap(currency =>
    totals[currency] ? [`${totals[currency]} ${currencyNames[currency]}`] : []).join("、");
}

export function compensationSummaryLine(debt: ReturnType<typeof summarizeCompensationDebt>): string {
  if (!debt.count) return "";
  const amount = formatCompensationMoney(debt.due);
  return [`欠 ${debt.count} 项`, debt.maxDays ? `最长已拖 ${debt.maxDays} 天` : "尚未逾期",
    amount ? `应存 ${amount}` : "", debt.reflection ? `反思 ${debt.reflection} 字` : "",
    debt.exercise.公里 ? `加量 ${debt.exercise.公里} 公里` : "",
    debt.exercise.分钟 ? `加量 ${debt.exercise.分钟} 分钟` : "",
    debt.pendingConversion ? `${debt.pendingConversion} 项运动超量待设折算` : ""
  ].filter(Boolean).join(" · ");
}
