import type { LifeOpsEventBus } from "../../lifeOpsEventBus";
import type { StoreHost } from "../../store/settingsSlice";
import type { LocalOperationHost } from "../serviceHost";
import { assertReadingSource, captureReadingSource, readReadingIndex, readingNoteAllowed, saveReadingEntry, summarizeReadingSource, type ReadingRequest } from "./index";

export function subscribeReadingNotes(host: LocalOperationHost, store: StoreHost, events: LifeOpsEventBus, request: ReadingRequest,
  isCurrent = () => true): () => void {
  let active = true;
  const pending = new Map<string, { revision: string; controller: AbortController }>();
  const unsubscribe = events.subscribe(async event => {
    if (!active || !isCurrent() || event.type !== "vault.created" && event.type !== "vault.modified" && event.type !== "vault.renamed") return;
    const path = (event.payload as { path?: string }).path, ai = store.settings.ai;
    if (typeof path !== "string" || !readingNoteAllowed(store, path) || !ai.dataDisclosureAccepted || ai.provider === "off" || !ai.endpoint || !ai.model) return;
    const source = await captureReadingSource(store, path);
    if (!source || !active || !isCurrent()) return;
    const doc = await readReadingIndex(store);
    if (doc.entries.some(entry => entry.path === path && entry.sourceRevision === source.revision)) return;
    const previous = pending.get(path);
    if (previous?.revision === source.revision) return;
    previous?.controller.abort("newer reading note");
    const entry = { revision: source.revision, controller: new AbortController() };
    pending.set(path, entry);
    const current = () => {
      entry.controller.signal.throwIfAborted();
      if (!active || !isCurrent() || !store.settings.ai.dataDisclosureAccepted || store.settings.ai.provider === "off") {
        throw new Error("阅读索引已停止。");
      }
    };
    try {
      current();
      const summary = await summarizeReadingSource(store, source, request, { signal: entry.controller.signal, assertTextRequestCurrent: current });
      await host.saveLocalOperation("local_index_reading", { path, revision: source.revision }, scope => saveReadingEntry(scope, source, summary),
        { assertCurrent: current, assertBeforeCommit: () => assertReadingSource(store, source) });
    } finally {
      if (pending.get(path) === entry) pending.delete(path);
    }
  });
  return () => {
    active = false;
    unsubscribe();
    for (const entry of pending.values()) entry.controller.abort("reading indexing stopped");
    pending.clear();
  };
}
