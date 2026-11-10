import { createHash } from "node:crypto";
import type { AiToolCall } from "./ai";
import { getCommittedContextEvidence, getCommittedTaskEvidence, type ToolCallResult } from "./agentRuntime";
import { operationFingerprint, type OperationLedgerDocument } from "./dataFoundation/operationLedger";
import { guardedOperationIdentity, isGuardedOperationScope, inspectFactRecovery, type GuardedFileChange } from "./dataFoundation/factOperation";
import { recordRevision } from "./operationIdentity";
import { continuityHash, projectFileName, projectEntrySourcePaths, validateProjectDocument, PROJECT_FIELDS, PROJECT_SNAPSHOT_FIELDS, type ProjectSnapshot } from "./projectContinuity";
import type { ProjectJobProjectBinding, ProjectNextStepArguments } from "./projectJobRepository";
import { isVaultPathExcluded } from "./privacy";
import type { StoreHost } from "./store/settingsSlice";
import type { LifeOpsTask } from "./types";

/** Opaque, local snapshot; copying its fields does not create a usable baseline. */
export interface ProjectToolSnapshot {
  readonly contextRevision: string;
  readonly memoryRevision: string;
}
/** Persisted evidence is compared with a fresh read; it never creates a WeakMap capability. */
export interface ProjectTaskBaseline {
  [key: string]: unknown;
  contextRevision: string;
  memoryRevision: string;
  protectedRevision: string;
  settingsRevision: string;
  taskJsonHash: string;
  taskMirrorHash: string;
  sourcePaths: string[];
}
interface SnapshotState {
  host: StoreHost;
  sourcePaths: readonly string[];
  settingsRevision: string;
  protectedRevision: string;
  taskJson: string | null;
  taskMirror: string | null;
  projectRaw: string | null;
  protectedInput: { settingsRevision: string; projectRaw: string | null; memoryRaw: string | null; memoryRevision: string; sources: string[][] };
  contextRevision: string;
  memoryRevision: string;
  contextInput: { revision: string; tasks: LifeOpsTask[]; artifacts: ProjectSnapshot["artifacts"]; sources: Array<[string, string]>; excluded: string[] };
}
const snapshots = new WeakMap<ProjectToolSnapshot, SnapshotState>();
export class ProjectToolContinuityError extends Error {
  constructor() { super("目标、任务、来源或隐私记录无法核对，已停止后续安排；已完成的保存以实际回执为准。"); }
}
function stop(): never { throw new ProjectToolContinuityError(); }
function hash(raw: string | null): string { return raw === null ? "absent" : createHash("sha256").update(raw, "utf8").digest("hex"); }
async function raw(store: StoreHost, path: string): Promise<string | null> {
  const file = store.getFile(path);
  if (!file) return null;
  if (file.path !== path) stop();
  return store.readPath(path);
}
function publish(state: SnapshotState): ProjectToolSnapshot {
  const snapshot = Object.freeze({ contextRevision: state.contextRevision, memoryRevision: state.memoryRevision });
  snapshots.set(snapshot, state); return snapshot;
}
function stateOf(store: StoreHost, snapshot: ProjectToolSnapshot): SnapshotState {
  const state = snapshots.get(snapshot);
  if (!state || state.host !== store) stop();
  return state;
}
async function readOnce(store: StoreHost, sourcePaths: readonly string[]): Promise<SnapshotState> {
  const settingsRevision = recordRevision({ folders: store.settings.folders, privacy: store.settings.privacy });
  const excluded = store.settings.privacy?.excludedVaultPrefixes ?? [];
  const projectPath = store.path(store.settings.folders.goals, projectFileName());
  if (isVaultPathExcluded(projectPath, excluded) || isVaultPathExcluded(store.taskDbPath(), excluded)) stop();
  const contextRevision = await store.getProjectContextRevision();
  const project = await store.getProjectSnapshot();
  const [{ readPersonalMemoryWithSources }, { personalMemoryContextRevision }] = await Promise.all([
    import("./personalMemorySources"), import("./personalMemoryContext")
  ]);
  const memory = await readPersonalMemoryWithSources(store);
  const projectRaw = await raw(store, projectPath);
  if (hash(projectRaw) !== project.revision) stop();
  const taskJson = await raw(store, store.taskDbPath()), taskMirror = await raw(store, store.taskMirrorPath());
  const memoryRaw = await raw(store, store.personalMemoryPath());
  const ledgerPath = store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
  const paths = [...new Set([...sourcePaths, ...project.document.goals.map(goal => goal.sourcePath),
    ...project.document.projects.flatMap(item => [item.nextStepSourcePath, ...item.entries.flatMap(projectEntrySourcePaths)]),
    ...project.tasks.map(task => task.sourceNotePath), ...memory.records.flatMap(item => item.sourceRefs.map(ref => ref.path))]
    .filter(path => Boolean(path) && path !== ledgerPath))].sort();
  const sources = [];
  const sourceStates = new Map<string, string>();
  for (const path of paths) {
    const allowed = store.isManagedSourcePath(path) && !isVaultPathExcluded(path, excluded);
    // Excluded sources are never read or released. Read errors on allowed files fail closed.
    const value = allowed ? await raw(store, path) : null;
    sources.push([path, allowed ? hash(value) : "unavailable"]);
    sourceStates.set(path, value === null ? "unavailable" : hash(value));
  }
  if (settingsRevision !== recordRevision({ folders: store.settings.folders, privacy: store.settings.privacy })) stop();
  const memoryRevision = personalMemoryContextRevision(memory.records);
  const projectSources = [...new Set([...project.document.goals.map(goal => goal.sourcePath),
    ...project.document.projects.flatMap(item => [item.nextStepSourcePath, ...item.entries.flatMap(projectEntrySourcePaths)]),
    ...project.tasks.map(task => task.sourceNotePath)].filter(Boolean))].sort().filter(path => !isVaultPathExcluded(path, excluded));
  const contextInput = { revision: project.revision, tasks: project.tasks, artifacts: project.artifacts,
    sources: projectSources.map(path => [path, sourceStates.get(path) ?? "unavailable"] as [string, string]), excluded: [...excluded] };
  if (continuityHash(contextInput) !== contextRevision) stop();
  const protectedInput = { settingsRevision, projectRaw, memoryRaw, memoryRevision, sources };
  return { host: store, sourcePaths, settingsRevision, taskJson, taskMirror, projectRaw, protectedInput, contextRevision, memoryRevision,
    contextInput, protectedRevision: recordRevision(protectedInput) };
}
function same(left: SnapshotState, right: SnapshotState): boolean {
  return left.protectedRevision === right.protectedRevision && left.taskJson === right.taskJson
    && left.taskMirror === right.taskMirror && left.contextRevision === right.contextRevision;
}
async function stableRead(store: StoreHost, sourcePaths: readonly string[]): Promise<SnapshotState> {
  try {
    const first = await readOnce(store, sourcePaths), second = await readOnce(store, sourcePaths);
    if (!same(first, second)) stop();
    return second;
  } catch { return stop(); }
}

