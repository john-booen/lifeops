import { createHash } from "node:crypto";
import type { PersonalMemoryRecord } from "./personalMemory";
import { createPersonalMemoryContextFilter, personalMemoryContextRevision, personalMemoryHistoryNeedsEvidence } from "./personalMemoryContext";
import { memorySourcePolicy } from "./personalMemorySources";
import type { StoreHost } from "./store/settingsSlice";
import type { AgentConversationMessage, AgentResponse } from "./types";
import { summaryQuerySelections, type SummaryQueryScope } from "./agent/summaryQueryScope";

// Private and process-local. Enumerable symbols survive an ordinary object
// spread, but neither JSON nor the Provider message projection carries them.
const evidence = Symbol("lifeops-agent-history-evidence");
interface HistoryEvidence {
  vault: object;
  revision: string;
  policy: string;
  userHash: string;
  assistantHash: string;
  queryScopes?: readonly SummaryQueryScope[];
}
const owners = new WeakMap<object, HistoryEvidence>();
// Persistence and permission to reuse history are separate claims. Only Main's
// original response receives this receipt after its real append has completed.
const appendedResponses = new WeakMap<AgentResponse, {
  store: StoreHost; vault: object; userHash: string; assistantHash: string;
}>();
type Proven = { [evidence]?: object };
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function retainAgentConversationAppend(store: StoreHost, response: AgentResponse, user: string): void {
  appendedResponses.set(response, { store, vault: store.app.vault, userHash: hash(user), assistantHash: hash(response.reply) });
}

export function agentConversationAlreadyAppended(response: AgentResponse, store: StoreHost, user: string, reply: string): boolean {
  const held = appendedResponses.get(response);
  return !!held && held.store === store && held.vault === store.app.vault
    && held.userHash === hash(user) && held.assistantHash === hash(reply) && response.reply === reply;
}

/** Main calls only after its full input projection and publication guards.
 * Bind to the generation's snapshot, never a newly reread reply-time state. */
export function attestAgentHistoryResponse(response: AgentResponse, store: StoreHost, revision: string, policy: string, user: string,
  queryScopes: readonly SummaryQueryScope[] = []): AgentResponse {
  const token = Object.freeze({});
  owners.set(token, { vault: store.app.vault, revision, policy, userHash: hash(user), assistantHash: hash(response.reply),
    ...(summaryQuerySelections(store, queryScopes).length ? { queryScopes: [...queryScopes] } : {}) });
  Object.defineProperty(response, evidence, { value: token });
  return response;
}

/** Only final UI pairs receive the producer's opaque proof. Interrupted,
 * streaming, synthetic or changed responses stay visible but unproven. */
export function bindAgentHistoryResponse(response: AgentResponse, user: AgentConversationMessage | undefined, assistant: AgentConversationMessage | undefined): void {
  const token = (response as Proven)[evidence], owner = token && owners.get(token);
  if (!owner || !user || !assistant || user.role !== "user" || assistant.role !== "assistant" || owner.userHash !== hash(user.content)
    || owner.assistantHash !== hash(assistant.content) || owner.assistantHash !== hash(response.reply)) return;
  Object.defineProperty(user, evidence, { value: token, enumerable: true });
  Object.defineProperty(assistant, evidence, { value: token, enumerable: true });
}

/** A visible pair alone is not authority: check its current producer, vault, policy and exact text. */
export function isCurrentAgentHistoryPair(user: AgentConversationMessage | undefined, assistant: AgentConversationMessage | undefined,
  store: StoreHost, records: PersonalMemoryRecord[]): boolean {
  if (user?.role !== "user" || assistant?.role !== "assistant") return false;
  const token = (user as Proven)[evidence], owner = token && owners.get(token);
  return !!owner && token === (assistant as Proven)[evidence] && owner.vault === store.app.vault
    && owner.revision === personalMemoryContextRevision(records) && owner.policy === memorySourcePolicy(store)
    && owner.userHash === hash(user.content) && owner.assistantHash === hash(assistant.content);
}

/** Validate complete entries before normalizeAgentHistory clips them. A stale
 * or fabricated proof never falls back to the unproven-history branch. The
 * original objects and persisted conversation remain unchanged. */
export function projectPersonalMemoryHistory(history: AgentConversationMessage[], store: StoreHost, records: PersonalMemoryRecord[]): AgentConversationMessage[] {
  const revision = personalMemoryContextRevision(records), policy = memorySourcePolicy(store);
  const required = personalMemoryHistoryNeedsEvidence(records, store), protect = createPersonalMemoryContextFilter(records);
  return history.flatMap(entry => {
    const token = (entry as Proven)[evidence];
    if (evidence in entry) {
      const owner = token && owners.get(token);
      if (!owner || owner.vault !== store.app.vault || owner.revision !== revision || owner.policy !== policy
        || hash(entry.content) !== (entry.role === "user" ? owner.userHash : owner.assistantHash)) return [];
    } else if (required) return [];
    return [{ role: entry.role, content: protect(entry.content) }];
  });
}

/** Memory changes invalidate old prose, not a checked query's date selection.
 * Require the complete original pair; the selection only helps resolve a new
 * request and must be read again under the current permissions and memory. */
export function historicalQueryHistoryContext(history: AgentConversationMessage[], store: StoreHost): string {
  for (let index = history.length - 1; index > 0; index--) {
    const user = history[index - 1], assistant = history[index];
    if (user.role !== "user" || assistant.role !== "assistant") continue;
    const token = (user as Proven)[evidence], owner = token && owners.get(token);
    if (!owner || token !== (assistant as Proven)[evidence] || owner.vault !== store.app.vault || owner.policy !== memorySourcePolicy(store)
      || owner.userHash !== hash(user.content) || owner.assistantHash !== hash(assistant.content)) return "";
    const selected = summaryQuerySelections(store, owner.queryScopes ?? []);
    if (selected.length) return "此前已核对的历史查询日期范围（仅用于本轮指代，不是事实或写入授权）：\n" + JSON.stringify(selected)
      + "\n只有本轮确实接续该查询时才使用；用户明确给出的新范围优先。本轮必须按当前权限重新读取，不沿用旧回复或旧事实。后续建议使用当前可用的已确认记忆；范围本身不证明任何事件。";
  }
  return "";
}
