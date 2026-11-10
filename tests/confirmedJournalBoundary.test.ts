import { activityNotePath } from "../src/activityRecords";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentRuntime } from "../src/agentRuntime";
import { OperationLedger } from "../src/dataFoundation/operationLedger";
import { runConfirmedToolAction } from "../src/toolRegistry";
import type { AgentActionSuggestion } from "../src/types";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: AgentRuntime;
function action(type: "append_daily_note" | "record_done" = "append_daily_note"): AgentActionSuggestion {
  return { id: `journal-${type}`, type, title: "确认写入", description: "用户确认", content: "整理项目资料", date: "2026-09-08" };
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-confirmed-journal-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; runtime = new AgentRuntime({ store, refreshViews: async () => undefined }); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe("legacy journal cards through the real runtime", () => {
  it.each(["append_daily_note", "record_done"] as const)("preserves date and section for %s, reads back and deduplicates", async type => {
    const card = action(type), journalPath = store.dailyNotePath(card.date, "早");
    const path = type === "record_done" ? activityNotePath(store, "tasks", card.date) : journalPath;
    await vault.seed(path, "# 已有日记\n\n原有正文必须保留。\n");
    expect(vault.writes).toEqual([]);
    expect((await runtime.executeConfirmedJournalSuggestion(card))?.success).toBe(true);
    const saved = await vault.bytes(path);
    expect(saved).toContain("原有正文必须保留。");
    if (type === "record_done") expect(saved).toContain("## 口述完成（未关联任务）");
    else expect(saved).not.toContain("## 日记");
    expect(saved).toContain("整理项目资料");
    const writes = vault.writes.length;
    expect((await runtime.executeConfirmedJournalSuggestion(card))?.success).toBe(true);
    expect(vault.writes).toHaveLength(writes);
    expect(await new OperationLedger(store).latestReversible()).toMatchObject({ operationId: `confirmed:${card.id}`, status: "verified" });
  });
  it("rejects reused IDs with different content", async () => {
    const card = action();
    await runtime.executeConfirmedJournalSuggestion(card);
    const before = await vault.bytes(store.dailyNotePath(card.date, "早"));
    expect((await runtime.executeConfirmedJournalSuggestion({ ...card, content: "被换掉的内容" }))?.success).toBe(false);
    expect(await vault.bytes(store.dailyNotePath(card.date, "早"))).toBe(before);
  });
  it("returns control for unrelated suggestions without writing", async () => {
    expect(await runtime.executeConfirmedJournalSuggestion({ ...action(), type: "record_idea" })).toBeNull();
    expect(vault.writes).toEqual([]);
  });
  it("can undo a newly created journal without leaving a phantom note", async () => {
    const card = action();
    await runtime.executeConfirmedJournalSuggestion(card);
    await runtime.undoOperation(`confirmed:${card.id}`);
    expect(store.getFile(store.dailyNotePath(card.date, "早"))).toBeNull();
  });
});

describe("remaining confirmed capture cards", () => {
  it("rejects a delete card if the task changed after it was shown", async () => {
    const task = await store.createTask({ title: "原任务", date: "2026-09-09" });
    const proposal = await runtime.executeAiToolCall({ id: "delete", name: "delete_task", arguments: { taskIdOrTitle: task.id } }, "kimi");
    await store.updateTaskDetails(task.id, { title: "后来修改的任务" });
    const before = await vault.bytes(store.taskDbPath());
    await expect(runConfirmedToolAction(proposal.actions[0], { store, refreshViews: async () => undefined })).rejects.toThrow("确认卡");
    expect(await vault.bytes(store.taskDbPath())).toBe(before);
  });
  it("rejects a delete card if the habit definition changed after it was shown", async () => {
    const habit = await store.createHabit({ name: "跑步", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    const { actions: cards } = await runtime.executeAiToolCall({ name: "delete_habit", arguments: { name: habit.name } }, "kimi");
    expect(cards).toHaveLength(1);
    await store.updateHabitDetails(habit.id, { name: "轻松散步", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    const before = await vault.bytes(store.habitDbPath());
    await expect(runConfirmedToolAction(cards[0], { store, refreshViews: async () => undefined })).rejects.toThrow("确认卡");
    expect(await vault.bytes(store.habitDbPath())).toBe(before);
  });
  it("rejects a memory review card if another review changed its target", async () => {
    const candidate = await store.upsertPersonalMemory({ kind: "core_profile", content: "原候选", sourceRefs: [{ sourceId: "test", path: "日记/test.md", capturedAt: new Date().toISOString() }] });
    const proposal = await runtime.executeAiToolCall({ id: "review", name: "review_personal_memory", arguments: { memoryId: candidate.id, decision: "confirm" } }, "kimi");
    await store.reviewPersonalMemory(candidate.id, { decision: "correct", content: "用户后来纠正的内容" });
    const before = await vault.bytes(store.personalMemoryPath());
    await expect(runConfirmedToolAction(proposal.actions[0], { store, refreshViews: async () => undefined })).rejects.toThrow("确认卡");
    expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
  });
  it.each(["record_idea", "record_health", "record_trade", "record_habit", "send_to_inbox"] as const)("records, verifies, deduplicates and undoes %s", async type => {
    await store.initializeVault();
    if (type === "record_habit") await store.createHabit({ name: "散步", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    const card: AgentActionSuggestion = { ...action(), id: type, type, title: "测试资料", content: type === "record_habit" ? "散步" : "保留这段用户记录", date: "2026-09-09" };
    const before = new Map<string, string>();
    for (const file of vault.getMarkdownFiles()) before.set(file.path, await vault.bytes(file.path));
    const result = await runtime.executeConfirmedCaptureSuggestion(card);
    expect(result?.success).toBe(true);
    const audit = await new OperationLedger(store).latestReversible();
    expect(audit).toMatchObject({ operationId: `confirmed:${type}`, status: "verified", result: { undo: { kind: "restore_guarded_files" } } });
    const undo = audit!.result!.undo!;
    if (undo.kind !== "restore_guarded_files") throw new Error("Missing complete undo");
    expect(undo.files.length).toBeGreaterThan(0);
    expect(undo.files.some(file => file.after?.includes(card.content))).toBe(true);
    const writes = vault.writes.length;
    expect((await runtime.executeConfirmedCaptureSuggestion(card))?.success).toBe(true);
    expect(vault.writes).toHaveLength(writes);
    await runtime.undoOperation(`confirmed:${type}`);
    for (const file of undo.files) {
      if (file.before === null) expect(store.getFile(file.path)).toBeNull();
      else expect(await vault.bytes(file.path)).toBe(file.before);
    }
    for (const [path, text] of before) expect(await vault.bytes(path)).toBe(text);
  });
  it("does not report successful habit recording when no such habit exists", async () => {
    const card: AgentActionSuggestion = { ...action(), type: "record_habit", content: "不存在的习惯" };
    const result = await runtime.executeConfirmedCaptureSuggestion(card);
    expect(result?.success).toBe(false);
    expect(result?.output).toContain("没有找到");
    expect(store.getFile(store.habitDbPath())).toBeNull();
  });
});

describe("initialization preserves user-owned memory materials", () => {
  it.each(["个人画像.md", "当前状态.md", "长期目标.md", "管家规则.md", "交易纪律.md"])("never appends defaults to an existing %s", async name => {
    const path = store.memoryFilePath(name), original = "# 我的内容\r\n\r\n我亲自写下的规则和想法。\r\n";
    await vault.seed(path, original);
    await store.initializeVault();
    expect(await vault.bytes(path)).toBe(original);
    expect(vault.writes.filter(write => write.path === path)).toEqual([]);
  });
  it("creates empty memory structure and does not invent user facts on first startup", async () => {
    await store.initializeVault();
    expect((await store.readPersonalMemories()).records).toEqual([]);
    expect(await vault.bytes(store.memoryFilePath("当前状态.md"))).toContain("暂无用户记录");
    expect(await vault.bytes(store.memoryFilePath("管家规则.md"))).not.toContain("OpenAI");
    const writes = vault.writes.length;
    await store.initializeVault();
    expect(vault.writes).toHaveLength(writes);
  });
});
