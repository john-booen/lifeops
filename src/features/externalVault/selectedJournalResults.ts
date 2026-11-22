import { readFactOperation } from "../../dataFoundation/factOperation";
import { fileRevision } from "../../operationIdentity";
import type { StoreHost } from "../../store/settingsSlice";
import { JOURNAL_SIGNAL_FIELDS, parseJournalSignal, type JournalSignal } from "../journal/signals";
import { externalVaultScope, resolveExternalSource } from "./catalog";
import { readDocument } from "./journals";
import { assertSelection, previewExternalJournal, type ExternalJournalPreview, type ExternalJournalSelection } from "./selectedJournals";

export interface SelectedJournalResults {
  readonly text: string; readonly saved: number; readonly revision: string;
  readonly selections: readonly ExternalJournalSelection[];
}
const boundary = "以下仅为已选日记片段的整理要点，不代表整篇或整周记录；尚未创建任务，也未确认为个人记忆。";
const labels = { energy: "精力", mood: "情绪", stress: "压力", sleepHours: "睡眠时长", sleepQuality: "睡眠质量" };
function lines(entry: JournalSignal): string[] {
  return [
    ...JOURNAL_SIGNAL_FIELDS.flatMap(field => entry[field] === null ? [] : [`${labels[field]}：${entry[field]}${field === "sleepHours" ? "小时" : "/5"}（原话：${entry.quotes.find(quote => quote.field === field)!.text}）`]),
    ...entry.keyEvents.map(text => `事件：${text}`),
    ...entry.plans.map(plan => `计划原话：${plan.text}${plan.when ? `（时间原话：${plan.when}）` : "（未注明时间）"}`),
    ...entry.ideas.map(idea => `想法原话：${idea.quote}`),
    ...entry.worries.map(text => `担心原话：${text}`)
  ];
}

/** Read-only receipt: recheck both source and derived document before returning. */
export async function readSelectedJournalResults(store: StoreHost, selections: readonly ExternalJournalSelection[], current: () => void, now = new Date()): Promise<SelectedJournalResults> {
  const chosen = selections.map(item => Object.freeze({ ...item })), scope = externalVaultScope(store);
  const check = () => { current(); if (externalVaultScope(store) !== scope) throw Error("资料范围已变化。"); };
  return readFactOperation(store, async () => {
    check(); const documents = new Map<string, { name: string; date: string; doc: Awaited<ReturnType<typeof readDocument>>; revision: string }>();
    const parts = [boundary]; let saved = 0;
    for (const selected of chosen) {
      const { source, destination } = await assertSelection(store, selected, now, check);
      let record = documents.get(destination);
      if (!record) {
        const doc = await readDocument(store, source.config.name, selected.date); check();
        record = { name: source.config.name, date: selected.date, doc, revision: fileRevision(JSON.stringify(doc)) }; documents.set(destination, record);
      }
      const entry = record.doc[selected.period].find(item => item.sources[0].path === selected.reference && item.sources[0].sha256 === selected.sourceHash
        && item.sources[0].selectedExcerpt?.sha256 === selected.excerptHash && item.sources[0].selectedExcerpt.text === selected.excerpt);
      parts.push(`\n${selected.date} · ${source.config.name} / ${source.path.split("/").at(-1)}`);
      if (!entry) { parts.push("这一段尚无已保存的整理结果。"); continue; }
      // Never promote a derived-file edit into a new literal fact or trust an idea paraphrase.
      const clean = parseJournalSignal(JSON.stringify(entry), selected.date, selected.period, selected.excerpt, entry.sources[0]);
      const facts = lines(clean); parts.push(...(facts.length ? facts : ["这一段未提取到明确的状态、事件、计划或想法。"]), `选段原文：\n${selected.excerpt}`); saved++;
    }
    for (const selected of chosen) await assertSelection(store, selected, now, check);
    for (const record of documents.values()) {
      if (fileRevision(JSON.stringify(await readDocument(store, record.name, record.date))) !== record.revision) throw Error("保存结果已变化，请重新查看。");
    }
    check();
    return Object.freeze({ text: parts.join("\n"), saved, selections: Object.freeze(chosen), revision: fileRevision(JSON.stringify([...documents].map(([path, item]) => [path, item.revision]))) });
  });
}

/** Reopen the saved excerpts of one explicitly previewed current original, without a model call. */
export async function readSavedJournalResults(store: StoreHost, preview: ExternalJournalPreview, current: () => void, now = new Date()): Promise<SelectedJournalResults> {
  current(); const fresh = await previewExternalJournal(store, preview.reference, now); current();
  if (fresh.sourceHash !== preview.sourceHash || fresh.scope !== preview.scope || fresh.date !== preview.date || fresh.period !== preview.period) throw Error("原文或范围已变化，请重新预览。");
  return readFactOperation(store, async () => {
    const source = resolveExternalSource(store, fresh.reference); if (!source) throw Error("来源暂不可读。");
    const doc = await readDocument(store, source.config.name, fresh.date); current();
    const chosen = doc[fresh.period].flatMap(entry => {
      const pin = entry.sources[0];
      return pin.path === fresh.reference && pin.sha256 === fresh.sourceHash && pin.selectedExcerpt
        ? [{ reference: fresh.reference, date: fresh.date, period: fresh.period, sourceHash: fresh.sourceHash, scope: fresh.scope, excerpt: pin.selectedExcerpt.text, excerptHash: pin.selectedExcerpt.sha256 }] : [];
    });
    const unique = chosen.filter((item, index) => chosen.findIndex(other => other.excerptHash === item.excerptHash) === index);
    if (!unique.length) { await previewExternalJournal(store, fresh.reference, now).then(value => { current(); if (value.scope !== fresh.scope || value.sourceHash !== fresh.sourceHash) throw Error("原文已变化。"); }); }
    const result = await readSelectedJournalResults(store, unique, current, now); current();
    if (externalVaultScope(store) !== fresh.scope || fileRevision(JSON.stringify(await readDocument(store, source.config.name, fresh.date))) !== fileRevision(JSON.stringify(doc))) throw Error("资料范围或保存结果已变化。");
    current(); if (externalVaultScope(store) !== fresh.scope) throw Error("资料范围已变化。");
    return result;
  });
}

export async function assertSelectedJournalResultsCurrent(store: StoreHost, snapshot: SelectedJournalResults, current: () => void): Promise<void> {
  const fresh = await readSelectedJournalResults(store, snapshot.selections, current);
  if (!snapshot.saved || fresh.revision !== snapshot.revision || fresh.text !== snapshot.text) throw Error("保存结果已变化，请重新查看。");
}
