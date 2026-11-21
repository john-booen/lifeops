import { readPersonalMemoryDocument } from "./dataFoundation/personalMemoryPersistence";
import { jsonDataContract, parseJsonData } from "./dataFoundation/jsonDataGuard";
import type { OperationLedgerDocument, OperationLedgerRecord } from "./dataFoundation/operationLedger";
import { memoryContentHash, personalMemorySourceAssessment,
  type PersonalMemoryContextSource, type PersonalMemoryDocument, type PersonalMemoryRecord, type PersonalMemorySourceRef } from "./personalMemory";
import type { StoreHost } from "./store/settingsSlice";
import { isVaultPathExcluded } from "./privacy";
import { createHash } from "node:crypto";
import { SUMMARY_ORIGINAL_VERSION, isSummaryConversationOriginalRef, summaryOriginalRefCurrent, type SummaryOriginalReadCache } from "./features/memory/summaryOriginals";

type Assessment = NonNullable<PersonalMemoryRecord[typeof personalMemorySourceAssessment]>;
type LedgerSnapshot = { document: OperationLedgerDocument | null };
async function provisionalMemoryConfirmation(store: StoreHost): Promise<string | undefined> {
  const operations = await import("./dataFoundation/factOperation");
  const confirmation = (active: NonNullable<ReturnType<typeof operations.activeFactOperation>>) =>
    active.purpose === "derived" ? undefined : active.operationId;
  const active = operations.activeFactOperation(store);
  // Only a privately owned derived scope is restricted to rebuilding indexes.
  // Its retirement cannot change a memory's confirmation; a durable purpose
  // field never obtains this exemption. User-fact identities remain barriers.
  if (active) return confirmation(active);
  const pending = await operations.hasPendingFactOperation(store);
  const current = operations.activeFactOperation(store);
  if (current) return confirmation(current);
  if (!pending) return undefined;
  const journal = operations.inspectFactRecovery(store, await store.readPath(operations.factRecoveryPath(store)));
  const latest = operations.activeFactOperation(store);
  if (latest) return confirmation(latest);
  return journal.status === "pending" ? journal.operationId : undefined;
}

/** Load and assess the memory version observed for this request. */
export async function readPersonalMemoryWithSources(store: StoreHost): Promise<PersonalMemoryDocument> {
  const document = await readPersonalMemoryDocument(store);
  if (!document.records.length) return document;
  const ledgerPath = store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
  const provisionalOperation = document.records.some(record => record.sourceBinding && record.status === "active")
    ? await provisionalMemoryConfirmation(store) : undefined;
  const exists = (path: string) => store.getFile(path)?.path === path;
  const sourceBytes = new Map<string, string | null>();
  const readSource = async (path: string): Promise<string | null> => {
    if (sourceBytes.has(path)) return sourceBytes.get(path)!;
    const raw = exists(path) ? await store.readPath(path).catch(() => null) : null;
    sourceBytes.set(path, raw);
    return raw;
  };
  let ledger: LedgerSnapshot | undefined;
  const readLedger = async (): Promise<LedgerSnapshot> => {
    if (ledger) return ledger;
    const raw = await readSource(ledgerPath);
    let parsed: OperationLedgerDocument | null = null;
    if (raw !== null) {
      try {
        parsed = parseJsonData(raw, ledgerPath, jsonDataContract(ledgerPath, store.settings.folders)) as OperationLedgerDocument;
        const ids = new Set<string>();
        for (const record of parsed.records) {
          if (!record || typeof record.operationId !== "string" || ids.has(record.operationId)
            || !["executing", "verified", "failed", "reverted"].includes(record.status)) { parsed = null; break; }
          ids.add(record.operationId);
        }
      } catch { parsed = null; }
    }
    ledger = { document: parsed };
    return ledger;
  };
  const records: PersonalMemoryRecord[] = [];
  const originalCache: SummaryOriginalReadCache = {};
  for (const record of document.records) {
    const assessment: Assessment = provisionalOperation !== undefined && record.sourceBinding && record.confirmationReceipt?.operationId === provisionalOperation
      ? { usable: false, reason: "本次确认尚未保存，暂不使用", verifiedSourceIds: [] }
      : await assessMemory(record, store, ledgerPath, exists, readLedger, readSource, originalCache);
    records.push({ ...record, [personalMemorySourceAssessment]: assessment });
  }
  return { ...document, records };
}

