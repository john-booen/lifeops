import { isDeviceConfigurationWrite, isDeviceInputWrite } from "../features/devices/workspace";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { App, TFile, Vault } from "obsidian";
import type { StoreHost } from "../store/settingsSlice";
import { OperationLedger, operationFingerprint, type OperationUndoDescriptor, type OperationLedgerDocument, type OperationLedgerRecord } from "./operationLedger";
import { jsonDataContract, parseJsonData, serializeJsonData } from "./jsonDataGuard";
import { assertSafeOperationId, fileRevision, UndoRecoveryRequiredError } from "../operationIdentity";
import { decodeFactRecovery, encodeFactRecovery, MAX_RECOVERY_BYTES, RecoveryCapacityError } from "./recoveryEncoding";
import { ledgerUndoAfter, type LedgerUndoRecovery } from "./ledgerUndoRecovery";
import { signalDateFromDocumentPath } from "../features/journal/signals";
import { journalDateFromPath } from "../journalResolver";

export interface GuardedFileChange {
  path: string;
  before: string | null;
  after: string | null;
  beforeHash: string;
  afterHash: string;
  previous?: string | null;
  previousHash?: string;
  retained?: Array<{ path: string; expectedHash: string }>;
}
export interface FactOperationIdentity {
  operationId: string;
  purpose?: "fact" | "derived";
  auditId?: string;
  auditStatus?: "verified" | "reverted";
  /** Internal undo tool audit, never a model argument or a user undo descriptor. */
  undoToolOperationId?: string;
}
export interface FactOperationOptions {
  assertCurrent?: () => void;
  /** Async protected-source checks run while commit ownership is still held. */
  assertBeforeCommit?: () => Promise<void>;
  /** Called synchronously only after facts, audit and recovery journal settle. */
  onCommitted?: (evidence?: {journalCommitted:boolean}) => void;
}
export interface RecoveryDocument extends FactOperationIdentity {
  version: 1;
  status: "pending" | "committed" | "rolled_back";
  entries: GuardedFileChange[];
  rollbackRequired?: boolean;
  undoToolClaim?: OperationLedgerRecord;
  /** Durable rollback completion precedes releasing the exact temporary claim. */
  rollbackComplete?: boolean;
  /** Exact ledger base plus a frozen deterministic transition. */
  ledgerUndo?: LedgerUndoRecovery;
}
type SharedFactState = { locks: WeakMap<object, Promise<unknown>>; activeWrites: WeakMap<object, FactOperationIdentity> };
const sharedKey = Symbol.for("lifeops.fact-operation-state.v1");
const sharedGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown };
const previousState = sharedGlobal[sharedKey] as SharedFactState | undefined;
const sharedState: SharedFactState = previousState?.locks instanceof WeakMap && previousState.activeWrites instanceof WeakMap
  ? previousState : { locks: new WeakMap(), activeWrites: new WeakMap() };
