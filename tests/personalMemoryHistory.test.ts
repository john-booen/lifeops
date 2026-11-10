import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (path: string) => path }));
import { DEFAULT_SETTINGS } from "../src/defaults";
import { createPersonalMemory, reviewPersonalMemoryRecord } from "../src/personalMemory";
import { createPersonalMemorySourceFilter, MEMORY_CONTEXT_OMISSION, personalMemoryContextRevision } from "../src/personalMemoryContext";
import { memorySourcePolicy } from "../src/personalMemorySources";
import { agentConversationAlreadyAppended, attestAgentHistoryResponse, bindAgentHistoryResponse, projectPersonalMemoryHistory, retainAgentConversationAppend } from "../src/personalMemoryHistory";
import { normalizeAgentHistory } from "../src/agentContext";
import type { StoreHost } from "../src/store/settingsSlice";
import type { AgentConversationMessage } from "../src/types";

const original = createPersonalMemory({ kind: "core_profile", content: "合成沟通偏好：先列依据。", sourceRefs: [{ sourceId: "synthetic", path: "source.md", capturedAt: "2026-10-09T00:00:00Z" }] });
const confirmed = () => reviewPersonalMemoryRecord([original], original.id, { decision: "confirm" });
const rawReply = "我们先核对材料和出处，再讨论下一步。"; // Arbitrary paraphrase; no old substring.
let store: StoreHost;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-10T01:00:00+08:00"));
  store = { app: { vault: {} }, settings: structuredClone(DEFAULT_SETTINGS), path: (...parts: string[]) => parts.join("/") } as unknown as StoreHost;
});
afterEach(() => vi.useRealTimers());
function pair(records = confirmed(), reply = rawReply) {
  const user: AgentConversationMessage = { role: "user", content: "合成下一步讨论" }, assistant: AgentConversationMessage = { role: "assistant", content: reply };
  const response = attestAgentHistoryResponse({ reply, actions: [] }, store, personalMemoryContextRevision(records), memorySourcePolicy(store), user.content);
  bindAgentHistoryResponse(response, user, assistant);
  return { user, assistant, response, history: [user, assistant] };
}

describe("opaque complete-history input boundary", () => {
  it("keeps current checked conversation across a fresh Store using the same vault", () => {
    const { history } = pair(), fresh = { ...store } as StoreHost;
    expect(projectPersonalMemoryHistory(history, fresh, confirmed())).toEqual(history.map(({ role, content }) => ({ role, content })));
  });
  it.each(["correct", "forget"] as const)("rejects arbitrary old paraphrases after %s without changing originals", decision => {
    const { history } = pair(), before = JSON.stringify(history);
    const changed = reviewPersonalMemoryRecord(confirmed(), original.id, decision === "correct" ? { decision, content: "合成先给结论" } : { decision });
    expect(projectPersonalMemoryHistory(history, store, changed)).toEqual([]);
    expect(projectPersonalMemoryHistory(history.map(entry => ({ role: entry.role, content: entry.content })), store, changed)).toEqual([]);
    expect(JSON.stringify(history)).toBe(before);
    expect(JSON.stringify(changed)).not.toContain(rawReply);
  });
  it("permits new checked continuity after forgetting while withholding unknown prior turns", () => {
    const forgotten = reviewPersonalMemoryRecord(confirmed(), original.id, { decision: "forget" });
    const current = pair(forgotten, "合成当前无关材料仍待整理");
    expect(projectPersonalMemoryHistory([{ role: "assistant", content: rawReply }, ...current.history], store, forgotten)).toEqual(current.history.map(({ role, content }) => ({ role, content })));
  });
  it("retains the candidate-only boundary when a first confirmation is undone", () => {
    const { history } = pair();
    expect(projectPersonalMemoryHistory(history, store, [original])).toEqual([]);
    expect(projectPersonalMemoryHistory([{ role: "assistant", content: rawReply }], store, [original])).toEqual([]);
  });
  it("never downgrades a stale token to ordinary history after Undo removes all memory markers", () => {
    const { history, response, assistant } = pair();
    expect(projectPersonalMemoryHistory(history, store, [])).toEqual([]);
    const symbol = Object.getOwnPropertySymbols(response)[0];
    expect(projectPersonalMemoryHistory([{ ...assistant, [symbol]: undefined }], store, [])).toEqual([]);
  });
  it("rejects a changed full tail before voice history is clipped", () => {
    const { assistant } = pair(confirmed(), "合成前文".repeat(240) + "完整原尾部");
    const changed = { ...assistant, content: assistant.content.slice(0, -5) + "外部改写尾部" };
    expect(normalizeAgentHistory(projectPersonalMemoryHistory([changed], store, confirmed()), 6, 700)).toEqual([]);
  });
  it.each(["vault", "privacy", "folders", "expiry"])("rejects a changed %s boundary", mode => {
    const records = confirmed(); if (mode === "expiry") records[0].expiresAt = "2026-10-10T01:00:01+08:00";
    const { history } = pair(records);
    if (mode === "vault") store = { ...store, app: { vault: {} } } as unknown as StoreHost;
    if (mode === "privacy") store.settings.privacy!.excludedVaultPrefixes = ["合成排除资料"];
    if (mode === "folders") store.settings.folders.ideas = "另一个合成资料位置";
    if (mode === "expiry") vi.advanceTimersByTime(2000);
    expect(projectPersonalMemoryHistory(history, store, records)).toEqual([]);
  });
  it("ignores public-shaped or stolen proof with mismatched role/content, even with no memory", () => {
    const { response, assistant } = pair();
    const symbol = Object.getOwnPropertySymbols(response)[0];
    const fake = Object.assign({ role: "assistant", content: rawReply }, { [symbol]: { revision: personalMemoryContextRevision([]), policy: memorySourcePolicy(store) } }) as AgentConversationMessage;
    expect(projectPersonalMemoryHistory([fake], store, [])).toEqual([]);
    expect(projectPersonalMemoryHistory([{ ...assistant, role: "user" }], store, confirmed())).toEqual([]);
  });
  it("does not attest a fabricated response, changed reply or interrupted pair", () => {
    const { response } = pair(), user: AgentConversationMessage = { role: "user", content: "合成下一步讨论" }, assistant: AgentConversationMessage = { role: "assistant", content: "不完整流" };
    bindAgentHistoryResponse(response, user, assistant);
    bindAgentHistoryResponse({ reply: assistant.content, actions: [] }, user, assistant);
    expect(projectPersonalMemoryHistory([user, assistant], store, confirmed())).toEqual([]);
  });
  it("projects only role and text; no opaque evidence is serialized or sent", () => {
    const { history, response } = pair(), projected = projectPersonalMemoryHistory(history, store, confirmed());
    expect(Object.getOwnPropertySymbols(history[0])).toHaveLength(1);
    expect(Object.getOwnPropertySymbols(projected[0])).toHaveLength(0);
    expect(JSON.stringify(response)).toBe(JSON.stringify({ reply: rawReply, actions: [] }));
    expect(JSON.stringify(history)).toBe(JSON.stringify(projected));
  });
  it("keeps ordinary unknown conversation only before any memory/permission boundary", () => {
    const history: AgentConversationMessage[] = [{ role: "assistant", content: "普通合成讨论" }];
    expect(projectPersonalMemoryHistory(history, store, [])).toEqual(history);
    store.settings.privacy!.excludedVaultPrefixes = ["合成排除"];
    expect(projectPersonalMemoryHistory(history, store, [])).toEqual([]);
  });
});