async function assessMemory(
  record: PersonalMemoryRecord, store: StoreHost, ledgerPath: string, exists: (path: string) => boolean,
  readLedger: () => Promise<LedgerSnapshot>, readSource: (path: string) => Promise<string | null>, originalCache: SummaryOriginalReadCache
): Promise<Assessment> {
  const unavailable = (reason: string): Assessment => ({ usable: false, reason, verifiedSourceIds: [] });
  if (record.status === "forgotten") return unavailable("已停止使用");
  if (record.summarySource && record.summarySource.settingsRevision !== memorySourcePolicy(store)) {
    return unavailable("摘要读取范围已经变化，暂不使用这条记忆。");
  }
  // Check every declared original dependency before either confirmation path.
  // A receipt proves approval of this version, never approval of later bytes.
  const verifiedOriginals: PersonalMemorySourceRef[] = [];
  for (const ref of record.sourceRefs.filter(ref => ref.contentHash !== undefined)) {
    if (record.summarySource?.evidenceVersion === 2 && ref.extractionVersion === "summary-v1" && isSummaryMemoryRef(ref, store)) continue;
    if (!allowedVersionSource(ref, store)) return unavailable("固定版本来源缺失、被排除或不在允许范围，待重新核对");
    const raw = await readSource(ref.path);
    if (raw === null || sourceContentHash(raw) !== ref.contentHash) return unavailable("原文已变化或无法读取，旧理解暂停使用；请核对新的原文版本");
    if (ref.extractionVersion === SUMMARY_ORIGINAL_VERSION) {
      if (!await summaryOriginalRefCurrent(ref, record.content, store, readSource, originalCache)) return unavailable("自动记忆的原始陈述无法核对，原记忆保留，暂不使用。");
      verifiedOriginals.push(ref);
    }
  }
  const refs = record.sourceRefs.filter(ref => validRef(ref)
    && !isVaultPathExcluded(ref.path, store.settings.privacy?.excludedVaultPrefixes));
  const existingOriginal = (ref: PersonalMemorySourceRef): boolean => {
    if (ref.sourceId.startsWith("confirmed:")) return false;
    if (ref.sourceId.startsWith("conversation:")) {
      const date = ref.sourceId.slice("conversation:".length);
      return /^\d{4}-\d{2}-\d{2}$/.test(date)
        && ref.path === store.path(store.settings.folders.aiReports, "Conversations", `${date}.md`) && exists(ref.path);
    }
    return store.isManagedSourcePath(ref.path) && ref.path.endsWith(".md") && exists(ref.path);
  };
  const available = (reason: string, verified: PersonalMemoryContextSource[]): Assessment => {
    const originals = refs.filter(ref => !verified.some(source => source.ref.sourceId === ref.sourceId && source.ref.path === ref.path)
      && !(record.summarySource?.evidenceVersion === 2 && ref.extractionVersion === "summary-v1" && isSummaryMemoryRef(ref, store))
      && (ref.contentHash !== undefined || existingOriginal(ref)))
      .map(ref => ({ ref, basis: ref.contentHash !== undefined ? "fixed_version" as const : "legacy_existing" as const }));
    const contextSources = [...verified, ...originals];
    return { usable: true, reason, verifiedSourceIds: [...new Set(contextSources.map(source => source.ref.sourceId))], contextSources };
  };
  const confirmationBasis = (operation: OperationLedgerRecord): PersonalMemoryContextSource["basis"] =>
    operation.toolName === "confirm_review_memory" && operation.arguments?.memoryDecision === "correct" ? "correction" : "confirmation";
  const receipt = record.confirmationReceipt;
  if (receipt) {
    const ref = refs.find(ref => ref.sourceId === receipt.operationId && ref.path === receipt.sourcePath);
    if (receipt.sourcePath !== ledgerPath || !ref) return unavailable("确认凭据来源不匹配或被排除，待核对");
    const ledger = await readLedger();
    if (!ledger.document) return unavailable("确认日志缺失或无法核验，待核对");
    const operation = ledger.document.records.find(item => item.operationId === receipt.operationId);
    if (operation) {
      if (!verifiedConfirmation(operation, record)) return unavailable("当前确认操作未完成、已撤销或内容不匹配，待核对");
      return available("确认操作及持久凭据已核验", [{ ref, basis: confirmationBasis(operation) }]);
    }
    // The rolling Ledger retains only 500 records. The receipt was persisted in
    // the same guarded fact transaction and binds this exact current memory.
    return available("当前日志未保留该条，已核验持久确认凭据", [{ ref, basis: "receipt" }]);
  }
  const confirmed = refs.filter(ref => ref.sourceId.startsWith("confirmed:"));
  if (confirmed.length) {
    const ledger = await readLedger();
    if (!ledger.document) return unavailable("确认日志缺失或无法核验，待核对");
    const valid = confirmed.filter(ref => ref.path === ledgerPath
      && ledger.document!.records.some(operation => operation.operationId === ref.sourceId && verifiedConfirmation(operation, record)));
    if (valid.length) return available("现存确认操作已核验", valid.map(ref => ({ ref,
      basis: confirmationBasis(ledger.document!.records.find(operation => operation.operationId === ref.sourceId)!) })));
    // An unverified historical confirmation cannot be bypassed by a still-existing diary.
    return unavailable("历史确认无法核验，待重新确认；原记忆保留");
  }
  const valid = refs.filter(existingOriginal);
  if (record.summarySource) {
    if (record.summarySource.evidenceVersion !== 2) return unavailable("旧摘要提炼缺少原始陈述依据，原记忆保留，核对后再使用。");
    return verifiedOriginals.length ? { usable: true, reason: "已逐字核对原始陈述及固定版本", verifiedSourceIds: [...new Set(verifiedOriginals.map(ref => ref.sourceId))],
      contextSources: verifiedOriginals.map(ref => ({ ref, basis: "fixed_version" as const })) }
      : unavailable("自动记忆的原始陈述无法核对，原记忆保留，暂不使用。");
  }
  return valid.length ? available("原始来源存在；内容含义仍以用户确认为准", valid.map(ref => ({ ref, basis: ref.contentHash !== undefined ? "fixed_version" : "legacy_existing" })))
    : unavailable("原始来源缺失或不在允许范围，待核对；原记忆保留");
}

