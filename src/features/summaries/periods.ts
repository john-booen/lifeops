import { addDays, datesBetween, formatDate, parseLocalDate, startOfWeek } from "../../date";
import { resolveStatsRange, type StatsRange } from "../stats/stats";

export type SummaryLevel = "day" | "week" | "month";
export type SummaryRange = { from: string; to: string };
export type SummaryPeriod = SummaryRange & { level: SummaryLevel; key: string };
export const summaryLevels: SummaryLevel[] = ["day", "week", "month"];
export const summaryFolders: Record<SummaryLevel, string> = { day: "日", week: "周", month: "月" };

export function summaryPeriod(level: SummaryLevel, day: string): SummaryPeriod {
  if (level === "day") return { level, key: day, from: day, to: day };
  if (level === "month") {
    const first = parseLocalDate(day.slice(0, 7) + "-01");
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    return { level, key: day.slice(0, 7), from: formatDate(first), to: formatDate(last) };
  }
  const from = startOfWeek(day);
  const thursday = addDays(from, 3);
  const year = thursday.slice(0, 4);
  const yearStart = startOfWeek(year + "-01-04");
  const utcDay = (value: string) => Date.parse(value + "T00:00:00Z") / 86_400_000;
  const number = (utcDay(from) - utcDay(yearStart)) / 7 + 1;
  return { level, key: year + "-W" + String(number).padStart(2, "0"), from, to: addDays(from, 6) };
}

export function scheduledSummaryPeriods(now: Date): SummaryPeriod[] {
  const today = formatDate(now);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const week = summaryPeriod("week", today);
  return [
    summaryPeriod("day", addDays(today, -1)),
    ...(minutes >= 23 * 60 + 30 ? [summaryPeriod("day", today)] : []),
    week.to === today && minutes >= 21 * 60 + 30 ? week : summaryPeriod("week", addDays(week.from, -1)),
    summaryPeriod("month", addDays(today.slice(0, 7) + "-01", -1))
  ];
}

export function summaryPeriodsInRange(level: SummaryLevel, range: SummaryRange): SummaryPeriod[] {
  const periods = new Map<string, SummaryPeriod>();
  for (const day of datesBetween(range.from, range.to)) {
    const period = summaryPeriod(level, day);
    periods.set(period.key, period);
  }
  return [...periods.values()];
}

export function resolveSummaryRange(range: StatsRange | "last_week" | "last_month", now: Date): SummaryRange {
  const today = formatDate(now);
  if (range === "last_week") return summaryPeriod("week", addDays(startOfWeek(today), -1));
  if (range === "last_month") return summaryPeriod("month", addDays(today.slice(0, 7) + "-01", -1));
  const result = resolveStatsRange(range, now);
  if (result.from < addDays(result.to, -365)) throw Error("一次最多查一年的摘要。");
  return result;
}

export function summaryBackfillPeriods(now: Date): SummaryPeriod[] {
  const end = addDays(startOfWeek(formatDate(now)), -1);
  const range = { from: addDays(end, -55), to: end };
  return [...summaryPeriodsInRange("day", range), ...summaryPeriodsInRange("week", range)];
}
