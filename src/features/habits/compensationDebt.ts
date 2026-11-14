import { addDays, normalizeJournalDate } from "../../date";
import { taskCompletionDay } from "../../taskSchedule";
import type { ExerciseCompensationUnit, HabitCompensationSettings, HabitDefinition, HabitPunishmentTask, LifeOpsTask, PunishmentRule } from "../../types";
import { EXERCISE_DAY_CAP, EXERCISE_SINGLE_CAP } from "./targets";

type Exercise = Extract<PunishmentRule, { kind: "extra_exercise" }>;
type Currency = Extract<PunishmentRule, { kind: "save_money" }>["currency"];
type Amounts = Partial<Record<Currency, number>>;
type Debt = NonNullable<HabitPunishmentTask["debt"]>;

export const DEFAULT_REFLECTION_INCREASE = 100;
const defaultOverflowRates: Record<ExerciseCompensationUnit, number> = { 公里: 20, 分钟: 3 };
const currencyNames: Record<Currency, string> = { CNY: "元", USD: "美元", SGD: "新元" };
const bounded = (n: number) => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, n));
const decimal = (n: number) => bounded(Math.round(bounded(n) * 100) / 100);
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;
const dayGap = (from: string, to: string) => bounded(dayNumber(to) - dayNumber(from)) || 0;
const isDay = (day: string) => Boolean(day && normalizeJournalDate(day) === day);
const finitePositive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export function exerciseOverflowRate(unit: ExerciseCompensationUnit, settings?: HabitCompensationSettings): number {
  const rate = settings?.exerciseOverflowCny?.[unit];
  return finitePositive(rate) ? rate : defaultOverflowRates[unit];
}

export function exerciseLimitMultiplier(settings?: HabitCompensationSettings): number {
  const multiplier = settings?.exerciseLimitMultiplier;
  return finitePositive(multiplier) ? multiplier : 2;
}

export function initialCompensationDebt(rule: PunishmentRule, dueDate: string): Debt {
  return { base: rule, appliedOn: dueDate, policyVersion: 2 };
}

export function compensationDaysLate(penalty: HabitPunishmentTask, day: string): number {
  return isDay(penalty.judgedDate) ? dayGap(addDays(penalty.judgedDate, 1), day) : 0;
}

function overflowMoney(penalty: HabitPunishmentTask): number {
  const debt = penalty.debt;
  if (debt?.policyVersion === 2) return debt.overflowCny ?? 0;
  const base = debt?.base;
  return base?.kind === "extra_exercise" && finitePositive(base.overflowCnyPerUnit)
    ? decimal((debt?.overflowUnits ?? 0) * base.overflowCnyPerUnit) : 0;
}

export function compensationRuleLabel(rule: PunishmentRule): string {
  if (rule.kind === "save_money") return `存 ${rule.amount} ${currencyNames[rule.currency]}`;
  if (rule.kind === "reflection") return `写反思至少 ${rule.minChars} 字`;
  return `${rule.activity} ${rule.amount} ${rule.unit}`;
}

export function compensationDueLabel(penalty: HabitPunishmentTask): string {
  const rule = penalty.rule;
  const parts = rule && (rule.kind !== "extra_exercise" || rule.amount > 0) ? [compensationRuleLabel(rule)] : [];
  const cash = overflowMoney(penalty);
  if (cash > 0) parts.push(`超量转存 ${cash} 元`);
  return parts.join("、");
}

function matchingRule(penalty: HabitPunishmentTask, habit?: HabitDefinition): PunishmentRule | undefined {
  const configured = habit?.punishment?.rules[penalty.level - 1];
  const saved = penalty.rule;
  if (configured?.kind !== saved?.kind) return;
  if (configured?.kind === "extra_exercise"
    && (saved?.kind !== "extra_exercise" || configured.unit !== saved.unit || configured.activity !== saved.activity)) return;
  return configured;
}