/** Capture before the model/plan uses project facts. Extra sources must be the actual context sources. */
export async function captureProjectToolSnapshot(store: StoreHost, sourcePaths: readonly string[] = []): Promise<ProjectToolSnapshot> {
  return publish(await stableRead(store, Object.freeze([...sourcePaths])));
}
/** Use before each remaining tool and final publication, including memory/source checks. */
export async function assertProjectToolSnapshotCurrent(store: StoreHost, snapshot: ProjectToolSnapshot): Promise<void> {
  const state = stateOf(store, snapshot);
  if (!same(state, await stableRead(store, state.sourcePaths))) stop();
}
function manifest(state: SnapshotState): ProjectTaskBaseline {
  return { contextRevision: state.contextRevision, memoryRevision: state.memoryRevision,
    protectedRevision: state.protectedRevision, settingsRevision: state.settingsRevision,
    taskJsonHash: hash(state.taskJson), taskMirrorHash: hash(state.taskMirror), sourcePaths: [...state.sourcePaths] };
}
/** Only source digests of the exact audited task pair may advance with its own save. */
function taskSourceHashes<T extends string[]>(store: StoreHost, sources: T[], taskJson: string | null, taskMirror: string | null): T[] {
  return sources.map(source => {
    const replacement = source[0] === store.taskDbPath() ? hash(taskJson) : source[0] === store.taskMirrorPath() ? hash(taskMirror) : undefined;
    return (replacement !== undefined && source[1] !== "unavailable" ? [source[0], replacement] : [...source]) as T;
  });
}
function protectedTaskInputs(store: StoreHost, state: SnapshotState, taskJson: string | null, taskMirror: string | null,
  projectRaw = state.projectRaw): SnapshotState["protectedInput"] {
  return { ...state.protectedInput, projectRaw, sources: taskSourceHashes(store, state.protectedInput.sources, taskJson, taskMirror) };
}
function taskArtifacts(store: StoreHost, state: SnapshotState, taskJson: string | null, taskMirror: string | null,
  projectRaw = state.projectRaw): ProjectSnapshot["artifacts"] {
  const artifacts = { ...state.contextInput.artifacts };
  if (projectRaw === null) return artifacts;
  const document = JSON.parse(projectRaw);
  if (!validateProjectDocument(document)) stop();
  for (const project of document.projects) for (const entry of project.entries) {
    const bytes = entry.path === store.taskDbPath() ? taskJson : entry.path === store.taskMirrorPath() ? taskMirror : undefined;
    if (bytes === undefined || artifacts[entry.id] === "unavailable") continue;
    artifacts[entry.id] = bytes === null ? "unavailable" : hash(bytes) === entry.artifactHash ? "unchanged" : "changed";
  }
  return artifacts;
}
export function projectToolSnapshotManifest(store: StoreHost, snapshot: ProjectToolSnapshot): ProjectTaskBaseline {
  return manifest(stateOf(store, snapshot));
}
export async function assertProjectTaskBaselineCurrent(store: StoreHost, baseline: ProjectTaskBaseline): Promise<ProjectToolSnapshot> {
  const current = await stableRead(store, baseline.sourcePaths);
  if (recordRevision(manifest(current)) !== recordRevision(baseline)) stop();
  return publish(current);
}
/** Recompute from the same protected project/source inputs with only audited task records replaced. */
export function projectToolTaskContextRevision(store: StoreHost, snapshot: ProjectToolSnapshot, taskJson: string | null, taskMirror?: string | null): string {
  const state = stateOf(store, snapshot);
  return continuityHash({ ...state.contextInput, tasks: taskDocument(taskJson).tasks,
    ...(taskMirror !== undefined ? { sources: taskSourceHashes(store, state.contextInput.sources, taskJson, taskMirror),
      artifacts: taskArtifacts(store, state, taskJson, taskMirror) } : {}) });
}
export function projectToolProjectRaw(store: StoreHost, snapshot: ProjectToolSnapshot): string | null {
  return stateOf(store, snapshot).projectRaw;
}
export function projectToolTaskRawPair(store: StoreHost, snapshot: ProjectToolSnapshot): Readonly<{json:string|null;mirror:string|null}> {
  const state=stateOf(store,snapshot);return Object.freeze({json:state.taskJson,mirror:state.taskMirror});
}
/** Rewind only the audited task/project pair; all current protected source inputs stay fixed. */
export function projectToolLinkedContextRevision(store: StoreHost, snapshot: ProjectToolSnapshot, taskJson: string | null, projectRaw: string | null, taskMirror?: string | null): string {
  const state = stateOf(store, snapshot);
  return continuityHash({ ...state.contextInput, revision: hash(projectRaw), tasks: taskDocument(taskJson).tasks,
    ...(taskMirror !== undefined ? { sources: taskSourceHashes(store, state.contextInput.sources, taskJson, taskMirror),
      artifacts: taskArtifacts(store, state, taskJson, taskMirror, projectRaw) } : {}) });
}
export function projectToolLinkedProtectedRevision(store: StoreHost, snapshot: ProjectToolSnapshot, projectRaw: string | null): string {
  return recordRevision({ ...stateOf(store, snapshot).protectedInput, projectRaw });
}
export function projectToolTaskProtectedRevision(store: StoreHost, snapshot: ProjectToolSnapshot, taskJson: string | null, taskMirror: string | null, projectRaw?: string | null): string {
  const state = stateOf(store, snapshot);
  return recordRevision(protectedTaskInputs(store, state, taskJson, taskMirror, projectRaw === undefined ? state.projectRaw : projectRaw));
}

