import type { StoreHost } from "../store/settingsSlice";
import { createHash } from "node:crypto";
import { assertCurrentWrite } from "../store/settingsSlice";
import { emptyPersonalMemoryDocument, memoryContentHash, personalMemoryDependenciesHash, personalMemoryReadSnapshot, type PersonalMemoryDocument } from "../personalMemory";
import { jsonDataContract, parseJsonData, validateJsonData } from "./jsonDataGuard";

const queues = new WeakMap<object, Promise<unknown>>();
function conflict(): never {
  throw new Error("个人记忆已发生变化或格式无法识别，已停止覆盖。原有内容已保留，请重新打开审查。");
}
function validateRecords(document: PersonalMemoryDocument): void {
  const ids = new Set<string>();
  for (const record of document.records) {
    if (!record || typeof record !== "object" || typeof record.id !== "string" || !record.id.trim() || ids.has(record.id)
      || typeof record.content !== "string" || !record.content.trim()
      || !["core_profile", "current_state", "episode", "pattern_candidate", "user_rule"].includes(record.kind)
      || !["candidate", "active", "forgotten"].includes(record.status) || !["explicit_fact", "inference"].includes(record.truth)
      || typeof record.confidence !== "number" || !Number.isFinite(record.confidence)
      || !Array.isArray(record.sourceRefs) || record.sourceRefs.some(s => !s || typeof s.sourceId !== "string" || typeof s.path !== "string" || typeof s.capturedAt !== "string")
      || !Array.isArray(record.tags) || record.tags.some(t => typeof t !== "string")
      || !Array.isArray(record.revisions) || record.revisions.some(revision => !revision || typeof revision.content !== "string"
        || typeof revision.changedAt !== "string" || !Number.isFinite(Date.parse(revision.changedAt))
        || !["corrected", "superseded"].includes(revision.reason))
      || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") conflict();
    if (record.archivedAt !== undefined && (typeof record.archivedAt !== "string" || !Number.isFinite(Date.parse(record.archivedAt)))) conflict();
    if (record.summarySource !== undefined && (!record.summarySource || !/^[a-f0-9]{64}$/.test(record.summarySource.settingsRevision)
      || (record.summarySource.evidenceVersion === 2
        ? !record.sourceRefs.some(source => source.sourceId.startsWith("summary:") && source.contentHash !== undefined && source.extractionVersion === "summary-v1")
          || !record.sourceRefs.some(source => source.extractionVersion === "summary-original-v2" && source.contentHash !== undefined)
        : !record.sourceRefs.some(source => source.sourceId.startsWith("summary:") && source.extractionVersion === "summary-v1")))) conflict();
    ids.add(record.id);
    for (const source of record.sourceRefs) {
      if (source.contentHash !== undefined && (typeof source.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(source.contentHash)
        || typeof source.extractionVersion !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(source.extractionVersion))) conflict();
      if (source.extractionVersion !== undefined && source.contentHash === undefined) conflict();
      if (source.excerpt !== undefined && (source.contentHash === undefined || typeof source.excerpt !== "string" || !source.excerpt.trim()
        || source.excerpt.length > 1200 || typeof source.excerptHash !== "string" || source.excerptHash !== sourceRawHash(source.excerpt))) conflict();
      if (source.observedDate !== undefined && (source.contentHash === undefined || typeof source.observedDate !== "string"
        || !/^\d{4}-\d{2}-\d{2}$/.test(source.observedDate) || new Date(`${source.observedDate}T00:00:00Z`).toISOString().slice(0, 10) !== source.observedDate)) conflict();
    }
    const dependenciesHash = personalMemoryDependenciesHash(record.sourceRefs);
    if (dependenciesHash || record.sourceBinding !== undefined || record.id.startsWith("personal_note_v1_") && record.status !== "forgotten") {
      if (!dependenciesHash || !record.sourceBinding || record.sourceBinding.version !== 1
        || record.sourceBinding.dependenciesHash !== dependenciesHash) conflict();
    }
    if (record.confirmationReceipt !== undefined) {
      const receipt = record.confirmationReceipt;
      if (!receipt || typeof receipt !== "object" || Object.hasOwn(receipt, "schemaVersion") || receipt.version !== 1
        || record.status !== "active" || receipt.memoryId !== record.id || receipt.contentHash !== memoryContentHash(record.content)
        || typeof receipt.operationId !== "string" || !/^confirmed:.+/.test(receipt.operationId)
        || typeof receipt.sourcePath !== "string" || !receipt.sourcePath.trim()
        || typeof receipt.confirmedAt !== "string" || !Number.isFinite(Date.parse(receipt.confirmedAt))
        || receipt.confirmedAt !== record.confirmedAt
        || !record.sourceRefs.some(source => source.sourceId === receipt.operationId && source.path === receipt.sourcePath)
        || receipt.sourceDependenciesHash !== dependenciesHash) conflict();
    }
    if (record.suppression !== undefined || record.status === "forgotten") {
      const suppression = record.suppression;
      if (record.status !== "forgotten" || !suppression || suppression.version !== 1 || !Array.isArray(suppression.contentHashes)
        || suppression.contentHashes.length === 0 || suppression.contentHashes.some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
        || !Number.isFinite(Date.parse(suppression.recordedAt))) conflict();
      if (suppression.contentLengths !== undefined && (!suppression.contentLengths || typeof suppression.contentLengths !== "object"
        || Array.isArray(suppression.contentLengths) || Object.entries(suppression.contentLengths).some(([hash, length]) =>
          !suppression.contentHashes.includes(hash) || !Number.isSafeInteger(length) || length <= 0))) conflict();
      if (suppression.contentFingerprints !== undefined && (!suppression.contentFingerprints || typeof suppression.contentFingerprints !== "object"
        || Array.isArray(suppression.contentFingerprints) || Object.entries(suppression.contentFingerprints).some(([hash, fingerprint]) =>
          !suppression.contentLengths?.[hash] || !Number.isSafeInteger(fingerprint) || fingerprint < 0 || fingerprint > 0xffffffff))) conflict();
    }
  }
}
function sourceRawHash(raw: string): string { return createHash("sha256").update(raw, "utf8").digest("hex"); }
async function rawFile(store: StoreHost): Promise<string | null> {
  const path = store.personalMemoryPath();
  return store.getFile(path) ? store.readPath(path) : null;
}
export async function readPersonalMemoryDocument(store: StoreHost): Promise<PersonalMemoryDocument> {
  const path = store.personalMemoryPath();
  const raw = await rawFile(store);
  const document = raw === null ? emptyPersonalMemoryDocument()
    : parseJsonData(raw, path, jsonDataContract(path, store.settings.folders)) as PersonalMemoryDocument;
  validateRecords(document);
  return { ...document, [personalMemoryReadSnapshot]: { raw } };
}
export async function persistPersonalMemoryDocument(store: StoreHost, document: PersonalMemoryDocument, isCurrent?: () => boolean): Promise<void> {
  assertCurrentWrite(isCurrent);
  const key = store.app.vault;
  const previous = queues.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => {
    assertCurrentWrite(isCurrent);
    const path = store.personalMemoryPath();
    const contract = jsonDataContract(path, store.settings.folders);
    validateJsonData(document, path, contract);
    validateRecords(document);
    const snapshot = document[personalMemoryReadSnapshot];
    if (!snapshot) conflict();
    const next = `${JSON.stringify({ ...document, updatedAt: new Date().toISOString() }, null, 2)}\n`;
    if (await rawFile(store) !== snapshot.raw) conflict();
    assertCurrentWrite(isCurrent);
    const file = store.getFile(path);
    if (file) {
      await store.app.vault.process(file, text => {
        assertCurrentWrite(isCurrent);
        if (text !== snapshot.raw) conflict();
        parseJsonData(text, path, contract);
        return next;
      });
    } else {
      await store.ensureFolder(path.split("/").slice(0, -1).join("/"));
      assertCurrentWrite(isCurrent);
      await store.app.vault.create(path, next);
    }
    if (await rawFile(store) !== next) throw new Error("个人记忆写入后读回校验失败；请先核对当前记录。");
    document[personalMemoryReadSnapshot] = { raw: next };
  });
  queues.set(key, pending);
  try { await pending; } finally { if (queues.get(key) === pending) queues.delete(key); }
}
