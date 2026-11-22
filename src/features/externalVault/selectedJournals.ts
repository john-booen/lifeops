import { formatDate } from "../../date";
import { runDerivedOperation } from "../../dataFoundation/derivedOperation";
import { journalDateFromPath, journalPeriodFromPath } from "../../journalResolver";
import { fileRevision } from "../../operationIdentity";
import { isVaultPathExcluded } from "../../privacy";
import type { StoreHost } from "../../store/settingsSlice";
import type { SignalRequest } from "../journal/signalStore";
import { journalSignalMessages, parseJournalSignal, SELECTED_JOURNAL_MAX_CHARACTERS, validSelectedJournalExcerpt, type SignalPeriod } from "../journal/signals";
import { externalCategory, externalFilesForCategory, externalJournalRoot, externalVaultScope, resolveExternalSource } from "./catalog";
import { documentPath, readDocument } from "./journals";

export const SELECTED_JOURNAL_MAX_ITEMS = 3;
export interface ExternalJournalPreview {
  reference: string; date: string; period: SignalPeriod; sourceHash: string; scope: string; text: string;
}
export type ExternalJournalSelection = Omit<ExternalJournalPreview, "text"> & { excerpt: string; excerptHash: string };
const periodFor = (path: string): SignalPeriod => journalPeriodFromPath(path) === "早" || path.split("/").at(-1)?.includes("晨") ? "晨" : "晚";
// A missing year must not silently turn an old diary into this year's fact.
const dateFor = (store: StoreHost, path: string) => journalDateFromPath(path, externalJournalRoot(store.settings, path));

/** Lists metadata only; no diary bodies or provider calls. */
export async function listSelectableExternalJournals(store: StoreHost, now = new Date()) {
  const scope = externalVaultScope(store), today = formatDate(now);
  const rows = (await externalFilesForCategory(store, "journal")).flatMap(item => {
    const date = dateFor(store, item.file.path);
    return date && date <= today ? [{ reference: item.reference, date, period: periodFor(item.file.path), label: `${date} · ${item.config.name} / ${item.file.path.split("/").at(-1)}` }] : [];
  }).sort((a, b) => b.date.localeCompare(a.date) || a.reference.localeCompare(b.reference));
  if (externalVaultScope(store) !== scope) throw Error("外部库范围已变化，请重新选择。");
  return rows;
}

/** Explicit local preview. The existing bounded, symlink-safe reader stays read-only. */
export async function previewExternalJournal(store: StoreHost, reference: string, now = new Date()): Promise<ExternalJournalPreview> {
  const scope = externalVaultScope(store), source = resolveExternalSource(store, reference);
  const date = source && externalCategory(store.settings, source.path) === "journal" ? dateFor(store, source.path) : null;
  if (!source || !date || date > formatDate(now)) throw Error("请选择可读日期的外部日记。");
  const text = await source.reader.read(source.path);
  if (externalVaultScope(store) !== scope) throw Error("外部库范围已变化，请重新选择。");
  return { reference, date, period: periodFor(source.path), sourceHash: fileRevision(text), scope, text };
}

export function selectExternalJournalExcerpt(preview: ExternalJournalPreview, excerpt: string): ExternalJournalSelection {
  const excerptHash = fileRevision(excerpt);
  if (!validSelectedJournalExcerpt({ text: excerpt, sha256: excerptHash }) || !preview.text.includes(excerpt)) {
    throw Error(`请从预览中选取一段连续原文，每段最多${SELECTED_JOURNAL_MAX_CHARACTERS}字。`);
  }
  const { text: _text, ...source } = preview;
  return { ...source, excerpt, excerptHash };
}

