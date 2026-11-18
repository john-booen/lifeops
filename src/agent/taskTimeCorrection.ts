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
