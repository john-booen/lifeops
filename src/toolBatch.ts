import type { AiToolCall } from "./ai";
import type { AgentRuntime, ToolCallResult } from "./agentRuntime";
import { getLifeOpsTool } from "./toolRegistry";
import { recordRevision } from "./operationIdentity";
import type { AgentActionSuggestion } from "./types";
import { discardUnstatedTradePnl } from "./features/trading/inputs";
import {taskCreationPolicy,taskCreationTitle} from './features/tasks/creationPolicy';

const batchJournalOriginals = new WeakMap<AgentActionSuggestion, string>();
const requestedPreviews = new WeakMap<AgentActionSuggestion, string>();
const dismissedPreviews = new WeakSet<AgentActionSuggestion>();
export function dismissRequestedToolBatch(action:AgentActionSuggestion):void { dismissedPreviews.add(action); }

/** Only a locally created requested preview can be sealed after its exact records are bound. */
export function sealRequestedToolBatch(action: AgentActionSuggestion): void {
  if (requestedPreviews.has(action)) requestedPreviews.set(action, recordRevision(action));
}

export function isCurrentRequestedToolBatch(action: AgentActionSuggestion): boolean {
  return !dismissedPreviews.has(action) && requestedPreviews.get(action) === recordRevision(action);
}

function countWrites(calls: AiToolCall[]): number {
  return calls.reduce((total, call) => total + (call.name === "update_tasks" && Array.isArray(call.arguments.updates)
    ? Math.max(1, call.arguments.updates.length) : call.name === "record_trade" && Array.isArray(call.arguments.trades)
    ? Math.max(1, call.arguments.trades.length) : 1), 0);
}

export function prepareToolBatch(calls: AiToolCall[], previousWriteCount = 0, userMessage = "", confirmationRequested = false): ToolCallResult | undefined {
  const writes = calls.filter(call => getLifeOpsTool(call.name)?.safety === "direct-write" && call.name !== "undo_latest_operation");
  if(writes.some(call=>['create_task','schedule_task_batch'].includes(call.name))&&taskCreationPolicy(userMessage).denied){
    return{callId:writes[0].id??'declined-task-creation',success:false,output:'这句包含取消或举例要求，没有创建任务。',actions:[]};
  }
  if(confirmationRequested&&writes.some(call=>call.name==='schedule_task_batch')){
    if(calls.length===1)return; // Runtime expands the batch before any ledger claim.
    return{callId:writes[0].id??'declined-task-batch',success:false,output:'请把整批排程单独提交，本次尚未保存。',actions:[]};
  }
  const count = countWrites(writes), guarded = countWrites(writes.filter(call => call.name !== "create_task"));
  if ((!guarded && !confirmationRequested) || !count || (count + previousWriteCount <= 3 && !confirmationRequested)) return;
  const total = count + previousWriteCount;
  const reviewed = writes.map(call => call.name === "record_trade" && Array.isArray(call.arguments.trades)
    ? { ...call, arguments: { ...call.arguments, trades: call.arguments.trades.map(row => discardUnstatedTradePnl(row, userMessage)) } }
    : call.name==='create_task'&&confirmationRequested&&typeof call.arguments.title==='string'
      ? {...call,arguments:{...call.arguments,title:taskCreationTitle(call.arguments.title,userMessage)}} : call);
  const journalOriginal = userMessage.trim() && reviewed.some(call => call.name === "append_journal_entry" && call.arguments.period === "晚")
    ? userMessage : undefined;
  const id = `proposal:batch:${recordRevision(journalOriginal ? [reviewed, journalOriginal] : reviewed)}`;
  const action: AgentActionSuggestion = { id, type: "tool_batch", title: `确认 ${count} 项修改`,
    description: "超过三条的批量修改，确认后执行；每项均有操作记录，可撤销。",
    content: reviewed.map((call, i) => `${i + 1}. ${call.name}：${JSON.stringify(call.arguments)}`).join("\n"), date: "",
    toolBatch: structuredClone(reviewed),
    ...(previousWriteCount || count !== writes.length ? { batchWriteCount: total } : {}) };
  if(confirmationRequested){action.title=`确认 ${count} 项任务安排`;action.description='核对后才保存；新任务和原任务修改都等待这一张卡确认。';}
  if (previousWriteCount) {
    action.title = `确认剩余 ${count} 项修改`;
    action.description = `本轮已保存 ${previousWriteCount} 项，剩余 ${count} 项需要确认。每项均可撤销。`;
  }
  if (journalOriginal) batchJournalOriginals.set(action, journalOriginal);
  if (confirmationRequested) requestedPreviews.set(action, "");
  return { callId: id, success: true, output: `已准备：${count} 项修改，等待确认。`, actions: [action] };
}

export async function executeConfirmedToolBatch(action: AgentActionSuggestion, runtime: AgentRuntime, assertCurrent: () => void): Promise<string> {
  const current=()=>{if(dismissedPreviews.has(action))throw Error('这份安排已取消，没有保存任务。');assertCurrent();};current();
  const actionId = action.id;
  const calls = structuredClone(action.toolBatch ?? []);
  const count = countWrites(calls), total = action.batchWriteCount ?? count;
  const requested = isCurrentRequestedToolBatch(action);
  if (!calls.length || !Number.isSafeInteger(total) || total < count || (total <= 3 && !requested)
    || calls.some(call => getLifeOpsTool(call.name)?.safety !== "direct-write" || call.name === "undo_latest_operation")) throw new Error("批量修改内容无效，请重新提出。");
  const outputs: string[] = [];
  const original = batchJournalOriginals.get(action);
  for (let i = 0; i < calls.length; i++) {
    current();
    const result = await runtime.executeToolCall({ toolName: calls[i].name, arguments: calls[i].arguments,
      source: "system", callId: `confirmed:${actionId}:${i}`, confirmedByUser: true,
      ...(calls[i].name === "append_journal_entry" ? { userMessage: original } : {}) }, { assertCurrent:current });
    if (!result.success) throw new Error(`已保存 ${outputs.length} 项，第 ${i + 1} 项未完成：${result.output}。已保存项可在最近操作中撤销。`);
    outputs.push(result.output);
  }
  return outputs.join("\n");
}
