import type { AiToolDefinition } from "../../ai";
import type { ToolExecutionContext, ToolExecutionRequest, ToolExecutionResult } from "../../toolRegistry";
import type { LifeOpsTask } from "../../types";
import type { StoreHost } from "../../store/settingsSlice";
import { recordRevision } from "../../operationIdentity";
import { isVaultPathExcluded } from "../../privacy";
import { taskScheduleLabel } from "../../taskSchedule";
import { TASK_PLAN_FIELDS, taskPlanUpdate } from "./scheduleUpdate";

export const UPDATE_TASKS_TOOL: AiToolDefinition = {
  name: "update_tasks",
  description: "修改已有任务标题、备注或完整时段，全部放入updates。超过三条只生成统一确认卡，用户要整批预览也调用。准确唯一完整标题可直接用。保留编号、未指定字段和完成状态，不删除重建。",
  parameters: { type: "object", additionalProperties: false, properties: {
    updates: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: false,
      properties: { taskIdOrTitle: { type: "string" }, title: { type: "string", description: "更正后的完整标题；未要求改名时省略。" },
        note: { type: "string", description: "新的完整备注；仅明确要求改备注时填写，空串表示清空。" },
        date: { type: "string", description: "新的安排日期；未要求则省略。" },
        endDate: { type: "string", description: "跨天结束日期；空串清除，省略保留。" },
        scheduleMode: { type: "string", enum: ["fixed", "window"], description: "window期间分次完成；fixed固定时段；省略保留。" },
        startTime: { type: "string", description: "计划开始HH:mm；空串清除，省略保留。" },
        endTime: { type: "string", description: "计划结束HH:mm；空串清除，省略保留。" },
        time: { type: "string", description: "无区间任务的单点HH:mm，省略保留。" } }, required: ["taskIdOrTitle"] } }
  }, required: ["updates"] }
};
type Resolution = { kind: "match"; item: LifeOpsTask } | { kind: "ambiguous"; candidates: LifeOpsTask[] } | { kind: "not_found" };
type Resolve = (store: StoreHost, ref: string, readOnly: boolean) => Promise<Resolution>;

export function taskContentWriteGuard(store: StoreHost): () => void {
  const policy = () => recordRevision([store.settings.folders, store.settings.privacy?.excludedVaultPrefixes ?? []]);
  const baseline = policy(), paths = [store.taskDbPath(), store.taskMirrorPath()];
  return () => {
    if (policy() !== baseline || paths.some(path => isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes))) {
      throw Error("任务内容修改的目录或权限已变化，本次已停止。");
    }
  };
}

export async function updateTaskContents(args: Record<string, unknown>, context: ToolExecutionContext,
  request: ToolExecutionRequest, resolve: Resolve): Promise<ToolExecutionResult> {
  if (!(await import("../../dataFoundation/factOperation")).isGuardedOperationScope(context.store)) {
    throw Error("任务内容修改需要受保护的任务库，本次未执行。");
  }
  if (Object.keys(args).some(key => key !== "updates") || !Array.isArray(args.updates)
    || !args.updates.length || args.updates.length > 20) throw Error("请提供一至二十条明确的任务内容修改。");
  if (args.updates.length > 3 && !request.confirmedByUser) throw Error("超过三条的内容修改需要先核对确认卡，本次未修改。");
  const excluded = context.store.settings.privacy?.excludedVaultPrefixes;
  if (isVaultPathExcluded(context.store.taskDbPath(), excluded)) throw Error("任务库已排除，本次未修改。");
  const changes: Array<{ before: LifeOpsTask; next: LifeOpsTask; plan: boolean }> = [];
  const seen = new Set<string>();
  for (const value of args.updates) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("任务修改内容格式需要核对。");
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(key => !["taskIdOrTitle", "title", "note", "expectedRevision", ...TASK_PLAN_FIELDS].includes(key))
      || typeof row.taskIdOrTitle !== "string" || !row.taskIdOrTitle.trim()
      || row.title === undefined && row.note === undefined && !TASK_PLAN_FIELDS.some(key => row[key] !== undefined)
      || row.title !== undefined && (typeof row.title !== "string" || !row.title.trim() || row.title.length > 1000 || /[\r\n]/u.test(row.title))
      || row.note !== undefined && (typeof row.note !== "string" || row.note.length > 20_000)) throw Error("请核对任务对象、新标题或备注，本次未修改。");
    const found = await resolve(context.store, row.taskIdOrTitle, true);
    if (found.kind !== "match") throw Error("未找到唯一的原任务，请提供准确旧标题或编号；本次未修改。");
    const before = found.item;
    if (row.expectedRevision !== undefined && row.expectedRevision !== recordRevision(before)) {
      throw Error("任务已在计划展示后发生变化，这份计划已过期，请重新核对；本次整批未修改。");
    }
    if (seen.has(before.id)) throw Error("同一条任务出现了两次修改，请合并后再试。");
    seen.add(before.id);
    if (before.sourceNotePath && isVaultPathExcluded(before.sourceNotePath, excluded)) throw Error("任务来源已排除，本次未修改。");
    const patch = taskPlanUpdate(before, row);
    changes.push({ before, plan: Object.keys(patch).length > 0, next: { ...before, ...patch,
      title: row.title === undefined ? before.title : (row.title as string).trim(),
      note: row.note === undefined ? before.note : row.note as string } });
  }
  const taskEdits: NonNullable<import("../../types").AgentWriteReceipt["taskEdits"]> = [];
  const outputs: string[] = [];
  for (const { before, next, plan } of changes) {
    const { title, note } = next;
    if (recordRevision(next) === recordRevision(before)) { outputs.push(`「${title}」修改已一致，未重复保存。`); continue; }
    request.signal?.throwIfAborted(); request.assertCurrent?.();
    await context.store.updateTask(before.id, current => {
      if (recordRevision(current) !== recordRevision(before)) throw Error("任务刚被修改，请核对最新内容后重试。");
      return next;
    });
    const verified = await context.store.getTask(before.id);
    const { updatedAt: _oldTime, ...expected } = next;
    const { updatedAt: _newTime, ...actual } = verified;
    if (recordRevision(actual) !== recordRevision(expected)) throw Error("任务内容修改后核对未通过。");
    taskEdits.push({ id: before.id, beforeTitle: before.title, title });
    const schedule = [verified.date, taskScheduleLabel(verified)].filter(Boolean).join(" ");
    if (plan) outputs.push(`已更新「${title}」：${[before.date, taskScheduleLabel(before)].filter(Boolean).join(" ") || "未排时间"} → ${schedule || "未排时间"}。编号${before.id}；完成状态保留。`);
    else outputs.push(`已更新「${before.title}」→「${title}」${note !== before.note ? "，备注已更新" : ""}。编号${before.id}${schedule ? `；原安排${schedule}` : ""}；完成状态保留。`);
  }
  await context.refreshViews();
  return { success: true, output: [`本次实际更新${taskEdits.length}项任务。`, ...outputs].join("\n"), actions: [], taskEdits };
}
