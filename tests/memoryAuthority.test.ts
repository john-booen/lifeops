import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import { createPersonalMemory, emptyPersonalMemoryDocument, reviewPersonalMemoryRecord } from "../src/personalMemory";
import { createMemoryCandidate, promoteMemory } from "../src/memoryIndex";
import { AgentRuntime } from "../src/agentRuntime";
import { runConfirmedToolAction } from "../src/toolRegistry";
import { recordConversationMemory } from "../src/memorySystem";
import type { InjectedContext } from "../src/contextInjection";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
const source = { sourceId: "journal:test", path: "日记/test.md", capturedAt: "2026-09-09T00:00:00.000Z" };
const input = { kind: "core_profile" as const, content: "用户喜欢简短回复", sourceRefs: [source] };
function context() { return { store, refreshViews: async () => undefined }; }
async function seedConfirmed() {
  const memory = createPersonalMemory(input);
  const records = reviewPersonalMemoryRecord([memory], memory.id, { decision: "confirm" });
  await vault.seed(store.personalMemoryPath(), JSON.stringify({ ...emptyPersonalMemoryDocument(), records, extension: { keep: true } }));
  return records[0];
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-memory-authority-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; await vault.seed(source.path, input.content); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe("one personal memory authority on actual files", () => {
  it("keeps automatic explicit observations pending until a review", async () => {
    const candidate = await store.upsertPersonalMemory(input);
    expect(candidate.status).toBe("candidate");
    expect(candidate.confirmedAt).toBeUndefined();
    expect(await store.buildPersonalMemoryContext()).toBe("");
    await store.reviewPersonalMemory(candidate.id, { decision: "confirm" });
    expect(await store.buildPersonalMemoryContext()).toContain(input.content);
  });
  it("does not inject old active index entries or Markdown over the canonical fact", async () => {
    await seedConfirmed();
    await store.writeMemoryIndex([promoteMemory(createMemoryCandidate({ content: "用户只喜欢特别长的回复", source: "old", perspective: "owner_trait" }), "core_identity")]);
    await vault.seed(store.memoryFilePath("个人画像.md"), "用户只喜欢特别长的回复");
    const text = await store.buildMemoryContext();
    expect(text).toContain(input.content);
    expect(text).not.toContain("特别长");
    expect(text).toBe(await store.buildPersonalMemoryContext());
  });
  it("writes a confirmed card into the memory used by the next conversation", async () => {
    const runtime = new AgentRuntime(context());
    const proposal = await runtime.executeAiToolCall({ id: "proposal", name: "append_memory_note", arguments: { content: input.content, fileName: "个人画像.md" } }, "kimi");
    expect(proposal.success,proposal.output).toBe(true);
    expect(proposal.actions).toEqual([]);
    const saved = await store.readPersonalMemories();
    expect(saved.records).toHaveLength(1);
    expect(saved.records[0]).toMatchObject({ content: input.content, status: "active" });
    expect(saved.records[0].sourceRefs.some(ref => ref.sourceId === proposal.receipt!.operationId)).toBe(true);
    expect(await store.buildPersonalMemoryContext()).toContain(input.content);
    expect(store.getFile(store.memoryFilePath("个人画像.md"))).toBeNull();
    const writes = vault.writes.length;
    await runtime.executeAiToolCall({ id: "proposal", name: "append_memory_note", arguments: { content: input.content, fileName: "个人画像.md" } }, "kimi");
    expect(vault.writes).toHaveLength(writes);
  });
  it("does not let a background observation replace confirmed content with the same ID", async () => {
    const active = await seedConfirmed();
    await store.upsertPersonalMemory({ ...input, id: active.id, content: "用户喜欢特别长的回复", truth: "inference" });
    const document = await store.readPersonalMemories();
    expect(document.records.find(r => r.id === active.id)).toEqual(JSON.parse(JSON.stringify(active)));
    expect(document.records.filter(r => r.status === "candidate")).toHaveLength(1);
    expect(await store.buildPersonalMemoryContext()).not.toContain("特别长");
  });
  it("preserves unknown root fields when adding a candidate", async () => {
    await seedConfirmed();
    await store.upsertPersonalMemory({ ...input, content: "另一条待确认信息" });
    expect(JSON.parse(await vault.bytes(store.personalMemoryPath())).extension).toEqual({ keep: true });
  });
  it("rejects stale writes after another reviewer changes the record", async () => {
    const active = await seedConfirmed();
    const stale = await store.readPersonalMemories();
    await store.reviewPersonalMemory(active.id, { decision: "correct", content: "用户在语音中偏好简短回复" });
    const before = await vault.bytes(store.personalMemoryPath());
    await expect(store.writePersonalMemories({ ...stale, records: [] })).rejects.toThrow();
    expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
  });
  it("preserves an edit that arrives inside the actual write callback", async () => {
    await seedConfirmed();
    const document = await store.readPersonalMemories();
    const newer = JSON.stringify({ ...document, extraNote: "later edit" });
    vault.beforeProcess = async file => { await vault.seed(file.path, newer); };
    await expect(store.writePersonalMemories({ ...document, records: [] })).rejects.toThrow();
    expect(await vault.bytes(store.personalMemoryPath())).toBe(newer);
  });
  it("allows only one of two writers with the same read revision to commit", async () => {
    await seedConfirmed();
    const left = await store.readPersonalMemories(), right = await store.readPersonalMemories();
    const results = await Promise.allSettled([store.writePersonalMemories({ ...left, left: true }), store.writePersonalMemories({ ...right, right: true })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect((await store.readPersonalMemories()).records[0].content).toBe(input.content);
  });
  it("does not restore a serialized old document without a fresh read", async () => {
    await seedConfirmed();
    const before = await vault.bytes(store.personalMemoryPath());
    await expect(store.writePersonalMemories(JSON.parse(before))).rejects.toThrow();
    expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
  });
  it("merges matching evidence without downgrading confirmation or extending expiry", async () => {
    const active = await seedConfirmed();
    await store.upsertPersonalMemory({ ...input, truth: "inference", confidence: 0.1, expiresAt: "2099-01-01", sourceRefs: [{ ...source, sourceId: "another" }] });
    const saved = (await store.readPersonalMemories()).records[0];
    expect(saved).toMatchObject({ content: active.content, truth: "explicit_fact", confidence: active.confidence, confirmedAt: active.confirmedAt });
    expect(saved.expiresAt).toBeUndefined();
    expect(saved.sourceRefs).toHaveLength(2);
  });
  it("keeps a corrected fact active when the old extracted text reappears", async () => {
    const active = await seedConfirmed();
    await store.reviewPersonalMemory(active.id, { decision: "correct", content: "语音简短，文字可以详细" });
    const observation = await store.upsertPersonalMemory(input);
    expect(observation.status).toBe("active");
    expect((await store.readPersonalMemories()).records.filter(record => record.status === "candidate")).toEqual([]);
    expect(await store.buildMemoryContext()).toContain("语音简短，文字可以详细");
    expect(await store.buildMemoryContext()).not.toContain(input.content);
  });
  it.each(["source-less", "inference", "unconfirmed", "expired"])("excludes an active-looking %s record from answers without rewriting it", async kind => {
    await seedConfirmed();
    const document = JSON.parse(await vault.bytes(store.personalMemoryPath()));
    if (kind === "source-less") document.records[0].sourceRefs = [];
    if (kind === "inference") document.records[0].truth = "inference";
    if (kind === "unconfirmed") delete document.records[0].confirmedAt;
    if (kind === "expired") document.records[0].expiresAt = "2000-01-01";
    const original = JSON.stringify(document);
    await vault.seed(store.personalMemoryPath(), original);
    expect(await store.buildPersonalMemoryContext()).toBe("");
    expect(await vault.bytes(store.personalMemoryPath())).toBe(original);
    expect(vault.writes).toEqual([]);
  });
  it("does not use an active legacy index alone as a fact or source coverage", async () => {
    await store.writeMemoryIndex([promoteMemory(createMemoryCandidate({ content: "用户喜欢长回复", source: "old" }), "core_identity")]);
    expect(await store.buildMemoryContext()).toBe("");
    expect(await store.hasMemoryCoverage("回复")).toBe(false);
  });
  it("keeps automatic conversation summaries separate and extracts only the user's text", async () => {
    const injected = { time: { timeOfDay: "morning" }, taskSummary: { totalActive: 0, overdue: 0, dueToday: 0 }, userState: { consecutiveLateNights: 0 } } as InjectedContext;
    await recordConversationMemory(store, "我喜欢简短回复", "我喜欢详细回复，请记住用户喜欢详细回复", injected);
    const records = (await store.readPersonalMemories()).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ content: "我喜欢简短回复", status: "candidate" });
    expect(await store.buildMemoryContext()).toBe("");
    expect(await vault.bytes(store.memoryFilePath("conversation-memory.jsonl"))).toContain("conversation_summary");
  });
  it("uses the same authority in model context", async () => {
    await store.initializeVault();
    await seedConfirmed();
    await store.writeMemoryIndex([promoteMemory(createMemoryCandidate({ content: "旧索引矛盾内容", source: "old" }), "core_identity")]);
    const text = await store.buildContext("2026-09-09");
    expect(text).toContain(input.content);
    expect(text).not.toContain("旧索引矛盾内容");
  });
  it("excludes old AI memory paths retained in a semantic index", async () => {
    const path = store.memoryFilePath("个人画像.md");
    await vault.seed(path, "旧索引矛盾内容");
    await store.writeJson(store.vectorIndexPath(), { generatedAt: source.capturedAt, model: "test", entries: [{ path, title: "旧记忆", category: "agent-memory", mtime: 1, summary: "old", embedding: [1, 0] }] });
    expect(await store.buildSemanticContext([1, 0])).toBe("");
  });
  it("excludes old AI memory chunks retained in a graph index", async () => {
    await store.writeJson(store.chunkIndexPath(), { generatedAt: source.capturedAt, chunks: [{ id: "old", path: store.memoryFilePath("个人画像.md"), keywords: ["回复"], text: "旧索引矛盾内容", summary: "旧索引矛盾内容", mtime: 1 }] });
    expect(await store.buildKnowledgeGraphContext("回复")).not.toContain("旧索引矛盾内容");
  });
  it("deduplicates two separately confirmed identical facts and supports undo", async () => {
    await seedConfirmed();
    const runtime = new AgentRuntime(context());
    for (const id of ["one", "two"]) {
      const result = await runtime.executeAiToolCall({ id, name: "append_memory_note", arguments: { content: input.content, fileName: "个人画像.md" } }, "kimi");
      expect(result.success,result.output).toBe(true);
      expect((await store.readPersonalMemories()).records).toHaveLength(1);
    }
    const result = await runtime.executeAiToolCall({ id: "three", name: "append_memory_note", arguments: { content: "另一条确认的事实" } }, "kimi");
    expect(result.success,result.output).toBe(true);
    expect((await store.readPersonalMemories()).records).toHaveLength(2);
    await runtime.undoOperation(result.receipt!.operationId);
    expect((await store.readPersonalMemories()).records).toHaveLength(1);
    expect((await store.readPersonalMemories()).extension).toEqual({ keep: true });
  });
  it("rejects duplicate IDs without rewriting or injecting an ambiguous authority", async () => {
    const active = await seedConfirmed();
    const original = JSON.stringify({ ...emptyPersonalMemoryDocument(), records: [active, { ...active, content: "矛盾内容" }] });
    await vault.seed(store.personalMemoryPath(), original);
    await expect(store.buildMemoryContext()).rejects.toThrow();
    expect(await vault.bytes(store.personalMemoryPath())).toBe(original);
  });
});
