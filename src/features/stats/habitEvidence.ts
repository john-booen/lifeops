import { addDays } from "../../date";

type Evidence = {
  domain?: string;
  range?: { from?: string; to?: string };
  habits?: { name?: string; goals?: { period?: string; missedDates?: string[] }[] }[];
  scope?: string;
  tradeGoals?: string;
};
const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

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
