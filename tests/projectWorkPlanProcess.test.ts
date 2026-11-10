import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import type { App } from "obsidian";
import type { StoreHost } from "../src/store/settingsSlice";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store"), { DiskVault } = await import("./helpers/diskVault");
const { AgentRuntime } = await import("../src/agentRuntime");
const { ProjectJobRunner } = await import("../src/projectJobRunner");
const { ProjectJobRepository } = await import("../src/projectJobRepository");
const { OperationLedger } = await import("../src/dataFoundation/operationLedger");
const { projectDocumentPath } = await import("../src/dataFoundation/projectPersistence");
const { factRecoveryPath, fileRevision } = await import("../src/dataFoundation/factOperation");
let bundleRoot: string, executable: string, root: string, store: StoreHost, projectId: string, oldSource: string, newSource: string;
function run(mode: string, phase = "none") {
  const child = spawnSync(process.execPath, [executable, root, mode, phase, projectId, "read-task-mirror", "mixed"],
    { encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" });
  expect(child.error).toBeUndefined(); return child;
}
async function files(folder = root): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(path)); else result[path] = await readFile(path, "utf8");
  }
  return result;
}
beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "lifeops-work-plan-process-bundle-")); executable = join(bundleRoot, "child.mjs");
  await build({ entryPoints: [resolve("tests/helpers/projectJobChild.ts")], outfile: executable, bundle: true, platform: "node",
    format: "esm", target: "node22", alias: { obsidian: resolve("tests/helpers/obsidianFileMock.ts") }, logLevel: "silent" });
});
afterAll(async () => { await rm(bundleRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-work-plan-process-")); const vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault(); oldSource = store.path(store.settings.folders.ideas, "纯虚构原文.md");
  newSource = store.path(store.settings.folders.ideas, "纯虚构新原文.md");
  await vault.seed(oldSource, "纯虚构原文"); await vault.seed(newSource, "纯虚构新原文");
  const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  for (const kind of ["goal", "project"] as const) {
    const snapshot = await store.getProjectSnapshot(), operationId = `local:work-process-${kind}`;
    const command = kind === "goal" ? { kind: "save_goal" as const, input: { title: "纯虚构混合中断目标", reason: "", successCriteria: "", timeBoundary: "",
      constraints: "", nextStep: "", reviewOn: "", sourcePath: "", state: "agreed" as const, stateNote: "" } }
      : { kind: "save_project" as const, input: { title: "纯虚构混合中断项目", goalId: snapshot.document.goals[0].id, kind: "work" as const,
        nextStep: "纯虚构原下一步", nextStepSourcePath: oldSource, commitments: "原承诺保留", blockers: "", reviewOn: "", state: "started" as const, stateNote: "" } };
    const result = await runtime.executeLocalOperation("synthetic_seed_project", { command },
      scope => scope.applyProjectCommand(command, snapshot.revision, operationId), operationId);
    expect(result.success, result.output).toBe(true);
  }
  projectId = (await store.getProjectSnapshot()).document.projects[0].id;
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
it.each(["after-task-json", "after-next-step-claim", "after-next-step-project", "after-next-step-checkpoint", "after-next-step-audit",
  "after-next-step-wal", "after-next-step-progress", "after-completed-state", "after-completed-audit"])
  ("recovers a genuinely killed mixed plan at %s, saving each different action exactly once", async phase => {
    const initial = await store.getProjectSnapshot(); expect(run("start", phase).signal).toBe("SIGKILL");
    const before = await files(), inspected = run("inspect"); expect(inspected.status, inspected.stderr).toBe(0); expect(await files()).toEqual(before);
    const resumed = run("resume"); expect(resumed.status, resumed.stderr).toBe(0); expect(JSON.parse(resumed.stdout).status).toBe("completed");
    const current = await store.getProjectSnapshot(), project = current.document.projects[0], tasks = current.tasks;
    expect(tasks).toHaveLength(2); expect(new Set(tasks.map(task => task.source)).size).toBe(2);
    expect(tasks.map(task => task.date)).toEqual(["2026-10-06", "2026-10-07"]); expect(tasks.every(task => task.status === "active")).toBe(true);
    expect(current.document.goals).toEqual(initial.document.goals); expect(project).toMatchObject({ state: "started", commitments: "原承诺保留",
      nextStep: "纯虚构混合下一步", nextStepSourcePath: newSource, nextStepEntryId: "" });
    expect(project.taskIds).toEqual(tasks.map(task => task.id)); expect(project.changes).toHaveLength(initial.document.projects[0].changes.length + 3);
    const document = (await new ProjectJobRepository(store).load()).document, job = document.job!; expect(document.version).toBe(2);
    expect(job.effects).toHaveLength(3); expect(job.baseline.sourcePaths).toEqual(expect.arrayContaining([oldSource, newSource, store.taskMirrorPath()]));
    expect(job.effects[2].beforeTaskJsonHash).toBe(job.effects[2].afterTaskJsonHash); expect(Object.hasOwn(job.effects[2], "taskId")).toBe(false);
    const audit = await store.readJson<any>(new OperationLedger(store).filePath, {});
    expect(audit.records.filter((r: any) => r.toolName === "create_task")).toHaveLength(2);
    expect(audit.records.filter((r: any) => r.toolName === "set_project_next_step")).toHaveLength(1);
    for (const step of job.steps) {
      const record = audit.records.find((r: any) => r.operationId === step.operationId);
      expect(record.result.undo.files.map((f: any) => f.path)).toEqual(step.toolName === "create_task"
        ? [store.taskDbPath(), store.taskMirrorPath(), projectDocumentPath(store)] : [projectDocumentPath(store)]);
      const retriedUnverified = step.toolName === "set_project_next_step"
        && ["after-next-step-claim", "after-next-step-project", "after-next-step-checkpoint"].includes(phase);
      if (phase !== "after-task-json") expect(record.attempts).toBe(retriedUnverified ? 2 : 1);
    }
    const beforeRepeat = await files(); expect(run("resume").status).toBe(0); expect(await files()).toEqual(beforeRepeat);
  });
it.each(["project", "task", "source"])("preserves a later external %s change after the final Project write and refuses recovery", async target => {
  expect(run("start", "after-next-step-project").signal).toBe("SIGKILL");
  const path = join(root, target === "project" ? projectDocumentPath(store) : target === "task" ? store.taskDbPath() : oldSource);
  const edited = (await readFile(path, "utf8")) + "\n "; await writeFile(path, edited); const before = await files();
  expect(run("resume").status).not.toBe(0); expect(await files()).toEqual(before); expect(await readFile(path, "utf8")).toBe(edited);
});
it.each(["project_after", "missing_project", "job_after"])("refuses a forged verified final-step WAL %s without settling it", async alteration => {
  expect(run("start", "after-next-step-audit").signal).toBe("SIGKILL");
  const path = join(root, factRecoveryPath(store)), wal = JSON.parse(await readFile(path, "utf8")); expect(wal.status).toBe("pending");
  expect(wal.entries).toHaveLength(2);
  if (alteration === "missing_project") wal.entries = wal.entries.filter((e: any) => e.path !== projectDocumentPath(store));
  else {
    const entry = wal.entries.find((e: any) => alteration === "project_after" ? e.path === projectDocumentPath(store) : e.path.endsWith("/Jobs/project-job.json"));
    const document = JSON.parse(entry.after); document.future = "纯虚构篡改最后动作恢复候选";
    entry.after = JSON.stringify(document, null, 2) + "\n"; entry.afterHash = fileRevision(entry.after);
  }
  await writeFile(path, JSON.stringify(wal, null, 2) + "\n"); const before = await files(); expect(run("resume").status).not.toBe(0);
  expect(await files()).toEqual(before); expect(JSON.parse(await readFile(path, "utf8")).status).toBe("pending");
});
it("binds the final-step recovery proof to its first WAL bytes across an A-B-A read sequence", async () => {
  expect(run("start", "after-next-step-audit").signal).toBe("SIGKILL");
  const path = factRecoveryPath(store), valid = await readFile(join(root, path), "utf8"), doc = JSON.parse(valid);
  doc.entries = doc.entries.filter((entry: any) => entry.path !== projectDocumentPath(store));
  await writeFile(join(root, path), JSON.stringify(doc, null, 2) + "\n"); const before = await files();
  const vault = store.app.vault as unknown as InstanceType<typeof DiskVault>, read = vault.read.bind(vault); let reads = 0;
  vi.spyOn(vault, "read").mockImplementation(async file => file.path === path && ++reads >= 3 && reads <= 4 ? valid : read(file));
  const runner = new ProjectJobRunner(store, new AgentRuntime({ store, refreshViews: async () => {} }), () => new Date("2026-10-05T03:00:00.000Z"));
  await expect(runner.resume(await new ProjectJobRepository(store).load())).rejects.toThrow();
  expect(reads).toBeGreaterThanOrEqual(3); expect(await files()).toEqual(before);
});
it.each(["after-next-step-project", "after-next-step-audit"])("rechecks protected Task bytes after an audit read at %s before any recovery write", async phase => {
  expect(run("start", phase).signal).toBe("SIGKILL");
  const vault = store.app.vault as unknown as InstanceType<typeof DiskVault>, read = vault.read.bind(vault);
  let auditReads = 0, observed: Record<string, string> | undefined;
  vi.spyOn(vault, "read").mockImplementation(async file => {
    const result = await read(file);
    if (file.path === new OperationLedger(store).filePath && ++auditReads === 2) {
      await vault.seed(store.taskDbPath(), (await readFile(join(root, store.taskDbPath()), "utf8")) + "\n "); observed = await files();
    }
    return result;
  });
  const runner = new ProjectJobRunner(store, new AgentRuntime({ store, refreshViews: async () => {} }), () => new Date("2026-10-05T03:00:00.000Z"));
  await expect(runner.resume(await new ProjectJobRepository(store).load())).rejects.toThrow();
  expect(observed).toBeDefined(); expect(await files()).toEqual(observed);
});
it("rechecks protected Task bytes changed by the final WAL read before the first recovery write", async () => {
  expect(run("start", "after-next-step-project").signal).toBe("SIGKILL");
  const vault = store.app.vault as unknown as InstanceType<typeof DiskVault>, read = vault.read.bind(vault);
  let walReads = 0, observed: Record<string, string> | undefined;
  vi.spyOn(vault, "read").mockImplementation(async file => {
    const result = await read(file);
    // Reads 1/2 locate owned recovery; 3 loads it inside the lock, 4 checks it after audit.
    // Read 5 is the last byte check immediately before restoring the first owned file.
    if (file.path === factRecoveryPath(store) && ++walReads === 5) {
      await vault.seed(store.taskDbPath(), (await readFile(join(root, store.taskDbPath()), "utf8")) + "\n "); observed = await files();
    }
    return result;
  });
  const runner = new ProjectJobRunner(store, new AgentRuntime({ store, refreshViews: async () => {} }), () => new Date("2026-10-05T03:00:00.000Z"));
  await expect(runner.resume(await new ProjectJobRepository(store).load())).rejects.toThrow();
  expect(observed).toBeDefined(); expect(await files()).toEqual(observed);
});