sharedGlobal[sharedKey] = sharedState;
const { locks, activeWrites } = sharedState;
const scopes = new WeakSet<object>();
const scopeIdentities = new WeakMap<object, FactOperationIdentity>();
const scopeOwners = new WeakMap<object, StoreHost>();
const scopeDocuments = new WeakMap<object, RecoveryDocument>();
const scopeReads = new WeakMap<object, Map<string, string | null>>();
export class UndoCapacityError extends Error {
  constructor() {
    super("操作历史超过本次安全撤销容量，记录没有修改，仍可保存新内容；需要检查历史容量后再撤销。");
    this.name = "UndoCapacityError";
  }
}
// The durable journal may already say committed while a final async source
// guard can still reject. Keep public readers behind that in-process boundary.
export function activeFactOperation(store: StoreHost): FactOperationIdentity | undefined {
  const active = activeWrites.get((scopeOwners.get(store) ?? store).app.vault);
  return active ? { ...active } : undefined;
}
export function isGuardedOperationScope(store: StoreHost): boolean { return scopes.has(store); }
export function guardedOperationIdentity(store: StoreHost): FactOperationIdentity | undefined {
  const identity = scopeIdentities.get(store);
  return identity ? { ...identity } : undefined;
}
/** First-party scope provenance, without relying on a copied settings/path object. */
export function guardedOperationOwner(store: StoreHost): StoreHost | undefined { return scopeOwners.get(store); }
export function factRecoveryPath(store: StoreHost): string {
  return store.path(store.settings.folders.aiReports, "Operations", "write-recovery.json");
}
export { fileRevision } from "../operationIdentity";
class FactWriteConflictError extends Error {
  constructor() {
    super("资料刚有改动，已保留当前内容，请再试一次。");
    this.name = "FactWriteConflictError";
  }
}
function conflict(): never {
  throw new Error("相关文件后来发生了变化，已停止覆盖。请先核对或恢复这次操作。");
}
function assertUndoToolIdentity(identity: FactOperationIdentity): void {
  if (identity.undoToolOperationId === undefined) return;
  assertSafeOperationId(identity.undoToolOperationId);
  if (identity.purpose === "derived" || identity.auditStatus !== "reverted" || !identity.auditId
    || identity.operationId !== `undo:${identity.auditId}` || identity.undoToolOperationId === identity.auditId
    || identity.undoToolOperationId === identity.operationId) conflict();
}
function validUndoToolClaim(document: FactOperationIdentity, claim: OperationLedgerRecord | undefined): claim is OperationLedgerRecord {
  return !!claim && claim.operationId === document.undoToolOperationId && claim.toolName === "undo_latest_operation"
    && claim.status === "executing" && Number.isSafeInteger(claim.attempts) && claim.attempts > 0
    && ["system", "kimi", "qwen-omni"].includes(claim.source) && typeof claim.createdAt === "string"
    && typeof claim.updatedAt === "string" && !!claim.arguments && typeof claim.arguments === "object" && !Array.isArray(claim.arguments)
    && claim.fingerprint === operationFingerprint(claim.toolName, claim.arguments);
}
function validatePath(store: StoreHost, path: string, identity: FactOperationIdentity): void {
  const parts = path.split("/");
  if (!path || path.includes("\\") || parts.some(part => !part || part === "." || part === ".." || part.startsWith("."))
    || /[\x00-\x1f]/.test(path) || !/\.(?:md|json|jsonl)$/.test(path)) conflict();
  const roots = Object.values(store.settings.folders).filter((value): value is string => typeof value === "string");
  if (!roots.some(root => path.startsWith(`${root}/`))
    && !(identity.purpose !== "derived" && (isDeviceConfigurationWrite(path, identity.operationId)
      || isDeviceInputWrite(path, identity.operationId)))) conflict();
  const operations = store.path(store.settings.folders.aiReports, "Operations");
  // Only the host's undo transaction may journal its own Ledger transition.
  // The same exact identity/path check applies to live writes and recovery;
  // ordinary facts, derived indexes and other Operations files stay excluded.
  const undoLedger = identity.purpose !== "derived" && identity.auditStatus === "reverted"
    && Boolean(identity.auditId) && identity.operationId === `undo:${identity.auditId}`
    && path === store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
  if (path.startsWith(`${operations}/`) && !undoLedger) conflict();
  if (identity.purpose === "derived") {
    const derived = [store.sourceManifestPath(), store.vaultIndexPath(), store.vectorIndexPath(), store.chunkIndexPath(),
      store.knowledgeGraphPath(), store.knowledgeLinksPath(), store.memoryIndexPath(), store.associationsPath()];
    if (!derived.includes(path) && !signalDateFromDocumentPath(path, store.settings.folders.aiReports)) {
      throw new Error("资料整理只能更新派生资料，不能修改用户记录。");
    }
  }
}
function needsExactMarkdown(store: StoreHost, path: string): boolean {
  if (!path.endsWith(".md")) return false;
  const { ideas, health, dailyRoot } = store.settings.folders;
  const retained = store.path(store.settings.folders.aiReports, "Operations", "Retained");
  return (Boolean(ideas) && path.startsWith(ideas + "/") && !path.startsWith(ideas + "/每日记录/"))
    || (Boolean(health) && path.startsWith(health + "/"))
    || (Boolean(dailyRoot) && !!journalDateFromPath(path, dailyRoot))
    || path.startsWith(retained + "/");
}
async function readVaultText(store: StoreHost, file: TFile, vault = store.app.vault): Promise<string> {
  // Obsidian's text reader can normalize a hand-written note. Recovery and
  // attribute-only changes must retain the original UTF-8 bytes.
  const adapter = vault.adapter as { getBasePath?: () => string } | undefined;
  if (needsExactMarkdown(store, file.path) && typeof vault.readBinary === "function" && adapter?.getBasePath?.()) {
    return Buffer.from(await vault.readBinary(file)).toString("utf8");
  }
  return vault.read(file);
}
async function readRaw(store: StoreHost, path: string): Promise<string | null> {
  const file = store.getFile(path);
  return file ? readVaultText(store, file) : null;
}

/** Recovery may replace several files. On desktop, compare its preflight
 * snapshot again inside the actual process callback of the next write. */
