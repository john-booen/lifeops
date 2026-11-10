import { formatDate } from "../../date";
import { readScopedMarkdown } from "../../dataFoundation/markdownSources";
import type { LifeOpsEventBus } from "../../lifeOpsEventBus";
import { fileRevision } from "../../operationIdentity";
import type { StoreHost } from "../../store/settingsSlice";
import type { LocalOperationHost } from "../serviceHost";
import { learningNoteAllowed, newLearningNoteTrack, readLearningDocument, recordLearningNote } from "./store";

export function subscribeLearningNotes(host: LocalOperationHost, store: StoreHost, events: LifeOpsEventBus, isCurrent = () => true): () => void {
  let active = true;
  const current = () => { if (!active || !isCurrent()) throw new Error("学习记录已停止。"); };
  const unsubscribe = events.subscribe(async event => {
    if (!active || event.type !== "vault.created" && event.type !== "vault.modified") return;
    current();
    const path = (event.payload as { path?: string }).path;
    if (typeof path !== "string" || !learningNoteAllowed(store, path)) return;
    const date = formatDate(new Date(event.occurredAt));
    const doc = await readLearningDocument(store);
    if (!newLearningNoteTrack(store, doc, path, date)) return;
    const revision = fileRevision(await readScopedMarkdown(store, path));
    const assertNote = async () => {
      current();
      if (!learningNoteAllowed(store, path) || fileRevision(await readScopedMarkdown(store, path)) !== revision) {
        throw new Error("学习笔记有更新，等待最新版本的事件。");
      }
    };
    let saved = false;
    await host.saveLocalOperation("local_capture_learning_note", { path, date }, async scope => {
      await assertNote();
      saved = await recordLearningNote(scope, path, date);
    }, { assertCurrent: current, assertBeforeCommit: assertNote });
    if (saved) await host.refreshViews().catch(() => undefined);
  });
  return () => { active = false; unsubscribe(); };
}
