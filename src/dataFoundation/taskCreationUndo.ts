import type { LifeOpsTask } from "../types";
import type { StoreHost, TaskDatabase } from "../store/settingsSlice";
import { fileRevision, recordRevision } from "../operationIdentity";
import type { GuardedFileChange } from "./factOperation";
import type { OperationLedgerRecord, OperationUndoDescriptor } from "./operationLedger";

export function createdTaskForUndo(record: OperationLedgerRecord, taskPath: string): LifeOpsTask | undefined {
  if (record.toolName !== "create_task" && record.toolName !== "local_createTask") return;
  const undo = record.result?.undo;
  if (undo?.kind !== "restore_guarded_files") return;
  const change = undo.files.find(file => file.path === taskPath);
  if (!change?.after) return;
  try {
    const before: TaskDatabase = change.before === null ? { tasks: [] } : JSON.parse(change.before);
    const after: TaskDatabase = JSON.parse(change.after);
    const prior = new Map(before.tasks.map(task => [task.id, recordRevision(task)]));
    if (after.tasks.length !== before.tasks.length + 1 || prior.size !== before.tasks.length) return;
    const added = after.tasks.filter(task => !prior.has(task.id));
    if (added.length === 1 && after.tasks.every(task => !prior.has(task.id) || prior.get(task.id) === recordRevision(task))) return added[0];
  } catch { /* The normal undo path still verifies its file snapshots. */ }
}

export async function taskCreationUndoAcrossCompensation(store: StoreHost, record: OperationLedgerRecord,
  descriptor: OperationUndoDescriptor, later: OperationLedgerRecord[]): Promise<GuardedFileChange[] | undefined> {
  if (descriptor.kind !== "restore_guarded_files" || descriptor.files.length !== 2) return;
  const taskPath = store.taskDbPath(), mirrorPath = store.taskMirrorPath();
  const taskFile = descriptor.files.find(file => file.path === taskPath);
  const mirrorFile = descriptor.files.find(file => file.path === mirrorPath);
  const task = createdTaskForUndo(record, taskPath);
  if (!taskFile || !mirrorFile || !task) return;

  // Bridge only changes accounted for by the scheduled compensation records.
  let json = taskFile.after, mirror = mirrorFile.after;
  for (const operation of later) {
    const undo = operation.result?.undo;
    if (operation.toolName !== "local_checkHabitPunishments" || operation.source !== "system"
      || operation.status !== "verified" || undo?.kind !== "restore_guarded_files") continue;
    const nextJson = undo.files.find(file => file.path === taskPath);
    const nextMirror = undo.files.find(file => file.path === mirrorPath);
    if (nextJson && nextMirror && nextJson.before === json && nextMirror.before === mirror) {
      json = nextJson.after;
      mirror = nextMirror.after;
    }
  }
  if (json === taskFile.after || json === null || mirror === null) return;
  const { planTaskDatabaseWrite } = await import("./taskPersistence");
  const database = await store.readTaskDb({ readOnly: true });
  const current = database.tasks.find(item => item.id === task.id);
  if (!current || recordRevision(current) !== recordRevision(task)) return;

  database.tasks = database.tasks.filter(item => item.id !== task.id);
  const next = planTaskDatabaseWrite(store, database);
  if (next.snapshot.json !== json || next.snapshot.mirror !== mirror) return;
  return [[taskPath, next.json, json], [mirrorPath, next.mirror, mirror]].map(([path, before, after]) => ({
    path, before, after, beforeHash: fileRevision(before), afterHash: fileRevision(after)
  }));
}
