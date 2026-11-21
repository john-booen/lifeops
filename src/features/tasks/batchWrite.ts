import { createHash } from "node:crypto";
import type { LifeOpsToolDefinition, ToolExecutionContext, ToolExecutionRequest, ToolExecutionResult } from "../../toolRegistry";
import { isGuardedOperationScope } from "../../dataFoundation/factOperation";
import { planTaskBatch } from "../../agent/taskBatch";
import type { StoreHost } from "../../store/settingsSlice";
import { isVaultPathExcluded } from "../../privacy";
import { recordRevision } from "../../operationIdentity";

export function taskBatchManifestPath(store: StoreHost, operationId: string): string {
  return store.path(store.settings.folders.aiReports, "System", "TaskBatches",
    createHash("sha256").update(operationId).digest("hex") + ".json");
}

export function taskBatchWriteGuard(store: StoreHost, operationId: string): () => void {
  const policy = () => recordRevision({ folders: store.settings.folders, excluded: store.settings.privacy?.excludedVaultPrefixes ?? [] });
  const baseline = policy();
  const paths = [store.taskDbPath(), store.taskMirrorPath(), taskBatchManifestPath(store, operationId)];
  return () => {
    if (policy() !== baseline || paths.some(path => isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes))) {
      throw Error("任务或整批回执目录的权限已变化，本批保存已停止。");
    }
  };
}

/** One inbox input is one WAL transaction, including its durable, reversible receipt marker. */
export async function saveTaskBatch(args: Record<string, unknown>, context: ToolExecutionContext,
  request: ToolExecutionRequest, createTask: LifeOpsToolDefinition["execute"]): Promise<ToolExecutionResult> {
  if (!isGuardedOperationScope(context.store)) throw Error("整批保存需要受保护的任务库，本批没有执行。");
  const plan = await planTaskBatch(context.store, { id: request.operationId, name: "schedule_task_batch", arguments: args },
    new Date(), { retainPastDate: true });
  const path = taskBatchManifestPath(context.store, request.operationId);
  if (context.store.getFile(path)) throw Error("本条整批回执已存在，请核对最近操作，本次没有重复执行。");
  const saved: string[] = [], taskIds: string[] = [];
  for (const call of plan.calls) {
    request.signal?.throwIfAborted(); request.assertCurrent?.();
    const result = await createTask(call.arguments, context, { ...request, operationId: call.id! });
    if (!result.success || result.actions.length) throw Error(result.output || "本批保存未完成。");
    const rows = (await context.store.readTaskDb()).tasks.filter(task => task.source === `lifeops-agent-tool:${call.id}`);
    if (rows.length !== 1) throw Error("本批任务的保存身份无法核对，已停止。");
    taskIds.push(rows[0].id); saved.push(result.output);
  }
  const taskBatch = { created: taskIds.length, existing: plan.existing.length };
  // Also record all-existing/no-new cases so a lost inbox receipt can be recovered without another model call.
  await context.store.writeJson(path, { version: 1, operationId: request.operationId, taskBatch, taskIds });
  const output = [`本批实际保存${saved.length}项新任务，沿用${plan.existing.length}项已有任务。`,
    ...plan.notes, "撤销本条会撤回本批新建任务，其他已有任务保留。",
    ...saved, ...plan.existing.map(text => `已有：${text}`)].join("\n");
  return { success: true, output, actions: [], taskBatch };
}
