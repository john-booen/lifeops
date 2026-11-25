import type { AiToolCall } from "../ai";
import { readContextTasks } from "../contextData";
import type { StoreHost } from "../store/settingsSlice";
import type { AgentConversationMessage } from "../types";
import type { PersonalMemoryRecord } from "../personalMemory";
import { isCurrentAgentHistoryPair } from "../personalMemoryHistory";
import { isLiteralTaskConfirmation } from "../features/tasks/confirmationText";

import {taskConfirmationRequested} from '../features/tasks/creationPolicy';
export {taskConfirmationRequested} from '../features/tasks/creationPolicy';

interface TitleEdit { id:string; before:string; title:string }
interface TitleEditRequest { edits:TitleEdit[]; confirmationRequested:boolean }

export async function confirmedTitleEdits(store: StoreHost, message: string, history: AgentConversationMessage[], memories: PersonalMemoryRecord[]): Promise<TitleEdit[] | undefined> {
  if (!isLiteralTaskConfirmation(message)) return;
  const user = history.at(-2), assistant = history.at(-1);
  if (!isCurrentAgentHistoryPair(user, assistant, store, memories) || !assistant!.content.includes("确认")) return;
  const edits = (await titleEditRequest(store, user!.content))?.edits;
  if (!edits?.length || edits.length > 3 || !edits.every(edit => assistant!.content.includes(edit.before) && assistant!.content.includes(edit.title))) return;
  return edits;
}
/** Only a leading, explicit quoted old→new instruction supplies exact content.
 * Discussion, conditional requests, and ambiguous task names keep the normal route. */
export async function explicitTitleEdits(store:StoreHost,message:string):Promise<TitleEdit[]|undefined> {
  const request = await titleEditRequest(store, message);
  return request?.confirmationRequested ? undefined : request?.edits;
}

export async function titleEditRequest(store:StoreHost,message:string):Promise<TitleEditRequest|undefined> {
  const pair=/^(?:(?:请|帮我|请帮我)\s*)?把(?:刚才的|之前的|原来的|任务)?\s*[「“"]([^「」“”"\r\n]{1,1000})[」”"]\s*(?:的标题|的名称|标题|名称)?\s*(?:改为|改成|重命名为|更名为)\s*[「“"]([^「」“”"\r\n]{1,1000})[」”"]/u;
  const edits:Array<{before:string;title:string}>=[];
  let tail=message.trim(),outside="";
  for(;;){
    const match=pair.exec(tail);if(!match)break;
    edits.push({before:match[1].trim(),title:match[2].trim()});
    tail=tail.slice(match[0].length).replace(/^[\s，,；;。]+/u,"");
    if(edits.length>20)return;
  }
  if(!edits.length)return;
  // Keep the waiting requirement separate from hypothetical, discussion and refusal text.
  outside=tail.replace(/[「“"][^「」“”"]*[」”"]/gu,"");
  if(/如果|假如|举例|例子|只讨论|不(?:要)?(?:执行|修改|改名|保存)|先别|暂不|是否|会怎样|是什么|翻译|怎么说|什么意思|台词|[?？]/u.test(outside)
    || /把[\s\S]*?(?:改为|改成|重命名为|更名为)/u.test(outside))return;
  const confirmationRequested = taskConfirmationRequested(outside);
  const data=await readContextTasks(store);if(!data.available)return;
  const result:TitleEdit[]=[],seen=new Set<string>();
  for(const edit of edits){
    if(!edit.before||!edit.title)return;
    const matches=data.tasks.filter(task=>task.title===edit.before);
    if(matches.length!==1||seen.has(matches[0].id))return;
    seen.add(matches[0].id);result.push({id:matches[0].id,...edit});
  }
  return { edits: result, confirmationRequested };
}

/** Complete a partial model submission using only the user's exact pairs.
 * Other actions (for example a new task in the same sentence) remain in order. */
export function completeTitleEditCalls(calls:AiToolCall[],edits:TitleEdit[]):AiToolCall[] {
  const updates=calls.filter(call=>call.name==="update_tasks");
  if(!updates.length)return [titleEditCall(edits),...calls];
  for(const call of updates){
    if(Object.keys(call.arguments).some(key=>key!=="updates")||!Array.isArray(call.arguments.updates))return calls;
    for(const row of call.arguments.updates){
      if(!row||typeof row!=="object"||Array.isArray(row)||Object.keys(row).some(key=>!["taskIdOrTitle","title"].includes(key))
        ||!edits.some(edit=>row.taskIdOrTitle===edit.id||row.taskIdOrTitle===edit.before))return calls;
    }
  }
  const first=updates[0];
  return calls.flatMap(call=>call.name!=="update_tasks"?[call]:call===first?[{...call,arguments:{updates:edits.map(edit=>({taskIdOrTitle:edit.before,title:edit.title}))}}]:[]);
}

export function titleEditCall(edits:TitleEdit[]):AiToolCall {
  return {name:"update_tasks",arguments:{updates:edits.map(edit=>({taskIdOrTitle:edit.before,title:edit.title}))}};
}
