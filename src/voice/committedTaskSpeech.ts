import { getCommittedTaskEvidence, type ToolCallResult } from "../agentRuntime";
import type { StoreHost } from "../store/settingsSlice";
import type { AgentResponse } from "../types";

const speechResponses = new WeakMap<AgentResponse, {
  store: StoreHost; vault: object; reply: string; spokenReply: string;
}>();

/** Main binds only its original completed response; JSON and object copies do
 * not inherit the original Runtime's speech projection. */
export function retainCommittedTaskSpeechResponse(
  store: StoreHost, response: AgentResponse, results: readonly ToolCallResult[], message: string
): void {
  speechResponses.delete(response);
  const spokenReply = committedTaskSpeechReply(store, response, results, message);
  if (spokenReply !== response.reply) speechResponses.set(response, {
    store, vault: store.app.vault, reply: response.reply, spokenReply
  });
}

export function committedTaskSpeechForResponse(
  store: StoreHost, response: AgentResponse, reply: string
): string {
  const held = speechResponses.get(response);
  return held && held.store === store && held.vault === store.app.vault
    && held.reply === reply && response.reply === reply
    && Array.isArray(response.actions) && response.actions.length === 0
    ? held.spokenReply : reply;
}

/** A speech-only projection of one original committed task receipt. Visible
 * text, saved history, Runtime result and Ledger remain the original receipt. */
export function committedTaskSpeechReply(
  store: StoreHost, response: AgentResponse, results: readonly ToolCallResult[], message: string
): string {
  const original = response.reply;
  // Keep identifiers when the user mentions them; this formatter does not
  // interpret quoted IDs or decide which identifier the person wants to hear.
  if (/(?:ID|编号|标识)/iu.test(message) || results.length !== 1 || response.actions.length) return original;
  const result = results[0];
  if (!result.success || result.actions.length || result.output !== original) return original;
  const evidence = getCommittedTaskEvidence(result, store);
  if (!evidence) return original;
  const file = evidence.files.find(file => file.path === store.taskDbPath());
  if (typeof file?.after !== "string") return original;
  try {
    const database = JSON.parse(file.after);
    if (!Array.isArray(database.tasks)) return original;
    const created = database.tasks.filter((task: { source?: string }) => task?.source === `lifeops-agent-tool:${evidence.operationId}`);
    if (created.length !== 1 || typeof created[0].id !== "string" || !created[0].id) return original;
    const suffix = `已从任务库读回校验（ID：${created[0].id}）。`;
    if (!original.startsWith(`已创建任务：${created[0].title}`) || !original.endsWith(suffix)) return original;
    return original.slice(0, -suffix.length) + "已从任务库读回校验。";
  } catch { return original; }
}
