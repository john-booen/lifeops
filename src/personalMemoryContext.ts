import { createHash } from "node:crypto";
import { memoryMatchFingerprint, normalizeMemoryContent, personalMemorySourceAssessment, personalMemoriesToMarkdown, selectPersonalMemories, verifiedPersonalMemoryContextSources, type PersonalMemoryRecord } from "./personalMemory";
import { readPersonalMemoryWithSources } from "./personalMemorySources";
import { isVaultPathExcluded } from "./privacy";
import type { StoreHost } from "./store/settingsSlice";

export const MEMORY_CONTEXT_OMISSION = "（已省略暂不可使用的历史片段，以可核对的已确认个人记忆为准。）";

export function personalMemoryHistoryNeedsEvidence(records: PersonalMemoryRecord[], store: StoreHost): boolean {
  // Candidates retain the boundary if a first confirmation is undone.
  // Unknown paraphrases cannot safely be matched against tombstone hashes.
  return records.length > 0 || !!store.settings.privacy?.excludedVaultPrefixes?.length;
}

/** Conversation files have no per-turn generation proof. Keep the originals
 * available locally, but never rebuild stale assistant paraphrases from them
 * when memory or source permissions require a checked history generation. */
export function createPersonalMemorySourceFilter(records: PersonalMemoryRecord[], store: StoreHost): (path: string, text: string) => string {
  const protect = createPersonalMemoryContextFilter(records);
  const conversations = store.path(store.settings.folders.aiReports, "Conversations");
  const requiresEvidence = personalMemoryHistoryNeedsEvidence(records, store);
  return (path, text) => requiresEvidence && path.startsWith(conversations + "/") ? MEMORY_CONTEXT_OMISSION : protect(text);
}

/** Always state availability: an omitted empty section lets models mistake
 * assistant defaults or withheld history for confirmed user preferences. */
export function formatConfirmedPersonalMemoryContext(records: PersonalMemoryRecord[], query = "", maxRecordBytes = Infinity, maxRecords = 12): string {
  const candidates = selectPersonalMemories(records, query, records.length);
  // Under a finite prompt budget, retain explicit scheduling/behavioral
  // constraints before long profile background. Preserve relevance order
  // within each group and never send a clipped fact as a complete rule.
  if (Number.isFinite(maxRecordBytes)) candidates.sort((a, b) => Number(b.kind === "user_rule") - Number(a.kind === "user_rule"));
  let used = 0, count = 0;
  const selected = candidates.filter(record => {
    const bytes = Buffer.byteLength(personalMemoriesToMarkdown([record], "verified"), "utf8");
    if (count >= maxRecords || used + bytes > maxRecordBytes) return false;
    used += bytes; count++; return true;
  });
  const omitted = candidates.length - selected.length;
  const automatic = selected.filter(record => record.summarySource && !record.confirmedAt).length;
  return [
    "## Confirmed Personal Memory",
    `本轮可用的已确认个人记忆：${selected.length - automatic}条。`,
    ...(automatic ? [`另有 ${automatic} 条从日摘要自动提炼、已逐字核对原始陈述的记忆。引用时注明原始来源，以用户的说明为准。`] : []),
    "仅以下当前可用记录可作为本轮个人记忆，区分本人确认和原文自动提取；记录可用不代表其中的状态现在仍存在。助手表达规则 和系统表达要求是助手的回复策略，不是用户事实，不能由助手默认表达风格推导用户偏好。",
    "区分原记录日期、来源采集或登记时间、确认时间和事件时间。内容中的今天、昨天、最近应以该内容对应的叙述时点理解，不能改以读取或确认日期为基准；补记及后来纠正不能只凭来源记录日期确定事件日，内容时点不清楚时应说明无法确定。未设置状态有效期不能证明状态一直持续，也不能自行给记忆设定失效日期。",
    selected.length
      ? personalMemoriesToMarkdown(selected, "verified")
      : omitted ? "本轮没有完整放入相关记忆，不能据此说记忆不存在；可按主题查询当前记录。"
        : "本轮没有可用的已确认个人记忆。询问既有偏好时，应说明当前没有可确认的记录，不得声称记得或已确认某项偏好。",
    ...(omitted ? [`另有${omitted}条可用记忆因本轮长度或条数上限未放入；没有截断其中的事实，需要时按主题查询。`] : []),
    "只查既有记忆时按当前可用结果收尾，不把缺记录转成要求用户补充、重新确认或重新声明偏好。",
    "未提供的偏好不能推断。正常回复只表达事实、易懂的来源名称和必要的记录日期，不展示内部ID、置信度或技术时间戳；用户明确核查技术信息时除外。"
  ].join("\n\n");
}

