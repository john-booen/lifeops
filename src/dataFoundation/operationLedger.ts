import type { AgentActionSuggestion } from "../types";
import { createHash } from "node:crypto";
import type { GuardedFileChange } from "./factOperation";
import { assertSafeOperationId } from "../operationIdentity";
import type { JsonWriteOptions } from "./jsonDataGuard";

export type OperationStatus = "executing" | "verified" | "failed" | "reverted";
export type OperationTrigger = "user" | "automatic";

export interface OperationFileSnapshot {
  path: string;
  content: string;
  existed: boolean;
}

export type OperationUndoDescriptor =
  | { kind: "restore_guarded_files"; files: GuardedFileChange[] }
  | { kind: "delete_task"; taskId: string }
  | { kind: "restore_task"; task: Record<string, unknown> }
  | { kind: "restore_task_database"; database: Record<string, unknown> }
  | { kind: "delete_habit"; habitId: string }
  | { kind: "restore_habit_database"; database: Record<string, unknown> }
  | { kind: "restore_personal_memory_document"; document: Record<string, unknown> }
  | ({ kind: "restore_file" } & OperationFileSnapshot)
  | { kind: "restore_files"; files: OperationFileSnapshot[] };

export interface OperationResultSnapshot {
  success: boolean;
  output: string;
  actions: AgentActionSuggestion[];
  undo?: OperationUndoDescriptor;
  tradeEdits?: import("../types").AgentWriteReceipt["tradeEdits"];
  /** Local first-party checkpoint, never a Provider result or another task database. */
  jobCheckpoint?: { path: string; beforeHash: string; afterHash: string; document: string;
    jobId: string; planHash: string; stepIndex: number };
}

export interface OperationLedgerRecord {
  operationId: string;
  fingerprint: string;
  toolName: string;
  source: "qwen-omni" | "kimi" | "system";
  trigger?: OperationTrigger;
  status: OperationStatus;
  attempts: number;
  arguments: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  revertedAt?: string;
  result?: OperationResultSnapshot;
  error?: string;
}

export interface OperationLedgerDocument {
  [key: string]: unknown;
  version: 1;
  records: OperationLedgerRecord[];
  /** Content-free tombstones survive the rolling detailed audit window. */
  revertedOperationHashes?: string[];
}

export interface OperationLedgerHost {
  readonly settings: { folders: { aiReports: string } };
  path(...parts: string[]): string;
  readJson<T>(filePath: string, fallback: T): Promise<T>;
  writeJson(filePath: string, value: unknown, options?: JsonWriteOptions): Promise<void>;
}

export interface OperationClaimInput {
  operationId: string;
  toolName: string;
  source: OperationLedgerRecord["source"];
  trigger?: OperationTrigger;
  arguments: Record<string, unknown>;
}

export type OperationClaim =
  | { kind: "execute"; record: OperationLedgerRecord }
  | { kind: "cached"; record: OperationLedgerRecord }
  | { kind: "busy"; record: OperationLedgerRecord }
  | { kind: "collision"; record: OperationLedgerRecord };

const storeLocks = new WeakMap<object, Promise<void>>();
const MAX_OPERATION_RECORDS = 500;
const automaticOperations = new Set([
  "local_checkHabitPunishments", "observe_personal_memory_candidate", "local_capture_learning_note", "local_index_reading", "project_job_metadata"
]);
const legacyUserOperations = new Set([
  "create_task", "reschedule_task", "complete_task", "create_habit", "complete_habit", "miss_habit",
  "append_journal_entry", "append_knowledge_note", "append_trading_model_note", "record_trade", "update_trade",
  "record_learning", "update_learning_unit", "start_quiz", "grade_answer", "set_idea_status", "upsert_idea",
  "set_project_next_step", "project_job_archive", "undo_latest_operation", "external_vault_index", "respond_proactive_candidate",
  "generate_workflow_catalog", "generate_workflow_draft", "generate_memory_review", "generated_period_summary", "generated_createTradingReview",
  "local_createTask", "local_updateTask", "local_updateTaskDetails", "local_deleteTask", "local_completeTask", "local_completeTaskAndLog",
  "local_postponeTask", "local_postponeTasks", "local_skipRepeatedTask", "local_moveTaskToDate", "local_duplicateTaskToDate", "local_moveTaskOrder",
  "local_abandonTask", "local_moveTaskToQuadrant", "local_addJournalPlanTask", "local_createHabit", "local_updateHabit", "local_updateHabitDetails",
  "local_deleteHabit", "local_recordHabit", "local_recordHabitStatus", "local_clearHabitCheckin", "local_acceptPunishments",
  "local_appendHealthEntry", "local_recordClassifiedInput", "local_update_trade", "local_record_trade", "local_trade_review_task",
  "local_register_idea_candidates", "local_ignore_idea_candidate", "local_screen_idea_candidates", "local_set_idea_status",
  "local_openRecordNote", "local_appendCalendarNote", "local_normalize_legacy_journal_layout", "local_update_learning_unit", "local_project_change"
]);

