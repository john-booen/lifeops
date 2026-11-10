import { activityNotePath } from "../src/activityRecords";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import { OperationLedger } from "../src/dataFoundation/operationLedger";
import { factRecoveryPath, fileRevision } from "../src/dataFoundation/factOperation";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let bundleRoot: string, executable: string, root: string, store: StoreHost, taskId: string;
let originalTasks: string, originalBoard: string;
function run(mode: string, phase = "none") {
  const child = spawnSync(process.execPath, [executable, root, mode, phase, taskId], { encoding: "utf8", timeout: 10000 });
  expect(child.error).toBeUndefined();
  return child;
}
async function originalState() {
  expect(await readFile(join(root, store.taskDbPath()), "utf8")).toBe(originalTasks);
  expect(await readFile(join(root, store.taskMirrorPath()), "utf8")).toBe(originalBoard);
  expect(store.getFile(activityNotePath(store, "tasks", "2026-09-09"))).toBeNull();
}
beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "lifeops-fact-child-bundle-")); executable = join(bundleRoot, "child.mjs");
  await build({ entryPoints: [resolve("tests/helpers/factOperationChild.ts")], outfile: executable, bundle: true, platform: "node", format: "esm", target: "node22", alias: { obsidian: resolve("tests/helpers/obsidianFileMock.ts") }, logLevel: "silent" });
});
afterAll(async () => { await rm(bundleRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-fact-crash-"));
  const vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
  taskId = (await store.createTask({ title: "重复学习", date: "2026-09-09", repeatUnit: "day", repeatInterval: 1 })).id;
  originalTasks = await vault.bytes(store.taskDbPath()); originalBoard = await vault.bytes(store.taskMirrorPath());
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe("actual process termination and restart", () => {
  it("restores A after SIGKILL with the second intent durable and B still on disk", async () => {
    const path = store.path(store.settings.folders.ideas, "纯虚构中间写入.md");
    await store.writeFile(path, "original A\r\n");
    expect(run("intermediate", "before-second-write").signal).toBe("SIGKILL");
    expect(await readFile(join(root, path), "utf8")).toBe("intermediate B");
    const pending = JSON.parse(await readFile(join(root, factRecoveryPath(store)), "utf8"));
    expect(pending.status).toBe("pending");
    expect(pending.entries.find((entry: any) => entry.path === path)).toMatchObject({ before: "original A\r\n", after: "intended C", previous: "intermediate B", previousHash: fileRevision("intermediate B") });
    const recovered = run("recover");
    expect(recovered.status, recovered.stderr).toBe(0); expect(JSON.parse(recovered.stdout).status).toBe("restored");
    expect(await readFile(join(root, path), "utf8")).toBe("original A\r\n"); await originalState();
  });
  it.each(["before-first-write", "after-first-write", "after-new-journal"])("recovers a killed compound operation at %s and retries exactly once", async phase => {
    expect(run("execute", phase).signal).toBe("SIGKILL");
    const recovered = run("recover");
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout).status).toBe("restored");
    await originalState();
    expect(run("execute").status).toBe(0);
    expect(run("execute").status).toBe(0);
    expect((await store.readTaskDb()).tasks).toHaveLength(2);
    expect((await store.readPath(activityNotePath(store, "tasks", "2026-09-09"))).match(/完成学习/g)).toHaveLength(1);
  });
  it("keeps a verified operation after a kill before the journal tail was saved", async () => {
    expect(run("execute", "after-audit").signal).toBe("SIGKILL");
    const recovered = run("recover");
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout).status).toBe("kept");
    expect(run("execute").status).toBe(0);
    expect((await store.readTaskDb()).tasks).toHaveLength(2);
  });
  it("refuses recovery after a human edits a touched file following a crash", async () => {
    expect(run("execute", "after-first-write").signal).toBe("SIGKILL");
    const changedTasks = await readFile(join(root, store.taskDbPath()), "utf8");
    const edited = `${changedTasks}\n `;
    await writeFile(join(root, store.taskDbPath()), edited);
    expect(run("recover").status).not.toBe(0);
    expect(await readFile(join(root, store.taskDbPath()), "utf8")).toBe(edited);
    expect(await readFile(join(root, store.taskMirrorPath()), "utf8")).toBe(originalBoard);
  });
  it("restores the completed operation when undo is killed during a guarded removal", async () => {
    expect(run("execute").status).toBe(0);
    const completedTasks = await readFile(join(root, store.taskDbPath()), "utf8");
    const completedBoard = await readFile(join(root, store.taskMirrorPath()), "utf8");
    const completedJournal = await readFile(join(root, activityNotePath(store, "tasks", "2026-09-09")), "utf8");
    expect(run("undo", "after-removal-rename").signal).toBe("SIGKILL");
    const recovered = run("recover");
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(await readFile(join(root, store.taskDbPath()), "utf8")).toBe(completedTasks);
    expect(await readFile(join(root, store.taskMirrorPath()), "utf8")).toBe(completedBoard);
    expect(await readFile(join(root, activityNotePath(store, "tasks", "2026-09-09")), "utf8")).toBe(completedJournal);
    expect(run("undo").status).toBe(0);
    await originalState();
  });
  it("keeps a verified undo after a kill immediately after its audit update", async () => {
    expect(run("execute").status).toBe(0);
    expect(run("undo", "after-audit").signal).toBe("SIGKILL");
    const recovered = run("recover");
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout).status).toBe("kept");
    await originalState();
  });
  it.each(["before-audit", "after-audit"])("recovers a v2 undo killed at %s in a new process without losing long history", async phase => {
    const historicalText = '"\\\n'.repeat(700_000), ledgerPath = join(root, new OperationLedger(store).filePath);
    await store.ensureFolder(new OperationLedger(store).filePath.split("/").slice(0, -1).join("/"));
    await writeFile(ledgerPath, JSON.stringify({ version: 1, records: [], preservedHistoricalExtension: historicalText }));
    expect(run("execute").status).toBe(0);
    const saved = await readFile(join(root, store.taskDbPath()), "utf8");
    expect(run("undo", phase).signal).toBe("SIGKILL");
    const pending = JSON.parse(await readFile(join(root, factRecoveryPath(store)), "utf8"));
    expect(pending).toMatchObject({ version: 2, status: "pending" });
    const recovered = run("recover");
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout).status).toBe(phase === "after-audit" ? "kept" : "restored");
    const audit = JSON.parse(await readFile(ledgerPath, "utf8"));
    expect(audit.preservedHistoricalExtension).toBe(historicalText);
    expect(audit.records.find((record: any) => record.operationId === "crash-operation").status).toBe(phase === "after-audit" ? "reverted" : "verified");
    if (phase === "before-audit") {
      expect(await readFile(join(root, store.taskDbPath()), "utf8")).toBe(saved);
      expect(run("undo").status).toBe(0);
    }
    await originalState();
    expect(Buffer.byteLength(await readFile(join(root, factRecoveryPath(store)), "utf8"))).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
});