/** Tool reads obey their full response budget and keep fact/source blocks whole.
 * Missing space is an explicit omission, never a partial confirmed statement. */
export function formatPersonalMemoryExcerpt(records: PersonalMemoryRecord[], query: string, maxChars: number, maxRecords = 12): string {
  const candidates = selectPersonalMemories(records, query, records.length);
  if (!candidates.length) return "";
  const render = (selected: PersonalMemoryRecord[]) => [
    "## Confirmed Personal Memory",
    `本轮完整显示${selected.length}条可用记忆。`,
    selected.length ? personalMemoriesToMarkdown(selected, "verified") : "本轮长度内未能放入完整记录；这不代表记忆不存在。",
    ...(selected.length < candidates.length ? [`另有${candidates.length - selected.length}条可用记忆未放入；可缩小关键词或提高读取长度，不能把本次结果当成完整记忆清单。`] : [])
  ].join("\n\n");
  const selected: PersonalMemoryRecord[] = [];
  for (const record of candidates) {
    if (selected.length >= maxRecords) break;
    if (render([...selected, record]).length <= maxChars) selected.push(record);
  }
  return render(selected);
}

/** Partial prepared-context diagnostics only. Do not feed these Ledger/source
 * paths back into action snapshots. A complete record block must survive
 * trimming; separate fact/id/path matches can come from unrelated text. */
export function confirmedMemoryContextSourcePaths(
  records: PersonalMemoryRecord[], query: string, context: string, excludedPrefixes: string[] = []
): string[] {
  const paths = new Set<string>();
  for (const record of selectPersonalMemories(records, query, records.length)) {
    const assessment = record[personalMemorySourceAssessment];
    if (assessment?.usable !== true) continue;
    const rendered = personalMemoriesToMarkdown([record], "verified");
    const block = rendered.slice(rendered.indexOf("\n") + 1);
    if (!block || !context.includes(block)) continue;
    const projected = verifiedPersonalMemoryContextSources(record);
    for (const ref of record.sourceRefs.filter(ref => projected.some(source => source.ref.sourceId === ref.sourceId && source.ref.path === ref.path))) {
      const path = ref.path;
      if (!path || path.length > 240 || path !== path.trim() || /^(?:\/|~|[a-z][a-z\d+.-]*:)/i.test(path) || /[\\\u0000-\u001f]/.test(path)
        || path.split("/").some(part => !part || part === "." || part === "..") || isVaultPathExcluded(path, excludedPrefixes)) continue;
      paths.add(path);
      if (paths.size === 20) return [...paths];
    }
  }
  return [...paths];
}

/** Filter automatic context only. Original notes and the user's current message
 * are never edited. Hashes plus lengths allow matching tombstones without
 * persisting the forgotten text again. This is exact normalized matching. */
