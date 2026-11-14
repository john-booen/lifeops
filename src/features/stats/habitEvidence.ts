import { addDays } from "../../date";
import type { StatsRange } from "./stats";

type Evidence = {
  domain?: string;
  range?: { from?: string; to?: string };
  habits?: { name?: string; doneCount?: number; completionPercent?: number | null;
    goals?: { period?: string; missedDates?: string[] }[] }[];
  scope?: string;
  tradeGoals?: string;
};
const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

export function weeklyHabitQuestion(message: string): StatsRange | undefined {
  let text = message.trim();
  while (text && "。？！?!".includes(text.at(-1)!)) text = text.slice(0, -1);
  const periods = [["这周", "this_week"], ["本周", "this_week"], ["上周", "last_week"]] as const;
  for (const [label, range] of periods) {
    if (["习惯完成得怎么样", "习惯完成得怎样", "习惯完成情况如何", "习惯完成情况"]
      .some(question => text === label + question || text === label + "的" + question)) return range;
  }
}

export function formatWeeklyHabits(output: string): string | undefined {
  let evidence: Evidence;
  try { evidence = JSON.parse(output); } catch { return; }
  const { from, to } = evidence?.range ?? {};
  if (evidence?.domain !== "habits" || !day(from) || !day(to) || !Array.isArray(evidence.habits)) return;
  const rows = evidence.habits.flatMap(habit => {
    const name = typeof habit?.name === "string" ? habit.name.replace(/\s+/gu, " ").trim() : "";
    const count = habit?.doneCount;
    if (!name || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return [];
    const rate = typeof habit.completionPercent === "number" && Number.isFinite(habit.completionPercent)
      ? `完成率 ${habit.completionPercent}%` : "暂无可算的完成率";
    return [`- ${name}有 ${count} 次完成记录，${rate}。`];
  });
  const text = [
    `${from} 至 ${to}`,
    ...(rows.length ? rows : ["这段时间没有可核对的习惯统计。"]),
    ...(evidence.tradeGoals ? ["交易目标进度暂不可用。"] : []),
    ...(evidence.scope ? ["只统计允许读取的记录。"] : [])
  ].join("\n");
  const missed = habitDateEvidence(output, text);
  return missed ? text + "\n\n" + missed : text;
}

/** Attach only dates the read tool already verified for habits named in the answer. */
export function habitDateEvidence(output: string, answer: string): string | undefined {
  let evidence: Evidence;
  try { evidence = JSON.parse(output); } catch { return; }
  const { from, to } = evidence?.range ?? {};
  if (evidence?.domain !== "habits" || !day(from) || !day(to) || from >= to
    || to > addDays(from, 6) || evidence.tradeGoals || !Array.isArray(evidence.habits)) return;
  const rows = evidence.habits.flatMap(habit => {
    const name = typeof habit?.name === "string" ? habit.name.trim() : "";
    if (!name || name.length > 40 || !answer.includes(name) || !Array.isArray(habit.goals)) return [];
    const dates = [...new Set(habit.goals.flatMap(goal => goal?.period === "day" && Array.isArray(goal.missedDates)
      ? goal.missedDates.filter(date => day(date) && date >= from && date <= to) : []))].sort();
    if (!dates.length || dates.every(date => answer.includes(date.slice(5))
      || answer.includes(Number(date.slice(5, 7)) + "月" + Number(date.slice(8)) + "日"))) return [];
    return ["「" + name + "」" + dates.map(date => date.slice(5)).join("、")];
  }).slice(0, 3);
  if (rows.length) return "核对到的未达标日期：" + rows.join("；") + (evidence.scope ? "（仅含可读记录）" : "") + "。";
}
