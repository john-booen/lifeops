import type { StatsRange } from "../stats/stats";

export function deviceSleepRange(message: string): StatsRange | undefined {
  const text = message.trim().replace(/(?:只报天数和小时[。！!]?|[。？！?!])$/u, "").replace(/[。？！?!]$/u, "").trim();
  const match = /^(今天|今日|昨晚|这周|本周|上周|这月|本月|这个月|上个月|最近三天|过去三天|最近七天|过去七天)(?:里|的)?(?:手表|设备)(?:记录的|记录了的|记录)?(?:的)?睡眠时长(?:平均)?(?:是)?(?:多少(?:个)?小时|多少|多久)$/u.exec(text);
  if (!match) return;
  const period = match[1];
  if (period === "昨晚" || period === "今天" || period === "今日") return "today";
  if (period === "这周" || period === "本周") return "this_week";
  if (period === "上周") return "last_week";
  if (period === "上个月") return "last_month";
  if (period.endsWith("三天")) return "last_3d";
  if (period.endsWith("七天")) return "last_7d";
  return "this_month";
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
