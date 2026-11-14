import type { StatsRange } from "../stats/stats";

const periods = {
  今天: "today", 这周: "this_week", 本周: "this_week", 上周: "last_week",
  最近三天: "last_3d", 最近七天: "last_7d", 本月: "this_month", 这个月: "this_month", 上个月: "last_month"
} as const satisfies Record<string, StatsRange>;

export function deviceSleepQuestion(message: string): StatsRange | undefined {
  const text = message.trim().replace(/[。！？!?]+$/u, "");
  const match = /^(?:请问[，, ]*)?(今天|这周|本周|上周|最近三天|最近七天|本月|这个月|上个月)(?:的)?(?:设备|手表)(?:上)?(?:记录的|测到的)(?:平均)?睡眠(?:时长)?(?:平均(?:是)?多少(?:小时)?|有多少(?:小时)?|怎么样)$/u.exec(text);
  return match ? periods[match[1] as keyof typeof periods] : undefined;
}

export function deviceSleepAnswer(output: string): string {
  const data = JSON.parse(output) as { range: { from: string; to: string }; sleepHours?: { average: number | null; recordedDays: number }; scope?: string };
  const { from, to } = data.range;
  const days = from === to ? from : `${from} 至 ${to}`;
  const sleep = data.sleepHours;
  const scope = data.scope ? "只统计允许读取的健康记录。" : "";
  if (!sleep?.recordedDays || sleep.average === null) return `${days} 暂无可读的设备睡眠记录。${scope}`;
  return `${days} 有 ${sleep.recordedDays} 天设备睡眠记录，平均 ${sleep.average} 小时。${scope}`;
}
