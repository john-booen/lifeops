import type { AiToolCall } from "../ai";
import { recordRevision } from "../operationIdentity";

const fields = ["title", "estimateMin", "category", "dueDate", "dueTime"];
export const BATCH_ITEM_REPAIR = "整批任务字段格式未通过校验，尚未保存。只调用一次schedule_task_batch纠正字段类型或移除工具定义之外的字段。逐字保留任务标题、全部任务及顺序、date和可用边界、已有有效分类、估时和独立截止；数字文字估时只能转为等值整数，不能改变时长。无效分类可省略或按原请求填写合法分类。不得增加、删减、改名、改期或逐条另建。";

/** Repair representation only; a model retry cannot replace the task list. */
export function repairedBatchItems(original: AiToolCall, calls: AiToolCall[]): AiToolCall | undefined {
  if (calls.length !== 1 || calls[0].name !== "schedule_task_batch") return;
  const repaired = calls[0], before = original.arguments.tasks, after = repaired.arguments.tasks;
  const rest = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).filter(([key]) => key !== "tasks"));
  if (recordRevision(rest(original.arguments)) !== recordRevision(rest(repaired.arguments))
    || !Array.isArray(before) || !Array.isArray(after) || before.length !== after.length || !before.length || before.length > 20) return;
  for (let i = 0; i < before.length; i++) {
    const old = before[i], next = after[i];
    if (!old || !next || typeof old !== "object" || typeof next !== "object" || Array.isArray(old) || Array.isArray(next)
      || typeof old.title !== "string" || !old.title.trim() || old.title.length > 1000 || Object.keys(next).some(key => !fields.includes(key))) return;
    const expected: Record<string, unknown> = Object.fromEntries(Object.entries(old).filter(([key]) => fields.includes(key)));
    if (expected.estimateMin !== undefined) {
      if (typeof expected.estimateMin === "string" && /^\d+$/u.test(expected.estimateMin)) expected.estimateMin = Number(expected.estimateMin);
      if (typeof expected.estimateMin !== "number" || !Number.isInteger(expected.estimateMin) || expected.estimateMin < 1 || expected.estimateMin > 720) return;
    }
    if (old.category !== undefined && (typeof old.category !== "string" || old.category === "punishment")) {
      if (next.category !== undefined && (typeof next.category !== "string" || next.category === "punishment")) return;
      delete expected.category;
      if (next.category !== undefined) expected.category = next.category;
    }
    if (recordRevision(expected) !== recordRevision(next)) return;
  }
  return repaired;
}