function checkRecoveryFilesAtWrite(store: StoreHost, expected: ReadonlyMap<string, string | null>): (() => void) | undefined {
  const adapter = store.app.vault.adapter as { getBasePath?: () => string } | undefined;
  const root = adapter?.getBasePath?.();
  if (!root || !isAbsolute(root)) return undefined;
  const base = realpathSync(root);
  return () => {
    for (const [path, raw] of expected) {
      const target = join(base, path);
      let stat;
      try { stat = lstatSync(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && raw === null) continue;
        conflict();
      }
      if (raw === null || !stat.isFile() || realpathSync(target) !== target
        || stat.size !== Buffer.byteLength(raw) || createHash("sha256").update(readFileSync(target)).digest("hex") !== fileRevision(raw)) conflict();
    }
  };
}
async function replaceRaw(store: StoreHost, path: string, expected: string | null, next: string | null, retainedPath?: string, assertStable?: () => void): Promise<void> {
  if (await readRaw(store, path) !== expected) conflict();
  assertStable?.();
  if (expected === next) return;
  const file = store.getFile(path);
  if (next === null) {
    if (file && retainedPath) {
      await store.ensureFolder(retainedPath.split("/").slice(0, -1).join("/"));
      assertStable?.();
      // Rename first and retain the bytes. A concurrent edit between our check
      // and removal must never be irreversibly unlinked.
      await store.app.vault.rename(file, retainedPath);
      const retained = await readRaw(store, retainedPath);
      if (retained !== expected) {
        if (retained !== null && !store.getFile(path)) {
          await store.app.vault.create(path, retained).catch(() => undefined);
        }
        conflict();
      }
    } else if (file && scopes.has(store)) await store.app.vault.delete(file);
    else if (file) throw new Error("删除缺少保留副本，已停止操作。");
  } else if (file) {
    const assertExactMarkdown = needsExactMarkdown(store, path) && typeof store.app.vault.readBinary === "function"
      ? checkRecoveryFilesAtWrite(store, new Map([[path, expected]])) : undefined;
    await store.app.vault.process(file, current => {
      assertStable?.();
      // The same TFile can be renamed while awaiting the native write boundary.
      if (file.path !== path) conflict();
      if (assertExactMarkdown) assertExactMarkdown();
      else if (current !== expected) conflict();
      const contract = jsonDataContract(path, store.settings.folders);
      if (contract) { parseJsonData(current, path, contract); parseJsonData(next, path, contract); }
      return next;
    });
  } else {
    await store.ensureFolder(path.split("/").slice(0, -1).join("/"));
    assertStable?.();
    await store.app.vault.create(path, next);
  }
  if (await readRaw(store, path) !== next) throw new Error("保存后的内容与预期不一致，操作未通过读回检查。");
}
function validateRecovery(store: StoreHost, value: unknown): RecoveryDocument {
  const document = value as RecoveryDocument;
  if (!document || document.version !== 1 || typeof document.operationId !== "string" || !document.operationId
    || (document.purpose !== undefined && !["fact", "derived"].includes(document.purpose))
    || (document.auditId !== undefined && (typeof document.auditId !== "string" || !document.auditId))
    || (document.auditStatus !== undefined && !["verified", "reverted"].includes(document.auditStatus))
    || !["pending", "committed", "rolled_back"].includes(document.status) || !Array.isArray(document.entries)
    || (document.rollbackRequired !== undefined && typeof document.rollbackRequired !== "boolean")
    || (document.rollbackComplete !== undefined && typeof document.rollbackComplete !== "boolean")) conflict();
  assertSafeOperationId(document.operationId);
  if (document.auditId !== undefined) assertSafeOperationId(document.auditId);
  assertUndoToolIdentity(document);
  if (document.undoToolOperationId !== undefined ? !validUndoToolClaim(document, document.undoToolClaim) : document.undoToolClaim !== undefined) conflict();
  if (document.rollbackComplete && (!document.undoToolOperationId || !document.rollbackRequired || document.status === "committed")) conflict();
  const paths = new Set<string>();
  if (document.ledgerUndo !== undefined) {
    validatePath(store, document.ledgerUndo.path, document);
    if (document.ledgerUndo.path !== new OperationLedger(store).filePath) conflict();
    ledgerUndoAfter(document.ledgerUndo, document);
    paths.add(document.ledgerUndo.path);
  }
  for (const entry of document.entries) {
    if (!entry || typeof entry.path !== "string" || paths.has(entry.path)) conflict();
    validatePath(store, entry.path, document);
    paths.add(entry.path);
    if ((entry.before !== null && typeof entry.before !== "string") || (entry.after !== null && typeof entry.after !== "string")
      || fileRevision(entry.before) !== entry.beforeHash || fileRevision(entry.after) !== entry.afterHash
      || (Object.hasOwn(entry, "previous") && ((entry.previous !== null && typeof entry.previous !== "string")
        || fileRevision(entry.previous!) !== entry.previousHash))) conflict();
    if (entry.retained !== undefined && (!Array.isArray(entry.retained) || entry.retained.some(copy =>
      !copy || !new RegExp(`^[a-f0-9-]{36}\\.md$`).test(copy.path?.split("/").at(-1) ?? "")
      || copy.path !== store.path(store.settings.folders.aiReports, "Operations", "Retained", copy.path.split("/").at(-1)!)
      || !/^[a-f0-9]{64}$/.test(copy.expectedHash)))) conflict();
  }
  return document;
}
/** Read-only validation shared by durable recovery clients; this never settles or rewrites a WAL. */
export function inspectFactRecovery(store: StoreHost, raw: string): RecoveryDocument {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECOVERY_BYTES) conflict();
  const path = factRecoveryPath(store);
  return validateRecovery(store, decodeFactRecovery(parseJsonData(raw, path, jsonDataContract(path, store.settings.folders))));
}

/** New audit records cannot change the exact ledger used to recover an undo. */
export async function assertOperationClaimAllowed(store: StoreHost): Promise<void> {
  if (activeFactOperation(store)?.auditStatus === "reverted") throw new UndoRecoveryRequiredError();
  const raw = await readRaw(store, factRecoveryPath(store));
  if (activeFactOperation(store)?.auditStatus === "reverted") throw new UndoRecoveryRequiredError();
  if (raw === null) return;
  // Do not expand large snapshots to check an operation claim. The
  // recovery owner validates the full document when it applies the journal.
  const journal = JSON.parse(raw);
  if (journal.status !== "pending" || journal.auditStatus !== "reverted") return;
  const ledgerPath = new OperationLedger(store).filePath;
  const ledgerInEntries = Array.isArray(journal.entries) && journal.entries.some((entry: { path?: string } | null) => entry?.path === ledgerPath);
  if (journal.ledgerUndo || ledgerInEntries && (journal.rollbackRequired || !await auditFinished(store, journal))) throw new UndoRecoveryRequiredError();
}

/** Check the complete known undo before its first write, using the same exact
 * snapshot encoding and limits as the real WAL. This never persists a journal. */
