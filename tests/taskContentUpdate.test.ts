import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { StoreHost } from "../src/store/settingsSlice";
import type { AgentLoopHost } from "../src/agent/AgentLoop";
import type { AgentHost } from "../src/agent/service";
import type { AiToolCall } from "../src/ai";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { AgentConversationMessage } from "../src/types";
import { personalMemoryContextRevision } from "../src/personalMemoryContext";
import { attestAgentHistoryResponse, bindAgentHistoryResponse } from "../src/personalMemoryHistory";
import { memorySourcePolicy, readPersonalMemoryWithSources } from "../src/personalMemorySources";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, Modal: class {},
  normalizePath: (s: string) => s.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), requestUrl: vi.fn(),
  parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { createFsApp } = await import("./helpers/fsApp");
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { AgentLoop } = await import("../src/agent/AgentLoop");
const { executeConfirmedToolBatch } = await import("../src/toolBatch");
const { executeAgentAction } = await import("../src/agent/service");
const { explicitTitleEdits } = await import("../src/agent/explicitTitleEdits");
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

it("does not accept status fields through task editing", async () => {
  const [row] = await seed(1);
  const result = await runtime.executeAiToolCall(tool([{ ...edit(row.id, "虚构新纸样"), status: "done" }]), "kimi");
  expect(result.success).toBe(false); expect(await store.getTask(row.id)).toEqual(row);
});

it("confirms eleven complete schedule changes once, saves them together and undoes without removing later tasks", async () => {
  const rows = await seed(11), before = await store.readPath(store.taskDbPath());
  const updates = rows.map((row, i) => ({ taskIdOrTitle: row.id, startTime: `${9 + i}`.padStart(2, "0") + ":00", endTime: `${9 + i}`.padStart(2, "0") + ":30" }));
  const { result } = await run([tool(updates)], "把这十一项现有纸样任务按刚给出的完整时段统一重排，其他内容不变。", [], true);
  expect(await store.readPath(store.taskDbPath())).toBe(before);
  expect(result.confirmations).toHaveLength(1); expect(result.confirmations[0].type).toBe("tool_batch");
  const saved = await executeConfirmedToolBatch(result.confirmations[0], runtime, () => {});
  expect(saved).toContain("本次实际更新11项");
  for (const [i, row] of rows.entries()) {
    const { updatedAt: _old, ...old } = row;
    const { updatedAt: _new, ...next } = await store.getTask(row.id);
    expect(next).toEqual({ ...old, startTime: updates[i].startTime, endTime: updates[i].endTime });
  }
  await store.createTask({ title: "虚构后续独立工作" });
  await runtime.undoLatestOperation();
  expect((await store.readTaskDb()).tasks.slice(0, 11)).toEqual(rows);
  expect((await store.readTaskDb()).tasks.at(-1)?.title).toBe("虚构后续独立工作");
});

it("changes two full intervals and creates a new task in the same turn", async () => {
  const rows = await seed();
  const { result } = await run([tool(rows.map((row, i) => ({ taskIdOrTitle: row.id, startTime: `1${5 + i}:00`, endTime: `1${5 + i}:45` }))),
    { id: "fictional-extra-plan", name: "create_task", arguments: { title: "虚构新增计划", date } }], "把这两个已有纸样改成新时段，再增加一条虚构新增计划。");
  expect(result.confirmations).toEqual([]); expect(result.receipts).toHaveLength(2);
  const after = (await store.readTaskDb()).tasks;
  expect(after).toHaveLength(3); expect(after[0]).toMatchObject({ id: rows[0].id, title: rows[0].title, startTime: "15:00", endTime: "15:45" });
  expect(after[1]).toMatchObject({ id: rows[1].id, title: rows[1].title, startTime: "16:00", endTime: "16:45" });
  expect(after[2].title).toBe("虚构新增计划");
});

