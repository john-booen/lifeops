import { createHash } from "node:crypto";
import type { PersonalMemoryRecord } from "./personalMemory";
import { createPersonalMemoryContextFilter, personalMemoryContextRevision, personalMemoryHistoryNeedsEvidence } from "./personalMemoryContext";
import { memorySourcePolicy } from "./personalMemorySources";
import type { StoreHost } from "./store/settingsSlice";
import type { AgentConversationMessage, AgentResponse } from "./types";

// Private and process-local. Enumerable symbols survive an ordinary object
// spread, but neither JSON nor the Provider message projection carries them.
const evidence = Symbol("lifeops-agent-history-evidence");
interface HistoryEvidence {
  vault: object;
  revision: string;
  policy: string;
  userHash: string;
  assistantHash: string;
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
export function attestAgentHistoryResponse(response: AgentResponse, store: StoreHost, revision: string, policy: string, user: string): AgentResponse {
  const token = Object.freeze({});
  owners.set(token, { vault: store.app.vault, revision, policy, userHash: hash(user), assistantHash: hash(response.reply) });
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
