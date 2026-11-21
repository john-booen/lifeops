import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { StoreHost } from "../src/store/settingsSlice";
import type { AgentLoopHost } from "../src/agent/AgentLoop";
import type { AiToolCall } from "../src/ai";
import { DEFAULT_SETTINGS } from "../src/defaults";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
  normalizePath: (s: string) => s.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), requestUrl: vi.fn(),
  parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { createFsApp } = await import("./helpers/fsApp");
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { AgentLoop } = await import("../src/agent/AgentLoop");
const { executeConfirmedToolBatch } = await import("../src/toolBatch");
let root: string, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
const date = "2066-01-10";
const edit = (ref: string, title: string) => ({ taskIdOrTitle: ref, title });
const tool = (updates: Record<string, unknown>[], id = "fictional-content-edit"): AiToolCall => ({ id, name: "update_tasks", arguments: { updates } });
async function seed(count = 2) {
  for (let i = 0; i < count; i++) await store.createTask({ title: `虚构旧纸样${i}`, date,
    startTime: `${12 + i}:00`, endTime: `${12 + i}:30`, note: `虚构备注${i}`, category: "work" });
  return (await store.readTaskDb()).tasks;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-content-edit-"));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.ai = { ...settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", model: "synthetic", dataDisclosureAccepted: true };
  settings.privacy = { excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
  store = new LifeOpsStore(createFsApp(root), settings) as unknown as StoreHost;
  await store.initializeVault(); runtime = new AgentRuntime({ store, refreshViews: async () => {} });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it("renames two existing tasks directly while retaining identities, schedules, notes and completion state", async () => {
  const tasks = await seed(); await store.completeTask(tasks[1].id);
  const before = (await store.readTaskDb()).tasks;
  const result = await runtime.executeAiToolCall(tool(before.map((row, i) => edit(row.title, `虚构新纸样${i}`))), "kimi");
  expect(result.success).toBe(true); expect(result.actions).toEqual([]); expect(result.receipt?.taskEdits).toHaveLength(2);
  const after = (await store.readTaskDb()).tasks;
  expect(after).toHaveLength(2);
  for (const [i, row] of after.entries()) {
    const { title: _title, updatedAt: _time, ...rest } = row;
    const { title: _priorTitle, updatedAt: _priorTime, ...prior } = before[i];
    expect(row.title).toBe(`虚构新纸样${i}`); expect(rest).toEqual(prior);
  }
  await store.createTask({ title: "虚构后续独立任务" });
  await runtime.undoOperation(result.receipt!.operationId);
  expect((await store.readTaskDb()).tasks.slice(0, 2)).toEqual(before);
  expect((await store.readTaskDb()).tasks.at(-1)?.title).toBe("虚构后续独立任务");
});

it("supports notes and exact cached retry without a second update", async () => {
  const [row] = await seed(1); const request = tool([{ taskIdOrTitle: row.id, note: "虚构新备注\n保留换行" }]);
  const update = vi.spyOn(LifeOpsStore.prototype, "updateTask");
  const first = await runtime.executeAiToolCall(request, "kimi"), second = await runtime.executeAiToolCall(request, "kimi");
  expect(first.success).toBe(true); expect(second.receipt).toEqual(first.receipt); expect(update).toHaveBeenCalledOnce();
  expect(await store.getTask(row.id)).toMatchObject({ title: row.title, note: "虚构新备注\n保留换行" });
});

it("preflights every target and refuses ambiguous or missing references before editing any", async () => {
  const rows = await seed();
  const before = await store.readPath(store.taskDbPath());
  const result = await runtime.executeAiToolCall(tool([edit(rows[0].id, "虚构不应提前改"), edit("task-missing", "虚构不存在")]), "kimi");
  expect(result.success).toBe(false); expect(await store.readPath(store.taskDbPath())).toBe(before);
  await store.createTask({ title: rows[0].title });
  const duplicate = await runtime.executeAiToolCall(tool([edit(rows[0].title, "虚构歧义")], "fictional-ambiguous"), "kimi");
  expect(duplicate.success).toBe(false); expect(duplicate.output).toContain("唯一");
});

it("does not accept date/status fields through content editing", async () => {
  const [row] = await seed(1);
  const result = await runtime.executeAiToolCall(tool([{ ...edit(row.id, "虚构新纸样"), date: "2066-02-01" }]), "kimi");
  expect(result.success).toBe(false); expect(await store.getTask(row.id)).toEqual(row);
});

it("rolls back the first edit when the second save fails", async () => {
  const rows = await seed(), before = await store.readPath(store.taskDbPath());
  const original = LifeOpsStore.prototype.updateTask; let calls = 0;
  vi.spyOn(LifeOpsStore.prototype, "updateTask").mockImplementation(async function (this: InstanceType<typeof LifeOpsStore>, ...args) {
    await original.apply(this, args); if (++calls === 2) throw Error("Fictional write failure");
  });
  const result = await runtime.executeAiToolCall(tool(rows.map((row, i) => edit(row.id, `虚构新名称${i}`))), "kimi");
  expect(result.success).toBe(false); expect(await store.readPath(store.taskDbPath())).toBe(before);
});

it.each([false, true])("stops excluded permissions before/during editing (mid-save: %s)", async midSave => {
  const rows = await seed(), before = await store.readPath(store.taskDbPath());
  const exclude = () => { store.settings.privacy = { ...store.settings.privacy, excludedVaultPrefixes: [store.taskDbPath()] }; };
  if (midSave) {
    const original = LifeOpsStore.prototype.updateTask; let calls = 0;
    vi.spyOn(LifeOpsStore.prototype, "updateTask").mockImplementation(async function (this: InstanceType<typeof LifeOpsStore>, ...args) {
      await original.apply(this, args); if (++calls === 1) exclude();
    });
  } else exclude();
  const result = await runtime.executeAiToolCall(tool(rows.map((row, i) => edit(row.id, `虚构新名称${i}`))), "kimi");
  expect(result.success).toBe(false); expect(await store.readPath(store.taskDbPath())).toBe(before);
});

async function run(calls: AiToolCall[], message: string, history: Parameters<InstanceType<typeof AgentLoop>["run"]>[0]["history"] = []) {
  let turns = 0;
  const model = vi.fn(async () => ++turns === 1 ? { content: "", toolCalls: calls }
    : { content: "模型的额外确认要求不作为保存回执。", toolCalls: [] });
  const host: AgentLoopHost = { store, settings: store.settings, aiForRole: () => ({ agentTurnStream: model }),
    executeTools: async (tools, userMessage, signal, onResult) => {
      const results = [];
      for (const call of tools) {
        const result = await runtime.executeAiToolCall(call, "kimi", userMessage, { assertCurrent: () => signal?.throwIfAborted() });
        onResult(call, result); results.push(result);
      }
      return results;
    }, offlineFallback: async () => null };
  const result = await new AgentLoop(host).run({ message, history, source: "text", now: new Date(2066, 0, 10, 10) });
  return { result, model };
}

it("handles a two-task correction plus a third new task in one turn without asking for confirmation", async () => {
  const rows = await seed();
  const { result, model } = await run([tool(rows.map((row, i) => edit(row.title, `虚构更正名称${i}`))),
    { id: "fictional-extra", name: "create_task", arguments: { title: "虚构新增第三项", date } }],
    "把虚构旧纸样0和虚构旧纸样1改为对应的新名称，再新增第三项，都保留今天的原安排。");
  expect(model).toHaveBeenCalledTimes(2); expect(result.confirmations).toEqual([]);
  expect(result.receipts).toHaveLength(2); expect(result.text).toContain("实际更新2项");
  expect(result.text).toContain("已创建任务：虚构新增第三项");
  expect((await store.readTaskDb()).tasks.map(row => row.title)).toEqual(["虚构更正名称0", "虚构更正名称1", "虚构新增第三项"]);
});

it("uses the explicit old-to-new history when the next message just confirms the two names", async () => {
  const rows = await seed();
  const { result } = await run([tool(rows.map((row, i) => edit(row.id, `虚构纠正名称${i}`)))], "确定改这两个任务的名称", [
    { role: "user", content: "把虚构旧纸样0改成虚构纠正名称0，把虚构旧纸样1改成虚构纠正名称1。" },
    { role: "assistant", content: "两条改名请确认后再改。" }
  ]);
  expect(result.confirmations).toEqual([]); expect(result.text).toContain("实际更新2项");
  expect((await store.readTaskDb()).tasks.map(row => row.id)).toEqual(rows.map(row => row.id));
});

it("still requires one real confirmation for four edits and preserves that gate in raw Runtime calls", async () => {
  const rows = await seed(4), call = tool(rows.map((row, i) => edit(row.id, `虚构新纸样${i}`)));
  const direct = await runtime.executeAiToolCall(call, "kimi"); expect(direct.success).toBe(false);
  const { result } = await run([call], "请修改这四条虚构任务的标题。");
  expect(result.confirmations).toHaveLength(1); expect(result.receipts).toEqual([]);
  expect((await store.readTaskDb()).tasks).toEqual(rows);
  await executeConfirmedToolBatch(result.confirmations[0], runtime, () => {});
  expect((await store.readTaskDb()).tasks.map(row => row.title)).toEqual(rows.map((_, i) => `虚构新纸样${i}`));
});
