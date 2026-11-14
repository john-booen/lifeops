import { startOfWeek } from "../../date";
import { isHealthHabitSource } from "../health/habitSources";
import type { HabitCheckin, HabitDefinition, HabitPunishment, HabitTarget, PunishmentRule } from "../../types";

export const EXERCISE_SINGLE_CAP = { 公里: 3, 分钟: 30 };
export const EXERCISE_DAY_CAP = { 公里: 5, 分钟: 60 };

export function isHabitRequiredOn(habit: HabitDefinition, date: string): boolean {
  const elapsed = Date.parse(`${date}T00:00:00Z`) - Date.parse(`${habit.startDate}T00:00:00Z`);
  const unitDays = habit.frequencyUnit === "week" ? 7 : 1;
  return elapsed >= 0 && Math.floor(elapsed / (unitDays * 86_400_000)) % habit.frequencyInterval === 0;
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const onlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

export function habitMeasurementUnit(input: unknown): string | undefined {
  if (typeof input !== "string" || /[\r\n]/.test(input)) return undefined;
  const unit = input.trim();
  return unit && unit.length <= 20 ? unit : undefined;
}

export function validateHabitTarget(value: unknown): HabitTarget | undefined {
  if (value === undefined) return undefined;
  const target = object(value);
  const unit = habitMeasurementUnit(target?.unit);
  if (target?.kind === "boolean" && onlyKeys(target, ["kind"])) return { kind: "boolean" };
  if (target?.kind === "number" && onlyKeys(target, ["kind", "unit", "perDay", "perWeek"])
    && unit
    && (target.perDay === undefined || positive(target.perDay)) && (target.perWeek === undefined || positive(target.perWeek))
    && (positive(target.perDay) || positive(target.perWeek))) {
    return { kind: "number", unit, perDay: target.perDay as number | undefined, perWeek: target.perWeek as number | undefined };
  }
  throw Error("数值习惯需要单位，以及大于零的每日或每周目标。");
}

function validatePunishmentRule(input: unknown): PunishmentRule {
  const rule = object(input);
  if (rule?.kind === "save_money" && onlyKeys(rule, ["kind", "amount", "currency", "dailyIncrease"])
    && positive(rule.amount) && (rule.dailyIncrease === undefined || positive(rule.dailyIncrease))
    && (rule.currency === "CNY" || rule.currency === "USD" || rule.currency === "SGD")) {
    return { kind: rule.kind, amount: rule.amount, currency: rule.currency,
      ...(positive(rule.dailyIncrease) ? { dailyIncrease: rule.dailyIncrease } : {}) };
  }
  if (rule?.kind === "reflection" && onlyKeys(rule, ["kind", "minChars", "dailyIncrease"])
    && positive(rule.minChars) && Number.isSafeInteger(rule.minChars)
    && (rule.dailyIncrease === undefined || positive(rule.dailyIncrease) && Number.isSafeInteger(rule.dailyIncrease))) {
    return { kind: rule.kind, minChars: rule.minChars,
      ...(positive(rule.dailyIncrease) ? { dailyIncrease: rule.dailyIncrease } : {}) };
  }
  if (rule?.kind === "extra_exercise" && onlyKeys(rule, ["kind", "activity", "amount", "unit", "dailyLimit", "overflowCnyPerUnit"])
    && (rule.activity === "跑步" || rule.activity === "快走" || rule.activity === "跳绳")
    && (rule.unit === "公里" || rule.unit === "分钟") && positive(rule.amount)
    && rule.amount <= EXERCISE_SINGLE_CAP[rule.unit]
    && (rule.dailyLimit === undefined || positive(rule.dailyLimit) && rule.dailyLimit <= EXERCISE_DAY_CAP[rule.unit])
    && (rule.overflowCnyPerUnit === undefined || positive(rule.overflowCnyPerUnit))) {
    return { kind: rule.kind, activity: rule.activity, amount: rule.amount, unit: rule.unit,
      ...(positive(rule.dailyLimit) ? { dailyLimit: rule.dailyLimit } : {}),
      ...(positive(rule.overflowCnyPerUnit) ? { overflowCnyPerUnit: rule.overflowCnyPerUnit } : {}) };
  }
  throw Error("补偿限存钱、写反思或加量运动。运动单次最多 3 公里或 30 分钟。");
}

export function validateHabitPunishment(input: unknown): HabitPunishment | undefined {
  if (input === undefined) return undefined;
  const config = object(input);
  if (!config || !onlyKeys(config, ["enabled", "rules"]) || typeof config.enabled !== "boolean"
    || !Array.isArray(config.rules) || config.rules.length > 3 || (config.enabled && !config.rules.length)) {
    throw Error("请为已启用的补偿设置一至三级规则。");
  }
  return { enabled: config.enabled, rules: config.rules.map(validatePunishmentRule) };
}

export function numericHabitPeriods(habit: HabitDefinition): Array<{ period: "day" | "week"; goal: number }> {
  const target = habit.target;
  if (target?.kind !== "number") return [];
  const periods: Array<{ period: "day" | "week"; goal: number }> = [];
  if (positive(target.perDay)) periods.push({ period: "day", goal: target.perDay });
  if (positive(target.perWeek)) periods.push({ period: "week", goal: target.perWeek });
  return periods;
}

export function habitRecordedAmount(habit: HabitDefinition, checkin: HabitCheckin | undefined): number {
  if (checkin?.status !== "done") return 0;
  if (habit.target?.kind === "number") return typeof checkin.value === "number" && Number.isFinite(checkin.value)
    && (checkin.valueUnit === undefined || checkin.valueUnit === habit.target.unit) ? Math.max(0, checkin.value) : 0;
  return Math.max(1, checkin.count || 1);
}

export function automaticHabitDayDisplay(habit: HabitDefinition, checkin?: HabitCheckin): { status: "done" | "pending"; label: string } | undefined {
  const fromDevice = isHealthHabitSource(habit.source);
  if (!fromDevice && habit.source !== "trades") return undefined;
  if (!checkin && fromDevice) return { status: "pending", label: "未记录" };
  if (checkin?.status !== "done" || habit.target?.kind !== "number") return undefined;
  const { perDay, unit } = habit.target;
  if (!fromDevice && !perDay) return undefined;
  const amount = habitRecordedAmount(habit, checkin);
  return {
    status: perDay && amount < perDay ? "pending" : "done",
    label: `${amount}${perDay ? "/" + perDay : ""} ${unit}`
  };
}

export function healthHabitReadingDays(habit: HabitDefinition, checkins: readonly HabitCheckin[]): number {
  const source = habit.source;
  if (!isHealthHabitSource(source)) return 0;
  return new Set(checkins.filter(checkin => checkin.status === "done" && checkin.date >= habit.startDate
    && (habit.target?.kind !== "number" || typeof checkin.value === "number" && Number.isFinite(checkin.value)
      && (checkin.valueUnit === undefined || checkin.valueUnit === habit.target.unit)))
    .map(checkin => checkin.date)).size;
}

export function numericHabitGoalProgress(
  habit: HabitDefinition, checkins: readonly HabitCheckin[], required: string[], days: string[], includeWeek = true
) {
  const entries = new Map(checkins.filter(item => item.habitId === habit.id && item.date >= habit.startDate).map(item => [item.date, item]));
  const deviceBased = isHealthHabitSource(habit.source);
  return numericHabitPeriods(habit).filter(goal => includeWeek || goal.period === "day").map(({ period, goal }) => {
    const keyFor = period === "week" ? startOfWeek : (date: string) => date;
    const scheduled = required.filter(date => entries.get(date)?.status !== "leave");
    const progress = new Map(scheduled.map(date => [keyFor(date), 0]));
    const unrecorded = new Set(deviceBased ? scheduled.filter(date => !entries.has(date)).map(keyFor) : []);
    for (const date of period === "week" ? days : required) {
      const key = keyFor(date), existing = progress.get(key);
      if (existing !== undefined) progress.set(key, existing + habitRecordedAmount(habit, entries.get(date)));
    }
    const met = [...progress.values()].filter(amount => amount >= goal).length;
    const missedDates = [...progress].filter(([date, amount]) => amount < goal && !unrecorded.has(date)).map(([date]) => date);
    const unknownPeriods = progress.size - met - missedDates.length;
    return { period, goal, met, periods: progress.size - unknownPeriods, missedDates,
      ...(unknownPeriods ? { unknownPeriods } : {}) };
  });
}

export function numericHabitWindow(habit: HabitDefinition, checkins: readonly HabitCheckin[], requiredDays: string[], days: string[]) {
  const goals = numericHabitGoalProgress(habit, checkins, requiredDays, days);
  const required = goals.reduce((sum, goal) => sum + goal.periods, 0);
  const done = goals.reduce((sum, goal) => sum + goal.met, 0);
  const unknown = goals.reduce((sum, goal) => sum + (goal.unknownPeriods ?? 0), 0);
  return { required, done, rate: required ? Math.round(done / required * 100) : unknown ? null : 100 };
}