function exerciseDailyLimit(penalty: HabitPunishmentTask, rule: Exercise, habit: HabitDefinition | undefined,
  settings: HabitCompensationSettings | undefined): number {
  const configured = matchingRule(penalty, habit);
  const current = configured?.kind === "extra_exercise" ? configured : rule;
  const base = penalty.debt?.base;
  const original = habit?.target?.kind === "number" && habit.target.unit === rule.unit && finitePositive(habit.target.perDay)
    ? habit.target.perDay : base?.kind === "extra_exercise" ? base.amount : current.amount;
  return finitePositive(current.dailyLimit) ? current.dailyLimit : bounded(original * exerciseLimitMultiplier(settings));
}

function currentExerciseRate(rule: PunishmentRule, configured: PunishmentRule | undefined,
  base: PunishmentRule | undefined, settings: HabitCompensationSettings | undefined): number {
  if (rule.kind !== "extra_exercise") return 0;
  const override = configured?.kind === "extra_exercise" ? configured.overflowCnyPerUnit
    : rule.overflowCnyPerUnit ?? (base?.kind === "extra_exercise" ? base.overflowCnyPerUnit : undefined);
  return finitePositive(override) ? override : exerciseOverflowRate(rule.unit, settings);
}

function exerciseBudgets(tasks: readonly LifeOpsTask[], habits: ReadonlyMap<string, HabitDefinition>, day: string,
  settings: HabitCompensationSettings | undefined) {
  const limits = { 公里: new Map<string, number>(), 分钟: new Map<string, number>() };
  const used = { 公里: 0, 分钟: 0 };
  for (const task of tasks) {
    const penalty = task.habitPunishment;
    const rule = penalty?.rule;
    if (!penalty || rule?.kind !== "extra_exercise" || !Object.hasOwn(limits, rule.unit)) continue;
    const doneToday = task.status === "completed" && taskCompletionDay(task.completedAt) === day;
    if (task.status !== "active" && !doneToday) continue;
    const byHabit = limits[rule.unit];
    const limit = exerciseDailyLimit(penalty, rule, habits.get(penalty.habitId), settings);
    byHabit.set(penalty.habitId, Math.max(byHabit.get(penalty.habitId) ?? 0, limit));
    if (doneToday && finitePositive(rule.amount)) used[rule.unit] += rule.amount;
  }
  const budget = (unit: ExerciseCompensationUnit) =>
    Math.min(EXERCISE_DAY_CAP[unit], [...limits[unit].values()].reduce((sum, limit) => sum + limit, 0));
  return { limit: { 公里: budget("公里"), 分钟: budget("分钟") }, used };
}

function assessDebt(penalty: HabitPunishmentTask, rule: PunishmentRule, day: string, exerciseRate: number): Debt {
  const previous = penalty.debt;
  if (previous?.policyVersion === 2) return previous;
  const firstDue = addDays(penalty.judgedDate, 1);
  const appliedOn = [day, firstDue, previous?.appliedOn ?? ""].sort().at(-1)!;
  // Previously priced charges are frozen. Convert an outstanding unpriced balance once.
  const base = previous?.base;
  const cash = base?.kind === "extra_exercise" && !finitePositive(base.overflowCnyPerUnit)
    ? decimal((previous?.overflowUnits ?? 0) * exerciseRate) : overflowMoney(penalty);
  return { ...(previous ?? initialCompensationDebt(rule, appliedOn)), appliedOn, policyVersion: 2,
    ...(cash > 0 ? { overflowCny: cash } : {}) };
}

/**
 * Each active task owns one debt. Moving a task does not restart its clock.
 * Legacy debts start accruing at first assessment and keep previously recorded charges.
 * Allocate exercise oldest first within each unit, after today's completed exercise.
 */
