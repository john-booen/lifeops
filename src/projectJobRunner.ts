import { randomUUID } from "node:crypto";
import type { AiToolCall } from "./ai";
import { AgentRuntime } from "./agentRuntime";
import { normalizeJournalDate, formatDate } from "./date";
import { buildTaskFromInput } from "./vaultApi";
import { TASK_PLAN_FIELDS, taskPlanUpdate } from "./features/tasks/scheduleUpdate";
import { factRecoveryPath, fileRevision, inspectFactRecovery, recoverFactOperation } from "./dataFoundation/factOperation";
import { OperationLedger, operationFingerprint, type OperationLedgerDocument } from "./dataFoundation/operationLedger";
import { recordRevision } from "./operationIdentity";
import { isVaultPathExcluded } from "./privacy";
import { ProjectJobRepository, projectJobPlanHash, projectJobStepOperationId, projectJobArchivePath, validateProjectJobDocument, type ProjectJob,
  type ProjectJobArguments, type ProjectNextStepArguments, type ProjectJobBaseline, type ProjectJobEffect, type ProjectJobSnapshot } from "./projectJobRepository";
import { assertProjectTaskBaselineCurrent, assertProjectToolSnapshotCurrent, captureProjectToolSnapshot, describeProjectTaskEffect, describeProjectLinkedTaskEffect,
  projectToolSnapshotManifest, projectToolTaskContextRevision, projectToolProjectRaw, projectToolLinkedContextRevision, projectToolTaskProtectedRevision,
  verifyProjectTaskFiles, verifyProjectLinkedTaskFiles, projectNextStepCommand, describeProjectNextStepEffect,
  verifyProjectNextStepFiles, projectWorkContextRevision, projectToolTaskRawPair, type ProjectToolSnapshot } from "./projectToolContinuity";
import { projectFileName } from "./projectContinuity";
import type { ProjectJobProjectBinding } from "./projectJobRepository";
import type { StoreHost } from "./store/settingsSlice";

export interface ProjectJobReview { readonly job: Readonly<ProjectJob>; readonly version?: 1 | 2;
  readonly nextStepBefore?: Readonly<{text:string;sourcePath:string}> }
export interface ProjectJobInspection { snapshot: ProjectJobSnapshot; canResume: boolean; message: string;
  /** Display evidence from this inspection, never a durable execution permission. */
  savedStateVerified?: boolean }
interface ActiveRun {
  jobId: string; owner: string; generation: number; revoked?: "cancelled" | "timed_out" | "interrupted";
  settled: Promise<ProjectJobInspection>;
}
const plans = new WeakMap<ProjectJobReview, { store: StoreHost; snapshot: ProjectJobSnapshot; job: ProjectJob; version: 1 | 2 }>();
interface SharedRuns { version: 1; activeRuns: WeakMap<object, ActiveRun>; owners: Map<string, ActiveRun>; settledOwners: Set<string> }
// Obsidian can unload/load bundles in one process while old promises are still settling.
const sharedKey = Symbol.for("lifeops.project-job-runs.v1");
const sharedGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown };
const existing = sharedGlobal[sharedKey];
if (existing !== undefined && ((existing as SharedRuns)?.version !== 1
  || !((existing as SharedRuns).activeRuns instanceof WeakMap) || !((existing as SharedRuns).owners instanceof Map)
  || !((existing as SharedRuns).settledOwners instanceof Set))) throw new Error("安排运行宿主状态无法识别，已停止接管。");
