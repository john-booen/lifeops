import type { AiToolCall } from "../ai";
import type { StoreHost } from "../store/settingsSlice";
import { planTaskBatch, TASK_BATCH_TOOL } from "./taskBatch";

/** Expand a structured new-task batch alongside edits before the common confirmation gate. */
export async function expandMixedTaskBatch(store: StoreHost, calls: AiToolCall[], now: Date): Promise<{
  calls: AiToolCall[]; notes: string[]; error?: { callId: string; output: string };
} | undefined> {
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
