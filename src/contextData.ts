import { isContextSourcePath, contextSourceHash } from "./sourceReferences";
import { isVaultPathExcluded } from "./privacy";
import { jsonDataContract, parseJsonData } from "./dataFoundation/jsonDataGuard";
import { TaskConflictError, validateTaskMirrorRevision, validateTaskRecords } from "./dataFoundation/taskPersistence";
import { normalizeTasks, normalizeHabitDefinitions, type StoreHost, type HabitDatabase, type TaskDatabase } from "./store/settingsSlice";
import { parseVaultTasks } from "./vaultApi";
import type { TaskDashboardData } from "./types";
import { automaticHabitProgress } from "./features/habits/tradeProgress";

export interface ContextDataSource { path: string; hash: string }
export interface ContextTaskData { available: boolean; tasks: TaskDatabase["tasks"]; source?: ContextDataSource; reads?: ContextDataSource[]; missing?: string[]; filtered?: boolean }
export interface ContextHabitData { available: boolean; database: HabitDatabase; source?: ContextDataSource; missing?: string[]; tradeUnavailable?: boolean }
export interface DashboardContextData { tasks: ContextTaskData; habits: ContextHabitData; policy: string }
const dashboardSources = new WeakMap<TaskDashboardData, DashboardContextData>();
const readOnlyDatabases = new WeakSet<HabitDatabase>();
export function isContextDataProjection(value: HabitDatabase): boolean { return readOnlyDatabases.has(value); }
function habitProjection(database: HabitDatabase): HabitDatabase { readOnlyDatabases.add(database); return database; }
export function bindDashboardContextData(dashboard: TaskDashboardData, data: DashboardContextData): void { dashboardSources.set(dashboard, data); }
export function dashboardContextData(dashboard: TaskDashboardData): DashboardContextData | undefined { return dashboardSources.get(dashboard); }
export function contextDataPolicy(store: StoreHost): string {
  return JSON.stringify({ tasks: store.settings.folders.tasks, habits: store.settings.folders.habits, trades: store.settings.folders.tradingReviews,
    excluded: store.settings.privacy?.excludedVaultPrefixes ?? [] });
}
const allowed = (store: StoreHost, path: string) => isContextSourcePath(path) && !isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes);
async function read(store: StoreHost, path: string, policy: string): Promise<{ raw: string; source: ContextDataSource } | null> {
  if (contextDataPolicy(store) !== policy || !allowed(store, path)) throw new Error("当前记录权限变化，无法核对上下文。");
  const file = store.getFile(path);
  if (!file) return null;
  if (file.path !== path) throw new Error("当前记录身份无法核对。");
  const raw = await store.readPath(path);
  if (contextDataPolicy(store) !== policy || !allowed(store, path)) throw new Error("当前记录权限变化，无法核对上下文。");
  return { raw, source: { path, hash: contextSourceHash(raw) } };
}
/** Separate read-only DTOs: never hand filtered records to a persistence method. */
export async function readContextTasks(store: StoreHost): Promise<ContextTaskData> {
  const policy = contextDataPolicy(store), path = store.taskDbPath(), mirrorPath = store.taskMirrorPath();
  if (!allowed(store, path)) return { available: false, tasks: [] };
  const json = await read(store, path, policy);
  // A missing JSON may use the legacy mirror; an excluded JSON never may.
  const mirror = allowed(store, mirrorPath) ? await read(store, mirrorPath, policy) : null;
  if (contextDataPolicy(store) !== policy) throw new Error("当前记录权限变化，无法核对上下文。");
  const reads = [json?.source, mirror?.source].filter((value): value is ContextDataSource => !!value);
  const missing = [!json ? path : "", !mirror && allowed(store, mirrorPath) ? mirrorPath : ""].filter(Boolean);
  let records: TaskDatabase["tasks"], source: ContextDataSource;
  if (json) {
    const db = parseJsonData(json.raw, path, jsonDataContract(path, store.settings.folders)) as TaskDatabase;
    validateTaskMirrorRevision(db);
    if (db.tasks.length === 0 && !allowed(store, mirrorPath)) return { available: false, tasks: [], reads, missing };
    if (db.tasks.length === 0 && mirror && /^\s*-\s+\[[ xX]\]/m.test(mirror.raw)) throw new TaskConflictError();
    records = db.tasks; source = json.source;
  } else {
    if (!mirror) return { available: false, tasks: [], reads, missing };
    records = parseVaultTasks(mirror.raw); source = mirror.source;
  }
  validateTaskRecords(records);
  const tasks = normalizeTasks(records).filter(task => !task.sourceNotePath || !isVaultPathExcluded(task.sourceNotePath, store.settings.privacy?.excludedVaultPrefixes));
  return { available: true, tasks, source, reads, missing, filtered: tasks.length !== records.length };
}
export async function readContextHabits(store: StoreHost): Promise<ContextHabitData> {
  const policy = contextDataPolicy(store), path = store.habitDbPath();
  if (!allowed(store, path)) return { available: false, database: habitProjection({ habits: [], checkins: [] }) };
  const file = await read(store, path, policy);
  if (!file) return { available: false, database: habitProjection({ habits: [], checkins: [] }), missing: [path] };
  const db = parseJsonData(file.raw, path, jsonDataContract(path, store.settings.folders)) as HabitDatabase;
  const database = { ...db, habits: normalizeHabitDefinitions(db.habits ?? []), checkins: db.checkins ?? [] };
  const progress = await automaticHabitProgress(store, database, true);
  if (contextDataPolicy(store) !== policy) throw new Error("当前记录权限变化，无法核对上下文。");
  return { available: true, source: file.source, database: habitProjection({ ...database, checkins: progress.checkins }),
    ...(progress.unavailable ? { tradeUnavailable: true } : {}) };
}
