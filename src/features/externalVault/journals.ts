import { formatDate } from "../../date";
import { runDerivedOperation } from "../../dataFoundation/derivedOperation";
import { journalDateFromPath, journalPeriodFromPath } from "../../journalResolver";
import { fileRevision } from "../../operationIdentity";
import { isVaultPathExcluded } from "../../privacy";
import type { StoreHost } from "../../store/settingsSlice";
import type { SignalRequest } from "../journal/signalStore";
import { emptySignalDocument, journalSignalMessages, parseJournalSignal, validSelectedJournalExcerpt, validSignalDocument, type JournalSignal, type SignalDocument, type SignalSource } from "../journal/signals";
import { externalCategory, externalFilesForCategory, externalJournalRoot, externalVaultScope, externalVaultSettings, resolveExternalSource } from "./catalog";

export const documentPath = (store: StoreHost, name: string, date: string) => store.path(store.settings.folders.aiReports, "Signals", "External", name, date + ".json");

export async function readDocument(store: StoreHost, name: string, date: string): Promise<SignalDocument> {
  const path = documentPath(store, name, date);
  const fallback = emptySignalDocument(date);
  if (isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)) return fallback;
  const doc = await store.readJson(path, fallback);
  if (!validSignalDocument(doc, date)) throw Error("外部日记信号格式异常。");
  return doc;
}

export async function externalJournalSignalSourceCurrent(store: StoreHost, date: string, source: SignalSource): Promise<boolean> {
  const scope = externalVaultScope(store), external = resolveExternalSource(store, source.path);
  if (!external || externalCategory(store.settings, external.path) !== "journal"
    || journalDateFromPath(external.path, externalJournalRoot(store.settings, external.path), date.slice(0, 4)) !== date) return false;
  const raw = await external.reader.read(external.path).catch(() => undefined);
  return raw !== undefined && externalVaultScope(store) === scope && fileRevision(raw) === source.sha256
    && (source.selectedExcerpt === undefined || validSelectedJournalExcerpt(source.selectedExcerpt) && raw.includes(source.selectedExcerpt.text));
}

export async function readExternalJournalSignals(store: StoreHost, date: string): Promise<JournalSignal[]> {
  const scope = externalVaultScope(store);
  const docs = await Promise.all(externalVaultSettings(store.settings).map(config => readDocument(store, config.name, date)));
  const result: JournalSignal[] = [];
  for (const doc of docs) {
    for (const item of [...doc.晨, ...doc.晚]) {
      if (await externalJournalSignalSourceCurrent(store, date, item.sources[0])) result.push(item);
    }
  }
  return externalVaultScope(store) === scope ? result : [];
}

export async function listHistoricalExternalIdeaSignals(store: StoreHost, recentDates: string[]): Promise<JournalSignal[]> {
  const existing = new Set(recentDates);
  const sources = await externalFilesForCategory(store, "journal");
  const dates = new Set(sources.flatMap(({ file }) => {
    const date = journalDateFromPath(file.path, externalJournalRoot(store.settings, file.path), recentDates.at(-1)?.slice(0, 4));
    return date && !existing.has(date) ? [date] : [];
  }));
  return (await Promise.all([...dates].map(date => readExternalJournalSignals(store, date).catch(() => [])))).flat();
}

export async function extractExternalJournalSignals(store: StoreHost, request: SignalRequest, signal: AbortSignal,
  assertCurrent: () => void, now = new Date(), progress?: (done: number, total: number) => void) {
  const scope = externalVaultScope(store);
  const today = formatDate(now);
  const files = (await externalFilesForCategory(store, "journal")).flatMap(item => {
    const date = journalDateFromPath(item.file.path, externalJournalRoot(store.settings, item.file.path), today.slice(0, 4));
    return date && date <= today ? [{ ...item, date }] : [];
  });
  let saved = 0, unavailable = 0, examined = 0;
  const current = () => {
    signal.throwIfAborted();
    assertCurrent();
    if (externalVaultScope(store) !== scope) throw Error("外部库范围已变化，扫描已停止。");
  };
  for (const item of files) {
    current();
    try {
      if (await extractExternalJournal(store, item, request, signal, current)) saved++;
    } catch {
      current();
      unavailable++;
    }
    examined++;
    progress?.(examined, files.length);
  }
  return { examined, saved, unavailable };
}

async function extractExternalJournal(store: StoreHost, item: { config: { name: string }; reference: string; file: { path: string }; date: string },
  request: SignalRequest, signal: AbortSignal, current: () => void): Promise<boolean> {
  const source = resolveExternalSource(store, item.reference);
  if (!source) throw Error("日记来源已排除。");
  const { date, file, config, reference } = item;
  const period = journalPeriodFromPath(file.path) === "早" || file.path.split("/").at(-1)?.includes("晨") ? "晨" : "晚";
  const raw = await source.reader.read(source.path);
  const sha256 = fileRevision(raw);
  const destination = documentPath(store, config.name, date);
  const assertSource = async () => {
    current();
    if (isVaultPathExcluded(destination, store.settings.privacy?.excludedVaultPrefixes)
      || fileRevision(await source.reader.read(source.path)) !== sha256) throw Error("外部日记已变化或被排除。");
    current();
  };
  await assertSource();
  if ((await readDocument(store, config.name, date))[period].some(entry =>
    entry.sources[0].path === reference && entry.sources[0].sha256 === sha256)) return false;
  const text = [...raw.slice(0, 12000)].slice(0, 6000).join("");
  let parsed: JournalSignal | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assertSource();
    const answer = text.trim() ? await request(journalSignalMessages(reference, date, period, text, attempt > 0), {
      signal, beforeTextRequest: assertSource, assertTextRequestCurrent: current
    }) : JSON.stringify({ date, period });
    try { parsed = parseJournalSignal(answer, date, period, text, { path: reference, sha256 }); break; } catch { /* Retry malformed JSON once. */ }
  }
  if (!parsed) throw Error("外部日记信号无法解析。");
  const entry = parsed;
  await runDerivedOperation(store, async operation => {
    await assertSource();
    const document = await readDocument(operation, config.name, date);
    for (const part of ["晨", "晚"] as const) document[part] = document[part].filter(value => value.sources[0].path !== reference);
    document[period].push(entry);
    await operation.writeJson(destination, document);
  }, { assertCurrent: current, assertBeforeCommit: assertSource });
  return true;
}
