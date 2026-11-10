import { createHash, randomUUID } from "node:crypto";
import type { AiToolCall } from "./ai";

export function fileRevision(text: string | null): string {
  return text === null ? "absent" : createHash("sha256").update(text, "utf8").digest("hex");
}

export const MAX_TOOL_CALL_ID_LENGTH = 256;
// First-party inputs need room for proposal/confirmed prefixes. Persisted keys
// additionally reserve space for memory revision and undo suffixes/prefixes.
export const MAX_OPERATION_INPUT_ID_LENGTH = 384;
// A proposal adds its prefix plus a decimal array index (at most 10 digits).
export const MAX_CONFIRMATION_ACTION_ID_LENGTH = MAX_OPERATION_INPUT_ID_LENGTH + "proposal:".length + 1 + 10;
export const MAX_CONFIRMED_OPERATION_ID_LENGTH = MAX_CONFIRMATION_ACTION_ID_LENGTH + "confirmed:".length;
export const MAX_STORED_OPERATION_ID_LENGTH = 512;
export const INVALID_OPERATION_ID_MESSAGE = "操作标识无效，已停止执行。";

export function isSafeOperationId(value: unknown, maxLength = MAX_STORED_OPERATION_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && !/[\s\p{Cc}\p{Cf}<>]/u.test(value);
}

export function assertSafeOperationId(value: unknown, maxLength = MAX_STORED_OPERATION_ID_LENGTH): asserts value is string {
  // Never echo untrusted bytes into a user reply, report, or diagnostic.
  if (!isSafeOperationId(value, maxLength)) throw new Error(INVALID_OPERATION_ID_MESSAGE);
}

export function isSafeRuntimeOperationId(value: unknown): value is string {
  return isSafeOperationId(value, MAX_OPERATION_INPUT_ID_LENGTH)
    || isSafeOperationId(value, MAX_CONFIRMED_OPERATION_ID_LENGTH) && value.startsWith("confirmed:");
}

// An ID belongs to one call, not to its wording or its position in a response.
// Preserve it on the call object so execution retries and result messages agree.
export function ensureToolCallId(call: AiToolCall): string {
  if (call.id == null) call.id = `lifeops-tool:${randomUUID()}`;
  assertSafeOperationId(call.id, MAX_TOOL_CALL_ID_LENGTH);
  return call.id;
}

export function newLocalOperationId(kind: string): string {
  const id = `local:${kind}:${randomUUID()}`;
  assertSafeOperationId(id, MAX_OPERATION_INPUT_ID_LENGTH);
  return id;
}

export function recordRevision(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)])) : item;
  return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

export function assertRecordRevision(value: unknown, expected?: string): void {
  if (expected && (!value || recordRevision(value) !== expected)) {
    throw new Error("这条记录在打开表单后发生了变化，已保留后来修改的内容。请重新打开编辑表单。");
  }
}
