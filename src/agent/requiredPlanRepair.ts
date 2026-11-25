import type {AiChatResult,ChatMessage} from "../ai";

/** Complete the rejected protocol turn with explicit errors; none of its calls ran. */
export function requiredPlanRepairMessages(messages:ChatMessage[],response:AiChatResult):ChatMessage[] {
  const calls=response.toolCalls.map((call,index)=>({id:`unexecuted-plan-${index}`,type:"function" as const,
    function:{name:call.name,arguments:JSON.stringify(call.arguments)}}));
  return [...messages,
    {role:"assistant",content:response.content,...(calls.length?{tool_calls:calls}:{})},
    ...calls.map(call=>({role:"tool" as const,tool_call_id:call.id,
      content:JSON.stringify({success:false,executed:false,error:"本阶段只接受propose_task_plan；这次调用没有执行，不能当作新读取或保存证据。"})})),
    {role:"system",content:"上一条回复未按本阶段协议生成安排卡，未执行其中任何调用。plan_today的当轮结果已经给出draft日期、负荷参考和已排事项。现在只调用一次propose_task_plan，把具体任务放入tasks，date采用draft.date；禁止再查询或重复plan_today。只给确认草案，不执行保存、不声称卡已生成。若用户给出具体清单，完整保留其事项；未指定清单时根据已经读到的资料给出可审阅建议。"}];
}
