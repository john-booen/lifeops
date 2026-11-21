import { LifeOpsAi } from "../ai";
import { Notice } from "obsidian";
import type LifeOpsPlugin from "../main";
import { offlineFallback } from "./offlineFallback";
import { attestAgentHistoryResponse, retainAgentConversationAppend } from "../personalMemoryHistory";
import { personalMemoryContextRevision } from "../personalMemoryContext";
import { memorySourcePolicy } from "../personalMemorySources";
import { isVaultPathExcluded } from "../privacy";
import { todayString } from "../date";
import type { VaultQueryRead } from "../vaultQueryRead";
import type { StoreHost } from "../store/settingsSlice";
import type { AgentConversationMessage, AgentResponse, AgentSubmissionOptions } from "../types";
import { AgentLoop } from "./AgentLoop";
import { settingsForAgentModel } from "./models";
import { assertProviderActive } from "../providerRun";

export interface AgentTurnHost {
  activeProviderRequests: LifeOpsPlugin["activeProviderRequests"];
  ai: LifeOpsPlugin["ai"];
  executeToolCalls: LifeOpsPlugin["executeToolCalls"];
  finiteProviderRevision: LifeOpsPlugin["finiteProviderRevision"];
  settings: LifeOpsPlugin["settings"];
  store: LifeOpsPlugin["store"];
  createAgentRuntime: LifeOpsPlugin["createAgentRuntime"];
  unloaded: LifeOpsPlugin["unloaded"];
}

export async function runAgentTurn(this: AgentTurnHost, message: string, history: AgentConversationMessage[],
  onText: (content: string) => void, options: AgentSubmissionOptions): Promise<AgentResponse> {
  const request = new AbortController();
  const abort = () => request.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted || this.unloaded) abort();
  const entry = { controller: request, stage: "classification" as const, revision: this.finiteProviderRevision("classification") };
  (this.activeProviderRequests ??= new Set()).add(entry);
  const settings = structuredClone(this.settings), ai = this.ai, store = this.store as unknown as StoreHost;
  const inbox = options.phoneInbox;
  const historyPolicy = memorySourcePolicy(store);
  let historyRevision: string | undefined;
  let lastQuery: VaultQueryRead | undefined;
  const loop = new AgentLoop({
    settings, store,
    assertReadOnlyReplyCurrent: () => {
      assertProviderActive(request.signal);
      if (this.unloaded || (this.store as unknown as StoreHost) !== store
        || this.finiteProviderRevision("classification") !== entry.revision) throw new DOMException("本轮读取已停止。", "AbortError");
    },
    onContext: ({ memories }) => { if (memories) historyRevision = personalMemoryContextRevision(memories); },
    aiForRole: role => {
      const selected = settingsForAgentModel(settings, role);
      return selected === settings ? ai : new LifeOpsAi(selected);
    },
    executeTools: (calls, userMessage, signal, onResult) => this.executeToolCalls(calls, userMessage, signal, inbox?.assertLineCurrent,
      async (call, result) => { onResult(call, result); }, [], undefined, (_result, read) => {
        lastQuery?.dispose();
        lastQuery = read;
      }, lastQuery, inbox?.assertCurrent).then(execution => execution.results),
    offlineFallback: input => offlineFallback(input, store, this.createAgentRuntime())
  });
  try {
    let streamed = "";
    const result = await loop.run({ message, history, source: inbox ? "system" : options.source ?? "text", now: new Date(), signal: request.signal,
      phoneInbox: inbox, voiceBackground: options.voiceBackground, voiceJobs: options.voiceJobs,
      onVoiceText: options.source === "voice" ? options.onVoiceText : undefined,
      onText: delta => { streamed += delta; onText(streamed); } });
    const response = { reply: result.text, actions: result.confirmations, receipts: result.receipts,
      ...(result.voiceSpeech ? { voiceSpeech: result.voiceSpeech } : {}),
      ...(inbox ? { toolCalls: result.toolCalls } : {}) };
    if (historyRevision !== undefined && !request.signal.aborted && !this.unloaded) {
      attestAgentHistoryResponse(response, store, historyRevision, historyPolicy, message);
    }
    const conversationPath = store.path(settings.folders.aiReports, "Conversations", `${todayString()}.md`);
    if (!inbox && !options.selfTest && !(options.source === "voice" && options.deferConversation) && !request.signal.aborted && !this.unloaded && result.text.trim()
      && !isVaultPathExcluded(conversationPath, settings.privacy?.excludedVaultPrefixes)) {
      await store.appendAgentConversation(message, result.text, undefined, () => !request.signal.aborted && !this.unloaded)
        .then(() => retainAgentConversationAppend(store, response, message))
        .catch(() => { new Notice("回复已生成，对话记录暂未保存。"); });
    }
    if (!request.signal.aborted && streamed !== result.text) onText(result.text);
    return response;
  } finally {
    lastQuery?.dispose();
    this.activeProviderRequests.delete(entry);
    options.signal?.removeEventListener("abort", abort);
  }
}
