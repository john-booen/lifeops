import type { StoreHost } from "../store/settingsSlice";
import { DataProtectionError, jsonDataContract, parseJsonData } from "./jsonDataGuard";
import { fileRevision, isGuardedOperationScope } from "./factOperation";
import { emptyProjectDocument, projectFileName, validateProjectDocument, type ProjectDocument } from "../projectContinuity";

export const projectReadSnapshot = Symbol("lifeops-project-read-snapshot");
type DocumentSnapshot = ProjectDocument & { [projectReadSnapshot]?: { raw: string | null } };
export function projectDocumentPath(store: StoreHost): string { return store.path(store.settings.folders.goals, projectFileName()); }
export function projectConflict(): never { throw new Error("目标与项目已发生变化，已停止覆盖；请重新打开，核对最新记录后再保存。"); }
async function rawFile(store: StoreHost): Promise<string | null> {
  const path = projectDocumentPath(store);
  return store.getFile(path) ? store.readPath(path) : null;
}
export async function readProjectDocument(store: StoreHost): Promise<DocumentSnapshot> {
  const path = projectDocumentPath(store), raw = await rawFile(store);
  const document = raw === null ? emptyProjectDocument() : parseJsonData(raw, path, jsonDataContract(path, store.settings.folders));
  if (!validateProjectDocument(document)) throw new DataProtectionError(path, "shape");
  return { ...document, [projectReadSnapshot]: { raw } };
}
export function projectDocumentRevision(document: DocumentSnapshot): string { return fileRevision(document[projectReadSnapshot]!.raw); }
export async function persistProjectDocument(store: StoreHost, document: DocumentSnapshot): Promise<void> {
  if (!isGuardedOperationScope(store)) throw new Error("目标与项目只能通过有记录、可恢复的保存入口修改。");
  const path = projectDocumentPath(store), snapshot = document[projectReadSnapshot];
  if (!snapshot || !validateProjectDocument(document)) throw new DataProtectionError(path, "shape");
  const next = `${JSON.stringify(document, null, 2)}\n`;
  if (await rawFile(store) !== snapshot.raw) projectConflict();
  const file = store.getFile(path);
  if (file) await store.app.vault.process(file, current => {
    if (current !== snapshot.raw) projectConflict();
    parseJsonData(current, path, jsonDataContract(path, store.settings.folders));
    return next;
  });
  else {
    await store.ensureFolder(store.settings.folders.goals);
    await store.app.vault.create(path, next);
  }
  if (await rawFile(store) !== next) throw new Error("目标与项目保存后核对失败，请先恢复或检查这次操作。");
  document[projectReadSnapshot] = { raw: next };
}