/** Version-two history reconstructs its source graph from that step's audited Project and Task bytes. */
export function projectWorkContextRevision(store: StoreHost, snapshot: ProjectToolSnapshot, taskJson: string | null,
  taskMirror: string | null, projectRaw: string | null): string {
  const state = stateOf(store, snapshot), document = projectRaw === null ? null : JSON.parse(projectRaw);
  if (!document || !validateProjectDocument(document)) stop();
  const tasks = taskDocument(taskJson).tasks, excluded = state.contextInput.excluded,
    sources = new Map(taskSourceHashes(store, state.protectedInput.sources, taskJson, taskMirror).map(source => [source[0], source[1]])),
    paths = [...new Set([...document.goals.map(goal => goal.sourcePath),
      ...document.projects.flatMap(project => [project.nextStepSourcePath, ...project.entries.flatMap(projectEntrySourcePaths)]),
      ...tasks.map(task => task.sourceNotePath)].filter(Boolean))].sort().filter(path => !isVaultPathExcluded(path, excluded));
  return continuityHash({ revision: hash(projectRaw), tasks, artifacts: taskArtifacts(store, state, taskJson, taskMirror, projectRaw),
    sources: paths.map(path => [path, sources.get(path) === "absent" ? "unavailable" : sources.get(path) ?? "unavailable"]), excluded });
}

