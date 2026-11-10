import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { KnowledgeChunkIndex, StoreHost, VaultIndex } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  requestUrl: vi.fn(() => { throw Error("Network forbidden"); })
}));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
const original = "# 纯虚构来源\n\n" + "这是保持不变的虚构资料，用于核对来源日期。".repeat(100);
const firstMtime = 1_790_000_000_000, secondMtime = firstMtime + 60_000;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-source-metadata-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const chunks = () => store.readJson<KnowledgeChunkIndex>(store.chunkIndexPath(), { generatedAt: "", chunks: [] });

async function seed(folder: "ideas" | "dailyRoot") {
  const path = store.path(store.settings.folders[folder], "纯虚构日期来源.md");
  const other = store.path(store.settings.folders.ideas, "纯虚构保持来源.md");
  await vault.seed(path, original); await vault.seed(other, "# 纯虚构保持来源\n\n另一份资料保持原样。");
  await utimes(vault.diskPath(path), firstMtime / 1000, firstMtime / 1000);
  await store.syncVaultSources();
  await store.writeJson(store.vectorIndexPath(), { generatedAt: "2026-10-21T00:00:00Z", model: "fixture", entries: [
    { path, title: "纯虚构来源", category: folder === "dailyRoot" ? "daily" : "ideas", mtime: firstMtime, summary: "纯虚构", embedding: [1, 0] }
  ] });
  return { path, other };
}

it.each(["ideas", "dailyRoot"] as const)("synchronizes metadata-only %s changes without invalidating content derivatives", async folder => {
  const { path, other } = await seed(folder), beforeManifest = await store.readSourceManifest();
  const beforeSource = beforeManifest.entries.find(entry => entry.path === path)!;
  const beforeChunks = await chunks(), memory = await vault.bytes(store.memoryIndexPath());
  if (folder === "dailyRoot") expect((await store.readMemoryIndex()).length).toBeGreaterThan(0);
  const vector = await vault.bytes(store.vectorIndexPath()), graph = await vault.bytes(store.knowledgeGraphPath());
  await utimes(vault.diskPath(path), secondMtime / 1000, secondMtime / 1000);
  expect(await store.syncVaultSources()).toEqual({ addedOrChanged: 0, deleted: 0, unchanged: 2 });
  const source = (await store.readSourceManifest()).entries.find(entry => entry.path === path)!;
  const index = await store.readJson<VaultIndex>(store.vaultIndexPath(), { generatedAt: "", vaultName: "", totalMarkdownFiles: 0, indexedFiles: 0, entries: [] });
  const current = await chunks(), actual = current.chunks.filter(chunk => chunk.path === path);
  expect(source.mtime).toBe(secondMtime);
  expect(index.entries.find(entry => entry.path === path)?.mtime).toBe(secondMtime);
  expect(actual).toEqual(beforeChunks.chunks.filter(chunk => chunk.path === path).map(chunk => ({ ...chunk, mtime: secondMtime })));
  expect(source.contentHash).toBe(beforeSource.contentHash); expect(source.chunkIds).toEqual(beforeSource.chunkIds);
  expect(current.chunks.filter(chunk => chunk.path === other)).toEqual(beforeChunks.chunks.filter(chunk => chunk.path === other));
  expect(await vault.bytes(store.vectorIndexPath())).toBe(vector); expect(await vault.bytes(store.memoryIndexPath())).toBe(memory);
  expect(await vault.bytes(store.knowledgeGraphPath())).toBe(graph); expect(await vault.bytes(path)).toBe(original);
});

it("leaves already-current chunks byte-identical on a repeated explicit upsert", async () => {
  const { path } = await seed("ideas"), raw = await vault.bytes(store.chunkIndexPath());
  vault.writes.length = 0;
  expect((await store.upsertVaultSource(path)).changed).toBe(false);
  expect(await vault.bytes(store.chunkIndexPath())).toBe(raw);
  expect(vault.writes.filter(write => write.path === store.chunkIndexPath())).toEqual([]);
});

it("still replaces content chunks and invalidates the old vector on a real content change", async () => {
  const { path } = await seed("ideas"), previous = (await store.readSourceManifest()).entries.find(entry => entry.path === path)!;
  await vault.seed(path, original + "\n\n本次确有新增的虚构内容。\n");
  const changed = await store.upsertVaultSource(path);
  expect(changed.changed).toBe(true);
  const source = (await store.readSourceManifest()).entries.find(entry => entry.path === path)!;
  expect(source.contentHash).not.toBe(previous.contentHash);
  expect((await chunks()).chunks.filter(chunk => chunk.path === path).map(chunk => chunk.text).join("\n")).toContain("本次确有新增");
  expect(JSON.parse(await vault.bytes(store.vectorIndexPath())).entries).toEqual([]);
});
