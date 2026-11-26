export function todayString(): string {
  return formatDate(new Date());
}

const relativeDays: Readonly<Record<string, number>> = {
  今天: 0, 今日: 0, 今晚: 0, 今早: 0,
  昨天: -1, 昨日: -1, 昨晚: -1, 昨夜: -1, 昨早: -1,
  前天: -2, 大前天: -3, 明天: 1, 明日: 1, 明早: 1, 明晚: 1, 后天: 2, 大后天: 3
};
const weekdays = "一二三四五六日";
const digits = "〇一二三四五六七八九";
const dayNumberPattern = "[0-9０-９一二三四五六七八九十]{1,3}";
const weekPrefixPattern = "这周|本周|下周";
const weekNumberPattern = "[一二三四五六日天1-7１-７]";
const weekDay = new RegExp(`^(${weekPrefixPattern}|周)(${weekNumberPattern})$`, "u");
const monthDay = new RegExp(`^(?:(${dayNumberPattern})月)?(${dayNumberPattern})[日号]$`, "u");
const thisWeekend = ["周末", "本周末", "这周末", "这个周末"];
const nextWeekend = ["下周末", "下个周末"];
const monthEnd = ["月底", "本月底", "这个月底"];

/** Date token within an explicit scheduling command. Validate it with normalizeJournalDate. */
export const journalDateToken = [
  String.raw`[0-9０-９]{4}[-－][0-9０-９]{2}[-－][0-9０-９]{2}`,
  `(?:${dayNumberPattern}月)?${dayNumberPattern}[日号]`,
  `(?:${weekPrefixPattern}|周)${weekNumberPattern}`,
  ...[...Object.keys(relativeDays), ...thisWeekend, ...nextWeekend, ...monthEnd].sort((a, b) => b.length - a.length)
].join("|");

function validLocalDay(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && formatDate(parseLocalDate(text)) === text;
}

function dateNumber(text: string): number {
  if (/^\d{1,2}$/.test(text)) return Number(text);
  if (text.length === 1 && text !== "十") return digits.indexOf(text);
  const parts = /^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(text);
  if (!parts) return NaN;
  const [, tens, ones] = parts;
  return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0);
}

/** Empty means unspecified or invalid. Bare month/day uses the base year/month;
 * a bare weekday uses this week, consistently with an explicit 本周 prefix. */
export function normalizeJournalDate(value: string, baseDate = todayString()): string {
  const text = value.trim().normalize("NFKC");
  if (validLocalDay(text)) return text;
  if (!validLocalDay(baseDate)) return "";
  if (Object.hasOwn(relativeDays, text)) return addDays(baseDate, relativeDays[text]);
  const week = weekDay.exec(text);
  if (week) {
    const day = week[2] === "天" ? 6 : /^\d$/.test(week[2]) ? Number(week[2]) - 1 : weekdays.indexOf(week[2]);
    return addDays(startOfWeek(baseDate), day + (week[1] === "下周" ? 7 : 0));
  }
  if (thisWeekend.includes(text)) {
    return parseLocalDate(baseDate).getDay() === 0 ? baseDate : addDays(startOfWeek(baseDate), 5);
  }
  if (nextWeekend.includes(text)) return addDays(startOfWeek(baseDate), 12);
  const [year, month] = baseDate.split("-");
  if (monthEnd.includes(text)) return formatDate(new Date(Number(year), Number(month), 0));
  const day = monthDay.exec(text);
  if (!day) return "";
  const withMonth = day[1] ? String(dateNumber(day[1])).padStart(2, "0") : month;
  const result = `${year}-${withMonth}-${String(dateNumber(day[2])).padStart(2, "0")}`;
  return validLocalDay(result) ? result : "";
}

export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Display a saved timestamp in the device's local time without changing its value. */
export function formatLocalTime(timestamp: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(timestamp)) return "";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function startOfWeek(dateString: string): string {
  const date = parseLocalDate(dateString);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return formatDate(date);
}

export function weekDates(dateString: string): string[] {
  const start = parseLocalDate(startOfWeek(dateString));
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return formatDate(date);
  });
}

export function endOfWeek(dateString: string): string {
  return weekDates(dateString)[4];
}

export function parseLocalDate(dateString: string): Date {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function addDays(dateString: string, days: number): string {
  const date = parseLocalDate(dateString);
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

export function datesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    dates.push(cursor);
    if (cursor === endDate) break;
    cursor = addDays(cursor, 1);
  }
  return dates;
}
