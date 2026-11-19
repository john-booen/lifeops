import type { App } from "obsidian";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityNotePath } from "../src/activityRecords";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { OperationLedgerDocument } from "../src/dataFoundation/operationLedger";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { AgentRuntime } = await import("../src/agentRuntime");
const { factRecoveryPath } = await import("../src/dataFoundation/factOperation");
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const originalId = "fiction-original", undoId = "fiction-voice-undo", date = "2026-10-07";
let bundleRoot: string, executable: string, root: string, store: StoreHost;
let paths: string[], before: Array<string | null>, saved: Array<string | null>;
function run(mode: string, phase = "none") {
  const child = spawnSync(process.execPath, [executable, root, mode, phase], { encoding: "utf8", timeout: 15000 });
  expect(child.error).toBeUndefined();
  return child;
}
async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(join(root, path), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function businessBytes() { return await Promise.all(paths.map(readOptional)); }
async function audit() {
  const path = store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
  return JSON.parse((await readOptional(path))!) as OperationLedgerDocument;
}
async function states() {
  const document = await audit();
  return { original: document.records.find(record => record.operationId === originalId),
    own: document.records.find(record => record.operationId === undoId) };
}
async function recovery() { return JSON.parse((await readOptional(factRecoveryPath(store)))!); }
function recover(expected: "kept" | "restored") {
  const child = run("recover");
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout).status).toBe(expected);
}
async function retry() {
  const child = run("undo");
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout).result.success, child.stdout).toBe(true);
  expect(await businessBytes()).toEqual(before);
  const state = await states();
  expect(state.original?.status).toBe("reverted");
  expect(state.own?.status).toBe("verified");
  expect(state.own?.result?.undo).toBeUndefined();
}

beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "lifeops-voice-undo-bundle-"));
  executable = join(bundleRoot, "child.mjs");
  await build({ entryPoints: [resolve("tests/helpers/voiceUndoChild.ts")], outfile: executable, bundle: true,
    platform: "node", format: "esm", target: "node22", alias: { obsidian: resolve("tests/helpers/obsidianFileMock.ts") }, logLevel: "silent" });
});
afterAll(async () => { await rm(bundleRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-voice-undo-crash-"));
  const vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
  paths = [store.taskDbPath(), store.taskMirrorPath(), activityNotePath(store, "tasks", date)];
  before = await businessBytes();
  const runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
  const result = await runtime.executeToolCall({ toolName: "create_task", arguments: { title: "纯虚构语音撤销恢复任务", date },
    source: "system", callId: originalId, confirmedByUser: true });
  expect(result.success, result.output).toBe(true);
  saved = await businessBytes();
  expect(saved).not.toEqual(before);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// Real fsync, large snapshots and subprocess recovery can exceed five seconds on hosted Intel disks.
describe("actual voice undo SIGKILL and new-process recovery", { timeout: 30_000 }, () => {
  it.each(["before-undo-audit", "after-undo-audit", "after-rollback-required", "after-rollback-complete", "before-own-release", "after-own-release"])(
    "recovers v2 long-history undo at %s without resurrecting a released claim", async phase => {
      const historicalText = '"\\\n'.repeat(700_000);
      const path = store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
      await writeFile(join(root, path), JSON.stringify({ ...await audit(), preservedHistoricalExtension: historicalText }));
      expect(run("undo", phase).signal).toBe("SIGKILL");
      expect(await recovery()).toMatchObject({ version: 2, status: "pending" });
      const interruptedOwn = (await states()).own!;
      expect(interruptedOwn.status).toBe(phase === "after-own-release" ? "failed" : ["after-undo-audit", "after-rollback-required"].includes(phase) ? "verified" : "executing");
      const finished = phase === "after-undo-audit";
      recover(finished ? "kept" : "restored");
      expect(await businessBytes()).toEqual(finished ? before : saved);
      const state = await states();
      expect(state.original?.status).toBe(finished ? "reverted" : "verified");
      expect(state.own?.status).toBe(finished ? "verified" : "failed");
      for (const key of ["operationId", "toolName", "source", "attempts", "createdAt", "fingerprint"] as const) expect(state.own?.[key]).toEqual(interruptedOwn[key]);
      expect((await audit() as OperationLedgerDocument & { preservedHistoricalExtension: string }).preservedHistoricalExtension).toBe(historicalText);
      const settled = await readOptional(factRecoveryPath(store)), settledAudit = await readOptional(path);
      const noOp = run("recover"); expect(noOp.status, noOp.stderr).toBe(0); expect(JSON.parse(noOp.stdout).status).toBe("none");
      expect(await readOptional(path)).toBe(settledAudit);
      expect(await readOptional(factRecoveryPath(store))).toBe(settled);
      await retry();
      expect((await states()).own?.attempts).toBe(finished ? 1 : 2);
      expect((await audit() as OperationLedgerDocument & { preservedHistoricalExtension: string }).preservedHistoricalExtension).toBe(historicalText);
      expect(Buffer.byteLength((await readOptional(factRecoveryPath(store)))!)).toBeLessThanOrEqual(16 * 1024 * 1024);
    }
  );
  it("restores a kill before the atomic undo audit and releases the exact own claim for retry", async () => {
    expect(run("undo", "before-undo-audit").signal).toBe("SIGKILL");
    // The new atomic write cannot expose original=reverted with own=executing.
    // This stop is before that actual write, after the business reverse writes.
    expect((await states()).original?.status).toBe("verified");
    expect((await states()).own?.status).toBe("executing");
    expect((await recovery()).status).toBe("pending");
    recover("restored");
    expect(await businessBytes()).toEqual(saved);
    expect((await states()).original?.status).toBe("verified");
    expect((await states()).own?.status).toBe("failed");
    await retry();
    expect((await states()).own?.attempts).toBe(2);
  });

  it("keeps both records after the atomic undo audit and returns the cached accurate receipt without another undo", async () => {
    expect(run("undo", "after-undo-audit").signal).toBe("SIGKILL");
    expect((await states()).original?.status).toBe("reverted");
    expect((await recovery()).status).toBe("pending");
    recover("kept");
    expect(await businessBytes()).toEqual(before);
    expect((await states()).own?.status).toBe("verified");
    const ownResult = structuredClone((await states()).own?.result);
    await retry();
    await retry();
    expect((await states()).own?.result).toEqual(ownResult);
    expect((await states()).own?.attempts).toBe(1);
    expect((await audit()).records.filter(record => record.operationId === undoId)).toHaveLength(1);
  });

  it.each(["after-rollback-required", "after-rollback-complete", "before-own-release", "after-own-release"])(
    "restores cancelled undo killed at %s, releases only its own claim, and retries once", async phase => {
      expect(run("undo", phase).signal).toBe("SIGKILL");
      const journal = await recovery();
      expect(journal.status).toBe("pending");
      expect(journal.rollbackRequired).toBe(true);
      if (phase !== "after-rollback-required") expect(journal.rollbackComplete).toBe(true);
      if (phase === "after-own-release") expect((await states()).own?.status).toBe("failed");
      recover("restored");
      expect(await businessBytes()).toEqual(saved);
      expect((await states()).original?.status).toBe("verified");
      expect((await states()).own?.status).toBe("failed");
      expect((await recovery()).status).toBe("rolled_back");
      await retry();
      expect((await states()).own?.attempts).toBe(2);
    }
  );

  it("refuses recovery after an external business edit and preserves every later byte", async () => {
    expect(run("undo", "before-undo-audit").signal).toBe("SIGKILL");
    const current = await businessBytes();
    const edited = `${current[0]}\n `;
    await writeFile(join(root, paths[0]), edited, "utf8");
    const child = run("recover");
    expect(child.status).not.toBe(0);
    expect(child.stderr).toMatch(/后来发生了变化|停止覆盖/);
    expect(await businessBytes()).toEqual([edited, ...current.slice(1)]);
    expect((await recovery()).status).toBe("pending");
    expect((await states()).original?.status).toBe("verified");
    expect((await states()).own?.status).toBe("executing");
  });

  it.each(["after-rollback-complete", "after-own-release"])(
    "refuses claim cleanup after later business bytes change following %s", async phase => {
      expect(run("undo", phase).signal).toBe("SIGKILL");
      expect(await businessBytes()).toEqual(saved);
      const journal = await recovery();
      expect(journal.status).toBe("pending");
      expect(journal.rollbackRequired).toBe(true);
      expect(journal.rollbackComplete).toBe(true);
      const ownStatus = phase === "after-own-release" ? "failed" : "executing";
      expect((await states()).own?.status).toBe(ownStatus);
      const auditBefore = await audit(), recoveryBefore = await readOptional(factRecoveryPath(store));
      const edited = `${saved[0]}\n `;
      await writeFile(join(root, paths[0]), edited, "utf8");
      const child = run("recover");
      expect(child.status).not.toBe(0);
      expect(child.stderr).toMatch(/后来发生了变化|停止覆盖/);
      expect(await businessBytes()).toEqual([edited, ...saved.slice(1)]);
      expect(await audit()).toEqual(auditBefore);
      expect(await readOptional(factRecoveryPath(store))).toBe(recoveryBefore);
      expect((await states()).original?.status).toBe("verified");
      expect((await states()).own?.status).toBe(ownStatus);
    }
  );
});