export function createPersonalMemoryContextFilter(records: PersonalMemoryRecord[]): (text: string) => string {
  const corrected = [...records.filter(record => record.status === "active" && record[personalMemorySourceAssessment]?.usable === false).map(record => normalizeMemoryContent(record.content)),
    ...records.flatMap(record => record.revisions
    .filter(revision => revision.reason === "corrected" && normalizeMemoryContent(revision.content) !== normalizeMemoryContent(record.content))
    .map(revision => normalizeMemoryContent(revision.content)))].filter(Boolean);
  const hashesByLength = new Map<number, Set<string>>();
  const fingerprintsByLength = new Map<number, Set<number>>();
  const slowLengths = new Set<number>();
  let legacyTombstone = false;
  for (const record of records.filter(record => record.status === "forgotten")) {
    for (const hash of record.suppression?.contentHashes ?? []) {
      const length = record.suppression?.contentLengths?.[hash];
      if (!length) { legacyTombstone = true; continue; }
      const hashes = hashesByLength.get(length) ?? new Set<string>();
      hashes.add(hash); hashesByLength.set(length, hashes);
      const fingerprint = record.suppression?.contentFingerprints?.[hash];
      if (fingerprint === undefined) slowLengths.add(length);
      else {
        const fingerprints = fingerprintsByLength.get(length) ?? new Set<number>();
        fingerprints.add(fingerprint); fingerprintsByLength.set(length, fingerprints);
      }
    }
  }
  const containsSuppressed = (text: string): boolean => {
    const normalized = normalizeMemoryContent(text);
    if (corrected.some(content => normalized.includes(content))) return true;
    for (const [length, hashes] of hashesByLength) {
      if (length > normalized.length) continue;
      let fingerprint = memoryMatchFingerprint(normalized.slice(0, length));
      let power = 1;
      for (let index = 1; index < length; index += 1) power = Math.imul(power, 31) >>> 0;
      for (let start = 0; start <= normalized.length - length; start += 1) {
        if (slowLengths.has(length) || fingerprintsByLength.get(length)?.has(fingerprint)) {
          const hash = createHash("sha256").update(normalized.slice(start, start + length), "utf8").digest("hex");
          if (hashes.has(hash)) return true;
        }
        if (start + length < normalized.length) {
          fingerprint = (Math.imul((fingerprint - Math.imul(normalized.charCodeAt(start), power)) >>> 0, 31) + normalized.charCodeAt(start + length)) >>> 0;
        }
      }
    }
    return false;
  };
  return (text: string): string => {
    if (!text || (!corrected.length && !hashesByLength.size && !legacyTombstone)) return text;
    // Older tombstones have no match length. Do not guess which source is safe.
    if (legacyTombstone) return MEMORY_CONTEXT_OMISSION;
    if (!containsSuppressed(text)) return text;
    const blocks = text.split(/\n\s*\n/);
    const filtered = blocks.map(block => containsSuppressed(block) ? MEMORY_CONTEXT_OMISSION : block).join("\n\n");
    // A phrase split across paragraphs must not escape the per-block check.
    return containsSuppressed(filtered) ? MEMORY_CONTEXT_OMISSION : filtered;
  };
}

export function personalMemoryContextRevision(records: PersonalMemoryRecord[], now = new Date()): string {
  return createHash("sha256").update(JSON.stringify(records.filter(record => record.status !== "candidate" || record.revisions.length)
    .map(record => ({ id: record.id, content: record.content, status: record.status, truth: record.truth,
      confirmedAt: record.confirmedAt, expiresAt: record.expiresAt, archivedAt: record.archivedAt, summarySource: record.summarySource,
      expired: record.expiresAt ? !(Date.parse(record.expiresAt) > now.getTime()) : false,
      sourceRefs: record.sourceRefs, sourceAssessment: record[personalMemorySourceAssessment] ? {
        usable: record[personalMemorySourceAssessment]!.usable, verifiedSourceIds: record[personalMemorySourceAssessment]!.verifiedSourceIds,
        contextSources: record[personalMemorySourceAssessment]!.contextSources
      } : undefined, revisions: record.revisions, suppression: record.suppression }))
    .sort((a, b) => a.id.localeCompare(b.id)))).digest("hex");
}

/** Apply at automatic source-context exits; the canonical memory remains a
 * separate trusted input, including when legacy history must be withheld. */
export function guardPersonalMemorySourceContexts(prototype: object): void {
  const target = prototype as Record<string, (this: StoreHost, ...args: unknown[]) => Promise<string>>;
  for (const name of ["buildContext", "buildRetrievalContext",
    "buildKnowledgeContext", "buildKnowledgeGraphContext", "buildKnowledgeTopicContext", "buildSemanticContext", "buildTradingContext", "buildProjectContext"]) {
    const original = target[name];
    if (typeof original !== "function") throw new Error(`Missing context method: ${name}`);
    target[name] = async function(this: StoreHost, ...args: unknown[]) {
      const context = await original.apply(this, args);
      return createPersonalMemoryContextFilter((await readPersonalMemoryWithSources(this)).records)(context);
    };
  }
}
