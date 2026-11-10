import { formatDate } from "./date";

export type TimeOfDay = "morning" | "midday" | "afternoon" | "evening" | "night";

export interface TimeContext {
  date: string;
  weekday: string;
  time: string;
  timeOfDay: TimeOfDay;
  isWorkday: boolean;
  isTradingWindow: boolean;
  isWeeklyReviewDay: boolean;
  season: string;
}

export function getTimeContext(date = new Date()): TimeContext {
  return {
    date: formatDate(date),
    weekday: weekdayLabel(date),
    time: formatLocalTime(date),
    timeOfDay: inferTimeOfDay(date),
    isWorkday: isWorkday(date),
    isTradingWindow: isTradingWindow(date),
    isWeeklyReviewDay: date.getDay() === 0,
    season: seasonLabel(date)
  };
}

export function timeContextToMarkdown(context: TimeContext): string {
  return [
    "## Runtime Time Context",
    `- 当前日期：${context.date}（${context.weekday}）`,
    `- 当前时间：${context.time}`,
    `- 时间段：${timeOfDayLabel(context.timeOfDay)}`,
    `- 工作日：${context.isWorkday ? "是" : "否"}`,
    `- 交易时段：${context.isTradingWindow ? "可能处于交易/复盘敏感时段" : "否"}`,
    `- 周复盘日：${context.isWeeklyReviewDay ? "是" : "否"}`,
    `- 季节：${context.season}`
  ].join("\n");
}

export function inferTimeOfDay(date: Date): TimeOfDay {
  const hour = date.getHours();
  if (hour < 7) return "night";
  if (hour < 11) return "morning";
  if (hour < 14) return "midday";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}

export function isTradingWindow(date: Date): boolean {
  const day = date.getDay();
  const minutes = date.getHours() * 60 + date.getMinutes();
  const weekday = day >= 1 && day <= 5;
  const asiaMorning = weekday && minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30;
  const asiaAfternoon = weekday && minutes >= 13 * 60 && minutes <= 15 * 60;
  const europeUsOverlap = weekday && minutes >= 15 * 60 && minutes <= 23 * 60 + 30;
  const usEvening = weekday && minutes >= 21 * 60 + 30;
  const usOvernight = day >= 2 && day <= 6 && minutes <= 4 * 60;
  return asiaMorning || asiaAfternoon || europeUsOverlap || usEvening || usOvernight;
}

function isWorkday(date: Date): boolean {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

function weekdayLabel(date: Date): string {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
}

function formatLocalTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function seasonLabel(date: Date): string {
  const month = date.getMonth() + 1;
  if (month >= 3 && month <= 5) return "春";
  if (month >= 6 && month <= 8) return "夏";
  if (month >= 9 && month <= 11) return "秋";
  return "冬";
}

function timeOfDayLabel(value: TimeOfDay): string {
  switch (value) {
    case "morning":
      return "上午";
    case "midday":
      return "中午";
    case "afternoon":
      return "下午";
    case "evening":
      return "晚上";
    case "night":
      return "深夜/清晨";
  }
}