export function advanceCompensationDebt(tasks: readonly LifeOpsTask[], habits: readonly HabitDefinition[], day: string,
  settings?: HabitCompensationSettings): LifeOpsTask[] {
  if (!isDay(day)) return tasks.slice();
  const habitsById = new Map(habits.map(habit => [habit.id, habit]));
  const active = tasks.filter(task => task.status === "active" && task.habitPunishment?.rule && isDay(task.habitPunishment.judgedDate))
    .sort((a, b) => a.habitPunishment!.judgedDate.localeCompare(b.habitPunishment!.judgedDate)
      || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const exercise = exerciseBudgets(tasks, habitsById, day, settings);
  const replacements = new Map<string, LifeOpsTask>();
  for (const task of active) {
    const penalty = task.habitPunishment!, rule = penalty.rule!;
    if (rule.kind === "extra_exercise" && !Object.hasOwn(EXERCISE_SINGLE_CAP, rule.unit)) continue;
    const habit = habitsById.get(penalty.habitId);
    const configured = matchingRule(penalty, habit);
    const rate = currentExerciseRate(rule, configured, penalty.debt?.base, settings);
    const debt = assessDebt(penalty, rule, day, rate);
    const elapsed = dayGap(debt.appliedOn, day);
    const appliedOn = day > debt.appliedOn ? day : debt.appliedOn;
    const base = debt.base;
    let nextRule = rule, overflow = debt.overflowUnits ?? 0, cash = debt.overflowCny ?? 0;
    if (rule.kind === "save_money" && base.kind === "save_money") {
      const step = base.dailyIncrease ?? (base.currency === "CNY" ? 50 : base.amount);
      if (elapsed) nextRule = { ...rule, amount: decimal(rule.amount + elapsed * step) };
    } else if (rule.kind === "reflection" && base.kind === "reflection") {
      const increase = (configured?.kind === "reflection" ? configured.dailyIncrease : base.dailyIncrease)
        ?? DEFAULT_REFLECTION_INCREASE;
      if (elapsed) nextRule = { ...rule, minChars: bounded(rule.minChars + elapsed * increase) };
    } else if (rule.kind === "extra_exercise" && base.kind === "extra_exercise" && Object.hasOwn(EXERCISE_DAY_CAP, rule.unit)) {
      const unit = rule.unit;
      const limit = Math.min(exerciseDailyLimit(penalty, rule, habit, settings), EXERCISE_SINGLE_CAP[unit]);
      const available = Math.floor(Math.max(0, exercise.limit[unit] - exercise.used[unit]) * 1e6 + 1e-8) / 1e6;
      const requested = bounded(rule.amount + elapsed * base.amount);
      const amount = Math.min(requested, limit, available);
      const excess = Math.round((requested - amount) * 1e6) / 1e6;
      overflow = bounded(Math.round((overflow + excess) * 1e6) / 1e6);
      if (excess > 0) cash = decimal(cash + excess * rate);
      if (amount !== rule.amount) nextRule = { ...rule, amount };
      exercise.used[unit] += amount;
    }
    if (penalty.debt === debt && appliedOn === debt.appliedOn && nextRule === rule
      && overflow === (debt.overflowUnits ?? 0) && cash === (debt.overflowCny ?? 0)) continue;
    replacements.set(task.id, { ...task, habitPunishment: { ...penalty, rule: nextRule,
      debt: { ...debt, appliedOn, ...(overflow > 0 ? { overflowUnits: overflow } : {}), ...(cash > 0 ? { overflowCny: cash } : {}) } } });
  }
  return tasks.map(task => replacements.get(task.id) ?? task);
}

export function summarizeCompensationDebt(tasks: readonly LifeOpsTask[], day: string) {
  let count = 0, maxDays = 0, reflection = 0;
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
  }
  return { count, maxDays, due, reflection, exercise, saved };
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
    debt.exercise.分钟 ? `加量 ${debt.exercise.分钟} 分钟` : ""
  ].filter(Boolean).join(" · ");
}
