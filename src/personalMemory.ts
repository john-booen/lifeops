import { createHash } from "node:crypto";

export type PersonalMemoryKind =
  | "core_profile"
  | "current_state"
  | "episode"
  | "pattern_candidate"
  | "user_rule";

export type PersonalMemoryStatus = "candidate" | "active" | "forgotten";
export type PersonalMemoryTruth = "explicit_fact" | "inference";

export interface PersonalMemorySourceRef {
  sourceId: string;
  path: string;
  capturedAt: string;
  excerptHash?: string;
  /** SHA-256 of the complete original file, never an excerpt or mutable Ledger. */
  contentHash?: string;
  extractionVersion?: string;
  observedDate?: string;
  excerpt?: string;
}

export interface PersonalMemoryRevision {
  content: string;
  changedAt: string;
  reason: "corrected" | "superseded";
}

export interface PersonalMemoryRecord {
  [personalMemorySourceAssessment]?: { usable: boolean; reason: string; verifiedSourceIds: string[]; contextSources?: PersonalMemoryContextSource[] };
  id: string;
  kind: PersonalMemoryKind;
  content: string;
  status: PersonalMemoryStatus;
  truth: PersonalMemoryTruth;
  sensitive: boolean;
  confidence: number;
  sourceRefs: PersonalMemorySourceRef[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  archivedAt?: string;
  confirmedAt?: string;
  summarySource?: { settingsRevision: string };
  revisions: PersonalMemoryRevision[];
  tags: string[];
  sourceBinding?: { version: 1; dependenciesHash: string };
  confirmationReceipt?: { version: 1; memoryId: string; contentHash: string; operationId: string; confirmedAt: string; sourcePath: string; sourceDependenciesHash?: string };
  suppression?: { version: 1; contentHashes: string[]; contentLengths?: Record<string, number>; contentFingerprints?: Record<string, number>; recordedAt: string };
}

/** Ephemeral source projection, assessed against the current source policy. */
export interface PersonalMemoryContextSource {
  ref: PersonalMemorySourceRef;
  basis: "confirmation" | "correction" | "receipt" | "fixed_version" | "legacy_existing" | "summary";
}

export interface PersonalMemoryDocument {
  [personalMemoryReadSnapshot]?: { raw: string | null };
  [key: string]: unknown;
  version: 1;
  updatedAt: string;
  records: PersonalMemoryRecord[];
}

// Carried by object spread, omitted from JSON and durable undo descriptors.
export const personalMemoryReadSnapshot = Symbol("lifeops-personal-memory-read-snapshot");
export const personalMemorySourceAssessment = Symbol("lifeops-personal-memory-source-assessment");

export interface PersonalMemoryInput {
  id?: string;
  kind: PersonalMemoryKind;
  content: string;
  truth?: PersonalMemoryTruth;
  sensitive?: boolean;
  confidence?: number;
  sourceRefs?: PersonalMemorySourceRef[];
  expiresAt?: string;
  tags?: string[];
}

export type PersonalMemoryReview =
  | { decision: "confirm"; sourceRef?: PersonalMemorySourceRef }
  | { decision: "correct"; content: string; sourceRef?: PersonalMemorySourceRef }
  | { decision: "forget" };

export function emptyPersonalMemoryDocument(now = new Date().toISOString()): PersonalMemoryDocument {
  return { version: 1, updatedAt: now, records: [] };
}

export function createPersonalMemory(
  input: PersonalMemoryInput,
  now = new Date().toISOString()
): PersonalMemoryRecord {
  const content = input.content.replace(/\s+/g, " ").trim();
  const truth = input.truth ?? "explicit_fact";
  const sensitive = input.sensitive ?? isSensitivePersonalMemory(content);
  // Extraction is an observation, never proof of a user's confirmation.
  const status: PersonalMemoryStatus = "candidate";
  const sourceRefs = dedupeSources(input.sourceRefs ?? []);
  const dependenciesHash = personalMemoryDependenciesHash(sourceRefs);
  return {
    id: input.id ?? (dependenciesHash ? `personal_note_v1_${memoryContentHash(`${input.kind}:${content}:${dependenciesHash}`)}` : `personal_${hashText(`${input.kind}:${content}`).slice(0, 12)}`),
    kind: input.kind,
    content,
    status,
    truth,
    sensitive,
    confidence: clamp01(input.confidence ?? (truth === "explicit_fact" ? 0.88 : 0.55)),
    sourceRefs,
    ...(dependenciesHash ? { sourceBinding: { version: 1 as const, dependenciesHash } } : {}),
    createdAt: now,
    updatedAt: now,
    expiresAt: input.expiresAt,
    revisions: [],
    tags: Array.from(new Set(input.tags ?? []))
  };
}

export function upsertPersonalMemoryRecord(
  records: PersonalMemoryRecord[],
  incoming: PersonalMemoryRecord,
  now = new Date().toISOString()
): PersonalMemoryRecord[] {
  if (findMemorySuppression(records, incoming.content)) return records;
  incoming = { ...incoming, status: "candidate", confirmedAt: undefined, confirmationReceipt: undefined,
    [personalMemorySourceAssessment]: undefined };
  const existing = records.find((record) => record.id === incoming.id);
  if (!existing) return [...records, incoming].sort(sortMemoryRecords);
  if (incoming.sourceBinding && existing.sourceBinding?.dependenciesHash === incoming.sourceBinding.dependenciesHash
    && existing.kind === incoming.kind && existing.content === incoming.content) return records;
  if (existing.status === "forgotten") {
    // A reused source ID cannot replace the durable suppression marker.
    return upsertPersonalMemoryRecord(records, {
      ...incoming, id: `${existing.id}_candidate_${hashText(`${incoming.kind}:${incoming.content}`)}`
    }, now);
  }
  const changed = existing.content !== incoming.content;
  if (existing.status === "active") {
    if (changed || existing.kind !== incoming.kind || incoming.sourceBinding?.dependenciesHash !== existing.sourceBinding?.dependenciesHash) {
      // Retain a conflicting observation separately; it cannot inherit approval.
      const candidate = { ...incoming, id: `${existing.id}_candidate_${hashText(`${incoming.kind}:${incoming.content}:${incoming.sourceBinding?.dependenciesHash ?? ""}`)}`,
        status: "candidate" as const, confirmedAt: undefined };
      return upsertPersonalMemoryRecord(records, candidate, now);
    }
    const merged = { ...existing, sourceRefs: dedupeSources([...existing.sourceRefs, ...incoming.sourceRefs]),
      tags: Array.from(new Set([...existing.tags, ...incoming.tags])), sensitive: existing.sensitive || incoming.sensitive,
      updatedAt: now, [personalMemorySourceAssessment]: undefined };
    return records.map(record => record.id === existing.id ? merged : record).sort(sortMemoryRecords);
  }
  const merged: PersonalMemoryRecord = {
    ...existing,
    ...incoming,
    status: "candidate",
    confirmedAt: undefined,
    confirmationReceipt: undefined,
    [personalMemorySourceAssessment]: undefined,
    sourceRefs: dedupeSources([...existing.sourceRefs, ...incoming.sourceRefs]),
    createdAt: existing.createdAt,
    updatedAt: now,
    revisions: changed
      ? [...existing.revisions, { content: existing.content, changedAt: now, reason: "superseded" }]
      : existing.revisions
  };
  return [...records.filter((record) => record.id !== incoming.id), merged].sort(sortMemoryRecords);
}

export function reviewPersonalMemoryRecord(
  records: PersonalMemoryRecord[],
  id: string,
  review: PersonalMemoryReview,
  now = new Date().toISOString()
): PersonalMemoryRecord[] {
  const existing = records.find((record) => record.id === id);
  if (!existing) return records;
  if (review.decision === "forget") {
    if (existing.status === "forgotten") return records;
    const hashes = new Set([existing.content, ...existing.revisions.map(revision => revision.content)].map(memoryContentHash));
    return retireMatchingMemories(records, hashes, now);
  }
  if (existing.status === "forgotten") throw new Error("这条记忆已被遗忘，不会通过普通确认重新启用。需要恢复时请先核对或撤销原遗忘操作。");
  const corrected = review.decision === "correct"
    ? review.content.replace(/\s+/g, " ").trim()
    : existing.content;
  if (!corrected.trim()) throw new Error("纠正后的记忆内容不能为空");
  if (findMemorySuppression(records, corrected)) throw new Error("这段内容已被遗忘或纠正，不能通过普通确认或纠正重新启用。请先核对或撤销原操作。");
  const sourceRefs = dedupeSources([...existing.sourceRefs, ...(review.sourceRef ? [review.sourceRef] : [])]);
  if (!sourceRefs.some(isUsableMemorySource)) throw new Error("这条记忆缺少可回溯来源，请重新确认内容及来源后再保存。");
  const next: PersonalMemoryRecord = {
    ...existing,
    content: corrected,
    status: "active",
    truth: "explicit_fact",
    sensitive: existing.sensitive || isSensitivePersonalMemory(corrected),
    sourceRefs,
    confidence: Math.max(existing.confidence, 0.9),
    confirmedAt: now,
    confirmationReceipt: review.sourceRef?.sourceId.startsWith("confirmed:") && isUsableMemorySource(review.sourceRef)
      ? { version: 1, memoryId: existing.id, contentHash: memoryContentHash(corrected),
        operationId: review.sourceRef.sourceId, confirmedAt: now, sourcePath: review.sourceRef.path,
        ...(existing.sourceBinding ? { sourceDependenciesHash: existing.sourceBinding.dependenciesHash } : {}) }
      : undefined,
    [personalMemorySourceAssessment]: undefined,
    updatedAt: now,
    revisions: review.decision === "correct" && memoryContentHash(corrected) !== memoryContentHash(existing.content)
      ? [...existing.revisions, { content: existing.content, changedAt: now, reason: "corrected" }]
      : existing.revisions
  };
  const superseded = new Set(next.revisions.filter(revision => revision.reason === "corrected").map(revision => memoryContentHash(revision.content)));
  const others = retireMatchingMemories(records.filter(record => record.id !== id), superseded, now, memoryContentHash(corrected));
  return [...others, next].sort(sortMemoryRecords);
}

/** Scrub all matching copies and their old revisions in one authority write.
 * Closure makes deletion independent of record ordering and duplicate history. */
function retireMatchingMemories(
  records: PersonalMemoryRecord[], hashes: Set<string>, now: string, protectedHash?: string
): PersonalMemoryRecord[] {
  const contentLengths: Record<string, number> = {};
  const contentFingerprints: Record<string, number> = {};
  for (const record of records) {
    for (const content of [record.content, ...record.revisions.map(revision => revision.content)]) {
      contentLengths[memoryContentHash(content)] = normalizeMemoryContent(content).length;
      contentFingerprints[memoryContentHash(content)] = memoryMatchFingerprint(normalizeMemoryContent(content));
    }
  }
  const retired = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (record.status === "forgotten" || retired.has(record.id) || !hashes.has(memoryContentHash(record.content))) continue;
      retired.add(record.id);
      changed = true;
      for (const revision of record.revisions) {
        const hash = memoryContentHash(revision.content);
        if (hash !== protectedHash) hashes.add(hash);
      }
    }
  }
  return records.map(record => retired.has(record.id)
    ? { ...record, status: "forgotten" as const, content: "（已停止使用的个人记忆）", sourceRefs: [], revisions: [], tags: [],
      confirmedAt: undefined, confirmationReceipt: undefined, sourceBinding: undefined, [personalMemorySourceAssessment]: undefined,
      expiresAt: undefined, archivedAt: undefined, summarySource: undefined, updatedAt: now,
      suppression: { version: 1 as const, contentHashes: [...hashes],
        contentLengths: Object.fromEntries([...hashes].filter(hash => contentLengths[hash]).map(hash => [hash, contentLengths[hash]])),
        contentFingerprints: Object.fromEntries([...hashes].filter(hash => contentLengths[hash]).map(hash => [hash, contentFingerprints[hash]])), recordedAt: now } }
    : record);
}

