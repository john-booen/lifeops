import { createHash } from "node:crypto";
import { planLedgerRevertV1, type OperationLedgerDocument, type OperationLedgerRecord, type OperationResultSnapshot } from "./operationLedger";
import { MAX_RECOVERY_BYTES, RecoveryCapacityError } from "./recoveryEncoding";

/** One exact base, no expanded after image retained in the recovery document. */
export interface LedgerUndoRecovery {
  kind: "ledger-revert-v1";
  path: string;
  before: string;
  beforeHash: string;
  afterHash: string;
  timestamp: string;
  toolResult?: OperationResultSnapshot;
}
interface UndoIdentity { operationId: string; auditId?: string; auditStatus?: string; purpose?: string; undoToolOperationId?: string; undoToolClaim?: OperationLedgerRecord }
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function refuse(): never { throw new Error("撤销恢复计划无法安全核验，已停止覆盖并保留原记录。"); }

export function ledgerUndoAfter(delta: LedgerUndoRecovery, identity: UndoIdentity): string {
  if (!delta || delta.kind !== "ledger-revert-v1"
    || Object.keys(delta).some(k => !["kind", "path", "before", "beforeHash", "afterHash", "timestamp", "toolResult"].includes(k))
    || typeof delta.path !== "string" || typeof delta.before !== "string"
    || !/^[a-f0-9]{64}$/.test(delta.beforeHash) || !/^[a-f0-9]{64}$/.test(delta.afterHash)
    || hash(delta.before) !== delta.beforeHash
    || identity.purpose === "derived" || identity.auditStatus !== "reverted" || !identity.auditId
    || identity.operationId !== `undo:${identity.auditId}`
    || typeof delta.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(delta.timestamp)) refuse();
  try {
    if (Buffer.byteLength(delta.before, "utf8") + Buffer.byteLength(JSON.stringify(delta.toolResult ?? {}), "utf8") > MAX_RECOVERY_BYTES) throw new RecoveryCapacityError();
    if (new Date(delta.timestamp).toISOString() !== delta.timestamp) refuse();
    if (identity.undoToolOperationId ? !identity.undoToolClaim || identity.undoToolClaim.operationId !== identity.undoToolOperationId || !delta.toolResult : delta.toolResult !== undefined) refuse();
    const document = JSON.parse(delta.before) as OperationLedgerDocument;
    const plan = planLedgerRevertV1(document, identity.auditId, delta.timestamp,
      identity.undoToolOperationId && identity.undoToolClaim && delta.toolResult
        ? { claim: identity.undoToolClaim, result: delta.toolResult } : undefined);
    const after = `${JSON.stringify(plan.document)}\n`;
    if (Buffer.byteLength(after, "utf8") > MAX_RECOVERY_BYTES) throw new RecoveryCapacityError();
    if (hash(after) !== delta.afterHash) refuse();
    return after;
  } catch (error) { if (error instanceof RecoveryCapacityError) throw error; refuse(); }
}
