import type { App } from "obsidian";
import { activeFactOperation, factRecoveryPath, inspectFactRecovery, recoverFactOperation } from "../../dataFoundation/factOperation";
import { jsonDataContract, parseJsonData } from "../../dataFoundation/jsonDataGuard";
import { operationFingerprint, type OperationLedgerDocument, type OperationLedgerRecord } from "../../dataFoundation/operationLedger";
import { MAX_LEDGER_RECOVERY_BYTES, MAX_RECOVERY_BYTES } from "../../dataFoundation/recoveryEncoding";
import { readBoundedVaultFile } from "../../legacyMemoryReview";
import { recordRevision } from "../../operationIdentity";
import { LifeOpsStore } from "../../store";
import type { StoreHost } from "../../store/settingsSlice";
import type { LifeOpsSettings } from "../../types";
import { DEVICE_SETUP_OPERATION, DEVICE_WORKSPACE_PATH } from "./execution";
import { deviceLayout, isDeviceConfigurationWrite, parseDeviceWorkspaceFile } from "./workspace";

/** Explicit local setup only. This reader never grants general fact-writing rights. */
export async function recoverInitialDeviceSetup(app: App, settings: LifeOpsSettings, deviceId: string,
  assertCurrent: () => void): Promise<void> {
  const reader = new LifeOpsStore(app, settings) as unknown as StoreHost;
  const layout = recordRevision(deviceLayout(settings));
  const invalid: () => never = () => { throw Error("上次保存需要核对，请保留当前资料；这次没有接管或恢复其他记录。"); };
  const current = () => {
    assertCurrent();
    if (activeFactOperation(reader) || layout !== recordRevision(deviceLayout(settings))) invalid();
  };
  const read = async (path: string, maximum: number): Promise<string | null> => {
    current();
    const result = await readBoundedVaultFile(reader, path, maximum);
    current();
    if (!("raw" in result)) invalid();
    return result.raw;
  };
  const journalPath = factRecoveryPath(reader), raw = await read(journalPath, MAX_RECOVERY_BYTES);
  if (raw === null) return;
  const journal = inspectFactRecovery(reader, raw);
  if (journal.status !== "pending") return;
  if (!isDeviceConfigurationWrite(DEVICE_WORKSPACE_PATH, journal.operationId)
    || (journal.auditId ?? journal.operationId) !== journal.operationId || (journal.auditStatus ?? "verified") !== "verified" || journal.purpose === "derived"
    || journal.ledgerUndo || journal.undoToolOperationId || journal.entries.length !== 1) invalid();
  const entry = journal.entries[0];
  if (entry.path !== DEVICE_WORKSPACE_PATH || entry.before !== null || entry.after === null
    || entry.previous != null) invalid();
  const intent = parseDeviceWorkspaceFile(JSON.parse(entry.after));
  if (intent.executionDeviceId !== deviceId || recordRevision(intent.layout) !== layout) invalid();
  const ledgerPath = reader.path(settings.folders.aiReports, "Operations", "operation-ledger.json");
  const ownedClaim = async (): Promise<OperationLedgerRecord> => {
    const ledgerRaw = await read(ledgerPath, MAX_LEDGER_RECOVERY_BYTES);
    if (ledgerRaw === null) invalid();
    const document = parseJsonData(ledgerRaw, ledgerPath, jsonDataContract(ledgerPath, settings.folders)) as OperationLedgerDocument;
    const claims = document.records.filter(row => row?.operationId === journal.operationId);
    if (claims.length !== 1) invalid();
    const claim = claims[0], args = claim.arguments;
    if (claim.source !== "system" || claim.toolName !== DEVICE_SETUP_OPERATION || claim.trigger !== "automatic"
      || !["executing", "verified", "failed"].includes(claim.status) || !args || Array.isArray(args)
      || Object.keys(args).length !== 2 || args.workspaceId !== intent.workspaceId || args.executionDeviceId !== deviceId
      || claim.fingerprint !== operationFingerprint(DEVICE_SETUP_OPERATION, args)) invalid();
    if (claim.status === "verified") {
      const undo = claim.result?.undo;
      if (claim.result?.success !== true || undo?.kind !== "restore_guarded_files" || undo.files.length !== 1
        || undo.files[0].path !== entry.path || undo.files[0].before !== null || undo.files[0].after !== entry.after) invalid();
    }
    return claim;
  };
  const initialClaim = await ownedClaim();
  const beforeWrite = async () => {
    const claim = await ownedClaim();
    if (claim.status !== initialClaim.status && !(initialClaim.status === "executing" && claim.status === "failed")) invalid();
    const policyRaw = await read(DEVICE_WORKSPACE_PATH, 16_000);
    if (policyRaw !== null && policyRaw !== entry.after
      || claim.status === "verified" && !journal.rollbackRequired && policyRaw !== entry.after) invalid();
    current();
  };
  await beforeWrite();
  await recoverFactOperation(reader, { expectedRaw: raw, assertCurrent: current, assertBeforeRecoveryWrite: beforeWrite });
  current();
}