export async function preflightFactOperationChanges(store: StoreHost, changes: GuardedFileChange[]): Promise<void> {
  const document = scopeDocuments.get(store);
  if (!document || !isGuardedOperationScope(store) || hasRecoveryChanges(document)) {
    throw new Error("撤销容量核对缺少当前保存范围，未开始修改。");
  }
  const planned = { ...structuredClone(document), entries: structuredClone(changes) };
  const reads = scopeReads.get(store);
  for (const entry of planned.entries) {
    const current = await readRaw(store, entry.path);
    if (current !== entry.before || reads?.has(entry.path) && reads.get(entry.path) !== current) conflict();
    if (entry.after === null && current !== null) retainForDeletion(store, entry, current);
  }
  validateRecovery(store, planned);
  const budget = (value: RecoveryDocument) => {
    encodeFactRecovery(value);
    encodeSettledFactRecovery({ ...value, status: "committed" });
    encodeFactRecovery({ ...value, status: "pending", rollbackRequired: true,
      ...(value.undoToolOperationId ? { rollbackComplete: true } : {}) });
    const rollbackPlan = structuredClone(value);
    for (const entry of rollbackPlan.entries) {
      if (entry.before === null && entry.after !== null) retainForDeletion(store, entry, entry.after);
    }
    encodeSettledFactRecovery({ ...rollbackPlan, status: "rolled_back", rollbackRequired: true,
      ...(value.undoToolOperationId ? { rollbackComplete: true } : {}) });
  };
  try { budget(planned); return; }
  catch (error) { if (!(error instanceof RecoveryCapacityError)) throw error; }
  // Only a complete, exact internal ledger transition may use the new form.
  // Malformed snapshots and conflicts never enter this capacity fallback.
  const ledgerPath = new OperationLedger(store).filePath;
  const ledger = planned.entries.find(entry => entry.path === ledgerPath);
  if (!ledger || typeof ledger.before !== "string" || typeof ledger.after !== "string"
    || planned.auditStatus !== "reverted" || !planned.auditId || planned.operationId !== `undo:${planned.auditId}`) throw new UndoCapacityError();
  const after = parseJsonData(ledger.after, ledgerPath, jsonDataContract(ledgerPath, store.settings.folders)) as OperationLedgerDocument;
  const record = after.records.find(row => row.operationId === planned.auditId);
  const toolResult = planned.undoToolOperationId ? after.records.find(row => row.operationId === planned.undoToolOperationId)?.result : undefined;
  if (!record?.revertedAt) conflict();
  const delta: LedgerUndoRecovery = { kind: "ledger-revert-v1", path: ledgerPath, before: ledger.before,
    beforeHash: ledger.beforeHash, afterHash: ledger.afterHash, timestamp: record.revertedAt,
    ...(toolResult ? { toolResult: structuredClone(toolResult) } : {}) };
  const candidate = { ...planned, entries: planned.entries.filter(entry => entry.path !== ledgerPath), ledgerUndo: delta };
  for (const kind of ["ledger-revert-v1", "ledger-revert-v2"] as const) {
    delta.kind = kind;
    try {
      if (ledgerUndoAfter(delta, planned) !== ledger.after) conflict();
      budget(candidate);
    } catch (error) {
      if (error instanceof RecoveryCapacityError) continue;
      throw error;
    }
    // The plan becomes durable only when the first guarded write begins.
    document.ledgerUndo = delta;
    return;
  }
  throw new UndoCapacityError();
}
function hasRecoveryChanges(document: RecoveryDocument): boolean { return !!(document.entries.length || document.ledgerUndo); }
function isDeviceConfigurationOnly(document: RecoveryDocument): boolean {
  return document.purpose !== "derived" && !document.ledgerUndo && !document.undoToolOperationId
    && (document.auditId ?? document.operationId) === document.operationId
    && (document.auditStatus ?? "verified") === "verified" && document.entries.length === 1
    && isDeviceConfigurationWrite(document.entries[0].path, document.operationId);
}
function encodeSettledFactRecovery(document: RecoveryDocument): string {
  // Older daily versions validate even terminal WAL paths against their own
  // record roots. Setup lives outside those roots. Only discard its redundant
  // WAL snapshots after all guards settle; the Ledger retains the full undo.
  if (document.status !== "pending" && isDeviceConfigurationOnly(document)) {
    return encodeFactRecovery({ ...document, entries: [] });
  }
  if (document.ledgerUndo?.kind !== "ledger-revert-v2") return encodeFactRecovery(document);
  // The ledger base is needed until the transaction settles. Leave the
  // business snapshots and an old-readable terminal status on disk.
  const { ledgerUndo: _ledgerUndo, ...settled } = document;
  return encodeFactRecovery(settled);
}
async function locked<T>(store: StoreHost, work: () => Promise<T>): Promise<T> {
  const key = store.app.vault;
  const prior = locks.get(key) ?? Promise.resolve();
  const pending = prior.catch(() => undefined).then(work);
  locks.set(key, pending);
  try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
}
/** Public request preparation only: await live work without joining its lock or
 * settling a durable interrupted journal. Never call from a held Fact scope. */
