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
const path = "Notes/纯虚构进程来源.md", original = "纯虚构我想先完成一件事。\n";
beforeAll(async () => { bundleRoot = await mkdtemp(join(tmpdir(), "lifeops-note-child-")); executable = join(bundleRoot, "child.mjs"); await build({ entryPoints: [resolve("tests/helpers/noteUnderstandingChild.ts")], outfile: executable, bundle: true, platform: "node", format: "esm", target: "node22", alias: { obsidian: resolve("tests/helpers/obsidianFileMock.ts") }, logLevel: "silent" }); });
afterAll(async () => { await rm(bundleRoot, { recursive: true, force: true }); });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-note-process-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; await vault.seed(path, original); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const run = (mode: string, phase = "none", id = "initial") => spawnSync(process.execPath, [executable, root, mode, phase, id], { encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" });
function successful(mode: string, phase = "none", id = "initial") { const result = run(mode, phase, id); expect(result.status, result.stderr + result.stdout).toBe(0); return JSON.parse(result.stdout); }
it.each(["candidate", "confirm"])("restores interrupted %s before audit then continues through a new process", async mode => {
  if (mode === "confirm") successful("candidate");
  const before = store.getFile(store.personalMemoryPath()) ? await vault.bytes(store.personalMemoryPath()) : null;
  expect(run(mode, "after-memory").signal).toBe("SIGKILL"); const inspected = successful("inspect"); expect(inspected.candidateQuerySucceeded).toBe(false); expect(inspected.activeCount).toBe(0);
  expect(successful("recover").recovery).toBe("restored"); expect(store.getFile(store.personalMemoryPath()) ? await vault.bytes(store.personalMemoryPath()) : null).toBe(before);
  expect(successful(mode, "none", "after-recovery").saved).toBe(true); const records = (await store.readPersonalMemories()).records;
  expect(records).toHaveLength(1); expect(records[0].status).toBe(mode === "candidate" ? "candidate" : "active"); expect(await vault.bytes(path)).toBe(original);
});
it.each(["after-audit", "after-wal"])("does not publish provisional confirmation at %s and preserves exactly one record", async phase => {
  successful("candidate"); expect(run("confirm", phase).signal).toBe("SIGKILL");
  const before = await vault.bytes(store.personalMemoryPath()), inspected = successful("inspect");
  expect(inspected.activeCount).toBe(phase === "after-wal" ? 1 : 0); expect(inspected.candidateQuerySucceeded).toBe(phase === "after-wal");
  expect(successful("recover").recovery).toBe(phase === "after-wal" ? "none" : "kept"); expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
  expect(successful("inspect").activeCount).toBe(1); expect((await store.readPersonalMemories()).records).toHaveLength(1);
});
it("keeps an audited record unavailable after the source changes during the killed final boundary", async () => {
  successful("candidate"); expect(run("confirm", "after-audit").signal).toBe("SIGKILL"); await vault.seed(path, "纯虚构外部更正，原文不再相同。\n");
  expect(successful("inspect").activeCount).toBe(0); expect(successful("recover").recovery).toBe("kept"); expect(successful("inspect").activeCount).toBe(0);
  expect((await store.readPersonalMemories()).records[0].status).toBe("active"); expect(await vault.bytes(path)).toBe("纯虚构外部更正，原文不再相同。\n");
});
it("preserves external memory edits after an actual kill and refuses a false recovery", async () => {
  expect(run("candidate", "after-memory").signal).toBe("SIGKILL"); const document = JSON.parse(await vault.bytes(store.personalMemoryPath())); document.extension = "纯虚构外部编辑保留";
  const external = JSON.stringify(document); await vault.seed(store.personalMemoryPath(), external); expect(run("recover").status).not.toBe(0); expect(await vault.bytes(store.personalMemoryPath())).toBe(external); expect(successful("inspect").candidateQuerySucceeded).toBe(false);
});