function isUsableMemorySource(source: PersonalMemorySourceRef): boolean {
  return Boolean(source.sourceId.trim() && source.path.trim() && Number.isFinite(Date.parse(source.capturedAt)));
}

export function canPromotePattern(record: PersonalMemoryRecord): boolean {
  return record.kind === "pattern_candidate"
    && record.status === "candidate"
    && record.sourceRefs.length >= 3
    && record.confidence >= 0.72;
}

export function selectPersonalMemories(
  records: PersonalMemoryRecord[],
  query = "",
  maxCount = 12,
  now = new Date(),
  lastUsed?: ReadonlyMap<string, number>
): PersonalMemoryRecord[] {
  const terms = searchTerms(query);
  return records
    .filter((record) => record.status === "active" && !record.archivedAt)
    .filter((record) => record[personalMemorySourceAssessment]?.usable !== false)
    .filter((record) => !findMemorySuppression(records, record.content))
    .filter((record) => record.truth === "explicit_fact" && (Number.isFinite(Date.parse(record.confirmedAt ?? ""))
      || !!record.summarySource && record[personalMemorySourceAssessment]?.usable === true))
    .filter((record) => record.sourceRefs.some(isUsableMemorySource))
    .filter((record) => !record.expiresAt || Date.parse(record.expiresAt) > now.getTime())
    .map((record) => ({
      record,
      score: baseScore(record) + recencyScore(lastUsed?.get(record.id), now) + terms.reduce(
        (score, term) => score + (searchableMemory(record).includes(term) ? 0.18 : 0),
        0
      )
    }))
    .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt))
    .slice(0, maxCount)
    .map(({ record }) => record);
}

