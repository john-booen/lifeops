import { createHash } from "node:crypto";
import { isSafeOperationId, recordRevision } from "./operationIdentity";
import { taskCompletionPoint } from "./taskSchedule";
import type { LifeOpsTask, LifeOpsTaskInput } from "./types";

export const PROJECT_STATES = ["suggested", "agreed", "started", "completed", "cancelled"] as const;
export type ProjectState = typeof PROJECT_STATES[number];
export const PROJECT_STATE_LABELS: Record<ProjectState, string> = {
  suggested: "建议", agreed: "已同意", started: "进行中", completed: "已完成", cancelled: "已取消"
};
export interface ContinuityReceipt {
  kind: "user_confirmation";
  operationId: string;
  recordedAt: string;
  contentHash: string;
  commandHash: string;
}
export interface ContinuityChange {
  receipt: ContinuityReceipt;
  fields: Record<string, unknown>;
}
export interface GoalInput {
  title: string;
  reason: string;
  successCriteria: string;
  timeBoundary: string;
  constraints: string;
  nextStep: string;
  reviewOn: string;
  sourcePath: string;
  state: ProjectState;
  stateNote: string;
}
export interface ProjectInput {
  title: string;
  goalId: string;
  kind: "work" | "learning";
  nextStep: string;
  commitments: string;
  nextStepSourcePath: string;
  blockers: string;
  reviewOn: string;
  state: ProjectState;
  stateNote: string;
}
export interface ContinuityGoal extends GoalInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  changes: ContinuityChange[];
}
export interface ProjectEntryRevision {
  kind: "output" | "review";
  text: string;
  path: string;
  artifactHash: string;
  nextStep: string;
  receipt: ContinuityReceipt;
  taskEvidence?: ProjectTaskEvidence;
}
export interface ProjectTaskEvidence {
  taskId: string;
  title: string;
  status: LifeOpsTask["status"];
  completedAt: string;
  sourceNotePath: string;
  taskRevision: string;
}
export interface ProjectEntry extends ProjectEntryRevision {
  id: string;
  revisions: ProjectEntryRevision[];
}
export interface ContinuityProject extends ProjectInput {
  id: string;
  taskIds: string[];
  entries: ProjectEntry[];
  nextStepEntryId: string;
  createdAt: string;
  updatedAt: string;
  changes: ContinuityChange[];
}
export interface ProjectDocument {
  version: 1;
  goals: ContinuityGoal[];
  projects: ContinuityProject[];
  [key: string]: unknown;
}
export type ProjectCommand =
  | { kind: "save_goal"; id?: string; input: GoalInput }
  | { kind: "save_project"; id?: string; input: ProjectInput }
  | { kind: "link_task"; projectId: string; taskId: string; expectedTaskRevision?: string; remove?: boolean }
  | { kind: "create_task"; projectId: string; input: LifeOpsTaskInput }
  | { kind: "add_entry"; projectId: string; entryKind: "output" | "review"; text: string; path: string; nextStep: string }
  | { kind: "record_task_result"; projectId: string; taskId: string; expectedTaskRevision: string; entryKind: "output" | "review"; text: string; path: string; nextStep: string }
  | { kind: "correct_entry"; projectId: string; entryId: string; text: string; path: string; nextStep: string };
