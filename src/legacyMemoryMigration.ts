import { createHash } from "node:crypto";
import { createPersonalMemoryContextFilter } from "./personalMemoryContext";
import { memoryContentHash, type PersonalMemoryRecord } from "./personalMemory";
import { isVaultPathExcluded } from "./privacy";

export type LegacyMemorySourceKind = "index" | "conversation" | "markdown";
export interface LegacyMemorySnapshot {
  kind: LegacyMemorySourceKind;
  path: string;
  /** Exact snapshot bytes decoded as UTF-8. The caller must bound the read first. */
  text?: string;
  unavailable?: "missing" | "excluded" | "too_large" | "unreadable";
  /** Exact built-in empty template, not a heuristic for user-written text. */
  emptyTemplate?: string;
}
export const LEGACY_MEMORY_PREVIEW_LIMITS = Object.freeze({ sources: 8, entries: 500, sourceBytes: 512 * 1024, totalBytes: 1024 * 1024, previewChars: 1200 });
export interface LegacyMemoryPreviewSource {
  kind: LegacyMemorySourceKind;
  path: string;
  sha256?: string;
  status: "read" | "empty" | "missing" | "excluded" | "too_large" | "unreadable" | "invalid" | "unsupported" | "limit";
  entries: number;
  ignored: number;
  invalid: number;
}
export interface LegacyMemoryPreviewItem {
  id: string;
  status: "review" | "already_present" | "suppressed";
  /** Suppressed text is absent even when nested in a larger historical block. */
  preview?: string;
  truncated: boolean;
  occurrences: Array<{ source: number; position: number }>;
}
export interface LegacyMemoryMigrationPreview {
  version: 1;
  mode: "readonly_preview";
  complete: boolean;
  sources: LegacyMemoryPreviewSource[];
  items: LegacyMemoryPreviewItem[];
  counts: { reviewedEntries: number; unique: number; duplicates: number; suppressed: number; alreadyPresent: number; pendingReview: number; omittedSources: number };
}

/** No writes, generated timestamps, inferred facts or executable migration plan.
 * Repeating identical snapshots yields identical output. Existing authority and
 * source files remain separate; equality does not approve or merge a source. */
