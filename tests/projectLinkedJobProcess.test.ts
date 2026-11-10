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
let bundleRoot: string, executable: string, root: string, store: StoreHost, projectId: string;
function run(mode: string, phase = "none") {
  const child = spawnSync(process.execPath, [executable, root, mode, phase, projectId, "read-task-mirror"],
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
  bundleRoot = await mkdtemp(join(tmpdir(), "lifeops-linked-job-bundle-")); executable = join(bundleRoot, "child.mjs");
  await build({ entryPoints: [resolve("tests/helpers/projectJobChild.ts")], outfile: executable, bundle: true, platform: "node",
    format: "esm", target: "node22", alias: { obsidian: resolve("tests/helpers/obsidianFileMock.ts") }, logLevel: "silent" });
});
afterAll(async () => { await rm(bundleRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-linked-job-crash-")); const vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault(); await vault.seed(store.path(store.settings.folders.ideas, "纯虚构原文.md"), "纯虚构原文");
  const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  for (const kind of ["goal", "project"] as const) {
    const snapshot = await store.getProjectSnapshot(), operationId = `local:linked-process-${kind}`;
    const command = kind === "goal" ? { kind: "save_goal" as const, input: { title: "纯虚构中断目标", reason: "", successCriteria: "", timeBoundary: "",
      constraints: "", nextStep: "", reviewOn: "", sourcePath: "", state: "agreed" as const, stateNote: "" } }
      : { kind: "save_project" as const, input: { title: "纯虚构中断项目", goalId: snapshot.document.goals[0].id, kind: "work" as const,
        nextStep: "", nextStepSourcePath: "", commitments: "", blockers: "", reviewOn: "", state: "started" as const, stateNote: "" } };
    const result = await runtime.executeLocalOperation("synthetic_seed_project", { command },
      scope => scope.applyProjectCommand(command, snapshot.revision, operationId), operationId);
    expect(result.success, result.output).toBe(true);
  }
  projectId = (await store.getProjectSnapshot()).document.projects[0].id;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it.each(["after-task-json", "after-task-mirror", "after-project-link", "after-checkpoint", "after-step-audit", "after-step-wal",
  "after-first-progress", "after-second-task-json", "after-second-project-link"])("recovers an actual killed bound job at %s with every association exactly once", async phase => {
  const initial = await store.getProjectSnapshot(); expect(run("start", phase).signal).toBe("SIGKILL");
  const before = await files(), inspected = run("inspect"); expect(inspected.status, inspected.stderr).toBe(0); expect(await files()).toEqual(before);
  const resumed = run("resume"); expect(resumed.status, resumed.stderr).toBe(0); expect(JSON.parse(resumed.stdout).status).toBe("completed");
  const snapshot = await store.getProjectSnapshot(), tasks = snapshot.tasks;
  expect(tasks).toHaveLength(2); expect(new Set(tasks.map(task => task.source)).size).toBe(2);
  expect(tasks.map(task => task.date)).toEqual(["2026-10-06", "2026-10-07"]); expect(tasks.every(task => task.status === "active")).toBe(true);
  expect(snapshot.document.goals).toEqual(initial.document.goals); expect(snapshot.document.projects[0].state).toBe("started");
  expect(snapshot.document.projects[0].taskIds).toEqual(tasks.map(task => task.id));
  expect(snapshot.document.projects[0].changes).toHaveLength(initial.document.projects[0].changes.length + 2);
  const job = (await new ProjectJobRepository(store).load()).document.job!;
  const audit = await store.readJson<any>(new OperationLedger(store).filePath, {});
  expect(audit.records.filter((r: any) => r.toolName === "create_task")).toHaveLength(2);
  for (const step of job.steps) expect(audit.records.find((r: any) => r.operationId === step.operationId).result.undo.files).toHaveLength(3);
  if (["after-step-audit", "after-step-wal", "after-first-progress", "after-second-task-json", "after-second-project-link"].includes(phase)) {
    expect(audit.records.find((r: any) => r.operationId === job.steps[0].operationId).attempts).toBe(1);
  }
  const beforeRepeat = await files(), repeated = run("resume"); expect(repeated.status, repeated.stderr).toBe(0); expect(await files()).toEqual(beforeRepeat);
});
it.each(["project", "task"])("preserves a later external %s edit after partial association and refuses recovery", async target => {
  expect(run("start", "after-project-link").signal).toBe("SIGKILL");
  const path = join(root, target === "project" ? projectDocumentPath(store) : store.taskDbPath());
  const raw = await readFile(path, "utf8"), edited = `${raw}\n `;
  await writeFile(path, edited); const before = await files(); expect(run("resume").status).not.toBe(0);
  expect(await files()).toEqual(before); expect(await readFile(path, "utf8")).toBe(edited);
});
it.each(["after-cancelled-state", "after-cancelled-audit", "after-completed-state", "after-completed-audit"])
  ("repairs bound terminal metadata at %s without changing Task or Project facts", async phase => {
    expect(run("start", phase).signal).toBe("SIGKILL");
    const project = await readFile(join(root, projectDocumentPath(store)), "utf8"), task = await readFile(join(root, store.taskDbPath()), "utf8");
    const before = await files(); expect(run("inspect").status).toBe(0); expect(await files()).toEqual(before);
    const recovered = run("resume"); expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout).status).toBe(phase.includes("cancelled") ? "cancelled" : "completed");
    expect(await readFile(join(root, projectDocumentPath(store)), "utf8")).toBe(project); expect(await readFile(join(root, store.taskDbPath()), "utf8")).toBe(task);
    const snapshot = await store.getProjectSnapshot(); expect(snapshot.document.projects[0].taskIds).toEqual(snapshot.tasks.map(task => task.id));
  });
it.each(["project_after", "missing_project", "job_after"])("refuses an altered verified pending WAL %s before marking it committed", async alteration => {
  expect(run("start", "after-step-audit").signal).toBe("SIGKILL");
  const path = join(root, factRecoveryPath(store)), wal = JSON.parse(await readFile(path, "utf8")); expect(wal.status).toBe("pending");
  if (alteration === "missing_project") wal.entries = wal.entries.filter((e: any) => e.path !== projectDocumentPath(store));
  else {
    const entry = wal.entries.find((e: any) => alteration === "project_after" ? e.path === projectDocumentPath(store) : e.path.endsWith("/Jobs/project-job.json"));
    const document = JSON.parse(entry.after); document.future = "纯虚构篡改恢复候选";
    entry.after = JSON.stringify(document, null, 2) + "\n"; entry.afterHash = fileRevision(entry.after);
  }
  await writeFile(path, JSON.stringify(wal, null, 2) + "\n"); const before = await files();
  expect(run("resume").status).not.toBe(0); expect(await files()).toEqual(before);
  expect(JSON.parse(await readFile(path, "utf8")).status).toBe("pending");
});
it("binds recovery proof to the first WAL bytes across an A-B-A read sequence", async () => {
  expect(run("start", "after-step-audit").signal).toBe("SIGKILL");
  const path = factRecoveryPath(store), valid = await readFile(join(root, path), "utf8"), document = JSON.parse(valid);
  document.entries = document.entries.filter((entry: any) => entry.path !== projectDocumentPath(store));
  const altered = JSON.stringify(document, null, 2) + "\n"; await writeFile(join(root, path), altered);
  const before = await files(), vault = store.app.vault as unknown as InstanceType<typeof DiskVault>, read = vault.read.bind(vault);
  let reads = 0;
  const spy = vi.spyOn(vault, "read").mockImplementation(async file => {
    // Read 1 only checks for an archive. Owned recovery reads A at 2; proof sees B at 3 and 4; settlement sees A again.
    if (file.path === path && ++reads >= 3 && reads <= 4) return valid;
    return read(file);
  });
  const runner = new ProjectJobRunner(store, new AgentRuntime({ store, refreshViews: async () => {} }), () => new Date("2026-10-05T03:00:00.000Z"));
  try { await expect(runner.resume(await new ProjectJobRepository(store).load())).rejects.toThrow(); }
  finally { spy.mockRestore(); }
  expect(reads).toBeGreaterThanOrEqual(3); expect(await files()).toEqual(before);
});
