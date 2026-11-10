import { createHash, randomUUID } from "node:crypto";
import { OperationLedger, operationFingerprint } from "./dataFoundation/operationLedger";
import type { FactOperationOptions } from "./dataFoundation/factOperation";
import { isSafeOperationId, recordRevision } from "./operationIdentity";
import { isVaultPathExcluded } from "./privacy";
import type { StoreHost } from "./store/settingsSlice";

export type ProjectJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
export type ProjectJobArguments = { title: string; date: string; time: string; category: string };
export interface ProjectJobProjectBinding {
  projectId: string; title: string; goalId: string; goalTitle: string;
  state: "suggested" | "agreed" | "started"; initialProjectHash: string;
}
export type ProjectNextStepArguments = { projectId: string; text: string; sourcePath: string };
interface ProjectJobStepBase {
  [key: string]: unknown;
  operationId: string;
  fingerprint: string;
}
export type ProjectJobStep = ProjectJobStepBase & (
  { toolName: "create_task"; arguments: ProjectJobArguments }
  | { toolName: "set_project_next_step"; arguments: ProjectNextStepArguments }
);
export interface ProjectJobBaseline {
  [key: string]: unknown;
  contextRevision: string; memoryRevision: string; protectedRevision: string; settingsRevision: string;
  taskJsonHash: string; taskMirrorHash: string; sourcePaths: string[];
}
export interface ProjectJobEffect {
  [key: string]: unknown;
  phase: "effect_recorded" | "committed";
  stepIndex: number; operationId: string; fingerprint: string; taskId?: string; taskHash?: string;
  beforeTaskJsonHash: string; afterTaskJsonHash: string; beforeTaskMirrorHash: string; afterTaskMirrorHash: string;
  contextRevisionAfter: string;
  beforeProjectHash?: string; afterProjectHash?: string; protectedRevisionAfter?: string;
}
export interface ProjectJob {
  [key: string]: unknown;
  id: string; revision: number; status: ProjectJobStatus; generation: number; owner: string | null;
  createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null; deadlineAt: string;
  userMessage: string; authorization: "first-party-confirmation"; planHash: string;
  steps: ProjectJobStep[]; nextStep: number; baseline: ProjectJobBaseline; effects: ProjectJobEffect[]; error: string;
  projectBinding?: ProjectJobProjectBinding;
}
export interface ProjectJobDocument { [key: string]: unknown; version: 1 | 2; job: ProjectJob | null }
export interface ProjectJobSnapshot { readonly path: string; readonly raw: string | null; readonly document: ProjectJobDocument }
type PlanInput = Pick<ProjectJob, "id" | "userMessage" | "authorization" | "steps" | "baseline" | "createdAt" | "deadlineAt" | "projectBinding">;
const jobKeys = ["id", "revision", "status", "generation", "owner", "createdAt", "updatedAt", "startedAt", "finishedAt", "deadlineAt", "userMessage", "authorization", "planHash", "steps", "nextStep", "baseline", "effects", "error", "projectBinding"];
const stepKeys = ["toolName", "operationId", "arguments", "fingerprint"];
const baselineKeys = ["contextRevision", "memoryRevision", "protectedRevision", "settingsRevision", "taskJsonHash", "taskMirrorHash", "sourcePaths"];
const projectEffectKeys = ["beforeProjectHash", "afterProjectHash"] as const;
const effectKeys = ["phase", "stepIndex", "operationId", "fingerprint", "taskId", "taskHash", "beforeTaskJsonHash", "afterTaskJsonHash", "beforeTaskMirrorHash", "afterTaskMirrorHash", "contextRevisionAfter", "protectedRevisionAfter", ...projectEffectKeys];
const snapshots = new WeakMap<ProjectJobSnapshot, { host: StoreHost; path: string; raw: string | null; document: ProjectJobDocument }>();
const statuses: readonly string[] = ["queued", "running", "completed", "failed", "cancelled", "timed_out"];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fileHash = (value: unknown): value is string => value === "absent" || sha(value);
const iso = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const date = (value: unknown): value is string => value === "" || typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const sourcePath = (value: unknown): value is string => typeof value === "string" && Boolean(value) && !/[\\\x00-\x1f]/.test(value)
  && !value.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("."));
function jsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => jsonSafe(item, depth + 1));
  return object(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.values(value).every(item => jsonSafe(item, depth + 1));
}
export class ProjectJobRepositoryError extends Error {
  readonly code = "LIFEOPS_PROJECT_JOB_PROTECTED";
  constructor() { super("安排记录已变化或格式无法识别，已停止覆盖。请重新核对当前安排。"); }
}
function stop(): never { throw new ProjectJobRepositoryError(); }
export function projectJobPath(store: StoreHost): string { return store.path(store.settings.folders.aiReports, "Jobs", "project-job.json"); }
export function projectJobArchivePath(store: StoreHost, jobId: string): string {
  if (!uuid.test(jobId)) stop();
  return store.path(store.settings.folders.aiReports, "Jobs", "Archive", `${jobId}.json`);
}
export function projectJobStepOperationId(jobId: string, index: number): string {
  if (!uuid.test(jobId) || !integer(index) || index > 7) stop();
  return `job:${jobId}:step:${index}`;
}
export function projectJobPlanHash(job: PlanInput, version: 1 | 2 = 1): string {
  return recordRevision({ ...(version === 2 ? { format: "lifeops.project-work-plan", version: 2 } : {}),
    id: job.id, userMessage: job.userMessage, authorization: job.authorization, createdAt: job.createdAt, deadlineAt: job.deadlineAt,
    steps: job.steps.map(step => ({ toolName: step.toolName, operationId: step.operationId, arguments: step.arguments, fingerprint: step.fingerprint })),
    baseline: Object.fromEntries(baselineKeys.map(key => [key, job.baseline[key]])),
    ...(Object.hasOwn(job, "projectBinding") ? { projectBinding: job.projectBinding } : {}) });
}
function validProjectBinding(value: unknown): value is ProjectJobProjectBinding {
  return object(value) && Object.keys(value).length === 6
    && Object.keys(value).every(key => ["projectId", "title", "goalId", "goalTitle", "state", "initialProjectHash"].includes(key))
    && isSafeOperationId(value.projectId) && isSafeOperationId(value.goalId)
    && [value.title, value.goalTitle].every(text => typeof text === "string" && Boolean(text.trim()))
    && ["suggested", "agreed", "started"].includes(value.state) && sha(value.initialProjectHash);
}
function validArguments(value: unknown): value is ProjectJobArguments {
  return object(value) && Object.keys(value).length === 4 && Object.keys(value).every(key => ["title", "date", "time", "category"].includes(key))
    && typeof value.title === "string" && Boolean(value.title.trim()) && value.title === value.title.trim() && !/[\r\n]/.test(value.title)
    && date(value.date) && typeof value.time === "string" && (value.time === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time))
    && typeof value.category === "string" && value.category === value.category.trim() && !/[\r\n·]/.test(value.category);
}
function validNextStepArguments(value: unknown): value is ProjectNextStepArguments {
  return object(value) && Object.keys(value).length === 3 && Object.keys(value).every(key => ["projectId", "text", "sourcePath"].includes(key))
    && isSafeOperationId(value.projectId) && typeof value.text === "string" && Boolean(value.text.trim()) && value.text === value.text.trim()
    && value.text.length <= 4000 && typeof value.sourcePath === "string" && (value.sourcePath === "" || sourcePath(value.sourcePath));
}
/** Pure validation: no Runtime/host import, also used by the protected JSON contract. */
export function validateProjectJobDocument(value: unknown): value is ProjectJobDocument {
  try {
    if (!object(value) || ![1, 2].includes(value.version) || Object.hasOwn(value, "schemaVersion") || !jsonSafe(value) || !Object.hasOwn(value, "job")) return false;
    const job = value.job;
    if (job === null) return true;
    if (!object(job) || Object.hasOwn(job, "schemaVersion") || !uuid.test(job.id) || !integer(job.revision) || !integer(job.generation)
      || !statuses.includes(job.status) || !(job.owner === null || typeof job.owner === "string" && Boolean(job.owner.trim()) && job.owner.length <= 256)
      || !iso(job.createdAt) || !iso(job.updatedAt) || !iso(job.deadlineAt) || Date.parse(job.updatedAt) < Date.parse(job.createdAt)
      || Date.parse(job.deadlineAt) <= Date.parse(job.createdAt) || !(job.startedAt === null || iso(job.startedAt))
      || !(job.finishedAt === null || iso(job.finishedAt)) || typeof job.userMessage !== "string" || !job.userMessage.trim()
      || job.authorization !== "first-party-confirmation" || !sha(job.planHash) || !Array.isArray(job.steps) || job.steps.length < 1 || job.steps.length > 8
      || !integer(job.nextStep) || job.nextStep > job.steps.length || !Array.isArray(job.effects) || job.effects.length > job.steps.length
      || typeof job.error !== "string") return false;
    if (Object.hasOwn(job, "projectBinding") && !validProjectBinding(job.projectBinding)) return false;
    if (value.version === 2 && (!job.projectBinding || job.steps.length < 2)) return false;
    if (job.startedAt !== null && Date.parse(job.startedAt) < Date.parse(job.createdAt)
      || job.finishedAt !== null && Date.parse(job.finishedAt) < Date.parse(job.startedAt ?? job.createdAt)
      || job.startedAt !== null && Date.parse(job.updatedAt) < Date.parse(job.startedAt)
      || job.finishedAt !== null && Date.parse(job.updatedAt) < Date.parse(job.finishedAt)) return false;
    if (job.status === "queued" && (job.generation !== 0 || job.owner !== null || job.startedAt !== null || job.finishedAt !== null || job.effects.length !== 0)
      || job.status === "running" && (!job.owner || job.generation === 0 || job.startedAt === null || job.finishedAt !== null)
      || !["queued", "running"].includes(job.status) && (job.owner !== null || job.finishedAt === null)) return false;
    const baseline = job.baseline;
    if (!object(baseline) || Object.hasOwn(baseline, "schemaVersion")
      || ![baseline.contextRevision, baseline.memoryRevision, baseline.protectedRevision, baseline.settingsRevision].every(sha)
      || !fileHash(baseline.taskJsonHash) || !fileHash(baseline.taskMirrorHash) || !Array.isArray(baseline.sourcePaths)
      || baseline.sourcePaths.some((path: unknown) => !sourcePath(path)) || new Set(baseline.sourcePaths).size !== baseline.sourcePaths.length) return false;
    for (let index = 0; index < job.steps.length; index++) {
      const step = job.steps[index];
      const nextStep = value.version === 2 && index === job.steps.length - 1;
      if (!object(step) || Object.hasOwn(step, "schemaVersion")
        || (nextStep ? step.toolName !== "set_project_next_step" || !validNextStepArguments(step.arguments)
          || step.arguments.projectId !== job.projectBinding.projectId : step.toolName !== "create_task" || !validArguments(step.arguments))
        || step.operationId !== projectJobStepOperationId(job.id, index) || !isSafeOperationId(step.operationId)
        || step.fingerprint !== operationFingerprint(step.toolName, step.arguments)) return false;
    }
    let committed = 0;
    const taskIds = new Set<string>();
    for (let index = 0; index < job.effects.length; index++) {
      const effect = job.effects[index], step = job.steps[index];
      if (!object(effect) || Object.hasOwn(effect, "schemaVersion") || effect.stepIndex !== index || effect.operationId !== step.operationId
        || effect.fingerprint !== step.fingerprint || !["effect_recorded", "committed"].includes(effect.phase)
        || effect.phase === "effect_recorded" && index !== job.effects.length - 1
        || !sha(effect.contextRevisionAfter)
        || !fileHash(effect.beforeTaskJsonHash) || !sha(effect.afterTaskJsonHash) || !fileHash(effect.beforeTaskMirrorHash) || !sha(effect.afterTaskMirrorHash)
        || effect.beforeTaskJsonHash !== (index ? job.effects[index - 1].afterTaskJsonHash : baseline.taskJsonHash)
        || effect.beforeTaskMirrorHash !== (index ? job.effects[index - 1].afterTaskMirrorHash : baseline.taskMirrorHash)) return false;
      if (step.toolName === "create_task") {
        if (typeof effect.taskId !== "string" || !effect.taskId.trim() || /[\r\n]/.test(effect.taskId) || taskIds.has(effect.taskId)
          || !sha(effect.taskHash) || effect.beforeTaskJsonHash === effect.afterTaskJsonHash || effect.beforeTaskMirrorHash === effect.afterTaskMirrorHash) return false;
        taskIds.add(effect.taskId);
      } else if (Object.hasOwn(effect, "taskId") || Object.hasOwn(effect, "taskHash")
        || effect.beforeTaskJsonHash !== effect.afterTaskJsonHash || effect.beforeTaskMirrorHash !== effect.afterTaskMirrorHash) return false;
      if (job.projectBinding) {
        if (!sha(effect.beforeProjectHash) || !sha(effect.afterProjectHash) || !sha(effect.protectedRevisionAfter)
          || effect.beforeProjectHash === effect.afterProjectHash
          || effect.beforeProjectHash !== (index ? job.effects[index - 1].afterProjectHash : job.projectBinding.initialProjectHash)) return false;
      } else if (projectEffectKeys.some(key => Object.hasOwn(effect, key))) return false;
      if (Object.hasOwn(effect, "protectedRevisionAfter") && !sha(effect.protectedRevisionAfter)) return false;
      if (effect.phase === "committed") committed++;
    }
    if (job.nextStep !== committed || job.status === "completed" && (committed !== job.steps.length || job.startedAt === null)
      || job.planHash !== projectJobPlanHash(job as ProjectJob, value.version)) return false;
    return true;
  } catch { return false; }
}
function parse(raw: string | null): ProjectJobDocument {
  try {
    const document = raw === null ? { version: 1, job: null } : JSON.parse(raw);
    if (!validateProjectJobDocument(document)) stop();
    return document;
  } catch { return stop(); }
}
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.values(value).forEach(freeze); Object.freeze(value);
}
function preserveExtensions(old: Record<string, unknown>, next: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
  const merged = { ...next };
  for (const [key, value] of Object.entries(old)) if (!known.includes(key)) {
    if (Object.hasOwn(next, key) && recordRevision(next[key]) !== recordRevision(value)) stop();
    merged[key] = value;
  }
  return merged;
}
function mergeJob(old: ProjectJob | null, incoming: ProjectJob): ProjectJob {
  if (!old) return incoming;
  const job = preserveExtensions(old, incoming, jobKeys) as ProjectJob;
  job.baseline = preserveExtensions(old.baseline, incoming.baseline, baselineKeys) as ProjectJobBaseline;
  job.steps = incoming.steps.map((step, index) => preserveExtensions(old.steps[index] ?? {}, step, stepKeys) as ProjectJobStep);
  job.effects = incoming.effects.map((effect, index) => preserveExtensions(old.effects[index] ?? {}, effect, effectKeys) as ProjectJobEffect);
  return job;
}
function validateTransition(old: ProjectJob | null, next: ProjectJob, version: 1 | 2): void {
  if (!old) {
    if (next.status !== "queued" || next.revision !== 0 || next.generation !== 0 || next.nextStep !== 0 || next.effects.length) stop();
    return;
  }
  if (next.id !== old.id || next.revision !== old.revision + 1 || next.planHash !== old.planHash
    || Object.hasOwn(next, "projectBinding") !== Object.hasOwn(old, "projectBinding") || recordRevision(next.projectBinding ?? null) !== recordRevision(old.projectBinding ?? null)
    || projectJobPlanHash(next, version) !== projectJobPlanHash(old, version) || Date.parse(next.updatedAt) < Date.parse(old.updatedAt)
    || recordRevision(next.steps) !== recordRevision(old.steps) || recordRevision(next.baseline) !== recordRevision(old.baseline)
    || next.effects.length < old.effects.length || next.effects.length > old.effects.length + 1) stop();
  for (let i = 0; i < old.effects.length; i++) {
    const { phase: previous, ...oldEffect } = old.effects[i], { phase, ...nextEffect } = next.effects[i];
    if (recordRevision(oldEffect) !== recordRevision(nextEffect) || previous === "committed" && phase !== "committed") stop();
  }
  const sameOwner = next.generation === old.generation && next.owner === old.owner;
  if ((next.nextStep !== old.nextStep || old.effects.some((effect, index) => effect.phase !== next.effects[index].phase))
    && (old.status !== "running" || next.status !== "running" || !sameOwner)) stop();
  if (next.effects.length > old.effects.length && (old.effects.some(effect => effect.phase === "effect_recorded")
    || next.effects.at(-1)!.phase !== "effect_recorded" || old.status !== "running" || next.status !== "running"
    || next.owner !== old.owner || next.generation !== old.generation)) stop();
  if (old.status === "queued") {
    if (next.status === "queued" && sameOwner && next.startedAt === old.startedAt) return;
    if (next.status === "running" && next.generation === old.generation + 1 && next.owner) return;
    if (["cancelled", "timed_out"].includes(next.status) && next.generation === old.generation + 1 && next.startedAt === old.startedAt) return;
    if (next.status === "failed" && sameOwner) return;
    stop();
  }
  if (old.status === "running") {
    if (next.status === "running" && (sameOwner && next.startedAt === old.startedAt
      || next.generation === old.generation + 1 && next.owner !== old.owner && next.owner)) return;
    if (["completed", "failed"].includes(next.status) && next.generation === old.generation && next.startedAt === old.startedAt) return;
    if (["cancelled", "timed_out"].includes(next.status) && next.generation === old.generation + 1 && next.startedAt === old.startedAt) return;
    stop();
  }
  if (old.status === "failed" && next.status === "running" && next.generation === old.generation + 1 && next.owner) return;
  if (old.status === "failed" && next.status === "cancelled" && next.generation === old.generation + 1 && next.startedAt === old.startedAt) return;
  if (next.status === old.status && sameOwner && next.startedAt === old.startedAt && next.finishedAt === old.finishedAt
    && next.nextStep === old.nextStep && recordRevision(next.effects) === recordRevision(old.effects)) return;
  stop();
}
async function readRaw(store: StoreHost, path: string): Promise<string | null> {
  const file = store.getFile(path);
  if (!file) return null;
  if (file.stat?.size > 1024 * 1024) stop();
  const text = await store.app.vault.read(file);
  if (file.path !== path || Buffer.byteLength(text, "utf8") > 1024 * 1024) stop();
  return text;
}

