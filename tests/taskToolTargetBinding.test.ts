import { stubAgentModel } from "./helpers/stubAgentModel";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { StoreHost } from "../src/store/settingsSlice";
import type { LifeOpsTask } from "../src/types";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { activityNotePath } from "../src/activityRecords";
import { todayString } from "../src/date";
import { formatVaultTaskBlock } from "../src/vaultApi";
import { recordRevision } from "../src/operationIdentity";

vi.mock("obsidian", () => ({ App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: () => { throw Error("Offline fictional target binding"); } }));
const { LifeOpsStore } = await import("../src/store"), { DiskVault } = await import("./helpers/diskVault"), { AgentRuntime } = await import("../src/agentRuntime");
const { default: LifeOpsPlugin } = await import("../src/main");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>, plugin: any;
const originalText = "纯虚构手写记录，不能因任务选择改变。\n";
function task(id: string, title: string, status: LifeOpsTask["status"] = "active"): LifeOpsTask {
  return { id, title, status, priority: "high", quadrant: "important-not-urgent", category: "虚构", project: "虚构项目", date: "2026-10-08", endDate: "2026-10-08", time: "", dueDate: "2026-10-08", dueTime: "", repeatUnit: "none", repeatInterval: 1, repeatUntil: "", parentTaskId: "parent", note: "纯虚构亲写备注\n保留第二行", source: "manual", sourceNotePath: "日记/source.md", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z", completedAt: status === "completed" ? "2026-10-07T00:00:00.000Z" : "", completionLog: [{ completedAt: "2026-09-01T00:00:00.000Z", note: "纯虚构旧历史" }], sortOrder: 1 };
}
async function seed(tasks: LifeOpsTask[]) {
  await vault.seed(store.taskDbPath(), JSON.stringify({ tasks, extraRoot: { keep: true } }, null, 2) + "\n");
  const board = "# LifeOps 任务看板\n\n" + ([["进行中", "active"], ["已完成", "completed"], ["放弃", "abandoned"]] as const).map(([heading, status]) => `## ${heading}\n${tasks.filter(t => t.status === status).map(formatVaultTaskBlock).join("\n")}\n`).join("\n") + "\n## 亲写说明\n纯虚构原文须保留。\n";
  await vault.seed(store.taskMirrorPath(), board);
  await vault.seed(activityNotePath(store, "tasks", todayString()), originalText);
  await vault.seed(store.dailyNotePath(todayString(), "早"), originalText);
}
const paths = () => [store.taskDbPath(), store.taskMirrorPath(), activityNotePath(store, "tasks", todayString()), store.dailyNotePath(todayString(), "早")];
const facts = async () => Promise.all(paths().map(path => vault.bytes(path)));
async function call(toolName: "complete_task" | "delete_task", reference: string, callId = "fiction-target-" + toolName) {
  return runtime.executeToolCall({ toolName, arguments: { taskIdOrTitle: reference, note: "纯虚构新说明" }, source: "qwen-omni", callId, userMessage: (toolName === "complete_task" ? "这个任务已经完成：" : "请删除这个任务：") + reference });
}
beforeEach(async () => {
  vi.stubGlobal("window", globalThis);
  root = await mkdtemp(join(tmpdir(), "lifeops-task-target-")); vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; await store.initializeVault();
  runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), { app, store, settings: store.settings, lifecycleGeneration: 1, unloaded: false, updateStatusBar: vi.fn(async () => {}), refreshViews: vi.fn(async () => {}), lifeOpsEvents: { publish: vi.fn() }, buildSemanticContext: vi.fn(async () => ""), tryLocalAgentFallback: vi.fn(async () => null) });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

describe("task references through real Runtime and temporary disk", () => {
  it.each([
    ["请创建任务 展馆：给蓝色样品贴标签，安排在明天下午三点。", "给蓝色样品贴标签", "展馆：给蓝色样品贴标签"],
    ["新建待办：给绿色文件夹贴标签，定在明天。", "绿色文件夹贴标签", "给绿色文件夹贴标签"],
    ["请创建任务：原样抄下，安排在明天，再找原图。", "原样抄下", "原样抄下"],
    ["请创建任务：给黄色盒子贴标签，安排在明天下午三点。", "擦拭样品台", "擦拭样品台"]
  ])("preserves an explicit title before its separately stated schedule: %s", async (userMessage, title, expected) => {
    await seed([task("task-1800-new", "纯虚构已有任务")]);
    const before = await facts();
    const result = await runtime.executeToolCall({ toolName: "create_task", arguments: { title, date: "明天", time: "15:00" },
      source: "qwen-omni", callId: "fiction-explicit-title", userMessage });
    expect(result.success).toBe(true);
    expect(result.output).toContain(expected);
    expect((await store.readTaskDb({ readOnly: true })).tasks).toContainEqual(expect.objectContaining({ title: expected, time: "15:00" }));
    expect(await runtime.undoOperation(result.callId)).toBe(true);
    expect(await facts()).toEqual(before);
  });

  it.each([
    ["帮我创建一个明天下午三点的任务，标题是虚构口令里的数字。", "虚构口令里的数字"],
    ["请创建任务，标题用刚才提到的编号。", "刚才提到的编号"],
    ["请创建任务，任务名是前面说的项目名称。", "前面说的项目名称"],
    ["先前提过‘准确名称’，请创建任务，标题是便签中的编号。", "便签中的编号"],
    ["请创建任务：上次标题是“普通事项”，这次标题是虚构口令里的数字。", "虚构口令里的数字"],
    ["请创建任务：上次标题原样写成虚构口令里的数字，这次标题是虚构口令里的数字。", "虚构口令里的数字"]
  ])("does not save a copied unresolved title reference: %s", async (userMessage, title) => {
    await seed([task("task-1800-new", "纯虚构已有任务")]); const before = await facts();
    const result = await runtime.executeToolCall({ toolName: "create_task", arguments: { title, date: "明天", time: "15:00" }, source: "qwen-omni", callId: "fiction-reference-title", userMessage });
    expect(result.success).toBe(false); expect(result.actions).toEqual([]); expect(result.output).toContain("具体标题");
    expect(await facts()).toEqual(before);
  });
  it.each([
    ["请创建任务：标题原样写成“虚构口令里的数字”。", "虚构口令里的数字"],
    ["请创建任务：标题是“前面说的编号”。", "前面说的编号"],
    ["请创建任务，标题原样写成前面说的编号。", "前面说的编号"],
    ["请创建任务：上次标题是虚构口令里的数字，这次标题是“虚构口令里的数字”。", "虚构口令里的数字"],
    ["请创建任务，标题是核对报表里的数字。", "核对报表里的数字"],
    ["请创建任务：标题是标注照片里的数字。", "标注照片里的数字"],
    ["请创建任务：标题是找出报表中的编号。", "找出报表中的编号"],
    ["请创建任务：统计报表里的数字。", "统计报表里的数字"],
    ["请创建任务，标题是刚才那封邮件的回复草稿。", "刚才那封邮件的回复草稿"],
    ["请创建任务，标题是前面说的编号。", "二十九"]
  ])("preserves explicit literal, concrete or resolved titles with normal undo: %s", async (userMessage, title) => {
    await seed([task("task-1800-new", "纯虚构已有任务")]); const before = await facts();
    const result = await runtime.executeToolCall({ toolName: "create_task", arguments: { title }, source: "qwen-omni", callId: "fiction-reference-title", userMessage });
    expect(result.success).toBe(true); expect((await store.readTaskDb({ readOnly: true })).tasks.some(t => t.title === title)).toBe(true);
    expect(await runtime.undoOperation(result.callId)).toBe(true); expect(await facts()).toEqual(before);
  });
  it.each(["completed", "abandoned"] as const)("does not complete another task when the exact ID belongs to a %s task", async status => {
    const old = task("task-1700-old", "纯虚构整理甲材料", status), next = task("task-1800-new", "纯虚构练习乙方案");
    await seed([old, next]); const before = await facts(), result = await call("complete_task", old.id);
    expect(result.success).toBe(false); expect(result.output).toContain(status === "completed" ? "已完成" : "已放弃"); expect(await facts()).toEqual(before);
  });
  it.each(["completed", "abandoned"] as const)("keeps an exact %s title ahead of another active longer title", async status => {
    const old = task("task-1700-old", "纯虚构报告", status), next = task("task-1800-new", "纯虚构报告附录校对");
    await seed([old, next]); const before = await facts(), result = await call("complete_task", old.title);
    expect(result.success).toBe(false); expect(result.output).toContain(status === "completed" ? "已完成" : "已放弃"); expect(await facts()).toEqual(before);
  });
  for (const toolName of ["complete_task", "delete_task"] as const) {
    it.each(["task-1700-old", "task:1700-old", "task_1700_old", "task -1700-old", "task : 1700-old", "task-1800", "TASK-1800-NEW", "task-1800-new!", "task-1700-old extra", "842ba5c0-1698-401f-83c6-9bdcf31fea20"])(`refuses missing, partial or changed ID %s: ${toolName}`, async ref => {
      await seed([task("task-1800-new", "纯虚构练习乙方案"), task("legacy-existing", "纯虚构名称与旧编号 " + ref)]);
      const before = await facts(), result = await call(toolName, ref);
      expect(result.success).toBe(false); expect(result.actions).toEqual([]); expect(await facts()).toEqual(before);
    });
    it(`does not silently choose the active member of identical titles: ${toolName}`, async () => {
      await seed([task("task-1700-old", "纯虚构同名报告", "completed"), task("task-1800-new", "纯虚构同名报告")]);
      const before = await facts(), result = await call(toolName, "纯虚构同名报告");
      expect(result.success).toBe(false); expect(result.output).toContain("多个可能的任务"); expect(result.actions).toEqual([]); expect(await facts()).toEqual(before);
    });
    it(`requires a choice among mixed-state shared title fragments: ${toolName}`, async () => {
      await seed([task("task-1700-old", "纯虚构报告", "completed"), task("task-1800-new", "纯虚构报告附录校对")]);
      const before = await facts(), result = await call(toolName, "纯虚构报");
      expect(result.success).toBe(false); expect(result.output).toContain("多个可能的任务"); expect(await facts()).toEqual(before);
    });
  }
  it("gives the exact stable ID precedence over another task's identical title, with normal undo", async () => {
    const selected = task("legacy-exact", "纯虚构精确编号对象"), other = task("task-1800-new", selected.id);
    await seed([selected, other]); const before = await facts(), result = await call("complete_task", selected.id);
    expect(result.success).toBe(true); expect((await store.readTaskDb({ readOnly: true })).tasks.find(t => t.id === other.id)).toEqual(other);
    const fresh = new LifeOpsStore(plugin.app, store.settings) as unknown as StoreHost;
    expect((await fresh.readTaskDb({ readOnly: true })).tasks.find(t => t.id === selected.id)?.status).toBe("completed");
    expect(await runtime.undoOperation(result.callId)).toBe(true); expect(await facts()).toEqual(before);
  });
  it.each(["英语", "纯虚构英语学习"])("preserves unique natural title reference %s and all history during completion and undo", async ref => {
    const selected = task("task-1800-new", "纯虚构英语学习"); await seed([selected]); const before = await facts(), result = await call("complete_task", ref);
    expect(result.success).toBe(true); const actual = (await store.readTaskDb({ readOnly: true })).tasks[0];
    expect(actual.completionLog.slice(0, -1)).toEqual(selected.completionLog); expect(actual.parentTaskId).toBe(selected.parentTaskId); expect(actual.note).toBe(selected.note);
    expect(await vault.bytes(activityNotePath(store, "tasks", todayString()))).toContain(selected.title);
    expect(await vault.bytes(store.dailyNotePath(todayString(), "早"))).toBe(originalText);
    expect(await runtime.undoOperation(result.callId)).toBe(true); expect(await facts()).toEqual(before);
  });
  it.each(["active", "completed", "abandoned"] as const)("binds deletion to the actual %s ID without writes before confirmation, then supports undo", async status => {
    const selected = task("task-1700-old", "纯虚构报告", status), other = task("task-1800-new", "纯虚构报告附录校对");
    await seed([selected, other]); const before = await facts(), result = await call("delete_task", selected.id);
    expect(result.success).toBe(true); expect(result.actions).toHaveLength(1); const action = result.actions[0];
    expect(action.taskIds).toEqual([selected.id]); expect(action.expectedTargetRevisions).toEqual({ ["task:" + selected.id]: recordRevision(selected) }); expect(await facts()).toEqual(before);
    await plugin.executeAgentAction(action);
    expect((await store.readTaskDb({ readOnly: true })).tasks).toEqual([other]);
    await plugin.undoLatestLifeOpsOperation(); expect(await facts()).toEqual(before);
  });
  it("rejects the old deletion card after the same stable ID is reused for a different record", async () => {
    const selected = task("task-1700-old", "纯虚构旧报告", "completed"), other = task("task-1800-new", "纯虚构新报告");
    await seed([selected, other]); const result = await call("delete_task", selected.id); expect(result.actions).toHaveLength(1);
    await store.updateTaskDetails(selected.id, { title: "纯虚构后来替换的内容" }); const before = await facts();
    await expect(plugin.executeAgentAction(result.actions[0])).rejects.toThrow(); expect(await facts()).toEqual(before);
  });
  for (const source of ["text", "voice"] as const) {
    it.each(["completed-id", "completed-title", "deleted-id"])(`Main preserves unrelated records after refusing the old reference %s: ${source}`, async scenario => {
      const old = task("task-1700-old", "纯虚构报告", "completed"), other = task("task-1800-new", "纯虚构报告附录校对"); await seed(scenario === "deleted-id" ? [other] : [old, other]);
      const ref = scenario === "completed-title" ? old.title : old.id, before = await facts();
      const fixed = vi.fn(async () => ({ content: "", toolCalls: [{ id: "fiction-main-ref-" + scenario + "-" + source, name: "complete_task", arguments: { taskIdOrTitle: ref } }] }));
      stubAgentModel(plugin, fixed);
      const result = await plugin.submitAgentMessage("这个任务已经完成：" + ref, [], { source, selfTest: true });
      expect(fixed).toHaveBeenCalledOnce(); expect(result.actions).toEqual([]); expect(result.reply).toMatch(/已完成|没在任务库里定位到/); expect(await facts()).toEqual(before);
    });
    it(`Main completes an exact active task once, preserves the unrelated completed task, and normally undoes: ${source}`, async () => {
      const old = task("task-1700-old", "纯虚构报告", "completed"), selected = task("task-1800-new", "纯虚构报告附录校对"); await seed([old, selected]); const before = await facts();
      const fixed = vi.fn(async () => ({ content: "", toolCalls: [{ id: "fiction-main-exact-" + source, name: "complete_task", arguments: { taskIdOrTitle: selected.id } }] }));
      stubAgentModel(plugin, fixed);
      const result = await plugin.submitAgentMessage("这个任务已经完成：" + selected.id, [], { source, selfTest: true });
      expect(fixed).toHaveBeenCalledOnce(); expect(result.actions).toEqual([]); expect(result.reply).toContain("已标记完成");
      expect((await store.readTaskDb({ readOnly: true })).tasks.find(t => t.id === old.id)).toEqual(old); await plugin.undoLatestLifeOpsOperation(); expect(await facts()).toEqual(before);
    });
  }
});
