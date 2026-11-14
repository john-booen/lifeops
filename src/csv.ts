import type { HealthEntry } from "./types";

export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvGrid(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map((value) => value.trim());
  return rows.slice(1).map((values) => {
    return headers.reduce<Record<string, string>>((record, header, index) => {
      record[header] = values[index]?.trim() ?? "";
      return record;
    }, {});
  });
}

export function parseHealthCsv(text: string): HealthEntry[] {
  return parseCsv(text)
    .map((row) => ({
      date: row.date || row["日期"] || row.day || "",
      sleepHours: numberFrom(row.sleepHours || row["睡眠小时"] || row.sleep || row["睡眠"]),
      weightKg: numberFrom(row.weightKg || row["体重"] || row.weight),
      steps: numberFrom(row.steps || row["步数"]),
      runningKm: numberFrom(row.runningKm || row["跑步距离"]),
      restingHeartRate: numberFrom(row.restingHeartRate || row["静息心率"]),
      exercise: row.exercise || row["运动"] || "",
      fatigue: numberFrom(row.fatigue || row["疲劳"]),
      energy: numberFrom(row.energy || row["精力"]),
      note: row.note || row["备注"] || ""
    }))
    .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.date));
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

function numberFrom(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const number = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : undefined;
}
