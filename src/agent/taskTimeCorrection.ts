import { clockFromMatch, clockMatches } from "../clockText";
import { journalDateToken, normalizeJournalDate } from "../date";
import type { AiToolCall } from "../ai";
import { readContextTasks } from "../contextData";
import { OperationLedger } from "../dataFoundation/operationLedger";
import { taskSavedByReceipt } from "../dataFoundation/taskRecordUndo";
import { isVaultPathExcluded } from "../privacy";
import type { StoreHost } from "../store/settingsSlice";
import { taskNamedInRequest } from "../taskReference";
import type { AgentConversationMessage, LifeOpsTask } from "../types";

export type SavedTaskReference = Pick<LifeOpsTask, "id" | "title">;

export async function previousSavedTask(store: StoreHost, history: readonly AgentConversationMessage[]): Promise<SavedTaskReference | undefined> {
  const last = history.at(-1);
  if (last?.role !== "assistant" || last.receipts?.length !== 1) return;
  try {
    const excluded = store.settings.privacy?.excludedVaultPrefixes;
    const ledger = new OperationLedger(store);
    if (isVaultPathExcluded(ledger.filePath, excluded) || isVaultPathExcluded(store.taskDbPath(), excluded)) return;
    const record = await ledger.verifiedOperationForReceipt(last.receipts[0].operationId);
    const saved = record && taskSavedByReceipt(record, store.taskDbPath());
    if (!saved) return;
    const { tasks } = await readContextTasks(store);
    const current = tasks.find(task => task.id === saved.id && task.status === "active");
    if (current?.title === saved.title) return { id: saved.id, title: saved.title };
  } catch { /* Without readable evidence, the user needs to name the task. */ }
}

export async function unverifiedTaskTimeChanges(store: StoreHost, calls: readonly AiToolCall[], message: string,
  previous?: SavedTaskReference): Promise<AiToolCall[]> {
  const proposals = calls.filter(call => call.name === "reschedule_task" && call.arguments.time !== undefined);
  if (!proposals.length) return [];
  const data = await readContextTasks(store).catch(() => undefined);
  const namedIds = new Set(data?.tasks.filter(task => taskNamedInRequest(task, message)).map(task => task.id));
  return proposals.filter(call => {
    const value = call.arguments.taskIdOrTitle;
    const ref = typeof value === "string" ? value.trim() : "";
    const task = data?.tasks.find(row => row.id === ref) ?? data?.tasks.find(row => row.title === ref);
    if (task?.status !== "active") return true;
    if (namedIds.size) return !namedIds.has(task.id);
    return task.id !== ref || previous?.id !== ref || previous.title !== task.title;
  });
}

/** Only a complete, explicit clock applied to the immediately attested task. */
export function explicitRecentTaskTimeChange(message: string, today: string, previous?: SavedTaskReference): Record<string, unknown> | undefined {
  if (!previous) return;
  const text = message.trim().normalize("NFKC").replace(/[。！!]$/u, "");
  const match = /^(?:不对[,，]\s*)?(?:刚才|刚刚)的?(?:这|那)一?(?:条|项)(?:任务|待办)?\s*再?改(?:成|到|为)\s*(.+)$/u.exec(text);
  if (!match) return;
  const value = match[1], clocks = clockMatches(value);
  if (clocks.length !== 1) return;
  const clock = clocks[0];
  if (clock.index! + clock[0].length !== value.length || !clock[1] && !/^\d{1,2}[:：]\d{2}$/u.test(clock[0])) return;
  const prefix = value.slice(0, clock.index).trim(), time = clockFromMatch(clock);
  if (!time || prefix && !new RegExp("^(?:" + journalDateToken + ")$", "u").test(prefix)) return;
  const date = prefix ? normalizeJournalDate(prefix, today) : undefined;
  if (prefix && !date) return;
  return { taskIdOrTitle: previous.id, time, ...(date ? { date } : {}) };
}
