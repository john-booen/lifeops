import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store"), { DiskVault } = await import("./helpers/diskVault");
const { ProjectJobRepository } = await import("../src/projectJobRepository");
const { OperationLedger } = await import("../src/dataFoundation/operationLedger");
const { factRecoveryPath } = await import("../src/dataFoundation/factOperation");
let bundleRoot: string, executable: string, root: string, store: StoreHost;
function run(mode: string, phase = "none") {
  const child = spawnSync(process.execPath, [executable, root, mode, phase], { encoding: "utf8", timeout: 10000 });
  expect(child.error).toBeUndefined(); return child;
}
async function files(folder: string = root): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(path)); else result[path] = await readFile(path, "utf8");
  }
  return result;
}
beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "lifeops-job-child-bundle-")); executable = join(bundleRoot, "child.mjs");
  await build({ entryPoints: [resolve("tests/helpers/projectJobChild.ts")], outfile: executable, bundle: true, platform: "node", format: "esm", target: "node22",
    alias: { obsidian: resolve("tests/helpers/obsidianFileMock.ts") }, logLevel: "silent" });
});
afterAll(async () => { await rm(bundleRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-job-crash-")); store = new LifeOpsStore({ vault: new DiskVault(root) } as unknown as App,
    structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault(); await (store.app.vault as unknown as InstanceType<typeof DiskVault>).seed(store.path(store.settings.folders.ideas, "纯虚构原文.md"), "纯虚构原文");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it.each(["after-running-claim", "after-step-claim", "after-task-json", "after-task-mirror", "after-checkpoint", "after-step-audit", "after-step-wal", "after-first-progress", "after-first-progress-audit", "after-second-task-json"])
  ("recovers an actual killed process at %s without any duplicate task", async phase => {
    expect(run("start", phase).signal).toBe("SIGKILL"); const before = await files(), inspected = run("inspect");
    expect(inspected.status, inspected.stderr).toBe(0); expect(await files()).toEqual(before);
    const resumed = run("resume"); expect(resumed.status, resumed.stderr).toBe(0); expect(JSON.parse(resumed.stdout).status).toBe("completed");
    const tasks = (await store.readTaskDb()).tasks; expect(tasks).toHaveLength(2); expect(new Set(tasks.map(task => task.source)).size).toBe(2);
    expect(tasks.map(task => task.date)).toEqual(["2026-10-06", "2026-10-07"]); expect(tasks.every(task => task.status === "active")).toBe(true);
    const job = (await new ProjectJobRepository(store).load()).document.job!;
    const audit = await store.readJson<any>(new OperationLedger(store).filePath, {});
    expect(audit.records.filter((r: any) => r.toolName === "create_task")).toHaveLength(2);
    if (["after-step-audit", "after-step-wal", "after-first-progress", "after-first-progress-audit", "after-second-task-json"].includes(phase)) {
      expect(audit.records.find((r: any) => r.operationId === job.steps[0].operationId).attempts).toBe(1);
    }
    const beforeRepeat = await files(), repeated = run("resume"); expect(repeated.status, repeated.stderr).toBe(0); expect(await files()).toEqual(beforeRepeat);
  });
it.each(["terminal", "archive"].flatMap(kind => ["auditId", "auditStatus", "purpose"].map(field => ({kind, field}))))
  ("refuses borrowed recovery identity $field in $kind and preserves every byte", async ({kind, field}) => {
    if (kind === "archive") expect(run("start").status).toBe(0);
    expect(run(kind === "archive" ? "archive" : "start", kind === "archive" ? "after-archive-clear" : "after-cancelled-state").signal).toBe("SIGKILL");
    const path = join(root, factRecoveryPath(store)), wal = JSON.parse(await readFile(path, "utf8"));
    const audit = await store.readJson<any>(new OperationLedger(store).filePath, {});
    wal[field] = field === "auditId" ? audit.records.find((record: any) => record.toolName === "create_task" && record.status === "verified").operationId
      : field === "auditStatus" ? "verified" : "fact";
    await writeFile(path, JSON.stringify(wal)); const before = await files();
    const result = run("resume"); expect(result.status).not.toBe(0); expect(await files()).toEqual(before);
  });
it("preserves a later human edit following a partial task write and refuses recovery", async () => {
  expect(run("start", "after-task-json").signal).toBe("SIGKILL"); const path = join(root, store.taskDbPath()), edited = `${await readFile(path, "utf8")}\n `;
  await writeFile(path, edited); const before = await files(); expect(run("resume").status).not.toBe(0);
  expect(await readFile(path, "utf8")).toBe(edited); expect(await files()).toEqual(before);
});
it.each(["after-archive-copy", "after-archive-clear", "after-archive-audit"])("recovers archive termination at %s and keeps all task bytes", async phase => {
  const started = run("start"); expect(started.status, started.stderr).toBe(0);
  const beforeTasks = await readFile(join(root, store.taskDbPath()), "utf8"), beforeMirror = await readFile(join(root, store.taskMirrorPath()), "utf8");
  expect(run("archive", phase).signal).toBe("SIGKILL"); const before = await files(); const checked = run("inspect"); expect(checked.status, checked.stderr).toBe(0); expect(await files()).toEqual(before);
  const recovered = run("archive"); expect(recovered.status, recovered.stderr).toBe(0); expect(JSON.parse(recovered.stdout).status).toBe("archived");
  expect((await new ProjectJobRepository(store).load()).document.job).toBeNull();
  expect(await readFile(join(root, store.taskDbPath()), "utf8")).toBe(beforeTasks); expect(await readFile(join(root, store.taskMirrorPath()), "utf8")).toBe(beforeMirror);
});
it.each(["completed", "cancelled", "timed_out"].flatMap(status => [`after-${status}-state`, `after-${status}-audit`]))
  ("repairs terminal metadata at %s without dispatching any remaining task", async phase => {
    expect(run("start", phase).signal).toBe("SIGKILL");
    const json = await readFile(join(root, store.taskDbPath()), "utf8"), mirror = await readFile(join(root, store.taskMirrorPath()), "utf8");
    const before = await files(); expect(run("inspect").status).toBe(0); expect(await files()).toEqual(before);
    const recovered = run("resume"); expect(recovered.status, recovered.stderr).toBe(0);
    const status = phase.slice("after-".length, phase.lastIndexOf("-")); expect(JSON.parse(recovered.stdout).status).toBe(status);
    expect(await readFile(join(root, store.taskDbPath()), "utf8")).toBe(json); expect(await readFile(join(root, store.taskMirrorPath()), "utf8")).toBe(mirror);
    expect((await store.readTaskDb()).tasks).toHaveLength(status === "completed" ? 2 : 1);
    const after = await files(); expect(run("resume").status).toBe(0); expect(await files()).toEqual(after);
  });