it.each([{ startTime: "24:00" }, { endTime: "11:00" }, { date: "2066-02-30" }, { startTime: 900 },
  { endDate: "2065-12-01" }, { time: "09:00" }])("rejects an invalid second plan before applying either change: %j", async invalid => {
  const rows = await seed(), before = await store.readPath(store.taskDbPath());
  const result = await runtime.executeAiToolCall(tool([{ taskIdOrTitle: rows[0].id, startTime: "15:00", endTime: "15:30" },
    { taskIdOrTitle: rows[1].id, ...invalid }]), "kimi");
  expect(result.success).toBe(false); expect(await store.readPath(store.taskDbPath())).toBe(before);
});

it("refuses to move a completed task while allowing the existing title correction behavior", async () => {
  const [row] = await seed(1); await store.completeTask(row.id); const before = await store.getTask(row.id);
  const blocked = await runtime.executeAiToolCall(tool([{ taskIdOrTitle: row.id, startTime: "15:00", endTime: "15:30" }]), "kimi");
  expect(blocked.success).toBe(false); expect(await store.getTask(row.id)).toEqual(before);
  const renamed = await runtime.executeAiToolCall(tool([edit(row.id, "虚构完成后的准确标题")], "fictional-finished-name"), "kimi");
  expect(renamed.success).toBe(true); expect(await store.getTask(row.id)).toMatchObject({ status: before.status, completedAt: before.completedAt });
});

it("binds the whole preview to record revisions and refuses a stale last task before any schedule changes", async () => {
  const rows = await seed(4);
  const updates = rows.map(row => ({ taskIdOrTitle: row.id, startTime: "15:00", endTime: "15:30" }));
  const { result } = await run([tool(updates)], "把这四项完整时段统一改成15点到15点半。");
  expect(result.confirmations).toHaveLength(1);
  const action = result.confirmations[0];
  expect(action.content).toContain("虚构旧纸样0"); expect(action.content).toContain("15:00");
  expect(action.content).not.toContain("expectedRevision");
  await store.updateTask(rows[3].id, current => ({ ...current, note: "虚构外部新备注" }));
  const changed = await store.readPath(store.taskDbPath());
  await expect(executeConfirmedToolBatch(action, runtime, () => {})).rejects.toThrow("过期");
  expect(await store.readPath(store.taskDbPath())).toBe(changed);
});

it("shows one readable frozen preview for schedule changes and additional new tasks", async () => {
  const rows = await seed(4);
  const { result } = await run([tool(rows.map(row => ({ taskIdOrTitle: row.title, startTime: "15:00", endTime: "15:30" }))),
    { id: "fictional-with-plan", name: "create_task", arguments: { title: "虚构额外新工作", date } }], "四条纸样统一改时段，并加一条新工作，给一份确认。");
  expect(result.confirmations).toHaveLength(1);
  expect(result.confirmations[0].content).toContain("新建「虚构额外新工作」");
  expect(result.confirmations[0].content).not.toContain("taskIdOrTitle");
  await executeConfirmedToolBatch(result.confirmations[0], runtime, () => {});
  expect((await store.readTaskDb()).tasks).toHaveLength(5);
});

it("does not present an executable plan if one of the batch targets is missing", async () => {
  const rows = await seed(3), before = await store.readPath(store.taskDbPath());
  const { result } = await run([tool([...rows.map(row => ({ taskIdOrTitle: row.id, startTime: "15:00", endTime: "15:30" })),
    { taskIdOrTitle: "fictional-missing-task", startTime: "16:00", endTime: "16:30" }])], "给这四项准备整批时段。");
  expect(result.confirmations).toEqual([]); expect(result.receipts).toEqual([]);
  expect(await store.readPath(store.taskDbPath())).toBe(before);
});

it("updates explicit cross-day plan dates while keeping the independent deadline and other content", async () => {
  const [row] = await seed(1); await store.updateTask(row.id, current => ({ ...current, dueDate: "2066-01-20" }));
  const saved = await runtime.executeAiToolCall(tool([{ taskIdOrTitle: row.id, date: "2066-01-11", endDate: "2066-01-12",
    startTime: "23:30", endTime: "00:30" }]), "kimi");
  expect(saved.success).toBe(true);
  expect(await store.getTask(row.id)).toMatchObject({ id: row.id, title: row.title, note: row.note, dueDate: "2066-01-20",
    date: "2066-01-11", endDate: "2066-01-12", startTime: "23:30", endTime: "00:30" });
});

