import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../src/agentRuntime";
import { activityNotePath } from "../src/activityRecords";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import type { ClassifiedInput } from "../src/types";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: AgentRuntime;
const date = "2026-09-23", original = "# 2026-09-23早\r\n\r\n今天的经历和感受，保留每一个字。\r\n";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-domain-records-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
  await vault.seed(store.dailyNotePath(date, "早"), original);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("business records stay outside the personal journal", () => {
  it.each(["todo", "done", "habit", "idea", "trade", "health"] as const)("saves and undoes %s without changing an existing journal", async kind => {
    if (kind === "habit") await store.createHabit({ name: "散步", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    const input: ClassifiedInput = { kind, date, content: kind === "habit" ? "散步" : "保留领域记录", raw: "原话", title: "测试记录", source: "test", confidence: 1, reason: "明确记录" };
    const result = await runtime.executeLocalOperation("capture", { input }, scope => scope.recordClassifiedInput(input), `capture-${kind}`);
    expect(result.success, result.output).toBe(true);
    expect(await vault.bytes(store.dailyNotePath(date, "早"))).toBe(original);
    expect(store.getFile(store.dailyNotePath(date, "晚"))).toBeNull();
    const otherContent = await Promise.all(vault.getMarkdownFiles().filter(f => !f.path.startsWith(store.settings.folders.dailyRoot + "/")).map(f => vault.bytes(f.path)));
    expect(otherContent.join("\n")).toContain(kind === "trade" ? input.raw : input.content);
    await runtime.undoOperation(`capture-${kind}`);
    expect(await vault.bytes(store.dailyNotePath(date, "早"))).toBe(original);
  });

  it("completes a real task without adding a daily section and preserves authoritative counts", async () => {
    const task = await store.createTask({ title: "发送资料", date });
    expect((await runtime.executeLocalOperation("complete", { id: task.id }, scope => scope.completeTaskAndLog(task.id, date), "complete-task")).success).toBe(true);
    expect(await vault.bytes(activityNotePath(store, "tasks", date))).toContain("发送资料");
    expect(await vault.bytes(store.dailyNotePath(date, "早"))).toBe(original);
    expect((await store.readTaskDb()).tasks[0].status).toBe("completed");
    await runtime.undoOperation("complete-task");
    expect((await store.readTaskDb()).tasks[0].status).toBe("active");
    expect(store.getFile(activityNotePath(store, "tasks", date))).toBeNull();
  });

  it.each(["append_knowledge_note", "append_trading_model_note"])("keeps %s links in its domain and can undo both files", async toolName => {
    const result = await runtime.executeToolCall({ toolName, arguments: { date, content: "知识和规则内容" }, source: "system", confirmedByUser: true, callId: toolName });
    expect(result.success, result.output).toBe(true);
    const path = activityNotePath(store, toolName === "append_knowledge_note" ? "ideas" : "tradingModels", date);
    expect(await vault.bytes(path)).toContain("[[");
    expect(await vault.bytes(store.dailyNotePath(date, "早"))).toBe(original);
    await runtime.undoOperation(toolName);
    expect(store.getFile(path)).toBeNull();
    expect(await vault.bytes(store.dailyNotePath(date, "早"))).toBe(original);
  });

  it("appends explicit journal prose without adding empty sections or turning paragraphs into a list", async () => {
    const content = "第一段经历。\n\n第二段感受。";
    const result = await runtime.executeToolCall({ toolName: "append_journal_entry", arguments: { date, period: "晚", content }, source: "system", confirmedByUser: true, callId: "prose" });
    expect(result.success, result.output).toBe(true);
    const saved = await vault.bytes(store.dailyNotePath(date, "晚"));
    expect(saved).toContain(`# ${date}晚\n\n${content}`);
    expect(saved).not.toContain("##");
    expect(saved).not.toContain("- 第一段");
    await runtime.undoOperation("prose");
    expect(store.getFile(store.dailyNotePath(date, "晚"))).toBeNull();
  });

  it("deduplicates spoken completion, includes it in next-day context, and protects later edits on undo", async () => {
    const card = { id: "spoken-done", type: "record_done" as const, title: "口述完成", description: "用户确认", content: "已经整理好资料", date };
    expect((await runtime.executeConfirmedJournalSuggestion(card))?.success).toBe(true);
    const path = activityNotePath(store, "tasks", date), saved = await vault.bytes(path);
    const writes = vault.writes.length;
    expect((await runtime.executeConfirmedJournalSuggestion(card))?.success).toBe(true);
    expect(vault.writes).toHaveLength(writes);
    expect((await store.readTaskDb()).tasks).toHaveLength(0);
    expect(await store.buildTaskContext("2026-09-24")).toContain("已经整理好资料");
    expect(await store.buildTaskContext("2026-09-24")).toContain("不代表任务数据库已完成");
    await vault.modify(store.getFile(path)!, `${saved}\n我后来补充的事实。`);
    await expect(runtime.undoOperation("confirmed:spoken-done")).rejects.toThrow("变化");
    expect(await vault.bytes(path)).toContain("我后来补充的事实。");
    expect(await vault.bytes(store.dailyNotePath(date, "早"))).toBe(original);
  });

  it("undoes spoken completion while retaining the user's existing journal", async () => {
    const card = { id: "undo-spoken", type: "record_done" as const, title: "完成", description: "明确记录", content: "记录完成", date };
    await runtime.executeConfirmedJournalSuggestion(card);
    await runtime.undoOperation("confirmed:undo-spoken");
    expect(store.getFile(activityNotePath(store, "tasks", date))).toBeNull();
    expect(await vault.bytes(store.dailyNotePath(date, "早"))).toBe(original);
  });
});
