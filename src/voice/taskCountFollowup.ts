import type { AgentConversationMessage } from "../types";
import type { StatsRange } from "../features/stats/stats";

const periods = {
  今天: "today", 今日: "today", 本周: "this_week", 这周: "this_week", 上周: "last_week",
  本月: "this_month", 这个月: "this_month", 上个月: "last_month", 上月: "last_month"
} as const satisfies Record<string, StatsRange>;
const period = `(${Object.keys(periods).join("|")})`;
const count = "(?:(?:一共|实际|总共)?(?:完成了|已完成|完成)(?:多少|几)(?:个|项|条)?(?:任务|待办)|(?:任务|待办)(?:实际)?(?:完成了|完成)(?:多少|几)(?:个|项|条)?)";
const originalQuestion = new RegExp(`^(?:请)?(?:帮我|给我|我想知道)?(?:查一下|说说|看看|统计一下)?(?:我)?${period}(?:的)?${count}(?:呢|呀)?$`, "u");
const clarification = new RegExp(`^(?:你)?(?:问的是|是说|是想|是要|指的是|想查)(?:查|问|看)?${period}(?:到今天)?(?:的)?(?:${count}|(?:实际)?(?:任务|待办)(?:的)?(?:实际)?完成数|(?:实际)?完成数)(?:吗)?$`, "u");
const newPeriod = new RegExp(`^(?:不对(?:不对)?|不是)?(?:我(?:刚才)?(?:问|说)的是|是|那)?${period}(?:的)?(?:呢|呀)?$`, "u");
const completionCorrection = new RegExp(`^(?:不对(?:不对)?|不是)(?:我(?:刚才)?问的是|是)${period}(?:的)?(?:任务|待办)(?:的)?完成情况$`, "u");
const previousCompletionRequest = /^(?:请)?(?:帮我)?(?:总结|回顾|说说|看看)(?:一下)?(?:我)?(?:最近|近期|本周|这周|今天|今日|本月|这个月|上周|上月|上个月)(?:的)?(?:任务|待办)(?:的)?完成情况$/u;
const replacedPeriod = new RegExp(`^不是${period}(?:是|我(?:刚才)?问的是)${period}(?:的)?$`, "u");
const tidy = (value: string) => value.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "");
type PeriodName = keyof typeof periods;
type CountRange = typeof periods[PeriodName];

export function explicitTaskCount(message: string): CountRange | undefined {
  const name = originalQuestion.exec(message.trim().replace(/^请问[，, ]*/u, "").replace(/[。！？!?]+$/u, ""))?.[1] as PeriodName | undefined;
  return name && periods[name];
}

/** Only resolve a read-only count with an immediate, already permission-checked history pair. */
export function voiceTaskCountFollowup(message: string, history: readonly AgentConversationMessage[]): CountRange | undefined {
  const user = history.at(-2), assistant = history.at(-1);
  if (user?.role !== "user" || assistant?.role !== "assistant") return;
  const previous = tidy(user.content);
  const value = tidy(message);
  const original = originalQuestion.exec(previous)?.[1] as PeriodName | undefined;
  const explicitCorrection = completionCorrection.exec(value)?.[1] as PeriodName | undefined;
  if (explicitCorrection && (original || previousCompletionRequest.test(previous))) return periods[explicitCorrection];
  if (!original) return;
  const confirmed = newPeriod.exec(value)?.[1] as PeriodName | undefined;
  if (confirmed) return periods[confirmed];
  const replacement = replacedPeriod.exec(value);
  if (replacement && periods[replacement[1] as PeriodName] === periods[original]) return periods[replacement[2] as PeriodName];
  const clarified = clarification.exec(tidy(assistant.content))?.[1] as PeriodName | undefined;
  if (/^(?:对+|是的|是|没错)$/u.test(value) && clarified) return periods[clarified];
  if (/^(?:不对(?:不对)?|不是不是)$/u.test(value) && clarified && periods[clarified] !== periods[original]) return periods[original];
}
