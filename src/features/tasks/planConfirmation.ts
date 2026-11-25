import type { ToolCallResult } from "../../agentRuntime";
import { readContextTasks } from "../../contextData";
import { recordRevision } from "../../operationIdentity";
import type { StoreHost } from "../../store/settingsSlice";
import { taskScheduleLabel, taskScheduleMode } from "../../taskSchedule";
import { TASK_SCHEDULE_FIELDS, taskPlanUpdate } from "./scheduleUpdate";
import { taskDeadlineLabel } from "./deadlineInput";

/** Freeze the exact existing records shown in a batch's confirmation preview. */
export async function bindTaskPlanConfirmation(store: StoreHost, batch: ToolCallResult): Promise<void> {
  const action = batch.actions[0], calls = action?.toolBatch;
  if (action?.type !== "tool_batch" || !calls?.some(call => call.name === "update_tasks")) return;
  try {
    const { tasks } = await readContextTasks(store), frozen = structuredClone(calls), preview: string[] = [];
    for (const call of frozen) {
      if (call.name !== "update_tasks") {
        preview.push(call.name === "create_task" ? `新建「${String(call.arguments.title ?? "")}」${call.arguments.date ? `，${call.arguments.date}` : ""}`
          : `另含一项操作：${call.name}（${JSON.stringify(call.arguments)}）`);
        continue;
      }
      if (!Array.isArray(call.arguments.updates)) throw Error("计划修改清单无效，请重新准备。");
      for (const row of call.arguments.updates) {
        if (!row || typeof row !== "object" || Array.isArray(row)) throw Error("计划修改格式需要核对。");
        const matches = tasks.filter(task => task.id === row.taskIdOrTitle || task.title === row.taskIdOrTitle);
        if (matches.length !== 1) throw Error("计划中有任务无法唯一定位，请先核对标题；原安排保留。");
        const before = matches[0];
        // A repeated old title/note is preservation, not a requested edit.
        for (const key of ["title", "note"] as const) if (Object.prototype.hasOwnProperty.call(row, key)
          && Object.is(before[key], row[key])) delete row[key];
        const next = { ...before, ...taskPlanUpdate(before, row) };
        // A model may echo list_tasks' derived mode even though the user only
        // changed clocks. Preserve the original metadata unless the mode is
        // different or is needed to keep that meaning under the new dates.
        if (row.scheduleMode !== undefined && row.scheduleMode === taskScheduleMode(before)
          && taskScheduleMode({ ...next, scheduleMode: before.scheduleMode }) === row.scheduleMode) delete row.scheduleMode;
        row.taskIdOrTitle = before.id; row.expectedRevision = recordRevision(before);
        const oldPlan = [before.date, taskScheduleLabel(before)].filter(Boolean).join(" ") || "未排时间";
        const newPlan = [next.date, taskScheduleLabel(next)].filter(Boolean).join(" ") || "未排时间";
        const plan = TASK_SCHEDULE_FIELDS.some(key => row[key] !== undefined) ? `：${oldPlan} → ${newPlan}` : "";
        const deadline = row.dueDate !== undefined || row.dueTime !== undefined ? `；${taskDeadlineLabel(before) || "未另设必须截止"} → ${taskDeadlineLabel(next) || "清除必须截止"}` : "";
        preview.push(`「${before.title}」${plan}${deadline}${row.title !== undefined ? `；新标题「${row.title}」` : ""}${row.note !== undefined ? `；新备注：${row.note}` : ""}`);
      }
    }
    action.toolBatch = frozen; action.id = `proposal:batch:${recordRevision(frozen)}`; batch.callId = action.id;
    action.content = preview.map((line, index) => `${index + 1}. ${line}`).join("\n");
    action.description = "核对整份调整后，点击确认；只有这一份相邻计划时也可回复“确认”或“确定”。记录变化后旧计划不执行。";
  } catch (error) {
    batch.success = false; batch.actions = [];
    batch.output = error instanceof Error ? error.message : "这份计划未能核对，原安排保留。";
  }
}