export function operationTrigger(tool: string, args: Record<string, unknown>): OperationTrigger | undefined {
  if (tool.startsWith("scheduled_") || tool.startsWith("migrate_") || automaticOperations.has(tool)) return "automatic";
  if (tool === "append_memory_note") return args.explicit === true ? "user" : "automatic";
  if (tool.startsWith("confirm_") || tool.startsWith("manual_") || legacyUserOperations.has(tool)) return "user";
}

/** Frozen recovery algorithm. A future change needs a new plan kind, because
 * pending ledger-revert-v1 journals must reconstruct exactly the same bytes. */
export function planLedgerRevertV1(document: OperationLedgerDocument, operationId: string, timestamp: string,
  toolReceipt?: { claim: OperationLedgerRecord; result: OperationResultSnapshot }): { record: OperationLedgerRecord; document: OperationLedgerDocument } {
  assertSafeOperationId(operationId);
  if (!document || typeof document !== "object" || Array.isArray(document) || document.version !== 1 || Object.hasOwn(document, "schemaVersion")
    || !Array.isArray(document.records) || document.records.some(row => !row || typeof row !== "object" || Array.isArray(row))
    || (document.revertedOperationHashes !== undefined && (!Array.isArray(document.revertedOperationHashes)
      || document.revertedOperationHashes.some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))))) throw new Error("操作历史格式无法安全读取。");
  if (document.records.filter(record => record.operationId === operationId).length > 1
    || toolReceipt && document.records.filter(record => record.operationId === toolReceipt.claim.operationId).length > 1) throw new Error("操作历史身份不唯一，已停止撤销。");
  const existing = document.records.find(record => record.operationId === operationId);
  if (!existing) throw new Error(`未找到操作记录：${operationId}`);
  if (existing.status !== "verified" || !existing.result?.undo) throw new Error(`操作不可撤销：${operationId}`);
  const own = toolReceipt && document.records.find(record => record.operationId === toolReceipt.claim.operationId);
  if (toolReceipt && (!own || own.operationId === operationId || own.toolName !== "undo_latest_operation"
    || own.status !== "executing" || own.attempts !== toolReceipt.claim.attempts
    || own.createdAt !== toolReceipt.claim.createdAt || own.updatedAt !== toolReceipt.claim.updatedAt
    || own.fingerprint !== toolReceipt.claim.fingerprint || own.source !== toolReceipt.claim.source
    || operationFingerprint(own.toolName, own.arguments) !== own.fingerprint
    || toolReceipt.result.success !== true || typeof toolReceipt.result.output !== "string"
    || !Array.isArray(toolReceipt.result.actions) || toolReceipt.result.actions.length || toolReceipt.result.undo)) {
    throw new Error("撤销工具的执行记录发生变化，已停止本次撤销。");
  }
  const record: OperationLedgerRecord = { ...existing, status: "reverted", updatedAt: timestamp, revertedAt: timestamp };
  const next = updatedLedgerDocumentV1(document, [record, ...(own && toolReceipt
    ? [{ ...own, status: "verified" as const, updatedAt: timestamp, finishedAt: timestamp, result: toolReceipt.result, error: undefined }] : [])]);
  return { record, document: next };
}