function recencyScore(lastUsed: number | undefined, now: Date): number {
  if (lastUsed === undefined) return 0;
  return 0.15 * Math.max(0, 1 - Math.max(0, now.getTime() - lastUsed) / (7 * 86_400_000));
}

export function archiveExpiredMemories(records: PersonalMemoryRecord[], now: Date): PersonalMemoryRecord[] {
  return records.map(record => record.status !== "forgotten" && !record.archivedAt && record.expiresAt
    && Date.parse(record.expiresAt) <= now.getTime() ? { ...record, archivedAt: now.toISOString() } : record);
}

export function personalMemoryOrigin(record: PersonalMemoryRecord): string {
  if (record.summarySource) return "摘要";
  if (record.sourceRefs.some(source => /^(?:confirmed:)?conversation:/.test(source.sourceId))) return "对话";
  return record.sourceRefs.length ? "笔记或手动记录" : "手动记录";
}

export function personalMemoriesToMarkdown(records: PersonalMemoryRecord[], sourceView: "all" | "verified" = "all"): string {
  records = selectPersonalMemories(records, "", records.length);
  if (records.length === 0) return "";
  const groups: Array<[PersonalMemoryKind, string]> = [
    ["core_profile", "核心画像"],
    ["current_state", "已确认状态记录"],
    ["user_rule", "用户规则"],
    ["episode", "已确认事件记录"],
    ["pattern_candidate", "已确认模式"]
  ];
  return groups.map(([kind, label]) => {
    const items = records.filter((record) => record.kind === kind);
    if (items.length === 0) return "";
    return [
      `### ${label}`,
      ...items.map((record) => {
        const projected = verifiedPersonalMemoryContextSources(record);
        const sources = sourceView === "verified" ? record.sourceRefs.filter(ref => projected.some(source => source.ref.sourceId === ref.sourceId && source.ref.path === ref.path)) : record.sourceRefs;
        const basisLabels: Record<PersonalMemoryContextSource["basis"], string> = {
          confirmation: "当前正文的确认操作已核验",
          correction: "当前正文的更正确认操作已核验",
          receipt: "当前正文的持久确认凭据已核验；当前日志未保留该操作，不能据此推断更正过程",
          summary: "由日摘要自动提炼，仍可由用户核对",
          fixed_version: "原始文件版本未变；不单独证明当前正文含义或事件时间",
          legacy_existing: "旧来源文件存在；不单独证明当前正文来自该文件或其中状态仍持续"
        };
        return [
        `- ${record.content}`,
        `  - id: ${record.id}`,
        `  - truth: ${record.truth}`,
        // A ranking score is not a probability about the user's stated fact.
        // Keep it in the audit view and canonical record, outside chat evidence.
        sourceView === "all" ? `  - confidence: ${record.confidence.toFixed(2)}` : "",
        record.summarySource && !record.confirmedAt ? `  - 自动从摘要记下: ${record.createdAt}`
          : `  - 确认时间: ${record.confirmedAt}（确认或最近纠正记录，不代表事件发生或状态更新）`,
        sourceView === "verified" ? `  - 当前来源核验: ${projected.length ? projected.map(source => `${source.ref.path}（${basisLabels[source.basis]}）`).join("；") : "未提供可核验的来源说明，不推断确认或更正过程"}` : "",
        sources.length ? `  - 原记录日期: ${sources.map((source) => `${source.path}：${source.observedDate ?? "未注明"}`).join("；")}（原记录日期不等于事件发生日）` : "",
        record.kind === "current_state" || record.kind === "episode"
          ? "  - 事件日期: 未核对；以原文中的时间和用户说明为准，读取或确认时间不能替代事件时间。"
          : "",
        record.kind === "current_state"
          ? `  - 状态有效期: ${record.expiresAt ? `记忆使用截至 ${record.expiresAt}` : "未设置"}；这不证明该状态现在仍持续。`
          : "",
        sources.length > 0
          ? `  - sources: ${sources.map((source) => `${source.path}@${source.capturedAt}（来源采集／登记时间）`).join(", ")}`
          : ""
      ].filter(Boolean).join("\n"); })
    ].join("\n");
  }).filter(Boolean).join("\n\n");
}

