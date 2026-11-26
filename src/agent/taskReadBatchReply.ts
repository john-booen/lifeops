import type {AiToolCall} from '../ai';
import type {ToolCallResult} from '../agentRuntime';
import {formatTaskListReply} from '../features/tasks/planTools';
import {completedTasksReply} from '../features/stats/completedTasksReply';
import {taskSummaryReply} from '../features/stats/taskSummaryReply';
import {taskMetricMeaning} from '../features/stats/taskMetricMeaning';

/** Compose only model-declared factual reads. A write, an explanation, a
 * grouped result or an incomplete read must continue through the agent. */
export function taskReadBatchReply(calls:readonly AiToolCall[],results:readonly ToolCallResult[],today:string):string|undefined{
  if(calls.length<2||results.length!==calls.length)return;
  const blocks:string[]=[];
  for(const call of calls){
    const result=results.find(result=>result.callId===call.id);
    if(!result?.success||result.receipt||result.actions.length)return;
    const args=call.arguments;let text:string|undefined;
    if(call.name==='get_stats'&&args.domain==='tasks'&&args.groupBy===undefined){
      if(args.directReply==='completed_tasks')text=completedTasksReply(result.output,today);
      else if(args.directReply==='task_summary')text=taskSummaryReply(result.output,today);
      else if(args.directReply==='task_meaning')text=taskMetricMeaning(result.output);
    }else if(call.name==='list_tasks'&&['facts','counts'].includes(String(args.answerMode))&&args.directReply!==false){
      const body=formatTaskListReply(result.output,today);
      if(body)text=(args.answerMode==='counts'?'任务数量：\n':'任务清单：\n')+body;
    }
    if(!text)return;blocks.push(text);
  }
  return blocks.join('\n\n');
}
