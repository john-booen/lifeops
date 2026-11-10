import { dashboardContextData } from "../contextData";
import { formatDate, normalizeJournalDate } from "../date";
import { newLocalOperationId } from "../operationIdentity";
import { assertProviderActive } from "../providerRun";
import type { StoreHost } from "../store/settingsSlice";
import { taskScheduleLabel } from "../taskSchedule";
import type { AgentResponse } from "../types";
import type { AgentRuntime } from "../agentRuntime";
import type { AgentTurnInput } from "./AgentLoop";

export async function offlineFallback(input: AgentTurnInput, store: StoreHost, runtime: AgentRuntime): Promise<AgentResponse | null> {
  const message = input.message.trim().replace(/[。！？?!]$/, "");
  if (!message || /[\r\n；;？?]/.test(message)) return null;
  const date = formatDate(input.now);
  if (/^(?:今天还有什么(?:任务|待办)?|今天还有哪些(?:任务|待办)|今日(?:任务|待办)|\/today)$/i.test(message)) {
    const dashboard = await store.getTaskDashboard(date, { forContext: true });
    assertProviderActive(input.signal);
    if (dashboardContextData(dashboard)?.tasks.available === false) return { reply: "今日任务暂时无法读取。", actions: [] };
    const tasks = dashboard.today.map(task => [task.title, taskScheduleLabel(task)].filter(Boolean).join(" "));
    return { reply: tasks.length ? `今天还有 ${tasks.length} 项待办。\n${tasks.map(task => "- " + task).join("\n")}` : "今天没有剩余待办。", actions: [] };
  }
  const command = /^\/(todo|done|checkin)\s+(.+)$/i.exec(message)
    ?? /^(?:帮我|请)?\s*(创建|新建|建|完成)(?:一[条个])?(?:任务|待办)[：:，,\s]*(.+)$/u.exec(message)
    ?? /^(?:帮我|请)?\s*(打卡)[：:，,\s]*(.+)$/u.exec(message);
  if (!command) return null;
  const [, verb, value] = command;
  const toolName = /^(?:done|完成)$/i.test(verb) ? "complete_task"
    : /^(?:checkin|打卡)$/i.test(verb) ? "complete_habit" : "create_task";
  const args = toolName === "complete_task" ? { taskIdOrTitle: value.trim() }
    : toolName === "complete_habit" ? { name: value.trim() }
      : offlineTask(value, date);
  if (!args) return { reply: "没识别出任务时间，请用明确的日期和时刻，例如「明天 10:00」。", actions: [] };
  const assertCurrent = () => assertProviderActive(input.signal);
  assertCurrent();
  const result = await runtime.executeToolCall({
    toolName, arguments: args, source: "system", callId: newLocalOperationId("offline"), confirmedByUser: true
  }, { assertCurrent });
  return { reply: result.output, actions: result.actions, receipts: result.receipt ? [result.receipt] : [] };
}

function offlineTask(value: string, today: string): Record<string, unknown> | null {
  const day = /(?:^|[，,\s])(今天|明天|后天|\d{4}-\d{2}-\d{2})(?=$|[，,\s零一二两三四五六七八九十半\d]|凌晨|早上|上午|中午|下午|傍晚|晚上)/u.exec(value);
  const date = day ? normalizeJournalDate(day[1], today) : today;
  if (!date) return null;
  const remaining = day ? value.slice(0, day.index) + " " + value.slice(day.index + day[0].length) : value;
  const clock = parseTaskClock(remaining);
  if (!clock) return null;
  const title = clock.titleText.replace(/^[，,\s]+|[，,\s]+$/g, "");
  if (!title || (day && !clock.time && remaining.includes(" ") && /[点时分]|半小/.test(remaining))) return null;
  return { title, date, time: clock.time };
}

function parseTaskClock(text: string): { time: string; titleText: string } | null {
  // Local fallback has only one absolute clock field. Keep unsupported relative,
  // approximate or range requests out of Runtime instead of saving a partial task.
  if (/(分钟|小时|刻钟)\s*(之?[前后]|以[前后])/.test(text)) return null;
  const matches = [...text.matchAll(/(?:(凌晨|早上|上午|中午|下午|傍晚|晚上|今晚)\s*)?([\d零〇一二两三四五六七八九十百]+)\s*(?:[:：]([\d零〇一二两三四五六七八九十百]+)|[点时]\s*(?:(半|一刻|三刻)|([\d零〇一二两三四五六七八九十百]+)\s*(分)?)?)(?:钟)?(?:整(?=$|[\s，,。；;]|开始))?/gu)];
  if (matches.length === 0) return { time: "", titleText: text };
  if (matches.length !== 1) return null;
  const match = matches[0], start = match.index!, end = start + match[0].length;
  const before = text.slice(0, start), after = text.slice(end);
  if (/(差[\d零〇一二两三四五六七八九十]+分?|过|约|大概|负|[.\d-])\s*$/.test(before)
    || /^(前|后|之前|之后|以前|以后|左右|多|到|至|内|刻|秒|[:：\d—~～-])/.test(after.trimStart())) return null;
  // A bare number followed by a noun may count people or items, not minutes.
  if (match[5] && !match[6] && !/^(?:$|[，,。；;]|开始)/.test(after.trimStart())) return null;
  // Without a day period, require a clock position instead of extracting e.g.
  // “三点” from the task title “整理三点建议”. Ambiguity stays with the model.
  if (!match[1] && !/(今天|明天|后天|任务|待办|提醒我|记一下|记下|安排|[，,。；;]|^\/todo)\s*$/.test(before)
    && !/^(?:$|开始)/.test(after.trimStart())) return null;
  let hour = clockNumber(match[2]);
  const minute = match[4] === "半" ? 30 : match[4] === "一刻" ? 15 : match[4] === "三刻" ? 45 : clockNumber(match[3] ?? match[5] ?? "0");
  if (hour === null || minute === null || hour > 23 || minute > 59) return null;
  const period = match[1];
  if (period === "上午" || period === "早上") {
    if (hour >= 12) return null;
  } else if (period === "凌晨") {
    if (hour === 12) hour = 0;
    if (hour > 6) return null;
  } else if (period === "中午") {
    if (hour === 1) hour = 13;
    if (hour < 11 || hour > 13) return null;
  } else if (period) {
    if (hour === 0) return null;
    // Night-time 1–5 or 12 can refer to the next calendar day. Do not turn
    // these into an afternoon clock or silently move midnight to this morning.
    if ((period === "晚上" || period === "今晚") && (hour < 6 || hour === 12)) return null;
    if (period === "傍晚" && !(hour >= 5 && hour <= 7 || hour >= 17 && hour <= 19)) return null;
    if (hour < 12) hour += 12;
  }
  return {
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    titleText: before + after.replace(/^\s*开始/u, "")
  };
}

function clockNumber(value: string): number | null {
  if (/^\d{1,2}$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value in digits) return digits[value];
  if (/^[零〇][一二三四五六七八九]$/.test(value)) return digits[value[1]];
  if (/^[二两三四五六七八九]?十[一二三四五六七八九]?$/.test(value)) {
    const [tens, units] = value.split("十");
    return (tens ? digits[tens] : 1) * 10 + (units ? digits[units] : 0);
  }
  return null;
}
