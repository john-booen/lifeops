import type { ToolCallResult } from "./agentRuntime";
import type { AgentWriteReceipt } from "./types";
import type { AgentResponse } from "./types";
import type { AgentConversationMessage } from "./types";

export function writeReceipts(results: ToolCallResult[]): AgentWriteReceipt[] {
  return results.flatMap(result => result.receipt ? [result.receipt] : []);
}

export function conversationMemoryResponse(results: ToolCallResult[], requestedCount: number): AgentResponse | undefined {
  if (!results.some(result => result.receipt?.operationId.startsWith("confirmed:conversation:"))) return;
  const receipts = writeReceipts(results);
  return { reply: `${receipts.length === 1 ? "已记住：这条对话信息" : `已保存：${receipts.length} 项修改`}${results.length < requestedCount ? "。记忆已更新，其余事项尚未执行，请重新提出。" : "。"}`,
    actions: [], receipts };
}

export function renderWriteReceipts(container: HTMLElement, receipts: AgentWriteReceipt[] | undefined,
  undo?: (id: string) => Promise<void>, editTrade?: (id: string) => Promise<void>): void {
  if ((!undo && !editTrade) || !receipts?.length) return;
  const row = container.createDiv({ cls: "lifeops-write-receipts" });
  for (const receipt of receipts) {
    const editButtons: HTMLButtonElement[] = [];
    for (const trade of receipt.tradeEdits ?? []) {
      const tradeRow = row.createDiv();
      tradeRow.createEl("span", { text: trade.summary });
      if (!editTrade) continue;
      const edit = tradeRow.createEl("button", { text: "改", attr: { type: "button", "aria-label": `修改 ${trade.label}` } });
      editButtons.push(edit);
      edit.onclick = async () => {
        try { await editTrade(trade.id); }
        catch (error) { new (await import("obsidian")).Notice(error instanceof Error ? error.message : "交易无法打开。"); }
      };
    }
    if (!undo) continue;
    const button = row.createEl("button", { text: "撤销", attr: { type: "button", "aria-label": "撤销这次保存" } });
    button.onclick = async () => {
      button.disabled = true;
      try { await undo(receipt.operationId); button.textContent = "已撤销"; for (const edit of editButtons) edit.disabled = true; }
      catch (error) { button.disabled = false; new (await import("obsidian")).Notice(error instanceof Error ? error.message : "撤销未完成，请查看最近操作。"); }
    };
  }
}

export function attachVoiceWriteReceipts(view: { agentMessages: AgentConversationMessage[]; agentOmniE2eAssistantIndex: number;
  agentOmniE2eStreamMessageEl?: HTMLElement; controller: { undoStewardOperation?(id: string): Promise<void>; openTradeEditModal?(id: string): Promise<void> } }, receipts?: AgentWriteReceipt[]): void {
  if (!receipts?.length || !view.agentMessages) return;
  const index = view.agentOmniE2eAssistantIndex, message = view.agentMessages[index];
  if (message?.role !== "assistant") return;
  const merged = [...new Map([...(message.receipts ?? []), ...receipts].map(receipt => [receipt.operationId, receipt])).values()];
  view.agentMessages[index] = { ...message, receipts: merged };
  if (view.agentOmniE2eStreamMessageEl) renderWriteReceipts(view.agentOmniE2eStreamMessageEl, receipts,
    view.controller.undoStewardOperation?.bind(view.controller), view.controller.openTradeEditModal?.bind(view.controller));
}
