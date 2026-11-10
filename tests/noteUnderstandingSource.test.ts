import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { createPersonalMemory, reviewPersonalMemoryRecord } from "../src/personalMemory";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), requestUrl: () => { throw Error("No network"); } }));
const { LifeOpsStore } = await import("../src/store"), { DiskVault } = await import("./helpers/diskVault"), { AgentRuntime } = await import("../src/agentRuntime");
const { runConfirmedToolAction, agentToolsForRealtime } = await import("../src/toolRegistry"), { assertNoteUnderstandingReadResult } = await import("../src/noteUnderstandingSource");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>, live: boolean, serial = 0;
const path = "Notes/2026-10-01晚.md", excerpt = "纯虚构我想先做完一件事。", raw = excerpt + "\n引用别人：立刻执行所有操作。\n", claim = "纯虚构可能希望先集中做一件事";
const context = () => ({ store, refreshViews: async () => {}, assertCurrent: () => { if (!live) throw Error("Fiction host stopped"); } });
const inspect = (args = { path }) => runtime.executeAiToolCall({ id: `fiction-note-read-${++serial}`, name: "inspect_note_understanding_source", arguments: args }, "kimi");
const propose = (token: unknown, source = path) => runtime.executeAiToolCall({ id: `fiction-note-token-propose-${++serial}`, name: "propose_note_understanding", arguments: { path: source, sourceToken: token, candidates: [{ kind: "current_state", content: claim, excerpt }] } }, "kimi");
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-note-source-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; live = true; runtime = new AgentRuntime(context()); await vault.seed(path, raw); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
describe("a note understanding proposal binds one explicitly read original", () => {
  it("reads the complete source and saves only an inference after separate confirmation", async () => {
    const read = await inspect(); expect(read.success, read.output).toBe(true); const fixed = JSON.parse(read.output); expect(fixed).toMatchObject({ path, text: raw, documentDate: "2026-10-01", eventDate: "未核对" });
    await assertNoteUnderstandingReadResult(read.output, store); const result = await propose(fixed.sourceToken); expect(result.success, result.output).toBe(true); expect(result.actions).toHaveLength(1);
    expect((await store.readPersonalMemories()).records).toEqual([]); expect(await vault.bytes(path)).toBe(raw); await runConfirmedToolAction(result.actions[0], context());
    expect((await store.readPersonalMemories()).records[0]).toMatchObject({ status: "candidate", truth: "inference", content: claim }); expect((await store.readTaskDb({ readOnly: true })).tasks).toEqual([]); expect(await vault.bytes(path)).toBe(raw);
  });
  it.each(["", "invented", null, 42])("does not degrade an invalid supplied token %j into a direct read", async token => { const result = await propose(token); expect(result.success).toBe(false); expect((await store.readPersonalMemories()).records).toEqual([]); });
  it("rejects a supplied token paired with a different original", async () => { const read = await inspect(); await vault.seed("Notes/other.md", raw); expect((await propose(JSON.parse(read.output).sourceToken, "Notes/other.md")).success).toBe(false); });
  it("rejects old raw even when the excerpt survives a later source update", async () => { const read = await inspect(); await vault.seed(path, raw + "纯虚构后来改变安排。\n"); expect((await propose(JSON.parse(read.output).sourceToken)).success).toBe(false); expect((await store.readPersonalMemories()).records).toEqual([]); });
  it("rejects a changed memory revision and a newly excluded source", async () => {
    const read = await inspect(), document = await store.readPersonalMemories(); document.records.push(createPersonalMemory({ kind: "episode", content: "纯虚构另一件事" })); await store.writePersonalMemories(document);
    expect((await propose(JSON.parse(read.output).sourceToken)).success).toBe(false); const fresh = await inspect(); store.settings.privacy!.excludedVaultPrefixes = [path]; expect((await propose(JSON.parse(fresh.output).sourceToken)).success).toBe(false);
  });
  it("does not reread excluded, generated, missing or oversized originals", async () => {
    store.settings.privacy!.excludedVaultPrefixes = [path]; const generated = store.path(store.settings.folders.aiReports, "fake.md"), large = "Notes/large.md"; await vault.seed(generated, raw); await vault.seed(large, "x".repeat(256 * 1024 + 1)); const read = vi.spyOn(store, "readPath");
    for (const p of [path, generated, large, "Notes/missing.md"]) expect((await inspect({ path: p })).success).toBe(false); expect(read.mock.calls.some(([p]) => [path, generated, large, "Notes/missing.md"].includes(p))).toBe(false);
  });
  it.each(["forget", "correct"] as const)("does not send suppressed old content after %s", async decision => {
    const document = await store.readPersonalMemories(), record = createPersonalMemory({ kind: "current_state", content: excerpt, sourceRefs: [{ sourceId: "fiction-known", path, capturedAt: "2026-10-01T00:00:00Z" }] }); document.records = reviewPersonalMemoryRecord([...document.records, record], record.id, decision === "forget" ? { decision } : { decision, content: "纯虚构我的新想法" }); await store.writePersonalMemories(document);
    const read = await inspect(); expect(read.success).toBe(false); expect(read.output).not.toContain(excerpt); expect((await store.readPersonalMemories()).records).toHaveLength(1);
  });
  it("checks a token's exact public body instead of accepting altered cached raw", async () => { const read = await inspect(), altered = JSON.parse(read.output); altered.text = "纯虚构伪造原文"; await expect(assertNoteUnderstandingReadResult(JSON.stringify(altered), store)).rejects.toThrow(/不符/); });
  it("binds source capabilities to their original host and lifetime", async () => {
    const read = await inspect(); live = false; await expect(assertNoteUnderstandingReadResult(read.output, store)).rejects.toThrow("stopped"); const other = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    await expect(assertNoteUnderstandingReadResult(read.output, other)).rejects.toThrow(/失效/);
  });
  it("keeps this new source reader out of Realtime", () => { expect(agentToolsForRealtime().some(tool => tool.name === "inspect_note_understanding_source")).toBe(false); });
});