export async function waitForFactOperations(store: StoreHost, options: { signal?: AbortSignal; assertCurrent?: () => void } = {}): Promise<void> {
  if (isGuardedOperationScope(store)) throw new Error("不能在保存操作内等待同一保存队列。");
  const current = () => {
    if (options.signal?.aborted) { const error = new Error("AI request aborted"); error.name = "AbortError"; throw error; }
    options.assertCurrent?.();
  };
  current();
  for (;;) {
    const tail = locks.get(store.app.vault);
    if (!tail) { current(); return; }
    let onAbort: (() => void) | undefined;
    const settled = tail.catch(() => undefined);
    try {
      if (options.signal) {
        const cancelled = new Promise<never>((_resolve, reject) => {
          onAbort = () => { const error = new Error("AI request aborted"); error.name = "AbortError"; reject(error); };
          options.signal!.addEventListener("abort", onAbort, { once: true });
        });
        current();
        await Promise.race([settled, cancelled]);
      } else await settled;
      current();
    } finally { if (onAbort) options.signal?.removeEventListener("abort", onAbort); }
    // A newer operation can have joined while we waited. A settled identical
    // tail is safe even before its owner's finally removes it.
    if (locks.get(store.app.vault) === tail) return;
  }
}
/** Read a snapshot once any active write has settled. */
export async function readFactOperation<T>(store: StoreHost, read: () => Promise<T>): Promise<T> {
  if (!store.runFactOperation || scopes.has(store)) return read();
  await waitForFactOperations(store);
  if (await hasInterruptedFactOperation(store)) throw new Error("上次保存被中断，请先恢复后再读取。");
  return read();
}
async function assertWrittenFiles(store: StoreHost, document: RecoveryDocument): Promise<void> {
  for (const entry of document.entries) if (await readRaw(store, entry.path) !== entry.after) conflict();
  if (document.ledgerUndo && await readRaw(store, document.ledgerUndo.path) !== ledgerUndoAfter(document.ledgerUndo, document)) conflict();
}
async function auditFinished(store: StoreHost, document: RecoveryDocument): Promise<boolean> {
  const path = store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
  if (document.ledgerUndo) {
    const revision = fileRevision(await readRaw(store, path));
    if (revision === document.ledgerUndo.beforeHash) return false;
    if (revision !== document.ledgerUndo.afterHash) conflict();
    // A committed ledger paired with a later business edit is a conflict, even
    // when that edit happens to equal the operation's old before image.
    for (const entry of document.entries) if (await readRaw(store, entry.path) !== entry.after) conflict();
  }
  const ledger = await store.readJson<OperationLedgerDocument>(path, { version: 1, records: [] });
  const originalFinished = ledger.records.some(record => record.operationId === (document.auditId ?? document.operationId)
    && record.status === (document.auditStatus ?? "verified"))
    || document.auditStatus === "reverted" && !!ledger.revertedOperationHashes?.includes(fileRevision(document.auditId ?? document.operationId));
  if (!originalFinished || !document.undoToolOperationId) return originalFinished;
  const own = ledger.records.find(record => record.operationId === document.undoToolOperationId), claim = document.undoToolClaim;
  return !!own && !!claim && own.status === "verified" && own.toolName === claim.toolName && own.source === claim.source
    && own.attempts === claim.attempts && own.createdAt === claim.createdAt && own.fingerprint === claim.fingerprint
    && operationFingerprint(own.toolName, own.arguments) === own.fingerprint
    && own.result?.success === true && own.result.actions.length === 0 && !own.result.undo;
}
async function finishUndoToolRollback(store: StoreHost, document: RecoveryDocument, persist: () => Promise<void>,
  beforeWrite?: () => Promise<void>): Promise<void> {
  if (!document.undoToolOperationId) return;
  if (!document.rollbackComplete) {
    // If claim release or its following WAL tail fails, recovery must not try
    // to restore the Ledger's older executing bytes over the released claim.
    document.rollbackRequired = true; document.rollbackComplete = true;
    await persist();
  }
  const claim = document.undoToolClaim;
  if (!validUndoToolClaim(document, claim)) conflict();
  const ledger = new OperationLedger(store), live = await store.readJson<OperationLedgerDocument>(ledger.filePath, { version: 1, records: [] });
  const verifyRestored = async () => {
    for (const entry of document.entries) {
      if (entry.path !== ledger.filePath && await readRaw(store, entry.path) !== entry.before) conflict();
    }
  };
  await verifyRestored();
  const own = live.records.find(record => record.operationId === claim.operationId);
  if (own?.status === "failed" && own.attempts === claim.attempts && own.createdAt === claim.createdAt
    && own.fingerprint === claim.fingerprint && own.source === claim.source && own.toolName === claim.toolName
    && operationFingerprint(own.toolName, own.arguments) === own.fingerprint) return;
  await beforeWrite?.();
  await verifyRestored();
  if (!await ledger.failClaim(claim, "撤销已中断并恢复，原有记录保留，可以重新提出撤销。")) conflict();
  await verifyRestored();
}
function retainForDeletion(store: StoreHost, entry: GuardedFileChange, current: string): string {
  const path = store.path(store.settings.folders.aiReports, "Operations", "Retained", `${randomUUID()}.md`);
  entry.retained = [...(entry.retained ?? []), { path, expectedHash: fileRevision(current) }];
  return path;
}
async function rollback(store: StoreHost, document: RecoveryDocument, persist: () => Promise<void>, assertCurrent?: () => Promise<void>): Promise<void> {
  // Check every file before changing any: a conflict in the last file must not
  // restore the earlier files and leave the user with a half-undone operation.
  const observed = new Map<string, string | null>();
  let ledgerCurrent: string | null = null;
  if (document.ledgerUndo) {
    ledgerCurrent = await readRaw(store, document.ledgerUndo.path);
    if (ledgerCurrent !== document.ledgerUndo.before && ledgerCurrent !== ledgerUndoAfter(document.ledgerUndo, document)) conflict();
  }
  for (const entry of document.entries) {
    for (const copy of entry.retained ?? []) {
      const retained = await readRaw(store, copy.path);
      if (retained !== null && fileRevision(retained) !== copy.expectedHash) conflict();
      observed.set(copy.path, retained);
    }
    const current = await readRaw(store, entry.path);
    const allowed = [entry.before, entry.after, ...(Object.hasOwn(entry, "previous") ? [entry.previous] : [])];
    if (!allowed.includes(current)) conflict();
    observed.set(entry.path, current);
  }
  if (document.ledgerUndo) {
    await assertCurrent?.();
    observed.set(document.ledgerUndo.path, ledgerCurrent);
    await replaceRaw(store, document.ledgerUndo.path, ledgerCurrent, document.ledgerUndo.before, undefined, checkRecoveryFilesAtWrite(store, observed));
    observed.set(document.ledgerUndo.path, document.ledgerUndo.before);
  }
  for (const entry of [...document.entries].reverse()) {
    const current = observed.get(entry.path)!;
    const retained = entry.before === null && current !== null ? retainForDeletion(store, entry, current) : undefined;
    if (retained) await persist();
    await assertCurrent?.();
    await replaceRaw(store, entry.path, current, entry.before, retained, document.ledgerUndo ? checkRecoveryFilesAtWrite(store, observed) : undefined);
    observed.set(entry.path, entry.before);
    if (retained) observed.set(retained, current);
  }
}

