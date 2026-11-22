import { vi } from "vitest";
import type LifeOpsPlugin from "../../src/main";
import { LifeOpsAi } from "../../src/ai";
import { bindAgentHistoryResponse } from "../../src/personalMemoryHistory";
import type { StoreHost } from "../../src/store/settingsSlice";
import type { AgentConversationMessage } from "../../src/types";

/** A completed, non-writing production turn with a controlled fictional proposal. */
export async function deferredTitleConfirmationFixture(plugin: LifeOpsPlugin, store: StoreHost): Promise<AgentConversationMessage[]> {
  for (const [i, title] of ["核对虚构青色图卡", "整理虚构银色纸盒"].entries()) {
    await store.createTask({ title, date: "2026-11-13", time: `${15 + i}:00`, note: "虚构确认续接备注" });
  }
  const before = await store.readPath(store.taskDbPath());
  const question = "把「核对虚构青色图卡」改成「给虚构青色图卡添加黄色标记」，把「整理虚构银色纸盒」改成「检查虚构银色纸盒的封口」。先给我确认卡，等我确认。";
  const proposal = "核对虚构青色图卡改成给虚构青色图卡添加黄色标记；整理虚构银色纸盒改成检查虚构银色纸盒的封口。请确认后我再改。";
  const mock = vi.spyOn(LifeOpsAi.prototype, "agentTurnStream").mockResolvedValue({ content: proposal, toolCalls: [] });
  let reply;
  try { reply = await plugin.submitAgentMessageStream(question, [], () => {}, { source: "text" }); }
  finally { mock.mockRestore(); }
  const card = reply.actions[0], updates = card?.toolBatch?.flatMap(call => Array.isArray(call.arguments.updates) ? call.arguments.updates : []) ?? [];
  if (before !== await store.readPath(store.taskDbPath()) || reply.receipts?.length || reply.actions.length !== 1
    || card.type !== "tool_batch" || updates.length !== 2 || !updates.every(row => typeof row.expectedRevision === "string")
    || !reply.reply.includes("黄色标记") || !reply.reply.includes("封口") || !reply.reply.includes("尚未修改")) {
    throw Error("虚构待确认前轮发生写入或未保留完整提案。");
  }
  const history: AgentConversationMessage[] = [{ role: "user", content: question }, { role: "assistant", content: reply.reply }];
  bindAgentHistoryResponse(reply, history[0], history[1]);
  return history;
}