export class ProjectJobRepository {
  constructor(private readonly store: StoreHost) {}
  private assertAccessible(store: StoreHost = this.store, path: string = projectJobPath(this.store)): void {
    if (projectJobPath(this.store) !== path || projectJobPath(store) !== path
      || isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)) stop();
  }
  private snapshot(path: string, raw: string | null): ProjectJobSnapshot {
    const document = parse(raw); freeze(document);
    const snapshot = Object.freeze({ path, raw, document });
    snapshots.set(snapshot, { host: this.store, path, raw, document }); return snapshot;
  }
  private prepare(snapshot: ProjectJobSnapshot, incoming: ProjectJob, version: 1 | 2 = snapshot.document.version): { path: string; before: string | null; next: string; job: ProjectJob } {
    this.assertAccessible();
    const state = snapshots.get(snapshot);
    if (!state || state.host !== this.store || state.path !== projectJobPath(this.store)) stop();
    if (state.document.job && state.document.version !== version || !object(incoming) || !validateProjectJobDocument({ version, job: incoming })) stop();
    const job = mergeJob(state.document.job, incoming);
    const document = { ...state.document, version, job };
    if (!validateProjectJobDocument(document)) stop();
    validateTransition(state.document.job, job, version);
    const next = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(next, "utf8") > 1024 * 1024) stop();
    return { path: state.path, before: state.raw, next, job };
  }
  async load(): Promise<ProjectJobSnapshot> {
    const { guardedOperationOwner } = await import("./dataFoundation/factOperation");
    const owner = guardedOperationOwner(this.store) ?? this.store;
    const path = projectJobPath(this.store);
    this.assertAccessible(owner, path);
    const raw = await readRaw(this.store, path);
    this.assertAccessible(owner, path);
    return this.snapshot(path, raw);
  }
  /** Joins the caller's current Fact transaction; never opens a nested operation. */
  async updateInScope(snapshot: ProjectJobSnapshot, nextJob: ProjectJob, scopedStore: StoreHost = this.store, version: 1 | 2 = snapshot.document.version): Promise<ProjectJobSnapshot> {
    const prepared = this.prepare(snapshot, structuredClone(nextJob), version);
    const { isGuardedOperationScope, guardedOperationOwner } = await import("./dataFoundation/factOperation");
    const owner = guardedOperationOwner(scopedStore);
    if (!isGuardedOperationScope(scopedStore) || (owner !== this.store && scopedStore !== this.store)
      || projectJobPath(scopedStore) !== prepared.path) stop();
    this.assertAccessible(owner ?? this.store, prepared.path);
    if (await readRaw(scopedStore, prepared.path) !== prepared.before) stop();
    this.assertAccessible(owner ?? this.store, prepared.path);
    const file = scopedStore.getFile(prepared.path);
    if (file) {
      await scopedStore.app.vault.process(file, current => {
        this.assertAccessible(owner ?? this.store, prepared.path);
        if (file.path !== prepared.path || current !== prepared.before) stop();
        const currentDocument = parse(current);
        if (currentDocument.job?.id !== snapshot.document.job?.id || currentDocument.job?.revision !== snapshot.document.job?.revision) stop();
        return prepared.next;
      });
    } else {
      if (prepared.before !== null) stop();
      await scopedStore.ensureFolder(prepared.path.split("/").slice(0, -1).join("/"));
      this.assertAccessible(owner ?? this.store, prepared.path);
      await scopedStore.app.vault.create(prepared.path, prepared.next);
    }
    this.assertAccessible(owner ?? this.store, prepared.path);
    if (await readRaw(scopedStore, prepared.path) !== prepared.next) stop();
    this.assertAccessible(owner ?? this.store, prepared.path);
    return this.snapshot(prepared.path, prepared.next);
  }
  /** Internal metadata has no user undo; task execution uses updateInScope above. */
  async updateMetadata(snapshot: ProjectJobSnapshot, nextJob: ProjectJob, options?: FactOperationOptions, version: 1 | 2 = snapshot.document.version): Promise<ProjectJobSnapshot> {
    const frozen = structuredClone(nextJob), prepared = this.prepare(snapshot, frozen, version);
    const { isGuardedOperationScope } = await import("./dataFoundation/factOperation");
    if (isGuardedOperationScope(this.store) || !this.store.runFactOperation) stop();
    const previous = snapshot.document.job;
    const operationId = previous ? `local:project-job-metadata:${randomUUID()}` : `job:${prepared.job.id}:authorize`;
    const ledger = new OperationLedger(this.store);
    const claim = await ledger.claim({ operationId, toolName: "project_job_metadata", source: "system",
      arguments: { jobId: prepared.job.id, planHash: prepared.job.planHash, generation: prepared.job.generation,
        fromRevision: previous?.revision ?? null, toRevision: prepared.job.revision, fromStatus: previous?.status ?? null, toStatus: prepared.job.status,
        beforeHash: prepared.before === null ? "absent" : createHash("sha256").update(prepared.before).digest("hex"), afterHash: createHash("sha256").update(prepared.next).digest("hex") } });
    if (claim.kind !== "execute") stop();
    try {
      return await this.store.runFactOperation({ operationId }, scope => this.updateInScope(snapshot, frozen, scope, version), async () => {
        await ledger.verify(operationId, { success: true, output: "安排状态已保存。", actions: [] });
      }, { ...options, assertCurrent: () => { this.assertAccessible(this.store, prepared.path); options?.assertCurrent?.(); } });
    } catch (error) {
      await ledger.failClaim(claim.record, "安排状态没有完成保存。").catch(() => undefined); throw error;
    }
  }

  /** Explicitly archive a settled plan, retaining its exact bytes and leaving task facts alone. */
  async archiveTerminal(snapshot: ProjectJobSnapshot, options?: FactOperationOptions): Promise<ProjectJobSnapshot> {
    const state = snapshots.get(snapshot), job = state?.document.job;
    if (!state || state.host !== this.store || !state.raw || !job || !["completed", "cancelled", "timed_out"].includes(job.status)
      || state.path !== projectJobPath(this.store) || !this.store.runFactOperation) stop();
    const { isGuardedOperationScope } = await import("./dataFoundation/factOperation");
    if (isGuardedOperationScope(this.store)) stop();
    const archivePath = projectJobArchivePath(this.store, job.id), empty = `${JSON.stringify({ ...state.document, job: null }, null, 2)}\n`;
    const assertCurrent = () => {
      this.assertAccessible(this.store, state.path);
      if (projectJobArchivePath(this.store, job.id) !== archivePath || isVaultPathExcluded(archivePath, this.store.settings.privacy?.excludedVaultPrefixes)) stop();
      options?.assertCurrent?.();
    };
    assertCurrent();
    const ledger = new OperationLedger(this.store), operationId = `job:${job.id}:archive`;
    const claim = await ledger.claim({ operationId, toolName: "project_job_archive", source: "system", arguments: {
      jobId: job.id, planHash: job.planHash, archivePath, beforeHash: createHash("sha256").update(state.raw).digest("hex"),
      afterHash: createHash("sha256").update(empty).digest("hex"), archiveHash: createHash("sha256").update(state.raw).digest("hex") } });
    if (claim.kind !== "execute") stop();
    try {
      return await this.store.runFactOperation({ operationId }, async scope => {
        assertCurrent();
        if (await readRaw(scope, state.path) !== state.raw) stop();
        const previousArchive = await readRaw(scope, archivePath);
        if (previousArchive !== null && previousArchive !== state.raw) stop();
        if (previousArchive === null) {
          await scope.ensureFolder(archivePath.split("/").slice(0, -1).join("/")); assertCurrent();
          await scope.app.vault.create(archivePath, state.raw!);
        }
        const file = scope.getFile(state.path); if (!file) stop();
        await scope.app.vault.process(file, current => {
          assertCurrent(); if (file.path !== state.path || current !== state.raw) stop();
          parse(current); return empty;
        });
        if (await readRaw(scope, archivePath) !== state.raw || await readRaw(scope, state.path) !== empty) stop();
        assertCurrent(); return this.snapshot(state.path, empty);
      }, async () => { await ledger.verify(operationId, { success: true, output: "已保留安排历史，可创建下一份安排。", actions: [] }); }, { ...options, assertCurrent });
    } catch (error) { await ledger.failClaim(claim.record, "安排归档没有完成。").catch(() => undefined); throw error; }
  }
}
