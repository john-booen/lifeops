import { addDays, datesBetween, formatDate } from "../../date";
import { guardedOperationIdentity } from "../../dataFoundation/factOperation";
import { fileRevision } from "../../operationIdentity";
import type { StoreHost } from "../../store/settingsSlice";
import { extractJournalSignal, journalSourceFor, readJournalSignals, type SignalRequest } from "../journal/signalStore";
import { datedIdeaFile, ideaTitleKey, isIdeaNotePath, readIdeaProperties, readIdeaSource, splitIdeaNote } from "./notes";
import { externalCategory, externalFilesForCategory, externalJournalRoot, externalPrefix, resolveExternalSource } from "../externalVault/catalog";
import { journalDateFromPath } from "../../journalResolver";

export interface IdeaCandidate {
  id: string;
  kind: "note" | "journal" | "external";
  title: string;
  description: string;
  created: string;
  path: string;
  revision: string;
  quote?: string;
  screened?: boolean;
}

export interface IdeaScreening { id: string; revision: string; keep: boolean }
interface CandidateDecisions { version: 1; ignored: string[]; registered: string[]; screened?: IdeaScreening[] }
const decisionsPath = (store: StoreHost) => store.path(store.settings.folders.aiReports, "Ideas", "LifeOps想法候选.json");
const validScreening = (entry: IdeaScreening) => !!entry && typeof entry.id === "string" && /^journal:[a-f0-9]{64}$/.test(entry.id)
  && typeof entry.revision === "string" && /^[a-f0-9]{64}$/.test(entry.revision) && typeof entry.keep === "boolean";

export async function readIdeaDecisions(store: StoreHost): Promise<CandidateDecisions> {
  const document = await store.readJson<CandidateDecisions>(decisionsPath(store), { version: 1, ignored: [], registered: [] });
  if (!document || document.version !== 1 || !Array.isArray(document.ignored) || !Array.isArray(document.registered)
    || [...document.ignored, ...document.registered].some(id => typeof id !== "string" || !/^(note|journal|external):[a-f0-9]{64}$/.test(id))
    || document.screened !== undefined && (!Array.isArray(document.screened) || !document.screened.every(validScreening)
      || new Set(document.screened.map(entry => entry.id)).size !== document.screened.length)) {
    throw new Error("想法候选记录格式异常，请先核对。");
  }
  return document;
}

export async function decideIdeaCandidates(store: StoreHost, ids: readonly string[], decision: "ignored" | "registered"): Promise<void> {
  const identity = guardedOperationIdentity(store);
  if (!identity || identity.purpose === "derived") throw new Error("请从想法候选入口保存。");
  const document = await readIdeaDecisions(store);
  const handled = new Set([...document.ignored, ...document.registered]);
  if (ids.some(id => handled.has(id))) throw new Error("候选已处理，请刷新。");
  await store.writeJson(decisionsPath(store), { ...document, [decision]: [...document[decision], ...new Set(ids)] });
}

