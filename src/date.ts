export function todayString(): string {
  return formatDate(new Date());
}

/** Empty means unspecified or invalid; callers must not default an invalid supplied date. */
export function normalizeJournalDate(value: string, baseDate = todayString()): string {
  const text = value.trim();
  const offsets: Record<string, number> = {
    今天: 0, 今日: 0, 今晚: 0, 今早: 0,
    昨天: -1, 昨日: -1, 昨晚: -1, 昨夜: -1, 昨早: -1,
    前天: -2, 明天: 1, 明日: 1, 明早: 1, 明晚: 1, 后天: 2
  };
  if (Object.prototype.hasOwnProperty.call(offsets, text)) return addDays(baseDate, offsets[text]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  return formatDate(parseLocalDate(text)) === text ? text : "";
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
