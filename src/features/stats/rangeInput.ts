import {addDays,formatDate,normalizeJournalDate,startOfWeek} from "../../date";

export const statsNamedRanges = ["today", "last_3d", "this_week", "last_week", "last_7d", "this_month", "last_month", "last_30d"] as const;
export const ISO_DATE_INTERVAL_PATTERN = "^(\\d{4}-\\d{2}-\\d{2})(?:\\.\\.|/)(\\d{4}-\\d{2}-\\d{2})$";
const isoDateInterval = new RegExp(ISO_DATE_INTERVAL_PATTERN);
type IsoInterval = `${number}-${number}-${number}..${number}-${number}-${number}` | `${number}-${number}-${number}/${number}-${number}-${number}`;
export type StatsRange = { from: string; to: string } | typeof statsNamedRanges[number] | IsoInterval;
export type DayRange = {from:string;to:string};

/** Decode one equivalent model representation, then keep all existing date,
 * period and source-policy checks. No dates are inferred or widened here. */
export function serializedDateRange(value: unknown): { from: string; to: string } | undefined {
  if (typeof value !== "string" || !value.trim().startsWith("{")) return;
  const invalid = () => Error("统计区间需要只含 from、to 两个日期文字的对象。");
  if (value.length > 256) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "from,to"
    || typeof record.from !== "string" || typeof record.to !== "string") throw invalid();
  return { from: record.from, to: record.to };
}

export function resolveStatsRange(range: StatsRange, now: Date): DayRange {
  if (!Number.isFinite(now.getTime())) throw Error("统计时间无效。");
  range = serializedDateRange(range) ?? range;
  const today = formatDate(now);
  if (typeof range === "string") {
    const interval = isoDateInterval.exec(range);
    if (interval) return resolveStatsRange({ from: interval[1], to: interval[2] }, now);
  }
  if (typeof range === "object" && range !== null) {
    const from = typeof range.from === "string" ? normalizeJournalDate(range.from, today) : "";
    const to = typeof range.to === "string" ? normalizeJournalDate(range.to, today) : "";
    if (!from || !to || from > to) {
      throw Error("统计区间需要有效的起止日期，开始日期不能晚于结束日期。");
    }
    return { from, to };
  }
  if (range === "last_week") {
    const to = addDays(startOfWeek(today), -1);
    return { from: addDays(to, -6), to };
  }
  if (range === "last_month") {
    const to = addDays(today.slice(0, 7) + "-01", -1);
    return { from: to.slice(0, 7) + "-01", to };
  }
  const start = {
    today, last_3d: addDays(today, -2), this_week: startOfWeek(today), last_7d: addDays(today, -6),
    this_month: today.slice(0, 7) + "-01", last_30d: addDays(today, -29)
  };
  if (!Object.hasOwn(start, range)) throw Error("不支持这个统计区间。");
  return { from: start[range as keyof typeof start], to: today };
}


/** Shared schema for the same named and literal calendar ranges. */
export function dateRangeParameter(names:readonly string[]=statsNamedRanges){return {anyOf:[{type:"string",enum:[...names]},{type:"object",additionalProperties:false,properties:{from:{type:"string"},to:{type:"string"}},required:["from","to"]},{type:"string",pattern:ISO_DATE_INTERVAL_PATTERN}]};}
