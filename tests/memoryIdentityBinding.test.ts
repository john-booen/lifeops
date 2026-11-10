import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { createPersonalMemory, type PersonalMemoryRecord } from "../src/personalMemory";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { AgentRuntime } = await import("../src/agentRuntime");
const { runConfirmedToolAction } = await import("../src/toolRegistry");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>, serial = 0;
const normalId = "personal-exact", spacedId = ` ${normalId} `;
const context = () => ({ store, refreshViews: async () => {} });
function reopen() { store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; runtime = new AgentRuntime(context()); }
const review = (memoryId: unknown, decision = "correct") => runtime.executeAiToolCall({ id: `identity-memory-${++serial}`, name: "review_personal_memory", arguments: { memoryId, decision, correctedContent: "纯虚构明确更正" } }, "kimi");
const record = (id: string): PersonalMemoryRecord => createPersonalMemory({ id, kind: "user_rule", content: `纯虚构原规则${id}`, sourceRefs: [] });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-memory-identity-")); vault = new DiskVault(root); reopen(); await store.initializeVault();
  const doc = await store.readPersonalMemories(); doc.records = [normalId, spacedId, "9", "true", "0", "false", "old:memory/片段@一"].map(record); await store.writePersonalMemories(doc);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function assertRefused(memoryId: unknown, decision = "correct") {
  const before = await vault.bytes(store.personalMemoryPath()), result = await review(memoryId, decision);
  expect(result.success, result.output).toBe(false); expect(result.actions).toEqual([]); expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
}
async function undo() {
  const result = await runtime.executeAiToolCall({ id: `memory-identity-undo-${++serial}`, name: "undo_latest_operation", arguments: {} }, "kimi", "请撤销刚才的个人记忆审查");
  expect(result.success, result.output).toBe(true);
}

describe("personal memory tools preserve exact persisted identity", () => {
  it.each(["confirm", "correct", "forget"])("does not trim an absent padded ID into an existing %s target", async decision => {
    await assertRefused(`\t${normalId}\n`, decision);
  });
  it.each([9, true, 0, false, null, undefined, {}, []])("does not coerce non-string ID %j into a saved string ID", async id => {
    await assertRefused(id);
  });
  it.each(["", " ", "\t", "\n"])("refuses a blank ID %j without modifying facts", async id => {
    await assertRefused(id);
  });
  it.each(["confirm", "correct", "forget"])("binds an exact legacy spaced ID to its own %s record, preserving its unspaced neighbor", async decision => {
    const raw = await vault.bytes(store.personalMemoryPath()), before = await store.readPersonalMemories();
    const result = await review(spacedId, decision); expect(result.success, result.output).toBe(true);
    expect(result.actions[0].memoryId).toBe(spacedId); expect(await vault.bytes(store.personalMemoryPath())).toBe(raw);
    await runConfirmedToolAction(result.actions[0], context()); reopen();
    const after = await store.readPersonalMemories(), target = after.records.find(r => r.id === spacedId)!;
    expect(after.records.find(r => r.id === normalId)).toEqual(before.records.find(r => r.id === normalId));
    expect(after.records).toHaveLength(before.records.length);
    if (decision === "forget") { expect(target.status).toBe("forgotten"); expect(target.suppression).toBeDefined(); }
    else { expect(target.status).toBe("active"); expect(target.confirmationReceipt?.memoryId).toBe(spacedId); }
    if (decision === "correct") { expect(target.content).toBe("纯虚构明确更正"); expect(target.revisions[0].content).toBe(before.records.find(r => r.id === spacedId)!.content); }
    await undo(); expect(await vault.bytes(store.personalMemoryPath())).toBe(raw);
    await expect(runConfirmedToolAction(result.actions[0], context())).rejects.toThrow(/撤销|重复/);
  });
  it.each(["9", "true", "0", "false", "old:memory/片段@一"])("keeps valid legacy string ID %j and its correction/undo after reopening", async id => {
    const raw = await vault.bytes(store.personalMemoryPath()), result = await review(id); expect(result.success, result.output).toBe(true); expect(result.actions[0].memoryId).toBe(id);
    await runConfirmedToolAction(result.actions[0], context()); reopen();
    expect((await store.readPersonalMemories()).records.find(r => r.id === id)).toMatchObject({ content: "纯虚构明确更正", status: "active" });
    await undo(); expect(await vault.bytes(store.personalMemoryPath())).toBe(raw);
  });
  it("refuses a missing exact ID without choosing another record or exposing it in the error", async () => {
    const id = "missing-sensitive-identity", raw = await vault.bytes(store.personalMemoryPath()), result = await review(id);
    expect(result.success).toBe(false); expect(result.actions).toEqual([]); expect(result.output).not.toContain(id); expect(await vault.bytes(store.personalMemoryPath())).toBe(raw);
  });
  it("does not reactivate an already forgotten exact record", async () => {
    const forgotten = await review(normalId, "forget"); await runConfirmedToolAction(forgotten.actions[0], context()); reopen(); await assertRefused(normalId, "confirm");
  });
  it("retains stale confirmation protection when the exact target changes after proposal", async () => {
    const old = await review(normalId), other = await review(normalId); await runConfirmedToolAction(other.actions[0], context());
    const raw = await vault.bytes(store.personalMemoryPath()); await expect(runConfirmedToolAction(old.actions[0], context())).rejects.toThrow(/变化|版本/); expect(await vault.bytes(store.personalMemoryPath())).toBe(raw);
  });
  it("keeps source-bound candidates separate from review and preserves exact correction, forgetting, and undo", async () => {
    const path = "Notes/memory-identity-source.md", text = "纯虚构明确规则是晚上不看行情。"; await vault.seed(path, text);
    const read = await runtime.executeAiToolCall({ id: `identity-source-${++serial}`, name: "inspect_note_understanding_source", arguments: { path } }, "kimi"); expect(read.success, read.output).toBe(true);
    const candidate = await runtime.executeAiToolCall({ id: `identity-candidate-${++serial}`, name: "propose_note_understanding", arguments: { path, sourceToken: JSON.parse(read.output).sourceToken, candidates: [{ kind: "user_rule", content: text, excerpt: text }] } }, "kimi");
    expect(candidate.success, candidate.output).toBe(true); await runConfirmedToolAction(candidate.actions[0], context());
    const sourceRecord = (await store.readPersonalMemories()).records.find(r => r.content === text)!; expect(sourceRecord.status).toBe("candidate"); expect(await store.buildPersonalMemoryContext()).not.toContain(text);
    await assertRefused(` ${sourceRecord.id} `);
    const raw = await vault.bytes(store.personalMemoryPath()), confirmation = await review(sourceRecord.id, "confirm"); await runConfirmedToolAction(confirmation.actions[0], context()); reopen(); expect(await store.buildPersonalMemoryContext()).toContain(text);
    const correction = await review(sourceRecord.id); await runConfirmedToolAction(correction.actions[0], context()); reopen(); expect(await store.buildPersonalMemoryContext()).toContain("纯虚构明确更正"); expect(await store.buildPersonalMemoryContext()).not.toContain(text);
    const forgetting = await review(sourceRecord.id, "forget"); await runConfirmedToolAction(forgetting.actions[0], context()); reopen(); expect(await store.buildPersonalMemoryContext()).not.toContain("纯虚构明确更正");
    await undo(); expect(await store.buildPersonalMemoryContext()).toContain("纯虚构明确更正"); await undo(); expect(await store.buildPersonalMemoryContext()).toContain(text); await undo(); expect(await vault.bytes(store.personalMemoryPath())).toBe(raw); expect(await vault.bytes(path)).toBe(text);
  });
});
