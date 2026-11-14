import type { HealthEntry } from "./types";
import { healthDay, healthMetricKeys, healthRating } from "./features/health/model";

const HEALTH_COLUMN_NAMES = {
  date: ["date", "日期", "day"],
  sleepHours: ["sleepHours", "睡眠小时", "sleep", "睡眠"],
  weightKg: ["weightKg", "体重", "weight"],
  steps: ["steps", "步数"],
  runningKm: ["runningKm", "跑步距离"],
  restingHeartRate: ["restingHeartRate", "静息心率"],
  exercise: ["exercise", "运动"],
  fatigue: ["fatigue", "疲劳"],
  energy: ["energy", "精力"],
  note: ["note", "备注"]
} as const;

export function parseCsv(text: string, strict = false): Record<string, string>[] {
  const rows = parseCsvGrid(text, strict);
  if (rows.length === 0) return [];
  const headers = rows[0].map((value) => value.trim());
  if (strict && (headers.some(header => !header) || new Set(headers).size !== headers.length)) {
    throw Error("健康 CSV 的表头有空白或重复列名，请核对。");
  }
  return rows.slice(1).map((values, index) => {
    if (strict && values.length > headers.length) {
      throw Error(`第 ${index + 1} 条健康记录的列数超过表头。含逗号的字段请用双引号括起来。`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""]));
  });
}

export function parseHealthCsv(text: string): HealthEntry[] {
  const rows = parseCsv(text, true);
  const headings = rows[0] ?? {};
  const columns = new Map<keyof typeof HEALTH_COLUMN_NAMES, string>();
  for (const [field, names] of Object.entries(HEALTH_COLUMN_NAMES)) {
    const provided = names.filter(name => Object.hasOwn(headings, name));
    if (provided.length > 1) throw Error(`表头中的「${provided.join("、")}」指向同一个字段，请保留一列。`);
    if (provided.length) columns.set(field as keyof typeof HEALTH_COLUMN_NAMES, provided[0]);
  }
  return rows.flatMap((row, index) => {
    if (Object.values(row).every(value => !value)) return [];
    try {
      const read = (field: keyof typeof HEALTH_COLUMN_NAMES): string | undefined => {
        const name = columns.get(field);
        return name ? row[name] : undefined;
      };
      const entry = healthDay(read("date") || "", {
        sleepHours: numberFrom(read("sleepHours"), "睡眠小时", /\s*(?:小时|hrs?|h)$/iu),
        weightKg: numberFrom(read("weightKg"), "体重", /\s*(?:公斤|千克|kg)$/iu),
        steps: numberFrom(read("steps"), "步数", /\s*(?:步|steps?)$/iu),
        runningKm: numberFrom(read("runningKm"), "跑步距离", /\s*(?:公里|千米|km)$/iu),
        restingHeartRate: numberFrom(read("restingHeartRate"), "静息心率", /\s*(?:次\/分|bpm)$/iu)
      });
      const record: HealthEntry = {
        ...entry,
        exercise: read("exercise") || "",
        fatigue: healthRating(numberFrom(read("fatigue"), "疲劳"), "疲劳"),
        energy: healthRating(numberFrom(read("energy"), "精力"), "精力"),
        note: read("note") || ""
      };
      if (!healthMetricKeys.some(key => record[key] !== undefined) && record.fatigue === undefined
        && record.energy === undefined && !record.exercise && !record.note) return [];
      return [record];
    } catch (error) {
      throw Error(`第 ${index + 1} 条健康记录：${error instanceof Error ? error.message : "无法读取。"}`);
    }
  });
}

export function parseCsvGrid(text: string, strict = false): string[][] {
  const normalized = text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  if (strict) return parseStrictCsvGrid(normalized);
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
  rows.push(normalized.slice(start));
  return (quoted ? normalized.split("\n") : rows).filter(row => row.length > 0).map(splitCsvLine);
}

function parseStrictCsvGrid(text: string): string[][] {
  const rows: string[][] = [];
  let fields: string[] = [], field = "";
  let state: "plain" | "quoted" | "closed" = "plain";
  const endField = () => {
    fields.push(field);
    field = "";
    state = "plain";
  };
  let rowStart = 0;
  for (let index = 0; index <= text.length; index++) {
    const char = text[index];
    if (state === "quoted") {
      if (char === undefined) throw Error("CSV 有未闭合的引号，请核对文件格式。");
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') state = "closed";
      else field += char;
    } else if (char === "," || char === "\n" || char === undefined) {
      endField();
      if (char !== ",") {
        if (index > rowStart) rows.push(fields);
        fields = [];
        rowStart = index + 1;
      }
    } else if (char === '"' && state === "plain" && !field.trim()) {
      state = "quoted";
    } else if (char === '"' || state === "closed" && !/[ \t]/u.test(char)) {
      throw Error(`CSV 第 ${rows.length + 1} 行的引号位置无效，请核对字段。`);
    } else field += char;
  }
  return rows;
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