/** Construct only from the exact preceding Project, never from a guessed model patch. */
export function projectNextStepCommand(projectRaw: string | null, args: ProjectNextStepArguments) {
  if (!projectRaw) stop();
  const document = JSON.parse(projectRaw); if (!validateProjectDocument(document)) stop();
  const project = document.projects.find(item => item.id === args.projectId); if (!project) stop();
  const input = Object.fromEntries(PROJECT_FIELDS.map(field => [field, project[field]]));
  input.nextStep = args.text; input.nextStepSourcePath = args.sourcePath;
  return { kind: "save_project" as const, id: project.id, input: input as unknown as import("./projectContinuity").ProjectInput };
}

export async function verifyProjectNextStepFiles(store: StoreHost, files: GuardedFileChange[], operationId: string,
  args: ProjectNextStepArguments, binding: ProjectJobProjectBinding): Promise<void> {
  try {
    const project = files[0], path = store.path(store.settings.folders.goals, projectFileName());
    if (files.length !== 1 || project.path !== path || !project.before || !project.after || !fileMatches(project, project.before, project.after)
      || args.projectId !== binding.projectId) stop();
    const before = JSON.parse(project.before), after = JSON.parse(project.after);
    if (!validateProjectDocument(before) || !validateProjectDocument(after)) stop();
    const index = before.projects.findIndex(item => item.id === binding.projectId), old = before.projects[index], next = after.projects[index],
      goal = before.goals.find(item => item.id === binding.goalId);
    if (!old || !next || !goal || goal.title !== binding.goalTitle || old.title !== binding.title || old.goalId !== binding.goalId
      || old.state !== binding.state || next.changes.length !== old.changes.length + 1) stop();
    const command = projectNextStepCommand(project.before, args), change = next.changes.at(-1)!,
      content = Object.fromEntries(PROJECT_SNAPSHOT_FIELDS.map(field => [field, next[field]]));
    if (change.receipt.kind !== "user_confirmation" || change.receipt.operationId !== operationId
      || change.receipt.commandHash !== continuityHash(command) || change.receipt.recordedAt !== next.updatedAt
      || change.receipt.contentHash !== continuityHash(content) || recordRevision(change.fields) !== recordRevision(content)) stop();
    const expected = structuredClone(before);
    expected.projects[index] = { ...old, nextStep: args.text, nextStepSourcePath: args.sourcePath,
      nextStepEntryId: old.nextStep === args.text && old.nextStepSourcePath === args.sourcePath ? old.nextStepEntryId : "",
      updatedAt: next.updatedAt, changes: [...old.changes, change] };
    if (recordRevision(expected) !== recordRevision(after)) stop();
  } catch { return stop(); }
}

export async function describeProjectNextStepEffect(store: StoreHost, beforeSnapshot: ProjectToolSnapshot, scoped: StoreHost,
  operationId: string, args: ProjectNextStepArguments, binding: ProjectJobProjectBinding): Promise<{baseline: ProjectTaskBaseline; files: GuardedFileChange[]}> {
  try {
    const before = stateOf(store, beforeSnapshot);
    if (!isGuardedOperationScope(scoped) || guardedOperationIdentity(scoped)?.operationId !== operationId) stop();
    const current = await stableRead(store, before.sourcePaths);
    if (before.taskJson !== current.taskJson || before.taskMirror !== current.taskMirror
      || recordRevision(protectedTaskInputs(store, current, before.taskJson, before.taskMirror, before.projectRaw)) !== before.protectedRevision) stop();
    const files = [{ path: store.path(store.settings.folders.goals, projectFileName()), before: before.projectRaw, after: current.projectRaw,
      beforeHash: hash(before.projectRaw), afterHash: hash(current.projectRaw) }];
    await verifyProjectNextStepFiles(store, files, operationId, args, binding);
    if (current.contextRevision !== projectWorkContextRevision(store, publish(before), current.taskJson, current.taskMirror, current.projectRaw)
      || !same(current, await stableRead(store, before.sourcePaths))) stop();
    return { baseline: manifest(current), files };
  } catch { return stop(); }
}
function fileMatches(file: GuardedFileChange, before: string | null, after: string | null): boolean {
  return file.before === before && file.after === after && hash(before) === file.beforeHash && hash(after) === file.afterHash
    && !Object.hasOwn(file, "previous") && !Object.hasOwn(file, "previousHash") && !file.retained?.length;
}
function taskDocument(text: string | null): { tasks: LifeOpsTask[]; [key: string]: unknown } {
  const document = text === null ? { tasks: [] } : JSON.parse(text);
  if (!document || typeof document !== "object" || !Array.isArray(document.tasks)) stop();
  return document;
}
function unchangedTaskMetadata(before: ReturnType<typeof taskDocument>, after: ReturnType<typeof taskDocument>): boolean {
  const { tasks: _old, taskMirror: _oldMirror, ...oldFields } = before;
  const { tasks: _new, taskMirror: _newMirror, ...newFields } = after;
  return recordRevision(oldFields) === recordRevision(newFields);
}

