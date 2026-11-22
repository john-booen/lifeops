import { fileRevision } from "../../operationIdentity";
import { journalDateFromPath } from "../../journalResolver";
import { isVaultPathExcluded } from "../../privacy";
import { isContextSourcePath } from "../../sourceReferences";
import type { PersonalMemorySourceRef } from "../../personalMemory";
import type { StoreHost } from "../../store/settingsSlice";
import { journalOriginalText } from "../journal/entry";

export const SUMMARY_ORIGINAL_VERSION = "summary-original-v2";
export const SUMMARY_ORIGINAL_MAX_BYTES = 32 * 1024 * 1024;
export const SUMMARY_QUOTATION_OMISSION = "（引用段未作为本人陈述提供。）";
export interface SummaryOriginal {
  date: string; path: string; sourceId: string; revision: string; text: string;
}
export interface SummaryOriginalReadCache {
  conversationRaw?: string; conversationEntries?: ReturnType<typeof summaryConversationEntries>;
}

/** Markdown quotations remain readable in the diary, but do not establish
 * the author's own automatic personal memory, including lazy continuations. */
export function journalNarrationForMemory(raw: string): string {
  let quoted = false;
  return (journalOriginalText(raw).match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/gu) ?? []).map(line => {
    if (!line.trim()) quoted = false;
    else if (/^ {0,3}>/u.test(line)) quoted = true;
    else if (/^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-+*]|\d{1,9}[.)])[ \t]+|`{3,}|~{3,})/u.test(line)) quoted = false;
    else if (/^ {0,3}(?:\*(?:[ \t]*\*){2,}|-(?:[ \t]*-){2,}|_(?:[ \t]*_){2,})[ \t]*(?:\r\n|\n|\r)?$/u.test(line)) quoted = false;
    return quoted ? SUMMARY_QUOTATION_OMISSION + (/(?:\r\n|\n|\r)$/u.exec(line)?.[0] ?? "") : line;
  }).join("");
}
export function isSummaryConversationOriginalRef(ref: PersonalMemorySourceRef, store: StoreHost): boolean {
  const date = ref.sourceId.match(/^summary-conversation:(\d{4}-\d{2}-\d{2}):[a-f0-9]{64}$/u)?.[1];
  return !!date && ref.extractionVersion === SUMMARY_ORIGINAL_VERSION && ref.observedDate === date
    && ref.path === store.path(store.settings.folders.aiReports, "Conversations", date + ".md");
}

export function summaryConversationLogPath(store: StoreHost): string {
  return store.path(store.settings.folders.aiReports, "Memory", "conversation-memory.jsonl");
}
export function summaryOriginalPathAllowed(store: StoreHost, path: string): boolean {
  return isContextSourcePath(path) && !isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes);
}
export function summaryJournalDate(store: StoreHost, path: string): string | null {
  return summaryOriginalPathAllowed(store, path) && store.isManagedSourcePath(path)
    && !path.startsWith(store.settings.folders.aiReports + "/")
    ? journalDateFromPath(path, store.settings.folders.dailyRoot) : null;
}

/** Structured user-only fields avoid mistaking Markdown examples in an AI reply for a user turn. */
export function summaryConversationEntries(raw: string, store: StoreHost) {
  const entries: Array<{ date: string; path: string; sourceId: string; text: string }> = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim() || line.length > 65536) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const date = row?.metadata?.localDate, value = row?.userStatement;
    if (row?.type !== "conversation_summary" || row.metadata?.source !== "agent-runtime"
      || row.metadata?.evidenceRole !== "conversation_only" || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(date)
      || !Number.isFinite(Date.parse(row.timestamp)) || typeof value !== "string" || !value.trim() || value.length > 4000) continue;
    const path = store.path(store.settings.folders.aiReports, "Conversations", date + ".md");
    if (row.metadata.sourcePath !== path || !summaryOriginalPathAllowed(store, path)) continue;
    const sourceId = "summary-conversation:" + date + ":" + fileRevision(line);
    if (seen.has(sourceId)) continue; seen.add(sourceId);
    entries.push({ date, path, sourceId, text: value });
  }
  return entries;
}

/** The full dated original is hash-bound; the structured user row is identified
 * by its own digest so later, unrelated log appends do not retire the memory. */
export async function summaryOriginalRefCurrent(ref: PersonalMemorySourceRef, content: string, store: StoreHost,
  readSource: (path: string) => Promise<string | null>, cache: SummaryOriginalReadCache = {}): Promise<boolean> {
  if (ref.extractionVersion !== SUMMARY_ORIGINAL_VERSION || typeof ref.excerpt !== "string"
    || ref.excerpt.replace(/\s+/gu, " ").trim() !== content || ref.excerptHash !== fileRevision(ref.excerpt)
    || !ref.contentHash || !summaryOriginalPathAllowed(store, ref.path)) return false;
  const raw = await readSource(ref.path);
  if (raw === null || fileRevision(raw) !== ref.contentHash) return false;
  const date = ref.sourceId.match(/^summary-journal:(\d{4}-\d{2}-\d{2})$/u)?.[1];
  if (date) return ref.observedDate === date && summaryJournalDate(store, ref.path) === date && journalOriginalText(raw).includes(ref.excerpt);
  const conversationDate = ref.sourceId.match(/^summary-conversation:(\d{4}-\d{2}-\d{2}):[a-f0-9]{64}$/u)?.[1];
  if (!conversationDate || ref.observedDate !== conversationDate) return false;
  const log = summaryConversationLogPath(store);
  if (!summaryOriginalPathAllowed(store, log) || (store.getFile(log)?.stat.size ?? Infinity) > SUMMARY_ORIGINAL_MAX_BYTES) return false;
  const logRaw = await readSource(log);
  if (logRaw === null || Buffer.byteLength(logRaw, "utf8") > SUMMARY_ORIGINAL_MAX_BYTES) return false;
  if (cache.conversationRaw !== logRaw || !cache.conversationEntries) {
    cache.conversationRaw = logRaw; cache.conversationEntries = summaryConversationEntries(logRaw, store);
  }
  const entry = cache.conversationEntries.find(item => item.sourceId === ref.sourceId && item.path === ref.path);
  return !!entry && entry.text.includes(ref.excerpt) && raw.replace(/\s+/gu, " ").includes(entry.text);
}
