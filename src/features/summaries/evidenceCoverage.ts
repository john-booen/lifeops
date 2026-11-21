import { normalizeJournalDate } from "../../date";

export interface EvidenceCoverageDay { date: string; status: string }
const statuses = ["已返回可读片段", "有日记，可读正文未命中主题", "允许范围未找到日记", "有日记，片段暂不可核对", "有日记，本次未读齐"] as const;

/** Count calendar dates, never the number of morning/evening notes. */
export function evidenceCoverage(range: { from: string; to: string }, days: EvidenceCoverageDay[], returnedNotes: number, hasTopic: boolean) {
  if (normalizeJournalDate(range.from) !== range.from || normalizeJournalDate(range.to) !== range.to || range.from > range.to
    || !Number.isSafeInteger(returnedNotes) || returnedNotes < 0
    || new Set(days.map(row => row.date)).size !== days.length
    || days.some(row => row.date < range.from || row.date > range.to || !statuses.includes(row.status as typeof statuses[number]))) {
    throw Error("日记覆盖范围无法核对，请重新查询。");
  }
  const requestedDays = Math.round((Date.parse(range.to + "T00:00:00Z") - Date.parse(range.from + "T00:00:00Z")) / 86400000) + 1;
  const [matchedDays, unmatchedDays, missingDays, unavailableDays, limitedDays] = statuses.map(status => days.filter(row => row.status === status).length);
  const counts = { requestedDays, scopeDays: days.length, withJournalDays: days.length - missingDays,
    matchedDays, unmatchedDays, missingDays, unavailableDays, limitedDays,
    outsideScopeDays: requestedDays - days.length, returnedNotes };
  const summary = `原文核对：所问范围共${requestedDays}天，本次覆盖${counts.scopeDays}天；允许范围内${counts.withJournalDays}天有日记，${missingDays}天未找到日记。`
    + `${matchedDays}天返回${hasTopic ? "主题" : "日记"}片段${hasTopic ? `，${unmatchedDays}天有日记但可读正文未命中主题` : ""}；${unavailableDays}天片段暂不可核对，${limitedDays}天本次未读齐。`
    + `共返回${returnedNotes}篇片段，篇数和天数分别计算。`
    + (counts.outsideScopeDays ? `另${counts.outsideScopeDays}天未在本次原文读取范围，不能按没写日记统计。` : "")
    + "未命中主题或未找到日记都不能表示当天没做。";
  return { counts, summary };
}
