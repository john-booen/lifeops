import type { AiToolCall } from "../ai";
import type { StoreHost } from "../store/settingsSlice";
import { planTaskBatch, TASK_BATCH_TOOL } from "./taskBatch";
import {draftCapacityNotice, taskPlanDraft} from '../taskPlanTools';

/** Expand a structured new-task batch alongside edits before the common confirmation gate. */
export async function expandMixedTaskBatch(store: StoreHost, calls: AiToolCall[], now: Date): Promise<{
  calls: AiToolCall[]; notes: string[]; confirmationRequested?: true; error?: { callId: string; output: string };
} | undefined> {
  const proposals = calls.filter(call => ['propose_task_plan','propose_project_work_plan'].includes(call.name));
  if (proposals.length && calls.some(call => call.name === 'update_tasks')) {
    const proposal = proposals[0];
    try {
      if (proposals.length !== 1 || calls.some(call => !['propose_task_plan','update_tasks'].includes(call.name))
        || proposal.arguments.projectId !== undefined) throw Error('这份混合安排包含项目或其他操作，需要先核对完整方案；新任务和已有任务都尚未保存。');
      const tasks = taskPlanDraft(proposal.arguments);
      const notice = proposal.arguments.capacityAware === true ? await draftCapacityNotice(store,tasks) : '';
      return {calls:calls.flatMap(call=>call===proposal ? tasks.map((task,index)=>({
        id:`${proposal.id}:task:${index}`,name:'create_task',arguments:{...task}
      })):[call]), notes:notice?[notice]:[], confirmationRequested:true};
    } catch (error) {
      return {calls:[],notes:[],error:{callId:proposal.id!,output:error instanceof Error?error.message:'完整安排未能核对，本批尚未保存。'}};
    }
  }
  const batches = calls.filter(call => call.name === TASK_BATCH_TOOL.name);
  if (batches.length !== 1 || calls.length < 2 || calls.some(call => call.name !== TASK_BATCH_TOOL.name && call.name !== "update_tasks")) return;
  const batch = batches[0];
  try {
    const plan = await planTaskBatch(store, batch, now);
    return { calls: calls.flatMap(call => call === batch ? plan.calls : [call]),
      notes: [...plan.existing.map(text => "已有：" + text), ...plan.notes] };
  } catch (error) {
    return { calls: [], notes: [], error: { callId: batch.id!,
      output: error instanceof Error ? error.message : "本批新任务未能核对，已有任务也未修改。" } };
  }
}
