import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import type { App } from "obsidian";
import type { StoreHost } from "../src/store/settingsSlice";
import { beforeAll, afterAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store"), { DiskVault } = await import("./helpers/diskVault");
let bundleRoot: string, executable: string, root: string, store: StoreHost, vault: InstanceType<typeof DiskVault>;
const path = "Notes/2026-10-01.md", original = "纯虚构我想先完成一件事。\n";
beforeAll(async () => { bundleRoot = await mkdtemp(join(tmpdir(), "lifeops-weekly-child-")); executable = join(bundleRoot, "child.mjs"); await build({ entryPoints: [resolve("tests/helpers/weeklyReviewChild.ts")], outfile: executable, bundle: true, platform: "node", format: "esm", target: "node22", alias: { obsidian: resolve("tests/helpers/obsidianFileMock.ts") }, logLevel: "silent" }); });
afterAll(async () => { await rm(bundleRoot, { recursive: true, force: true }); });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-weekly-process-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; await vault.seed(path, original); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const run = (mode: string, phase = "none", id = "initial") => spawnSync(process.execPath, [executable, root, mode, phase, id], { encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" });
function successful(mode: string, phase = "none", id = "initial") { const result = run(mode, phase, id); expect(result.status, result.stderr + result.stdout).toBe(0); return JSON.parse(result.stdout); }
it("restores an interrupted draft before audit and saves exactly once after explicit recovery", async () => {
  expect(run("draft", "after-draft").signal).toBe("SIGKILL"); expect(successful("inspect").querySucceeded).toBe(false);
  expect(successful("recover").recovery).toBe("restored"); expect(successful("inspect").drafts).toEqual([]);
  expect(successful("draft", "none", "after-recovery").saved).toBe(true); const inspected = successful("inspect"); expect(inspected.querySucceeded).toBe(true); expect(inspected.drafts).toHaveLength(1); expect(inspected.memories).toBe(0); expect(await vault.bytes(path)).toBe(original);
});
it.each(["after-audit", "after-wal"])("preserves one audited draft after actual kill at %s", async phase => {
  expect(run("draft", phase).signal).toBe("SIGKILL"); const before = successful("inspect"); expect(before.querySucceeded).toBe(phase === "after-wal"); expect(before.drafts).toHaveLength(1);
  const raw = await vault.bytes(before.drafts[0]); expect(successful("recover").recovery).toBe(phase === "after-wal" ? "none" : "kept"); expect(successful("inspect").querySucceeded).toBe(true); expect(await vault.bytes(before.drafts[0])).toBe(raw); expect((await store.readPersonalMemories()).records).toEqual([]);
});
it("preserves later handwritten draft bytes and refuses false recovery after an actual kill", async () => {
  expect(run("draft", "after-draft").signal).toBe("SIGKILL"); const report = successful("inspect").drafts[0], external = `${await vault.bytes(report)}\n纯虚构本人后来手写更正，必须保留。\n`; await vault.seed(report, external);
  expect(run("recover").status).not.toBe(0); expect(await vault.bytes(report)).toBe(external); expect(successful("inspect").querySucceeded).toBe(false); expect(await vault.bytes(path)).toBe(original);
});
