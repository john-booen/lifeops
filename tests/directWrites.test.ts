import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentRuntime } from "../src/agentRuntime";
import { prepareToolBatch, executeConfirmedToolBatch } from "../src/toolBatch";
import { renderWriteReceipts } from "../src/writeReceipts";
import { readPersonalMemoryWithSources } from "../src/personalMemorySources";
import { selectPersonalMemories } from "../src/personalMemory";
import type { LifeOpsTask } from "../src/types";

vi.mock("obsidian", () => ({ App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {},
  Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: () => { throw Error("Offline test"); } }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { default: Plugin } = await import("../src/main");
let root: string, store: any, runtime: AgentRuntime, vault: InstanceType<typeof DiskVault>;
beforeEach(async () => {
  vi.stubGlobal("window", globalThis);
  root = await mkdtemp(join(tmpdir(), "lifeops-direct-write-")); vault = new DiskVault(root);
  store = new LifeOpsStore({ vault, workspace: { getLeavesOfType: () => [] } } as any, structuredClone(DEFAULT_SETTINGS));
  await store.initializeVault(); runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  await store.createTask({ title: "虚构待办", date: "" });
  await store.createHabit({ name: "虚构阅读", frequencyUnit: "day", targetCount: 1, frequencyInterval: 1,
    startDate: "2026-11-05", penaltyThreshold: 3, color: "#123456" });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

const cases: Array<[string, Record<string, unknown>]> = [
  ["create_task", { title: "虚构会面", date: "明天", startTime: "15:00" }],
  ["complete_task", { taskIdOrTitle: "虚构待办" }],
  ["create_habit", { name: "虚构散步" }],
  ["complete_habit", { name: "虚构阅读" }],
  ["miss_habit", { name: "虚构阅读", reason: "虚构原因" }],
  ["append_journal_entry", { content: "纯虚构日记", date: "2026-11-05", period: "晚" }],
  ["append_memory_note", { content: "虚构偏好：先给结论", fileName: "个人画像.md" }],
  ["append_knowledge_note", { content: "纯虚构知识", date: "2026-11-05" }],
  ["append_trading_model_note", { content: "纯虚构复盘结论", date: "2026-11-05" }]
];
describe("direct writes with a real Store", () => {
  it.each(cases)("writes, returns a receipt and restores exact files: %s", async (name, args) => {
    const call = { id: `fiction-${name}`, name, arguments: args };
    const result = await runtime.executeAiToolCall(call, "kimi", ({create_task:"请创建任务：虚构会面",complete_task:"请把虚构待办标记为已完成",create_habit:"请创建习惯：虚构散步",complete_habit:"虚构阅读打卡完成",miss_habit:"请把虚构阅读习惯标记为未完成",append_journal_entry:"请保存晚间日记：纯虚构日记",append_knowledge_note:"请保存到知识笔记：纯虚构知识",append_trading_model_note:"请保存到交易模型：纯虚构复盘结论"} as Record<string,string>)[name] ?? "虚构稳定偏好");
    expect(result.success, result.output).toBe(true); expect(result.actions).toEqual([]); expect(result.output).toMatch(/^已/);
    expect(result.receipt).toBeDefined();
    const files = (result as any).undo.files;
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(await vault.bytes(file.path)).toBe(file.after);
    const retry = await runtime.executeToolCall({callId:call.id,toolName:name,arguments:args,source:"kimi",userMessage:({create_task:"请创建任务：虚构会面",complete_task:"请把虚构待办标记为已完成",create_habit:"请创建习惯：虚构散步",complete_habit:"虚构阅读打卡完成",miss_habit:"请把虚构阅读习惯标记为未完成",append_journal_entry:"请保存晚间日记：纯虚构日记",append_knowledge_note:"请保存到知识笔记：纯虚构知识",append_trading_model_note:"请保存到交易模型：纯虚构复盘结论"}as Record<string,string>)[name]??""}); expect(retry.receipt).toEqual(result.receipt);
    if (name === "append_memory_note") {
      const active = selectPersonalMemories((await readPersonalMemoryWithSources(store)).records);
      expect(active.some(record => record.content === args.content && record.tags.includes("对话"))).toBe(true);
    }
    await runtime.undoOperation(result.receipt!.operationId);
    for (const file of files) expect(vault.getFileByPath(file.path) ? await vault.bytes(file.path) : null).toBe(file.before);
  });
  it("keeps four modifications behind a confirmation and executes the approved batch only once", async () => {
    const tasks = [];
    for (let i = 0; i < 4; i++) tasks.push(await store.createTask({ title: `虚构批量任务${i}` }));
    const calls = tasks.map((task, i) => ({ id: `bulk-${i}`, name: "complete_task", arguments: { taskIdOrTitle: task.id } }));
    expect(prepareToolBatch(calls.slice(0, 3))).toBeUndefined();
    const prepared = prepareToolBatch(calls)!;
    expect(prepared.actions).toHaveLength(1); expect((await store.readTaskDb()).tasks.every((t: LifeOpsTask) => t.status === "active")).toBe(true);
    await executeConfirmedToolBatch(prepared.actions[0], runtime, () => {});
    await executeConfirmedToolBatch(prepared.actions[0], runtime, () => {});
    expect((await store.readTaskDb()).tasks).toHaveLength(5);
    expect((await store.readTaskDb()).tasks.filter((t: LifeOpsTask) => t.status === "completed")).toHaveLength(4);
  });
  it("allows a complete batch of new tasks with idempotent per-task writes", async () => {
    const calls = Array.from({ length: 5 }, (_, i) => ({ id: `new-bulk-${i}`, name: "create_task", arguments: { title: `虚构新增${i}` } }));
    expect(prepareToolBatch(calls)).toBeUndefined();
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const call of calls) expect((await runtime.executeAiToolCall(call, "kimi", "一次创建五项虚构新任务")).success).toBe(true);
    }
    expect((await store.readTaskDb()).tasks).toHaveLength(6);
  });
  it("uses the receipt's exact operation when the undo button is clicked", async () => {
    const result = await runtime.executeAiToolCall({ id: "button-write", name: "create_task", arguments: { title: "虚构按钮任务" } }, "kimi", "请创建任务：虚构按钮任务");
    const buttons: any[] = [];
    const row = { createEl: (_tag: string, options: any) => { const button = { textContent: options.text, disabled: false, onclick: undefined }; buttons.push(button); return button; } };
    renderWriteReceipts({ createDiv: () => row } as any, [result.receipt!], async id => { await runtime.undoOperation(id); });
    expect(buttons[0].textContent).toBe("撤销"); await buttons[0].onclick();
    expect(buttons[0]).toMatchObject({ textContent: "已撤销", disabled: true });
    expect((await store.readTaskDb()).tasks.some((task: any) => task.title === "虚构按钮任务")).toBe(false);
  });
  it("returns usable conversation memory and its undo receipt from Main", async () => {
    const plugin = Object.assign(Object.create(Plugin.prototype), { app: store.app, store, settings: store.settings,
      lifecycleGeneration: 1, unloaded: false, updateStatusBar: async () => {}, refreshViews: async () => {}, lifeOpsEvents: { publish: () => {} } });
    const response = await plugin.executeAgentToolCall({ id: "main-auto-memory", name: "append_memory_note", arguments: { content: "虚构稳定事实：喜欢晨间阅读" } }, "我喜欢晨间阅读");
    expect(response.actions).toEqual([]); expect(response.receipts).toHaveLength(1);
    expect(selectPersonalMemories((await readPersonalMemoryWithSources(store)).records).some(record => record.content.includes("晨间阅读"))).toBe(true);
    await plugin.undoStewardOperation(response.receipts[0].operationId);
    expect((await store.readPersonalMemories()).records).toEqual([]);
  });
});
