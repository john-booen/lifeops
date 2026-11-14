import { todayString } from "../../date";
import type { HabitDatabase, StoreHost } from "../../store/settingsSlice";
import type { HabitCheckin, HabitTarget } from "../../types";
import { readHealthRange } from "./store";

export const HEALTH_HABIT_SOURCES = {
  "health:runningKm": { label: "按健康记录的跑步公里数", key: "runningKm", unit: "公里" },
  "health:steps": { label: "按健康记录的步数", key: "steps", unit: "步" },
  "health:weightKg": { label: "有健康体重记录即打卡", key: "weightKg", unit: "" }
} as const;

type HealthHabitSource = keyof typeof HEALTH_HABIT_SOURCES;

export function isHealthHabitSource(source: string | undefined): source is HealthHabitSource {
  return typeof source === "string" && Object.hasOwn(HEALTH_HABIT_SOURCES, source);
}

export function assertHealthHabitTarget(source: string | undefined, target: HabitTarget | undefined): void {
  if (!isHealthHabitSource(source)) return;
  const { unit } = HEALTH_HABIT_SOURCES[source];
  if (unit ? target?.kind !== "number" || target.unit !== unit : target?.kind !== "boolean") {
    throw Error("请选择与健康数据来源相符的记录方式和目标。");
  }
}

/** Derive a single daily value. Keep explicit check-ins, including leave, authoritative. */
export async function projectHealthHabitProgress(store: StoreHost, database: HabitDatabase): Promise<{
  checkins: HabitCheckin[];
  partial: boolean;
}> {
  const habits = database.habits.filter(habit => isHealthHabitSource(habit.source));
  if (!habits.length) return { checkins: database.checkins, partial: false };
  const start = habits.map(habit => habit.startDate).sort()[0];
  const { days, partial } = await readHealthRange(store, start, todayString());
  const checkins = database.checkins.slice();
  const existing = new Set(checkins.map(row => row.habitId + ":" + row.date));
  for (const habit of habits) {
    if (!isHealthHabitSource(habit.source)) continue;
    const { key, unit } = HEALTH_HABIT_SOURCES[habit.source];
    for (const day of days) {
      const value = day[key];
      if (value === undefined || day.date < habit.startDate || existing.has(habit.id + ":" + day.date)) continue;
      checkins.push({ habitId: habit.id, date: day.date, status: "done", count: 1,
        ...(unit ? { value, valueUnit: unit } : {}), updatedAt: day.date + "T00:00:00.000Z", note: "由已核对的健康记录计算" });
    }
  }
  return { checkins, partial };
}
