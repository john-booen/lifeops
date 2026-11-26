import type { AiToolCall } from "../ai";
import { formatDate, journalDateToken, normalizeJournalDate } from "../date";
import { readContextTasks } from "../contextData";
import type { StoreHost } from "../store/settingsSlice";
import { outsideQuotedTaskText } from "../features/tasks/creationPolicy";

/** Argument grounding after the model chose a move tool, never intent routing.
 * A single literal destination fixes the already selected shared plan date.
 * Separate destinations/end dates remain the model's explicit responsibility. */
export async function bindTaskMoveDate(store: StoreHost, calls: AiToolCall[], message: string, now: Date): Promise<AiToolCall[]> {
  if (!calls.some(call => call.name === "update_tasks" || call.name === "reschedule_task")) return calls;
  const text = message.normalize("NFKC"), base = formatDate(now);
  const outside = outsideQuotedTaskText(text).replace(/`[^`\r\n]*`/gu, "");
  const moveWords = ["改到", "挪到", "移到", "移动到", "调整到", "推迟到", "延后到", "安排到"];
  const dates = [...text.matchAll(new RegExp(`(?:${journalDateToken})`, "gu"))]
    .filter(match => !match[0].includes("周末") && moveWords.some(word => {
      const prefix = text.slice(0, match.index).trimEnd();
      return prefix.endsWith(word) && outside.includes(word + text.slice(prefix.length, match.index) + match[0]);
    }))
    .map(match => normalizeJournalDate(match[0], base));
  if (dates.length !== 1 || !dates[0]) return calls;
  const destination = dates[0];
  const data = await readContextTasks(store);
  if (!data.available) return calls;
  const identity = (value: string) => value.normalize("NFKC").trim();
  return calls.map(call => {
    if (call.name !== "update_tasks" && call.name !== "reschedule_task") return call;
    const rows = call.name === "update_tasks" ? call.arguments.updates : [call.arguments];
    if (!Array.isArray(rows) || !rows.length || rows.some(row => !row || typeof row !== "object" || Array.isArray(row)
      || typeof row.date !== "string" || !normalizeJournalDate(row.date, base)
      || row.endDate !== undefined && row.endDate !== "")) return call;
    const selected = new Set(rows.map(row => normalizeJournalDate(row.date, base)));
    if (selected.size !== 1 || rows.every(row => row.date === destination)) return call;
    // An echoed unchanged date on a time/title-only edit is not a move. Only
    // ground a batch whose uniquely resolved members all change plan date.
    for (const row of rows) {
      if (typeof row.taskIdOrTitle !== "string" || !row.taskIdOrTitle.trim()) return call;
      const exact = data.tasks.filter(task => task.id === row.taskIdOrTitle);
      const matches = exact.length ? exact : data.tasks.filter(task => identity(task.title) === identity(row.taskIdOrTitle));
      if (matches.length !== 1 || matches[0].date === normalizeJournalDate(row.date, base)) return call;
    }
    const grounded = rows.map(row => ({ ...row, date: destination }));
    return { ...call, arguments: call.name === "update_tasks" ? { ...call.arguments, updates: grounded } : grounded[0] };
  });
}
