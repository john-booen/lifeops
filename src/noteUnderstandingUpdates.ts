import { randomUUID } from "node:crypto";
import { personalMemoryReadSnapshot, personalMemorySourceAssessment } from "./personalMemory";
import { NOTE_UNDERSTANDING_VERSION, allowedNoteUnderstandingSource, noPendingNoteUnderstanding, noteSourceHash, noteSourcePolicy, noteUnderstandingDraftMessage } from "./noteUnderstandingSource";
import type { ToolExecutionContext } from "./toolRegistry";
import type { StoreHost } from "./store/settingsSlice";
export type UnderstandingUpdateStatus = "needs_review" | "not_reviewed" | "current_candidate" | "current_record" | "missing" | "excluded" | "too_large" | "blocked_content";
export interface UnderstandingUpdate { token: string; path: string; status: UnderstandingUpdateStatus; versions: number }
type Snapshot = { rowHash: string; memoryRaw: string | null; policy: string; contentHash: string };
const choices = new WeakMap<StoreHost, Map<string, Snapshot>>(), rowHash = (row: UnderstandingUpdate) => noteSourceHash(JSON.stringify(row));
export async function listUnderstandingUpdates(context: ToolExecutionContext, activePath?: string): Promise<{ rows: UnderstandingUpdate[]; remainingSources: number }> {
  const store = context.store; context.assertCurrent?.(); await noPendingNoteUnderstanding(store); const baseline = noteSourcePolicy(store);

  const document = await store.readPersonalMemories(), memoryRaw = document[personalMemoryReadSnapshot]?.raw;
  if (memoryRaw === undefined) throw new Error("个人记忆版本未核对，未展示原文更新。");
  const refs = document.records.filter(record => record.status !== "forgotten" && record.sourceBinding?.version === 1 && !(record.expiresAt && Date.parse(record.expiresAt) <= Date.now()))
    .flatMap(record => record.sourceRefs.filter(ref => /^[a-f0-9]{64}$/.test(ref.contentHash ?? "") && ref.extractionVersion).map(ref => ({ record, ref })));
  const knownPaths = [...new Set(refs.map(item => item.ref.path))].sort(), selected = knownPaths.slice(0, 32);
  if (activePath && allowedNoteUnderstandingSource(store, activePath) && store.getFile(activePath) && !selected.includes(activePath)) { if (selected.length === 32) selected.pop(); selected.unshift(activePath); }
  const filter = (await import("./personalMemoryContext")).createPersonalMemoryContextFilter(document.records.map(record => ({ ...record, [personalMemorySourceAssessment]: undefined }))), rows: UnderstandingUpdate[] = [], pending: Array<{ row: UnderstandingUpdate; contentHash: string }> = [];
  for (const path of selected) {
    context.assertCurrent?.(); const versions = new Set(refs.filter(item => item.ref.path === path).map(item => item.ref.contentHash)).size;
    let status: UnderstandingUpdateStatus, contentHash = "";
    if (!allowedNoteUnderstandingSource(store, path)) status = "excluded";
    else if (!store.getFile(path)) status = "missing";
    else if ((store.getFile(path)?.stat?.size ?? 0) > 256 * 1024) status = "too_large";
    else {
      const raw = await store.readPath(path); contentHash = noteSourceHash(raw);
      if (!allowedNoteUnderstandingSource(store, path) || !store.getFile(path)) throw new Error("核对期间原文范围变化，请刷新。");
      if (Buffer.byteLength(raw, "utf8") > 256 * 1024) status = "too_large";
      else if (filter(raw) !== raw) status = "blocked_content";
      else {
        const current = refs.filter(item => item.ref.path === path && item.ref.contentHash === contentHash && item.ref.extractionVersion === NOTE_UNDERSTANDING_VERSION);
        status = current.length ? current.some(item => item.record.status === "candidate") ? "current_candidate" : "current_record" : versions ? "needs_review" : "not_reviewed";
      }
    }
    const row: UnderstandingUpdate = { token: randomUUID(), path, status, versions }; rows.push(row); pending.push({ row, contentHash });
  }
  await noPendingNoteUnderstanding(store);
  for (const item of pending.filter(item => item.contentHash)) {
    if (!allowedNoteUnderstandingSource(store, item.row.path) || !store.getFile(item.row.path)) throw new Error("核对期间原文范围变化，请刷新。");
    if (noteSourceHash(await store.readPath(item.row.path)) !== item.contentHash) throw new Error("核对期间原文变化，请刷新，不展示旧状态。");
  }
  if ((await store.readPersonalMemories())[personalMemoryReadSnapshot]?.raw !== memoryRaw || noteSourcePolicy(store) !== baseline) throw new Error("核对期间记忆或权限变化，请刷新。");
  context.assertCurrent?.();
  let map = choices.get(store); if (!map) { map = new Map(); choices.set(store, map); }
  for (const { row, contentHash } of pending) if (["needs_review", "not_reviewed"].includes(row.status)) map.set(row.token, { rowHash: rowHash(row), memoryRaw, policy: baseline, contentHash });
  while (map.size > 64) map.delete(map.keys().next().value!);
  return { rows, remainingSources: knownPaths.filter(path => !selected.includes(path)).length };
}
export async function prepareUnderstandingUpdate(row: UnderstandingUpdate, context: ToolExecutionContext, compose: (message: string, assertCurrent: () => void) => Promise<void>): Promise<void> {
  const store = context.store, saved = choices.get(store)?.get(row.token);
  if (!saved || saved.rowHash !== rowHash(row) || !["needs_review", "not_reviewed"].includes(row.status)) throw new Error("原文更新选择已失效，请刷新后重新选择。");

  const assertCurrent = () => { context.assertCurrent?.(); if (noteSourcePolicy(store) !== saved.policy || !allowedNoteUnderstandingSource(store, row.path) || !store.getFile(row.path)) throw new Error("原文或权限已变化，请刷新；未继续准备请求。");  };

  assertCurrent(); await noPendingNoteUnderstanding(store); assertCurrent();
  if (noteSourceHash(await store.readPath(row.path)) !== saved.contentHash || (await store.readPersonalMemories())[personalMemoryReadSnapshot]?.raw !== saved.memoryRaw) throw new Error("原文或记忆已更新，请刷新列表，不沿用旧选择。");
  await noPendingNoteUnderstanding(store); assertCurrent(); await compose(noteUnderstandingDraftMessage(row.path), assertCurrent); assertCurrent();
}
