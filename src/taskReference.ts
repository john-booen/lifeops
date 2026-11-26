import { clockFromMatch, clockMatches } from "./clockText";
import { journalDateToken, normalizeJournalDate } from "./date";

const reminderBody = /^提醒\S/u;

export function taskNamedInRequest(task: { id: string; title: string }, request: string): boolean {
  const words = request.normalize("NFKC");
  return words.includes(task.id) || words.includes(task.title.normalize("NFKC"));
}

/** Generated task IDs and UUIDs are identities, never title fragments. */
export function isTaskIdentifierReference(reference: string): boolean {
  // Classify distorted identifiers without using this copy to bind a record.
  const shape = reference.replace(/\s+/g, "");
  return /^task[-_:：]/i.test(shape)
    || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(shape);
}

/** Preserve the user's literal title when an explicit create command puts
 * the schedule in its own clause and the proposed title is a suffix of it. */
export function explicitScheduledTaskTitle(title: string, userMessage = ""): string {
  const match = /^(?:请(?:帮我)?|帮我)?\s*(?:创建|新建|添加|建)(?:一[个条项])?(?:任务|待办)[：:\s]*([^，,。；;！？!?\r\n]+)[，,]\s*(?:安排在|定在|时间是)[^，,。；;！？!?\r\n]+[。！!]*$/u.exec(userMessage.trim());
  const original = match?.[1].trim();
  if (original) {
    if (/^(?:标题|任务名|[「『“"'‘])/u.test(original)) return title;
    return original.replace(/\s+/gu, "").endsWith(title.replace(/\s+/gu, "")) ? original : title;
  }
  // Content preservation after the model has already chosen create_task.
  // Use the existing date/clock parsers; this does not route or authorize a write.
  const message = userMessage.trim().replace(/[。！!]$/u, ""), prefix = new RegExp("^(?:" + journalDateToken + ")\\s*", "u").exec(message)?.[0];
  if (!prefix || !normalizeJournalDate(prefix.trim())) return title;
  const timed = message.slice(prefix.length), clocks = clockMatches(timed);
  if (clocks.length !== 1 || clocks[0].index !== 0 || !clockFromMatch(clocks[0])) return title;
  const tail = timed.slice(clocks[0][0].length);
  if (!tail.startsWith("前")) return title;
  const body = tail.slice(1).trim();
  // Keep the existing reminder-title contract: request words are not missing
  // action content. This check never selects a tool or authorizes a write.
  if (reminderBody.test(body)) return title;
  return body.length <= 1000 && !/[，,。；;！？!?\r\n]/u.test(body) && title.trim()
    && body.replace(/\s+/gu, "").endsWith(title.replace(/\s+/gu, "")) ? body : title;
}

/** A reminder at one named time can correct an identical model-proposed
 * end time. Explicit starts, deadlines, ranges and other requests stay intact. */
export function explicitReminderClock(userMessage = ""): string | undefined {
  const message = userMessage.trim().replace(/[。！!]$/u, "");
  if (/[，,。；;！？!?\r\n]/u.test(message)) return;
  const clocks = clockMatches(message);
  if (clocks.length !== 1) return;
  const [clock] = clocks;
  const before = message.slice(0, clock.index).trim();
  const after = message.slice(clock.index! + clock[0].length).trim();
  if (!/^(?:请(?:帮我)?|帮我)?\s*(?:今天|今日|明天|后天|大后天|(?:这|本|下)周[一二三四五六日天1-7]|\d{4}-\d{2}-\d{2})\s*$/u.test(before)
    || !reminderBody.test(after)) return;
  return clockFromMatch(clock) ?? undefined;
}

/** Refuse a copied, explicitly assigned reference instead of inventing its value.
 * This is a conservative guard for reference-only titles, not a language resolver.
 * Actual resolution stays with the model and the current, authorized context.
 */
export function isCopiedTaskTitleReference(title: string, userMessage = ""): boolean {
  const assignment = [...userMessage.matchAll(/(?:标题|任务名)(原样|按字面)?(?:写成|写为|设成|设为|是|为|用|叫)\s*[：:]?\s*([^，,。！？!?\r\n]+)/gu)].at(-1);
  if (!assignment || assignment[1]) return false;
  const described = assignment[2].trim();
  // A quote elsewhere in the request cannot turn this assignment into a literal.
  for (const [left, right] of [["“", "”"], ["「", "」"], ["『", "』"], ['"', '"'], ["‘", "’"], ["'", "'"]]) {
    if (described === left + title + right) return false;
  }
  if (described !== title) return false;
  return /^(?:刚才|之前|前面|上面|前文|上文|上一句|上句话|那个|这个|其中|那里|这里)[^，,。！？!?]{0,60}(?:数字|编号|号码|名称|名字|标题|内容|步骤)$/u.test(title)
    // Full noun phrases only: an activity such as "标注照片里的数字" must pass.
    || /^(?:(?:这|那)(?:个|句|段|条|份|张)?|(?:刚才|之前|上述|前述)(?:提到|说过|提供)?的?|(?:纯)?虚构|测试)?(?:口令|暗号|句子|语句|设定|对话|消息|文本|原文|笔记|便签|备注|表格|报表|照片)(?:里|中|内)(?:面)?的?(?:数字|编号|号码|名称|名字)$/u.test(title);
}

export function isRecentModificationUndo(message: string): boolean {
  return /^撤销(?:刚才|刚刚)的修改[。！!]?$/u.test(message.trim());
}
