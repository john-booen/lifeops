import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiChatResult, AiToolCall, ChatMessage } from "../src/ai";
import type { AgentLoopHost } from "../src/agent/AgentLoop";
import type { AgentConversationMessage } from "../src/types";
import type { StoreHost } from "../src/store/settingsSlice";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { attestAgentHistoryResponse, bindAgentHistoryResponse } from "../src/personalMemoryHistory";
import { personalMemoryContextRevision } from "../src/personalMemoryContext";
import { memorySourcePolicy, readPersonalMemoryWithSources } from "../src/personalMemorySources";

vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, Modal: class {},
  normalizePath: (s: string) => s.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), requestUrl: vi.fn(),
  parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { createFsApp } = await import("./helpers/fsApp");
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { AgentLoop } = await import("../src/agent/AgentLoop");
const { executeConfirmedToolBatch } = await import("../src/toolBatch");
let root: string, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
const today = new Date(2026, 10, 26, 8, 30);
const call = (name: string, args: Record<string, unknown>, id = name): AiToolCall => ({ name, arguments: args, id });
const reply = (toolCalls: AiToolCall[] = [], content = ""): AiChatResult => ({ toolCalls, content });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(today);
  root = await mkdtemp(join(tmpdir(), "lifeops-subject-continuity-"));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.ai = { ...settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", model: "synthetic", dataDisclosureAccepted: true };
  settings.privacy = { excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
  store = new LifeOpsStore(createFsApp(root), settings) as unknown as StoreHost;
  await store.initializeVault(); runtime = new AgentRuntime({ store, refreshViews: async () => {} });
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function pair(user: string, assistant: string): Promise<AgentConversationMessage[]> {
  const messages: AgentConversationMessage[] = [{ role: "user", content: user }, { role: "assistant", content: assistant }];
  const { records } = await readPersonalMemoryWithSources(store);
  const response = attestAgentHistoryResponse({ reply: assistant, actions: [] }, store,
    personalMemoryContextRevision(records), memorySourcePolicy(store), user);
  bindAgentHistoryResponse(response, messages[0], messages[1]);
  return messages;
}
async function fixture() {
  const group = [];
  for (const title of ["虚构蓝鲸资料逐项核对并整理归档", "虚构星河样品登记后补齐来源备注", "虚构海盐纸样清点并处理待办事项", "虚构灯塔备忘汇总并清理过期草案"])
    group.push(await store.createTask({ title, date: "2026-11-23", startTime: "19:30", endTime: "20:00" }));
  const other = await store.createTask({ title: "虚构银杏邮箱更换绑定地址", date: "2026-11-28", time: "10:00" });
  const ongoing = await store.createTask({ title: "虚构紫杉期间资料整理", date: "2026-11-21", endDate: "2026-11-27", scheduleMode: "window" });
  const list = "逾期的四项均在11月23日：\n" + group.map((task, i) => `${i + 1}. ${task.title}，19:30–20:00。`).join("\n")
    + `\n本周期间还有${ongoing.title}。`;
  const history = [
    ...await pair("本周还有什么没有完成？", list),
    ...await pair("统一安排在周六周日。", "（被打断）"),
    ...await pair("工作日没时间处理了。", `要不要把「${ongoing.title}」挪到周末？`)
  ];
  return { group, other, ongoing, history, list };
}
async function run(responses: AiChatResult[], history: AgentConversationMessage[], message = "挪到周日吧，周六也有事情。", source: "text" | "voice" = "voice") {
  const requests: ChatMessage[][] = [];
  const host: AgentLoopHost = { store, settings: store.settings,
    aiForRole: () => ({ agentTurnStream: async messages => {
      requests.push(structuredClone(messages)); return responses.shift() ?? reply([], "本批尚未修改，请核对原对象。");
    } }),
    executeTools: async (calls, userMessage, signal, onResult) => {
      const results = [];
      for (const item of calls) {
        const result = await runtime.executeAiToolCall(item, "kimi", userMessage, { assertCurrent: () => signal?.throwIfAborted() });
        onResult(item, result); results.push(result);
      }
      return results;
    }, offlineFallback: async () => null };
  return { result: await new AgentLoop(host).run({ message, history, source, now: today }), requests };
}
async function writes() {
  const { OperationLedger } = await import("../src/dataFoundation/operationLedger");
  const path = new OperationLedger(store).filePath;
  const ledger = store.getFile(path) ? JSON.parse(await store.readPath(path)) as { records: { toolName: string; status: string }[] } : { records: [] };
  return ledger.records.filter(row => ["reschedule_task", "update_tasks", "complete_task", "delete_task", "create_task"].includes(row.toolName));
}

it("preserves the original list and interrupted group request in the actual fast voice model input", async () => {
  const { history, list, group } = await fixture();
  const { requests } = await run([reply([], "请核对要挪的是逾期四项，还是包含期间任务。")], history);
  expect(requests[0].some(row => row.role === "assistant" && row.content === list)).toBe(true);
  for (const task of group) expect(JSON.stringify(requests[0])).toContain(task.title);
  expect(requests[0]).toContainEqual({ role: "user", content: "统一安排在周六周日。" });
});

for (const source of ["text", "voice"] as const) {
  it.each(["reschedule_task", "update_tasks", "complete_task", "delete_task"])(`rejects an unrelated destination lookup target before any write or card: ${source}, %s`, async name => {
    const { other, history } = await fixture(), before = await store.readPath(store.taskDbPath());
    const args = name === "update_tasks" ? { updates: [{ taskIdOrTitle: other.id, date: "2026-11-29" }] }
      : { taskIdOrTitle: other.id, ...(name === "reschedule_task" ? { date: "2026-11-29" } : {}) };
    const { result } = await run([reply([call("list_tasks", { date: "2026-11-28", answerMode: "continue" })]),
      reply([call(name, args)]), reply([], "所查的周六任务并非原对象，本批未修改。")], history, undefined, source);
    expect(result.receipts).toEqual([]); expect(result.confirmations).toEqual([]);
    expect(result.toolCalls).toContainEqual({ name, ok: false });
    expect(await store.readPath(store.taskDbPath())).toBe(before); expect(await writes()).toEqual([]);
  });
}

it("rejects unique title fragments too, and does not partially save a mixed new/edit proposal", async () => {
  const { other, history } = await fixture(), before = await store.readPath(store.taskDbPath());
  const { result } = await run([reply([call("update_tasks", { updates: [{ taskIdOrTitle: "银杏邮箱", date: "2026-11-29" }] }),
    call("create_task", { title: "虚构不应提前保存的新项", date: "2026-11-29" })])], history);
  expect(result.receipts).toEqual([]); expect(result.confirmations).toEqual([]); expect(await writes()).toEqual([]);
  expect(await store.readPath(store.taskDbPath())).toBe(before); expect((await store.getTask(other.id)).date).toBe("2026-11-28");
});

it("repairs the rejected target in the same turn, previews all four, confirms once and deduplicates repeat approval", async () => {
  const { group, other, ongoing, history } = await fixture(), before = await store.readPath(store.taskDbPath());
  const update = vi.spyOn(store, "updateTask");
  const { result } = await run([
    reply([call("list_tasks", { date: "2026-11-28", answerMode: "continue" })]),
    reply([call("reschedule_task", { taskIdOrTitle: other.id, date: "2026-11-29" })]),
    reply([call("update_tasks", { updates: group.map(task => ({ taskIdOrTitle: task.id, date: "2026-11-29" })) })])
  ], history);
  expect(result.confirmations).toHaveLength(1); expect(result.receipts).toEqual([]);
  expect(await store.readPath(store.taskDbPath())).toBe(before); expect(await writes()).toEqual([]); expect(update).not.toHaveBeenCalled();
  const action = result.confirmations[0];
  expect(action.toolBatch?.[0].arguments.updates).toHaveLength(4);
  await executeConfirmedToolBatch(action, runtime, () => {});
  await executeConfirmedToolBatch(action, runtime, () => {});
  expect(update).toHaveBeenCalledTimes(4); expect(await writes()).toHaveLength(1);
  for (const task of group) expect(await store.getTask(task.id)).toMatchObject({ ...task, date: "2026-11-29", updatedAt: expect.any(String) });
  expect(await store.getTask(other.id)).toEqual(other); expect(await store.getTask(ongoing.id)).toEqual(ongoing);
});

it("lets the user explicitly name a new subject and leaves the earlier group alone", async () => {
  const { group, other, history } = await fixture();
  const { result } = await run([reply([call("reschedule_task", { taskIdOrTitle: other.id, date: "2026-11-29" })])],
    history, `前面的先保留，另把「${other.title}」挪到周日。`);
  expect(result.receipts).toHaveLength(1); expect((await store.getTask(other.id)).date).toBe("2026-11-29");
  for (const task of group) expect(await store.getTask(task.id)).toEqual(task);
});

it("preserves an explicit source-date lookup when there is no prior task subject", async () => {
  const { other } = await fixture();
  const { result } = await run([reply([call("list_tasks", { date: "2026-11-28", answerMode: "continue" })]),
    reply([call("reschedule_task", { taskIdOrTitle: other.id, date: "2026-11-29" })])], [], "把11月28日的任务移到周日。");
  expect(result.receipts).toHaveLength(1); expect((await store.getTask(other.id)).date).toBe("2026-11-29");
});

it("binds legacy four-move cards to one atomic update and freezes dates across midnight", async () => {
  const { group, other, history } = await fixture();
  await store.updateTask(group[0].id, task => ({...task, endDate: "2026-11-25", scheduleMode: "window", dueDate: "2026-12-02", dueTime: "17:00"}));
  const { result } = await run([reply(group.map(task => call("reschedule_task", {taskIdOrTitle: task.title, date: "本周日"}, task.id)))], history);
  const action = result.confirmations[0];
  expect(action.toolBatch).toHaveLength(1); expect(action.toolBatch?.[0].name).toBe("update_tasks");
  const updates = action.toolBatch?.[0].arguments.updates as Record<string, unknown>[];
  expect(updates).toHaveLength(4);
  for (const row of updates) { expect(row.date).toBe("2026-11-29"); expect(typeof row.expectedRevision).toBe("string"); }
  vi.setSystemTime(new Date(2026, 10, 30, 9));
  await executeConfirmedToolBatch(action, runtime, () => {});
  for (const task of group) expect((await store.getTask(task.id)).date).toBe("2026-11-29");
  expect(await store.getTask(group[0].id)).toMatchObject({endDate: "2026-12-01", dueDate: "2026-12-02", dueTime: "17:00"});
  expect(await store.getTask(other.id)).toEqual(other); expect(await writes()).toHaveLength(1);
});

it("rejects an entire legacy four-move card if any original task changes before confirmation", async () => {
  const { group, history } = await fixture();
  const { result } = await run([reply(group.map(task => call("reschedule_task", {taskIdOrTitle: task.id, date: "本周日"}, task.id)))], history);
  await store.updateTask(group[3].id, task => ({...task, note: "虚构并行修改，应保留"}));
  const before = await store.readPath(store.taskDbPath());
  await expect(executeConfirmedToolBatch(result.confirmations[0], runtime, () => {})).rejects.toThrow("过期");
  expect(await store.readPath(store.taskDbPath())).toBe(before); expect((await writes()).filter(row => row.status === "verified")).toEqual([]);
});

it("preserves an independent deadline when directly moving an explicitly named period task", async () => {
  const { ongoing } = await fixture();
  await store.updateTask(ongoing.id, task => ({...task, dueDate: "2026-12-05", dueTime: "17:00"}));
  const response = await runtime.executeAiToolCall(call("reschedule_task", {taskIdOrTitle: ongoing.id, date: "2026-11-23"}), "kimi", `把「${ongoing.title}」移到11月23日。`);
  expect(response.success).toBe(true);
  expect(await store.getTask(ongoing.id)).toMatchObject({date: "2026-11-23", endDate: "2026-11-29", dueDate: "2026-12-05", dueTime: "17:00"});
});

it("keeps the original action words when a model-selected create omits a leading part of the action", async () => {
  const result = await runtime.executeAiToolCall(call("create_task", {title: "虚构蓝鲸盒贴标签", date: "2026-11-27", endTime: "15:00"}),
    "kimi", "明天下午三点前给虚构蓝鲸盒贴标签。");
  expect(result.success).toBe(true);
  expect((await store.readTaskDb()).tasks).toMatchObject([{title: "给虚构蓝鲸盒贴标签", date: "2026-11-27", endTime: "15:00"}]);
});
