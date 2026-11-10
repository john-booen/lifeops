export interface JournalFileRef {
  path: string;
  mtime?: number;
}

export type JournalPeriod = "早" | "晚";

export function isJournalPath(path: string, journalRoot: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(journalRoot);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function journalDateFromPath(path: string, journalRoot: string, fallbackYear?: string): string | null {
  if (!isJournalPath(path, journalRoot)) return null;
  const normalized = normalizePath(path);
  const basename = normalized.split("/").pop()?.replace(/\.md$/i, "") ?? "";

  const fullDate = basename.match(/(?:^|\D)(\d{4})\s*(?:[-._]|年)\s*(\d{1,2})\s*(?:[-._]|月)\s*(\d{1,2})(?:日|号)?/u);
  if (fullDate) return validDate(fullDate[1], fullDate[2], fullDate[3]);

  const { year: pathYear, month: folderMonth } = inferYearMonthFromPath(normalized, journalRoot);
  const year = pathYear ?? fallbackYear ?? null;
  if (!year) return null;

  const monthDay = basename.match(/(?:^|\D)(\d{1,2})\s*(?:[-._]|月)\s*(\d{1,2})(?:日|号)?/u);
  if (monthDay) return validDate(year, monthDay[1], monthDay[2]);

  const dayOnly = basename.match(/^(\d{1,2})(?:日|号)?(?:\D.*)?$/u);
  if (dayOnly && folderMonth) return validDate(year, folderMonth, dayOnly[1]);
  return null;
}

export function journalPeriodFromPath(path: string): JournalPeriod | null {
  const basename = normalizePath(path).split("/").pop()?.replace(/\.md$/i, "") ?? "";
  if (basename.includes("早")) return "早";
  if (basename.includes("晚")) return "晚";
  return null;
}

export function findJournalFilesForDate<T extends JournalFileRef>(
  files: T[],
  journalRoot: string,
  date: string,
  period?: JournalPeriod
): T[] {
  return files
    .filter((file) => journalDateFromPath(file.path, journalRoot, date.slice(0, 4)) === date)
    .filter((file) => !period || journalPeriodFromPath(file.path) === period || journalPeriodFromPath(file.path) === null)
    .sort((left, right) => {
      const periodDiff = journalPeriodRank(left.path) - journalPeriodRank(right.path);
      if (periodDiff !== 0) return periodDiff;
      return left.path.localeCompare(right.path, "zh-CN");
    });
}

export function findLatestJournalFiles<T extends JournalFileRef>(
  files: T[],
  journalRoot: string
): T[] {
  return files
    .map((file) => ({
      file,
      date: journalDateFromPath(file.path, journalRoot)
    }))
    .filter((entry): entry is { file: T; date: string } => Boolean(entry.date))
    .sort((left, right) => {
      const dateDiff = right.date.localeCompare(left.date);
      if (dateDiff !== 0) return dateDiff;
      const periodDiff = journalPeriodRank(right.file.path) - journalPeriodRank(left.file.path);
      if (periodDiff !== 0) return periodDiff;
      const mtimeDiff = (right.file.mtime ?? 0) - (left.file.mtime ?? 0);
      if (mtimeDiff !== 0) return mtimeDiff;
      return right.file.path.localeCompare(left.file.path, "zh-CN");
    })
    .map((entry) => entry.file);
}

export function isLatestJournalRequest(message: string): boolean {
  const normalized = message.replace(/\s+/g, "");
  return /(?:最后|最新|最近一篇|上一次).{0,10}(?:日记|晨间记录|晚间记录)/u.test(normalized)
    || /(?:日记|晨间记录|晚间记录).{0,10}(?:最后|最新|最近一篇|上一次)/u.test(normalized);
}

function inferYearMonthFromPath(path: string, journalRoot: string): { year: string | null; month: string | null } {
  const root = normalizePath(journalRoot);
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const parts = relative.split("/").slice(0, -1);
  const yearIndex = parts.findIndex((part) => /^\d{4}$/.test(part));
  const monthParts = yearIndex === -1 ? parts : parts.slice(yearIndex + 1);
  const monthPart = monthParts.find((part) => /^(?:0?[1-9]|1[0-2])(?:月)?$/.test(part));
  return {
    year: yearIndex === -1 ? null : parts[yearIndex],
    month: monthPart?.replace("月", "") ?? null
  };
}

function validDate(yearValue: string, monthValue: string, dayValue: string): string | null {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function journalPeriodRank(path: string): number {
  const period = journalPeriodFromPath(path);
  if (period === "早") return 0;
  if (period === "晚") return 2;
  return 1;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}