function updatedLedgerDocumentV1(document: OperationLedgerDocument, updates: OperationLedgerRecord[]): OperationLedgerDocument {
  const ids = new Set(updates.map(record => record.operationId));
  const records = document.records.filter(item => !ids.has(item.operationId));
  records.push(...updates);
  records.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  return { ...document, version: 1,
    revertedOperationHashes: [...new Set([...(document.revertedOperationHashes ?? []),
      ...document.records.filter(item => item.status === "reverted").map(item => operationIdHash(item.operationId)),
      ...updates.filter(record => record.status === "reverted").map(record => operationIdHash(record.operationId))])],
    records: records.slice(-MAX_OPERATION_RECORDS) };
}

export class OperationLedger {
  readonly filePath: string;

  constructor(private readonly host: OperationLedgerHost, private readonly now: () => Date = () => new Date()) {
    this.filePath = host.path(host.settings.folders.aiReports, "Operations", "operation-ledger.json");
  }

  async claim(input: OperationClaimInput): Promise<OperationClaim> {
    assertSafeOperationId(input.operationId);
    input = { ...input, arguments: JSON.parse(JSON.stringify(input.arguments)) as Record<string, unknown> };
    return this.withLock(async () => {
      const document = await this.readDocument();
      const fingerprint = operationFingerprint(input.toolName, input.arguments);
      if (document.revertedOperationHashes?.includes(operationIdHash(input.operationId))) {
        const timestamp = this.now().toISOString();
        return { kind: "cached", record: { ...input, fingerprint, status: "reverted", attempts: 0, createdAt: timestamp, updatedAt: timestamp,
          result: { success: false, output: "这次操作已经撤销，不会自动重新执行。", actions: [] } } };
      }
      const existing = document.records.find((record) => record.operationId === input.operationId);
      if (existing && (existing.toolName !== input.toolName || stableStringify(existing.arguments) !== stableStringify(input.arguments))) {
        return { kind: "collision", record: existing };
      }
      if (existing?.status === "reverted") {
        return { kind: "cached", record: { ...existing, result: { success: false, output: "这次操作已经撤销，不会自动重新执行。", actions: [] } } };
      }
      if (existing?.status === "verified" && existing.result) {
        return { kind: "cached", record: existing };
      }
      if (existing?.status === "executing") {
        return { kind: "busy", record: existing };
      }

      const timestamp = this.now().toISOString();
      const trigger = existing?.trigger ?? input.trigger ?? operationTrigger(input.toolName, input.arguments);
      const record: OperationLedgerRecord = {
        operationId: input.operationId,
        fingerprint,
        toolName: input.toolName,
        source: input.source,
        ...(trigger ? { trigger } : {}),
        status: "executing",
        attempts: (existing?.attempts ?? 0) + 1,
        arguments: input.arguments,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      };
      await this.writeRecord(document, record);
      return { kind: "execute", record };
    });
  }

  async verify(operationId: string, result: OperationResultSnapshot): Promise<OperationLedgerRecord> {
    return this.finish(operationId, "verified", result);
  }

  async fail(operationId: string, error: string, result?: OperationResultSnapshot): Promise<OperationLedgerRecord> {
    return this.finish(operationId, "failed", result, error);
  }

  /** A late failure must not replace a newer claim or an already settled result. */
  async failClaim(claim: OperationLedgerRecord, error: string, result?: OperationResultSnapshot): Promise<boolean> {
    assertSafeOperationId(claim.operationId);
    return this.withLock(async () => {
      const document = await this.readDocument();
      const current = document.records.find(record => record.operationId === claim.operationId);
      if (!current || current.status !== "executing" || current.attempts !== claim.attempts
        || current.updatedAt !== claim.updatedAt || current.createdAt !== claim.createdAt
        || current.fingerprint !== claim.fingerprint || current.source !== claim.source
        || current.toolName !== claim.toolName) return false;
      const timestamp = this.now().toISOString();
      await this.writeRecord(document, { ...current, status: "failed", updatedAt: timestamp, finishedAt: timestamp, result, error });
      return true;
    });
  }

  async latestReversible(memoryOnly = false): Promise<OperationLedgerRecord | null> {
    const document = await this.readDocument();
    for (const record of [...document.records].reverse()) {
      if (record.status !== "verified" || !record.result?.undo) continue;
      if (memoryOnly) {
        if (record.toolName === "append_memory_note" || record.toolName === "observe_personal_memory_candidate") return record;
        continue;
      }
      const trigger = record.trigger ?? operationTrigger(record.toolName, record.arguments);
      if (trigger === "automatic") continue;
      return trigger === "user" ? record : null;
    }
    return null;
  }

