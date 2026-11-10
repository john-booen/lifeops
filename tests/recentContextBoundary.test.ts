import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import { readRecentMarkdownSnapshot } from "../src/recentContext";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store"), { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, currentPath: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-recent-snapshot-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  currentPath = store.path(store.settings.folders.aiReports, "Conversations", "2026-11-07.md");
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
it("returns an observed conversation snapshot and ignores later edits", async () => {
  await vault.seed(currentPath, "虚构原文");
  const folder = store.path(store.settings.folders.aiReports, "Conversations");
  const snapshot = await readRecentMarkdownSnapshot(store, folder, 3, 500);
  await vault.seed(currentPath, "虚构后来编辑");
  expect(snapshot.text).toContain("虚构原文");
  expect(snapshot.files.map(file => file.path)).toEqual([currentPath]);
  expect((await readRecentMarkdownSnapshot(store, folder, 3, 500)).text).toContain("虚构后来编辑");
});
it("does not read excluded history", async () => {
  await vault.seed(currentPath, "虚构私密对话");
  store.settings.privacy!.excludedVaultPrefixes = [currentPath];
  const read = vi.spyOn(vault, "read");
  expect((await readRecentMarkdownSnapshot(store, store.path(store.settings.folders.aiReports, "Conversations"), 3, 500)).text).toBe("");
  expect(read.mock.calls.some(([file]) => file.path === currentPath)).toBe(false);
});