/** Real Vault boundary. Business methods run on a scoped Store; audit writes use
 * the original Store, so recording an operation cannot recursively record itself. */
export async function runFactOperation<T>(
  store: StoreHost,
  identity: FactOperationIdentity,
  execute: (scoped: StoreHost) => Promise<T>,
  finalize: (result: T, undo?: OperationUndoDescriptor) => Promise<void>,
  options: FactOperationOptions = {}
): Promise<T> {
  const snapshot = structuredClone(identity);
  try { return await runFactOperationOnce(store, snapshot, execute, finalize, options); }
  catch (error) {
    if (!(error instanceof FactWriteConflictError)) throw error;
    return runFactOperationOnce(store, snapshot, execute, finalize, options);
  }
}

async function runFactOperationOnce<T>(
  store: StoreHost,
  identity: FactOperationIdentity,
  execute: (scoped: StoreHost) => Promise<T>,
  finalize: (result: T, undo?: OperationUndoDescriptor) => Promise<void>,
  options: FactOperationOptions
): Promise<T> {
  assertSafeOperationId(identity.operationId);
  if (identity.auditId !== undefined) assertSafeOperationId(identity.auditId);
  assertUndoToolIdentity(identity);
  if (scopes.has(store)) throw new Error("不能在一个保存操作中另开保存操作。");
  return locked(store, async () => {
    try {
    options.assertCurrent?.();
    if (identity.auditStatus === "reverted") activeWrites.set(store.app.vault, { ...identity });
    const journalPath = factRecoveryPath(store);
    let journalRaw = await readRaw(store, journalPath);
    let canCompactLedger = identity.auditStatus === "reverted";
    if (journalRaw !== null) {
      const previous = inspectFactRecovery(store, journalRaw);
      if (previous.status === "pending") {
        canCompactLedger = false;
          if (previous.ledgerUndo?.kind === "ledger-revert-v2" || previous.rollbackRequired || !await auditFinished(store, previous)) {
          throw new Error("上次保存被中断。请先使用“检查并恢复未完成操作”，恢复后再继续保存。");
        }
      }
    }
    if (canCompactLedger) {
      const ledger = new OperationLedger(store);
      await ledger.compactRevertedSnapshots(() => readRaw(store, ledger.filePath), async (raw, compacted) => {
        // This changes only finished undo data. A pending recovery must keep its exact ledger bytes.
        activeWrites.set(store.app.vault, { ...identity });
        await replaceRaw(store, ledger.filePath, raw, serializeJsonData(compacted, { compact: true }), undefined, options.assertCurrent);
      });
    }
    const document: RecoveryDocument = { version: 1, ...identity, status: "pending", entries: [] };
    if (identity.undoToolOperationId) {
      const ledger = new OperationLedger(store), audit = await store.readJson<OperationLedgerDocument>(ledger.filePath, { version: 1, records: [] });
      const claim = audit.records.find(record => record.operationId === identity.undoToolOperationId);
      if (!validUndoToolClaim(identity, claim)) conflict();
      document.undoToolClaim = structuredClone(claim);
    }
    const persist = async (settled = false, assertStable?: () => void) => {
      const next = settled ? encodeSettledFactRecovery(document) : encodeFactRecovery(document);
      try { await replaceRaw(store, journalPath, journalRaw, next, undefined, assertStable); }
      catch (error) {
        if (!settled || document.ledgerUndo?.kind !== "ledger-revert-v2"
          || await readRaw(store, journalPath).catch(() => undefined) !== next) throw error;
      }
      journalRaw = next;
    };
    const reads = new Map<string, string | null>();
    let open = true;
    let writeChain: Promise<unknown> = Promise.resolve();
    const queue = <R>(work: () => Promise<R>): Promise<R> => {
      if (!open) return Promise.reject(new Error("这次保存已经结束，后续写入已停止。"));
      const next = writeChain.then(work);
      writeChain = next;
      return next;
    };
    let writeConflict: FactWriteConflictError | undefined;
    const mutate = async (path: string, change: (before: string | null) => string | null): Promise<string | null> => {
      validatePath(store, path, identity);
      const current = await readRaw(store, path);
      if (reads.has(path) && fileRevision(reads.get(path) ?? null) !== fileRevision(current)) throw (writeConflict = new FactWriteConflictError());
      const next = change(current);
      if (next !== null && typeof next !== "string") conflict();
      if (current === next) return next;
      if (document.ledgerUndo?.path === path) {
        if (current !== document.ledgerUndo.before || next !== ledgerUndoAfter(document.ledgerUndo, document)) conflict();
        activeWrites.set(store.app.vault, { ...identity });
        await persist();
        await replaceRaw(store, path, current, next);
        reads.set(path, next);
        return next;
      }
      const candidate = structuredClone(document);
      let entry = candidate.entries.find(entry => entry.path === path);
      if (!entry) {
        entry = { path, before: current, after: current, beforeHash: fileRevision(current), afterHash: fileRevision(current) };
        candidate.entries.push(entry);
      }
      // The initial before image already permits recovery from this value.
      // Keep a distinct intermediate image when writing the same file again.
      if (current !== entry.before) {
        entry.previous = current;
        entry.previousHash = fileRevision(current);
      } else {
        delete entry.previous;
        delete entry.previousHash;
      }
      entry.after = next;
      entry.afterHash = fileRevision(next);
      const retained = next === null && current !== null ? retainForDeletion(store, entry, current) : undefined;
      // A capacity refusal must not poison the smaller rollback journal.
      // After encoding passes, retain the intent even if its disk write fails.
      encodeFactRecovery(candidate);
      document.entries = candidate.entries;
      activeWrites.set(store.app.vault, { ...identity });
      await persist(); // Durable intent always precedes the first business write.
      await replaceRaw(store, path, current, next, retained);
      reads.set(path, next);
      delete entry.previous;
      delete entry.previousHash;
      await persist();
      return next;
    };
    const rawVault = store.app.vault;
    const vault = new Proxy(rawVault, {
      get(target, property) {
        if (property === "getAbstractFileByPath" || property === "getFileByPath") return (path: string) => {
          const value = property === "getFileByPath" ? target.getFileByPath(path) : target.getAbstractFileByPath(path);
          if (!value && !reads.has(path)) reads.set(path, null);
          return value;
        };
        if (property === "read" || property === "cachedRead") return async (file: TFile) => {
          const value = await readVaultText(store, file, target);
          if (!reads.has(file.path)) reads.set(file.path, value);
          return value;
        };
        if (property === "create") return (path: string, content: string) => queue(async () => {
          await mutate(path, before => { if (before !== null) conflict(); return content; });
          return store.getFile(path)!;
        });
        if (property === "modify") return (file: TFile, content: string) => queue(async () => {
          await mutate(file.path, before => { if (before === null) conflict(); return content; });
        });
        if (property === "process") return (file: TFile, updater: (text: string) => string) => queue(async () => {
          return (await mutate(file.path, before => { if (before === null) conflict(); return updater(before); }))!;
        });
        if (property === "delete") return (file: TFile) => queue(async () => { await mutate(file.path, () => null); });
        if (["rename", "trash", "createBinary", "modifyBinary", "append"].includes(String(property))) {
          return () => { throw new Error("本次操作不支持这种文件修改方式。"); };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as Vault;
    const app = new Proxy(store.app, { get(target, property) { return property === "vault" ? vault : Reflect.get(target, property, target); } }) as App;
    const scoped = Object.assign(Object.create(Object.getPrototypeOf(store)), store, { app, settings: structuredClone(store.settings) }) as StoreHost;
    scopes.add(scoped);
    scopeIdentities.set(scoped, { ...identity });
    scopeOwners.set(scoped, store);
    scopeDocuments.set(scoped, document);
    scopeReads.set(scoped, reads);
    let outcome: { result: T } | undefined;
    let guardRejected = false;
    const current = () => {
      try { options.assertCurrent?.(); } catch (error) { guardRejected = true; throw error; }
    };
    const beforeCommit = async () => {
      try { await options.assertBeforeCommit?.(); current(); }
      catch (error) { guardRejected = true; throw error; }
    };
    try {
      current();
      const result = await execute(scoped);
      outcome = { result };
      await writeChain;
      if (writeConflict) throw writeConflict;
      open = false;
      await assertWrittenFiles(store, document);
      current();
      if (options.assertBeforeCommit) await beforeCommit();
      await assertWrittenFiles(store, document);
      const changed = document.entries.filter(entry => entry.before !== entry.after);
      const undo: OperationUndoDescriptor | undefined = changed.length
        ? { kind: "restore_guarded_files", files: structuredClone(changed) } : undefined;
      await finalize(result, undo);
      await assertWrittenFiles(store, document);
      current();
      const extendedUndo = document.ledgerUndo?.kind === "ledger-revert-v2" ? document.ledgerUndo : undefined;
      const deviceConfiguration = isDeviceConfigurationOnly(document);
      if (!extendedUndo && !deviceConfiguration) {
        document.status = "committed";
        if (hasRecoveryChanges(document)) await persist();
      }
      current();
      if (options.assertBeforeCommit) await beforeCommit();
      await assertWrittenFiles(store, document);
      current();
      if (extendedUndo || deviceConfiguration) {
        document.status = "committed";
        const expected = new Map(document.entries.map(entry => [entry.path, entry.after] as const));
        if (extendedUndo) expected.set(extendedUndo.path, ledgerUndoAfter(extendedUndo, document));
        const assertStable = checkRecoveryFilesAtWrite(store, expected);
        await persist(true, () => { assertStable?.(); current(); });
      }
      options.onCommitted?.({journalCommitted:true});
      return result;
    } catch (error) {
      if (writeConflict) error = writeConflict;
      if (!guardRejected && outcome && hasRecoveryChanges(document)) {
        try { await assertWrittenFiles(store, document); }
        catch (changed) { guardRejected = true; error = changed; }
      }
      open = false;
      await writeChain.catch(() => undefined);
      // An awaited disk failure can coincide with cancellation before the next
      // success-side guard runs. Sample it before trusting a verified audit.
      if (!guardRejected) {
        try { current(); } catch (cancelled) { error = cancelled; }
      }
      if (hasRecoveryChanges(document)) {
        // A finalized audit is authoritative if only the final journal update failed.
        if (!guardRejected && outcome && await auditFinished(store, document)) {
          try {
            if (options.assertBeforeCommit) await beforeCommit();
            await assertWrittenFiles(store, document);
            current();
          } catch (cancelled) { guardRejected = true; error = cancelled; }
          if (!guardRejected) {
            options.onCommitted?.({journalCommitted:false});
            return outcome.result;
          }
        }
        // Explicit cancellation must remain recoverable even if the audit was
        // verified just before it arrived. Revoke that audit before restoring
        // files; a crash during rollback will then resume restoration.
        if (guardRejected) {
          document.status = "pending";
          document.rollbackRequired = true;
          await persist();
          // Undo now records its Ledger transition in this WAL too. Its
          // before-image is the original verified operation, not a failed save;
          // changing that after-image here would prevent conflict-safe rollback.
          if (identity.purpose !== "derived" && identity.auditStatus!=="reverted" && await auditFinished(store, document)) {
            await new OperationLedger(store).fail(identity.auditId ?? identity.operationId, "保存已取消，正在恢复原有文件。");
          }
        }
        if ((document.undoToolOperationId || document.ledgerUndo) && !document.rollbackRequired) {
          document.status = "pending"; document.rollbackRequired = true; await persist();
        }
        await rollback(store, document, persist);
        await finishUndoToolRollback(store, document, persist);
        document.status = "rolled_back";
        await persist(true);
      }
      throw error;
    }
    } finally { activeWrites.delete(store.app.vault); }
  });
}

export async function restoreGuardedFiles(store: StoreHost, files: GuardedFileChange[]): Promise<void> {
  await store.assertFactWritesAllowed?.();
  validateRecovery(store, { version: 1, operationId: "undo-validation", status: "pending", entries: files });
  for (const file of files) if (await readRaw(store, file.path) !== file.after) conflict();
  for (const file of [...files].reverse()) await replaceRaw(store, file.path, file.after, file.before);
}

export async function recoverFactOperation(store: StoreHost,
  options: { expectedRaw?: string | null; assertCurrent?: () => void; assertBeforeRecoveryWrite?: () => Promise<void> } = {}): Promise<"none" | "kept" | "restored"> {
  await store.assertFactWritesAllowed?.();
  if (scopes.has(store)) throw new Error("请先结束当前保存操作。");
  const bound = Object.hasOwn(options, "expectedRaw"), expectedRaw = options.expectedRaw, guard = options.assertCurrent;
  return locked(store, async () => {
    const path = factRecoveryPath(store);
    let raw = await readRaw(store, path);
    guard?.();
    if (bound && raw !== expectedRaw) conflict();
    if (raw === null) return "none";
    const document = inspectFactRecovery(store, raw);
    if (document.status !== "pending") return "none";
    const finished = !document.rollbackRequired && await auditFinished(store, document);
    const current = async () => {
      guard?.();
      if (options.assertBeforeRecoveryWrite) await options.assertBeforeRecoveryWrite();
      if (bound && await readRaw(store, path) !== raw) conflict();
      if (options.assertBeforeRecoveryWrite) await options.assertBeforeRecoveryWrite();
      if (finished && document.ledgerUndo && !await auditFinished(store, document)) conflict();
      guard?.();
    };
    await current();
    const persist = async (settled = false) => {
      if (finished && document.ledgerUndo || options.assertBeforeRecoveryWrite) await current(); else guard?.();
      const next = settled ? encodeSettledFactRecovery(document) : encodeFactRecovery(document);
      const kept = finished && (document.ledgerUndo || isDeviceConfigurationOnly(document))
        ? new Map([...document.entries.map(entry => [entry.path, entry.after] as const),
          ...(document.ledgerUndo ? [[document.ledgerUndo.path, ledgerUndoAfter(document.ledgerUndo, document)] as const] : [])])
        : undefined;
      await replaceRaw(store, path, raw, next, undefined, kept && checkRecoveryFilesAtWrite(store, kept));
      raw = next;
    };
    if (!finished && !document.rollbackComplete) await rollback(store, document, persist, current);
    if (!finished) await finishUndoToolRollback(store, document, persist, current);
    if (!finished && document.auditStatus !== "reverted") {
      const auditPath = store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
      const audit = await store.readJson<{ records: Array<{ operationId: string; status: string }> }>(auditPath, { records: [] });
      if (audit.records.some(record => record.operationId === document.operationId
        && (record.status === "executing" || (document.rollbackRequired && record.status === "verified")))) {
        await current();
        await new OperationLedger(store).fail(document.operationId, "已恢复中断操作，原有文件已复原，可以重新执行。");
      }
    }
    document.status = finished ? "committed" : "rolled_back";
    await persist(true);
    return finished ? "kept" : "restored";
  });
}

export async function hasInterruptedFactOperation(store: StoreHost): Promise<boolean> {
  const path = factRecoveryPath(store), raw = await readRaw(store, path);
  if (raw === null) return false;
  const document = inspectFactRecovery(store, raw);
  return document.status === "pending"
    && (document.ledgerUndo?.kind === "ledger-revert-v2" || Boolean(document.rollbackRequired) || !await auditFinished(store, document));
}

/** Public fact readers must wait for the final WAL boundary even when the
 * audit is already verified. The last source guard can still roll it back. */
export async function hasPendingFactOperation(store: StoreHost): Promise<boolean> {
  if (activeFactOperation(store)) return true;
  const path=factRecoveryPath(store),raw=await readRaw(store,path);
  if(raw===null)return false;
  const document=inspectFactRecovery(store,raw);
  return document.status==="pending";
}