  async readSettledOperations(operationIds: readonly string[]): Promise<{
    reverted: Set<string>;
    verified: Map<string, { toolName: string; output: string }>;
  }> {
    const document = await this.readDocument();
    const hashes = new Set(document.revertedOperationHashes ?? []);
    const requested = new Set(operationIds);
    const reverted = new Set(operationIds.filter(id => hashes.has(operationIdHash(id))));
    const verified = new Map<string, { toolName: string; output: string }>();
    for (const { operationId, toolName, status, result } of document.records) {
      if (!requested.has(operationId)) continue;
      if (status === "reverted") reverted.add(operationId);
      if (status === "verified" && result?.success && result.undo) verified.set(operationId, { toolName, output: result.output });
    }
    return { reverted, verified };
  }

  async revert(
    operationId: string,
    executeUndo: (descriptor: OperationUndoDescriptor, plannedLedger: OperationLedgerDocument) => Promise<void>,
    toolReceipt?: { claim: OperationLedgerRecord; result: OperationResultSnapshot }
  ): Promise<OperationLedgerRecord> {
    assertSafeOperationId(operationId);
    return this.withLock(async () => {
      const document = await this.readDocument();
      const existing = document.records.find((record) => record.operationId === operationId);
      if (!existing) throw new Error(`未找到操作记录：${operationId}`);
      if (existing.status === "reverted") {
        if (toolReceipt) throw new Error("这次操作已经撤销，请重新核对最近的记录。");
        return existing;
      }
      if (existing.status !== "verified" || !existing.result?.undo) {
        throw new Error(`操作不可撤销：${operationId}`);
      }
      const timestamp = this.now().toISOString();
      const plan = planLedgerRevertV1(document, operationId, timestamp, toolReceipt);
      // Both audit transitions are one native JSON write. A crash cannot leave
      // a reverted original paired with an unfinished new undo tool receipt.
      await executeUndo(existing.result.undo, plan.document);
      await this.host.writeJson(this.filePath, plan.document, { compact: true });
      return plan.record;
    });
  }

  private async finish(
    operationId: string,
    status: Extract<OperationStatus, "verified" | "failed">,
    result?: OperationResultSnapshot,
    error?: string
  ): Promise<OperationLedgerRecord> {
    assertSafeOperationId(operationId);
    return this.withLock(async () => {
      const document = await this.readDocument();
      const existing = document.records.find((record) => record.operationId === operationId);
      if (!existing) {
        throw new Error(`未找到操作记录：${operationId}`);
      }
      const timestamp = this.now().toISOString();
      const record: OperationLedgerRecord = {
        ...existing,
        status,
        updatedAt: timestamp,
        finishedAt: timestamp,
        result,
        error
      };
      await this.writeRecord(document, record);
      return record;
    });
  }

  private async readDocument(): Promise<OperationLedgerDocument> {
    const document = await this.host.readJson<OperationLedgerDocument>(this.filePath, {
      version: 1,
      records: []
    });
    return {
      ...document,
      version: 1,
      records: Array.isArray(document.records) ? document.records : []
    };
  }

  private async writeRecord(document: OperationLedgerDocument, record: OperationLedgerRecord): Promise<void> {
    await this.writeRecords(document, [record]);
  }

  private async writeRecords(document: OperationLedgerDocument, updates: OperationLedgerRecord[]): Promise<void> {
    await this.host.writeJson(this.filePath, this.updatedDocument(document, updates), { compact: true });
  }

  private updatedDocument(document: OperationLedgerDocument, updates: OperationLedgerRecord[]): OperationLedgerDocument {
    return updatedLedgerDocumentV1(document, updates);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.host as object;
    const previous = storeLocks.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    storeLocks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (storeLocks.get(key) === queued) {
        storeLocks.delete(key);
      }
    }
  }
}

function operationIdHash(operationId: string): string { return createHash("sha256").update(operationId, "utf8").digest("hex"); }

export function operationFingerprint(toolName: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(`${toolName}:${stableStringify(args)}`, "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
