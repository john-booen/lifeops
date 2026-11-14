import { isHealthHabitSource, projectHealthHabitProgress } from "../health/habits";
import { isVaultPathExcluded } from "../../privacy";
import type { HabitDatabase, StoreHost } from "../../store/settingsSlice";
import type { HabitCheckin, HabitDefinition, HabitTarget } from "../../types";
import type { Trade } from "../trading/types";

export function assertTradeHabitSource(source: string | undefined, target: HabitTarget | undefined, unit: HabitDefinition["frequencyUnit"], interval: number): void {
  if (source === "trades" && (unit !== "day" || interval !== 1 || target?.kind !== "number" || target.unit !== "笔"
    || target.perWeek !== undefined || !Number.isSafeInteger(target.perDay) || (target.perDay ?? 0) <= 0)) {
    throw new Error("交易笔数习惯按天统计，请设置每天的整数笔数。");
  }
}

export function tradeHabitDayDisplay(habit: HabitDefinition, checkin?: HabitCheckin): { status: "done" | "pending"; label: string } | undefined {
  if (habit.source !== "trades" || habit.target?.kind !== "number" || !habit.target.perDay || checkin?.status !== "done") return undefined;
  const count = checkin.value ?? 0;
  return { status: count >= habit.target.perDay ? "done" : "pending", label: `${count}/${habit.target.perDay} 笔` };
}

function projectTradeCheckins(database: HabitDatabase, trades: readonly Trade[]): HabitCheckin[] {
  const automatic = database.habits.filter(habit => habit.source === "trades");
  const ids = new Set(automatic.map(habit => habit.id));
  const checkins = database.checkins.filter(row => !ids.has(row.habitId) || row.status === "leave");
  const leave = new Set(checkins.filter(row => row.status === "leave").map(row => `${row.habitId}:${row.date}`));
  const daily = new Map<string, { count: number; updatedAt: string }>();
  for (const trade of trades) {
    const date = trade.openedAt.slice(0, 10), previous = daily.get(date);
    daily.set(date, { count: (previous?.count ?? 0) + 1,
      updatedAt: !previous || Date.parse(trade.updatedAt) > Date.parse(previous.updatedAt) ? trade.updatedAt : previous.updatedAt });
  }
  for (const habit of automatic) for (const [date, { count, updatedAt }] of daily) {
    if (date < habit.startDate || leave.has(`${habit.id}:${date}`)) continue;
    checkins.push({ habitId: habit.id, date, status: "done", count, value: count, valueUnit: "笔", updatedAt, note: "由交易记录计算" });
  }
  return checkins;
}

export async function automaticHabitProgress(store: StoreHost, database: HabitDatabase, respectPrivacy = false): Promise<{
  checkins: HabitCheckin[]; unavailable: boolean; healthPartial?: boolean;
}> {
  const withHealth = async (checkins: HabitCheckin[], unavailable: boolean) => {
    const health = await projectHealthHabitProgress(store, { ...database, checkins }).catch(() =>
      ({ checkins, partial: database.habits.some(habit => isHealthHabitSource(habit.source)) }));
    return { checkins: health.checkins, unavailable, ...(health.partial ? { healthPartial: true } : {}) };
  };
  if (!database.habits.some(habit => habit.source === "trades")) return withHealth(database.checkins, false);
  try {
    const { readTradeDatabase, tradeDatabasePath } = await import("../trading/persistence");
    const excluded = store.settings.privacy?.excludedVaultPrefixes;
    if (respectPrivacy && isVaultPathExcluded(tradeDatabasePath(store.settings.folders), excluded)) throw new Error("交易记录已排除。");
    const { trades } = await readTradeDatabase(store);
    if (respectPrivacy && trades.some(trade => trade.source.kind === "backfill" && trade.source.ref && isVaultPathExcluded(trade.source.ref, excluded))) {
      throw new Error("部分交易原文已排除。");
    }
    return withHealth(projectTradeCheckins(database, trades), false);
  } catch {
    return withHealth(projectTradeCheckins(database, []), true);
  }
}
