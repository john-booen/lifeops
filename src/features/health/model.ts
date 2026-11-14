import { MarkdownBlocks } from "../../dataFoundation/markdownBlocks";
import { normalizeJournalDate } from "../../date";
import type { HealthEntry } from "../../types";

export const HEALTH_METRICS = {
  sleepHours: { label: "睡眠小时", unit: "小时", max: 24 },
  steps: { label: "步数", unit: "步", max: 200_000 },
  runningKm: { label: "跑步距离", unit: "公里", max: 400 },
  weightKg: { label: "体重", unit: "kg", max: 700 },
  restingHeartRate: { label: "静息心率", unit: "次/分", max: 300 }
} as const;

export type HealthMetric = keyof typeof HEALTH_METRICS;
export const healthMetricKeys = Object.keys(HEALTH_METRICS) as HealthMetric[];
export type HealthDay = Pick<HealthEntry, "date"> & Partial<Record<HealthMetric, number>>;

export function healthMetricValue(key: HealthMetric, value: unknown): number | undefined {
  const { max } = HEALTH_METRICS[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max || key === "steps" && !Number.isInteger(value)) return;
  const rounded = Math.round(value * 100) / 100;
  if ((key === "weightKg" || key === "restingHeartRate") && rounded === 0) return;
  return rounded;
}

export function healthRating(value: number | undefined, label: "疲劳" | "精力"): number | undefined {
  if (value !== undefined && (!Number.isFinite(value) || value < 1 || value > 10)) throw Error(`${label}请填写 1 到 10。`);
  return value;
}

export function healthDay(date: string, values: Partial<Record<HealthMetric, unknown>>): HealthDay {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || normalizeJournalDate(date) !== date) throw Error("请选择有效的健康记录日期。");
  const entry: HealthDay = { date };
  for (const key of healthMetricKeys) {
    if (values[key] === undefined || values[key] === null) continue;
    const value = healthMetricValue(key, values[key]);
    if (value === undefined) throw Error(`${HEALTH_METRICS[key].label}的数字或单位需要核对。`);
    entry[key] = value;
  }
  return entry;
}

export function healthRows(content: string): HealthDay[] {
  if (content.length > 15_000) throw Error("识别内容太长，请分开上传。");
  let parsed: { rows?: unknown };
  const fenced = /^\s*```(?:json)?\s*([\s\S]+?)\s*```\s*$/iu.exec(content);
  try { parsed = JSON.parse(fenced?.[1] ?? content); }
  catch { throw Error("识别结果暂时无法解析，请选择更清晰的截图。"); }
  if (!Array.isArray(parsed?.rows) || parsed.rows.length > 20) throw Error("每张图最多导入 20 天，请分开上传。");
  return parsed.rows.flatMap(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const entries: Partial<Record<HealthMetric, number>> = {};
    for (const key of healthMetricKeys) {
      const raw = key === "sleepHours" && row.sleepHours === undefined && typeof row.sleepMinutes === "number"
        ? row.sleepMinutes / 60 : row[key];
      const value = healthMetricValue(key, raw);
      if (value !== undefined) entries[key] = value;
    }
    if (!Object.keys(entries).length) return [];
    // A missing screenshot date is filled by the user on the confirmation card.
    const date = typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(row.date) && normalizeJournalDate(row.date) === row.date ? row.date : "";
    return [{ date, ...entries }];
  });
}

export function combineHealthScreenshotDays(rows: readonly HealthDay[]): HealthDay[] {
  const byDate = new Map<string, HealthDay>();
  for (const row of rows) {
    const day = byDate.get(row.date) ?? { date: row.date };
    for (const key of healthMetricKeys) {
      const value = row[key];
      if (value === undefined) continue;
      if (day[key] !== undefined && day[key] !== value) {
        throw Error(`${row.date} 的${HEALTH_METRICS[key].label}有不同数值，请修改或取消勾选其中一条。`);
      }
      day[key] = value;
    }
    byDate.set(row.date, day);
  }
  return [...byDate.values()];
}

export function inspectHealthMarkdown(date: string, text: string): { day: HealthDay; canAppend: boolean } {
  const result: HealthDay = { date };
  const lines = text.replace(/^\uFEFF/u, "").split(/\r\n|\r|\n/u);
  const blocks = new MarkdownBlocks();
  let freeText = false;
  for (const [index, line] of lines.entries()) {
    // The note writer indents all continuations of these two free-text fields.
    if (freeText && line.startsWith("  ")) continue;
    freeText = false;
    if (blocks.skip(line, index === 0)) continue;
    freeText = line.startsWith("- 备注：") || line.startsWith("- 运动：");
    for (const key of healthMetricKeys) {
      const prefix = `- ${HEALTH_METRICS[key].label}：`;
      if (!line.startsWith(prefix)) continue;
      const valueText = line.slice(prefix.length).trim();
      const unit = " " + HEALTH_METRICS[key].unit;
      const number = valueText.endsWith(unit) ? valueText.slice(0, -unit.length) : valueText;
      const match = /^([0-9]+(?:\.[0-9]+)?)$/u.exec(number);
      const value = match ? healthMetricValue(key, Number(match[1])) : undefined;
      if (value !== undefined) result[key] = value;
    }
  }
  return { day: result, canAppend: blocks.canAppend };
}

export function healthStats(days: readonly HealthDay[]) {
  const summarize = (key: HealthMetric) => {
    const values = days.flatMap(day => day[key] === undefined ? [] : [day[key]]);
    const total = values.reduce((sum, value) => sum + value, 0);
    return { recordedDays: values.length, average: values.length ? Math.round(total / values.length * 100) / 100 : null,
      ...((key === "steps" || key === "runningKm") ? { total: values.length ? Math.round(total * 100) / 100 : null } : {}) };
  };
  return { recordedDays: days.length, sleepHours: summarize("sleepHours"), steps: summarize("steps"),
    runningKm: summarize("runningKm"), weightKg: summarize("weightKg"), restingHeartRate: summarize("restingHeartRate"),
    days: days.slice() };
}
