import { formatDate, normalizeJournalDate, todayString } from "../../date";
import { guardedOperationIdentity } from "../../dataFoundation/factOperation";
import { fileRevision } from "../../operationIdentity";
import { isVaultPathExcluded } from "../../privacy";
import { isContextSourcePath } from "../../sourceReferences";
import type { StoreHost } from "../../store/settingsSlice";
import type { LifeOpsTask } from "../../types";
import { LEARNING_TRACKS, effectiveLearningTrack, isLearningMinutes, isLearningTrackId, isLearningUnitStatus, validLearningDocument,
  type LearningDocument, type LearningSession, type LearningTrack, type LearningTrackId, type LearningUnitStatus } from "./model";

export const LEARNING_FILE = "LifeOps学习轨道.json";
export const learningPath = (store: StoreHost) => store.path(store.settings.folders.aiReports, "Learning", LEARNING_FILE);

export function learningFolderAllowed(store: StoreHost, folder: string): boolean {
  const root = store.settings.folders.aiReports;
  return isContextSourcePath(folder) && !folder.split("/").some(part => part.startsWith("."))
    && folder !== root && !folder.startsWith(root + "/") && !isVaultPathExcluded(folder, store.settings.privacy?.excludedVaultPrefixes);
}
export function learningNoteAllowed(store: StoreHost, path: string): boolean {
  return path.endsWith(".md") && learningFolderAllowed(store, path) && store.getFile(path)?.path === path;
}
export function defaultLearningFolders(store: StoreHost, id: LearningTrackId): string[] {
  const path = store.settings.folders.tradingModels;
  return id === "trading" && learningFolderAllowed(store, path) ? [path] : [];
}
export const blankLearningTrack = (store: StoreHost, id: LearningTrackId): LearningTrack => ({
  id, name: LEARNING_TRACKS[id], goal: "", weeklyMinutes: 0, folders: defaultLearningFolders(store, id), units: [], sessions: []
});

export async function readLearningDocument(store: StoreHost): Promise<LearningDocument> {
  const path = learningPath(store);
  if (isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)) throw new Error("学习记录目录已排除。");
  const doc = await store.readJson<LearningDocument>(path, { version: 1, tracks: [] });
  if (!validLearningDocument(doc)) throw new Error("学习轨道记录格式异常，请先核对。");
  return doc;
}

export function existingLearningTrack(store: StoreHost, doc: LearningDocument, id: LearningTrackId, date = todayString()): LearningTrack {
  return effectiveLearningTrack(doc.tracks.find(track => track.id === id) ?? blankLearningTrack(store, id), date);
}

export function visibleLearningTrack(store: StoreHost, track: LearningTrack): LearningTrack {
  const excluded = store.settings.privacy?.excludedVaultPrefixes;
  return { ...track, folders: track.folders.filter(folder => learningFolderAllowed(store, folder)),
    nextPlan: track.nextPlan ? { ...track.nextPlan, folders: track.nextPlan.folders.filter(folder => learningFolderAllowed(store, folder)) } : undefined,
    sessions: track.sessions.filter(session => !session.notePath || !isVaultPathExcluded(session.notePath, excluded)) };
}

export async function writeLearningTrack(store: StoreHost, doc: LearningDocument, track: LearningTrack): Promise<void> {
  const identity = guardedOperationIdentity(store);
  if (!identity || identity.purpose === "derived") throw new Error("学习记录须通过可撤销的保存入口写入。");
  const next = { ...doc, tracks: [...doc.tracks.filter(item => item.id !== track.id), track] };
  if (!validLearningDocument(next)) throw new Error("这次学习记录内容无效。");
  await store.writeJson(learningPath(store), next);
}

