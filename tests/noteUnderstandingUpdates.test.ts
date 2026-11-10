import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { createPersonalMemory, reviewPersonalMemoryRecord } from "../src/personalMemory";
import { noteSourceHash, selectedNoteUnderstandingRequest, NOTE_UNDERSTANDING_SOURCE_TOOL } from "../src/noteUnderstandingSource";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), requestUrl: () => { throw Error("No network"); } }));
const { LifeOpsStore } = await import("../src/store"), { DiskVault } = await import("./helpers/diskVault"), { listUnderstandingUpdates, prepareUnderstandingUpdate } = await import("../src/noteUnderstandingUpdates");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, live: boolean;
const path = "Notes/纯虚构原文.md", before = "纯虚构先做一件事。\n", after = before + "纯虚构但紧急事情可以并行。\n";
const context = () => ({ store, refreshViews: async () => {}, assertCurrent: () => { if (!live) throw Error("Fiction host stopped"); } });
async function known(p = path, raw = before, status: "active" | "candidate" = "candidate") {
  const document = await store.readPersonalMemories(), record = createPersonalMemory({ kind: "current_state", content: "纯虚构可能适合逐件尝试", sourceRefs: [{ sourceId: "note:fiction-" + p, path: p, contentHash: noteSourceHash(raw), extractionVersion: "note-understanding-v1", capturedAt: "2026-10-01T00:00:00Z" }] });
  record.status = status; document.records.push(record); await store.writePersonalMemories(document); return record;
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-understanding-updates-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; live = true; await vault.seed(path, before); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
describe("local understanding updates are version notices rather than automatic memory", () => {
  it("checks known paths locally and composes a request without saving or sending", async () => {
    await known(); await vault.seed(path, after); const memory = await vault.bytes(store.personalMemoryPath()), writes = vault.writes.length, result = await listUnderstandingUpdates(context()); expect(result.rows).toHaveLength(1); expect(result.rows[0].status).toBe("needs_review");
    const compose = vi.fn(async (_message: string, current: () => void) => { current(); }); await prepareUnderstandingUpdate(result.rows[0], context(), compose); expect(compose).toHaveBeenCalledTimes(1); expect(selectedNoteUnderstandingRequest(compose.mock.calls[0][0])).toBe(path);
    expect(compose.mock.calls[0][0]).not.toContain("inspect_note_understanding_source"); expect(await vault.bytes(store.personalMemoryPath())).toBe(memory); expect(await vault.bytes(path)).toBe(after); expect(vault.writes).toHaveLength(writes);
  });
  it("shows an already saved current candidate without reviving old active approval", async () => {
    await known(path, before, "active"); await vault.seed(path, after); await known(path, after); const result = await listUnderstandingUpdates(context()); expect(result.rows).toMatchObject([{ path, status: "current_candidate", versions: 2 }]); await expect(prepareUnderstandingUpdate(result.rows[0], context(), vi.fn())).rejects.toThrow(/失效/);
  });
  it("does not read excluded or missing source text", async () => {
    await known(); await known("Notes/missing.md"); store.settings.privacy!.excludedVaultPrefixes = [path]; const read = vi.spyOn(store, "readPath"), result = await listUnderstandingUpdates(context()); expect(result.rows.map(row => row.status).sort()).toEqual(["excluded", "missing"]); expect(read.mock.calls.some(([p]) => [path, "Notes/missing.md"].includes(p))).toBe(false);
  });
  it("does not use forgotten-only references to discover or read a source", async () => {
    const record = await known(), document = await store.readPersonalMemories(); document.records = reviewPersonalMemoryRecord([record], record.id, { decision: "forget" }); await store.writePersonalMemories(document); const read = vi.spyOn(store, "readPath"); expect((await listUnderstandingUpdates(context())).rows).toEqual([]); expect(read.mock.calls.some(([p]) => p === path)).toBe(false);
  });
  it("can explicitly select the active original with no prior memory", async () => { const result = await listUnderstandingUpdates(context(), path); expect(result.rows).toMatchObject([{ path, status: "not_reviewed", versions: 0 }]); const compose = vi.fn(async () => {}); await prepareUnderstandingUpdate(result.rows[0], context(), compose); expect(compose).toHaveBeenCalledTimes(1); });
  it("rejects a stale choice after the source, memory or scope changes", async () => {
    const row = (await listUnderstandingUpdates(context(), path)).rows[0], compose = vi.fn(); await vault.seed(path, after); await expect(prepareUnderstandingUpdate(row, context(), compose)).rejects.toThrow(/更新/);
    const fresh = (await listUnderstandingUpdates(context(), path)).rows[0]; await known(path, after); await expect(prepareUnderstandingUpdate(fresh, context(), compose)).rejects.toThrow(/更新/);
    const next = (await listUnderstandingUpdates(context(), path)).rows[0]; store.settings.privacy!.excludedVaultPrefixes = [path]; await expect(prepareUnderstandingUpdate(next, context(), compose)).rejects.toThrow(); expect(compose).not.toHaveBeenCalled();
  });
  it("blocks altered rows and old choices on a new store", async () => {
    const row = (await listUnderstandingUpdates(context(), path)).rows[0], compose = vi.fn(); await expect(prepareUnderstandingUpdate({ ...row, path: "Notes/other.md" }, context(), compose)).rejects.toThrow(/失效/); const other = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; await expect(prepareUnderstandingUpdate(row, { store: other, refreshViews: async () => {} }, compose)).rejects.toThrow(/失效/);
  });
  it("bounds existing-source scans and reports uninspected paths honestly", async () => {
    const document = await store.readPersonalMemories(); for (let i = 0; i < 35; i++) { const p = `Notes/fiction-${i.toString().padStart(2, "0")}.md`; await vault.seed(p, before); document.records.push(createPersonalMemory({ kind: "episode", content: "纯虚构" + i, sourceRefs: [{ sourceId: "note:" + i, path: p, contentHash: noteSourceHash(before), extractionVersion: "note-understanding-v1", capturedAt: "2026-10-01T00:00:00Z" }] })); } await store.writePersonalMemories(document);
    const result = await listUnderstandingUpdates(context()); expect(result.rows).toHaveLength(32); expect(result.remainingSources).toBe(3); expect(result.rows.every(row => row.status === "current_candidate")).toBe(true);
  });
  it("does not expose an incoming candidate as covered while its fact save is pending", async () => {
    const row = (await listUnderstandingUpdates(context(), path)).rows[0]; let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    const pending = store.runFactOperation!({ operationId: "fiction-pending-note-save" }, async scoped => {
      const document = await scoped.readPersonalMemories(); document.records.push(createPersonalMemory({ kind: "current_state", content: "纯虚构仍待核对的开始阶段", sourceRefs: [{ sourceId: "note:fiction-pending", path, capturedAt: "2026-10-01T00:00:00Z", contentHash: noteSourceHash(before), extractionVersion: "note-understanding-v1" }] }));
      await scoped.writePersonalMemories(document); entered(); await wait;
    }, async () => {});
    try {
      await ready; await expect(listUnderstandingUpdates(context())).rejects.toThrow(/保存尚未结束/);
      const read = await NOTE_UNDERSTANDING_SOURCE_TOOL.execute({ path }, context(), { operationId: "fiction-read-during-save", source: "system" }); expect(read.success).toBe(false); expect(read.output).not.toContain(before.trim());
      const compose = vi.fn(); await expect(prepareUnderstandingUpdate(row, context(), compose)).rejects.toThrow(/保存尚未结束/); expect(compose).not.toHaveBeenCalled();
    } finally { release(); await pending; }
    expect((await listUnderstandingUpdates(context())).rows[0].status).toBe("current_candidate");
  });
});