export interface ProjectSnapshot {
  revision: string;
  document: ProjectDocument;
  tasks: LifeOpsTask[];
  artifacts: Record<string, "unchanged" | "changed" | "unavailable">;
}
export const GOAL_FIELDS = ["title", "reason", "successCriteria", "timeBoundary", "constraints", "nextStep", "reviewOn", "sourcePath", "state", "stateNote"] as const;
export const PROJECT_FIELDS = ["title", "goalId", "kind", "nextStep", "nextStepSourcePath", "commitments", "blockers", "reviewOn", "state", "stateNote"] as const;
export const PROJECT_SNAPSHOT_FIELDS = [...PROJECT_FIELDS, "taskIds", "nextStepEntryId"] as const;
export const ENTRY_FIELDS = ["kind", "text", "path", "artifactHash", "nextStep"] as const;
/** Old entries keep their original receipt payload; new evidence is covered by its receipt. */
export function projectEntryFields(entry: Pick<ProjectEntryRevision, typeof ENTRY_FIELDS[number] | "taskEvidence">): Record<string, unknown> {
  return { ...Object.fromEntries(ENTRY_FIELDS.map(field => [field, entry[field]])),
    ...(entry.taskEvidence ? { taskEvidence: structuredClone(entry.taskEvidence) } : {}) };
}
export function projectEntrySourcePaths(entry: ProjectEntry): string[] {
  return [...new Set([entry, ...entry.revisions].flatMap(item => [item.path, item.taskEvidence?.sourceNotePath ?? ""]).filter(Boolean))];
}
export function projectTaskEvidence(task: LifeOpsTask): ProjectTaskEvidence {
  const evidence = { taskId: task.id, title: task.title, status: task.status,
    completedAt: task.status === "completed" && validCompletionTime(task.completedAt) ? task.completedAt : "",
    sourceNotePath: task.sourceNotePath, taskRevision: recordRevision(task) };
  if (!validProjectTaskEvidence(evidence)) throw new Error("原任务依据无法核对，未记录任务结果。");
  return evidence;
}
function validCompletionTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return !!taskCompletionPoint(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(`${value.slice(0, 10)}T12:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);
}
export function validProjectTaskEvidence(value: unknown): value is ProjectTaskEvidence {
  const names = ["taskId", "title", "status", "completedAt", "sourceNotePath", "taskRevision"];
  return object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
    && isSafeOperationId(value.taskId) && typeof value.title === "string" && !!value.title.trim()
    && ["active", "completed", "abandoned"].includes(value.status) && hash(value.taskRevision)
    && typeof value.sourceNotePath === "string" && (!value.sourceNotePath || safeProjectPath(value.sourceNotePath))
    && (value.completedAt === "" || value.status === "completed" && validCompletionTime(value.completedAt));
}
export function projectTaskEvidenceLines(evidence: ProjectTaskEvidence, current?: LifeOpsTask, linked = true): string[] {
  const label = (status: LifeOpsTask["status"]) => status === "completed" ? "已完成（任务库记录）" : status === "abandoned" ? "已取消（任务库记录）" : "待办（任务库记录）";
  return [`当时原任务：${evidence.title}；${label(evidence.status)}`,
    ...(evidence.status === "completed" ? [`当时完成${evidence.completedAt.length === 10 ? "日期" : "时间"}：${evidence.completedAt || "未有效记录，不能推断"}`] : []),
    ...(evidence.sourceNotePath ? [`当时任务原文来源：${evidence.sourceNotePath}`] : []),
    !linked ? "当前已解除任务关联；当时记录只作历史，请重新核对。"
      : !current ? "当前原任务不可用；当时记录只作历史，不能推断当前完成。"
      : recordRevision(current) === evidence.taskRevision ? "当前任务字段与当时一致；任务完成不等于项目完成。"
      : `当前原任务已变化（${label(current.status)}）；当时记录只作历史，请重新核对。`];
}
export function continuityHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
export function projectSubmissionId(baseId: string, command: ProjectCommand, expectedRevision: string): string {
  return `${baseId}:${continuityHash({ command, expectedRevision }).slice(0, 16)}`;
}
export function needsProjectContinuity(message: string, focus = "general"): boolean {
  return focus === "general" && /(项目|目标|工作|事业|学习|承诺|下一步|阻塞|产出|启程|进展|继续|接着|上次|上回|上一项|停在哪|停在什么)/.test(message);
}
export function emptyProjectDocument(): ProjectDocument { return { version: 1, goals: [], projects: [] }; }
export function projectFileName(): string { return "LifeOps目标项目.json"; }
export function safeProjectPath(path: string): boolean {
  return !!path && !/^[~/]|^[a-z][a-z\d+.-]*:/i.test(path) && !/[\\\u0000-\u001f]/.test(path)
    && path.split("/").every(part => !!part && part !== "." && part !== ".." && !part.startsWith(".")) && path.endsWith(".md");
}
function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value) && !Object.hasOwn(value, "schemaVersion");
}
function date(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function hash(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function reviewDate(value: string): boolean {
  if (value === "") return true;
  const parsed = new Date(`${value}T12:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function input(value: unknown, fields: readonly string[]): value is Record<string, string> {
  return object(value) && fields.every(field => typeof value[field] === "string") && !!value.title.trim()
    && PROJECT_STATES.includes(value.state) && reviewDate(value.reviewOn)
    && (!(value.state === "completed" || value.state === "cancelled") || !!value.stateNote.trim());
}
export function validGoalInput(value: unknown): boolean {
  return input(value, GOAL_FIELDS) && (!value.sourcePath || safeProjectPath(value.sourcePath));
}
export function validProjectInput(value: unknown): boolean {
  return input(value, PROJECT_FIELDS) && !!value.goalId && ["work", "learning"].includes(value.kind)
    && (!value.nextStepSourcePath || safeProjectPath(value.nextStepSourcePath));
}
export function validReceipt(value: unknown, content: unknown): value is ContinuityReceipt {
  return object(value) && value.kind === "user_confirmation" && isSafeOperationId(value.operationId)
    && date(value.recordedAt) && hash(value.commandHash) && hash(value.contentHash) && value.contentHash === continuityHash(content);
}
export function validateProjectDocument(value: unknown): value is ProjectDocument {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.goals) || !Array.isArray(value.projects)) return false;
  const ids = new Set<string>();
  const base = (record: unknown, fields: readonly string[]): record is Record<string, any> => {
    if (!object(record) || !isSafeOperationId(record.id) || ids.has(record.id) || !date(record.createdAt) || !date(record.updatedAt)
      || !Array.isArray(record.changes) || !record.changes.length) return false;
    ids.add(record.id);
    if (record.changes.some((change: unknown) => !object(change) || !object(change.fields) || !validReceipt(change.receipt, change.fields))) return false;
    const current = Object.fromEntries(fields.map(field => [field, record[field]]));
    return continuityHash(current) === record.changes.at(-1).receipt.contentHash;
  };
  for (const goal of value.goals) if (!validGoalInput(goal) || !base(goal, GOAL_FIELDS)) return false;
  const goalIds = new Set(value.goals.map(goal => goal.id));
  for (const project of value.projects) {
    if (!validProjectInput(project) || !base(project, PROJECT_SNAPSHOT_FIELDS) || !goalIds.has(project.goalId)
      || !Array.isArray(project.taskIds) || project.taskIds.some((id: unknown) => !isSafeOperationId(id))
      || new Set(project.taskIds).size !== project.taskIds.length || !Array.isArray(project.entries) || typeof project.nextStepEntryId !== "string") return false;
    const entryIds = new Set<string>();
    const entryValid = (entry: unknown): boolean => {
      if (!object(entry) || !["output", "review"].includes(entry.kind) || typeof entry.text !== "string" || !entry.text.trim()
        || typeof entry.path !== "string" || typeof entry.nextStep !== "string"
        || (entry.path ? !safeProjectPath(entry.path) || !hash(entry.artifactHash) : entry.artifactHash !== "")) return false;
      if (Object.hasOwn(entry, "taskEvidence") && !validProjectTaskEvidence(entry.taskEvidence)) return false;
      return validReceipt(entry.receipt, projectEntryFields(entry as ProjectEntryRevision));
    };
    for (const entry of project.entries) {
      if (!object(entry) || !isSafeOperationId(entry.id) || entryIds.has(entry.id) || !entryValid(entry)
        || !Array.isArray(entry.revisions) || entry.revisions.some((revision: unknown) => !entryValid(revision))) return false;
      entryIds.add(entry.id);
    }
    if (project.nextStepEntryId) {
      const source = project.entries.find((entry: ProjectEntry) => entry.id === project.nextStepEntryId && entry.kind === "review");
      if (!source || source.nextStep !== project.nextStep || source.path !== project.nextStepSourcePath) return false;
    }
  }
  return true;
}