async function assertSelection(store: StoreHost, selected: ExternalJournalSelection, now: Date, current: () => void) {
  current();
  if (externalVaultScope(store) !== selected.scope || !validSelectedJournalExcerpt({ text: selected.excerpt, sha256: selected.excerptHash })) throw Error("选段或外部库范围已变化，请重新预览。");
  const source = resolveExternalSource(store, selected.reference);
  if (!source || externalCategory(store.settings, source.path) !== "journal" || dateFor(store, source.path) !== selected.date
    || selected.date > formatDate(now) || periodFor(source.path) !== selected.period) throw Error("选段日期或来源无法核对，请重新预览。");
  const destination = documentPath(store, source.config.name, selected.date);
  if (isVaultPathExcluded(destination, store.settings.privacy?.excludedVaultPrefixes)) throw Error("整理结果位置已排除。");
  const raw = await source.reader.read(source.path);
  current();
  if (externalVaultScope(store) !== selected.scope || fileRevision(raw) !== selected.sourceHash || !raw.includes(selected.excerpt)) throw Error("原日记已经更新，请重新预览选段。");
  return { source, destination };
}

export async function extractSelectedExternalJournalSignals(store: StoreHost, selections: readonly ExternalJournalSelection[], request: SignalRequest,
  signal: AbortSignal, assertCurrent: () => void, now = new Date()) {
  if (!selections.length || selections.length > SELECTED_JOURNAL_MAX_ITEMS) throw Error(`每次请选择1至${SELECTED_JOURNAL_MAX_ITEMS}段原文。`);
  // Own the immutable selection; UI edits cannot enlarge an in-flight request.
  const chosen = selections.map(item => ({ ...item }));
  const ids = chosen.map(item => item.reference + ":" + item.sourceHash + ":" + item.excerptHash);
  if (new Set(ids).size !== ids.length) throw Error("同一段原文不必重复选择。");
  const current = () => { signal.throwIfAborted(); assertCurrent(); };
  // Validate the entire batch before its first request or derived write.
  for (const item of chosen) await assertSelection(store, item, now, current);
  const results: Array<{ reference: string; date: string; status: "saved" | "existing" }> = [];
  for (const item of chosen) {
    const checked = () => assertSelection(store, item, now, current).then(() => undefined);
    const { source, destination } = await assertSelection(store, item, now, current);
    const exists = (doc: Awaited<ReturnType<typeof readDocument>>) => [...doc.晨, ...doc.晚].some(entry => entry.sources[0].path === item.reference
      && entry.sources[0].sha256 === item.sourceHash && entry.sources[0].selectedExcerpt?.sha256 === item.excerptHash);
    if (exists(await readDocument(store, source.config.name, item.date))) { await checked(); results.push({ reference: item.reference, date: item.date, status: "existing" }); continue; }
    let entry;
    for (let attempt = 0; attempt < 2; attempt++) {
      await checked();
      const answer = await request(journalSignalMessages(item.reference, item.date, item.period, item.excerpt, attempt > 0),
        { signal, beforeTextRequest: checked, assertTextRequestCurrent: current });
      await checked();
      try { entry = parseJournalSignal(answer, item.date, item.period, item.excerpt, { path: item.reference, sha256: item.sourceHash,
        selectedExcerpt: { text: item.excerpt, sha256: item.excerptHash } }); break; } catch { /* One bounded format repair with the same selected text. */ }
    }
    if (!entry) throw Error("选段暂时无法整理，已完成的结果保留；未完成部分可再次提交。");
    const parsed = entry; let saved = false;
    await runDerivedOperation(store, async operation => {
      await checked();
      const document = await readDocument(operation, source.config.name, item.date);
      if (exists(document)) return;
      // Preserve other excerpts from the same current original, and unrelated sources.
      for (const period of ["晨", "晚"] as const) document[period] = document[period].filter(value => value.sources[0].path !== item.reference || value.sources[0].sha256 === item.sourceHash);
      document[item.period].push(parsed); await operation.writeJson(destination, document); saved = true;
    }, { assertCurrent: current, assertBeforeCommit: checked });
    results.push({ reference: item.reference, date: item.date, status: saved ? "saved" : "existing" });
  }
  return { examined: results.length, saved: results.filter(item => item.status === "saved").length, existing: results.filter(item => item.status === "existing").length, results };
}