/** Verify the task writer's exact delta from audited bytes, including handwritten mirror text. */
export async function verifyProjectTaskFiles(
  store: StoreHost, files: GuardedFileChange[], operationId: string, args: Record<string, unknown>
): Promise<LifeOpsTask> {
  try {
    const json = files.find(file => file.path === store.taskDbPath()), mirror = files.find(file => file.path === store.taskMirrorPath());
    if (files.length !== 2 || !json || !mirror || !fileMatches(json, json.before, json.after)
      || !fileMatches(mirror, mirror.before, mirror.after)) stop();
    const oldDb = taskDocument(json.before), newDb = taskDocument(json.after);
    if (!unchangedTaskMetadata(oldDb, newDb) || newDb.tasks.length !== oldDb.tasks.length + 1
      || recordRevision(newDb.tasks.slice(0, -1)) !== recordRevision(oldDb.tasks)) stop();
    const task = newDb.tasks.at(-1)!;
    if (!task || typeof task.id !== "string" || oldDb.tasks.some(old => old.id === task.id || old.source === task.source)
      || task.source !== `lifeops-agent-tool:${operationId}` || task.status !== "active"
      || task.title !== args.title || task.date !== args.date || task.time !== args.time || task.category !== args.category
      || task.completedAt !== "" || !Array.isArray(task.completionLog) || task.completionLog.length) stop();
    const { renderTaskMirror } = await import("./dataFoundation/taskPersistence");
    if (renderTaskMirror(newDb.tasks, mirror.before) !== mirror.after
      || recordRevision(newDb.taskMirror) !== recordRevision({ version: 1, sha256: hash(mirror.after) })) stop();
    return structuredClone(task);
  } catch { return stop(); }
}

/** Bound jobs admit exactly one task and its canonical project association in the same audited save. */
export async function verifyProjectLinkedTaskFiles(store: StoreHost, files: GuardedFileChange[], operationId: string,
  args: Record<string, unknown>, binding: ProjectJobProjectBinding): Promise<LifeOpsTask> {
  try {
    const projectPath = store.path(store.settings.folders.goals, projectFileName()), project = files.find(file => file.path === projectPath);
    if (files.length !== 3 || !project || !project.before || !project.after || !fileMatches(project, project.before, project.after)) stop();
    const task = await verifyProjectTaskFiles(store, files.filter(file => file.path !== projectPath), operationId, args);
    const oldDocument = JSON.parse(project.before), newDocument = JSON.parse(project.after);
    if (!validateProjectDocument(oldDocument) || !validateProjectDocument(newDocument)) stop();
    const index = oldDocument.projects.findIndex(item => item.id === binding.projectId), oldProject = oldDocument.projects[index], next = newDocument.projects[index];
    const goal = oldDocument.goals.find(item => item.id === binding.goalId);
    if (!oldProject || !next || !goal || goal.title !== binding.goalTitle || oldProject.title !== binding.title || oldProject.goalId !== binding.goalId
      || oldProject.state !== binding.state || next.id !== oldProject.id || oldProject.taskIds.includes(task.id)
      || next.changes.length !== oldProject.changes.length + 1) stop();
    const change = next.changes.at(-1)!;
    const command = { kind: "link_task", projectId: binding.projectId, taskId: task.id, expectedTaskRevision: recordRevision(task), remove: false };
    const content = Object.fromEntries(PROJECT_SNAPSHOT_FIELDS.map(field => [field, next[field]]));
    if (change.receipt.kind !== "user_confirmation" || change.receipt.operationId !== operationId
      || change.receipt.commandHash !== continuityHash(command) || change.receipt.recordedAt !== next.updatedAt
      || change.receipt.contentHash !== continuityHash(content) || recordRevision(change.fields) !== recordRevision(content)) stop();
    const expected = structuredClone(oldDocument);
    expected.projects[index] = { ...oldProject, taskIds: [...oldProject.taskIds, task.id], updatedAt: next.updatedAt,
      changes: [...oldProject.changes, change] };
    if (recordRevision(expected) !== recordRevision(newDocument)) stop();
    return task;
  } catch { return stop(); }
}

