import { hasGroundedSpeechNumbers } from "./summaryNumbers";

interface TaskSpeechBrief {
  facts: string;
  recommendation: string;
  cue: "overdue" | "unfinished" | "review" | "plan" | "coverage";
}

export const TASK_REPORT_SPOKEN_INSTRUCTIONS = "把这条建议改成一句自然、简短的中文口语。保持原意，不增加数字、日期、结论或表格。只返回建议这一句。";

function cells(line: string): string[] {
  const row = line.trim();
  return row.startsWith("|") && row.endsWith("|")
    ? row.slice(1, -1).split("|").map(cell => cell.replace(/\*\*|\x60/gu, "").trim()) : [];
}

function count(value: string | undefined): number | undefined {
  if (!value || !/^(?:\d+|\d{1,3}(?:,\d{3})+)$/u.test(value)) return;
  const number = Number(value.replaceAll(",", ""));
  return Number.isSafeInteger(number) ? number : undefined;
}

function rate(value: string | undefined): number | undefined {
  if (!value || !/^\d+(?:\.\d+)?\s*[%％]$/u.test(value)) return;
  const number = Number(value.slice(0, -1));
  return number <= 100 ? number : undefined;
}

const PERIOD_HEADINGS = ["周起始日", "周开始日", "周期", "日期"];
const TOTAL_PERIOD = /^(?:(?:全|整|本|上)?(?:月|周|期))?(?:合计|总计|汇总)(?:\s*[（(](有数据范围(?:\s+[^()（）]+)?)[）)])?$/u;
const PLAN_HEADINGS = ["计划数", "计划任务数", "计划"];
const DONE_HEADINGS = ["完成数", "完成任务数", "已完成"];
const RATE_HEADINGS = ["完成率", "计划完成率"];
const OVERDUE_HEADINGS = ["逾期数", "逾期待办", "逾期"];
const indexOf = (row: string[], names: string[]) => row.findIndex(cell => names.includes(cell));
const shortPercentage = (value: number) => Number.isInteger(value) ? `是百分之 ${value}` : `大约是百分之 ${Math.round(value)}`;

/** Extract the total and trend, keeping every number tied to its table column. */
export function taskReportBrief(detail: string): TaskSpeechBrief | undefined {
  const lines = detail.split("\n");
  for (const [index, line] of lines.entries()) {
    const header = cells(line).map(cell => cell.replace(/^周起始日\s*[（(]周一[）)]$/u, "周起始日"));
    const period = indexOf(header, PERIOD_HEADINGS), planned = indexOf(header, PLAN_HEADINGS);
    const completed = indexOf(header, DONE_HEADINGS), completion = indexOf(header, RATE_HEADINGS);
    if (Math.min(period, planned, completed, completion) < 0) continue;
    if (!header.includes("计划任务数") && !header.includes("完成任务数")
      && header[period] !== "周起始日" && !lines.slice(0, index).some(line => /^\s*#{1,6}\s+[^\n]*(?:任务|待办)/u.test(line))) continue;
    const divider = cells(lines[index + 1] ?? "");
    if (divider.length !== header.length || !divider.every(cell => /^:?-{2,}:?$/u.test(cell))) continue;
    const rows: string[][] = [];
    for (const row of lines.slice(index + 2)) {
      const fields = cells(row);
      if (fields.length !== header.length) break;
      rows.push(fields);
    }
    const totals = rows.filter(row => TOTAL_PERIOD.test(row[period]));
    if (totals.length !== 1) continue;
    const total = totals[0], plan = count(total[planned]), done = count(total[completed]), percent = rate(total[completion]);
    if (plan === undefined || done === undefined || plan > 0 && percent === undefined
      || percent !== undefined && percent > 0 && (!plan || !done)) continue;

    const scoped = Boolean(TOTAL_PERIOD.exec(total[period])?.[1]);
    const lead = plan === 0
      ? done === 0 ? "这段时间没有计划，也没有已完成的任务。" : `这段时间完成了 ${done} 项任务，没有预先排计划。`
      : `这段时间完成了 ${done} 项任务，计划完成率${shortPercentage(percent!)}。`;
    const scopedLead = scoped ? lead.replace("这段时间", "按已有记录，") : lead;
    const tableOverdue = count(total[indexOf(header, OVERDUE_HEADINGS)]);
    const textOverdue = [...detail.matchAll(/(?:全月|整月|全周|整周|这段时间)(?:另有|还有|有)\s*(?:\*\*)?(\d+)\s*[项条个](?:任务)?逾期/gu)]
      .map(match => count(match[1])).filter((value): value is number => value !== undefined);
    const uniqueOverdue = [...new Set([tableOverdue, ...(scoped ? [] : textOverdue)].filter((value): value is number => value !== undefined))];
    const overdue = uniqueOverdue.length === 1 ? uniqueOverdue[0] : undefined;
    const periods = rows.filter(row => /^\d{4}-\d{2}-\d{2}$/u.test(row[period]))
      .sort((left, right) => left[period].localeCompare(right[period]));
    const first = rate(periods[0]?.[completion]), last = rate(periods.at(-1)?.[completion]);
    const trend = periods.length < 2 || first === undefined || last === undefined || first === last ? ""
      : last > first ? "后段的完成比例有所提高" : "后段的完成比例有所下降";
    const followup = overdue ? `还有 ${overdue} 项任务逾期` : "";
    const facts = scopedLead + ([trend, followup].filter(Boolean).length ? [trend, followup].filter(Boolean).join("，") + "。" : "");
    if (scoped) return { facts, cue: "coverage", recommendation: "接下来先核对这份报告没有覆盖到的记录。" };
    if (overdue) return { facts, cue: "overdue", recommendation: "接下来可以先把逾期的事拆成小步来做。" };
    if (percent !== undefined && percent < 100) return { facts, cue: "unfinished", recommendation: "接下来先看看没做完的事，再调整安排。" };
    if (!plan && !done) return { facts, cue: "plan", recommendation: "如果手上还有事，可以先把它们排进计划。" };
    return { facts, cue: "review", recommendation: "接下来可以沿用这个节奏，再看看哪些做法最管用。" };
  }
}

/** The model may rephrase the next step, but it cannot change the facts or add a number. */
export function speakTaskReport(brief: TaskSpeechBrief, suggested?: string): string {
  const candidate = suggested?.trim().replace(/[。！？!?]+$/u, "");
  const cue = {
    overdue: /逾期|过期|拖欠/u, unfinished: /没做完|未完成|还没做|剩下/u,
    plan: /计划|排进|安排/u, review: /节奏|做法|复盘|继续/u, coverage: /记录|范围|覆盖/u
  }[brief.cue];
  const accepted = candidate && candidate.length <= 65 && !/[\r\n|#*\x60。！？!?]/u.test(candidate)
    && !/面板|原文|详见|删除|放弃|取消|体罚|https?:/u.test(candidate)
    && cue.test(candidate) && hasGroundedSpeechNumbers("", candidate);
  return brief.facts + (accepted ? candidate + "。" : brief.recommendation);
}
