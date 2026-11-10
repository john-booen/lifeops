import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentRuntime } from "../src/agentRuntime";
import { runConfirmedToolAction } from "../src/toolRegistry";
import type { StoreHost } from "../src/store/settingsSlice";
import { createPersonalMemory, reviewPersonalMemoryRecord } from "../src/personalMemory";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: AgentRuntime;
const content = "I prefer concise replies";
const input = { kind: "core_profile" as const, content, sourceRefs: [{ sourceId: "original", path: "source.md", capturedAt: "2026-09-09T10:00:00Z" }] };
const context = () => ({ store, refreshViews: async () => undefined });
async function confirmed() { const proposal = await runtime.executeAiToolCall({ id: "remember", name: "append_memory_note", arguments: { content, fileName: "个人画像.md" } }, "kimi"); expect(proposal.success,proposal.output).toBe(true); return (await store.readPersonalMemories()).records[0].id; }
async function review(id: string, decision: "correct" | "forget", correctedContent?: string) { const proposal = await runtime.executeAiToolCall({ id: `review:${decision}`, name: "review_personal_memory", arguments: { memoryId: id, decision, correctedContent } }, "kimi"); await runConfirmedToolAction(proposal.actions[0], context()); }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-memory-suppression-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; runtime = new AgentRuntime(context()); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe("memory suppression across later observations", () => {
  it("removes old conversation text after correction and forgetting", async () => {
    await store.initializeVault();
    await store.appendAgentConversation(content, `Remembered: ${content}`);
    const id = await confirmed();
    await review(id, "correct", "I prefer detailed replies for research");
    let text = await store.buildContext("2026-09-16");
    expect(text).not.toContain(content);
    expect(text).toContain("I prefer detailed replies for research");
    await review(id, "forget");
    store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    text = await store.buildContext("2026-09-16");
    expect(text).not.toContain(content);
    expect(text).not.toContain("I prefer detailed replies for research");
    const originalConversation = await vault.bytes(store.path(store.settings.folders.aiReports, "Conversations", new Date().toLocaleDateString("sv-SE") + ".md"));
    expect(originalConversation).toContain(content);
  });
  it("records the user's correction as its own durable confirmation source", async () => {
    const id = await confirmed();
    await review(id, "correct", "I prefer detailed replies for research");
    const record = (await store.readPersonalMemories()).records.find(r => r.id === id)!;
    expect(record.sourceRefs.filter(ref => ref.sourceId.startsWith("confirmed:"))).toHaveLength(2);
    expect(record.sourceRefs.every(ref => ref.path.endsWith("operation-ledger.json"))).toBe(true);
  });
  it("keeps tombstones intact when an old extractor reuses a forgotten ID", async () => {
    const id = await confirmed(); await review(id, "forget");
    const tombstone = (await store.readPersonalMemories()).records.find(r => r.id === id);
    await store.upsertPersonalMemory({ ...input, id, content: "a distinct new observation" });
    expect((await store.readPersonalMemories()).records.find(r => r.id === id)).toEqual(tombstone);
    await store.upsertPersonalMemory({ ...input, id: "old-source-replayed" });
    expect((await store.readPersonalMemories()).records.filter(r => r.status === "candidate").map(r => r.content)).toEqual(["a distinct new observation"]);
  });
  it("retires duplicate active facts atomically and restores the whole correction on undo", async () => {
    const id = await confirmed();
    const duplicate = createPersonalMemory({ ...input, id: "duplicate", kind: "user_rule" });
    const document = await store.readPersonalMemories();
    await store.writePersonalMemories({ ...document, records: [...document.records, ...reviewPersonalMemoryRecord([duplicate], duplicate.id, { decision: "confirm" })] });
    await review(id, "correct", "I prefer detailed replies for research");
    store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    expect(await store.buildPersonalMemoryContext()).not.toContain(content);
    expect((await store.readPersonalMemories()).records.find(r => r.id === "duplicate")?.status).toBe("forgotten");
    await new AgentRuntime(context()).undoLatestOperation();
    expect((await store.readPersonalMemories()).records.filter(r => r.status === "active")).toHaveLength(2);
    expect(await store.buildPersonalMemoryContext()).toContain(content);
  });
  it.each([null, { content: null, changedAt: "2026-09-16", reason: "corrected" }, { content: "old", changedAt: "invalid", reason: "corrected" }, { content: "old", changedAt: "2026-09-16", reason: "future" }])("preserves malformed revision history instead of overwriting it: %j", async revision => {
    await confirmed();
    const document = JSON.parse(await vault.bytes(store.personalMemoryPath()));
    document.records[0].revisions = [revision];
    const raw = JSON.stringify(document); await vault.seed(store.personalMemoryPath(), raw);
    await expect(store.upsertPersonalMemory(input)).rejects.toThrow();
    expect(await vault.bytes(store.personalMemoryPath())).toBe(raw);
  });
  it("retains only a suppression marker in canonical memory and supports explicit undo", async () => {
    const id = await confirmed(); await review(id, "forget");
    const raw = await vault.bytes(store.personalMemoryPath());
    expect(raw).not.toContain(content);
    expect(JSON.parse(raw).records[0]).toMatchObject({ status: "forgotten", sourceRefs: [], revisions: [], suppression: { version: 1 } });
    await runtime.undoLatestOperation();
    expect(await store.buildPersonalMemoryContext()).toContain(content);
  });
  it.each(["future", "missing_hash"])("preserves %s suppression metadata without silently rebuilding", async mode => {
    const id = await confirmed(); await review(id, "forget");
    const document = JSON.parse(await vault.bytes(store.personalMemoryPath()));
    if (mode === "future") document.records[0].suppression.version = 2;
    else document.records[0].suppression.contentHashes = [];
    const raw = JSON.stringify(document); await vault.seed(store.personalMemoryPath(), raw);
    await expect(store.upsertPersonalMemory(input)).rejects.toThrow();
    expect(await vault.bytes(store.personalMemoryPath())).toBe(raw);
  });
  it("does not regenerate a forgotten fact after a new Store reads the same old source", async () => {
    const id = await confirmed(); await review(id, "forget");
    store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    await store.upsertPersonalMemory(input);
    expect((await store.readPersonalMemories()).records.filter(r => r.status === "candidate" || r.status === "active")).toEqual([]);
    expect(await store.buildPersonalMemoryContext()).not.toContain(content);
  });
  it("blocks the same forgotten content with a different ID and classification", async () => {
    const id = await confirmed(); await review(id, "forget");
    await store.upsertPersonalMemory({ ...input, id: "new-id", kind: "user_rule", content: "I  prefer concise replies" });
    expect((await store.readPersonalMemories()).records.filter(r => r.status === "candidate" || r.status === "active")).toEqual([]);
  });
  it("does not propose an old corrected value again when reprocessing its original ID", async () => {
    const id = await confirmed(); await review(id, "correct", "I prefer detailed replies for research");
    await store.upsertPersonalMemory({ ...input, id });
    const records = (await store.readPersonalMemories()).records;
    expect(records.filter(r => r.status === "candidate")).toEqual([]);
    expect(await store.buildPersonalMemoryContext()).toContain("detailed replies");
    expect(await store.buildPersonalMemoryContext()).not.toContain(content);
  });
  it("does not let a new ordinary confirmation silently reactivate forgotten content", async () => {
    const id = await confirmed(); await review(id, "forget");
    const before = await vault.bytes(store.personalMemoryPath());
    const proposal = await runtime.executeAiToolCall({ id: "remember-again", name: "append_memory_note", arguments: { content, fileName: "个人画像.md" } }, "kimi");
    await expect(runConfirmedToolAction(proposal.actions[0], context())).rejects.toThrow();
    expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
  });
});
