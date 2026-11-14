import type { AiToolCall } from "./ai";
import type { AgentRuntime, ToolCallResult } from "./agentRuntime";
import { getLifeOpsTool } from "./toolRegistry";
import { recordRevision } from "./operationIdentity";
import type { AgentActionSuggestion } from "./types";
import { discardUnstatedTradePnl } from "./features/trading/inputs";

const batchJournalOriginals = new WeakMap<AgentActionSuggestion, string>();

function countWrites(calls: AiToolCall[]): number {
  return calls.reduce((total, call) => total + (call.name === "record_trade" && Array.isArray(call.arguments.trades)
    ? Math.max(1, call.arguments.trades.length) : 1), 0);
}

export function prepareToolBatch(calls: AiToolCall[], previousWriteCount = 0, userMessage = ""): ToolCallResult | undefined {
  const writes = calls.filter(call => getLifeOpsTool(call.name)?.safety === "direct-write" && call.name !== "undo_latest_operation");
  const count = countWrites(writes), total = count + previousWriteCount;
  if (!count || total <= 3) return;
  const reviewed = writes.map(call => call.name === "record_trade" && Array.isArray(call.arguments.trades)
    ? { ...call, arguments: { ...call.arguments, trades: call.arguments.trades.map(row => discardUnstatedTradePnl(row, userMessage)) } } : call);
  const journalOriginal = userMessage.trim() && reviewed.some(call => call.name === "append_journal_entry" && call.arguments.period === "晚")
    ? userMessage : undefined;
  const id = `proposal:batch:${recordRevision(journalOriginal ? [reviewed, journalOriginal] : reviewed)}`;
  const action: AgentActionSuggestion = { id, type: "tool_batch", title: `确认 ${count} 项修改`,
    description: "超过三条的批量修改，确认后执行；每项均有操作记录，可撤销。",
    content: reviewed.map((call, i) => `${i + 1}. ${call.name}：${JSON.stringify(call.arguments)}`).join("\n"), date: "",
    toolBatch: structuredClone(reviewed),
    ...(previousWriteCount || count !== writes.length ? { batchWriteCount: total } : {}) };
  if (previousWriteCount) {
    action.title = `确认剩余 ${count} 项修改`;
    action.description = `本轮已保存 ${previousWriteCount} 项，剩余 ${count} 项需要确认。每项均可撤销。`;
  }
  if (journalOriginal) batchJournalOriginals.set(action, journalOriginal);
  return { callId: id, success: true, output: `已准备：${count} 项修改，等待确认。`, actions: [action] };
}

export async function executeConfirmedToolBatch(action: AgentActionSuggestion, runtime: AgentRuntime, assertCurrent: () => void): Promise<string> {
  const calls = structuredClone(action.toolBatch ?? []);
  const count = countWrites(calls), total = action.batchWriteCount ?? count;
  if (!calls.length || !Number.isSafeInteger(total) || total < count || total <= 3
    || calls.some(call => getLifeOpsTool(call.name)?.safety !== "direct-write" || call.name === "undo_latest_operation")) throw new Error("批量修改内容无效，请重新提出。");
  const outputs: string[] = [];
  const original = batchJournalOriginals.get(action);
  for (let i = 0; i < calls.length; i++) {
    assertCurrent();
    const result = await runtime.executeToolCall({ toolName: calls[i].name, arguments: calls[i].arguments,
      source: "system", callId: `confirmed:${action.id}:${i}`, confirmedByUser: true,
      ...(calls[i].name === "append_journal_entry" ? { userMessage: original } : {}) }, { assertCurrent });
    if (!result.success) throw new Error(`已保存 ${outputs.length} 项，第 ${i + 1} 项未完成：${result.output}。已保存项可在最近操作中撤销。`);
    outputs.push(result.output);
  }
  return outputs.join("\n");
}