/** A scoped checkpoint may advance the project baseline only by the exact linked-task delta above. */
export async function describeProjectLinkedTaskEffect(store: StoreHost, beforeSnapshot: ProjectToolSnapshot, scoped: StoreHost,
  call: Readonly<AiToolCall>, binding: ProjectJobProjectBinding): Promise<{ baseline: ProjectTaskBaseline; task: LifeOpsTask; files: GuardedFileChange[] }> {
  try {
    const before = stateOf(store, beforeSnapshot);
    if (call.name !== "create_task" || !call.id || !isGuardedOperationScope(scoped) || guardedOperationIdentity(scoped)?.operationId !== call.id) stop();
    const current = await stableRead(store, before.sourcePaths);
    // Only project bytes differ in the protected input; a memory/source/policy change remains fatal.
    if (recordRevision(protectedTaskInputs(store, current, before.taskJson, before.taskMirror, before.projectRaw)) !== before.protectedRevision) stop();
    const files = [
      { path: store.taskDbPath(), before: before.taskJson, after: current.taskJson, beforeHash: hash(before.taskJson), afterHash: hash(current.taskJson) },
      { path: store.taskMirrorPath(), before: before.taskMirror, after: current.taskMirror, beforeHash: hash(before.taskMirror), afterHash: hash(current.taskMirror) },
      { path: store.path(store.settings.folders.goals, projectFileName()), before: before.projectRaw, after: current.projectRaw, beforeHash: hash(before.projectRaw), afterHash: hash(current.projectRaw) }
    ];
    const task = await verifyProjectLinkedTaskFiles(store, files, call.id, call.arguments, binding);
    const expected = continuityHash({ ...before.contextInput, revision: hash(current.projectRaw), tasks: [...before.contextInput.tasks, task],
      sources: taskSourceHashes(store, before.contextInput.sources, current.taskJson, current.taskMirror),
      artifacts: taskArtifacts(store, before, current.taskJson, current.taskMirror, current.projectRaw) });
    if (current.contextRevision !== expected || !same(current, await stableRead(store, before.sourcePaths))) stop();
    return { baseline: manifest(current), task, files };
  } catch { return stop(); }
}

/** Candidate checkpoint only. It becomes committed solely after independent Ledger/WAL verification. */
export async function describeProjectTaskEffect(
  store: StoreHost, beforeSnapshot: ProjectToolSnapshot, scoped: StoreHost, call: Readonly<AiToolCall>
): Promise<{ baseline: ProjectTaskBaseline; task: LifeOpsTask; files: GuardedFileChange[] }> {
  try {
    const before = stateOf(store, beforeSnapshot);
    if (call.name !== "create_task" || !call.id || !isGuardedOperationScope(scoped)
      || guardedOperationIdentity(scoped)?.operationId !== call.id) stop();
    const current = await stableRead(store, before.sourcePaths);
    if (before.protectedRevision !== recordRevision(protectedTaskInputs(store, current, before.taskJson, before.taskMirror))) stop();
    const files: GuardedFileChange[] = [
      { path: store.taskDbPath(), before: before.taskJson, after: current.taskJson,
        beforeHash: hash(before.taskJson), afterHash: hash(current.taskJson) },
      { path: store.taskMirrorPath(), before: before.taskMirror, after: current.taskMirror,
        beforeHash: hash(before.taskMirror), afterHash: hash(current.taskMirror) }
    ];
    const task = await verifyProjectTaskFiles(store, files, call.id, call.arguments);
    const expected = continuityHash({ ...before.contextInput, tasks: [...before.contextInput.tasks, task],
      sources: taskSourceHashes(store, before.contextInput.sources, current.taskJson, current.taskMirror),
      artifacts: taskArtifacts(store, before, current.taskJson, current.taskMirror) });
    if (current.contextRevision !== expected || !same(current, await stableRead(store, before.sourcePaths))) stop();
    return { baseline: manifest(current), task, files };
  } catch { return stop(); }
}

/** A completion may renew only the task pair in the private committed receipt.
 * Other project, memory and source bytes must still match the earlier snapshot. */
