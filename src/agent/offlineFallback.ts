import { dashboardContextData } from "../contextData";
import { clockFromMatch, clockMatches } from "../clockText";
import { formatDate, normalizeJournalDate } from "../date";
import { newLocalOperationId } from "../operationIdentity";
import { assertProviderActive } from "../providerRun";
import type { StoreHost } from "../store/settingsSlice";
import { taskScheduleLabel } from "../taskSchedule";
import type { AgentResponse } from "../types";
import type { AgentRuntime } from "../agentRuntime";
import type { AgentTurnInput } from "./AgentLoop";

export function explicitSingleTimedTask(message: string, today: string): Record<string, unknown> | null {
  const text = message.trim().replace(/[。！!]$/u, "");
  if (/[。；;？！!?\r\n]|(?:如果|要是|的话|然后|同时|另外|或者|再帮我|先查|每周|每天|重复)/u.test(text)) return null;
  const separated = /^(?:请(?:帮我)?|帮我)?\s*(?:创建|新建|添加|建)(?:一[个条项])?(?:任务|待办)(?:[：:]\s*|[ \t]+)([^，,]+)[，,]\s*(?:安排在|定在|时间是)(今天|明天|后天|\d{4}-\d{2}-\d{2})\s*([^，,]+)$/u.exec(text);
  if (separated) {
    const [, rawTitle, day, clockText] = separated;
    const title = rawTitle.trim();
    const date = normalizeJournalDate(day, today);
    const clock = parseTaskClock(clockText);
    if (/^(?:标题|任务名|[「『“"'‘]|这个|那个|刚才|前面|之前|把)/u.test(title)) return null;
    if (title && date && clock?.time && !clock.titleText.trim()) return { title, date, time: clock.time };
    return null;
  }
  if (/[，,]/u.test(text)) return null;
  const reminder = /^(?:请(?:帮我)?|帮我)?\s*(今天|今日|明天|后天|大后天|(?:这|本|下)周[一二三四五六日天1-7]|\d{4}-\d{2}-\d{2})\s*([^，,]+?)提醒(?:我)?(.+)$/u.exec(text);
  if (reminder) {
    const [, day, clockText, rawTitle] = reminder;
    const date = normalizeJournalDate(day, today);
    const clock = parseTaskClock(clockText);
    const title = rawTitle.trim();
    if (title && date && clock?.time && !clock.titleText.trim() && clockMatches(title).length === 0) {
      return { title, date, time: clock.time };
    }
    return null;
  }
  const command = /^(?:请(?:帮我)?|帮我)?\s*(?:创建|新建|加|建)(?:一[条项个])?\s*(.+?)的(?:任务|待办)$/u.exec(text);
  if (!command || !/^(?:今天|明天|后天|\d{4}-\d{2}-\d{2})(?:\s*\d|\s*(?:凌晨|早上|上午|中午|下午|傍晚|晚上))/u.test(command[1])) return null;
  const task = offlineTask(command[1], today);
  return task?.time ? task : null;
}

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
  const matches = clockMatches(text);
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
  const time = clockFromMatch(match);
  return time === null ? null : { time, titleText: before + after.replace(/^\s*开始/u, "") };
}