const shared: SharedRuns = existing as SharedRuns ?? { version: 1, activeRuns: new WeakMap(), owners: new Map(), settledOwners: new Set() };
if (existing === undefined) Object.defineProperty(sharedGlobal, sharedKey, { value: shared, configurable: false });
const activeRuns = shared.activeRuns;
function reject(message = "安排的来源、权限或保存证据无法核对，已停止后续动作。已保存的任务保留。"): never { throw new Error(message); }
function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function expectedBaseline(job: ProjectJob): ProjectJobBaseline {
  const effect = job.effects.at(-1);
  return effect ? { ...job.baseline, taskJsonHash: effect.afterTaskJsonHash, taskMirrorHash: effect.afterTaskMirrorHash,
    contextRevision: effect.contextRevisionAfter, ...(effect.protectedRevisionAfter ? { protectedRevision: effect.protectedRevisionAfter } : {}) } : structuredClone(job.baseline);
}
function expectedProjectHash(job: ProjectJob): string | undefined {
  return job.projectBinding ? job.effects.at(-1)?.afterProjectHash ?? job.projectBinding.initialProjectHash : undefined;
}
function previousProcessMayRun(owner: string | null): boolean {
  const match = owner?.match(/^run:(\d+):[a-f0-9-]{36}$/);
  if (!match) return owner !== null;
  const pid = Number(match[1]);
  // Same-process ownership is tracked synchronously in activeRuns, never by an awaited JSON update.
  if (pid === process.pid) return shared.owners.has(owner!) || !shared.settledOwners.has(owner!);
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** One explicitly started local run. Constructing/inspecting never starts a model, task or timer. */
export class ProjectJobRunner {
  private readonly repository: ProjectJobRepository;
  private readonly ledger: OperationLedger;
  constructor(private readonly store: StoreHost, private readonly runtime: AgentRuntime,
    private readonly now: () => Date = () => new Date(), private readonly assertHostCurrent: () => void = () => {}) {
    this.repository = new ProjectJobRepository(store); this.ledger = new OperationLedger(store);
  }

  async prepare(tasks: Array<Partial<ProjectJobArguments> & { title: string }>, userMessage: string,
    sourcePaths: string[] = [], deadlineMs = 24 * 60 * 60 * 1000, projectId = ""): Promise<ProjectJobReview> {
    this.assertHostCurrent();
    if (!userMessage.trim() || tasks.length < 1 || tasks.length > 8 || !Number.isSafeInteger(deadlineMs)
      || deadlineMs < 1 || deadlineMs > 24 * 60 * 60 * 1000) reject("请明确核对一至八项任务及运行期限。");
    const snapshot = await this.repository.load();
    if (snapshot.document.job) reject("已有一份持久安排，请先在安排入口核对。当前批次保留该记录，不替换它。");
    const instant = this.now(), baseDate = formatDate(instant), id = randomUUID();
    const steps = tasks.map((task, index) => {
      if (Object.keys(task).some(key => !["title", "category", ...TASK_PLAN_FIELDS].includes(key))) reject("任务包含当前不支持的字段，请重新核对。");
      const suppliedDate = task.date?.trim() || (task.dueDate !== undefined || task.dueTime !== undefined ? "" : baseDate);
      const date = suppliedDate ? normalizeJournalDate(suppliedDate, baseDate) : "", time = task.time?.trim() || "";
      const title = task.title.trim(), category = task.category?.trim() || "AI建议";
      if (suppliedDate && !date || !title || /[\r\n]/.test(title) || /[\r\n·]/.test(category)
        || time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) reject("任务标题、日期或时间无法识别，请核对后再保存。");
      const initial = buildTaskFromInput({title,date,time,category},instant);
      const suppliedPlan = {...task}; if (!date) delete suppliedPlan.date;
      const args: ProjectJobArguments = { title, date, time, category, ...taskPlanUpdate(initial, suppliedPlan, baseDate) };
      return { toolName: "create_task" as const, operationId: projectJobStepOperationId(id, index), arguments: args,
        fingerprint: operationFingerprint("create_task", args) };
    });
    const toolSnapshot = await captureProjectToolSnapshot(this.store, [...new Set(sourcePaths)].sort());
    let projectBinding: ProjectJobProjectBinding | undefined;
    if (projectId) {
      const { projectForTaskPlan } = await import("./projectTools"), projectSnapshot = await this.store.getProjectSnapshot();
      if (projectSnapshot.revision !== fileRevision(projectToolProjectRaw(this.store, toolSnapshot))) reject();
      const project = projectForTaskPlan(this.store, projectSnapshot, projectId), goal = projectSnapshot.document.goals.find(goal => goal.id === project.goalId)!;
      projectBinding = { projectId: project.id, title: project.title, goalId: goal.id, goalTitle: goal.title,
        state: project.state as ProjectJobProjectBinding["state"], initialProjectHash: projectSnapshot.revision };
      await assertProjectToolSnapshotCurrent(this.store, toolSnapshot);
    }
    const job: ProjectJob = { id, revision: 0, status: "queued", generation: 0, owner: null,
      createdAt: instant.toISOString(), updatedAt: instant.toISOString(), startedAt: null, finishedAt: null,
      deadlineAt: new Date(instant.getTime() + deadlineMs).toISOString(), userMessage: userMessage.trim(),
      authorization: "first-party-confirmation", planHash: "", steps, nextStep: 0,
      baseline: projectToolSnapshotManifest(this.store, toolSnapshot), effects: [], error: "", ...(projectBinding ? { projectBinding } : {}) };
    job.planHash = projectJobPlanHash(job);
    const review = Object.freeze({ job: frozen(structuredClone(job)) });
    plans.set(review, { store: this.store, snapshot, job: structuredClone(job), version: 1 });
    return review;
  }

  /** A fixed, visible mixed plan; no arbitrary tool selection or model execution capability. */
  async prepareWorkPlan(tasks: Array<Partial<ProjectJobArguments> & {title:string}>, userMessage: string,
    sourcePaths: string[], projectId: string, nextStep: {text:string;sourcePath?:string}, deadlineMs?: number): Promise<ProjectJobReview> {
    this.assertHostCurrent();
    if (!projectId || tasks.length < 1 || tasks.length > 7 || !nextStep || Object.keys(nextStep).some(key => !["text", "sourcePath"].includes(key))
      || typeof nextStep.text !== "string" || !nextStep.text.trim() || nextStep.text.trim().length > 4000
      || nextStep.sourcePath !== undefined && typeof nextStep.sourcePath !== "string") reject("请核对已有项目、一至七项任务和明确的项目下一步。");
    const args: ProjectNextStepArguments = { projectId, text: nextStep.text.trim(), sourcePath: nextStep.sourcePath?.trim() || "" };
    if (args.sourcePath && (!this.store.isManagedSourcePath(args.sourcePath) || !this.store.getFile(args.sourcePath)
      || isVaultPathExcluded(args.sourcePath, this.store.settings.privacy?.excludedVaultPrefixes))) reject("下一步来源无法读取或已排除，未生成安排。");
    const projectSnapshot = await this.store.getProjectSnapshot(), { projectForTaskPlan } = await import("./projectTools"),
      project = projectForTaskPlan(this.store, projectSnapshot, projectId);
    // Retain both source sets even after the current next-step graph switches.
    const paths = [...new Set([...sourcePaths, project.nextStepSourcePath, args.sourcePath].filter(Boolean))].sort();
    const taskReview = await this.prepare(tasks, userMessage, paths, deadlineMs, projectId), plan = plans.get(taskReview)!;
    plans.delete(taskReview);
    if (plan.job.projectBinding?.initialProjectHash !== projectSnapshot.revision) reject();
    const job = structuredClone(plan.job);
    job.steps.push({toolName:"set_project_next_step", operationId:projectJobStepOperationId(job.id, job.steps.length), arguments:args,
      fingerprint:operationFingerprint("set_project_next_step", args)});
    job.planHash = projectJobPlanHash(job, 2);
    if (!validateProjectJobDocument({version:2,job})) reject();
    const review = Object.freeze({version:2 as const,job:frozen(structuredClone(job)),nextStepBefore:Object.freeze({text:project.nextStep,sourcePath:project.nextStepSourcePath})});
    plans.set(review,{...plan,job,version:2});return review;
  }

  /** This entry is called only by the first-party confirmation button. */
  async startConfirmed(review: ProjectJobReview, signal?: AbortSignal): Promise<ProjectJobInspection> {
    const plan = plans.get(review);
    if (!plan || plan.store !== this.store) reject("这个安排窗口已失效，请重新打开并核对。");
    const current = () => { this.assertHostCurrent(); if (signal?.aborted) reject("本次安排已取消，尚未派发任务。"); };
    current();
    if (activeRuns.has(this.store.app.vault)) reject("已有安排正在保存，请先查看当前结果。");
    await assertProjectTaskBaselineCurrent(this.store, plan.job.baseline);
    const snapshot = await this.repository.updateMetadata(plan.snapshot, plan.job, { assertCurrent: current }, plan.version);
    plans.delete(review);
    if (signal?.aborted) return this.cancel(snapshot);
    return this.resume(snapshot, signal);
  }

  async inspect(): Promise<ProjectJobInspection> {
    this.assertHostCurrent();
    const snapshot = await this.repository.load(), job = snapshot.document.job;
    if (!job) {
      const raw = await this.read(factRecoveryPath(this.store));
      const pendingArchive = raw && inspectFactRecovery(this.store, raw).status === "pending"
        && inspectFactRecovery(this.store, raw).operationId.endsWith(":archive");
      return { snapshot, canResume: Boolean(pendingArchive), message: pendingArchive ? "上一份安排整理时中断，可以检查并恢复后再创建新安排。" : "没有未完成的持久安排。" };
    }
    const active = activeRuns.get(this.store.app.vault);
    if (active) return { snapshot, canResume: false, message: `正在核对并保存安排，原安排记录进度为 ${job.nextStep}/${job.steps.length} 项；当前结果待核对。` };
    const recoveryRaw = await this.read(factRecoveryPath(this.store));
    if (recoveryRaw) {
      const recovery = inspectFactRecovery(this.store, recoveryRaw);
      const audit = await this.store.readJson<OperationLedgerDocument>(this.ledger.filePath, { version: 1, records: [] });
      const record = audit.records.find(item => item.operationId === recovery.operationId);
      if (recovery.status === "pending" && (job.steps.some(step => step.operationId === recovery.operationId)
        || record?.toolName === "project_job_metadata" && record.arguments.jobId === job.id && record.arguments.planHash === job.planHash)) {
        return { snapshot, canResume: true, message: "上次保存中断，先检查并恢复；已保存项不会重复创建。" };
      }
    }
    try {
      await this.verify(snapshot);
      this.assertHostCurrent();
      const checked = { snapshot, savedStateVerified: true };
      if (job.status === "completed") return { ...checked, canResume: false, message: job.steps.some(step=>step.toolName==="set_project_next_step")
        ? this.report(job) : `安排已全部保存（${job.nextStep}项）；任务本身仍未完成。` };
      if (job.status === "cancelled") return { ...checked, canResume: false, message: "剩余安排已取消。已保存项保留，取消的安排不会自动重开。" };
      if (job.status === "timed_out" || this.now().getTime() >= Date.parse(job.deadlineAt)) return { ...checked, canResume: false, message: "运行期限已到，剩余安排不会自动执行。" };
      if (job.status === "running" && previousProcessMayRun(job.owner)) return { ...checked, canResume: false, message: "旧运行宿主仍可能在保存，请等待其退出或结算后再恢复。" };
      return { ...checked, canResume: true, message: `已核验保存 ${job.nextStep}/${job.steps.length} 项，恢复前会再次核对来源和原计划。` };
    } catch { return { snapshot, canResume: false, message: "来源、安排或提交证据需要核对；原记录保留，当前不会继续。" }; }
  }

  private async verify(snapshot: ProjectJobSnapshot): Promise<ProjectToolSnapshot> {
    const job = snapshot.document.job; if (!job) reject();
    const auditRaw = await this.read(this.ledger.filePath);
    const ledger = await this.verifyControl(snapshot);
    const current = await assertProjectTaskBaselineCurrent(this.store, expectedBaseline(job));
    if (job.projectBinding && fileRevision(projectToolProjectRaw(this.store, current)) !== expectedProjectHash(job)) reject();
    for (let index = 0; index < job.effects.length; index++) {
      const effect = job.effects[index], step = job.steps[index], record = ledger.records.find(item => item.operationId === step.operationId);
      if (!record || record.status !== "verified" || record.source !== "system" || record.toolName !== step.toolName
        || record.fingerprint !== step.fingerprint || operationFingerprint(record.toolName, record.arguments) !== step.fingerprint
        || !record.result?.success || record.result.actions.length || record.result.undo?.kind !== "restore_guarded_files"
        || ledger.revertedOperationHashes?.includes(fileRevision(step.operationId))) reject();
      const files = record.result.undo.files;
      if (step.toolName === "set_project_next_step") {
        if (snapshot.document.version !== 2 || !job.projectBinding) reject();
        await verifyProjectNextStepFiles(this.store, files, step.operationId, step.arguments, job.projectBinding);
        const project = files[0], pair=projectToolTaskRawPair(this.store,current);
        if (fileRevision(pair.json)!==effect.beforeTaskJsonHash || fileRevision(pair.mirror)!==effect.beforeTaskMirrorHash
          || project.beforeHash!==effect.beforeProjectHash || project.afterHash!==effect.afterProjectHash
          || projectWorkContextRevision(this.store,current,pair.json,pair.mirror,project.after)!==effect.contextRevisionAfter
          || projectToolTaskProtectedRevision(this.store,current,pair.json,pair.mirror,project.after)!==effect.protectedRevisionAfter) reject();
      } else {
      const task = job.projectBinding
        ? await verifyProjectLinkedTaskFiles(this.store, files, step.operationId, step.arguments, job.projectBinding)
        : await verifyProjectTaskFiles(this.store, files, step.operationId, step.arguments);
      const json = files.find(file => file.path === this.store.taskDbPath())!, mirror = files.find(file => file.path === this.store.taskMirrorPath())!;
      const project = files.find(file => file.path === this.store.path(this.store.settings.folders.goals, projectFileName()));
      const contextRevision = snapshot.document.version === 2
        ? projectWorkContextRevision(this.store,current,json.after,mirror.after,project!.after) : job.projectBinding
        ? projectToolLinkedContextRevision(this.store, current, json.after, project!.after, mirror.after)
        : projectToolTaskContextRevision(this.store, current, json.after, mirror.after);
      if (task.id !== effect.taskId || recordRevision(task) !== effect.taskHash
        || json.beforeHash !== effect.beforeTaskJsonHash || json.afterHash !== effect.afterTaskJsonHash
        || mirror.beforeHash !== effect.beforeTaskMirrorHash || mirror.afterHash !== effect.afterTaskMirrorHash
        || contextRevision !== effect.contextRevisionAfter) reject();
      if (job.projectBinding && (!project || project.beforeHash !== effect.beforeProjectHash || project.afterHash !== effect.afterProjectHash
        || project.beforeHash !== (index ? job.effects[index - 1].afterProjectHash : job.projectBinding.initialProjectHash)
        || projectToolTaskProtectedRevision(this.store, current, json.after, mirror.after, project.after) !== effect.protectedRevisionAfter)) reject();
      if (!job.projectBinding && effect.protectedRevisionAfter
        && projectToolTaskProtectedRevision(this.store, current, json.after, mirror.after) !== effect.protectedRevisionAfter) reject();
      }
      const proof = record.result.jobCheckpoint;
      if (!proof || proof.path !== snapshot.path || proof.jobId !== job.id || proof.planHash !== job.planHash
        || proof.stepIndex !== index || fileRevision(proof.document) !== proof.afterHash) reject();
      const candidate = JSON.parse(proof.document);
      if (!validateProjectJobDocument(candidate) || candidate.version!==snapshot.document.version || !candidate.job || candidate.job.id !== job.id || candidate.job.planHash !== job.planHash
        || candidate.job.status !== "running" || candidate.job.effects.length !== index + 1 || candidate.job.nextStep !== index
        || candidate.job.effects[index].phase !== "effect_recorded" || candidate.job.revision > job.revision
        || candidate.job.generation > job.generation
        || recordRevision(candidate.job.effects.map((item: ProjectJobEffect) => ({ ...item, phase: "committed" })))
          !== recordRevision(job.effects.slice(0, index + 1).map(item => ({ ...item, phase: "committed" })))) reject();
      await this.verifyCandidateWal(snapshot, step.operationId, files, proof);
    }
    // A step lacking a checkpoint may never be silently inferred from source markers or success text.
    for (const step of job.steps.slice(job.effects.length)) {
      const record = ledger.records.find(item => item.operationId === step.operationId);
      if (record?.status === "verified" || record?.status === "reverted"
        || ledger.revertedOperationHashes?.includes(fileRevision(step.operationId))) reject();
    }
    if (auditRaw !== await this.read(this.ledger.filePath) || snapshot.raw !== (await this.repository.load()).raw) reject();
    await assertProjectTaskBaselineCurrent(this.store, expectedBaseline(job));
    return current;
  }

  private async verifyControl(snapshot: ProjectJobSnapshot, allowCancelledIntent = false): Promise<OperationLedgerDocument> {
    const job = snapshot.document.job; if (!job) reject();
    const ledger = await this.verifyAuthorization(snapshot);
    // A durable user stop claim withdraws remaining permission even if its state write was interrupted.
    const stops = ledger.records.filter(record => record.toolName === "project_job_metadata" && record.source === "system"
      && record.arguments.jobId === job.id && record.arguments.planHash === job.planHash && record.arguments.toStatus === "cancelled");
    if (stops.some(record => record.fingerprint !== operationFingerprint(record.toolName, record.arguments))) reject();
    if (!allowCancelledIntent && stops.length && !(job.status === "cancelled" && stops.some(record => record.status === "verified"
      && record.arguments.generation === job.generation && record.arguments.afterHash === fileRevision(snapshot.raw)))) {
      reject("已收到停止剩余安排的请求；取消记录需要恢复，当前不会重新执行。");
    }
    // The original plan alone cannot authorize a restored old queued/running copy after cancellation.
    // Bind the exact current control bytes to the greatest surviving verified revision for this job.
    const bindings: Array<{ revision: number; generation: number; hash: string }> = [];
    for (const record of ledger.records) {
      if (record.status !== "verified" || record.source !== "system" || !record.result?.success || record.result.actions.length) continue;
      if (record.toolName === "project_job_metadata" && record.arguments.jobId === job.id) {
        if (record.arguments.planHash !== job.planHash || record.fingerprint !== operationFingerprint(record.toolName, record.arguments)
          || !Number.isSafeInteger(record.arguments.toRevision) || !Number.isSafeInteger(record.arguments.generation)
          || typeof record.arguments.afterHash !== "string") reject();
        bindings.push({ revision: record.arguments.toRevision as number, generation: record.arguments.generation as number, hash: record.arguments.afterHash });
      } else if (job.steps.some(step=>step.operationId===record.operationId&&step.toolName===record.toolName) && record.result.jobCheckpoint?.jobId === job.id) {
        const proof = record.result.jobCheckpoint, candidate = JSON.parse(proof.document);
        if (!validateProjectJobDocument(candidate) || candidate.version!==snapshot.document.version || !candidate.job || candidate.job.id !== job.id || candidate.job.planHash !== job.planHash
          || fileRevision(proof.document) !== proof.afterHash) reject();
        bindings.push({ revision: candidate.job.revision, generation: candidate.job.generation, hash: proof.afterHash });
      }
    }
    const latestRevision = Math.max(...bindings.map(binding => binding.revision));
    if (latestRevision !== job.revision || !bindings.some(binding => binding.revision === latestRevision
      && binding.generation === job.generation && binding.hash === fileRevision(snapshot.raw))) reject();
    return ledger;
  }

  private async verifyAuthorization(snapshot: ProjectJobSnapshot): Promise<OperationLedgerDocument> {
    const job = snapshot.document.job; if (!job) reject();
    const ledger = await this.store.readJson<OperationLedgerDocument>(this.ledger.filePath, { version: 1, records: [] });
    const authorization = ledger.records.find(record => record.operationId === `job:${job.id}:authorize`);
    if (!authorization || authorization.status !== "verified" || authorization.source !== "system"
      || authorization.toolName !== "project_job_metadata" || authorization.arguments.jobId !== job.id
      || authorization.arguments.planHash !== job.planHash || !/^(?:absent|[a-f0-9]{64})$/.test(String(authorization.arguments.beforeHash))
      || authorization.arguments.fromRevision !== null || authorization.arguments.toRevision !== 0
      || authorization.arguments.fromStatus !== null || authorization.arguments.toStatus !== "queued"
      || authorization.fingerprint !== operationFingerprint(authorization.toolName, authorization.arguments)
      || authorization.result?.success !== true || authorization.result.actions.length || authorization.result.undo) reject();
    const originallyQueued = { ...structuredClone(job), revision: 0, status: "queued", generation: 0, owner: null,
      updatedAt: job.createdAt, startedAt: null, finishedAt: null, nextStep: 0, effects: [], error: "" };
    const originalRaw = `${JSON.stringify({ ...snapshot.document, job: originallyQueued }, null, 2)}\n`;
    if (authorization.arguments.afterHash !== fileRevision(originalRaw)) reject();
    return ledger;
  }

  private async verifyCandidateWal(snapshot: ProjectJobSnapshot, operationId: string,
    taskFiles: import("./dataFoundation/factOperation").GuardedFileChange[],
    proof: NonNullable<import("./dataFoundation/operationLedger").OperationResultSnapshot["jobCheckpoint"]>, expectedRaw?: string): Promise<void> {
    const raw = await this.read(factRecoveryPath(this.store)); if (!raw) reject();
    if (expectedRaw !== undefined && raw !== expectedRaw) reject();
    const wal = inspectFactRecovery(this.store, raw);
    // Subsequent internal metadata has its own WAL. The verified task audit retains the bound checkpoint.
    if (wal.operationId !== operationId) return;
    const jobFile = wal.entries?.find((entry: any) => entry.path === snapshot.path);
    if (wal.version !== 1 || wal.operationId !== operationId || !["committed", "pending"].includes(wal.status)
      || wal.rollbackRequired || wal.auditId !== undefined || wal.auditStatus !== undefined || wal.purpose !== undefined
      || !Array.isArray(wal.entries) || wal.entries.length !== taskFiles.length + 1 || !jobFile || jobFile.after !== proof.document
      || jobFile.afterHash !== proof.afterHash || jobFile.beforeHash !== proof.beforeHash
      || fileRevision(jobFile.before) !== jobFile.beforeHash || fileRevision(jobFile.after) !== jobFile.afterHash
      || Object.hasOwn(jobFile, "previous") || jobFile.retained?.length
      || recordRevision(wal.entries.filter((entry: any) => entry.path !== snapshot.path)) !== recordRevision(taskFiles)) reject();
    if (raw !== await this.read(factRecoveryPath(this.store))) reject();
  }

  private async read(path: string): Promise<string | null> { const file = this.store.getFile(path); return file ? this.store.readPath(path) : null; }
  private updated(job: ProjectJob, patch: Partial<ProjectJob>): ProjectJob {
    return { ...structuredClone(job), ...patch, revision: job.revision + 1, updatedAt: this.now().toISOString() };
  }
  private async recoverOwnedWal(snapshot: ProjectJobSnapshot): Promise<ProjectJobSnapshot> {
    const raw = await this.read(factRecoveryPath(this.store)); if (!raw) return snapshot;
    const wal = inspectFactRecovery(this.store, raw); if (wal.status !== "pending") return snapshot;
    if (wal.auditId !== undefined || wal.auditStatus !== undefined || wal.purpose !== undefined) reject();
    const job = snapshot.document.job!;
    const record = (await this.verifyAuthorization(snapshot)).records.find(item => item.operationId === wal.operationId);
    const stepIndex = job.steps.findIndex(step => step.operationId === wal.operationId);
    const jobFile = wal.entries.find(entry => entry.path === snapshot.path);
    let owned = false;
    let recoveryGuard: (() => Promise<void>) | undefined;
    if (stepIndex >= 0 && stepIndex === job.nextStep && wal.auditId === undefined && wal.auditStatus === undefined && wal.purpose === undefined) {
      const step = job.steps[stepIndex];
      if (!record || record.source !== "system" || record.toolName !== step.toolName || record.fingerprint !== step.fingerprint
        || operationFingerprint(record.toolName, record.arguments) !== step.fingerprint || !["executing", "verified", "failed"].includes(record.status)) reject();
      // A verified audit cannot bless a different or truncated pending WAL merely by operation ID.
      // A genuine rejected final guard still uses rollbackRequired and must restore its recorded before bytes.
      if (record.status === "verified" && !wal.rollbackRequired) {
        const proof = record.result?.jobCheckpoint;
        if (!record.result?.success || record.result.actions.length || record.result.undo?.kind !== "restore_guarded_files"
          || !proof || proof.path !== snapshot.path || proof.jobId !== job.id || proof.planHash !== job.planHash
          || proof.stepIndex !== stepIndex || fileRevision(proof.document) !== proof.afterHash) reject();
        const candidate = JSON.parse(proof.document);
        if (!validateProjectJobDocument(candidate) || candidate.version!==snapshot.document.version || !candidate.job || candidate.job.id !== job.id || candidate.job.planHash !== job.planHash
          || candidate.job.status !== "running" || candidate.job.nextStep !== stepIndex || candidate.job.effects.length !== stepIndex + 1
          || candidate.job.effects[stepIndex].phase !== "effect_recorded") reject();
        if (step.toolName === "set_project_next_step") {
          if(snapshot.document.version!==2||!job.projectBinding)reject();
          await verifyProjectNextStepFiles(this.store,record.result.undo.files,step.operationId,step.arguments,job.projectBinding);
        } else if (job.projectBinding) await verifyProjectLinkedTaskFiles(this.store, record.result.undo.files, step.operationId, step.arguments, job.projectBinding);
        else await verifyProjectTaskFiles(this.store, record.result.undo.files, step.operationId, step.arguments);
        await this.verifyCandidateWal(snapshot, step.operationId, record.result.undo.files, proof, raw);
      }
      const baseline = job.effects.length > job.nextStep ? { ...job.baseline,
        taskJsonHash: job.effects[stepIndex].beforeTaskJsonHash, taskMirrorHash: job.effects[stepIndex].beforeTaskMirrorHash }
        : expectedBaseline(job);
      const projectHash = job.effects.length > job.nextStep ? job.effects[stepIndex].beforeProjectHash : expectedProjectHash(job);
      owned = wal.entries.length <= (step.toolName === "set_project_next_step" ? 2 : job.projectBinding ? 4 : 3) && wal.entries.every(entry => entry.path === snapshot.path
        ? [entry.before, entry.after].includes(snapshot.raw)
        : entry.path === this.store.taskDbPath() ? step.toolName === "create_task" && entry.beforeHash === baseline.taskJsonHash
        : entry.path === this.store.taskMirrorPath() ? step.toolName === "create_task" && entry.beforeHash === baseline.taskMirrorHash
        : !!job.projectBinding && entry.path === this.store.path(this.store.settings.folders.goals, projectFileName()) && entry.beforeHash === projectHash)
        && (jobFile ? [jobFile.before, jobFile.after].includes(snapshot.raw) : job.effects.length === job.nextStep);
      // This action does not write Task files. Their current bytes and every protected source
      // must still match the preceding committed step before recovery changes any Project bytes.
      // An explicit failed final guard remains entitled to roll back its own recorded writes.
      if (owned && step.toolName === "set_project_next_step" && !wal.rollbackRequired) {
        if (snapshot.document.version !== 2 || !job.projectBinding) reject();
        const preceding = expectedBaseline({ ...job, effects: job.effects.slice(0, stepIndex) });
        const projectFile = wal.entries.find(entry => entry.path === this.store.path(this.store.settings.folders.goals, projectFileName()));
        recoveryGuard = async () => {
          this.assertHostCurrent();
          const current = await captureProjectToolSnapshot(this.store, preceding.sourcePaths), pair = projectToolTaskRawPair(this.store, current);
          const currentProject = projectToolProjectRaw(this.store, current), projectBefore = projectFile?.before ?? currentProject;
          if (projectFile && ![projectFile.before, projectFile.after].includes(currentProject)
            || fileRevision(pair.json) !== preceding.taskJsonHash || fileRevision(pair.mirror) !== preceding.taskMirrorHash
            || fileRevision(projectBefore) !== projectHash
            || projectWorkContextRevision(this.store, current, pair.json, pair.mirror, projectBefore) !== preceding.contextRevision
            || projectToolTaskProtectedRevision(this.store, current, pair.json, pair.mirror, projectBefore) !== preceding.protectedRevision) reject();
          await assertProjectToolSnapshotCurrent(this.store, current);
          this.assertHostCurrent();
        };
        await recoveryGuard();
      }
    } else if (record?.toolName === "project_job_metadata" && record.source === "system" && record.arguments.jobId === job.id
      && record.arguments.planHash === job.planHash && record.fingerprint === operationFingerprint(record.toolName, record.arguments)
      && ["executing", "verified", "failed"].includes(record.status)
      && wal.entries.length === 1 && jobFile) {
      owned = [jobFile.before, jobFile.after].includes(snapshot.raw)
        && record.arguments.beforeHash === jobFile.beforeHash && record.arguments.afterHash === jobFile.afterHash;
    }
    if (!owned) {
      reject("另有未完成保存，请先使用现有的“检查并恢复未完成操作”，本安排没有继续。");
    }
    await recoverFactOperation(this.store, { expectedRaw: raw, assertCurrent: this.assertHostCurrent, assertBeforeRecoveryWrite: recoveryGuard });
    const recovered = await this.repository.load();
    if (!recovered.document.job || recovered.document.job.id !== job.id || recovered.document.job.planHash !== job.planHash) reject();
    return recovered;
  }

  private async recoverArchive(snapshot: ProjectJobSnapshot): Promise<boolean> {
    const raw = await this.read(factRecoveryPath(this.store)); if (!raw) return false;
    const wal = inspectFactRecovery(this.store, raw); if (wal.status !== "pending" || !wal.operationId.endsWith(":archive")) return false;
    if (wal.auditId !== undefined || wal.auditStatus !== undefined || wal.purpose !== undefined) reject();
    const ledger = await this.store.readJson<OperationLedgerDocument>(this.ledger.filePath, { version: 1, records: [] });
    const record = ledger.records.find(item => item.operationId === wal.operationId);
    if (!record || record.source !== "system" || record.toolName !== "project_job_archive"
      || !["executing", "verified", "failed"].includes(record.status)
      || record.fingerprint !== operationFingerprint(record.toolName, record.arguments)) reject();
    const jobId = String(record.arguments.jobId), archivePath = projectJobArchivePath(this.store, jobId);
    if (isVaultPathExcluded(archivePath, this.store.settings.privacy?.excludedVaultPrefixes)) reject();
    const current = wal.entries.find(entry => entry.path === snapshot.path), archive = wal.entries.find(entry => entry.path === archivePath);
    if (wal.entries.length > 2 || wal.entries.some(entry => entry.path !== snapshot.path && entry.path !== archivePath)
      || record.arguments.archivePath !== archivePath) reject();
    if (current) {
      if (![current.before, current.after].includes(snapshot.raw) || record.arguments.beforeHash !== current.beforeHash
        || record.arguments.afterHash !== current.afterHash) reject();
    } else if (!archive || !snapshot.document.job || record.arguments.beforeHash !== fileRevision(snapshot.raw)
      || record.arguments.afterHash !== fileRevision(`${JSON.stringify({ ...snapshot.document, job: null }, null, 2)}\n`)) reject();
    const retained = archive ? archive.after : await this.read(archivePath);
    if (!retained || fileRevision(retained) !== record.arguments.archiveHash || retained !== (current?.before ?? snapshot.raw)) reject();
    const document = JSON.parse(retained);
    if (!validateProjectJobDocument(document) || !document.job || document.job.id !== jobId || document.job.planHash !== record.arguments.planHash
      || !["completed", "cancelled", "timed_out"].includes(document.job.status)) reject();
    await this.verifyAuthorization({ path: snapshot.path, raw: retained, document });
    await recoverFactOperation(this.store, { expectedRaw: raw, assertCurrent: this.assertHostCurrent }); return true;
  }

  async archive(expected: ProjectJobSnapshot): Promise<ProjectJobInspection> {
    this.assertHostCurrent();
    if (activeRuns.has(this.store.app.vault)) reject("当前安排还在结算，稍后再整理历史。");
    let actual = await this.repository.load(); if (actual.raw !== expected.raw) reject("安排刚刚变化，请重新核对。");
    if (await this.recoverArchive(actual)) actual = await this.repository.load();
    if (!actual.document.job) return this.inspect();
    await this.verifyControl(actual);
    await this.repository.archiveTerminal(actual, { assertCurrent: this.assertHostCurrent });
    return this.inspect();
  }

  private async repairTerminal(snapshot: ProjectJobSnapshot): Promise<ProjectJobInspection> {
    const terminal = snapshot.document.job!;
    const recovered = await this.recoverOwnedWal(snapshot), job = recovered.document.job!;
    if (job.status === terminal.status) return this.inspect();
    if (!["queued", "running", "failed"].includes(job.status)) reject();
    await this.verifyControl(recovered, terminal.status === "cancelled");
    if (terminal.status === "completed" && job.nextStep !== job.steps.length) reject();
    await this.repository.updateMetadata(recovered, this.updated(job, { status: terminal.status,
      generation: job.generation + (terminal.status === "completed" ? 0 : 1), owner: null,
      finishedAt: this.now().toISOString(), error: terminal.error }), { assertCurrent: this.assertHostCurrent });
    return this.inspect();
  }

  /** Explicit resume; never called from onload, timers or automatic model retries. */
  async resume(expected: ProjectJobSnapshot, signal?: AbortSignal): Promise<ProjectJobInspection> {
    this.assertHostCurrent();
    const initial = await this.repository.load();
    if (expected.raw !== initial.raw || expected.path !== initial.path) reject("安排刚刚变化，请重新打开后核对。");
    if (!initial.document.job) {
      await this.recoverArchive(initial); return this.inspect();
    }
    if (await this.recoverArchive(initial)) return this.inspect();
    if (activeRuns.has(this.store.app.vault)) reject("这个安排仍在结算，没有重复执行。");
    if (!["queued", "running", "failed"].includes(initial.document.job.status)) {
      const raw = await this.read(factRecoveryPath(this.store));
      if (raw && inspectFactRecovery(this.store, raw).status === "pending") return this.repairTerminal(initial);
      return this.inspect();
    }
    if (initial.document.job.status === "running" && previousProcessMayRun(initial.document.job.owner)) reject("旧运行宿主仍可能在保存，当前不接管。");
    // Reserve the live ownership before the first await that could dispatch/repair a save.
    const owner = `run:${process.pid}:${randomUUID()}`;
    let settle!: (result: ProjectJobInspection) => void, fail!: (error: unknown) => void;
    const settled = new Promise<ProjectJobInspection>((resolve, rejectPromise) => { settle = resolve; fail = rejectPromise; });
    // The caller receives the same rejection; avoid a second unhandled promise from a cancellation observer.
    void settled.catch(() => undefined);
    const active: ActiveRun = { jobId: initial.document.job.id, owner, generation: -1, settled };
    activeRuns.set(this.store.app.vault, active);
    shared.owners.set(owner, active);
    const aborted = () => { active.revoked ??= "cancelled"; };
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    let timer: ReturnType<typeof setTimeout> | undefined, snapshot = initial, verifiedInitial = false;
    const assertCurrent = () => {
      this.assertHostCurrent();
      if (activeRuns.get(this.store.app.vault) !== active || active.revoked) reject("本次安排已停止。");
      if (recordRevision({ folders: this.store.settings.folders, privacy: this.store.settings.privacy }) !== snapshot.document.job!.baseline.settingsRevision) reject();
      if (this.now().getTime() >= Date.parse(snapshot.document.job!.deadlineAt)) { active.revoked = "timed_out"; reject("运行期限已到。"); }
    };
    try {
      snapshot = await this.recoverOwnedWal(snapshot);
      await this.verify(snapshot);
      verifiedInitial = true;
      if (this.now().getTime() >= Date.parse(snapshot.document.job!.deadlineAt)) active.revoked = "timed_out";
      if (active.revoked) {
        snapshot = await this.terminate(snapshot, active);
      } else {
        // Take a new generation without changing receipt phases; their local audit binding survives later WALs.
        const job = snapshot.document.job!;
        snapshot = await this.repository.updateMetadata(snapshot, this.updated(job, { status: "running", generation: job.generation + 1,
          owner, startedAt: job.startedAt ?? this.now().toISOString(), finishedAt: null, error: "" }), { assertCurrent });
        active.generation = snapshot.document.job!.generation;
        if (snapshot.document.job!.effects.some(effect => effect.phase === "effect_recorded")) {
          await this.verify(snapshot); assertCurrent();
          const current = snapshot.document.job!, effects = current.effects.map(effect => ({ ...effect, phase: "committed" as const }));
          snapshot = await this.repository.updateMetadata(snapshot, this.updated(current, { effects, nextStep: effects.length }), { assertCurrent });
        }
        timer = setTimeout(() => { active.revoked ??= "timed_out"; }, Math.min(2_147_483_647, Date.parse(job.deadlineAt) - this.now().getTime()));
        while (snapshot.document.job!.nextStep < snapshot.document.job!.steps.length) {
          assertCurrent();
          const before = await this.verify(snapshot), currentJob = snapshot.document.job!, index = currentJob.nextStep, step = currentJob.steps[index];
          assertCurrent();
          const audit = await this.store.readJson<OperationLedgerDocument>(this.ledger.filePath, { version: 1, records: [] });
          const previous = audit.records.find(record => record.operationId === step.operationId);
          // An executing claim without a task checkpoint can be recovered only in this explicit owned run,
          // after old process ownership and the unchanged task baseline were checked.
          if (previous?.status === "executing" && !await this.ledger.failClaim(previous, "用户显式恢复，原基线未变化且未发现已保存检查点。")) reject();
          const call: AiToolCall = { id: step.operationId, name: step.toolName, arguments: { ...step.arguments } };
          let stepBaseline: ProjectJobBaseline | undefined;
          const result = step.toolName === "set_project_next_step"
            ? await this.runtime.executeLocalOperation(step.toolName, { ...step.arguments }, async scope => {
              if (snapshot.document.version !== 2 || !currentJob.projectBinding) reject();
              assertCurrent();
              await scope.applyProjectCommand(projectNextStepCommand(projectToolProjectRaw(this.store,before),step.arguments),
                fileRevision(projectToolProjectRaw(this.store,before)),step.operationId);
              assertCurrent();
            }, step.operationId, {
              assertCurrent, userUndoPaths:[this.store.path(this.store.settings.folders.goals,projectFileName())],
              assertBeforeCommit:async()=>{if(!stepBaseline)reject();await assertProjectTaskBaselineCurrent(this.store,stepBaseline);assertCurrent();},
              checkpoint:async(scope,receipt)=>{
                assertCurrent();if(!receipt.success||receipt.actions.length||!currentJob.projectBinding)reject();
                const effect=await describeProjectNextStepEffect(this.store,before,scope,step.operationId,step.arguments,currentJob.projectBinding);
                stepBaseline=effect.baseline;
                const candidate:ProjectJobEffect={phase:"effect_recorded",stepIndex:index,operationId:step.operationId,fingerprint:step.fingerprint,
                  beforeTaskJsonHash:currentJob.effects.at(-1)!.afterTaskJsonHash,afterTaskJsonHash:effect.baseline.taskJsonHash,
                  beforeTaskMirrorHash:currentJob.effects.at(-1)!.afterTaskMirrorHash,afterTaskMirrorHash:effect.baseline.taskMirrorHash,
                  beforeProjectHash:expectedProjectHash(currentJob),afterProjectHash:effect.files[0].afterHash,
                  contextRevisionAfter:effect.baseline.contextRevision,protectedRevisionAfter:effect.baseline.protectedRevision};
                const checkpoint=await this.repository.updateInScope(snapshot,this.updated(currentJob,{effects:[...currentJob.effects,candidate]}),scope);
                assertCurrent();return{path:checkpoint.path,beforeHash:fileRevision(snapshot.raw),afterHash:fileRevision(checkpoint.raw),document:checkpoint.raw!,
                  jobId:currentJob.id,planHash:currentJob.planHash,stepIndex:index};
              }
            })
            : await this.runtime.executeToolCall({ callId: step.operationId, toolName: "create_task", arguments: call.arguments,
            source: "system", confirmedByUser: true, userMessage: currentJob.userMessage }, { assertCurrent,
            assertBeforeCommit: async () => {
              if (!stepBaseline) reject();
              await assertProjectTaskBaselineCurrent(this.store, stepBaseline); assertCurrent();
            },
            userUndoPaths: [this.store.taskDbPath(), this.store.taskMirrorPath(), ...(currentJob.projectBinding ? [this.store.path(this.store.settings.folders.goals, projectFileName())] : [])], checkpoint: async (scope, receipt) => {
              assertCurrent();
              if (!receipt.success || receipt.actions.length) reject();
              let effect = await describeProjectTaskEffect(this.store, before, scope, call);
              if (currentJob.projectBinding) {
                assertCurrent();
                await scope.applyProjectCommand({ kind: "link_task", projectId: currentJob.projectBinding.projectId, taskId: effect.task.id,
                  expectedTaskRevision: recordRevision(effect.task), remove: false }, fileRevision(projectToolProjectRaw(this.store, before)), step.operationId);
                assertCurrent();
                effect = await describeProjectLinkedTaskEffect(this.store, before, scope, call, currentJob.projectBinding);
              }
              stepBaseline = effect.baseline;
              const candidate: ProjectJobEffect = { phase: "effect_recorded", stepIndex: index, operationId: step.operationId,
                fingerprint: step.fingerprint, taskId: effect.task.id, taskHash: recordRevision(effect.task),
                beforeTaskJsonHash: currentJob.effects.at(-1)?.afterTaskJsonHash ?? currentJob.baseline.taskJsonHash,
                beforeTaskMirrorHash: currentJob.effects.at(-1)?.afterTaskMirrorHash ?? currentJob.baseline.taskMirrorHash,
                afterTaskJsonHash: effect.baseline.taskJsonHash, afterTaskMirrorHash: effect.baseline.taskMirrorHash,
                contextRevisionAfter: effect.baseline.contextRevision,
                ...(!currentJob.projectBinding && effect.baseline.protectedRevision !== currentJob.baseline.protectedRevision
                  ? { protectedRevisionAfter: effect.baseline.protectedRevision } : {}),
                ...(currentJob.projectBinding ? { beforeProjectHash: expectedProjectHash(currentJob),
                  afterProjectHash: effect.files.find(file => file.path === this.store.path(this.store.settings.folders.goals, projectFileName()))!.afterHash,
                  protectedRevisionAfter: effect.baseline.protectedRevision } : {}) };
              const checkpoint = await this.repository.updateInScope(snapshot, this.updated(currentJob, { effects: [...currentJob.effects, candidate] }), scope);
              assertCurrent();
              return { path: checkpoint.path, beforeHash: fileRevision(snapshot.raw), afterHash: fileRevision(checkpoint.raw),
                document: checkpoint.raw!, jobId: currentJob.id, planHash: currentJob.planHash, stepIndex: index };
            } });
          // Read actual settled bytes. A cancelled transaction may have restored the candidate.
          const actual = await this.repository.load();
          if (actual.document.job?.id !== currentJob.id || actual.document.job.generation !== active.generation || actual.document.job.owner !== owner) reject();
          snapshot = actual;
          if (!result.success) reject(result.output);
          await this.verify(snapshot);
          const saved = snapshot.document.job!, committed = saved.effects.map(effect => ({ ...effect, phase: "committed" as const }));
          // Cancellation after commit preserves and promotes the actual receipt, then stops remaining steps.
          snapshot = await this.repository.updateMetadata(snapshot, this.updated(saved, { effects: committed, nextStep: committed.length }), { assertCurrent: this.assertHostCurrent });
          if (active.revoked) break;
        }
        if (active.revoked) snapshot = await this.terminate(snapshot, active);
        else {
          assertCurrent(); await this.verify(snapshot); assertCurrent();
          snapshot = await this.repository.updateMetadata(snapshot, this.updated(snapshot.document.job!, { status: "completed", owner: null,
            finishedAt: this.now().toISOString() }), { assertCurrent });
        }
      }
      const result = { snapshot, canResume: false, message: this.report(snapshot.document.job!) }; settle(result); return result;
    } catch (error) {
      try {
        const actual = await this.repository.load(), job = actual.document.job;
        if (verifiedInitial && job?.id === active.jobId && job.planHash === initial.document.job!.planHash
          && (job.owner === active.owner && job.generation === active.generation || job.status === "queued" && actual.raw === initial.raw)
          && ["queued", "running"].includes(job.status)) {
          await this.verifyControl(actual);
          if (active.revoked) snapshot = await this.terminate(actual, active);
          else snapshot = await this.repository.updateMetadata(actual, this.updated(job, { status: "failed", owner: null,
            finishedAt: this.now().toISOString(), error: "保存或来源核对未完成，未开始项保留。" }));
        }
      } catch { /* Preserve a pending WAL or a concurrent edit rather than covering it with a failure label. */ }
      if (active.revoked && active.revoked !== "interrupted" && snapshot.document.job?.status === active.revoked) {
        const result = { snapshot, canResume: false, message: this.report(snapshot.document.job) }; settle(result); return result;
      }
      fail(error); throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      shared.owners.delete(owner); shared.settledOwners.add(owner);
      if (shared.settledOwners.size > 500) shared.settledOwners.delete(shared.settledOwners.values().next().value!);
      if (activeRuns.get(this.store.app.vault) === active) activeRuns.delete(this.store.app.vault);
    }
  }

  private async terminate(snapshot: ProjectJobSnapshot, active: ActiveRun): Promise<ProjectJobSnapshot> {
    const job = snapshot.document.job!;
    if (active.revoked === "interrupted") return snapshot; // plugin unload revokes execution; restart remains an explicit recovery.
    if (!active.revoked || !["queued", "running"].includes(job.status)) return snapshot;
    return this.repository.updateMetadata(snapshot, this.updated(job, { status: active.revoked, generation: job.generation + 1,
      owner: null, finishedAt: this.now().toISOString(), error: active.revoked === "cancelled" ? "用户停止剩余安排。" : "运行期限已到。" }));
  }
  async cancel(expected: ProjectJobSnapshot): Promise<ProjectJobInspection> {
    const job = expected.document.job; if (!job) return this.inspect();
    const active = activeRuns.get(this.store.app.vault);
    if (active?.jobId === job.id) {
      active.revoked = "cancelled"; // revoke synchronously before waiting for the current Fact transaction.
      await active.settled.catch(() => undefined); return this.inspect();
    }
    const actual = await this.repository.load(); if (actual.raw !== expected.raw) reject("安排已变化，请重新核对。");
    if (!["queued", "running", "failed", "cancelled"].includes(job.status)) return this.inspect();
    if (job.status === "cancelled") {
      const raw = await this.read(factRecoveryPath(this.store));
      if (!raw || inspectFactRecovery(this.store, raw).status !== "pending") return this.inspect();
    }
    if (job.status === "running" && previousProcessMayRun(job.owner)) reject("旧宿主仍可能在保存，当前不能覆盖其状态。");
    const recovered = await this.recoverOwnedWal(actual); await this.verifyControl(recovered, true);
    const current = recovered.document.job!;
    if (current.status === "cancelled") return this.inspect();
    await this.repository.updateMetadata(recovered, this.updated(current, { status: "cancelled", generation: current.generation + 1,
      owner: null, finishedAt: this.now().toISOString(), error: "用户停止剩余安排。" }));
    return this.inspect();
  }
  stopForHostUnload(): void {
    const active = activeRuns.get(this.store.app.vault); if (active) active.revoked = "interrupted";
  }
  private report(job: ProjectJob): string {
    if(job.status==="completed"&&job.steps.some(step=>step.toolName==="set_project_next_step"))
      return `安排已全部保存（${job.steps.filter(step=>step.toolName==="create_task").length}项任务已创建并关联，项目下一步已更新）；任务本身仍未完成，项目阶段保持原值。`;
    if (job.status === "completed") return `安排已全部保存（${job.nextStep}/${job.steps.length}项）；任务本身仍未完成。`;
    if (job.status === "cancelled") return `剩余安排已取消，已核验保存${job.nextStep}项保留。`;
    if (job.status === "timed_out") return `运行期限已到，已核验保存${job.nextStep}项保留。`;
    return `安排已中断，已核验保存${job.nextStep}项；重新打开后请先检查再恢复。`;
  }
}