export async function saveIdeaScreening(store: StoreHost, entries: readonly IdeaScreening[]): Promise<void> {
  const identity = guardedOperationIdentity(store);
  if (!identity || identity.purpose === "derived") throw new Error("请从日记候选筛查入口保存。");
  if (!entries.every(validScreening) || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error("候选筛查记录无效。");
  const document = await readIdeaDecisions(store), existing = new Map((document.screened ?? []).map(entry => [entry.id, entry]));
  const handled = new Set([...document.ignored, ...document.registered]);
  if (entries.some(entry => handled.has(entry.id) || existing.get(entry.id)?.revision === entry.revision)) {
    throw new Error("候选已处理，请刷新后再筛查。");
  }
  for (const entry of entries) existing.set(entry.id, entry);
  await store.writeJson(decisionsPath(store), { ...document, screened: [...existing.values()] });
}

const candidateText = (text: string) => text.trim().replace(/\s+/g, " ").slice(0, 150);

export async function listIdeaCandidates(store: StoreHost, now = new Date()): Promise<IdeaCandidate[]> {
  const today = formatDate(now), decisions = await readIdeaDecisions(store);
  const handled = new Set([...decisions.ignored, ...decisions.registered]);
  const screenings = new Map((decisions.screened ?? []).map(entry => [entry.id, entry]));
  const candidates = new Map<string, IdeaCandidate>();
  for (const file of store.app.vault.getMarkdownFiles()) {
    if (!isIdeaNotePath(store, file.path)) continue;
    const id = "note:" + fileRevision(file.path);
    if (handled.has(id)) continue;
    try {
      const raw = await readIdeaSource(store, file.path);
      const title = candidateText(file.basename);
      if (title && readIdeaProperties(raw).lifeops === undefined) {
        candidates.set(id, { id, kind: "note", title, description: candidateText(splitIdeaNote(raw).body.replace(/^# [^\n]*\r?\n\s*/, "")),
          created: datedIdeaFile(file.stat.ctime, now), path: file.path, revision: fileRevision(raw) });
      }
    } catch { /* Broken, excluded and oversized files remain untouched. */ }
  }
  if (store.settings.externalVaults?.length) {
    for (const { file, reference } of await externalFilesForCategory(store, "idea")) {
      const id = "external:" + fileRevision(reference);
      if (handled.has(id)) continue;
      try {
        const raw = await readIdeaSource(store, reference);
        const title = candidateText(file.path.split("/").at(-1)!.slice(0, -3));
        if (!title) continue;
        candidates.set(id, { id, kind: "external", title, description: candidateText(splitIdeaNote(raw).body.replace(/^# [^\n]*\r?\n\s*/, "")),
          created: datedIdeaFile(file.mtime, now), path: reference, revision: fileRevision(raw) });
      } catch { /* An unavailable external note does not block local candidates. */ }
    }
  }

  const recentDates = datesBetween(addDays(today, -89), today);
  const signals = (await Promise.all(recentDates.map(date => readJournalSignals(store, date).catch(() => [])))).flat();
  if (store.settings.externalVaults?.length) {
    const { listHistoricalExternalIdeaSignals } = await import("../externalVault/journals");
    signals.push(...await listHistoricalExternalIdeaSignals(store, recentDates).catch(() => []));
  }
  for (const signal of signals) {
    if (!signal.ideas.length) continue;
    const source = signal.sources[0];
    const raw = await readIdeaSource(store, source.path).catch(() => undefined);
    if (raw === undefined) continue;
    const revision = fileRevision(raw);
    // Diary signals use Obsidian's text reader, while confirmation must bind
    // the actual note bytes, including an original BOM or CRLF.
    const signalText = revision === source.sha256 ? raw : await store.readPath(source.path).catch(() => undefined);
    if (signalText === undefined || revision !== source.sha256 && fileRevision(signalText) !== source.sha256) continue;
    for (const idea of signal.ideas) {
      const title = candidateText(idea.text);
      const id = "journal:" + fileRevision(JSON.stringify([source.path, ideaTitleKey(title), idea.quote]));
      if (!title || !signalText.includes(idea.quote) || handled.has(id)) continue;
      const screened = screenings.get(id);
      if (screened?.revision === revision && !screened.keep) continue;
      candidates.set(id, { id, kind: "journal", title, description: candidateText(idea.quote),
        created: signal.date, path: source.path, revision, quote: idea.quote, ...(screened?.revision === revision ? { screened: true } : {}) });
    }
  }
  return [...candidates.values()].sort((a, b) => b.created.localeCompare(a.created) || a.path.localeCompare(b.path));
}

export async function assertIdeaCandidate(store: StoreHost, candidate: IdeaCandidate): Promise<void> {
  if (candidate.path.startsWith(externalPrefix + "/")) {
    const external = resolveExternalSource(store, candidate.path);
    const category = external && externalCategory(store.settings, external.path);
    const date = external && journalDateFromPath(external.path, externalJournalRoot(store.settings, external.path), candidate.created.slice(0, 4));
    if (!external || !(candidate.kind === "external" && category === "idea"
      || candidate.kind === "journal" && category === "journal" && date === candidate.created)) throw Error("外部想法来源已变化，请刷新候选。");
    const raw = await external.reader.read(external.path);
    if (fileRevision(raw) !== candidate.revision || candidate.quote && !raw.includes(candidate.quote)) throw Error("外部想法来源已变化，请刷新候选。");
    return;
  }
  const inScope = candidate.kind === "note" ? isIdeaNotePath(store, candidate.path)
    : journalSourceFor(store, candidate.path, candidate.created.slice(0, 4))?.date === candidate.created;
  if (!inScope) throw new Error("想法来源已变化，请刷新候选。");
  const current = await readIdeaSource(store, candidate.path);
  const quoteMatches = !candidate.quote || current.includes(candidate.quote)
    || candidate.kind === "journal" && (await store.readPath(candidate.path)).includes(candidate.quote);
  if (fileRevision(current) !== candidate.revision || !quoteMatches) {
    throw new Error("想法来源已变化，请刷新候选。");
  }
}

export async function scanIdeaJournals(store: StoreHost, request: SignalRequest, signal: AbortSignal,
  assertCurrent: () => void, now = new Date(), onProgress?: (examined: number, total: number) => void): Promise<{ examined: number; unavailable: number }> {
  const to = formatDate(now), from = addDays(to, -89), year = to.slice(0, 4);
  const paths = store.app.vault.getMarkdownFiles().flatMap(file => {
    const source = journalSourceFor(store, file.path, year);
    return source && source.date >= from && source.date <= to ? [file.path] : [];
  });
  let examined = 0, unavailable = 0;
  for (const path of paths) {
    signal.throwIfAborted();
    assertCurrent();
    try {
      const revision = fileRevision(await readIdeaSource(store, path));
      const requestCurrent: SignalRequest = (messages, options) => request(messages, {
        ...options, beforeTextRequest: async () => {
          await options.beforeTextRequest?.();
          if (fileRevision(await readIdeaSource(store, path)) !== revision) throw new Error("日记已修改，等待下次扫描。");
          assertCurrent();
        }
      });
      if (await extractJournalSignal(store, path, year, requestCurrent, signal, assertCurrent) === "invalid") unavailable++;
    } catch {
      signal.throwIfAborted();
      assertCurrent();
      unavailable++;
    }
    examined++;
    onProgress?.(examined, paths.length);
  }
  return { examined, unavailable };
}
