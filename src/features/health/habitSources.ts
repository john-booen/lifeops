export const HEALTH_HABIT_SOURCES = {
  "health:runningKm": { label: "按健康记录的跑步公里数", key: "runningKm", unit: "公里" },
  "health:steps": { label: "按健康记录的步数", key: "steps", unit: "步" },
  "health:weightKg": { label: "有健康体重记录即打卡", key: "weightKg", unit: "" }
} as const;

type HealthHabitSource = keyof typeof HEALTH_HABIT_SOURCES;

export function isHealthHabitSource(source: string | undefined): source is HealthHabitSource {
  return typeof source === "string" && Object.hasOwn(HEALTH_HABIT_SOURCES, source);
}
