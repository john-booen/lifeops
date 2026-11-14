import type { ChatMessage } from "../../ai";
import { runDerivedOperation } from "../../dataFoundation/derivedOperation";
import { readScopedMarkdown } from "../../dataFoundation/markdownSources";
import { journalDateFromPath, journalPeriodFromPath } from "../../journalResolver";
import { fileRevision } from "../../operationIdentity";
import { isVaultPathExcluded } from "../../privacy";
import { assertProviderActive } from "../../providerRun";
import { isContextSourcePath } from "../../sourceReferences";
import type { StoreHost } from "../../store/settingsSlice";
import type { ProviderRequestOptions } from "../../types";
import { emptySignalDocument, journalSignalMessages, parseJournalSignal, validSignalDocument, type JournalSignal, type SignalDocument, type SignalPeriod } from "./signals";

export type SignalRequest = (messages: ChatMessage[], options: ProviderRequestOptions) => Promise<string>;

export function journalSourceFor(store: StoreHost, path: string, year: string) {
  if (!isContextSourcePath(path) || !store.isManagedSourcePath(path)) return undefined;
  const date = journalDateFromPath(path, store.settings.folders.dailyRoot, year);
  const file = date ? store.getFile(path) : null;
  if (!date || file?.path !== path) return undefined;
  const period: SignalPeriod = journalPeriodFromPath(path) === "早" || file.basename.includes("晨") ? "晨" : "晚";
  return { date, period, mtime: file.stat.mtime };
}

export function signalDocumentPath(store: StoreHost, date: string): string {
  return store.path(store.settings.folders.aiReports, "Signals", `${date}.json`);
}

function signalPathAllowed(store: StoreHost, path: string): boolean {
  return isContextSourcePath(path) && !isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes);
}

async function readDocument(store: StoreHost, path: string, date: string): Promise<SignalDocument> {
  const document = await store.readJson(path, emptySignalDocument(date));
  if (!validSignalDocument(document, date)) throw Error("日记信号文件格式异常，已保留原文件。");
  return document;
}

export async function readJournalSignals(store: StoreHost, date: string): Promise<JournalSignal[]> {
  const path = signalDocumentPath(store, date);
  const document = signalPathAllowed(store, path) ? await readDocument(store, path, date) : emptySignalDocument(date);
  if (path !== signalDocumentPath(store, date)) return [];
  const year = date.slice(0, 4);
  const external = store.settings.externalVaults?.length
    ? await import("../externalVault/journals")
      .then(({ readExternalJournalSignals }) => readExternalJournalSignals(store, date))
      .catch(() => [])
    : [];
  const current = () => path === signalDocumentPath(store, date) && signalPathAllowed(store, path);
  if (!current()) return external;
  const verified = await Promise.all([...document.晨, ...document.晚].map(async item => {
    const source = item.sources[0];
    if (journalSourceFor(store, source.path, year)?.date !== date) return;
    const raw = await readScopedMarkdown(store, source.path).catch(() => undefined);
    if (raw !== undefined && fileRevision(raw) === source.sha256) return item;
  }));
  const local = current()
    ? verified.filter((item): item is JournalSignal => !!item && journalSourceFor(store, item.sources[0].path, year)?.date === date)
    : [];
  return [...external, ...local];
}

export async function extractJournalSignal(
  store: StoreHost, path: string, year: string, request: SignalRequest, signal: AbortSignal, assertSession: () => void
): Promise<"skipped" | "saved" | "invalid"> {
  const source = journalSourceFor(store, path, year);
  if (!source) return "skipped";
  const { date, period } = source;
  const destination = signalDocumentPath(store, date);
  if (!signalPathAllowed(store, destination)) return "skipped";
  const assertCurrent = () => {
    assertProviderActive(signal);
    assertSession();
    const selected = journalSourceFor(store, path, year);
    if (selected?.date !== date || selected.period !== period || destination !== signalDocumentPath(store, date)
      || !signalPathAllowed(store, destination)) throw Error("日记信号处理权限或来源已变化。");
  };
  assertCurrent();
  const raw = await store.readPath(path), sha256 = fileRevision(raw);
  const document = await readDocument(store, destination, date);
  if (document[period].some(entry => entry.sources[0].path === path && entry.sources[0].sha256 === sha256)) return "skipped";

  const assertSource = async () => {
    assertCurrent();
    const currentHash = fileRevision(await store.readPath(path));
    assertCurrent();
    if (currentHash !== sha256) throw Error("日记有新修改，将等待重新提取。");
  };
  const text = [...raw.slice(0, 12000)].slice(0, 6000).join("");
  let result: JournalSignal | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assertSource();
    const answer = text.trim() ? await request(journalSignalMessages(path, date, period, text, attempt > 0), {
      signal, beforeTextRequest: assertSource, assertTextRequestCurrent: assertCurrent
    }) : JSON.stringify({ date, period });
    try {
      result = parseJournalSignal(answer, date, period, text, { path, sha256 });
      break;
    } catch {
      // Invalid model JSON is retried once. Original text and model replies stay out of logs.
    }
  }
  if (!result) return "invalid";
  const next = result;
  await runDerivedOperation(store, async scope => {
    await assertSource();
    const current = await readDocument(scope, destination, date);
    const existing = current[period].find(entry => entry.sources[0].path === path);
    if (existing?.sources[0].sha256 === sha256) return;
    current.晨 = current.晨.filter(entry => entry.sources[0].path !== path);
    current.晚 = current.晚.filter(entry => entry.sources[0].path !== path);
    current[period].push(next);
    await scope.writeJson(destination, current);
  }, { assertCurrent, assertBeforeCommit: assertSource });
  return "saved";
}
