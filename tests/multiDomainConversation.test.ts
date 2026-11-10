import { stubAgentModel } from "./helpers/stubAgentModel";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { App } from "obsidian";
import type { AiToolCall } from "../src/ai";
import type { AgentResponse } from "../src/types";
import type { StoreHost } from "../src/store/settingsSlice";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { todayString, addDays } from "../src/date";
vi.mock("obsidian", () => ({ App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: () => { throw Error("Offline fictional evaluation"); } }));
const { LifeOpsStore } = await import("../src/store");
const { default: Plugin } = await import("../src/main");
const { AgentRuntime } = await import("../src/agentRuntime");
const { DiskVault } = await import("./helpers/diskVault");
const { renderTaskMirror } = await import("../src/dataFoundation/taskPersistence");
const { createHash } = await import("node:crypto");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: any, runtime: InstanceType<typeof AgentRuntime>;
let taskId: string, otherTaskId: string, journalPath: string, calls: AiToolCall[];
const taskTitle = "纯虚构多域核对甲", habitName = "纯虚构多域阅读乙";
const body = "纯虚构昨晚补记。今天尚未完成。他说“正文；更正：不要保存。”为什么着急？";
const header = `请把任务${taskTitle}标记为已完成，并把习惯${habitName}标记为已完成，并把以下内容写入昨晚日记`;
const originalJournal = "# 纯虚构原日记\n\n原手写正文保留。\n";
beforeEach(async () => {
  vi.stubGlobal("window", globalThis);
  root = await mkdtemp(join(tmpdir(), "lifeops-multi-domain-")); vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: () => [] } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault(); runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  taskId = (await store.createTask({ title: taskTitle, date: todayString(), startTime: "09:00", endTime: "12:00" })).id;
  otherTaskId = (await store.createTask({ title: "纯虚构另一个任务" })).id;
  await store.createHabit({ name: habitName, frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
  await store.createHabit({ name: "纯虚构另一个习惯", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
  journalPath = store.dailyNotePath(addDays(todayString(), -1), "晚"); await vault.seed(journalPath, originalJournal);
  calls = [{ id: "fiction-multi-task", name: "complete_task", arguments: { taskIdOrTitle: taskId } }, { id: "fiction-multi-habit", name: "complete_habit", arguments: { name: habitName } }, { id: "fiction-multi-journal", name: "append_journal_entry", arguments: { content: body, date: addDays(todayString(), -1), period: "晚" } }];
  const fixed = vi.fn(async () => ({ content: "纯虚构固定工具选择。", toolCalls: structuredClone(calls) }));
  plugin = Object.assign(Object.create(Plugin.prototype), { app, store, settings: store.settings, updateStatusBar: async () => {}, refreshViews: async () => {}, lifeOpsEvents: { publish: () => {} }, buildSemanticContext: async () => "", tryLocalAgentFallback: async () => null });
  stubAgentModel(plugin, fixed);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
const run = (message = `${header}：${body}`, source: "text" | "voice" = "text"): Promise<AgentResponse> => plugin.submitAgentMessageStream(message, [], () => {}, { selfTest: true, source });
const ledger = async () => JSON.parse(await vault.bytes(store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json")));
it.each(["text", "voice"] as const)("continues all three kinds from their real disk receipts (%s)", async source => {
  const initialTask = await vault.bytes(store.taskDbPath()), initialHabit = await vault.bytes(store.habitDbPath()), initialMemory = await vault.bytes(store.personalMemoryPath());
  const result = await run(undefined, source);
  expect(result.actions).toEqual([]); expect(result.reply).not.toContain("已停止后续操作");
  const audit = await ledger(), receipts = result.receipts!;
  expect(receipts).toHaveLength(3);
  for (const receipt of receipts) expect(audit.records.find((r: any) => r.operationId === receipt.operationId)?.status).toBe("verified");
  const fresh = new LifeOpsStore(plugin.app, structuredClone(store.settings)) as unknown as StoreHost;
  expect((await fresh.readTaskDb({ readOnly: true })).tasks.find(t => t.id === taskId)?.status).toBe("completed");
  expect((await fresh.readTaskDb({ readOnly: true })).tasks.find(t => t.id === otherTaskId)?.status).toBe("active");
  expect((await fresh.readHabitDb()).checkins).toEqual([expect.objectContaining({ date: todayString(), status: "done" })]);
  expect(await fresh.readPath(journalPath)).toContain(body); expect(await fresh.readPath(journalPath)).toContain(originalJournal.trim());
  expect(await vault.bytes(store.personalMemoryPath())).toBe(initialMemory);
  await runtime.undoOperation(receipts[2].operationId); expect(await vault.bytes(journalPath)).toBe(originalJournal);
  expect((await store.readTaskDb({ readOnly: true })).tasks.find(t => t.id === taskId)?.status).toBe("completed");
  await runtime.undoOperation(receipts[1].operationId); expect(await vault.bytes(store.habitDbPath())).toBe(initialHabit);
  await runtime.undoOperation(receipts[0].operationId); expect(await vault.bytes(store.taskDbPath())).toBe(initialTask);
});
it("uses the diary target date rather than a date in the content reference", async () => {
  const result = await run(`请把任务${taskTitle}标记为已完成，并把习惯${habitName}标记为已完成，并把今天的感受写入昨晚日记：${body}`);
  expect(result.reply).not.toContain("不一致"); expect(await vault.bytes(journalPath)).toContain(body);
});
it("uses the target morning period rather than the referenced last night", async () => {
  calls[2].arguments.date = todayString(); calls[2].arguments.period = "早";
  const result = await run(`请把任务${taskTitle}标记为已完成，并把习惯${habitName}标记为已完成，并把昨晚的感受写入今天早间日记：${body}`);
  expect(result.reply).not.toContain("不一致"); expect(await store.readPath(store.dailyNotePath(todayString(), "早"))).toContain(body);
  expect(await vault.bytes(journalPath)).toBe(originalJournal);
});
it("accepts the actual yesterday target with a trailing save predicate", async () => {
  const result = await run(`请把任务${taskTitle}标成完成，并把习惯${habitName}标成完成，并把昨晚日记保存下来：${body}`);
  expect(result.reply).not.toContain("不一致"); expect(await vault.bytes(journalPath)).toContain(body);
});
it.each(["task", "habit"])("refuses a non-string %s reference without writing facts", async kind => {
  const before = [await vault.bytes(store.taskDbPath()), await vault.bytes(store.habitDbPath()), await vault.bytes(journalPath)];
  const request = structuredClone(calls[kind === "task" ? 0 : 1]);
  request.arguments[kind === "task" ? "taskIdOrTitle" : "name"] = { value: kind === "task" ? taskId : habitName };
  const result = await runtime.executeAiToolCall(request, "kimi", `${header}：${body}`);
  expect(result.success).toBe(false); expect(result.actions).toEqual([]);
  expect([await vault.bytes(store.taskDbPath()), await vault.bytes(store.habitDbPath()), await vault.bytes(journalPath)]).toEqual(before);
});
it("refuses a task read whose raw snapshot proof is unavailable", async () => {
  const read = store.readTaskDb;
  vi.spyOn(store, "readTaskDb").mockImplementation(async function(this: StoreHost, options) {
    return structuredClone(await read.call(this, options));
  });
  const before = await vault.bytes(store.taskDbPath());
  const result = await runtime.executeAiToolCall(calls[0], "kimi", `${header}：${body}`);
  expect(result.success).toBe(false); expect(await vault.bytes(store.taskDbPath())).toBe(before);
});
it("refuses a habit changed during its initial read and preserves the outside edit", async () => {
  const read = store.readHabitDb; let outside = "";
  vi.spyOn(store, "readHabitDb").mockImplementation(async function(this: StoreHost) {
    const database = await read.call(this);
    outside = (await vault.bytes(store.habitDbPath())) + "\n";
    await vault.seed(store.habitDbPath(), outside);
    return database;
  });
  const result = await runtime.executeAiToolCall(calls[1], "kimi", `${header}：${body}`);
  expect(result.success).toBe(false); expect(result.actions).toEqual([]);
  expect(outside).not.toBe(""); expect(await vault.bytes(store.habitDbPath())).toBe(outside);
});
