import type {AiToolCall,ChatMessage} from '../ai';
import {recordRevision} from '../operationIdentity';

/** A failed pure planning call may repair clocks once; its task list is immutable. */
export function batchAvailabilityFailure(call:AiToolCall,output:string):ChatMessage {
  return {role:'tool',tool_call_id:call.id!,content:JSON.stringify({success:false,executed:false,saved:0,error:output})};
}
export const BATCH_AVAILABILITY_REPAIR = '整批安排的可用时刻参数未通过校验，尚未执行任何保存。只调用一次schedule_task_batch纠正availableStart/availableEnd为HH:mm；用户未指定的可用边界可以省略。逐字保留原date和tasks（任务、顺序、估时、分类及期限），不得增加、删减、改期或另行创建任务。仍不明确就不保存，不声称安排完成。';
export function repairedBatchAvailability(original:AiToolCall,calls:AiToolCall[]):AiToolCall|undefined {
  if(calls.length!==1||calls[0].name!=='schedule_task_batch')return;
  const rest=(args:Record<string,unknown>)=>Object.fromEntries(Object.entries(args).filter(([key])=>!['availableStart','availableEnd'].includes(key)));
  return recordRevision(rest(original.arguments))===recordRevision(rest(calls[0].arguments))?calls[0]:undefined;
}
