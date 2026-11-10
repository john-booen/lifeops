import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/defaults";
import { LifeOpsStore } from "../../src/store";
import type { StoreHost } from "../../src/store/settingsSlice";
import { AgentRuntime } from "../../src/agentRuntime";
import { ProjectJobRunner } from "../../src/projectJobRunner";
import { ProjectJobRepository, projectJobPath } from "../../src/projectJobRepository";
import { DiskVault } from "./diskVault";
import { projectDocumentPath } from "../../src/dataFoundation/projectPersistence";

const [root, mode, phase, projectId = "", taskMirrorSource = "", mixedWorkPlan = ""] = process.argv.slice(2), vault = new DiskVault(root);
const store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
let instant = new Date("2026-10-05T03:00:00.000Z"), refreshed = false;
// A fresh process after a simulated deadline runs after the saved instant, not back in yesterday's clock.
if (mode !== "start") {
  const previous = (await new ProjectJobRepository(store).load()).document.job;
  if (previous) instant = new Date(Math.max(instant.getTime(), Date.parse(previous.updatedAt)));
}
const runner = new ProjectJobRunner(store, new AgentRuntime({ store, refreshViews: async () => {
  if (refreshed) return; refreshed = true;
  if (phase.startsWith("after-cancelled-")) void runner.cancel(await new ProjectJobRepository(store).load());
  if (phase.startsWith("after-timed_out-")) instant = new Date((await new ProjectJobRepository(store).load()).document.job!.deadlineAt);
} }), () => instant);
const originalProcess = vault.process.bind(vault);
const originalCreate = vault.create.bind(vault);
function crash(): never { process.kill(process.pid, "SIGKILL"); throw new Error("Child was not killed"); }
vault.process = async (file, updater) => {
  const result = await originalProcess(file, updater);
  if (file.path === store.taskDbPath()) {
    const count = JSON.parse(result).tasks.length;
    if (phase === "after-task-json" && count === 1 || phase === "after-second-task-json" && count === 2) crash();
  }
  if (file.path === store.taskMirrorPath() && phase === "after-task-mirror") crash();
  if (file.path === projectDocumentPath(store) && phase === "after-project-link") crash();
  if (file.path === projectDocumentPath(store) && phase === "after-second-project-link"
    && JSON.parse(result).projects.find((project: any) => project.id === projectId)?.taskIds.length === 2) crash();
  if (file.path === projectDocumentPath(store) && phase === "after-next-step-project"
    && JSON.parse(result).projects.find((project: any) => project.id === projectId)?.nextStep === "纯虚构混合下一步") crash();
  if (file.path === projectJobPath(store)) {
    const job = JSON.parse(result).job;
    if (phase === "after-archive-clear" && job === null) crash();
    if (job === null) return result;
    if (phase === `after-${job.status}-state` && ["completed", "cancelled", "timed_out"].includes(job.status)) crash();
    if (phase === "after-running-claim" && job.status === "running" && job.effects.length === 0) crash();
    if (phase === "after-checkpoint" && job.effects[0]?.phase === "effect_recorded") crash();
    if (phase === "after-first-progress" && job.nextStep === 1) crash();
    if (phase === "after-next-step-checkpoint" && job.effects[2]?.phase === "effect_recorded") crash();
    if (phase === "after-next-step-progress" && job.nextStep === 3 && job.status === "running") crash();
  }
  if (file.path.endsWith("operation-ledger.json")) {
    const records = JSON.parse(result).records;
    if (["after-completed-audit", "after-cancelled-audit", "after-timed_out-audit"].includes(phase)
      && records.some((r: any) => r.toolName === "project_job_metadata" && r.status === "verified"
        && phase === `after-${r.arguments.toStatus}-audit`)) crash();
    if (phase === "after-archive-audit" && records.some((r: any) => r.toolName === "project_job_archive" && r.status === "verified")) crash();
    if (phase === "after-step-claim" && records.some((r: any) => r.toolName === "create_task" && r.status === "executing")) crash();
    if (phase === "after-step-audit" && records.some((r: any) => r.toolName === "create_task" && r.status === "verified")) crash();
    if (phase === "after-next-step-claim" && records.some((r: any) => r.toolName === "set_project_next_step" && r.status === "executing")) crash();
    if (phase === "after-next-step-audit" && records.some((r: any) => r.toolName === "set_project_next_step" && r.status === "verified")) crash();
    if (phase === "after-first-progress-audit") {
      const job = (await new ProjectJobRepository(store).load()).document.job;
      if (job?.nextStep === 1 && records.some((r: any) => r.toolName === "project_job_metadata" && r.status === "verified" && r.arguments.toRevision === job.revision)) crash();
    }
  }
  if (file.path.endsWith("write-recovery.json") && phase === "after-step-wal") {
    const wal = JSON.parse(result); if (wal.operationId.includes(":step:") && wal.status === "committed") crash();
  }
  if (file.path.endsWith("write-recovery.json") && phase === "after-next-step-wal") {
    const wal = JSON.parse(result); if (wal.operationId.endsWith(":step:2") && wal.status === "committed") crash();
  }
  return result;
};
vault.create = async (path, content) => {
  const file = await originalCreate(path, content);
  if (phase === "after-archive-copy" && path.includes("/Jobs/Archive/")) crash();
  return file;
};
if (mode === "archive") {
  const result = await runner.archive(await new ProjectJobRepository(store).load());
  console.log(JSON.stringify({ status: result.snapshot.document.job?.status ?? "archived" }));
}
else if (mode === "inspect") {
  const result = await runner.inspect(); console.log(JSON.stringify({ status: result.snapshot.document.job?.status, canResume: result.canResume }));
} else {
  const tasks = [{ title: "纯虚构重启任务甲", date: "明天" }, { title: "纯虚构重启任务乙", date: "后天" }];
  const sources = [store.path(store.settings.folders.ideas, "纯虚构原文.md"), ...(taskMirrorSource ? [store.taskMirrorPath()] : [])];
  const result = mode === "start" ? await runner.startConfirmed(mixedWorkPlan
    ? await runner.prepareWorkPlan(tasks, "创建纯虚构关联任务，再更改项目下一步", sources, projectId,
      { text: "纯虚构混合下一步", sourcePath: store.path(store.settings.folders.ideas, "纯虚构新原文.md") })
    : await runner.prepare(tasks, "创建任务：纯虚构重启安排", sources, undefined, projectId))
    : await runner.resume(await new ProjectJobRepository(store).load());
  console.log(JSON.stringify({ status: result.snapshot.document.job?.status, saved: result.snapshot.document.job?.nextStep,
    generation: result.snapshot.document.job?.generation }));
}