export function learningTrackForPath(store: StoreHost, doc: LearningDocument, path: string): LearningTrackId | undefined {
  if (!learningNoteAllowed(store, path)) return;
  const matches = (Object.keys(LEARNING_TRACKS) as LearningTrackId[]).flatMap(id =>
    existingLearningTrack(store, doc, id).folders.flatMap(folder =>
      learningFolderAllowed(store, folder) && path.startsWith(folder + "/") ? [{ id, length: folder.length }] : []));
  const longest = Math.max(0, ...matches.map(match => match.length));
  const tracks = [...new Set(matches.filter(match => match.length === longest).map(match => match.id))];
  return tracks.length === 1 ? tracks[0] : undefined;
}

async function appendLearningSession(store: StoreHost, doc: LearningDocument, id: LearningTrackId, session: LearningSession): Promise<boolean> {
  const track = existingLearningTrack(store, doc, id);
  if (session.key && track.sessions.some(previous => previous.key === session.key)) return false;
  await writeLearningTrack(store, doc, { ...track, sessions: [...track.sessions, session] });
  return true;
}

export async function recordLearningTime(store: StoreHost, id: LearningTrackId, input: { minutes?: number; date?: string; summary?: string },
  key: string, now = new Date()): Promise<string> {
  const today = formatDate(now), date = input.date ? normalizeJournalDate(input.date, today) : today;
  if (!date || date > today || input.minutes !== undefined && !isLearningMinutes(input.minutes) || (input.summary?.length ?? 0) > 600) {
    throw new Error("请核对学习日期、分钟数和简短备注。");
  }
  await appendLearningSession(store, await readLearningDocument(store), id,
    { date, minutes: input.minutes, summary: input.summary?.trim() || undefined, key: "chat:" + key });
  return date;
}

export async function recordLearningNote(store: StoreHost, path: string, date: string): Promise<boolean> {
  const doc = await readLearningDocument(store);
  const id = newLearningNoteTrack(store, doc, path, date);
  if (!id) return false;
  return appendLearningSession(store, doc, id, { date, notePath: path, key: noteSessionKey(path, date) });
}

const noteSessionKey = (path: string, date: string) => "note:" + date + ":" + fileRevision(path);
export function newLearningNoteTrack(store: StoreHost, doc: LearningDocument, path: string, date: string): LearningTrackId | undefined {
  const id = learningTrackForPath(store, doc, path);
  return id && !existingLearningTrack(store, doc, id).sessions.some(session => session.key === noteSessionKey(path, date)) ? id : undefined;
}

export async function recordLearningTask(store: StoreHost, task: LifeOpsTask, date: string, note: string): Promise<void> {
  if (task.category !== "learning") return;
  if (task.sourceNotePath && isVaultPathExcluded(task.sourceNotePath, store.settings.privacy?.excludedVaultPrefixes)) return;
  if (isVaultPathExcluded(learningPath(store), store.settings.privacy?.excludedVaultPrefixes)) return;
  const doc = await readLearningDocument(store);
  const id = isLearningTrackId(task.learningTrackId) ? task.learningTrackId : learningTrackForPath(store, doc, task.sourceNotePath);
  if (!id) return;
  const path = task.sourceNotePath && learningNoteAllowed(store, task.sourceNotePath) ? task.sourceNotePath : undefined;
  const summary = [task.title, note.trim()].filter(Boolean).join(" · ").slice(0, 600);
  await appendLearningSession(store, doc, id, { date, notePath: path, summary, key: "task:" + task.id });
}

export async function updateLearningUnit(store: StoreHost, id: LearningTrackId, unitId: string, status: LearningUnitStatus, today: string) {
  const doc = await readLearningDocument(store), track = existingLearningTrack(store, doc, id);
  const unit = track.units.find(item => item.id === unitId);
  if (!unit || !isLearningUnitStatus(status)) throw new Error("找不到可修改的学习单元。");
  if (unit.status === status) return unit;
  const updated = { ...unit, status, doneAt: status === "done" ? today : undefined };
  await writeLearningTrack(store, doc, { ...track, units: track.units.map(item => item === unit ? updated : item) });
  return updated;
}