export function previewLegacyMemoryMigration(
  snapshots: readonly LegacyMemorySnapshot[],
  records: readonly PersonalMemoryRecord[],
  allowedSources: readonly Pick<LegacyMemorySnapshot, "kind" | "path">[],
  excludedPrefixes: string[] = []
): LegacyMemoryMigrationPreview {
  const limits = LEGACY_MEMORY_PREVIEW_LIMITS;
  const result: LegacyMemoryMigrationPreview = { version: 1, mode: "readonly_preview", complete: true, sources: [], items: [],
    counts: { reviewedEntries: 0, unique: 0, duplicates: 0, suppressed: 0, alreadyPresent: 0, pendingReview: 0, omittedSources: Math.max(0, snapshots.length - limits.sources) } };
  const protect = createPersonalMemoryContextFilter([...records]);
  const existing = new Set(records.filter(r => r.status !== "forgotten").map(r => memoryContentHash(r.content)));
  const groups = new Map<string, LegacyMemoryPreviewItem>();
  let bytes = 0, examined = 0;
  const canonical = (path: string) => path.length > 0 && !/^[\/]|[\\\x00-\x1f\x7f]|:/.test(path)
    && path === path.trim() && path.split("/").every(segment => segment && segment !== "." && segment !== "..");
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  for (const snapshot of snapshots.slice(0, limits.sources)) {
    const source: LegacyMemoryPreviewSource = { kind: snapshot.kind, path: snapshot.path, status: "read", entries: 0, ignored: 0, invalid: 0 };
    const sourceIndex = result.sources.push(source) - 1;
    if (!canonical(snapshot.path) || !allowedSources.some(allowed => allowed.path === snapshot.path && allowed.kind === snapshot.kind)
      || isVaultPathExcluded(snapshot.path, excludedPrefixes)) { source.status = "excluded"; continue; }
    if (!["index", "conversation", "markdown"].includes(snapshot.kind)) { source.status = "unsupported"; continue; }
    if (snapshot.unavailable) { source.status = snapshot.unavailable; continue; }
    if (typeof snapshot.text !== "string") { source.status = "unreadable"; continue; }
    const text = snapshot.text, size = Buffer.byteLength(text, "utf8");
    if (size > limits.sourceBytes || bytes + size > limits.totalBytes) { source.status = "too_large"; continue; }
    bytes += size;
    source.sha256 = createHash("sha256").update(text, "utf8").digest("hex");
    if (!text.trim() || text === snapshot.emptyTemplate) { source.status = "empty"; continue; }
    const add = (content: string, position: number) => {
      result.counts.reviewedEntries++;
      source.entries++;
      const id = memoryContentHash(content), old = groups.get(id);
      if (old) { old.occurrences.push({ source: sourceIndex, position }); result.counts.duplicates++; return; }
      // Compare the full text before truncation. Do not resurface a forgotten
      // phrase through Markdown, old summaries or an abbreviated preview.
      const suppressed = protect(content) !== content;
      const status = suppressed ? "suppressed" : existing.has(id) ? "already_present" : "review";
      const item: LegacyMemoryPreviewItem = { id: `legacy_preview_v1_${id}`, status, truncated: content.length > limits.previewChars,
        ...(!suppressed ? { preview: content.slice(0, limits.previewChars) } : {}), occurrences: [{ source: sourceIndex, position }] };
      groups.set(id, item); result.items.push(item);
    };
    if (snapshot.kind === "markdown") {
      if (examined >= limits.entries) source.status = "limit";
      else { examined++; add(text, 1); }
      continue;
    }
    if (snapshot.kind === "index") {
      let entries: unknown;
      try { entries = JSON.parse(text); } catch { source.status = "invalid"; continue; }
      if (!Array.isArray(entries)) { source.status = "unsupported"; continue; }
      if (!entries.length) source.status = "empty";
      // A bounded prefix is explicitly incomplete; unknown rows are never
      // coerced to empty memories or written back to the original document.
      for (let position = 0; position < entries.length; position++) {
        if (examined >= limits.entries) { source.status = "limit"; break; }
        examined++;
        const entry: unknown = entries[position];
        if (!object(entry) || typeof entry.id !== "string" || !entry.id.trim() || typeof entry.content !== "string" || !entry.content.trim()) { source.invalid++; continue; }
        if (typeof entry.status !== "string" || !["candidate", "active", "stale", "superseded", "archived"].includes(entry.status)) { source.invalid++; continue; }
        if (entry.status !== "candidate" && entry.status !== "active") { source.ignored++; continue; }
        add(entry.content, position + 1);
      }
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let position = 0; position < lines.length; position++) {
      if (!lines[position].trim()) continue;
      if (examined >= limits.entries) { source.status = "limit"; break; }
      examined++;
      let entry: unknown;
      try { entry = JSON.parse(lines[position]); } catch { source.invalid++; continue; }
      if (!object(entry)) { source.invalid++; continue; }
      if (entry.type === "task_pattern" || entry.type === "user_state") { source.ignored++; continue; }
      if (entry.type !== "conversation_summary") { source.status = "unsupported"; continue; }
      if (typeof entry.userStatement !== "string" || !entry.userStatement.trim()) { source.invalid++; continue; }
      // The old compact user field is inspectable history, not an original
      // complete statement or confirmation. Never extract assistant/summary.
      add(entry.userStatement, position + 1);
    }
  }
  result.counts.unique = result.items.length;
  result.counts.suppressed = result.items.filter(i => i.status === "suppressed").length;
  result.counts.alreadyPresent = result.items.filter(i => i.status === "already_present").length;
  result.counts.pendingReview = result.items.filter(i => i.status === "review").length;
  result.complete = !result.counts.omittedSources && result.sources.every(s => ["read", "empty", "missing"].includes(s.status) && !s.invalid);
  return result;
}

/** Literal quoted text only: legacy Markdown cannot create links, headings,
 * embeds or executable instructions in the generated review. */
export function legacyMemoryPreviewToMarkdown(preview: LegacyMemoryMigrationPreview): string {
  const literal = (text: string) => text.replace(/\r\n?/g, "\n").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)
    .replace(/[\\`*_{}\[\]()#+.!|~$=-]/g, "\\$&").replace(/\n/g, "\n> ");
  const labels = { review: "待核对的旧资料", already_present: "已有同文记录，未合并来源", suppressed: "已纠正或停用，正文保持隐藏" };
  return ["## 旧记忆迁移预览", "", "仅查看和去重，不会导入、确认或改写记忆；旧状态不代表当前事实。对话只列旧用户字段，可能不完整；Markdown整页不自动拆成事实。", "",
    `范围：${preview.complete ? "已处理本次提供的快照" : "部分资料未处理，请先核对下列状态"}。同文分组 ${preview.counts.unique}，重复 ${preview.counts.duplicates}，待核对 ${preview.counts.pendingReview}，已有 ${preview.counts.alreadyPresent}，保持抑制 ${preview.counts.suppressed}。`,
    ...preview.sources.map((s, i) => `\n来源 ${i + 1}：${literal(s.path)}；${s.status}；未识别 ${s.invalid}，未采用 ${s.ignored}。`),
    ...(preview.counts.omittedSources ? [`\n还有 ${preview.counts.omittedSources} 份来源超过本次范围，未处理。`] : []),
    ...preview.items.flatMap(item => ["", `### ${labels[item.status]}`, `来源：${item.occurrences.map(o => `${o.source + 1} / ${o.position}`).join("，")}`,
      ...(item.preview !== undefined ? ["", `> ${literal(item.preview)}`, ...(item.truncated ? ["", "正文仅显示片段；去重和抑制核对使用完整快照内容。"] : [])] : [])])].join("\n");
}
