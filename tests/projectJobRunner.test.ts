import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { AiToolCall } from "../src/ai";
import type { StoreHost } from "../src/store/settingsSlice";
import { DEFAULT_SETTINGS } from "../src/defaults";
vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(),
  requestUrl: vi.fn(() => { throw new Error("Network forbidden"); })
}));
const { AgentRuntime, getCommittedTaskEvidence } = await import("../src/agentRuntime");
const { LifeOpsStore } = await import("../src/store");
const { OperationLedger } = await import("../src/dataFoundation/operationLedger");
const { renderTaskMirror } = await import("../src/dataFoundation/taskPersistence");
const { createPersonalMemory, reviewPersonalMemoryRecord } = await import("../src/personalMemory");
const { projectFileName } = await import("../src/projectContinuity");
const { getLifeOpsTool } = await import("../src/toolRegistry");
const { DiskVault } = await import("./helpers/diskVault");
const { ProjectJobRunner } = await import("../src/projectJobRunner");
const { ProjectJobRepository, projectJobPath, projectJobPlanHash } = await import("../src/projectJobRepository");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>, runner: InstanceType<typeof ProjectJobRunner>;
let clock = new Date("2026-10-05T03:00:00.000Z");
let source: string;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
beforeEach(async () => {
  clock = new Date("2026-10-05T03:00:00.000Z"); root = await mkdtemp(join(tmpdir(), "lifeops-project-job-runner-")); vault = new DiskVault(root);
  store = new LifeOpsStore({ vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault(); runtime = new AgentRuntime({ store, refreshViews: async () => {} }); runner = new ProjectJobRunner(store, runtime, () => clock);
  source = store.path(store.settings.folders.ideas, "纯虚构任务来源.md"); await vault.seed(source, "纯虚构原文第一版");
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const prepare = () => runner.prepare([{ title: "纯虚构任务甲", date: "明天" }, { title: "纯虚构任务乙", time: "09:00" }], "创建任务：纯虚构两项安排", [source]);
async function ledger() { return store.readJson<any>(new OperationLedger(store).filePath, {}); }
async function savedJob() { return new ProjectJobRepository(store).load(); }
async function reopen() {
  const app = store.app; store = new LifeOpsStore(app, structuredClone(store.settings)) as unknown as StoreHost;
  runtime = new AgentRuntime({ store, refreshViews: async () => {} }); runner = new ProjectJobRunner(store, runtime, () => clock);
}
it("previews without any write, freezes dates, then saves two active tasks with durable exact receipts", async () => {
  const beforeWrites = vault.writes.length, plan = await prepare(); expect(vault.writes.length).toBe(beforeWrites);
  const first=plan.job.steps[0];if(first.toolName!=="create_task")throw Error("Expected legacy task plan");
  expect(first.arguments.date).toBe("2026-10-06"); expect(Object.isFrozen(first.arguments)).toBe(true);
  const result = await runner.startConfirmed(plan); expect(result.snapshot.document.job?.status).toBe("completed");
  expect(result.snapshot.document.job?.effects.map(e => e.phase)).toEqual(["committed", "committed"]);
  expect(result.message).toContain("任务本身仍未完成"); const tasks = (await store.readTaskDb()).tasks;
  expect(tasks.map(task => task.status)).toEqual(["active", "active"]); expect(tasks.map(task => task.date)).toEqual(["2026-10-06", "2026-10-05"]);
  const audit = await ledger(); const effects = audit.records.filter((r: any) => r.toolName === "create_task");
  expect(effects).toHaveLength(2); expect(effects.every((r: any) => r.result.undo.files.length === 2 && r.result.jobCheckpoint.document)).toBe(true);
  const cached = await runtime.executeToolCall({ toolName: "create_task", callId: effects[0].operationId, arguments: effects[0].arguments, source: "system", confirmedByUser: true });
  expect(cached.success).toBe(true); expect(JSON.stringify(cached)).not.toContain("jobCheckpoint"); expect(JSON.stringify(cached)).not.toContain("first-party-confirmation");
  await reopen(); const inspection=await runner.inspect();expect(inspection.snapshot.document.job?.status).toBe("completed");expect(inspection.savedStateVerified).toBe(true);
  await runner.resume((await runner.inspect()).snapshot); expect((await store.readTaskDb()).tasks).toHaveLength(2);
});
it("rejects copied previews and changed sources without creating any job or task", async () => {
  const plan = await prepare(); await expect(runner.startConfirmed({ ...plan })).rejects.toThrow();
  await vault.seed(source, "纯虚构原文第二版"); await expect(runner.startConfirmed(plan)).rejects.toThrow();
  expect((await savedJob()).document.job).toBeNull(); expect((await store.readTaskDb()).tasks).toHaveLength(0);
});
it("does not publish a verified display result when the host unloads while inspection is awaiting its snapshot",async()=>{
  await runner.startConfirmed(await prepare());let loaded=true;
  runner=new ProjectJobRunner(store,runtime,()=>clock,()=>{if(!loaded)throw Error("纯虚构旧宿主已关闭");});
  const entered=deferred(),release=deferred(),original=ProjectJobRepository.prototype.load;
  vi.spyOn(ProjectJobRepository.prototype,"load").mockImplementationOnce(async function(this:InstanceType<typeof ProjectJobRepository>){const result=await original.call(this);entered.resolve();await release.promise;return result;});
  const beforeWrites=vault.writes.length,pending=runner.inspect();await entered.promise;loaded=false;release.resolve();
  const inspection=await pending;expect(inspection.savedStateVerified).not.toBe(true);expect(inspection.canResume).toBe(false);
  expect(vault.writes.length).toBe(beforeWrites);expect((await store.readTaskDb()).tasks).toHaveLength(2);
});
it("blocks concurrent confirmations and resume clicks without duplicating tasks", async () => {
  const plan = await prepare(), entered = deferred(), release = deferred(), tool = getLifeOpsTool("create_task")!, original = tool.execute;
  vi.spyOn(tool, "execute").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return original(...args); });
  const pending = runner.startConfirmed(plan); await entered.promise;
  await expect(runner.resume(await savedJob())).rejects.toThrow("仍在结算"); await expect(runner.startConfirmed(plan)).rejects.toThrow();
  release.resolve(); await pending; expect((await store.readTaskDb()).tasks).toHaveLength(2);
});
it("restores a task and its candidate checkpoint when cancelled before commit", async () => {
  const plan = await prepare(), entered = deferred(), release = deferred(), tool = getLifeOpsTool("create_task")!, original = tool.execute;
  const beforeJson = await vault.bytes(store.taskDbPath()), beforeMirror = await vault.bytes(store.taskMirrorPath());
  vi.spyOn(tool, "execute").mockImplementation(async (...args) => { const result = await original(...args); entered.resolve(); await release.promise; return result; });
  const pending = runner.startConfirmed(plan); await entered.promise; const stopping = runner.cancel(await savedJob()); release.resolve();
  const result = await pending; await stopping; expect(result.snapshot.document.job?.status).toBe("cancelled");
  expect(result.snapshot.document.job?.nextStep).toBe(0); expect(await vault.bytes(store.taskDbPath())).toBe(beforeJson); expect(await vault.bytes(store.taskMirrorPath())).toBe(beforeMirror);
  await reopen(); expect((await runner.inspect()).canResume).toBe(false); await runner.resume(await savedJob()); expect((await store.readTaskDb()).tasks).toHaveLength(0);
});
it("preserves an already committed first task when cancellation arrives during refresh", async () => {
  const entered = deferred(), release = deferred(); runtime = new AgentRuntime({ store, refreshViews: async () => { entered.resolve(); await release.promise; } });
  runner = new ProjectJobRunner(store, runtime, () => clock); const pending = runner.startConfirmed(await prepare()); await entered.promise;
  const stopping = runner.cancel(await savedJob()); release.resolve(); const result = await pending; await stopping;
  expect(result.snapshot.document.job?.status).toBe("cancelled"); expect(result.snapshot.document.job?.nextStep).toBe(1); expect((await store.readTaskDb()).tasks).toHaveLength(1);
  expect(result.snapshot.document.job?.effects[0].phase).toBe("committed");
});
it("rolls back a mid-save task on deadline and records timed_out without dispatching the next step", async () => {
  const plan = await prepare(), entered = deferred(), release = deferred(), tool = getLifeOpsTool("create_task")!, original = tool.execute;
  vi.spyOn(tool, "execute").mockImplementation(async (...args) => { const result = await original(...args); entered.resolve(); await release.promise; return result; });
  const pending = runner.startConfirmed(plan); await entered.promise; clock = new Date(plan.job.deadlineAt); release.resolve();
  const result = await pending; expect(result.snapshot.document.job?.status).toBe("timed_out"); expect((await store.readTaskDb()).tasks).toHaveLength(0);
});
it("recovers after committed task but failed phase metadata, using stable operation ID exactly once", async () => {
  const original = ProjectJobRepository.prototype.updateMetadata; let failOnce = true;
  vi.spyOn(ProjectJobRepository.prototype, "updateMetadata").mockImplementation(async function (this: InstanceType<typeof ProjectJobRepository>, snapshot, job, options) {
    if (failOnce && job.effects.length === 1 && job.effects[0].phase === "committed") { failOnce = false; throw new Error("纯虚构进度磁盘失败"); }
    return original.call(this, snapshot, job, options);
  });
  await expect(runner.startConfirmed(await prepare())).rejects.toThrow(); expect((await store.readTaskDb()).tasks).toHaveLength(1);
  expect((await savedJob()).document.job?.effects[0].phase).toBe("effect_recorded");
  await reopen(); const inspection = await runner.inspect(); expect(inspection.canResume).toBe(true);
  const result = await runner.resume(inspection.snapshot); expect(result.snapshot.document.job?.status).toBe("completed");
  expect((await store.readTaskDb()).tasks).toHaveLength(2); expect((await ledger()).records.filter((r: any) => r.toolName === "create_task").every((r: any) => r.attempts === 1)).toBe(true);
});
it("plugin unload cancels dispatch, preserves committed checkpoint, and only explicit new generation resumes", async () => {
  let loaded = true; const entered = deferred(), release = deferred();
  runtime = new AgentRuntime({ store, refreshViews: async () => { entered.resolve(); await release.promise; } });
  runner = new ProjectJobRunner(store, runtime, () => clock, () => { if (!loaded) throw new Error("纯虚构已停用"); });
  const pending = runner.startConfirmed(await prepare()); await entered.promise; loaded = false; runner.stopForHostUnload(); release.resolve();
  await expect(pending).rejects.toThrow(); expect((await store.readTaskDb()).tasks).toHaveLength(1); expect((await savedJob()).document.job?.status).toBe("running");
  await reopen(); const beforeWrites = vault.writes.length; const inspection = await runner.inspect(); expect(vault.writes.length).toBe(beforeWrites); expect(inspection.canResume).toBe(true);
  const resumed = await runner.resume(inspection.snapshot); expect(resumed.snapshot.document.job?.status).toBe("completed"); expect(resumed.snapshot.document.job?.generation).toBe(2); expect((await store.readTaskDb()).tasks).toHaveLength(2);
});
it("task undo excludes control metadata and blocks resumed rewriting after a tombstone", async () => {
  const result = await runner.startConfirmed(await prepare()), beforeJob = await vault.bytes(projectJobPath(store));
  const undone = await runtime.undoLatestOperation(); expect(undone).toBe(result.snapshot.document.job?.steps[1].operationId);
  expect(await vault.bytes(projectJobPath(store))).toBe(beforeJob); expect((await store.readTaskDb()).tasks).toHaveLength(1);
  expect((await runner.inspect()).canResume).toBe(false); await runner.resume(await savedJob()); expect((await store.readTaskDb()).tasks).toHaveLength(1);
});
it("refuses manual plan rehashing because the original local authorization hash is unchanged", async () => {
  const original = ProjectJobRepository.prototype.updateMetadata; let failOnce = true;
  vi.spyOn(ProjectJobRepository.prototype, "updateMetadata").mockImplementation(async function (this: InstanceType<typeof ProjectJobRepository>, snapshot, job, options) {
    if (failOnce && job.status === "running") { failOnce = false; throw new Error("纯虚构领取前失败"); } return original.call(this, snapshot, job, options);
  });
  await expect(runner.startConfirmed(await prepare())).rejects.toThrow(); const data = JSON.parse(await vault.bytes(projectJobPath(store)));
  data.job.steps[0].arguments.title = "纯虚构后改任务"; data.job.steps[0].fingerprint = (await import("../src/dataFoundation/operationLedger")).operationFingerprint("create_task", data.job.steps[0].arguments);
  data.job.planHash = projectJobPlanHash(data.job); await vault.seed(projectJobPath(store), JSON.stringify(data, null, 2)+"\n");
  expect((await runner.inspect()).canResume).toBe(false); await expect(runner.resume(await savedJob())).rejects.toThrow(); expect((await store.readTaskDb()).tasks).toHaveLength(0);
});
it("stops after first actual save if source changes, retaining the task rather than rebasing the rest", async () => {
  let refresh = 0; runtime = new AgentRuntime({ store, refreshViews: async () => { if (++refresh === 1) await vault.seed(source, "纯虚构来源已变"); } });
  runner = new ProjectJobRunner(store, runtime, () => clock);
  await expect(runner.startConfirmed(await prepare())).rejects.toThrow(); expect((await store.readTaskDb()).tasks).toHaveLength(1);
  const inspection=await runner.inspect();expect(inspection.canResume).toBe(false);expect(inspection.savedStateVerified).not.toBe(true);
  await expect(runner.resume(await savedJob())).rejects.toThrow(); expect((await store.readTaskDb()).tasks).toHaveLength(1);
});
it("refuses missing or trimmed commit evidence instead of recreating an existing source task", async () => {
  const result = await runner.startConfirmed(await prepare()); const audit = await ledger(); audit.records = audit.records.filter((r: any) => r.operationId !== result.snapshot.document.job?.steps[0].operationId);
  await vault.seed(new OperationLedger(store).filePath, JSON.stringify(audit, null, 2)+"\n");
  expect((await runner.inspect()).canResume).toBe(false); await runner.resume(await savedJob()); expect((await store.readTaskDb()).tasks).toHaveLength(2);
});
it("refuses old queued copies after cancellation without washing them into a new authorized failure", async () => {
  const plan = await prepare(), repo = new ProjectJobRepository(store);
  const queued = await repo.updateMetadata(await repo.load(), structuredClone(plan.job));
  await runner.cancel(queued); const auditBefore = await vault.bytes(new OperationLedger(store).filePath);
  const forged = JSON.parse(queued.raw!); forged.job.revision = 100;
  await vault.seed(projectJobPath(store), JSON.stringify(forged, null, 2)+"\n"); const rawBefore = await vault.bytes(projectJobPath(store));
  for (let i = 0; i < 2; i++) await expect(runner.resume(await savedJob())).rejects.toThrow();
  expect(await vault.bytes(projectJobPath(store))).toBe(rawBefore); expect(await vault.bytes(new OperationLedger(store).filePath)).toBe(auditBefore);
  expect((await store.readTaskDb()).tasks).toHaveLength(0);
});
it("rejects unproven same-process owners and never competes with a potentially late save", async () => {
  const plan = await prepare(), repo = new ProjectJobRepository(store), queued = await repo.updateMetadata(await repo.load(), structuredClone(plan.job));
  const job = queued.document.job!;
  const running = await repo.updateMetadata(queued, { ...job, revision: 1, status: "running", generation: 1, owner: `run:${process.pid}:a025d7d1-3709-4d67-93d0-c026d917922e`, startedAt: clock.toISOString() });
  const beforeWrites = vault.writes.length; await expect(runner.resume(running)).rejects.toThrow("旧运行宿主");
  expect(vault.writes.length).toBe(beforeWrites); expect((await runner.inspect()).canResume).toBe(false);
});
it("restores the task and candidate if a source changes while its verified audit is still awaiting commit", async () => {
  const entered = deferred(), release = deferred(), original = OperationLedger.prototype.verify;
  vi.spyOn(OperationLedger.prototype, "verify").mockImplementation(async function (this: InstanceType<typeof OperationLedger>, id, result) {
    const record = await original.call(this, id, result); if (record.toolName === "create_task") { entered.resolve(); await release.promise; } return record;
  });
  const beforeJson = await vault.bytes(store.taskDbPath()), beforeMirror = await vault.bytes(store.taskMirrorPath());
  const pending = runner.startConfirmed(await prepare()); await entered.promise; await vault.seed(source, "纯虚构提交中来源变化"); release.resolve();
  await expect(pending).rejects.toThrow(); expect(await vault.bytes(store.taskDbPath())).toBe(beforeJson); expect(await vault.bytes(store.taskMirrorPath())).toBe(beforeMirror);
  expect((await savedJob()).document.job?.effects).toHaveLength(0); expect((await ledger()).records.filter((r: any) => r.toolName === "create_task")[0].status).toBe("failed");
});
it("an interrupted stop claim withdraws remaining permission until explicit cancellation is repaired", async () => {
  const plan = await prepare(), repo = new ProjectJobRepository(store), queued = await repo.updateMetadata(await repo.load(), structuredClone(plan.job));
  const original = OperationLedger.prototype.verify; let once = true;
  vi.spyOn(OperationLedger.prototype, "verify").mockImplementation(async function (this: InstanceType<typeof OperationLedger>, id, result) {
    const audit = await store.readJson<any>(this.filePath, {}); const record = audit.records.find((r: any) => r.operationId === id);
    if (once && record?.arguments.toStatus === "cancelled") { once = false; throw new Error("纯虚构取消审计磁盘故障"); }
    return original.call(this, id, result);
  });
  await expect(runner.cancel(queued)).rejects.toThrow(); expect((await savedJob()).document.job?.status).toBe("queued");
  const before = await vault.bytes(projectJobPath(store)); for (let i = 0; i < 2; i++) await expect(runner.resume(await savedJob())).rejects.toThrow("停止剩余安排");
  expect(await vault.bytes(projectJobPath(store))).toBe(before); expect((await store.readTaskDb()).tasks).toHaveLength(0);
  const repaired = await runner.cancel(await savedJob()); expect(repaired.snapshot.document.job?.status).toBe("cancelled"); expect(repaired.message).toContain("剩余安排已取消");
});
it("rejects a confirmation aborted before queued metadata and writes no task or plan", async () => {
  const plan = await prepare(), control = new AbortController(); control.abort(); const before = vault.writes.length;
  await expect(runner.startConfirmed(plan, control.signal)).rejects.toThrow("已取消"); expect(vault.writes.length).toBe(before); expect((await savedJob()).document.job).toBeNull();
});
it("archives exact settled metadata without undo or task changes, then supports another plan", async () => {
  const done = await runner.startConfirmed(await prepare()), beforeJson = await vault.bytes(store.taskDbPath()), beforeMirror = await vault.bytes(store.taskMirrorPath());
  const firstId = done.snapshot.document.job!.id, firstRaw = done.snapshot.raw!;
  const archived = await runner.archive(done.snapshot); expect(archived.snapshot.document.job).toBeNull();
  const { projectJobArchivePath } = await import("../src/projectJobRepository"); expect(await vault.bytes(projectJobArchivePath(store, firstId))).toBe(firstRaw);
  expect(await vault.bytes(store.taskDbPath())).toBe(beforeJson); expect(await vault.bytes(store.taskMirrorPath())).toBe(beforeMirror);
  expect((await new OperationLedger(store).latestReversible())?.operationId).toBe(done.snapshot.document.job!.steps[1].operationId);
  const second = await runner.startConfirmed(await runner.prepare([{ title: "纯虚构下一份任务" }], "创建任务：纯虚构下一份安排"));
  expect(second.snapshot.document.job?.id).not.toBe(firstId); expect(second.snapshot.document.job?.status).toBe("completed"); expect((await store.readTaskDb()).tasks).toHaveLength(3);
  expect(await vault.bytes(projectJobArchivePath(store, firstId))).toBe(firstRaw);
});
it("refuses an existing conflicting archive and preserves current control and task facts", async () => {
  const done = await runner.startConfirmed(await prepare()), { projectJobArchivePath } = await import("../src/projectJobRepository");
  const archive = projectJobArchivePath(store, done.snapshot.document.job!.id); await vault.seed(archive, "纯虚构后来文件");
  const before = await vault.bytes(store.taskDbPath()); await expect(runner.archive(done.snapshot)).rejects.toThrow();
  expect(await vault.bytes(projectJobPath(store))).toBe(done.snapshot.raw); expect(await vault.bytes(archive)).toBe("纯虚构后来文件"); expect(await vault.bytes(store.taskDbPath())).toBe(before);
});