/** Never derive source meaning from IDs, revisions, or a confirmation clock. */
export function verifiedPersonalMemoryContextSources(record: PersonalMemoryRecord): PersonalMemoryContextSource[] {
  const assessment = record[personalMemorySourceAssessment];
  if (assessment?.usable !== true) return [];
  const ids = new Map<string, number>();
  for (const ref of record.sourceRefs) ids.set(ref.sourceId, (ids.get(ref.sourceId) ?? 0) + 1);
  return (assessment.contextSources ?? []).filter(source => ids.get(source.ref.sourceId) === 1
    && (assessment.verifiedSourceIds.includes(source.ref.sourceId) || source.basis === "fixed_version" && source.ref.contentHash !== undefined)
    && record.sourceRefs.some(ref => ref.sourceId === source.ref.sourceId && ref.path === source.ref.path));
}

export function memoryContentHash(content: string): string {
  return createHash("sha256").update(normalizeMemoryContent(content), "utf8").digest("hex");
}

export function normalizeMemoryContent(content: string): string {
  return content.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

/** Fast rolling prefilter only; SHA-256 still decides every suppression match. */
export function memoryMatchFingerprint(normalized: string): number {
  let value = 0;
  for (let index = 0; index < normalized.length; index += 1) value = (Math.imul(value, 31) + normalized.charCodeAt(index)) >>> 0;
  return value;
}

export function findMemorySuppression(records: PersonalMemoryRecord[], content: string): PersonalMemoryRecord | undefined {
  const hash = memoryContentHash(content);
  return records.find(record => record.status === "forgotten" && record.suppression?.contentHashes.includes(hash))
    ?? records.find(record => record.revisions.some(revision => revision.reason === "corrected" && memoryContentHash(revision.content) === hash)
      && memoryContentHash(record.content) !== hash);
}

export function personalMemoryReviewToMarkdown(records: PersonalMemoryRecord[]): string {
  const candidates = records.filter((record) => record.status === "candidate");
  return [
    "# LifeOps 个人记忆审查",
    "",
    `待确认：${candidates.length} 条`,
    "",
    ...candidates.map((record) => [
      `## ${record.content}`,
      `- id: ${record.id}`,
      `- kind: ${record.kind}`,
      `- truth: ${record.truth}`,
      `- sensitive: ${record.sensitive}`,
      `- confidence: ${record.confidence.toFixed(2)}`,
      `- evidenceCount: ${record.sourceRefs.length}`,
      record.sourceRefs.length > 0
        ? `- sources: ${record.sourceRefs.map((source) => source.path).join(", ")}`
        : "- sources: none",
      ""
    ].join("\n"))
  ].join("\n");
}

export function inferExplicitPersonalMemory(
  text: string,
  source: PersonalMemorySourceRef
): PersonalMemoryRecord | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (/[“”「」『』"`]/.test(normalized)
    || /(?:不要|不用|别|不想).{0,8}(?:记住|保存|记入|记录)|(?:只是举例|这是示例|不要当真|不代表我)/.test(normalized)) return null;
  if (/(?:请|你要)?记住|以后(?:请|不要)|不要再|我希望你/.test(normalized)) {
    return createPersonalMemory({
      kind: "user_rule",
      content: normalized,
      truth: "explicit_fact",
      sourceRefs: [source],
      tags: ["explicit-rule"]
    }, source.capturedAt);
  }
  if (/我(?:喜欢|偏好|不喜欢|习惯|通常|更喜欢)/.test(normalized)) {
    return createPersonalMemory({
      kind: "core_profile",
      content: normalized,
      truth: "explicit_fact",
      sourceRefs: [source],
      tags: ["explicit-profile"]
    }, source.capturedAt);
  }
  if (/我(?:最近|这段时间|目前|现在)(?:正在|一直|有点|比较|处于|想要)/.test(normalized)) {
    return createPersonalMemory({
      kind: "current_state",
      content: normalized,
      truth: "explicit_fact",
      sourceRefs: [source],
      expiresAt: new Date(Date.parse(source.capturedAt) + 14 * 86_400_000).toISOString(),
      tags: ["explicit-state"]
    }, source.capturedAt);
  }
  return null;
}

export function isSensitivePersonalMemory(content: string): boolean {
  return /(疾病|诊断|药物|用药|抑郁|焦虑|银行|账户|密码|身份证|收入|亏损|仓位|债务|性取向|亲密关系)/.test(content);
}

function baseScore(record: PersonalMemoryRecord): number {
  if (record.kind === "core_profile") return 1;
  if (record.kind === "user_rule") return 0.96;
  if (record.kind === "current_state") return 0.82;
  if (record.kind === "pattern_candidate") return 0.72;
  return 0.62;
}

function searchableMemory(record: PersonalMemoryRecord): string {
  return `${record.content} ${record.kind} ${record.tags.join(" ")}`.toLowerCase();
}

function searchTerms(query: string): string[] {
  return Array.from(new Set(query.toLowerCase().split(/[\s,，。；;:：、！？!?]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)));
}

function dedupeSources(sources: PersonalMemorySourceRef[]): PersonalMemorySourceRef[] {
  const map = new Map<string, PersonalMemorySourceRef>();
  for (const source of sources) {
    const key = `${source.sourceId}:${source.path}:${source.capturedAt}`;
    const previous = map.get(key);
    if (previous && (previous.contentHash !== source.contentHash || previous.extractionVersion !== source.extractionVersion
      || previous.observedDate !== source.observedDate || previous.excerptHash !== source.excerptHash || previous.excerpt !== source.excerpt)) {
      throw new Error("同一记忆来源的版本声明冲突，已停止合并；请重新核对。");
    }
    map.set(key, source);
  }
  return [...map.values()].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
}

export function personalMemoryDependenciesHash(sources: PersonalMemorySourceRef[]): string | undefined {
  const dependencies = sources.filter(source => source.contentHash !== undefined);
  if (!dependencies.length) return undefined;
  const rows = dependencies.map(source => [source.sourceId, source.path, source.contentHash, source.extractionVersion,
    source.observedDate ?? "", source.excerptHash ?? ""]);
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex");
}

function sortMemoryRecords(left: PersonalMemoryRecord, right: PersonalMemoryRecord): number {
  return left.kind.localeCompare(right.kind) || right.updatedAt.localeCompare(left.updatedAt);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
