import { isSafeOperationId } from "../../operationIdentity";

export interface TaskBatchReceipt { created: number; existing: number }
export function isTaskBatchReceipt(value: unknown): value is TaskBatchReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as TaskBatchReceipt;
  return Object.keys(row).every(key => key === "created" || key === "existing")
    && Number.isSafeInteger(row.created) && row.created >= 0
    && Number.isSafeInteger(row.existing) && row.existing >= 0
    && row.created + row.existing >= 1 && row.created + row.existing <= 20;
}
export function validTaskBatchManifest(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as { version: number; operationId: string; taskBatch: TaskBatchReceipt; taskIds: unknown[] };
  return row.version === 1 && isSafeOperationId(row.operationId) && isTaskBatchReceipt(row.taskBatch)
    && Array.isArray(row.taskIds) && row.taskIds.length === row.taskBatch.created
    && row.taskIds.every(id => typeof id === "string" && Boolean(id.trim()) && id.length <= 200)
    && new Set(row.taskIds).size === row.taskIds.length;
}
