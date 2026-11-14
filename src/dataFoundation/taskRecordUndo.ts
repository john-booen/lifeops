import type { LifeOpsTask } from "../types";
import type { StoreHost, TaskDatabase } from "../store/settingsSlice";
import { fileRevision, recordRevision } from "../operationIdentity";
import type { GuardedFileChange } from "./factOperation";
import type { OperationLedgerRecord, OperationUndoDescriptor } from "./operationLedger";

function taskDelta(file: GuardedFileChange) {
  const parse = (text: string | null) => {
    const document = (text === null ? { tasks: [] } : JSON.parse(text)) as TaskDatabase;
    if (!Array.isArray(document.tasks) || document.tasks.some(task => !task || typeof task.id !== "string")
      || new Set(document.tasks.map(task => task.id)).size !== document.tasks.length) throw new Error("任务撤销记录格式无效。");
    const { taskMirror: _mirror, tasks, ...metadata } = document;
    return { metadata, tasks: new Map(tasks.map(task => [task.id, task])) };
  };
  if (fileRevision(file.before) !== file.beforeHash || fileRevision(file.after) !== file.afterHash) {
    throw new Error("任务撤销记录未通过校验。");
  }
  const before = parse(file.before), after = parse(file.after);
  if (recordRevision(before.metadata) !== recordRevision(after.metadata)) return;
  const changed = [...new Set([...before.tasks.keys(), ...after.tasks.keys()])].flatMap(id => {
    const prior = before.tasks.get(id), saved = after.tasks.get(id);
    const revision = saved ? recordRevision(saved) : null;
    return (prior ? recordRevision(prior) : null) === revision ? [] : [{ id, prior, saved, revision }];
  });
  return changed;
}

export function createdTaskForUndo(record: OperationLedgerRecord, taskPath: string): LifeOpsTask | undefined {
  const undo = record.result?.undo;
  const change = undo?.kind === "restore_guarded_files" ? undo.files.find(file => file.path === taskPath) : undefined;
  if (!change) return;
  try {
    const rows = taskDelta(change);
    if (rows?.length === 1 && !rows[0].prior) return rows[0].saved;
  } catch { /* The undo operation still validates its saved revisions. */ }
}

export async function rebaseTaskRecordUndo(store: StoreHost, descriptor: OperationUndoDescriptor): Promise<GuardedFileChange[] | undefined> {
  if (descriptor.kind !== "restore_guarded_files") return;
  const taskPath = store.taskDbPath(), mirrorPath = store.taskMirrorPath();
  const json = descriptor.files.find(file => file.path === taskPath);
  const mirror = descriptor.files.find(file => file.path === mirrorPath);
  if (!json || !mirror) return;
  const persistence = await import("./taskPersistence");
  const { planTaskDatabaseWrite, readTaskFile } = persistence;
  const currentJson = await readTaskFile(store, taskPath), currentMirror = await readTaskFile(store, mirrorPath);
  if (json.after === currentJson && mirror.after === currentMirror) return;
  if (currentJson === null || fileRevision(mirror.before) !== mirror.beforeHash || fileRevision(mirror.after) !== mirror.afterHash) return;
  const changes = taskDelta(json);
  if (!changes?.length) return;
  const database = await store.readTaskDb({ readOnly: true });
  const snapshot = database[persistence.taskReadSnapshot];
  if (!snapshot || snapshot.json !== currentJson || snapshot.mirror !== currentMirror) {
    throw new Error("撤销期间任务库发生变化，请重试。");
  }
  const current = new Map((JSON.parse(currentJson) as TaskDatabase).tasks.map(task => [task.id, task]));
  const affected = new Set(changes.map(change => change.id));
  for (const { id, revision } of changes) {
    const task = current.get(id);
    if ((task ? recordRevision(task) : null) !== revision) {
      throw new Error("这次操作涉及的任务后来已修改，未撤销。");
    }
  }
  const restored = new Map(changes.flatMap(({ id, prior }) => prior ? [[id, prior] as const] : []));
  database.tasks = [...current.values()].flatMap(task => affected.has(task.id) ? (restored.get(task.id) ?? []) : task);
  for (const { id, prior, saved } of changes) if (prior && !saved && !current.has(id)) database.tasks.push(prior);
  const next = planTaskDatabaseWrite(store, database, mirror.before);
  return descriptor.files.map(file => {
    if (file.path !== taskPath && file.path !== mirrorPath) return file;
    const [before, after] = file.path === taskPath ? [next.json, currentJson] : [next.mirror, currentMirror];
    return { path: file.path, before, after, beforeHash: fileRevision(before), afterHash: fileRevision(after) };
  });
}
