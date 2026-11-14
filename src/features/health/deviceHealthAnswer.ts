import type { StatsRange } from "../stats/stats";
import { HEALTH_METRICS, type HealthMetric } from "./model";

type HealthReading = { metric: HealthMetric; range: StatsRange; aggregate: "average" | "total" };
const deviceMetrics: Record<string, HealthMetric> = {
  睡眠时长: "sleepHours", 步数: "steps", 跑步距离: "runningKm", 体重: "weightKg", 静息心率: "restingHeartRate"
};

export function deviceHealthQuestion(message: string): HealthReading | undefined {
  const text = message.trim().replace(/(?:只报天数和小时[。！!]?|[。？！?!])$/u, "").replace(/[。？！?!]$/u, "").trim();
  const match = /^(今天|今日|昨晚|这周|本周|上周|这月|本月|这个月|上个月|最近三天|过去三天|最近七天|过去七天)(?:里|的)?(?:手表|设备)(?:记录了?)?的?(睡眠时长|步数|跑步距离|体重|静息心率)(平均|合计|总共|一共)?(?:是)?(?:多少(?:个)?(小时|步|公里|千克|公斤|次\/分)?|(多久))$/u.exec(text);
  if (!match) return;
  const [,period,label,summary,unit,duration] = match;
  const metric = deviceMetrics[label], range = metricPeriod(period);
  const aggregate = summary && summary !== "平均" ? "total" : "average";
  const activity = metric === "steps" || metric === "runningKm";
  const expectedUnit = metric === "weightKg" ? ["千克", "公斤"] : [HEALTH_METRICS[metric].unit];
  if (unit && !expectedUnit.includes(unit) || duration && metric !== "sleepHours"
    || period === "昨晚" && metric !== "sleepHours" || aggregate === "total" && !activity
    || metric !== "sleepHours" && range !== "today" && !summary) return;
  return { metric, range, aggregate };
}

function metricPeriod(period: string): StatsRange {
  if (period === "昨晚" || period === "今天" || period === "今日") return "today";
  if (period === "这周" || period === "本周") return "this_week";
  if (period === "上周") return "last_week";
  if (period === "上个月") return "last_month";
  if (period.endsWith("三天")) return "last_3d";
  if (period.endsWith("七天")) return "last_7d";
  return "this_month";
}

export function deviceHealthAnswer(output: string, metric: HealthMetric, aggregate: HealthReading["aggregate"] = "average"): string {
  const data = JSON.parse(output) as { range: { from: string; to: string }; scope?: string }
    & Partial<Record<HealthMetric, { average: number | null; total?: number | null; recordedDays: number }>>;
  const { from, to } = data.range;
  const days = from === to ? from : `${from} 至 ${to}`;
  const reading = data[metric], value = reading?.[aggregate];
  const scope = data.scope ? "只统计允许读取的健康记录。" : "";
  const label = metric === "sleepHours" ? "睡眠" : HEALTH_METRICS[metric].label;
  const unit = metric === "weightKg" ? "公斤" : HEALTH_METRICS[metric].unit;
  if (!reading?.recordedDays || typeof value !== "number" || !Number.isFinite(value)) return `${days} 暂无可读的设备${label}记录。${scope}`;
  const description = from === to && metric !== "sleepHours" ? "记录值" : aggregate === "total" ? "合计" : "平均";
  return `${days} 有 ${reading.recordedDays} 天设备${label}记录，${description} ${value} ${unit}。${scope}`;
}