describe("automatic durable conversation sources", () => {
  it.each(["candidate", "confirmed", "forgotten"])("withholds unproven %s conversation before clipping, while retaining real unrelated source", mode => {
    const records = mode === "candidate" ? [original] : mode === "confirmed" ? confirmed() : reviewPersonalMemoryRecord(confirmed(), original.id, { decision: "forget" });
    const path = store.path(store.settings.folders.aiReports, "Conversations", "2026-10-09.md"), protect = createPersonalMemorySourceFilter(records, store);
    expect(protect(path, rawReply)).toBe(MEMORY_CONTEXT_OMISSION);
    expect(protect(store.path(store.settings.folders.ideas, "合成材料.md"), "无关原始事实")).toBe("无关原始事实");
  });
  it("uses an exact folder boundary rather than a similar name", () => {
    const protect = createPersonalMemorySourceFilter(confirmed(), store);
    expect(protect(store.path(store.settings.folders.aiReports, "Conversations-other", "合成.md"), rawReply)).toBe(rawReply);
  });
});

it('append receipt is bound to the original response/store/vault/full pair and grants no history authority',()=>{
 const user='纯虚构原输入',reply='纯虚构原回复',response={reply,actions:[]};
 expect(agentConversationAlreadyAppended(response,store,user,reply)).toBe(false);
 retainAgentConversationAppend(store,response,user);
 expect(agentConversationAlreadyAppended(response,store,user,reply)).toBe(true);
 expect(agentConversationAlreadyAppended({...response},store,user,reply)).toBe(false);
 expect(agentConversationAlreadyAppended(JSON.parse(JSON.stringify(response)),store,user,reply)).toBe(false);
 expect(agentConversationAlreadyAppended(response,{...store} as StoreHost,user,reply)).toBe(false);
 expect(agentConversationAlreadyAppended(response,store,user+'变',reply)).toBe(false);
 expect(agentConversationAlreadyAppended(response,store,user,reply+'变')).toBe(false);
 const priorVault=store.app.vault;store.app.vault={} as never;
 expect(agentConversationAlreadyAppended(response,store,user,reply)).toBe(false);store.app.vault=priorVault;
 response.reply+='变';expect(agentConversationAlreadyAppended(response,store,user,reply)).toBe(false);response.reply=reply;
 const u:AgentConversationMessage={role:'user',content:user},a:AgentConversationMessage={role:'assistant',content:reply};
 bindAgentHistoryResponse(response,u,a);expect(projectPersonalMemoryHistory([u,a],store,confirmed())).toEqual([]);
 const merelyChecked=pair();expect(agentConversationAlreadyAppended(merelyChecked.response,store,merelyChecked.user.content,rawReply)).toBe(false);
});
