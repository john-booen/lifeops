import type { AiToolCall } from "../ai";
import { readContextTasks } from "../contextData";
import type { StoreHost } from "../store/settingsSlice";
import { taskNamedInRequest } from "../taskReference";
import { resolveTaskByReference } from "../toolRegistry";
import type { AgentConversationMessage } from "../types";

const EXISTING_TASK_WRITES = new Set(["reschedule_task", "update_tasks", "complete_task", "delete_task"]);

/** A subsequent lookup (including the destination day's tasks) cannot enlarge
 * the subjects already named in the user's original conversation. This is an
 * upper bound, never an execution or confirmation grant. */
export async function taskSubjectConflict(store: StoreHost, calls: readonly AiToolCall[], message: string,
  history: readonly AgentConversationMessage[]): Promise<string | undefined> {
  const edits = calls.filter(call => EXISTING_TASK_WRITES.has(call.name));
  if (!edits.length || !history.length) return;
  const data = await readContextTasks(store);
  if (!data.available) return "任务资料暂不可核对，本批尚未修改。";
  const current = data.tasks.filter(task => taskNamedInRequest(task, message));
  const prior = data.tasks.filter(task => history.some(entry => taskNamedInRequest(task, entry.content)));
  if (!prior.length) return;
  const candidates = new Set([...prior, ...current].map(task => task.id));
  for (const call of edits) {
    const refs = call.name === "update_tasks" && Array.isArray(call.arguments.updates)
      ? call.arguments.updates.map(row => row && typeof row === "object" ? row.taskIdOrTitle : undefined)
      : [call.arguments.taskIdOrTitle];
    for (const ref of refs) {
      // Invalid/ambiguous references remain the original executor's job.
      if (typeof ref !== "string" || !ref.trim()) continue;
      const resolution = await resolveTaskByReference(store, ref, true);
      const task = resolution.kind === "match" ? resolution.item : undefined;
      if (!task || candidates.has(task.id)) continue;
      return "本批尚未修改：拟修改的任务不在原对话指明的对象中，不能把目标日期查询出的其他任务当成原对象。"
        + "请回到用户原始要求，保留被打断前的整组范围，按这些原对话候选核对后一次提交；含义仍不清楚时只集中问清对象。"
        + "候选仅是范围，不代表已授权修改：" + JSON.stringify(data.tasks.filter(row => candidates.has(row.id))
          .map(({ id, title, date }) => ({ id, title, date })));
    }
  }
}