function validRef(ref: PersonalMemorySourceRef): boolean {
  return Boolean(ref.sourceId.trim() && Number.isFinite(Date.parse(ref.capturedAt)) && ref.path
    && !/^(?:\/|~|[a-z][a-z\d+.-]*:)/i.test(ref.path) && !/[\\\u0000-\u001f]/.test(ref.path)
    && ref.path.split("/").every(part => part && part !== "." && part !== ".."));
}

function verifiedConfirmation(operation: OperationLedgerRecord, record: PersonalMemoryRecord): boolean {
  if (operation.status !== "verified" || operation.result?.success !== true
    || !operation.arguments || typeof operation.arguments !== "object") return false;
  const args = operation.arguments;
  if (operation.toolName === "append_memory_note" && operation.operationId.startsWith("confirmed:conversation:")) {
    return !record.sourceBinding && typeof args.content === "string" && memoryContentHash(args.content) === memoryContentHash(record.content);
  }
  if (operation.source !== "system") return false;
  if (record.sourceBinding && args.memorySourceDependenciesHash !== record.sourceBinding.dependenciesHash) return false;
  if (operation.toolName === "confirm_update_memory" && args.type === "update_memory") {
    return typeof args.content === "string" && memoryContentHash(args.content) === memoryContentHash(record.content);
  }
  if (operation.toolName !== "confirm_review_memory" || args.type !== "review_memory" || args.memoryId !== record.id
    || !["confirm", "correct"].includes(String(args.memoryDecision))) return false;
  const content = args.memoryDecision === "correct" ? args.correctedMemoryContent || args.content : record.sourceBinding ? args.memoryReviewedContent : args.content;
  return typeof content === "string" && memoryContentHash(content) === memoryContentHash(record.content);
}

export function sourceContentHash(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}
export function memorySourcePolicy(store: StoreHost): string {
  return sourceContentHash(JSON.stringify({ folders: store.settings.folders, privacy: store.settings.privacy, externalVaults: store.settings.externalVaults ?? [] }));
}
function allowedVersionSource(ref: PersonalMemorySourceRef, store: StoreHost): boolean {
  return validRef(ref) && (isSummaryMemoryRef(ref, store) || isSummaryConversationOriginalRef(ref, store) || store.isManagedSourcePath(ref.path) && ref.path.endsWith(".md"))
    && !isVaultPathExcluded(ref.path, store.settings.privacy?.excludedVaultPrefixes);
}
export function isSummaryMemoryRef(ref: Pick<PersonalMemorySourceRef, "sourceId" | "path">, store: StoreHost): boolean {
  const date = ref.sourceId.match(/^summary:(\d{4}-\d{2}-\d{2})$/)?.[1];
  return !!date && ref.path === store.path(store.settings.folders.aiReports, "摘要", "日", date + ".md")
    && !isVaultPathExcluded(ref.path, store.settings.privacy?.excludedVaultPrefixes);
}
/** Used by confirmation guards as well as read-only context. No hash is updated. */
export async function assertPersonalMemoryDependencies(record: PersonalMemoryRecord, store: StoreHost): Promise<void> {
  const before = memorySourcePolicy(store);
  const cache: SummaryOriginalReadCache = {};
  const originals = new Map<string, string | null>();
  const read = async (path: string) => {
    if (!originals.has(path)) originals.set(path, store.getFile(path) ? await store.readPath(path) : null);
    return originals.get(path)!;
  };
  for (const ref of record.sourceRefs.filter(ref => ref.contentHash !== undefined)) {
    if (record.summarySource?.evidenceVersion === 2 && ref.extractionVersion === "summary-v1" && isSummaryMemoryRef(ref, store)) continue;
    if (!allowedVersionSource(ref, store) || !store.getFile(ref.path)) throw new Error("理解候选的固定来源已失效或被排除，请重新整理；原内容保留。");
    if (sourceContentHash(await store.readPath(ref.path)) !== ref.contentHash) throw new Error("理解候选对应的原文已经变化，请核对新版本；未确认旧理解。");
    if (ref.extractionVersion === SUMMARY_ORIGINAL_VERSION && !await summaryOriginalRefCurrent(ref, record.content, store, read, cache)) {
      throw new Error("自动记忆的原始陈述已经变化或无法核对，请核对后再确认；原内容保留。");
    }
  }
  if (memorySourcePolicy(store) !== before) throw new Error("核对期间资料权限变化，请重新整理理解候选。");
}