it("supports an explicit single-point change and clearing plan fields without recreating tasks", async () => {
  const row = await store.createTask({ title: "虚构单点安排", date, time: "10:00" });
  const saved = await runtime.executeAiToolCall(tool([{ taskIdOrTitle: row.id, time: "11:30" }]), "kimi");
  expect(saved.success).toBe(true); expect((await store.getTask(row.id)).time).toBe("11:30");
  const cleared = await runtime.executeAiToolCall(tool([{ taskIdOrTitle: row.id, time: "", startTime: "", endTime: "", endDate: "" }], "fictional-clear-slot"), "kimi");
  expect(cleared.success).toBe(true); expect(await store.getTask(row.id)).toMatchObject({ id: row.id, title: row.title,
    date, time: "", startTime: "", endTime: "", endDate: "" });
});

it("does not write an interval that is already identical", async () => {
  const [row] = await seed(1), change = vi.spyOn(LifeOpsStore.prototype, "updateTask");
  const saved = await runtime.executeAiToolCall(tool([{ taskIdOrTitle: row.id, startTime: row.startTime, endTime: row.endTime }]), "kimi");
  expect(saved.success).toBe(true); expect(change).not.toHaveBeenCalled(); expect(await store.getTask(row.id)).toEqual(row);
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

async function run(calls: AiToolCall[], message: string, history: Parameters<InstanceType<typeof AgentLoop>["run"]>[0]["history"] = [], lookupFirst: boolean | 'plan' = false) {
  let turns = 0;
  const model = vi.fn(async () => {
    const turn = ++turns;
    if (lookupFirst && turn === 1) return { content: "", toolCalls: [{ id: "fictional-lookup-first", name: "list_tasks", arguments: { date, directReply: true } },
      ...(lookupFirst==='plan'?[{id:'fictional-plan-first',name:'plan_today',arguments:{draftTomorrow:true}}]:[])] };
    return turn === (lookupFirst ? 2 : 1) ? { content: "", toolCalls: calls }
      : { content: "模型的额外确认要求不作为保存回执。", toolCalls: [] };
  });
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

it.each(["both", "partial", "read-only-call", "prose", "blocked-extra"])("keeps both exact title edits unchanged until the requested preview is confirmed (%s)", async mode => {
 const rows = await seed(), before = await store.readPath(store.taskDbPath());
 const proposed = mode === "prose" ? [] : mode === "read-only-call" ? [{ name: "list_tasks", arguments: { date, directReply: true } }]
  : [tool(rows.slice(mode === "partial" ? 1 : 0).map(row => edit(row.id, row.id === rows[0].id ? "虚构新纸样甲" : "虚构新纸样乙")))];
 if (mode === "blocked-extra") proposed.push({ name: "reschedule_task", arguments: { taskIdOrTitle: "fictional-unknown-task", date, time: "20:00" } });
 const { result, model } = await run(proposed,
  '把「虚构旧纸样0」改为「虚构新纸样甲」，把「虚构旧纸样1」改为「虚构新纸样乙」。先给我确认卡，等我确认。');
 expect(result.receipts).toEqual([]);
 expect(result.confirmations).toHaveLength(1);
  expect(model).toHaveBeenCalledTimes(mode === 'read-only-call' ? 2 : 1);
 expect(result.text).toContain("尚未修改");
 if (mode === "blocked-extra") expect(result.text).toContain("没有核对到");
 expect(await store.readPath(store.taskDbPath())).toBe(before);
 const receipt = await executeAgentAction.call({ unloaded: false, lifecycleGeneration: 0, createAgentRuntime: () => runtime } as unknown as AgentHost, result.confirmations[0]);
 expect(receipt).toContain("实际更新2项");
 expect((await store.readTaskDb()).tasks.map(row => row.title)).toEqual(["虚构新纸样甲", "虚构新纸样乙"]);
});

it.each(["copied", "changed"])("rejects a %s small requested preview before writing", async mode => {
 await seed(); const before = await store.readPath(store.taskDbPath());
 const { result } = await run([], '把「虚构旧纸样0」改为「虚构新纸样甲」，把「虚构旧纸样1」改为「虚构新纸样乙」。确认后再修改。');
 const action = mode === "copied" ? structuredClone(result.confirmations[0]) : result.confirmations[0];
 if (mode === "changed") (action.toolBatch![0].arguments.updates as Array<Record<string, unknown>>)[0].title = "虚构篡改标题";
 await expect(executeConfirmedToolBatch(action, runtime, () => {})).rejects.toThrow("批量修改内容无效");
 expect(await store.readPath(store.taskDbPath())).toBe(before);
});

it("rejects the whole small preview after either original task changes", async () => {
 const rows = await seed();
 const { result } = await run([], '把「虚构旧纸样0」改为「虚构新纸样甲」，把「虚构旧纸样1」改为「虚构新纸样乙」。先让我确认。');
 await store.updateTask(rows[1].id, row => ({ ...row, note: "虚构并发备注" }));
 const before = await store.readPath(store.taskDbPath());
 await expect(executeConfirmedToolBatch(result.confirmations[0], runtime, () => {})).rejects.toThrow("过期");
 expect(await store.readPath(store.taskDbPath())).toBe(before);
});

it("previews a mixed two-title correction and one new task together when requested", async () => {
 await seed(); const before = await store.readPath(store.taskDbPath());
 const { result } = await run([{ name: "schedule_task_batch", arguments: { date, tasks: [{ title: "虚构待确认新任务" }] } }],
  '把「虚构旧纸样0」改为「虚构新纸样甲」，把「虚构旧纸样1」改为「虚构新纸样乙」。再安排虚构待确认新任务。先给我确认卡，等我确认。');
 expect(result.confirmations).toHaveLength(1); expect(result.receipts).toEqual([]);
 expect(await store.readPath(store.taskDbPath())).toBe(before);
 await executeConfirmedToolBatch(result.confirmations[0], runtime, () => {});
 expect((await store.readTaskDb()).tasks.map(row => row.title)).toEqual(["虚构新纸样甲", "虚构新纸样乙", "虚构待确认新任务"]);
});

it("snapshots a requested mixed card before its first asynchronous write", async () => {
 await seed();
 const { result } = await run([{ name: "schedule_task_batch", arguments: { date, tasks: [{ title: "虚构快照新增任务" }] } }],
  '把「虚构旧纸样0」改为「虚构新纸样甲」，把「虚构旧纸样1」改为「虚构新纸样乙」。再安排虚构快照新增任务。先给我确认卡，等我确认。');
 const action = result.confirmations[0], actionId = action.id, original = runtime.executeLocalOperation.bind(runtime), callIds: string[] = [];
 vi.spyOn(runtime, "executeLocalOperation").mockImplementation(async (...args) => {
  callIds.push(args[3]!);
  action.id = "fictional-later-mutated-id"; action.toolBatch![1].arguments.title = "虚构迟到篡改标题";
  return original(...args);
 });
 await executeAgentAction.call({ unloaded: false, lifecycleGeneration: 0, createAgentRuntime: () => runtime } as unknown as AgentHost, action);
 expect(callIds).toEqual([`confirmed:${actionId}:tasks`]);
 expect((await store.readTaskDb()).tasks.map(row => row.title)).toEqual(["虚构新纸样甲", "虚构新纸样乙", "虚构快照新增任务"]);
});

async function pendingTitleHistory(proven = true, different = false, tail = "其他安排都保留。"): Promise<AgentConversationMessage[]> {
 const history: AgentConversationMessage[] = [
  { role: "user", content: '把「虚构旧纸样0」改为「虚构新纸样甲」，把「虚构旧纸样1」改为「虚构新纸样乙」。' + tail },
  { role: "assistant", content: different ? "请确认其他事项。" : "虚构旧纸样0改为虚构新纸样甲，虚构旧纸样1改为虚构新纸样乙。请确认后我再改。" }
 ];
 if (proven) {
  const { records } = await readPersonalMemoryWithSources(store);
  const response = attestAgentHistoryResponse({ reply: history[1].content, actions: [] }, store,
   personalMemoryContextRevision(records), memorySourcePolicy(store), history[0].content);
  bindAgentHistoryResponse(response, history[0], history[1]);
 }
 return history;
}

it('keeps quoted title content exact on the normal model route without upgrading an unproven pair into approval',async()=>{
 const before=await seed(),history=await pendingTitleHistory(false);
 const {result}=await run([tool([{taskIdOrTitle:before[0].id,title:'虚拟新纸样甲'},{taskIdOrTitle:before[1].id,title:'虚拟新纸样乙'}])],'确定',history);
 expect(result.receipts.flatMap(row=>row.taskEdits??[])).toHaveLength(2);
 expect((await store.readTaskDb()).tasks.map(row=>row.title)).toEqual(['虚构新纸样甲','虚构新纸样乙']);
});

it('does not invent a missing model edit or use illustrative old names as exact content',async()=>{
 await seed();const noWrite=await run([],'确定',await pendingTitleHistory(false));expect(noWrite.result.receipts).toEqual([]);
 const history=await pendingTitleHistory(false,false,'这只是举例，不修改。');
 const {bindTitleEditContent,titleEditRequest}=await import('../src/agent/explicitTitleEdits');
 expect(await titleEditRequest(store,history[0].content)).toBeUndefined();
 const calls=[tool([{taskIdOrTitle:'unknown',title:'虚构模型原值',note:'保留其他参数'}])];
 expect(bindTitleEditContent(calls,[{id:'other',before:'虚构旧名',title:'虚构明确新名'}])).toEqual(calls);
 expect(bindTitleEditContent([],[])).toEqual([]);
});

it("retains the adjacent proven two-name confirmation even if the model only looks on the wrong date", async () => {
 const before = await seed(), history = await pendingTitleHistory();
 const { result } = await run([{ name: "list_tasks", arguments: { date: "2066-01-09", query: "纸样", directReply: true } }], "确定", history);
 expect(result.confirmations).toEqual([]); expect(result.receipts.flatMap(receipt => receipt.taskEdits ?? [])).toHaveLength(2);
 expect(result.text).toContain("虚构新纸样甲");
 const after = (await store.readTaskDb()).tasks;
 for (const [i, row] of before.entries()) expect(after.find(task => task.id === row.id)).toMatchObject({
  title: i ? "虚构新纸样乙" : "虚构新纸样甲", date: row.date, startTime: row.startTime, endTime: row.endTime
 });
});

it.each(["先给我确认卡，等我确认。", "确认后再修改。", "先让我确认，再改这两条标题。"])("resumes the exact two title edits after a deferred request: %s", async tail => {
 const before = await seed(), history = await pendingTitleHistory(true, false, tail);
 expect(await explicitTitleEdits(store, history[0].content)).toBeUndefined();
 expect((await store.readTaskDb()).tasks).toEqual(before);
 const { result } = await run([{ name: "list_tasks", arguments: { date: "2066-01-09", query: "纸样", directReply: true } }], "确定", history);
 expect(result.confirmations).toEqual([]);
 expect(result.receipts.flatMap(receipt => receipt.taskEdits ?? [])).toHaveLength(2);
 const after = (await store.readTaskDb()).tasks;
 for (const [i, row] of before.entries()) expect(after.find(task => task.id === row.id)).toMatchObject({
  title: i ? "虚构新纸样乙" : "虚构新纸样甲", date: row.date, startTime: row.startTime, endTime: row.endTime, note: row.note
 });
});

it.each(["如果合适才改，等我确认。", "这只是举例，等我确认。", "请只讨论，不保存，等我确认。", "不要修改，等我确认。", "这句话英文怎么说？等我确认。"])("does not turn a later confirmation into authority for a non-action request: %s", async tail => {
 const before = await seed(), history = await pendingTitleHistory(true, false, tail);
 const { result } = await run([{ name: "list_tasks", arguments: { date: "2066-01-09", directReply: true } }], "确定", history);
 expect(result.receipts).toEqual([]);
 expect((await store.readTaskDb()).tasks).toEqual(before);
});

it.each(["unproven", "changed", "policy", "other-proposal"])("does not resume a deferred title request from a %s history pair", async kind => {
 const before = await seed(), history = await pendingTitleHistory(kind !== "unproven", kind === "other-proposal", "先给我确认卡，等我确认。");
 if (kind === "changed") history[1].content += "请确认。";
 if (kind === "policy") store.settings.privacy!.excludedVaultPrefixes = ["虚构另一个排除目录"];
 const { result } = await run([{ name: "list_tasks", arguments: { date: "2066-01-09", directReply: true } }], "确定", history);
 expect(result.receipts).toEqual([]);
 expect((await store.readTaskDb()).tasks).toEqual(before);
});

it.each(["unproven", "changed", "policy", "other-proposal"])("does not borrow a %s history pair as confirmation authority", async kind => {
 const before = await seed(), history = await pendingTitleHistory(kind !== "unproven", kind === "other-proposal");
 if (kind === "changed") history[1].content += "请确认。";
 if (kind === "policy") store.settings.privacy!.excludedVaultPrefixes = ["虚构另一个排除目录"];
 const { result } = await run([{ name: "list_tasks", arguments: { date: "2066-01-09", directReply: true } }], "确定", history);
 expect(result.receipts).toEqual([]); expect((await store.readTaskDb()).tasks).toEqual(before);
});

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

it("does not omit the explicit title edits when the model submits only a lookup and the new task", async () => {
  const rows = await seed();
  const { result } = await run([
    { id: "fictional-title-lookup", name: "list_tasks", arguments: { date, directReply: true } },
    { id: "fictional-only-new", name: "create_task", arguments: { title: "虚构紫色纸袋", date } }
  ], '把「虚构旧纸样0」改为「虚构新纸样甲」，把「虚构旧纸样1」改为「虚构新纸样乙」。保留原安排，再新增虚构紫色纸袋。');
  expect(result.confirmations).toEqual([]); expect(result.receipts).toHaveLength(2);
  expect((await store.getTask(rows[0].id)).title).toBe("虚构新纸样甲");
  expect((await store.getTask(rows[1].id)).title).toBe("虚构新纸样乙");
  expect((await store.readTaskDb()).tasks.at(-1)?.title).toBe("虚构紫色纸袋");
});

it("completes both exact quoted title edits when the model submits only the second plus a new task",async()=>{
 const rows=await seed();
 const {result}=await run([tool([edit(rows[1].id,"虚构新标题乙")]),{name:"create_task",arguments:{title:"虚构新增第三项",date}}],
  '把「虚构旧纸样0」改为「虚构新标题甲」，把「虚构旧纸样1」改为「虚构新标题乙」。只改这两条标题，编号、日期和原时间都保留，不要再问确认。再新增第三项。');
 expect(result.receipts.flatMap(receipt=>receipt.taskEdits??[])).toHaveLength(2);
 expect(result.text).toContain("实际更新2项");expect(result.text).toContain("虚构新标题甲");
 const after=(await store.readTaskDb()).tasks;expect(after).toHaveLength(3);
 for(const [i,row]of rows.entries())expect(after.find(task=>task.id===row.id)).toMatchObject({date:row.date,startTime:row.startTime,endTime:row.endTime,title:i===0?"虚构新标题甲":"虚构新标题乙"});
});

it("does not leave two explicit quoted corrections waiting on another model confirmation",async()=>{
 const rows=await seed();const {result}=await run([], '把「虚构旧纸样0」改为「虚构新标题甲」，把「虚构旧纸样1」改为「虚构新标题乙」。');
 expect(result.confirmations).toEqual([]);expect(result.receipts.flatMap(receipt=>receipt.taskEdits??[])).toHaveLength(2);
 expect((await store.readTaskDb()).tasks.map(task=>task.id)).toEqual(rows.map(row=>row.id));
});

it("keeps two explicit corrections when the model only schedules several new tasks in the same turn", async () => {
 const rows = await seed();
 const before = await store.readPath(store.taskDbPath());
 const { result } = await run([{ id: "fictional-new-batch", name: "schedule_task_batch", arguments: {
   date, tasks: Array.from({ length: 5 }, (_, i) => ({ title: "虚构新增整批纸袋" + i, estimateMin: 20 }))
 } }], '把「虚构旧纸样0」改为「虚构新纸样甲」，把「虚构旧纸样1」改为「虚构新纸样乙」。保留原安排，再把五项新的纸袋任务排好今天并一起保存。');
 expect(result.confirmations).toHaveLength(1); expect(result.receipts).toEqual([]);
 expect(result.confirmations[0].toolBatch?.find(call => call.name === "update_tasks")?.arguments.updates)
   .toEqual(expect.arrayContaining(rows.map(row => expect.objectContaining({ taskIdOrTitle: row.id, expectedRevision: expect.any(String) }))));
 expect(await store.readPath(store.taskDbPath())).toBe(before);
 await executeConfirmedToolBatch(result.confirmations[0], runtime, () => {});
 const after = (await store.readTaskDb()).tasks;
 expect(after).toHaveLength(7); expect(after.find(row => row.id === rows[0].id)?.title).toBe("虚构新纸样甲");
 expect(after.find(row => row.id === rows[1].id)?.title).toBe("虚构新纸样乙");
});

it("saves a small mixed correction and new batch directly with both actual receipts", async () => {
 const rows = await seed();
 const { result } = await run([{ name: "schedule_task_batch", arguments: { date, tasks: [{ title: "虚构新增一项纸袋" }] } }],
   '把「虚构旧纸样0」改为「虚构新纸样甲」，把「虚构旧纸样1」改为「虚构新纸样乙」。保留原安排，再新增虚构新增一项纸袋并安排今天。');
 expect(result.confirmations).toEqual([]); expect(result.receipts).toHaveLength(2);
 expect(result.text).toContain("实际更新2项"); expect(result.text).toContain("虚构新增一项纸袋");
 expect((await store.getTask(rows[0].id)).title).toBe("虚构新纸样甲");
 await runtime.undoLatestOperation(); await runtime.undoLatestOperation();
 expect((await store.readTaskDb()).tasks).toEqual(rows);
});

it("does not apply the explicit corrections when the mixed new batch cannot be planned", async () => {
 await seed(); const before = await store.readPath(store.taskDbPath());
 const { result } = await run([{ name: "schedule_task_batch", arguments: { date, tasks: [{ title: "虚构新增一项纸袋" }],
   availableStart: "16:00", availableEnd: "15:00" } }],
   '把「虚构旧纸样0」改为「虚构新纸样甲」，把「虚构旧纸样1」改为「虚构新纸样乙」。再安排新任务。');
 expect(result.receipts).toEqual([]); expect(result.confirmations).toEqual([]); expect(result.text).toContain("结束时间须晚于");
 expect(await store.readPath(store.taskDbPath())).toBe(before);
});

it.each(["如果确认后才执行。","这只是举例。","请只讨论，不保存。","这句话英文怎么说？","先给我确认卡，等我确认。"])("does not directly prepare a hypothetical or deferred instruction: %s",async tail=>{
 await seed();expect(await explicitTitleEdits(store,'把「虚构旧纸样0」改为「虚构新标题甲」。'+tail)).toBeUndefined();
});
it("does not guess a duplicate task name or omit an extra unparsed rename",async()=>{
 await seed();await store.createTask({title:"虚构旧纸样0",date});
 expect(await explicitTitleEdits(store,'把「虚构旧纸样0」改为「虚构新标题甲」。')).toBeUndefined();
 expect(await explicitTitleEdits(store,'把「虚构旧纸样1」改为「虚构新标题乙」，再把另一个任务改为其他内容。')).toBeUndefined();
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

const mixedMessage='把「虚构旧纸样0」改为「虚构新纸样甲」，把「虚构旧纸样1」改为「虚构新纸样乙」。再规划五项纸袋任务，给一份完整确认卡。';
const fivePlan=()=>({name:'propose_task_plan',arguments:{capacityAware:true,tasks:Array.from({length:5},(_,i)=>({
 title:`虚构混批新增纸袋${i}`,date,endDate:'2066-01-17',scheduleMode:'window',startTime:'09:00',endTime:'09:20',dueDate:'2066-01-18',dueTime:'17:30'
}))}});
const taskFacts=async()=>{
 const raw=await store.readPath(new (await import('../src/dataFoundation/operationLedger')).OperationLedger(store).filePath);
 const {getLifeOpsTool}=await import('../src/toolRegistry');
 // Read receipts remain auditable; only task mutations must be absent before approval.
 const records=(raw?JSON.parse(raw).records:[]).filter((r:any)=>getLifeOpsTool(r.toolName)?.safety==='direct-write'||r.toolName==='confirm_task_batch');
 return{db:await store.readPath(store.taskDbPath()),mirror:await store.readPath(store.taskMirrorPath()),ledger:JSON.stringify({records})};
};
it.each([false,true,'plan'] as const)('holds old edits and all new plan rows in one real card after the read phase: %s',async lookup=>{
 const rows=await seed(),before=await taskFacts();
 const {result}=await run([fivePlan()],mixedMessage,[],lookup);
 expect(await taskFacts()).toEqual(before);expect(result.receipts).toEqual([]);expect(result.confirmations).toHaveLength(1);
 const card=result.confirmations[0];expect(card.type).toBe('tool_batch');expect(card.content.split('\n')).toHaveLength(7);
 expect(card.content).toContain('虚构新纸样乙');expect(card.content).toContain('虚构混批新增纸袋4');expect(card.content).toContain('必须截止2066-01-18 17:30');
 await executeConfirmedToolBatch(card,runtime,()=>{});const after=await taskFacts();
 expect((await store.readTaskDb()).tasks).toHaveLength(7);
 expect(await store.getTask(rows[0].id)).toMatchObject({...rows[0],title:'虚构新纸样甲',updatedAt:expect.any(String)});
 expect((await store.readTaskDb()).tasks.slice(2)).toEqual(expect.arrayContaining([expect.objectContaining({title:'虚构混批新增纸袋4',date,endDate:'2066-01-17',scheduleMode:'window',dueDate:'2066-01-18',dueTime:'17:30'})]));
 await executeConfirmedToolBatch(card,runtime,()=>{});expect(await taskFacts()).toEqual(after);
 const ledger=JSON.parse(after.ledger);expect(ledger.records.filter((r:any)=>r.status==='verified'&&r.toolName==='confirm_task_batch')).toHaveLength(1);
 await runtime.undoLatestOperation();expect(await store.readPath(store.taskDbPath())).toBe(before.db);expect(await store.readPath(store.taskMirrorPath())).toBe(before.mirror);
});
it.each(['failure','stale','cancel'] as const)('preserves the whole original mixed batch on %s',async mode=>{
 const rows=await seed(),{result}=await run([fivePlan()],mixedMessage,[],true),card=result.confirmations[0];
 if(mode==='stale')await store.updateTask(rows[1].id,t=>({...t,note:'虚构外部更正'}));
 if(mode==='cancel')(await import('../src/toolBatch')).dismissRequestedToolBatch(card);
 const before=await taskFacts();
 if(mode==='failure'){
  const original=LifeOpsStore.prototype.createTask;let n=0;
  vi.spyOn(LifeOpsStore.prototype,'createTask').mockImplementation(async function(this:InstanceType<typeof LifeOpsStore>,...args){
   const result=await original.apply(this,args);if(++n===3)throw Error('虚构第三项保存失败');return result;
  });
 }
 await expect(executeConfirmedToolBatch(card,runtime,()=>{})).rejects.toThrow();
 expect(await store.readPath(store.taskDbPath())).toBe(before.db);expect(await store.readPath(store.taskMirrorPath())).toBe(before.mirror);
 if(mode==='cancel')expect(await taskFacts()).toEqual(before);
});
it('does not partially edit when a mixed project plan cannot share the task-only transaction',async()=>{
 await seed();const before=await taskFacts(),plan=fivePlan();Object.assign(plan.arguments,{projectId:'fictional-project'});
 const {result}=await run([plan],mixedMessage,[],true);expect(await taskFacts()).toEqual(before);expect(result.confirmations).toEqual([]);expect(result.text).toContain('尚未保存');
});