export async function advanceProjectTaskCompletionSnapshot(
  store: StoreHost, baseline: ProjectToolSnapshot, frozenCall: Readonly<AiToolCall>, result: ToolCallResult
): Promise<ProjectToolSnapshot> {
  try {
    const before = stateOf(store, baseline), call = structuredClone(frozenCall);
    const proof = getCommittedContextEvidence(result, store);
    if (call.name !== "complete_task" || !call.id || result.callId !== call.id || !result.success || result.actions.length
      || !proof || proof.operationId !== call.id
      || operationFingerprint(call.name, call.arguments) !== operationFingerprint(call.name, proof.arguments)) stop();
    const current = await stableRead(store, before.sourcePaths);
    if (before.protectedRevision !== recordRevision(protectedTaskInputs(store, current, before.taskJson, before.taskMirror))) stop();
    const json = proof.files.find(file => file.path === store.taskDbPath()), mirror = proof.files.find(file => file.path === store.taskMirrorPath());
    if (!json || !mirror || !fileMatches(json, before.taskJson, current.taskJson)
      || !fileMatches(mirror, before.taskMirror, current.taskMirror)) stop();
    // All side effects (including the dated completion record) must still be
    // the exact committed after bytes. An outside edit cannot be blessed.
    for (const file of proof.files) if (!fileMatches(file, file.before, await raw(store, file.path))) stop();
    const nextTasks = taskDocument(current.taskJson).tasks;
    const { renderTaskMirror } = await import("./dataFoundation/taskPersistence");
    if (renderTaskMirror(nextTasks, before.taskMirror) !== current.taskMirror) stop();
    const expected = continuityHash({ ...before.contextInput, tasks: nextTasks,
      sources: taskSourceHashes(store, before.contextInput.sources, current.taskJson, current.taskMirror),
      artifacts: taskArtifacts(store, before, current.taskJson, current.taskMirror) });
    if (expected !== current.contextRevision) stop();
    const ledgerPath = store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json"), ledgerRaw = await raw(store, ledgerPath);
    if (!ledgerRaw) stop();
    const ledger = JSON.parse(ledgerRaw) as OperationLedgerDocument, audit = ledger.records.find(item => item.operationId === call.id);
    if (!audit || audit.status !== "verified" || audit.toolName !== call.name || audit.source !== proof.source
      || audit.fingerprint !== operationFingerprint(call.name, call.arguments)
      || operationFingerprint(audit.toolName, audit.arguments) !== audit.fingerprint
      || !audit.result?.success || audit.result.actions.length || audit.result.undo?.kind !== "restore_guarded_files"
      || recordRevision(audit.result.undo.files) !== recordRevision(proof.files)
      || ledger.revertedOperationHashes?.includes(hash(call.id))) stop();
    const recoveryPath = store.path(store.settings.folders.aiReports, "Operations", "write-recovery.json"), recoveryRaw = await raw(store, recoveryPath);
    if (!recoveryRaw) stop();
    const recovery = inspectFactRecovery(store, recoveryRaw);
    if (recovery.status !== "committed" || recovery.rollbackRequired || recovery.ledgerUndo
      || recovery.auditId !== undefined || recovery.auditStatus !== undefined || recovery.undoToolOperationId !== undefined) stop();
    if (recovery.purpose === "derived") {
      // Refreshing a native view can finish a later index-only transaction.
      // It supplies no fact authority: the private receipt and exact Ledger
      // above remain required. Validate its allowed paths and current bytes.
      if (!recovery.operationId.startsWith("derived:")) stop();
      for (const file of recovery.entries) if (!fileMatches(file, file.before, await raw(store, file.path))) stop();
    } else if (recovery.operationId !== call.id || recordRevision(recovery.entries) !== recordRevision(proof.files)) stop();
    if (!same(current, await stableRead(store, before.sourcePaths)) || ledgerRaw !== await raw(store, ledgerPath)) stop();
    for (const file of proof.files) if (!fileMatches(file, file.before, await raw(store, file.path))) stop();
    for (const file of recovery.entries) if (!fileMatches(file, file.before, await raw(store, file.path))) stop();
    if (recoveryRaw !== await raw(store, recoveryPath)) stop();
    return publish({ ...current, contextRevision: expected });
  } catch { return stop(); }
}

