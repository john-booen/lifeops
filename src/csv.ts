import type { HealthEntry } from "./types";
import { healthDay } from "./features/health/model";

export function parseCsv(text: string, strict = false): Record<string, string>[] {
  const rows = parseCsvGrid(text, strict);
  if (rows.length === 0) return [];
  const headers = rows[0].map((value) => value.trim());
  return rows.slice(1).map((values, index) => {
    if (strict && values.length > headers.length) {
      throw Error(`第 ${index + 1} 条健康记录的列数超过表头。含逗号的字段请用双引号括起来。`);
    }
    return headers.reduce<Record<string, string>>((record, header, index) => {
      record[header] = values[index]?.trim() ?? "";
      return record;
    }, {});
  });
}

export function parseHealthCsv(text: string): HealthEntry[] {
  const rows = parseCsv(text, true);
  return rows.flatMap((row, index) => {
    if (Object.values(row).every(value => !value)) return [];
    try {
      const entry = healthDay(row.date || row["日期"] || row.day || "", {
        sleepHours: numberFrom(row.sleepHours || row["睡眠小时"] || row.sleep || row["睡眠"], "睡眠小时", /\s*(?:小时|hrs?|h)$/iu),
        weightKg: numberFrom(row.weightKg || row["体重"] || row.weight, "体重", /\s*(?:公斤|千克|kg)$/iu),
        steps: numberFrom(row.steps || row["步数"], "步数", /\s*(?:步|steps?)$/iu),
        runningKm: numberFrom(row.runningKm || row["跑步距离"], "跑步距离", /\s*(?:公里|千米|km)$/iu),
        restingHeartRate: numberFrom(row.restingHeartRate || row["静息心率"], "静息心率", /\s*(?:次\/分|bpm)$/iu)
      });
      return [{
        ...entry,
        exercise: row.exercise || row["运动"] || "",
        fatigue: numberFrom(row.fatigue || row["疲劳"], "疲劳"),
        energy: numberFrom(row.energy || row["精力"], "精力"),
        note: row.note || row["备注"] || ""
      }];
    } catch (error) {
      throw Error(`第 ${index + 1} 条健康记录：${error instanceof Error ? error.message : "无法读取。"}`);
    }
  });
}

export function parseCsvGrid(text: string, strict = false): string[][] {
  const normalized = text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  const rows: string[] = [];
  let quoted = false, start = 0;
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === '"' && quoted && normalized[index + 1] === '"') index++;
    else if (char === '"') quoted = !quoted;
    else if (char === "\n" && !quoted) {
      rows.push(normalized.slice(start, index));
      start = index + 1;
    }
  }
  if (strict && quoted) throw new Error("CSV 有未闭合的引号，请核对文件格式。");
  rows.push(normalized.slice(start));
  return (quoted ? normalized.split("\n") : rows).filter(row => row.length > 0).map(splitCsvLine);
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function numberFrom(value: string | undefined, field: string, unit?: RegExp): number | undefined {
  if (!value || /^(?:--?|—|n\/?a)$/iu.test(value)) return undefined;
  const digits = unit ? value.replace(unit, "") : value;
  if (!/^[+-]?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?|\.\d+)$/u.test(digits)) {
    throw Error(`${field}的数字或单位需要核对。`);
  }
  const number = Number(digits.replaceAll(",", ""));
  if (!Number.isFinite(number)) throw Error(`${field}的数字或单位需要核对。`);
  return number;
}
