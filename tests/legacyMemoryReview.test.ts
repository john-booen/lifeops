import { mkdtemp, rm, chmod, symlink, writeFile, utimes } from "node:fs/promises";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { createPersonalMemory, emptyPersonalMemoryDocument, reviewPersonalMemoryRecord } from "../src/personalMemory";
import { captureLegacyMemoryReview } from "../src/legacyMemoryReview";
import { AgentRuntime } from "../src/agentRuntime";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: vi.fn(() => { throw Error("Network forbidden"); })
}));
const { default: Plugin } = await import("../src/main"), { LifeOpsStore } = await import("../src/store"), { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: any, refresh: () => Promise<void>;
const captures: Awaited<ReturnType<typeof captureLegacyMemoryReview>>[] = [];
const date = "2026-10-25T00:00:00.000Z", oldText = "纯虚构旧偏好", indexText = JSON.stringify([{ id: "legacy-1", status: "active", content: oldText }]);
const personal = () => createPersonalMemory({ kind: "core_profile", content: oldText, sourceRefs: [{ sourceId: "fixture", path: "原文/虚构.md", capturedAt: date }] }, date);
const authority = (records: ReturnType<typeof personal>[]) => JSON.stringify({ ...emptyPersonalMemoryDocument(date), records }, null, 2) + "\n";
const workflowFiles = () => vault.getMarkdownFiles().filter(f => f.path.startsWith(store.path(store.settings.folders.aiReports, "Workflows") + "/"));
beforeEach(async () => {
  vi.stubGlobal("window", globalThis); root = await mkdtemp(join(tmpdir(), "lifeops-legacy-preview-")); vault = new DiskVault(root);
  Object.assign(vault, { adapter: { getBasePath: () => root } });
  const app = { vault, workspace: { getLeavesOfType: () => [], openLinkText: vi.fn(async () => {}) } } as any;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; await store.initializeVault();
  await vault.seed(store.memoryIndexPath(), indexText);
  await vault.seed(store.path(store.settings.folders.aiReports, "Memory", "conversation-memory.jsonl"), JSON.stringify({ type: "conversation_summary", userStatement: oldText, assistantResponse: "ASSISTANT-DO-NOT-SHOW", content: "SUMMARY-DO-NOT-SHOW" }));
  refresh = async () => {};
  plugin = Object.assign(Object.create(Plugin.prototype), { app, store, settings: store.settings, lifecycleGeneration: 1, unloaded: false,
    createAgentRuntime: () => new AgentRuntime({ store, refreshViews: () => refresh() }) });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
async function capture(owner?: () => boolean) { const cap = await captureLegacyMemoryReview(store, owner); captures.push(cap); return cap; }
async function save(cap: Awaited<ReturnType<typeof capture>>) {
  let path = "";
  const result = await new AgentRuntime({ store, refreshViews: async () => {} }).executeLocalOperation("generate_memory_review", {}, async scoped => {
    await cap.assertBeforeCommit(); cap.assertScoped(scoped); path = await scoped.writeWorkflowDraft("personal-memory-review", cap.markdown);
  }, undefined, { assertCurrent: cap.assertCurrent, assertBeforeCommit: cap.assertBeforeCommit });
  return { result, path };
}
it("wires the original manual command through actual Runtime and publishes only a literal readonly preview", async () => {
  const before = await Promise.all([store.taskDbPath(), store.habitDbPath(), store.personalMemoryPath(), store.memoryIndexPath()].map(path => vault.bytes(path)));
  const ordinary = vi.spyOn(store, "writePersonalMemoryReview").mockRejectedValue(Error("ordinary review must not be called by opt-in"));
  await plugin.openPersonalMemoryReview();
  expect(ordinary).not.toHaveBeenCalled(); expect(plugin.app.workspace.openLinkText).toHaveBeenCalledTimes(1);
  const files = workflowFiles(); expect(files).toHaveLength(1); const raw = await vault.bytes(files[0].path);
  expect(raw).toContain("旧记忆迁移预览"); expect(raw).toContain(oldText); expect(raw).toContain("重复 1");
  expect(raw).not.toMatch(/ASSISTANT-DO-NOT-SHOW|SUMMARY-DO-NOT-SHOW/);
  expect(await Promise.all([store.taskDbPath(), store.habitDbPath(), store.personalMemoryPath(), store.memoryIndexPath()].map(path => vault.bytes(path)))).toEqual(before);
});
it("keeps the ordinary no-argument review from reading malformed, oversized or excluded legacy sources", async () => {
  await vault.seed(store.memoryIndexPath(), "{broken legacy"); store.settings.privacy = { excludedVaultPrefixes: [store.settings.folders.aiReports + "/Memory/memory-index.json"] };
  const original = store.readPath.bind(store), reads: string[] = [];
  vi.spyOn(store, "readPath").mockImplementation(async path => { reads.push(path); if (path === store.memoryIndexPath()) throw Error("legacy read forbidden"); return original(path); });
  const path = await store.writePersonalMemoryReview();
  expect(reads).not.toContain(store.memoryIndexPath()); expect(await vault.bytes(path)).not.toContain("旧记忆迁移预览");
});
it("shows unknown legacy JSON as a no-body status without changing the authority or aborting manual review", async () => {
  await vault.seed(store.memoryIndexPath(), JSON.stringify({ version: 999, entries: [{ content: "UNKNOWN-SCHEMA-SECRET" }] }));
  const cap = await capture(); expect(cap.markdown).toContain("unsupported"); expect(cap.markdown).not.toContain("UNKNOWN-SCHEMA-SECRET");
  expect((await save(cap)).result.success).toBe(true);
});
it("uses the current authority suppression before presenting older source material", async () => {
  const m = personal(), records = reviewPersonalMemoryRecord([m], m.id, { decision: "forget" }, date);
  await vault.seed(store.personalMemoryPath(), authority(records));
  const cap = await capture(); expect(cap.markdown).toContain("正文保持隐藏"); expect(cap.markdown).not.toContain(oldText);
});
it.each(["source", "authority", "permission", "owner", "missing-created"])("rejects %s changes before saving the review", async scene => {
  if (scene === "missing-created") await rm(vault.diskPath(store.memoryFilePath("个人画像.md")));
  let current = true; const cap = await capture(() => current);
  if (scene === "source") await vault.seed(store.memoryIndexPath(), indexText + " ");
  if (scene === "authority") await vault.seed(store.personalMemoryPath(), authority([personal()]));
  if (scene === "permission") store.settings.privacy = { excludedVaultPrefixes: [store.settings.folders.aiReports] };
  if (scene === "owner") current = false;
  if (scene === "missing-created") await vault.seed(store.memoryFilePath("个人画像.md"), "# later user edit");
  if (scene === "permission" || scene === "owner") await expect(save(cap)).rejects.toThrow(/变化/);
  else expect((await save(cap)).result.success).toBe(false);
  expect(workflowFiles()).toEqual([]);
});
it.each(["source", "forget"])("rolls back an unpublished Workflow when %s changes during the actual protected create, preserving later source edits", async scene => {
  const cap = await capture(), create = vault.create.bind(vault); let changed = "";
  vi.spyOn(vault, "create").mockImplementation(async (path, content) => {
    const file = await create(path, content);
    if (path.includes("/Workflows/") && !changed) {
      changed = scene === "source" ? "LATER-SOURCE-CONTENT" : authority(reviewPersonalMemoryRecord([personal()], personal().id, { decision: "forget" }, date));
      await vault.seed(scene === "source" ? store.memoryIndexPath() : store.personalMemoryPath(), changed);
    }
    return file;
  });
  const { result } = await save(cap); expect(result.success).toBe(false); expect(workflowFiles()).toEqual([]);
  expect(await vault.bytes(scene === "source" ? store.memoryIndexPath() : store.personalMemoryPath())).toBe(changed);
  // Recovery after-images/Retained remain governed by the original Runtime.
  // This asserts no successful Workflow publication, not physical erasure.
});
it("rejects mutable scoped destination/permission changes without writing into another business folder", async () => {
  const cap = await capture(), before = await vault.bytes(store.taskDbPath());
  const result = await new AgentRuntime({ store, refreshViews: async () => {} }).executeLocalOperation("generate_memory_review", {}, async scoped => {
    scoped.settings.folders.aiReports = scoped.settings.folders.tasks;
    cap.assertScoped(scoped); await scoped.writeWorkflowDraft("wrong-location", cap.markdown);
  }, undefined, { assertCurrent: cap.assertCurrent, assertBeforeCommit: cap.assertBeforeCommit });
  expect(result.success).toBe(false); expect(await vault.bytes(store.taskDbPath())).toBe(before); expect(workflowFiles()).toEqual([]);
  expect(vault.getMarkdownFiles().some(f => f.path.includes("wrong-location"))).toBe(false);
});
it("does not open a legitimately committed snapshot if owner or permission changes while refresh is awaited", async () => {
  refresh = async () => { store.settings.privacy = { excludedVaultPrefixes: [store.settings.folders.aiReports] }; };
  await expect(plugin.openPersonalMemoryReview()).rejects.toThrow(/变化/);
  expect(plugin.app.workspace.openLinkText).not.toHaveBeenCalled(); expect(workflowFiles()).toHaveLength(1);
});
it("detects same-size rewrites before saving even when the mtime is restored", async () => {
  const cap = await capture(), path = vault.diskPath(store.memoryIndexPath()), before = statSync(path);
  await writeFile(path, indexText.replace("legacy-1", "legacy-2")); await utimes(path, before.atime, before.mtime);
  await expect(cap.assertBeforeCommit()).rejects.toThrow(/变化/);
});
it("does not traverse a symlink to read legacy text", async () => {
  const path = store.memoryFilePath("个人画像.md"), target = join(root, "synthetic-other.md");
  await rm(vault.diskPath(path)); await writeFile(target, "SYMLINK-BODY-MUST-NOT-APPEAR"); await symlink(target, vault.diskPath(path));
  const cap = await capture(); expect(cap.markdown).not.toContain("SYMLINK-BODY-MUST-NOT-APPEAR"); expect(cap.markdown).toContain("unreadable");
});
it("rejects unsafe configured roots before reading or writing any preview", async () => {
  store.settings.folders.aiReports = "../outside";
  await expect(capture()).rejects.toThrow(/变化/); expect(workflowFiles()).toEqual([]);
});
it("requires the protected transaction capability instead of a lightweight fallback store", async () => {
  Object.defineProperty(store, "runFactOperation", { value: undefined, configurable: true });
  await expect(capture()).rejects.toThrow(/变化/); expect(workflowFiles()).toEqual([]);
});