/** Advance only the exact current-turn create_task effect; rejection never rewrites or undoes facts. */
export async function advanceProjectToolSnapshot(
  store: StoreHost, baseline: ProjectToolSnapshot, frozenCall: Readonly<AiToolCall>, result: ToolCallResult
): Promise<ProjectToolSnapshot> {
  try {
    const before = stateOf(store, baseline), call = structuredClone(frozenCall);
    const evidence = getCommittedTaskEvidence(result, store);
    if (call.name !== "create_task" || !call.id || result.callId !== call.id || !result.success || result.actions.length
      || !evidence || evidence.operationId !== call.id
      || operationFingerprint(call.name, call.arguments) !== operationFingerprint(call.name, evidence.arguments)) stop();
    const current = await stableRead(store, before.sourcePaths);
    if (before.protectedRevision !== recordRevision(protectedTaskInputs(store, current, before.taskJson, before.taskMirror))) stop();
    const files = evidence.files;
    const json = files.find(file => file.path === store.taskDbPath());
    const mirror = files.find(file => file.path === store.taskMirrorPath());
    if (files.length !== 2 || !json || !mirror
      || !fileMatches(json, before.taskJson, current.taskJson)
      || !fileMatches(mirror, before.taskMirror, current.taskMirror)) stop();
    const oldDb = taskDocument(before.taskJson), newDb = taskDocument(current.taskJson);
    if (!unchangedTaskMetadata(oldDb, newDb) || newDb.tasks.length !== oldDb.tasks.length + 1
      || recordRevision(newDb.tasks.slice(0, -1)) !== recordRevision(oldDb.tasks)) stop();
    const task = newDb.tasks.at(-1)!;
    if (!task || typeof task.id !== "string" || oldDb.tasks.some(old => old.id === task.id || old.source === task.source)
      || task.source !== `lifeops-agent-tool:${call.id}` || task.status !== "active"
      || task.title !== (typeof call.arguments.title === "string" ? call.arguments.title.trim() : "")
      || task.completedAt !== "" || !Array.isArray(task.completionLog) || task.completionLog.length) stop();
    const expectedRevision = continuityHash({ ...before.contextInput, tasks: [...before.contextInput.tasks, task],
      sources: taskSourceHashes(store, before.contextInput.sources, current.taskJson, current.taskMirror),
      artifacts: taskArtifacts(store, before, current.taskJson, current.taskMirror) });
    if (expectedRevision !== current.contextRevision) stop();
    const { renderTaskMirror } = await import("./dataFoundation/taskPersistence");
    if (renderTaskMirror(newDb.tasks, before.taskMirror) !== current.taskMirror
      || recordRevision(newDb.taskMirror) !== recordRevision({ version: 1, sha256: hash(current.taskMirror) })) stop();
    const ledgerPath = store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
    const ledgerRaw = await raw(store, ledgerPath);
    const ledger = await store.readJson<OperationLedgerDocument>(ledgerPath, { version: 1, records: [] });
    if (ledgerRaw !== await raw(store, ledgerPath)) stop();
    const audit = ledger.records.find(item => item.operationId === evidence.operationId);
    if (!audit || audit.status !== "verified" || audit.toolName !== "create_task" || audit.source !== evidence.source
      || audit.fingerprint !== operationFingerprint(call.name, call.arguments)
      || operationFingerprint(audit.toolName, audit.arguments) !== audit.fingerprint
      || !audit.result?.success || audit.result.actions.length || audit.result.undo?.kind !== "restore_guarded_files"
      || recordRevision(audit.result.undo.files) !== recordRevision(files)
      || ledger.revertedOperationHashes?.includes(hash(evidence.operationId))) stop();
    const recoveryRaw = await raw(store, store.path(store.settings.folders.aiReports, "Operations", "write-recovery.json"));
    if (!recoveryRaw) stop();
    const recovery = JSON.parse(recoveryRaw);
    // onCommitted also recognizes a failed final WAL update with a verified audit.
    if (recovery.version !== 1 || recovery.operationId !== call.id || recovery.rollbackRequired
      || !["committed", "pending"].includes(recovery.status)
      || recovery.auditId !== undefined || recovery.auditStatus !== undefined || recovery.purpose !== undefined
      || recordRevision(recovery.entries) !== recordRevision(files)) stop();
    if (!same(current, await stableRead(store, before.sourcePaths))) stop();
    if (ledgerRaw !== await raw(store, ledgerPath)
      || recoveryRaw !== await raw(store, store.path(store.settings.folders.aiReports, "Operations", "write-recovery.json"))) stop();
    // The only admitted replacement is the guarded task pair, never an arbitrary current revision.
    return publish({ ...current, contextRevision: expectedRevision });
  } catch { return stop(); }
}
