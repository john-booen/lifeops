import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatResult, AiToolCall, ChatMessage } from "../src/ai";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { addDays, formatDate, todayString } from "../src/date";
import type { StoreHost } from "../src/store/settingsSlice";
import type { AgentLoopHost, AgentTurnInput } from "../src/agent/AgentLoop";
import type { AgentModelRole } from "../src/agent/models";
import type { HealthEntry } from "../src/types";
import type { FactOperationOptions } from "../src/dataFoundation/factOperation";

const healthForm = vi.hoisted(() => ({ submit: undefined as ((entry: HealthEntry) => Promise<void>) | undefined }));
vi.mock("../src/modals", async importOriginal => ({
  ...await importOriginal<typeof import("../src/modals")>(),
  HealthEntryModal: class {
    constructor(_app: unknown, private readonly submit: (entry: HealthEntry) => Promise<void>) {}
    open() { healthForm.submit = this.submit; }
  }
}));

vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {},
  Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  parseYaml: (yaml: string) => JSON.parse(yaml), stringifyYaml: (fields: unknown) => JSON.stringify(fields),
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: vi.fn()
}));
const { createFsApp } = await import("./helpers/fsApp");
const { LifeOpsStore } = await import("../src/store");
const { LifeOpsAi } = await import("../src/ai");
const { default: Plugin } = await import("../src/main");
const { runAgentTurn } = await import("../src/agent/run");
const { AgentRuntime } = await import("../src/agentRuntime");
const { OperationLedger } = await import("../src/dataFoundation/operationLedger");
const { AgentLoop } = await import("../src/agent/AgentLoop");
const { voiceJobSpeech } = await import("../src/voice/jobs");
const { hasGroundedSpeechNumbers } = await import("../src/voice/summaryNumbers");
const { buildResidentContext, RESIDENT_CONTEXT_BYTE_LIMIT } = await import("../src/agent/context");
const { settingsForAgentModel } = await import("../src/agent/models");
const { executeConfirmedToolBatch } = await import("../src/toolBatch");
const { readTradeDatabase } = await import("../src/features/trading/persistence");
const { runConfirmedToolAction } = await import("../src/toolRegistry");
const now = new Date("2026-11-12T12:00:00+08:00");
let root: string, store: StoreHost, host: AgentLoopHost, runtime: InstanceType<typeof AgentRuntime>;
let responses: Array<AiChatResult | Error>, requests: ChatMessage[][], roles: AgentModelRole[];
let catalogs: string[][], toolChoices: unknown[];

it("replaces leaked tool protocol with one text-only answer using the originals already read", async () => {
  await store.appendDaily("2026-11-03", "日记", "虚构纸样整理原话。", "早", "虚构纸样整理原话。");
  const leaked = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="create_task">\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
  const answer = "11月3日的原话是“虚构纸样整理原话”。这不是已完成记录。";
  const fake = host.aiForRole;
  host.aiForRole = role => ({ agentTurnStream: (messages, onText, options) => fake(role).agentTurnStream(messages, text => {
    for (const length of [1, 4, 12, text.length]) onText(text.slice(0, length));
  }, options) });
  responses.push(reply("", [tool("query_vault", { domain: "journal", operation: "get", date: "2026-11-03", period: "早" })]),
    reply(leaked), reply(answer));
  const streamed: string[] = [], before = await store.readPath(store.taskDbPath());
  const result = await new AgentLoop(host).run(input({ message: "请按原话解释11月3日的虚构纸样记录，不修改。", onText: text => streamed.push(text) }));
  expect(result.text).toBe(answer);
  expect(streamed.join("")).toBe(answer);
  expect(result.receipts).toEqual([]);
  expect(result.toolCalls).toEqual([{ name: "query_vault", ok: true }]);
  expect(await store.readPath(store.taskDbPath())).toBe(before);
  expect(requests).toHaveLength(3); expect(catalogs.at(-1)).toEqual([]); expect(toolChoices.at(-1)).toBe("none");
  expect(roles.at(-1)).toBe("deep");
  expect(requests.at(-1)?.some(message => message.role === "tool" || message.tool_calls?.length)).toBe(false);
  expect(JSON.stringify(requests.at(-1))).toContain("虚构纸样整理原话");
  expect(JSON.stringify(requests.at(-1))).not.toContain("DSML");
});

it.each(["text", "native-call", "repeat"])("never executes leaked writes or retries indefinitely when repair returns %s", async mode => {
  const leaked = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="create_task"></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
  responses.push(reply(leaked), mode === "repeat" ? reply(leaked) : mode === "native-call"
    ? reply("", [tool("create_task", { title: "虚构泄漏任务" })]) : reply("已读请求，本次没有保存任何任务。"));
  const before = await store.readPath(store.taskDbPath()), streamed: string[] = [];
  const result = await new AgentLoop(host).run(input({ message: "请解释虚构纸样归档的原则，只讨论，不保存。", onText: value => streamed.push(value) }));
  expect(result.toolCalls).toEqual([]); expect(result.receipts).toEqual([]);
  expect(await store.readPath(store.taskDbPath())).toBe(before);
  expect(requests).toHaveLength(2); expect(catalogs[1]).toEqual([]); expect(toolChoices[1]).toBe("none");
  expect(result.text).not.toContain("DSML"); expect(streamed.join("")).not.toContain("DSML");
});

it.each(["privacy", "cancel"])("does not send a protocol repair after %s changed", async change => {
  const controller = new AbortController(), fake = host.aiForRole;
  host.aiForRole = role => ({ agentTurnStream: async (messages, onText, options) => {
    const response = await fake(role).agentTurnStream(messages, onText, options);
    if (change === "privacy") store.settings.privacy!.excludedVaultPrefixes = ["虚构不再准读"];
    else controller.abort();
    return response;
  } });
  responses.push(reply("<｜｜DSML｜｜ calls></｜｜DSML｜｜ calls>"));
  const streamed: string[] = [];
  await expect(new AgentLoop(host).run(input({ message: "解释虚构纸样记录，不修改。", signal: controller.signal,
    onText: value => streamed.push(value) }))).rejects.toMatchObject({ name: "AbortError" });
  expect(requests).toHaveLength(1); expect(streamed.join("")).not.toContain("DSML");
});

it("keeps a successful write receipt without replaying it after protocol leakage", async () => {
  responses.push(reply("", [tool("create_task", { title: "虚构已保存紫纸" })]),
    reply("<｜｜DSML｜｜ calls></｜｜DSML｜｜ calls>"), reply("虚构已保存紫纸已经保存，没有执行额外操作。"));
  const result = await new AgentLoop(host).run(input({ message: "帮我保存一项待办，名称虚构已保存紫纸，不安排时间，再简单说明。" }));
  expect((await store.readTaskDb()).tasks.map(task => task.title)).toEqual(["虚构已保存紫纸"]);
  expect(result.receipts).toHaveLength(1); expect(result.toolCalls).toEqual([{ name: "create_task", ok: true }]);
  expect(requests).toHaveLength(3); expect(catalogs.at(-1)).toEqual([]);
});

it("keeps ordinary text starting with a less-than sign without invoking protocol recovery", async () => {
  const text = "<虚构纸样>只是普通文本。", fake = host.aiForRole;
  host.aiForRole = role => ({ agentTurnStream: (messages, onText, options) => fake(role).agentTurnStream(messages, value => {
    for (const length of [1, 2, value.length]) onText(value.slice(0, length));
  }, options) });
  responses.push(reply(text)); const streamed: string[] = [];
  const result = await new AgentLoop(host).run(input({ message: "给一行虚构占位符说明，不执行操作。", onText: value => streamed.push(value) }));
  expect(result.text).toBe(text); expect(streamed.join("")).toBe(text); expect(requests).toHaveLength(1);
});

it("turns a model's unsupported eleven-task card claim into one real confirmation before any save", async () => {
  const model = host.aiForRole;
  host.aiForRole = role => ({agentTurnStream:(messages,onText,options)=>{
    if(typeof options?.toolChoice==='object'&&options.toolChoice.function.name==='resolve_task_lookup') {
      expect(options.preferFinite).toBe(true);
      expect(options.reasoning).toBe('disabled');
    }
    return model(role).agentTurnStream(messages,onText,options);
  }});
  const tasks = [];
  for (let i = 0; i < 11; i++) tasks.push(await store.createTask({ title: "虚构补卡纸样" + i, date: "2026-11-12", startTime: "20:00", endTime: "20:30" }));
  const before = await store.readPath(store.taskDbPath());
  responses.push(reply("", [tool("list_tasks", { date: "2026-11-12", query: "虚构补卡纸样" })]),
    reply("确认卡已经生成，请确认下面11项；这些只是模型写出的表格。"),
    reply("", [tool("resolve_task_lookup", { kind: "prepare_updates", coversAllRequested: true, updates: tasks.map((task, i) => ({
      taskIdOrTitle: task.id, title: task.title, note: task.note, date: task.date,
      startTime: String(i + 9).padStart(2, "0") + ":00", endTime: String(i + 9).padStart(2, "0") + ":30"
    })) })]), reply("请核对实际生成的修改确认卡。"));
  const streamed: string[] = [];
  const result = await new AgentLoop(host).run(input({ message: "请把虚构补卡纸样十一条统一改为从09:00起每小时一条、每条30分钟，先生成一份确认卡，等我确认再保存。", onText: text => streamed.push(text) }));
  expect(result.confirmations).toHaveLength(1); expect(result.confirmations[0].type).toBe("tool_batch");
  expect(result.confirmations[0].toolBatch).toHaveLength(1);
  expect(result.confirmations[0].toolBatch![0].name).toBe("update_tasks");
  expect((result.confirmations[0].toolBatch![0].arguments.updates as unknown[])).toHaveLength(11);
  for (const row of result.confirmations[0].toolBatch![0].arguments.updates as Array<Record<string, unknown>>) {
    expect(Object.keys(row).sort()).toEqual(["taskIdOrTitle", "date", "startTime", "endTime", "expectedRevision"].sort());
  }
  expect(await store.readPath(store.taskDbPath())).toBe(before); expect(result.receipts).toEqual([]);
  expect(streamed.join("")).not.toContain("这些只是模型写出的表格");
  expect(toolChoices).toContainEqual({ type: "function", function: { name: "resolve_task_lookup" } });
});

it.each(["unknown-target", "duplicate-target", "not-complete", "plain-prose", "read-only"])("keeps lookup recovery read-only for %s", async mode => {
  const tasks = [];
  for (let i = 0; i < 4; i++) tasks.push(await store.createTask({ title: "虚构保护清单" + i, date: "2026-11-12", startTime: "20:00", endTime: "20:30" }));
  const before = await store.readPath(store.taskDbPath());
  const updates = tasks.map(task => ({ taskIdOrTitle: task.id, startTime: "13:00", endTime: "13:30" }));
  if (mode === "unknown-target") updates[0].taskIdOrTitle = "fictional-unread-task";
  if (mode === "duplicate-target") updates[1].taskIdOrTitle = updates[0].taskIdOrTitle;
  const recovered = mode === "plain-prose" ? reply("我又说了一遍确认卡已生成。") : reply("", [tool("resolve_task_lookup",
    mode === "read-only" ? { kind: "read_only", reply: "共有4条允许读取的任务。" }
      : { kind: "prepare_updates", coversAllRequested: mode !== "not-complete", updates })]);
  responses.push(reply("", [tool("list_tasks", { date: "2026-11-12", query: "虚构保护清单" })]), reply("确认卡已经生成。"), recovered);
  const result = await new AgentLoop(host).run(input({ message: mode === "read-only" ? "请解释虚构保护清单的安排，只讨论，不修改。" : "请把虚构保护清单四项都改到13点至13点半，先给完整确认卡。" }));
  expect(result.confirmations).toEqual([]); expect(result.receipts).toEqual([]);
  expect(await store.readPath(store.taskDbPath())).toBe(before);
  expect(result.text).toContain(mode === "read-only" ? "共有4条" : "尚未生成可执行的调整卡");
  expect(result.text).not.toContain("确认卡已经生成");
});

it("keeps the remaining creation tools after exact titles have been saved, without relisting the completed edits", async () => {
  await store.createTask({ title: "虚构旧标题甲", date: "2026-11-13", time: "15:00" });
  await store.createTask({ title: "虚构旧标题乙", date: "2026-11-13", time: "16:00" });
  responses.push(reply("", [tool("update_tasks", { updates: [{ taskIdOrTitle: "虚构旧标题甲", title: "虚构新标题甲" },
    { taskIdOrTitle: "虚构旧标题乙", title: "虚构新标题乙" }] })]),
    reply("", [tool("create_task", { title: "给虚构紫色纸袋编号", date: "2026-11-13", time: "17:00" }, "new-paper-bag")]), reply("已保存。"));
  const result = await new AgentLoop(host).run(input({ message: "把「虚构旧标题甲」改为「虚构新标题甲」，把「虚构旧标题乙」改为「虚构新标题乙」。再新增一条明天17:00给虚构紫色纸袋编号。" }));
  expect(catalogs[0]).toEqual(expect.arrayContaining(["update_tasks", "list_tasks"]));
  expect(catalogs[1]).toContain("create_task"); expect(catalogs[1]).toContain("schedule_task_batch");
  expect(catalogs[1]).toContain("query_vault");
  expect(catalogs[1]).not.toContain("update_tasks"); expect(catalogs[1]).not.toContain("list_tasks");
  expect((await store.readTaskDb()).tasks.map(task => task.title)).toEqual(["虚构新标题甲", "虚构新标题乙", "给虚构紫色纸袋编号"]);
  expect(result.receipts).toHaveLength(2);
});

it("keeps read and update tools when the exact title operation did not save", async () => {
  const task = await store.createTask({ title: "虚构未保存旧标题" });
  responses.push(reply("", [tool("update_tasks", { updates: [{ taskIdOrTitle: "虚构不存在标题", title: "虚构新标题" }] })]), reply("没有执行修改。"));
  await new AgentLoop(host).run(input({ message: "把「虚构未保存旧标题」改为「虚构新标题」。" }));
  expect(catalogs[1]).toEqual(expect.arrayContaining(["update_tasks", "list_tasks"]));
  expect((await store.readTaskDb()).tasks.find(row => row.id === task.id)?.title).toBe("虚构未保存旧标题");
});

it("can still list the requested records through the read-only query after the exact title edits", async () => {
  await store.createTask({ title: "虚构查询旧标题", date: "2026-11-13", time: "15:00" });
  responses.push(reply("", [tool("update_tasks", { updates: [{ taskIdOrTitle: "虚构查询旧标题", title: "虚构查询新标题" }] })]),
    reply("", [tool("query_vault", { domain: "task", operation: "list", date: "2026-11-13" }, "read-after-edit")]), reply("明天有虚构查询新标题。"));
  const result = await new AgentLoop(host).run(input({ message: "把「虚构查询旧标题」改为「虚构查询新标题」。然后列出明天的任务。" }));
  expect(result.toolCalls).toContainEqual({ name: "query_vault", ok: true });
  expect(JSON.stringify(requests.at(-1))).toContain("虚构查询新标题");
  expect((await store.readTaskDb()).tasks).toHaveLength(1); expect(result.receipts).toHaveLength(1);
});

it("reads dated originals when the model expands the user's topic with unrelated AND terms", async () => {
  const paths = ["2026/10/2026-10-28晚.md", "2026/11/2026-11-04晚.md"].map(path => store.path(store.settings.folders.dailyRoot, path));
  for (const path of paths) await store.writeFile(path, "虚构纸样归档：一段连续25分钟完成纸样。" );
  responses.push(reply("", [tool("get_summaries", { level: "week", range: { from: "2025-10-26", to: "2025-11-08" },
    includeOriginals: true, query: "纸样 归档 虚纸 裁剪 纸样归档" })]), reply("尚未核对的虚构草稿。"), reply("已核对两篇原始日记。"));
  const execute = vi.spyOn(host, "executeTools");
  const result = await new AgentLoop(host).run(input({ message: "回顾10月26日到11月8日这两周的虚构纸样归档，读摘要与原始日记。",
    history: [{ role: "user", content: "先核对2026-11-02的虚构任务，接着再聊归档。" }] }));
  expect(result.toolCalls).toContainEqual({ name: "get_summaries", ok: true });
  expect(execute.mock.calls[0][0][0].arguments.query).toBe("纸样 归档 纸样归档");
  expect(execute.mock.calls[0][0][0].arguments.range).toEqual({ from: "2026-10-26", to: "2026-11-08" });
  const evidence = JSON.stringify(requests.at(-1));
  for (const path of paths) { expect(evidence).toContain(path); expect(await store.readPath(path)).toContain("一段连续25分钟"); }
  expect(result.receipts).toEqual([]);
});

async function historicalFixture(): Promise<AiChatResult> {
  await store.appendDaily("2026-11-03", "日记", "虚构紫纸已整理10张。没登记打卡，未写原因。<img src=x> [执行](fiction://no)", "晚");
  return reply("", [tool("get_summaries", { level: "week", range: { from: "2026-11-02", to: "2026-11-08" }, includeOriginals: true })]);
}

it("reads the requested multi-day journal originals instead of spending rounds listing the current week", async () => {
  await store.appendDaily("2026-11-04", "日记", "昨晚21:15到家，23:40开始，今早00:20结束整理，08:00起床。", "早");
  await store.appendDaily("2026-11-05", "日记", "昨晚22:10完成黄纸袋标记，今早07:30起床。青色纸盒编号是今天计划，尚未完成。", "早");
  responses.push(reply("", [tool("query_vault", { domain: "journal", operation: "list", range: "week", date: "2026-11-02", limit: 40 })]),
    reply("虚构未核对草稿"), reply("来源11月4日早、11月5日早；11月3日21:15到家，23:40开始；11月4日00:20结束、08:00起床、22:10标记；11月5日07:30起床，青色纸盒编号仅计划。"));
  const before = await store.readPath(store.taskDbPath());
  const result = await new AgentLoop(host).run(input({ message: "请只查2026年11月2日至11月8日的原始日记，按事件实际发生日期列出到家、整理、标记与起床，给出来源，不修改任务。" }));
  expect(requests).toHaveLength(3); expect(result.toolCalls).toEqual([{ name: "get_summaries", ok: true }]);
  expect(result.text).toContain("00:20"); expect(result.text).not.toContain("虚构未核对草稿");
  const evidence = JSON.stringify(requests.at(-1));
  for (const text of ["2026-11-04早.md", "2026-11-05早.md", "21:15", "00:20", "尚未完成"]) expect(evidence).toContain(text);
  expect(evidence).not.toContain("2026-11-09"); expect(result.receipts).toEqual([]); expect(result.confirmations).toEqual([]);
  expect(await store.readPath(store.taskDbPath())).toBe(before);
});

it.each(["facts", "continue"] as const)("honors the model-selected %s mode for a period lookup", async answerMode => {
  await store.createTask({ title: "虚构水杉卡片归档", date: "2026-11-06", endDate: "2026-11-12", estimateMin: 600 });
  const before = await store.readPath(store.taskDbPath());
  responses.push(reply("", [tool("list_tasks", { query: "虚构水杉卡片归档", status: "all", answerMode })]));
  responses.push(reply(answerMode === "continue" ? "虚构完整解释，保留后续请求。" : "要不要再帮你改期？"));
  const result = await new AgentLoop(host).run(input({ message: "查一下虚构水杉卡片归档的安排。这是这段日期内分次完成的任务，请告诉我是期间任务还是明天必须全部做完、计划哪天结束，有没有另设必须截止日期。不要修改或新建任何记录。" }));
  expect(requests).toHaveLength(2);
  if (answerMode === "facts") {
    expect(result.text).toContain("期间任务"); expect(result.text).toContain("计划完成：2026-11-12"); expect(result.text).toContain("必须截止：未另设");
  } else expect(result.text).toBe("虚构完整解释，保留后续请求。");
  expect(result.text).not.toMatch(/[？?]/u); expect(result.confirmations).toEqual([]); expect(result.receipts).toEqual([]);
  expect(await store.readPath(store.taskDbPath())).toBe(before);
});
it("does not let an early facts hint stop a requested four-task modification", async () => {
  const rows=[];for(let i=0;i<4;i++)rows.push(await store.createTask({title:`虚构整批事实${i}`,date:"2026-11-12",startTime:"16:00",endTime:"16:30"}));
  const before=await store.readPath(store.taskDbPath());
  responses.push(reply("",[tool("list_tasks",{query:"虚构整批事实",answerMode:"facts"})]),
    reply("",[tool("update_tasks",{updates:rows.map(row=>({taskIdOrTitle:row.id,startTime:"15:00",endTime:"15:30"}))})]),
    reply("四条修改已整理为一张确认卡，尚未保存。"));
  const result=await new AgentLoop(host).run(input({message:"把虚构整批事实四条原任务都改到15:00至15:30，给一份确认卡，等我确认后再保存。"}));
  expect(requests).toHaveLength(2);expect(result.confirmations).toHaveLength(1);
  expect((result.confirmations[0].toolBatch![0].arguments.updates as unknown[])).toHaveLength(4);
  expect(result.receipts).toEqual([]);expect(await store.readPath(store.taskDbPath())).toBe(before);
});

it.each(["查一下虚构蓝盒相关未完成任务，不限定日期，先不要修改。", "查一下虚构蓝盒相关未完成任务，不限定日期。"])("finishes a simple named task lookup with verified dates and no second model request (%s)", async message => {
  await store.createTask({ title: "虚构蓝盒贴标签", date: "2026-11-13", time: "15:15" });
  await store.createTask({ title: "虚构蓝盒核对编号", date: "2026-11-14", time: "16:00" });
  responses.push(reply("", [tool("list_tasks", { query: "虚构蓝盒" })]), new Error("Must not ask another model to restate an already verified list"));
  const before = await store.readPath(store.taskDbPath()), streamed: string[] = [];
  const result = await new AgentLoop(host).run(input({ message, onText: text => streamed.push(text) }));
  expect(requests).toHaveLength(1); expect(result.text).toContain("所有日期");
  for (const text of ["2026-11-13", "15:15", "2026-11-14", "16:00", "贴标签", "核对编号"]) expect(result.text).toContain(text);
  expect(result.text).not.toMatch(/[？?]/u); expect(streamed.join("")).toBe(result.text);
  expect(result.receipts).toEqual([]); expect(result.confirmations).toEqual([]);
  expect(await store.readPath(store.taskDbPath())).toBe(before); expect(result.usage.model).toBe("synthetic-model");
});

it("retains the normal model continuation for an explicit task explanation or directReply false", async () => {
  await store.createTask({ title: "虚构蓝盒说明", date: "2026-11-13" });
  for (const [message, args] of [["查虚构蓝盒任务，解释日期差异，不修改。", { query: "虚构蓝盒" }],
    ["查虚构蓝盒任务，不修改。", { query: "虚构蓝盒", directReply: false }]] as const) {
    responses.push(reply("", [tool("list_tasks", args)]), reply("虚构解释正文，保留用户明确要求。"));
    const before = requests.length, result = await new AgentLoop(host).run(input({ message }));
    expect(requests.length - before).toBe(2); expect(result.text).toContain("虚构解释正文");
  }
});

it("discards the direct read-only task answer if the source changes after its tool read", async () => {
  await store.createTask({ title: "虚构蓝盒旧来源", date: "2026-11-13" });
  const execute = host.executeTools; let stale = false;
  host.assertReadOnlyReplyCurrent = () => { if (stale) throw new DOMException("fictional source changed", "AbortError"); };
  host.executeTools = async (...args) => { const rows = await execute(...args); stale = true; return rows; };
  responses.push(reply("", [tool("list_tasks", { query: "虚构蓝盒" })]));
  const streamed: string[] = [];
  await expect(new AgentLoop(host).run(input({ message: "查虚构蓝盒任务，不修改。", onText: text => streamed.push(text) }))).rejects.toMatchObject({ name: "AbortError" });
  expect(requests).toHaveLength(1); expect(streamed.join("")).toBe("");
});

it("finishes historical text with one complete tools-free grounded answer, never streaming the discarded draft", async () => {
  const answer = "11月3日记载整理10张；没登记，原因未知，其余日期也无法据此判断。";
  const original = host.aiForRole, finalOptions: unknown[] = [];
  host.aiForRole = role => ({ agentTurnStream: (messages, onText, options) => {
    if (role === "deep") finalOptions.push(options);
    return original(role).agentTurnStream(messages, onText, options);
  } });
  responses.push(await historicalFixture(), reply("虚构未核实草稿：记录方式出了问题。"), reply(answer));
  const streamed: string[] = [], before = await store.readPath(store.taskDbPath());
  const result = await new AgentLoop(host).run(input({ message: "核对11月2日到8日原文，没打卡是否一周都没做？不修改。", onText: value => streamed.push(value) }));
  expect(result.text).toBe(answer); expect(streamed.join("")).toBe(answer);
  expect(requests).toHaveLength(3); expect(roles.at(-1)).toBe("deep");
  expect(catalogs.at(-1)).toEqual([]); expect(toolChoices.at(-1)).toBe("none");
  expect(finalOptions).toEqual([expect.objectContaining({ reasoning: "disabled", preferFinite: true, maxTokens: 4096, timeoutMs: 45_000, toolChoice: "none" })]);
  const final = requests.at(-1)!;
  expect(final.some(message => message.role === "tool" || message.tool_calls?.length)).toBe(false);
  expect(JSON.stringify(final)).toContain("虚构紫纸已整理10张");
  expect(JSON.stringify(final)).not.toContain("虚构未核实草稿");
  expect(result.receipts).toEqual([]); expect(result.confirmations).toEqual([]);
  expect(await store.readPath(store.taskDbPath())).toBe(before);
});

it.each(["network", "empty", "native-call", "protocol"])("retains literal historical evidence when final analysis returns %s", async mode => {
  responses.push(await historicalFixture(), reply("错误草稿：一周都没做。"), mode === "network" ? new Error("fictional network failure")
    : mode === "native-call" ? reply("", [tool("create_task", { title: "虚构不应执行" })])
    : reply(mode === "protocol" ? "<｜｜DSML｜｜ calls></｜｜DSML｜｜ calls>" : ""));
  const streamed: string[] = [], before = await store.readPath(store.taskDbPath());
  const result = await new AgentLoop(host).run(input({ message: "回顾11月2日到8日，核对原文，不修改。", onText: value => streamed.push(value) }));
  expect(requests).toHaveLength(3); expect(result.text).toContain("历史分析未完成");
  expect(result.text).toContain("虚构紫纸已整理10张"); expect(result.text).toContain("2026\\-11\\-03");
  expect(result.text).toContain("&lt;img src\\=x&gt;"); expect(result.text).toContain("\\[执行\\]");
  expect(result.text).not.toContain("错误草稿"); expect(result.text).not.toContain("DSML");
  expect(streamed.join("")).toBe(result.text); expect(result.toolCalls).toEqual([{ name: "get_summaries", ok: true }]);
  expect(result.receipts).toEqual([]); expect(await store.readPath(store.taskDbPath())).toBe(before);
});

it.each(["network", "empty", "native-call", "protocol"])("retains locally rechecked historical task statistics when final analysis returns %s", async mode => {
  const task = await store.createTask({ title: "虚构已完成纸样", date: "2026-11-03" });
  await store.updateTask(task.id, row => ({ ...row, status: "completed", createdAt: "2026-11-03T09:00:00+08:00", completedAt: "2026-11-03T10:00:00+08:00" }));
  host.assertReadOnlyReplyCurrent = () => {};
  const summary = await historicalFixture(), range = { from: "2026-11-02", to: "2026-11-08" };
  responses.push(reply("", [...summary.toolCalls, tool("get_stats", { domain: "tasks", range }, "historical-task-stats"),
    tool("get_stats", { domain: "habits", range }, "historical-habit-stats")]), reply("错误草稿：一周都没做。"),
    mode === "network" ? new Error("fictional network failure") : mode === "native-call"
      ? reply("", [tool("create_task", { title: "虚构不可执行" })]) : reply(mode === "protocol" ? "<｜｜DSML｜｜ calls></｜｜DSML｜｜ calls>" : ""));
  const streamed: string[] = [], before = await store.readPath(store.taskDbPath());
  const result = await new AgentLoop(host).run(input({ message: "回顾11月2日到8日原文与任务完成情况，不修改。", onText: value => streamed.push(value) }));
  expect(result.text).toContain("历史分析未完成"); expect(result.text).toContain("虚构紫纸已整理10张");
  expect(result.text).toContain("2026-11-02 至 2026-11-08");
  expect(result.text).toContain("计划 1 项，计划内完成 1 项"); expect(result.text).toContain("区间内登记完成 1 项");
  expect(result.text).toContain("不是实测工时"); expect(result.text).not.toContain("错误草稿"); expect(result.text).not.toContain("DSML");
  expect(requests).toHaveLength(3); expect(result.receipts).toEqual([]); expect(result.confirmations).toEqual([]);
  expect(streamed.join("")).toBe(result.text); expect(await store.readPath(store.taskDbPath())).toBe(before);
});

it.each(["privacy", "cancel", "store", "source"])("discards historical fallback statistics after %s changes during local recovery", async change => {
  await store.createTask({ title: "虚构本地恢复样本", date: "2026-11-03" });
  const controller = new AbortController(), original = host.aiForRole, read = store.readPath.bind(store);
  let recovering = false, stale = false, touched = false;
  host.assertReadOnlyReplyCurrent = () => { if (stale) throw new DOMException("fictional source changed", "AbortError"); };
  host.aiForRole = role => ({ agentTurnStream: async (messages, onText, options) => {
    if (role === "deep") recovering = true;
    return original(role).agentTurnStream(messages, onText, options);
  } });
  vi.spyOn(store, "readPath").mockImplementation(async path => {
    const result = await read(path);
    if (recovering && path === store.taskDbPath()) {
      touched = true;
      if (change === "privacy") store.settings.privacy!.excludedVaultPrefixes = ["虚构新拒读范围"];
      if (change === "cancel") controller.abort();
      if (change === "store") host.store = Object.create(store);
      if (change === "source") stale = true;
    }
    return result;
  });
  const summary = await historicalFixture();
  responses.push(reply("", [...summary.toolCalls, tool("get_stats", { domain: "tasks", range: "last_week" }, "historical-task-stats")]),
    reply("虚构未采纳草稿"), new Error("fictional network failure"));
  const streamed: string[] = [];
  await expect(new AgentLoop(host).run(input({ message: "回顾上周原文与任务统计，不修改。", signal: controller.signal,
    onText: value => streamed.push(value) }))).rejects.toMatchObject({ name: "AbortError" });
  expect(touched).toBe(true); expect(requests).toHaveLength(3); expect(streamed.join("")).toBe("");
});

it("keeps historical originals without inventing numbers when local statistic recovery is unavailable", async () => {
  await store.createTask({ title: "虚构本地不可用样本", date: "2026-11-03" });
  const original = host.aiForRole, read = store.readPath.bind(store);
  let recovering = false, touched = false;
  host.assertReadOnlyReplyCurrent = () => {};
  host.aiForRole = role => ({ agentTurnStream: async (messages, onText, options) => {
    if (role === "deep") recovering = true;
    return original(role).agentTurnStream(messages, onText, options);
  } });
  vi.spyOn(store, "readPath").mockImplementation(async path => {
    if (recovering && [store.taskDbPath(), store.taskMirrorPath()].includes(path)) { touched = true; throw Error("fictional local statistics unavailable"); }
    return read(path);
  });
  const summary = await historicalFixture();
  responses.push(reply("", [...summary.toolCalls, tool("get_stats", { domain: "tasks", range: "last_week" }, "historical-task-stats")]),
    reply("虚构未采纳草稿：完成99项。"), new Error("fictional network failure"));
  const result = await new AgentLoop(host).run(input({ message: "回顾上周原文与任务统计，不修改。" }));
  expect(result.text).toContain("历史分析未完成"); expect(result.text).toContain("虚构紫纸已整理10张");
  expect(result.text).not.toContain("99"); expect(result.text).not.toContain("区间内登记完成");
  expect(touched).toBe(true); expect(requests).toHaveLength(3); expect(result.receipts).toEqual([]); expect(result.confirmations).toEqual([]);
});

it.each(["privacy", "cancel", "store", "source"])("discards final historical text and evidence after %s changes", async change => {
  const controller = new AbortController(), original = host.aiForRole;
  let stale = false;
  host.assertReadOnlyReplyCurrent = () => { if (stale) throw new DOMException("fictional source changed", "AbortError"); };
  host.aiForRole = role => ({ agentTurnStream: async (messages, onText, options) => {
    const response = await original(role).agentTurnStream(messages, onText, options);
    if (role === "deep") {
      if (change === "privacy") store.settings.privacy!.excludedVaultPrefixes = ["虚构不再准读"];
      if (change === "cancel") controller.abort();
      if (change === "store") host.store = Object.create(store);
      if (change === "source") stale = true;
    }
    return response;
  } });
  responses.push(await historicalFixture(), reply("未核对草稿"), reply("虚构过期资料，不应显示。"));
  const streamed: string[] = [];
  await expect(new AgentLoop(host).run(input({ message: "核对11月2日到8日原文，不修改。", signal: controller.signal,
    onText: value => streamed.push(value) }))).rejects.toMatchObject({ name: "AbortError" });
  expect(requests).toHaveLength(3); expect(streamed).toEqual([]);
});

it("uses the historical protocol repair as its only text-only final answer", async () => {
  const answer = "只有11月3日的虚构记录，整周其他日期未知。";
  responses.push(await historicalFixture(), reply("<｜｜DSML｜｜ calls></｜｜DSML｜｜ calls>"), reply(answer));
  const streamed: string[] = [];
  const result = await new AgentLoop(host).run(input({ message: "核对11月2日到8日的原文，不修改。", onText: value => streamed.push(value) }));
  expect(result.text).toBe(answer); expect(streamed.join("")).toBe(answer);
  expect(requests).toHaveLength(3); expect(roles.filter(role => role === "deep")).toHaveLength(1);
});

it("does not add read-only historical analysis after a requested write", async () => {
  responses.push(await historicalFixture(), reply("", [tool("create_task", { title: "虚构复盘后续纸样" })]), reply("已保存虚构复盘后续纸样。"));
  const result = await new AgentLoop(host).run(input({ message: "查看11月2日到8日，再创建虚构复盘后续纸样待办，不安排时间。" }));
  expect(requests).toHaveLength(3); expect(roles).not.toContain("deep");
  expect(result.receipts).toHaveLength(1); expect((await store.readTaskDb()).tasks.map(row => row.title)).toEqual(["虚构复盘后续纸样"]);
});

function reply(content: string, toolCalls: AiToolCall[] = []): AiChatResult {
  const usage = { status: "reported", inputTokens: 40, outputTokens: 5, totalTokens: 45 } as const;
  return { content, toolCalls, reportedModel: "synthetic-model", responseUsage: usage,
    providerRun: { requestedProvider: "custom", requestedModel: "synthetic-model", actualModel: "synthetic-model",
      status: "success", fallbackUsed: false, attempts: [], responseUsage: usage } };
}

it.each([false,true])("explains task metric meaning locally with a real sample present=%s",async present=>{
  if(present){const task=await store.createTask({title:"虚构跨日样本",date:"2026-11-03"});
    await store.updateTask(task.id,row=>({...row,status:"completed",createdAt:"2026-11-03T08:00:00+08:00",completedAt:"2026-11-04T17:00:00+08:00"}));}
  const before=await store.readPath(store.taskDbPath());
  responses.push(reply("",[tool("get_stats",{domain:"tasks",range:{from:"2026-11-02",to:"2026-11-08"},directReply:"task_meaning"}),
    ...(present?[tool("get_stats",{domain:"tasks",range:{from:"2026-11-02",to:"2026-11-08"},groupBy:"day"},"daily-interval-read")]:[])]));
  const result=await new AgentLoop(host).run(input({message:"说明这周计划完成率和平均完成间隔的含义，只查记录。"}));
  expect(requests).toHaveLength(1);expect(result.text).toContain("不是实测工作工时");
  expect(result.text).toContain("不能据此断言拖延或临时需求挤占");expect(result.text).toContain("隔天完成不等于周或月计划外");
  expect(result.text).toContain(present?"1980 分钟":"没有有效登记到完成的间隔样本");
  expect(result.text).toContain(present?"计划完成率 100%":"无法计算计划完成率");
  expect(result.receipts).toEqual([]);expect(result.confirmations).toEqual([]);expect(await store.readPath(store.taskDbPath())).toBe(before);
});

it("keeps task interval numbers and their meaning before compact voice output is truncated",async()=>{
  const task=await store.createTask({title:"虚构跨日间隔",date:"2026-11-10",estimateMin:30,startTime:"09:00",endTime:"09:30"});
  await store.updateTask(task.id,row=>({...row,status:"completed",createdAt:"2026-11-10T08:00:00+08:00",completedAt:"2026-11-11T17:00:00+08:00"}));
  responses.push(reply("",[tool("get_stats",{domain:"tasks",range:{from:"2026-11-09",to:"2026-11-15"},groupBy:"day"})]),
    reply("这是从登记到完成的经过时间，不是实测工作工时。"));
  const result=await new AgentLoop(host).run(input({source:"voice",message:"统计这周任务的平均完成间隔。"}));
  expect(result.toolCalls).toContainEqual({name:"get_stats",ok:true});
  const evidence=requests.at(-1)!.filter(message=>message.role==="tool").map(message=>message.content).join("\n");
  expect(evidence).toContain('"averageCompletionMin":1980');expect(evidence).toContain('"completionPercent":100');
  expect(evidence).toContain("不是实测工作工时");expect(evidence).toContain("只显示已查结果的前部");
  expect(result.receipts).toEqual([]);
});
function input(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return { message: "请创建任务 纯虚构循环任务。", history: [], source: "text", now, ...overrides };
}
function tool(name: string, args: Record<string, unknown>, id = "synthetic-call"): AiToolCall {
  return { name, arguments: args, id };
}

function voiceUndoApproval(): AiChatResult {
  return reply("", [tool("choose_voice_job_control", { intent: "undo_latest_operation", target: "latest" })]);
}

const tradeExamples = [
  { message: "BTC 多 67000 进 68200 出 0.1 个 按突破模型 赚 120U", rows: [
    { market: "加密", symbol: "BTC", direction: "long", entry: 67000, exit: 68200, qty: 0.1, qtyUnit: "个", modelId: "突破模型", pnl: 120 }
  ], pnl: [120], source: ["stated"], currency: ["USD"] },
  { message: "今天茅台做 T，1680 买 1695 卖 200 股", rows: [
    { market: "A股", symbol: "茅台", direction: "long", entry: 1680, exit: 1695, qty: 200, qtyUnit: "股", openedAt: "2026-11-12" }
  ], pnl: [3000], source: ["computed"], currency: ["CNY"] },
  { message: "欧美空 1.0850 进 1.0820 出 1 手 没按止损", rows: [
    { market: "外汇", symbol: "EUR/USD", direction: "short", entry: 1.085, exit: 1.082, qty: 1, qtyUnit: "手", notes: "没按止损" }
  ], pnl: [300], source: ["computed"], currency: ["USD"] },
  { message: "早上三笔：特斯拉多赚 300，英伟达多亏 120，纳指期货空赚 450", rows: [
    { market: "美股", symbol: "特斯拉", direction: "long", pnl: 300 },
    { market: "美股", symbol: "英伟达", direction: "long", pnl: -120 },
    { market: "期货", symbol: "纳指期货", direction: "short", pnl: 450, currency: "USD" }
  ], pnl: [300, -120, 450], source: ["stated", "stated", "stated"], currency: ["USD", "USD", "USD"] },
  { message: "美股 ZTEST2 做空 5 股，进 100 出 98，手续费 1 美元；加密 ZTEST3 做多 2 个，实际净亏 7 美元。", rows: [
    { market: "美股", symbol: "ZTEST2", direction: "short", qty: 5, entry: 100, exit: 98, fees: 1, pnl: 9 },
    { market: "加密", symbol: "ZTEST3", direction: "long", qty: 2, pnl: -7 }
  ], pnl: [9, -7], source: ["computed", "stated"], currency: ["USD", "USD"] }
];

it.each(tradeExamples)("records the trades selected by the model for $message", async ({ message, rows, pnl, source, currency }) => {
  store.settings.tradingContractMultipliers = { "EUR/USD": 100000 };
  responses.push(reply("", [tool("record_trade", { trades: rows })]), reply("交易已保存。"));
  const result = await new AgentLoop(host).run(input({ message }));
  const trades = (await readTradeDatabase(store)).trades;
  expect(catalogs.some(names => names.includes("record_trade"))).toBe(true);
  expect(result.toolCalls).toContainEqual({ name: "record_trade", ok: true });
  expect(result.receipts).toHaveLength(1);
  expect(result.receipts[0].tradeEdits?.map(edit => edit.id)).toEqual(trades.map(trade => trade.id));
  expect(result.receipts[0].tradeEdits?.every(edit => edit.summary.includes("USD") || edit.summary.includes("CNY"))).toBe(true);
  expect(trades.map(trade => trade.pnlSource)).toEqual(source);
  expect(trades.map(trade => trade.currency)).toEqual(currency);
  for (const [index, value] of pnl.entries()) {
    expect(trades[index].pnl).toBeCloseTo(value);
    expect(trades[index].openedAtPrecision).toBe("date");
    expect(trades[index].source.kind).toBe("chat");
  }
  await runtime.undoOperation(result.receipts[0].operationId);
  expect((await readTradeDatabase(store)).trades).toEqual([]);
});

it("uses the actual model-group net profit for each currency without asking the model to rank", async () => {
  const rows = [
    { market: "A股", modelId: "虚构突破", pnl: 250 },
    { market: "A股", modelId: "虚构回踩", pnl: -70 },
    { market: "美股", modelId: "虚构突破", pnl: 90 },
    { market: "美股", modelId: "虚构回踩", pnl: 120 },
    { market: "美股", pnl: 1000 }
  ].map((row, index) => ({ ...row, symbol: `FICT-${index}`, direction: "long", openedAt: "2026-11-12" }));
  for (const batch of [rows.slice(0, 3), rows.slice(3)]) {
    const saved = await runtime.executeAiToolCall(tool("record_trade", { trades: batch }, `fixture-${batch.length}`), "kimi");
    expect(saved.success).toBe(true);
  }
  const before = (await readTradeDatabase(store)).trades;
  responses.push(reply("", [tool("get_stats", { domain: "trades", groupBy: "model", rankByNetPnl: true,
    range: { from: "2026-11-01", to: "2026-11-12" } })]));
  const result = await new AgentLoop(host).run(input({ message: "这个月哪个交易模型最赚钱？人民币和美元分开。" }));
  expect(result.text).toContain("人民币「虚构突破」排名第一，净盈亏 250 CNY。");
  expect(result.text).toContain("美元「虚构回踩」排名第一，净盈亏 120 USD。");
  expect(result.text).not.toContain("180");
  expect(result.toolCalls).toEqual([{ name: "get_stats", ok: true }]);
  expect(requests).toHaveLength(1);
  expect(result.receipts).toEqual([]);
  expect((await readTradeDatabase(store)).trades).toEqual(before);
});

it("requires missing data or a batch confirmation before recording any rows", async () => {
  const row = tradeExamples[0].rows[0];
  const missing = await runtime.executeAiToolCall(tool("record_trade", { trades: [row, { ...row, direction: undefined }] }), "kimi");
  expect(missing.success).toBe(false);
  expect(missing.output).toContain("请先问清");
  const rows = [row, row, row, row];
  responses.push(reply("", [tool("record_trade", { trades: rows })]), reply("请确认四笔记录。"));
  const result = await new AgentLoop(host).run(input({ message: "请把我刚才列出的四笔虚构交易一起记下来。" }));
  expect(result.confirmations).toHaveLength(1);
  expect(result.confirmations[0]).toMatchObject({ type: "tool_batch", batchWriteCount: 4 });
  expect((await readTradeDatabase(store)).trades).toEqual([]);
  await executeConfirmedToolBatch(result.confirmations[0], runtime, () => undefined);
  expect((await readTradeDatabase(store)).trades).toHaveLength(4);
});

it("updates the exact trade, rejects a stale delete card, and allows confirmed deletion and undo", async () => {
  const saved = await runtime.executeAiToolCall(tool("record_trade", { trades: tradeExamples[0].rows }, "trade-add"), "kimi");
  const id = saved.receipt!.tradeEdits![0].id;
  const first = await runtime.executeAiToolCall(tool("delete_trade", { id }, "delete-first"), "kimi");
  const confirmedContext = { store, refreshViews: async () => undefined };
  expect((await readTradeDatabase(store)).trades).toHaveLength(1);
  const changed = await runtime.executeAiToolCall(tool("update_trade", { id, patch: { pnl: 50, openedAt: "2026-11-13" } }, "trade-edit"), "kimi");
  expect(changed.output).toContain("相差超过 5%");
  expect((await readTradeDatabase(store)).trades[0]).toMatchObject({ id, pnl: 50, pnlSource: "stated", openedAtPrecision: "date" });
  await expect(runConfirmedToolAction(first.actions[0], confirmedContext)).rejects.toThrow("交易已变化");
  const current = await runtime.executeAiToolCall(tool("delete_trade", { id }, "delete-current"), "kimi");
  expect((await readTradeDatabase(store)).trades).toHaveLength(1);
  await runConfirmedToolAction(current.actions[0], confirmedContext);
  expect((await readTradeDatabase(store)).trades).toHaveLength(0);
  await runtime.undoOperation(`confirmed:${current.actions[0].id}`);
  expect((await readTradeDatabase(store)).trades[0]).toMatchObject({ id, pnl: 50 });
});

it("uses the deep role on a configured trading note and saves anchored rules only after confirmation", async () => {
  const path = `${store.settings.folders.tradingModels}/虚构纪律原文.md`;
  const raw = "# 练习模型\n每笔交易入场后必须设置止损。\n";
  await store.writeFile(path, raw);
  const quote = "每笔交易入场后必须设置止损。";
  const draft = { text: "入场后设置止损", kind: "risk", checkable: true, quote };
  host.aiForRole = role => ({ async agentTurnStream(messages) {
    roles.push(role);
    if (role === "deep") {
      expect(messages.at(-1)?.content).toBe(raw);
      return reply(JSON.stringify({ rules: [draft] }));
    }
    const message = messages.at(-1);
    if (message?.role !== "tool") return reply("", [tool("extract_trading_rules", { path }, "extract")]);
    if (message.content.startsWith("{")) {
      const { rules } = JSON.parse(message.content);
      return reply("", [tool("propose_trading_research_change", { command: { kind: "save_model", input: { title: "练习模型", rules } } }, "prepare")]);
    }
    return reply("请核对规则确认卡。");
  } });
  const result = await new AgentLoop(host).run(input({ message: "请从虚构纪律原文提取练习模型的规则，给我一张确认卡。" }));
  expect(roles).toContain("deep");
  expect(result.confirmations).toHaveLength(1);
  expect(result.confirmations[0].content).toContain(quote);
  expect(result.confirmations[0].content).toContain(path);
  expect((await store.getTradingSnapshot()).document.models).toEqual([]);
  await runConfirmedToolAction(result.confirmations[0], { store, refreshViews: async () => undefined });
  const version = (await store.getTradingSnapshot()).document.models[0].versions[0];
  expect(version).toMatchObject({ title: "练习模型", revision: 1, rules: [{ ...draft, sourcePath: path }] });
  expect(version.receipt).toBeUndefined();
  expect(await store.readPath(path)).toBe(raw);

  const id = version.rules![0].id;
  const row = { market: "A股", symbol: "虚构标的", direction: "long", modelId: "练习模型" };
  const userQuote = "入场后没有设止损";
  const correct = await runtime.executeAiToolCall(tool("record_trade", { trades: [{ ...row, ruleChecks: [{ id, status: "violation", quote: userQuote }] }] }, "rule-checked"),
    "kimi", `虚构交易，${userQuote}。`);
  expect(correct.success, correct.output).toBe(true);
  expect(correct.output).toContain("已核对违规 1 条");
  const missing = await runtime.executeAiToolCall(tool("record_trade", { trades: [{ ...row, ruleChecks: [{ id, status: "violation", quote: userQuote }] }] }, "rule-unknown"),
    "kimi", "虚构交易，只知道做多。");
  expect(missing.output).toContain("规则核对还缺依据");
  const rows = (await readTradeDatabase(store)).trades;
  expect(rows).toMatchObject([
    { modelId: version.modelId, modelVersionId: version.id, ruleViolations: [id], ruleCheckStatus: "checked" },
    { modelId: version.modelId, modelVersionId: version.id, ruleViolations: [], ruleCheckStatus: "insufficient" }
  ]);
});

it("never sends an excluded rule note or accepts a fabricated source quote", async () => {
  const path = `${store.settings.folders.tradingModels}/虚构规则备份.md`;
  await store.writeFile(path, "实际原文只说记录风险。\n");
  store.settings.privacy!.excludedVaultPrefixes = [path];
  responses.push(reply("", [tool("extract_trading_rules", { path }, "excluded")]), reply("请重新选择。"));
  const excluded = await new AgentLoop(host).run(input({ message: "请提取这篇虚构规则备份里的完整交易规则。" }));
  expect(excluded.toolCalls).toContainEqual({ name: "extract_trading_rules", ok: false });
  expect(roles).not.toContain("deep");
  store.settings.privacy!.excludedVaultPrefixes = [];
  responses.push(reply("", [tool("extract_trading_rules", { path }, "bad-quote")]),
    reply(JSON.stringify({ rules: [{ text: "设置固定百分比", kind: "risk", checkable: true, quote: "未出现的原话" }] })), reply("规则没有核对通过。"));
  const badQuote = await new AgentLoop(host).run(input({ message: "请从这篇虚构备份提取可以核对的交易规则。" }));
  expect(badQuote.toolCalls).toContainEqual({ name: "extract_trading_rules", ok: false });
  expect(badQuote.confirmations).toEqual([]);
  expect((await store.getTradingSnapshot()).document.models).toEqual([]);
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-agent-loop-"));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.ai = { ...settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", model: "synthetic-model", dataDisclosureAccepted: true };
  settings.privacy = { excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
  store = new LifeOpsStore(createFsApp(root), settings) as unknown as StoreHost;
  await store.initializeVault();
  runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  responses = []; requests = []; roles = []; catalogs = []; toolChoices = [];
  host = {
    settings, store,
    aiForRole: role => {
      roles.push(role);
      return { agentTurnStream: vi.fn(async (messages, onText, options?: Parameters<InstanceType<typeof LifeOpsAi>["agentTurnStream"]>[2]) => {
        requests.push(structuredClone(messages));
        catalogs.push(options?.tools?.map(tool => tool.name) ?? []);
        toolChoices.push(options?.toolChoice);
        const response = responses.shift();
        if (response instanceof Error) throw response;
        if (!response) throw Error("Missing synthetic response");
        if (response.content) onText(response.content);
        return response;
      }) };
    },
    executeTools: async (calls, message, signal, onResult) => {
      const results = [];
      for (const call of calls) {
        const result = await runtime.executeAiToolCall(call, "kimi", message, { assertCurrent: () => signal?.throwIfAborted() });
        onResult(call, result);
        results.push(result);
      }
      return results;
    },
    offlineFallback: vi.fn(async () => null)
  };
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

it("binds successive time corrections to the previous saved task and blocks a different guessed title", async () => {
  const unrelated = await store.createTask({ title: "虚构同一时刻的会议", date: "2026-11-13", time: "15:00" });
  const loop = new AgentLoop(host);
  const firstMessage = "明天下午3:00提醒我给靛色纸样夹贴标签。";
  const first = await loop.run(input({ message: firstMessage }));
  expect(first.receipts).toHaveLength(1);
  const task = (await store.readTaskDb()).tasks.find(item => item.title === "给靛色纸样夹贴标签")!;
  const history: AgentTurnInput["history"] = [
    { role: "user", content: firstMessage }, { role: "assistant", content: first.text, receipts: first.receipts }
  ];
  responses.push(
    reply("", [tool("reschedule_task", { taskIdOrTitle: unrelated.title, time: "15:15" }, "wrong-task")]),
    reply("", [tool("reschedule_task", { taskIdOrTitle: task.id, time: "15:15" }, "verified-task")])
  );
  const correction = "不对，我要把刚刚那条改成下午三点十五。";
  const result = await loop.run(input({ message: correction, source: "voice", history }));
  expect(result.toolCalls).toEqual([{ name: "reschedule_task", ok: false }, { name: "reschedule_task", ok: true }]);
  expect(result.receipts).toHaveLength(1);
  expect(result.voiceSpeech).toContain("15:15");
  expect(requests[0][0].content).toContain(task.id);
  expect(await store.getTask(unrelated.id)).toEqual(unrelated);
  expect(await store.getTask(task.id)).toMatchObject({ date: "2026-11-13", time: "15:15" });

  history.push({ role: "user", content: correction }, { role: "assistant", content: result.text, receipts: result.receipts });
  const callsBeforeAgain = requests.length;
  const again = await loop.run(input({ message: "把刚刚那条再改到下午三点半，保持其他信息不变。", source: "voice", history }));
  expect(again.voiceSpeech).toContain("15:30");
  expect(requests).toHaveLength(callsBeforeAgain);
  expect(await store.getTask(task.id)).toMatchObject({ date: "2026-11-13", time: "15:30" });
  await runtime.undoOperation(again.receipts[0].operationId);
  expect(await store.getTask(task.id)).toMatchObject({ date: "2026-11-13", time: "15:15" });
});

it("does not substitute the previous saved task for a task the user explicitly names", async () => {
  const named = await store.createTask({ title: "检查虚构门牌模型", date: "2026-11-13", time: "15:00" });
  const loop = new AgentLoop(host);
  const first = await loop.run(input({ message: "明天下午3:00提醒我打包青色纸样。" }));
  const previous = (await store.readTaskDb()).tasks.find(task => task.title === "打包青色纸样")!;
  responses.push(
    reply("", [tool("reschedule_task", { taskIdOrTitle: previous.id, time: "15:15" }, "wrong-previous-task")]),
    reply("", [tool("reschedule_task", { taskIdOrTitle: named.title, time: "15:15" }, "explicit-task")])
  );
  const result = await loop.run(input({ message: "把检查虚构门牌模型改到下午三点十五。", source: "text", history: [
    { role: "assistant", content: first.text, receipts: first.receipts }
  ] }));
  expect(result.toolCalls).toEqual([{ name: "reschedule_task", ok: false }, { name: "reschedule_task", ok: true }]);
  expect(await store.getTask(previous.id)).toEqual(previous);
  expect(await store.getTask(named.id)).toMatchObject({ time: "15:15" });
});

it("keeps an unnamed task unchanged when the previous message has no verified receipt", async () => {
  const task = await store.createTask({ title: "虚构未被点名任务", date: "2026-11-13", time: "15:00" });
  responses.push(reply("", [tool("reschedule_task", { taskIdOrTitle: task.id, time: "15:15" })]), reply("请告诉我要修改哪条待办。"));
  const result = await new AgentLoop(host).run(input({ message: "刚刚那条改到下午三点十五。", source: "voice", history: [
    { role: "assistant", content: "已记录。", receipts: [{ operationId: "fictional-unverified-operation" }] }
  ] }));
  expect(result.receipts).toHaveLength(0);
  expect(await store.getTask(task.id)).toEqual(task);
});


it.each(["text", "voice"] as const)("presents quiz questions without a model-written answer example in %s", async source => {
  if (source === "text") responses.push(reply("", [tool("load_more_tools", {}, "expand")]));
  responses.push(
    reply("", [tool("start_quiz", { trackId: "quant", count: 2 }, "quiz")]),
    reply("请按题号作答，例如第一题：不参与。")
  );
  const executeTools = host.executeTools;
  const receipt = { operationId: "fictional-quiz" };
  host.executeTools = (calls, message, signal, onResult) => calls[0]?.name !== "start_quiz"
    ? executeTools(calls, message, signal, onResult)
    : Promise.resolve(calls.map(call => {
      const result = { callId: call.id!, success: true, actions: [], receipt, output: JSON.stringify({ cards: [
        { number: 1, question: "样本外数据是否参与参数选择？" },
        { number: 2, question: "如何从毛收益得到净收益？" }
      ] }) };
      onResult(call, result);
      return result;
    }));
  const onVoiceText = vi.fn();
  const result = await new AgentLoop(host).run(input({ message: "从虚构量化笔记考我两题，先只出题。", source, onVoiceText }));
  expect(result.text).toBe("第 1 题：样本外数据是否参与参数选择？\n\n第 2 题：如何从毛收益得到净收益？\n\n请按题号作答。");
  if (source === "voice") {
    expect(catalogs[0]).toContain("start_quiz");
    expect(result.voiceSpeech).toBe(result.text);
  }
  expect(onVoiceText).not.toHaveBeenCalled();
  expect(result.receipts).toEqual([receipt]);
  expect(requests).toHaveLength(source === "voice" ? 1 : 2);
});

it("asks for an actual day for a vague weekend plan and never saves a guessed date", async () => {
  const loop = new AgentLoop(host);
  const ambiguous = await loop.run(input({ message: "周末我要给虚构盆栽换盆。" }));
  expect(ambiguous.text).toBe("你想安排在周六还是周日？");
  expect(ambiguous.receipts).toEqual([]);
  expect(requests).toEqual([]);
  expect((await store.readTaskDb()).tasks).toEqual([]);
  responses.push(reply("已经安排在周六。", [tool("create_task", { title: "给虚构盆栽换盆", date: "2026-11-14" })]),
    reply("已记下周六给虚构盆栽换盆。"));
  const specified = await loop.run(input({ message: "周末我要在周六给虚构盆栽换盆。" }));
  expect(specified.receipts).toHaveLength(1);
  expect((await store.readTaskDb()).tasks[0].date).toBe("2026-11-14");
});

it("answers a voice correction or short yes with the correct period's task count and no write", async () => {
  for (const [title, day] of [["虚构上月记录", "2026-10-28"], ["虚构上周记录甲", "2026-11-03"], ["虚构上周记录乙", "2026-11-06"]]) {
    const task = await store.createTask({ title, date: day });
    const completedAt = day + "T04:00:00.000Z";
    await store.updateTask(task.id, item => ({
      ...item, status: "completed", completedAt, completionLog: [{ completedAt, note: "" }]
    }));
  }
  const loop = new AgentLoop(host);
  const history = [
    { role: "user", content: "上周完成了多少项任务？" },
    { role: "assistant", content: "你是要查上周的实际完成数吗？" }
  ] as AgentTurnInput["history"];
  const onVoiceText = vi.fn();
  const before = await readFile(join(root, store.taskDbPath()), "utf8");
  const corrected = await loop.run(input({ source: "voice", message: "不对，是上个月。", history, onVoiceText }));
  const accepted = await loop.run(input({ source: "voice", message: "对。", history, onVoiceText }));
  expect(corrected.text).toBe("上个月已完成 1 个任务。");
  expect(accepted.text).toBe("上周已完成 2 个任务。");
  expect(onVoiceText.mock.calls.flat()).toEqual([corrected.text, accepted.text]);
  expect(requests).toEqual([]);
  expect(corrected.toolCalls).toEqual([{ name: "get_stats", ok: true }]);
  expect(accepted.confirmations).toEqual([]);
  expect(await readFile(join(root, store.taskDbPath()), "utf8")).toBe(before);
});

it("reads the completed historical summary when a correction restates the task period", async () => {
  const loop = new AgentLoop(host);
  host.executeTools = async calls => calls.map(call => {
    expect(call.name).toBe("get_summaries");
    const { level, range } = call.arguments;
    expect(level).toBe("week");
    expect(range).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    return { callId: call.id!, success: true, output: JSON.stringify({ summaries: [
      { from: "2026-11-02", through: "2026-11-08", complete: true, metrics: { tasksCompleted: 26 } }
    ] }), actions: [] };
  });
  const result = await loop.run(input({ source: "text", message: "不对，我问的是上周任务完成情况。", history: [
    { role: "user", content: "总结一下最近的任务完成情况。" },
    { role: "assistant", content: "这是今天的虚构待办。" }
  ] }));
  expect(result.text).toBe("上周完成了 26 项任务。");
  expect(result.toolCalls).toEqual([{ name: "get_summaries", ok: true }]);
  expect(requests).toEqual([]);
});

it("does not turn an unrelated confirmation into a task query", async () => {
  responses.push(reply("请说清楚你想确认哪件事。"));
  const result = await new AgentLoop(host).run(input({ source: "voice", message: "对。",
    history: [{ role: "user", content: "上周完成了多少项任务？" },
      { role: "assistant", content: "你确认要删除这条虚构任务吗？" }] }));
  expect(result.toolCalls).toEqual([]);
  expect(result.receipts).toEqual([]);
  expect(requests).toHaveLength(1);
});

it("reports only the selected habit's actual compensation as an existing task", async () => {
  const evening = new Date();
  evening.setHours(21, 0, 0, 0);
  for (const [name, minChars] of [["虚构阅读", 180], ["虚构跑步", 320]] as const) {
    await store.createHabit({ name, frequencyUnit: "day", frequencyInterval: 1, targetCount: 1,
      startDate: formatDate(evening), punishment: { enabled: true, rules: [{ kind: "reflection", minChars }] } });
  }
  await store.checkPunishments(evening);
  const result = await new AgentLoop(host).run(input({ message: "虚构阅读没达标会怎样？" }));
  expect(result.text).toContain("已有 1 项补偿待办");
  expect(result.text).toContain("写反思至少 180 字");
  expect(result.text).not.toContain("320");
  expect(result.toolCalls).toEqual([{ name: "list_tasks", ok: true }]);
  expect(result.receipts).toEqual([]);
  expect(requests).toEqual([]);
});

describe("unified agent loop", () => {
  it("streams text, retains only twelve history entries, and logs actual response counters", async () => {
    responses.push(reply("我可以帮你处理任务。"));
    const chunks: string[] = [];
    const result = await new AgentLoop(host).run(input({ message: "你可以做什么？", onText: delta => chunks.push(delta),
      history: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `虚构历史${index}` })) }));
    expect(result.text).toBe("我可以帮你处理任务。");
    expect(chunks.join("")).toBe(result.text);
    expect(requests[0]).toHaveLength(14);
    expect(requests[0][1].content).toBe("虚构历史8");
    expect(result.usage).toMatchObject({ model: "synthetic-model", inputTokens: 40, outputTokens: 5 });
    const logs = (await readFile(join(root, store.qualityLogPath()), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ captureMode: "agent-loop", toolCalls: [], actionSuggestions: 0 });
    expect(logs[0].providerRuns[0]).toMatchObject({ actualModel: "synthetic-model", responseUsage: { inputTokens: 40, outputTokens: 5 } });
  });

  it("executes a real write, returns its receipt, and undoes that exact operation", async () => {
    responses.push(reply("", [tool("create_task", { title: "纯虚构循环任务" })]), reply("已创建纯虚构循环任务。"));
    const receipts = vi.fn();
    const result = await new AgentLoop(host).run(input({ onReceipt: receipts }));
    expect((await store.readTaskDb({ readOnly: true })).tasks.map(task => task.title)).toContain("纯虚构循环任务");
    expect(result.receipts).toHaveLength(1);
    expect(receipts).toHaveBeenCalledWith(result.receipts[0]);
    expect(result.toolCalls).toEqual([{ name: "create_task", ok: true }]);
    expect(requests[1].filter(message => message.role === "tool")).toHaveLength(1);
    expect(result.usage.inputTokens).toBe(80);
    await runtime.undoOperation(result.receipts[0].operationId);
    expect((await store.readTaskDb({ readOnly: true })).tasks).toEqual([]);
  });

  it("returns verified list results to the model before completing a general request", async () => {
    const date = formatDate(now);
    await store.createTask({ title: "纯虚构待办", date, startTime: "15:00" });
    responses.push(reply("", [tool("list_tasks", { date, directReply: true })]),
      reply("模型误说有99项任务，详细回答很长。"));
    const chunks: string[] = [];
    const result = await new AgentLoop(host).run(input({ message: "把今天没完成的任务列出来。", onText: delta => chunks.push(delta) }));
    expect(requests).toHaveLength(2);
    expect(roles).toEqual(["fast", "fast"]);
    expect(requests[1].filter(message => message.role === "tool").map(message => message.content).join(" ")).toContain("纯虚构待办");
    expect(result.toolCalls).toEqual([{ name: "list_tasks", ok: true }]);
    expect(result.text).toContain("今天有 1 个未完成任务");
    expect(result.text).toContain("纯虚构待办（计划 15:00 开始 · 结束未定）");
    expect(chunks.join("")).toBe(result.text);
    expect(result.usage.inputTokens).toBe(80);
  });

  it.each(["我今天还有什么任务没完成？", "今天有哪些未完成的待办？", "今天还剩哪些任务？"])(
    "lists unfinished tasks for an explicit text query without contacting the model (%s)", async message => {
      const date = formatDate(now);
      await store.createTask({ title: "虚构今日待办", date });
      const completed = await store.createTask({ title: "虚构今日已做", date });
      await store.completeTask(completed.id);
      await store.createTask({ title: "虚构明日待办", date: addDays(date, 1) });
      const readDashboard = vi.spyOn(store, "getTaskDashboard");
      const result = await new AgentLoop(host).run(input({ message }));
      expect(result.text).toBe("今天有 1 个未完成任务。\n1. 虚构今日待办");
      expect(result.toolCalls).toEqual([{ name: "list_tasks", ok: true }]);
      expect(result.receipts).toEqual([]);
      expect(requests).toEqual([]);
      expect(readDashboard).not.toHaveBeenCalled();
    });

  it.each(["text", "voice"] as const)("reports overdue and due-today task groups locally (%s)", async source => {
    const date = formatDate(now), yesterday = addDays(date, -1), tomorrow = addDays(date, 1);
    await store.createTask({ title: "虚构昨日到期", date, dueDate: yesterday });
    await store.createTask({ title: "虚构今日到期", date: tomorrow, dueDate: date });
    await store.createTask({ title: "虚构今日计划", date });
    await store.createTask({ title: "虚构跨日计划尚未结束", date: yesterday, endDate: tomorrow });
    await store.createTask({ title: "虚构明日到期", date, dueDate: tomorrow });
    const finished = await store.createTask({ title: "虚构逾期已完成", date: yesterday, dueDate: yesterday });
    await store.completeTask(finished.id);
    const onVoiceText = vi.fn();
    const result = await new AgentLoop(host).run(input({
      source, onVoiceText,
      message: "我今天还有什么任务没完成？请把已逾期的和今天到期的分开列出来。"
    }));
    expect(result.text.split("\n")).toEqual([
      "已逾期 1 项。", expect.stringContaining("虚构昨日到期"),
      "今天到期 1 项。", expect.stringContaining("虚构今日到期")
    ]);
    expect(result.toolCalls).toEqual([{ name: "list_tasks", ok: true }]);
    expect(result.receipts).toEqual([]);
    expect(requests).toHaveLength(0);
    if (source === "voice") expect(onVoiceText).toHaveBeenCalledExactlyOnceWith(result.text);
    responses.push(reply("虚构综合规划。"));
    expect((await new AgentLoop(host).run(input({ message: "我今天还有什么任务没完成？请把已逾期的和今天到期的分开列出来。再排一下优先级。" }))).text)
      .toBe("虚构综合规划。");
    expect(requests).toHaveLength(1);
  });

  it("reports a direct completed-task count before checking model availability", async () => {
    const date = formatDate(now);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    host.settings.ai = { ...host.settings.ai, provider: "off" };
    try {
      const task = await store.createTask({ title: "虚构已完成任务", date });
      await store.completeTask(task.id);
      const loop = new AgentLoop(host);
      const result = await loop.run(input({ message: "今天完成了几个任务？" }));
      expect(result.text).toBe("今天已完成 1 个任务。");
      expect(result.toolCalls).toEqual([{ name: "get_stats", ok: true }]);
      expect(result.receipts).toEqual([]);
      expect(requests).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it("includes a still-active multiday plan in the regular local task list", async () => {
    const date = formatDate(now);
    await store.createTask({ title: "虚构仍在计划内", date: addDays(date, -1), endDate: addDays(date, 1) });
    await store.createTask({ title: "虚构计划已结束", date: addDays(date, -3), endDate: addDays(date, -1) });
    const result = await new AgentLoop(host).run(input({ message: "今天有哪些未完成的任务？" }));
    expect(result.text).toContain("今天有 1 个未完成任务。");
    expect(result.text).toContain("虚构仍在计划内");
    expect(result.text).not.toContain("虚构计划已结束");
    expect(requests).toHaveLength(0);
  });

  it("reads a simple priority question from the verified local order, reasons, and recorded energy", async () => {
    const data = { energy: 2, tasks: [
      { title: "虚构见样品负责人", time: "原安排 21:00", reasons: ["今天到期", "重要且紧急"] },
      { title: "虚构整理周报", reasons: ["今天到期"] },
      { title: "虚构复核地图", reasons: [] }
    ] };
    vi.spyOn(host, "executeTools").mockImplementation(async calls => calls.map(call =>
      ({ callId: call.id!, success: true, output: JSON.stringify(data), actions: [] })));
    const result = await new AgentLoop(host).run(input({ message: "今天应该先做哪些？" }));
    expect(result.text).toContain("先做「虚构见样品负责人」，原安排 21:00，今天到期，重要且紧急。然后做「虚构整理周报」");
    expect(result.text).toContain("精力 2 分");
    expect(requests).toHaveLength(0);
    expect(result.receipts).toEqual([]);
  });

  it.each(["single", "duplicate", "also-plan"].flatMap(mode => ["text", "voice"].map(source => [mode, source] as const)))(
    "reports a brief computed remaining count after continuation (%s/%s)", async (mode, source) => {
    const date = formatDate(now);
    await store.createTask({ title: "虚构归档", date, quadrant: "not-important-not-urgent" });
    await store.createTask({ title: "虚构核对计划", date, quadrant: "important-not-urgent" });
    await store.createTask({ title: "虚构验收", date, quadrant: "important-urgent" });
    responses.push(reply("", [tool("list_tasks", { date, order: "priority", limit: 2, directReply: true }),
      ...(mode === "duplicate" ? [tool("list_tasks", { directReply: true }, "synthetic-count")] : []),
      ...(mode === "also-plan" ? [tool("plan_today", {}, "synthetic-plan")] : [])]));
    responses.push(reply("模型很长的提醒。".repeat(50)));
    const spoken: string[] = [];
    const result = await new AgentLoop(host).run(input({ message: "今天还剩几项，只说最要紧的两件。", source: source as "text" | "voice",
      onVoiceText: source === "voice" ? text => spoken.push(text) : undefined }));
    expect(requests).toHaveLength(2);
    expect(result.text).toBe("今天还有 3 项未完成任务。先做：虚构验收、虚构核对计划。");
    expect(result.toolCalls).toEqual([{ name: "list_tasks", ok: true }]);
    expect((await store.readTaskDb({ readOnly: true })).tasks).toHaveLength(3);
    expect(spoken.join("")).toBe(source === "voice" ? result.text : "");
  });

  it.each(["text", "voice"] as const)("reads the three status domains without a model for an overall status request (%s)", async source => {
    await store.createTask({ title: "虚构近期计划", date: formatDate(now) });
    await store.createTask({ title: "虚构较早计划", date: addDays(formatDate(now), -8) });
    const chunks: string[] = [];
    const spoken: string[] = [];
    const result = await new AgentLoop(host).run(input({ source, message: "讲讲我最近的整体状态。",
      onText: chunk => chunks.push(chunk), onVoiceText: chunk => spoken.push(chunk) }));
    expect(result.text).toContain("安排了 1 项任务，完成其中 0 项。");
    expect(result.text).toContain("0 项习惯有达标记录");
    expect(result.text).toContain("有 0 篇日记。没有可核对的状态数值。");
    expect(chunks.join("")).toBe(result.text);
    expect(spoken.join("")).toBe(source === "voice" ? result.text : "");
    expect(result.toolCalls).toEqual(Array.from({ length: 3 }, () => ({ name: "get_stats", ok: true })));
    expect(result.receipts).toEqual([]);
    expect(requests).toEqual([]);
  });

  it.each(["text", "voice"] as const)("keeps a narrowly scoped mood question on the requested topic (%s)", async source => {
    responses.push(reply("日记记载，最近精力偏低。"));
    const result = await new AgentLoop(host).run(input({ source, message: "我最近三天的情绪怎么样？" }));
    expect(result.text).toBe("日记记载，最近精力偏低。");
    expect(result.toolCalls).toEqual([]);
  });

  it("keeps the exact title when a single explicit task places its start in a separate clause", async () => {
    const title = "研习蓝色样品盒贴标签";
    const result = await new AgentLoop(host).run(input({ message: `请创建任务 ${title}，安排在明天下午三点。` }));
    expect(result.text).toContain(title);
    expect(result.receipts).toHaveLength(1);
    expect((await store.readTaskDb()).tasks).toMatchObject([{ title, date: addDays(formatDate(now), 1), time: "15:00" }]);
    expect(requests).toHaveLength(0);
  });

  it("reports precise market win rates with read-only tool results without a model rewrite", async () => {
    const date = formatDate(now);
    const stats = { domain: "trades", groupBy: "market", range: { from: date, to: date }, groups: [
      { key: "美股", byCurrency: { USD: { count: 8, winPercent: 57.14, winCount: 4, lossCount: 3 } } },
      { key: "外汇", byCurrency: { USD: { count: 4, winPercent: 66.67, winCount: 2, lossCount: 1 } } }
    ] };
    host.executeTools = async calls => calls.map(call => ({ callId: call.id!, success: true,
      output: call.name === "get_stats" ? JSON.stringify(stats) : "其他虚构交易说明", actions: [] }));
    responses.push(reply("", [tool("get_stats", { domain: "trades", range: "this_month", groupBy: "market" }),
      tool("inspect_trade_review", { period: "month" }, "additional-read")]));
    const result = await new AgentLoop(host).run(input({ message: "这个月各有记录的市场分别是什么胜率？" }));
    expect(result.text).toContain("美股：57.14%（盈利 4 笔，亏损 3 笔）");
    expect(result.text).toContain("外汇：66.67%（盈利 2 笔，亏损 1 笔）");
    expect(requests).toHaveLength(1);
  });

  it("reports the recorded rule version when the model also asks for trading statistics", async () => {
    const evidence = [{ date: "2026-11-12", label: "虚构合约多单", modelId: "model", versionId: "v1", ruleViolations: ["stop"] }];
    const rules = [
      { modelId: "model", versionId: "v2", modelName: "虚构新版", ruleId: "stop", text: "虚构新版规则" },
      { modelId: "model", versionId: "v1", modelName: "虚构第一版", ruleId: "stop", text: "虚构旧版止损规则" }
    ];
    host.executeTools = async calls => calls.map(call => ({ callId: call.id!, success: true,
      output: call.name === "inspect_trade_review" ? JSON.stringify({ evidence, rules }) : "其他虚构统计", actions: [] }));
    responses.push(reply("", [tool("get_stats", { domain: "trades", range: "this_month" }),
      tool("inspect_trade_review", { period: "month" }, "additional-read")]));
    const result = await new AgentLoop(host).run(input({ message: "给交易纪律提一条改进建议，说清楚哪笔违反哪条规则。" }));
    expect(result.text).toContain("虚构合约多单");
    expect(result.text).toContain("「虚构第一版」中的「虚构旧版止损规则」");
    expect(requests).toHaveLength(1);
  });

  it.each([true, false])("keeps verified reading links when requested (present in draft: %s)", async present => {
    const link = "[[虚构阅读/角色设定与镜头]]";
    const answer = present ? "参考：" + link : "可以先读《角色设定与镜头》。";
    host.executeTools = async calls => calls.map(call => ({ callId: call.id!, success: true,
      output: JSON.stringify({ articles: [{ title: "角色设定与镜头", link }] }), actions: [] }));
    responses.push(reply("", [tool("search_reading", { query: "虚构定格动画" })]), reply(answer));
    const chunks: string[] = [];
    const result = await new AgentLoop(host).run(input({ message: "哪些最近的阅读和虚构定格动画相关？给我原笔记链接。",
      onText: chunk => chunks.push(chunk) }));
    expect(result.text).toBe(present ? answer : answer + "\n\n笔记链接：" + link);
    expect(chunks.join("")).toBe(result.text);
    expect(result.receipts).toEqual([]);
  });

  it("reports the completion rate from the actual period without choosing a summary", async () => {
    const date = formatDate(now);
    await store.createTask({ title: "虚构本月计划", date });
    await store.createTask({ title: "虚构其他月计划", date: "2026-10-12" });
    const response = await new AgentLoop(host).run(input({ message: "我这个月任务完成率是多少？" }));
    expect(response.text).toContain("计划任务完成率为 0%，完成 0 项，共计划 1 项。");
    expect(response.toolCalls).toEqual([{ name: "get_stats", ok: true }]);
    expect(requests).toHaveLength(0);
  });

  it.each([
    { source: "text", message: "今天是不是排多了？" },
    { source: "voice", message: "今天是不是排多了？" },
    { source: "text", message: "今天的待办能做完吗？" },
    { source: "voice", message: "今天的安排来得及完成吗？" }
  ] as const)("answers a direct capacity question using the local plan ($source, $message)", async ({ source, message }) => {
    const facts = { today: { scheduled: 12 }, capacity: { overloaded: true, typicalCount: 6, suggestDefer: ["can-defer", "unavailable"] },
      scope: "只提供允许读取的记录", tasks: [{ id: "can-defer", title: "整理虚构样品" }, { id: "due", title: "交虚构周报" }] };
    const executeTools = vi.spyOn(host, "executeTools").mockImplementation(async calls => calls.map(call =>
      ({ callId: call.id!, success: true, output: JSON.stringify(facts), actions: [] })));
    const onVoiceText = vi.fn();
    const loop = new AgentLoop(host);
    const result = await loop.run(input({ source, message, onVoiceText }));
    expect(result.text).toBe("按近期记录，今天的待办已超载。今天原排 12 项，常态每天完成约 6 项。可以考虑延后「整理虚构样品」。只统计允许读取的记录。");
    expect(executeTools.mock.calls[0][0]).toMatchObject([{ name: "plan_today", arguments: {} }]);
    if (source === "voice") expect(onVoiceText).toHaveBeenCalledExactlyOnceWith(result.text);
    expect(requests).toHaveLength(0);
    expect(result.receipts).toEqual([]);
    expect(result.confirmations).toEqual([]);
    responses.push(reply("虚构综合规划。"));
    expect((await loop.run(input({ source, message: "今天是不是排多了？顺便把虚构周报挪到明天。" }))).text)
      .toBe("虚构综合规划。");
    expect(requests).toHaveLength(1);
  });

  it.each(["text", "voice"] as const)("answers explicit device sleep questions from confirmed health records (%s)", async source => {
    const date = formatDate(now);
    const previous = addDays(date, -1);
    await store.appendHealthEntry({ date, sleepHours: 7.75 });
    await store.appendHealthEntry({ date: previous, sleepHours: 5.25 });
    await store.appendHealthEntry({ date: addDays(date, 1), sleepHours: 20 });
    const spoken = vi.fn();
    const message = "最近三天设备记录的睡眠时长平均是多少小时？";
    const result = await new AgentLoop(host).run(input({ source, message, onVoiceText: spoken }));
    expect(result.text).toContain("有 2 天设备睡眠记录，平均 6.5 小时。");
    if (source === "voice") expect(spoken).toHaveBeenCalledExactlyOnceWith(result.text);
    expect(result.toolCalls).toEqual([{ name: "get_stats", ok: true }]);
    expect(requests).toHaveLength(0);
    store.settings.privacy!.excludedVaultPrefixes = [store.path(store.settings.folders.health, previous + ".md")];
    const scoped = await new AgentLoop(host).run(input({ source, message }));
    expect(scoped.text).toContain("有 1 天设备睡眠记录，平均 7.75 小时。只统计允许读取的健康记录。");
    store.settings.privacy!.excludedVaultPrefixes.push(store.path(store.settings.folders.health, date + ".md"));
    const empty = await new AgentLoop(host).run(input({ source, message }));
    expect(empty.text).toContain("暂无可读的设备睡眠记录。只统计允许读取的健康记录。");
    expect(requests).toHaveLength(0);
  });

  it.each([
    { message: "这周睡得怎么样？", source: "text", offline: true },
    { message: "本周手表记录的睡眠怎么样？", source: "voice", offline: false }
  ] as const)("reads a bounded device sleep overview ($message)", async ({ message, source, offline }) => {
    const date = formatDate(now);
    await store.appendHealthEntry({ date, sleepHours: 7.5 });
    await store.appendHealthEntry({ date: addDays(date, -1), sleepHours: 5.5 });
    await store.appendHealthEntry({ date: addDays(date, 1), sleepHours: 20 });
    if (offline) host.settings.ai = { ...host.settings.ai, provider: "off" };
    const spoken = vi.fn();
    const result = await new AgentLoop(host).run(input({ message, source, onVoiceText: spoken }));
    expect(result.text).toBe(`2026-11-09 至 ${date} 有 2 天设备睡眠记录，平均 6.5 小时。`);
    expect(result.toolCalls).toEqual([{ name: "get_stats", ok: true }]);
    expect(requests).toHaveLength(0);
    if (source === "voice") expect(spoken).toHaveBeenCalledExactlyOnceWith(result.text);
  });

  it("can read one clearly requested device sleep result offline and keeps qualitative analysis in the model path", async () => {
    const date = formatDate(now);
    await store.appendHealthEntry({ date, sleepHours: 7.5 });
    const saved = host.settings.ai;
    host.settings.ai = { ...saved, provider: "off" };
    let local;
    try {
      local = await new AgentLoop(host).run(input({ message: "昨晚手表记录的睡眠时长是多少小时？" }));
    } finally { host.settings.ai = saved; }
    expect(local.text).toContain(date + " 有 1 天设备睡眠记录，平均 7.5 小时。");
    expect(requests).toHaveLength(0);
    responses.push(reply("虚构问题走一般分析。"));
    const mixed = await new AgentLoop(host).run(input({ message: "这周手表记录的睡眠时长平均是多少，为什么会这样？" }));
    expect(mixed.text).toBe("虚构问题走一般分析。");
    responses.push(reply("虚构问题需要同时理解日记。"));
    const subjective = await new AgentLoop(host).run(input({ message: "这周睡得怎么样？" }));
    expect(subjective.text).toBe("虚构问题需要同时理解日记。");
    expect(requests).toHaveLength(2);
  });

  it("uses measured values, their date coverage, and explicit aggregations for other device questions", async () => {
    const today = formatDate(now), yesterday = addDays(today, -1), tomorrow = addDays(today, 1);
    await store.appendHealthEntry({ date: today, steps: 0, runningKm: 2.25, weightKg: 70.5 });
    await store.appendHealthEntry({ date: yesterday, steps: 1234, runningKm: 1.25, weightKg: 71.5, restingHeartRate: 61 });
    await store.appendHealthEntry({ date: tomorrow, steps: 9999, runningKm: 100, restingHeartRate: 45 });
    const loop = new AgentLoop(host);
    const questions = [
      ["今天手表记录的步数是多少步？", "有 1 天设备步数记录，记录值 0 步。"],
      ["昨天手表记录的步数是多少步？", "有 1 天设备步数记录，记录值 1234 步。"],
      ["十一月十一日的设备体重是多少公斤？", "有 1 天设备体重记录，记录值 71.5 公斤。"],
      ["2026-11-11设备记录的静息心率是多少次/分？", "有 1 天设备静息心率记录，记录值 61 次/分。"],
      ["最近三天设备记录的步数合计多少步？", "有 2 天设备步数记录，合计 1234 步。"],
      ["过去三天设备记录的跑步距离一共是多少公里？", "有 2 天设备跑步距离记录，合计 3.5 公里。"],
      ["最近三天手表记录的体重平均是多少公斤？", "有 2 天设备体重记录，平均 71 公斤。"],
      ["最近三天手表记录的静息心率平均是多少次/分？", "有 1 天设备静息心率记录，平均 61 次/分。"],
      ["今天设备记录的静息心率是多少？", "暂无可读的设备静息心率记录。"]
    ] as const;
    for (const [message, expected] of questions) {
      const onVoiceText = vi.fn();
      const result = await loop.run(input({ source: "voice", message, onVoiceText }));
      expect(result.text).toContain(expected);
      expect(result.toolCalls).toEqual([{ name: "get_stats", ok: true }]);
      expect(onVoiceText).toHaveBeenCalledExactlyOnceWith(result.text);
    }
    expect(requests).toHaveLength(0);
    responses.push(reply("虚构综合分析。"));
    const mixed = await loop.run(input({ message: "今天设备记录的步数是多少，为什么走得少？" }));
    expect(mixed.text).toBe("虚构综合分析。");
    expect(requests).toHaveLength(1);
  });

  it("uses the wake-up day for last night's device sleep and leaves future measurements unanswered locally", async () => {
    const date = formatDate(now), yesterday = addDays(date, -1), tomorrow = addDays(date, 1);
    await store.appendHealthEntry({ date, sleepHours: 8 });
    await store.appendHealthEntry({ date: yesterday, sleepHours: 5 });
    await store.appendHealthEntry({ date: tomorrow, steps: 4321 });
    const loop = new AgentLoop(host);
    expect((await loop.run(input({ message: "昨夜设备记录的睡眠时长是多少小时？" }))).text).toContain(date + " 有 1 天设备睡眠记录，平均 8 小时");
    expect((await loop.run(input({ message: "昨天设备记录的睡眠时长是多少小时？" }))).text).toContain(yesterday + " 有 1 天设备睡眠记录，平均 5 小时");
    expect(requests).toHaveLength(0);
    responses.push(reply("虚构未来日期问题。"));
    const future = await loop.run(input({ message: "明天设备记录的步数是多少步？" }));
    expect(future.text).toBe("虚构未来日期问题。");
    expect(future.toolCalls).toEqual([]);
  });

  it.each(["get_stats", "query_vault"])("adds verified habit dates only from the stats tool (%s)", async name => {
    const answer = "虚构存钱在11月11日没达标。";
    const report = { domain: "habits", range: { from: "2026-11-09", to: "2026-11-12" },
      habits: [{ name: "虚构存钱", goals: [{ period: "day", missedDates: ["2026-11-10", "2026-11-11"] }] }] };
    vi.spyOn(host, "executeTools").mockImplementation(async calls => calls.map(call =>
      ({ callId: call.id!, success: true, output: JSON.stringify(report), actions: [] })));
    responses.push(reply("", [tool(name, name === "get_stats" ? { domain: "habits", range: "this_week" }
      : { domain: "note", operation: "search", query: "虚构统计" })]), reply(answer));
    const streamed: string[] = [];
    const result = await new AgentLoop(host).run(input({ message: "复核本周虚构习惯", onText: chunk => streamed.push(chunk) }));
    expect(result.text).toBe(name === "get_stats"
      ? answer + "\n\n核对到的未达标日期：「虚构存钱」11-10、11-11。" : answer);
    expect(streamed.join("")).toContain(answer);
  });

  it("reports explicit weekly habit completion from the existing stats with the text model disabled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const habit = await store.createHabit({ name: "虚构一周跑步", frequencyUnit: "day", frequencyInterval: 1,
        targetCount: 1, startDate: "2026-11-09" });
      await store.recordHabitStatus(habit.id, "done", "2026-11-10");
      host.settings.ai.provider = "off";
      const loop = new AgentLoop(host);
      const onVoiceText = vi.fn();
      const result = await loop.run(input({ message: "这周习惯完成得怎么样？", source: "voice", onVoiceText }));
      expect(result.text).toContain("2026-11-09 至 2026-11-12");
      expect(result.text).toContain("虚构一周跑步有 1 次完成记录，完成率 25%");
      expect(result.toolCalls).toEqual([{ name: "get_stats", ok: true }]);
      expect(onVoiceText).toHaveBeenCalledExactlyOnceWith(result.text);
      expect(requests).toEqual([]);
      expect(await loop.run(input({ message: "上周的习惯完成情况" }))).toMatchObject({
        text: expect.stringContaining("2026-11-02 至 2026-11-08")
      });
    } finally { vi.useRealTimers(); }
  });

  it("expands advanced tools when the short-text model selects that capability", async () => {
    responses.push(reply("", [tool("load_more_tools", {})]), reply("已准备好查询项目。"));
    const result = await new AgentLoop(host).run(input({ message: "查我的项目" }));
    expect(catalogs[0]).toContain("load_more_tools");
    expect(catalogs[0]).not.toContain("query_projects");
    expect(catalogs[1]).toContain("query_projects");
    expect(result.toolCalls).toEqual([{ name: "load_more_tools", ok: true }]);
  });

  it("returns the exact habit name from the delete confirmation without another model call", async () => {
    const habit = await store.createHabit({ name: "虚构阅读", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    responses.push(reply("", [tool("delete_habit", { name: habit.name })]));
    const result = await new AgentLoop(host).run(input({ message: "删除虚构阅读习惯" }));
    expect(result.text).toBe("已生成删除「虚构阅读」的确认卡，点击确认后才会删除。");
    expect(result.confirmations).toMatchObject([{ type: "delete_habit", habitIds: [habit.id] }]);
    expect(requests).toHaveLength(1);
    expect((await store.readHabitDb()).habits.some(item => item.id === habit.id)).toBe(true);
  });

  it("makes an explicit tomorrow draft selection continue to a capacity-checked confirmation", async () => {
    const date = addDays(todayString(), 1);
    const prepare = vi.fn(async () => ({ id: "preview-tomorrow", type: "task_plan" as const, title: "确认安排",
      description: "点确认后保存", content: "虚构草案", date, taskPlanToken: "preview-token" }));
    runtime = new AgentRuntime({ store, refreshViews: async () => {}, prepareTaskPlan: prepare });
    responses.push(reply("", [tool("plan_today", { draftTomorrow: true })]),
      reply("", [tool("propose_task_plan", { tasks: [{ title: "准备虚构材料", date }] })]));
    const result = await new AgentLoop(host).run(input({ message: "给我安排一下明天" }));
    expect(toolChoices[1]).toEqual({ type: "function", function: { name: "propose_task_plan" } });
    expect(prepare).toHaveBeenCalledOnce();
    expect(result.confirmations).toMatchObject([{ type: "task_plan" }]);
    expect((await store.readTaskDb()).tasks).toEqual([]);
  });

  it("keeps provisional tool text and generated write claims out of the voice stream", async () => {
    const onVoiceText = vi.fn();
    responses.push(reply("我已经记好了。", [tool("create_task", { title: "虚构语音回执" })]), reply("任务已创建。"));
    const result = await new AgentLoop(host).run(input({ source: "voice", message: "把虚构语音回执记作待办。", onVoiceText }));
    expect(result.receipts).toHaveLength(1);
    expect(result.voiceSpeech).toBe("已创建任务：虚构语音回执。");
    expect(onVoiceText).not.toHaveBeenCalled();
    expect((await store.readTaskDb()).tasks).toMatchObject([{ title: "虚构语音回执" }]);
  });

  it("speaks only verified journal, habit and trading receipts and can undo a saved voice write", async () => {
    const habit = await store.createHabit({ name: "虚构阅读习惯", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    const loop = new AgentLoop(host);
    const voice = async (message: string, name: string, args: Record<string, unknown>) => {
      responses.push(reply("", [tool(name, args)]));
      responses.push(name === "undo_latest_operation" ? voiceUndoApproval() : reply("模型输出的示例文字。"));
      return loop.run(input({ source: "voice", message }));
    };
    const checkin = await voice("给虚构阅读习惯打卡", "complete_habit", { name: habit.name });
    expect(checkin.voiceSpeech).toBe("已完成今日打卡：虚构阅读习惯。");
    expect((await store.readHabitDb()).checkins).toContainEqual(expect.objectContaining({ habitId: habit.id, status: "done" }));
    const transcript = "记到晚间日记：嗯，虚构蓝纸盒今天没整理。\n## 虚构行\n~~~  先保留这句。  ";
    const note = await voice(transcript, "append_journal_entry", { period: "晚", content: "今天没整理蓝纸盒。", heading: "原话" });
    expect(note.voiceSpeech).toBe("好，已经记进日记了。");
    const diaryPath = store.dailyNotePath(todayString(), "晚");
    const firstDiary = await store.readPath(diaryPath);
    expect(firstDiary).toContain("## 整理\n\n今天没整理蓝纸盒。");
    expect(firstDiary).toContain("## 原话\n\n~~~~\n" + transcript + "\n~~~~");
    const second = "记到晚间日记：准备先整理一个。";
    await voice(second, "append_journal_entry", { period: "晚", content: "先整理一个。"});
    const diary = await store.readPath(diaryPath);
    expect(diary.match(/^## 原话$/gm)).toHaveLength(1);
    expect(diary).toContain(transcript);
    expect(diary).toContain("~~~\n" + second + "\n~~~");
    expect(diary.indexOf("先整理一个。")).toBeLessThan(diary.indexOf("## 原话"));
    const trade = await voice("记一笔虚构交易，A股 ZTEST8 做多", "record_trade", {
      trades: [{ market: "A股", symbol: "ZTEST8", direction: "long" }] });
    expect(trade.voiceSpeech).toBe("已记下 1 笔交易。");
    expect((await readTradeDatabase(store)).trades).toHaveLength(1);
    const undo = await voice("撤销", "undo_latest_operation", {});
    expect(undo.voiceSpeech).toBe("已撤销这次交易记录。");
    expect((await readTradeDatabase(store)).trades).toHaveLength(0);
  });

  it("preserves the original diary turn through batch confirmation", async () => {
    const message = "请都记下。\n晚间原话：嗯，虚构路线今天才画完。";
    const date = formatDate(now);
    responses.push(reply("", [
      tool("append_journal_entry", { date, period: "晚", content: "虚构路线绘制完毕。" }, "journal"),
      ...["纸夹", "纸袋", "纸盒"].map(title => tool("create_task", { title: "虚构归档" + title, date }, title))
    ]));
    const result = await new AgentLoop(host).run(input({ message }));
    const [action] = result.confirmations;
    expect(action.type).toBe("tool_batch");
    expect(JSON.stringify(action)).not.toContain("今天才画完");
    const path = store.dailyNotePath(date, "晚");
    expect(await store.readPath(path)).toBe("");
    await executeConfirmedToolBatch(action, runtime, () => {});
    expect(await store.readPath(path)).toContain("## 原话\n\n~~~\n" + message + "\n~~~");
    expect((await store.readTaskDb()).tasks).toHaveLength(3);
  });

  it("preserves journal frontmatter and stops before appending into an open code fence", async () => {
    const date = formatDate(now), path = store.dailyNotePath(date, "晚");
    const header = "\uFEFF---\r\nsubject: |\r\n  ## 整理\r\n---\r\n";
    const available = header + "\r\n## 原话\r\n\r\n已有原话\r\n";
    await store.writeFile(path, available);
    const args = { date, period: "晚", content: "汇总虚构新句。" };
    const original = "记下今天整理好了。";
    const stored = await runtime.executeAiToolCall(tool("append_journal_entry", args, "journal-frontmatter"), "kimi", original);
    expect(stored.success).toBe(true);
    const diary = await store.readPath(path);
    expect(diary.startsWith(header)).toBe(true);
    expect(diary).toContain("## 整理\n\n汇总虚构新句。");
    expect(diary).toContain(original);

    const openFence = header + "\n## 整理\n\n~~~text\n用户尚在填写。\n";
    await store.writeFile(path, openFence);
    const blocked = await runtime.executeAiToolCall(tool("append_journal_entry", args, "journal-open-fence"), "kimi", original);
    expect(blocked.success).toBe(false);
    expect(blocked.output).toContain("未闭合");
    expect(await store.readPath(path)).toBe(openFence);
  });

  it("leaves hidden Markdown headings alone when writing the evening diary", async () => {
    const date = formatDate(now), path = store.dailyNotePath(date, "晚");
    const comment = "<!--\n## 原话\n虚构模板\n-->\n%%\n## 整理\n%%\n";
    await store.writeFile(path, "# 虚构日记\n" + comment);
    const args = { date, period: "晚", content: "写完地图。" };
    const original = "刚把虚构地图画好了。";
    const saved = await runtime.executeAiToolCall(tool("append_journal_entry", args, "journal-comment"), "kimi", original);
    expect(saved.success).toBe(true);
    expect(await store.readPath(path)).toContain(comment + "\n## 整理");
    expect(await store.readPath(path)).toContain("## 原话\n\n~~~\n" + original);
    const unfinished = "%%\n虚构草稿还在填写\n";
    await store.writeFile(path, unfinished);
    const blocked = await runtime.executeAiToolCall(tool("append_journal_entry", args, "journal-open-comment"), "kimi", original);
    expect(blocked.output).toContain("未闭合的属性、注释或代码块");
    expect(await store.readPath(path)).toBe(unfinished);
  });

  it("keeps the original diary section after a model draft contains a reserved heading", async () => {
    const date = formatDate(now), path = store.dailyNotePath(date, "晚");
    const original = "虚构原话：刚把纸地图画好。";
    const content = "草稿里的虚构标题\n\n## 原话\n\n另一段整理后的话。";
    const saved = await runtime.executeAiToolCall(tool("append_journal_entry", { date, period: "晚", content }, "journal-reserved-heading"), "kimi", original);
    expect(saved.success, saved.output).toBe(true);
    const diary = await store.readPath(path);
    expect(diary).toContain("### 原话\n\n另一段整理后的话。");
    const rawSection = diary.slice(diary.indexOf("\n## 原话\n"));
    expect(rawSection).toContain("~~~\n" + original + "\n~~~");
    expect(rawSection).not.toContain("另一段整理后的话");
    expect(diary.match(/^## 原话$/gm)).toHaveLength(1);
    const blocked = await runtime.executeAiToolCall(tool("append_journal_entry", {
      date, period: "晚", content: "虚构整理稿\n~~~text\n代码块没收口。"
    }, "journal-draft-open-fence"), "kimi", "另一条虚构原话。");
    expect(blocked.success).toBe(false);
    expect(blocked.output).toContain("整理稿有未闭合");
    expect(await store.readPath(path)).toBe(diary);
  });

  it("keeps generated underlined headings and code inside the evening draft", async () => {
    const date = formatDate(now), path = store.dailyNotePath(date, "晚");
    const code = "~~~markdown\n原话\n----\n~~~";
    const content = "整理标题\n=====\n\n原话\n----\n\n虚构整理内容。\n\n***\n---\n\n" + code;
    const original = "保留虚构原话。\n原话\n----";
    const result = await runtime.executeAiToolCall(tool("append_journal_entry",
      { date, period: "晚", content }, "journal-setext-draft"), "kimi", original);
    expect(result.success, result.output).toBe(true);
    const diary = await store.readPath(path);
    const [draft, recorded] = diary.split("\n## 原话\n");
    expect(draft).toContain("### 整理标题");
    expect(draft).toContain("### 原话");
    expect(draft).toContain("\n\n***\n---\n\n" + code);
    expect(recorded).toContain("~~~\n" + original + "\n~~~");
    expect(recorded).not.toContain("虚构整理内容");
  });

  it("appends into an existing underlined original section and preserves the hand-written note", async () => {
    const date = formatDate(now), path = store.dailyNotePath(date, "晚");
    const before = "\uFEFF# 虚构晚间日记\n\n## 整理\n\n已有整理。\n\n原话\n----\n\n~~~\n昨天的原话  \n~~~\n\n## 手写尾记\n\n原有尾记。\n";
    const original = "今天的虚构原话，逐字保存。";
    await store.writeFile(path, before);
    const result = await runtime.executeAiToolCall(tool("append_journal_entry",
      { date, period: "晚", content: "今天的整理稿。" }, "journal-setext-existing"), "kimi", original);
    expect(result.success, result.output).toBe(true);
    const diary = await store.readPath(path);
    const [draft, remainder] = diary.split("\n原话\n----\n");
    const [recorded, end] = remainder.split("\n## 手写尾记\n");
    expect(diary).not.toContain("\n## 原话\n");
    expect(draft).toContain("今天的整理稿。");
    expect(recorded).toContain("~~~\n昨天的原话  \n~~~");
    expect(recorded).toContain("~~~\n" + original + "\n~~~");
    expect(end).toBe("\n原有尾记。\n");
    await runtime.undoOperation(result.receipt!.operationId);
    expect(await store.readPath(path)).toBe(before);
  });

  it("keeps a second evening diary draft without a chat message outside existing original words", async () => {
    const date = formatDate(now), path = store.dailyNotePath(date, "晚");
    const original = "昨天的虚构原话。\n逐字保留  ";
    const before = "# 虚构晚间日记\n\n## 整理\n\n之前的整理稿。\n\n## 原话\n\n~~~\n" + original + "\n~~~\n";
    await store.writeFile(path, before);
    const content = "定时写入的虚构整理稿。\n\n## 原话\n\n整理稿内还没有原文。";
    const saved = await runtime.executeAiToolCall(tool("append_journal_entry", { date, period: "晚", content }, "journal-draft-only"), "kimi");
    expect(saved.success, saved.output).toBe(true);
    const after = await store.readPath(path);
    const originalSection = "\n## 原话\n\n~~~\n" + original + "\n~~~\n";
    expect(after.slice(after.indexOf("\n## 原话\n"))).toBe(originalSection);
    expect(after).toContain("定时写入的虚构整理稿。\n\n### 原话\n\n整理稿内还没有原文。");
    expect(after.match(/^## 原话$/gm)).toHaveLength(1);
  });

  it("keeps an automatically saved memory when undoing the task from the same turn", async () => {
    const loop = new AgentLoop(host);
    const title = "虚构样品盒贴标签", preference = "我习惯用虚构绿色标签归档";
    responses.push(reply("", [tool("create_task", { title }, "same-turn-task"), tool("append_memory_note", { content: preference }, "same-turn-memory")]), reply("已保存。"));
    await loop.run(input({ message: `创建任务${title}。${preference}。` }));
    expect((await store.readTaskDb()).tasks).toHaveLength(1);
    expect((await store.readPersonalMemories()).records.map(record => record.content)).toContain(preference);

    const callsBeforeUndo = requests.length;
    const undo = await loop.run(input({ source: "voice", message: "撤销刚才那个。" }));
    expect(undo.text).toContain(title);
    expect(undo.voiceSpeech).toBe(undo.text);
    expect(requests).toHaveLength(callsBeforeUndo);
    expect((await store.readTaskDb()).tasks).toEqual([]);
    expect((await store.readPersonalMemories()).records.map(record => record.content)).toContain(preference);

    responses.push(reply("", [tool("undo_latest_operation", { memoryOnly: true })]));
    const memoryUndo = await loop.run(input({ message: "撤销刚才保存的记忆。" }));
    expect(memoryUndo.text).toContain("个人记忆");
    expect((await store.readPersonalMemories()).records.map(record => record.content)).not.toContain(preference);
  });

  it("clarifies a bare voice deletion and preserves an older idea without using the model", async () => {
    const idea = await runtime.executeAiToolCall(tool("upsert_idea", {
      title: "虚构旧想法", description: "用彩纸制作地图。"
    }, "older-voice-idea"), "kimi");
    const task = await runtime.executeAiToolCall(tool("create_task", {
      title: "虚构待办"
    }, "new-voice-task"), "kimi");
    expect(idea).toMatchObject({ success: true });
    expect(task).toMatchObject({ success: true });
    expect(await runtime.undoOperation("new-voice-task")).toBe(true);
    const result = await new AgentLoop(host).run(input({ source: "voice", message: "删除。" }));

    expect(result.text).toContain("你想删除哪一条");
    expect(result.toolCalls).toEqual([]);
    expect(requests).toEqual([]);
    expect((await new OperationLedger(store).latestReversible())?.operationId).toBe("older-voice-idea");
  });

  it("offers a completed read-only response to the voice output", async () => {
    const onVoiceText = vi.fn();
    responses.push(reply("正在查看。", [tool("get_stats", { domain: "tasks", range: "today" })]), reply("今天还没完成任务。"));
    const result = await new AgentLoop(host).run(input({ source: "voice", message: "请概括一下今天的工作进展。", onVoiceText }));
    expect(result.text).toBe("今天还没完成任务。");
    expect(onVoiceText).toHaveBeenCalledExactlyOnceWith("今天还没完成任务。");
  });

  it("speaks a single requested count straight from the tool without a second model turn", async () => {
    const habit = await store.createHabit({ name: "虚构跑步", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    await store.recordHabitStatus(habit.id, "done", todayString());
    const onVoiceText = vi.fn();
    responses.push(reply("", [tool("get_stats", { domain: "habits", range: "today", habitName: "虚构跑步", voiceAnswer: "habit_checkin" })]));
    const result = await new AgentLoop(host).run(input({ source: "voice", message: "今天虚构跑步打卡了吗？", onVoiceText }));
    expect(result.text).toBe("今天已给「虚构跑步」打卡。");
    expect(onVoiceText).toHaveBeenCalledExactlyOnceWith(result.text);
    expect(roles).toEqual(["fast"]);
  });

  it("speaks the requested top tasks in tool order without another model turn or a write", async () => {
    const date = todayString();
    await store.createTask({ title: "虚构归档", date, quadrant: "not-important-not-urgent" });
    await store.createTask({ title: "虚构汇总", date, quadrant: "important-not-urgent" });
    await store.createTask({ title: "虚构核对", date, quadrant: "important-urgent" });
    const before = await store.readTaskDb();
    const onVoiceText = vi.fn();
    responses.push(reply("", [tool("plan_today", { voicePriorityCount: 2 })]));

    const result = await new AgentLoop(host).run(input({ source: "voice", message: "今天该先做哪两件事？", onVoiceText }));

    expect(result.text).toBe("先做「虚构核对」，今天到期，重要且紧急。然后做「虚构汇总」，今天到期，重要不紧急。");
    expect(onVoiceText).toHaveBeenCalledExactlyOnceWith(result.text);
    expect(requests).toHaveLength(1);
    expect(await store.readTaskDb()).toEqual(before);
  });

  it("retries the required plan call when the model returns an unrelated read", async () => {
    const date = addDays(todayString(), 1);
    const prepare = vi.fn(async () => ({ id: "retry-tomorrow", type: "task_plan" as const, title: "确认安排",
      description: "点确认后保存", content: "虚构草案", date, taskPlanToken: "preview-token" }));
    runtime = new AgentRuntime({ store, refreshViews: async () => {}, prepareTaskPlan: prepare });
    responses.push(reply("", [tool("plan_today", { draftTomorrow: true }), tool("list_tasks", { status: "active" }, "other-reading")]),
      reply("已准备好", [tool("list_tasks", { status: "active" })]),
      reply("", [tool("propose_task_plan", { tasks: [{ title: "准备虚构材料", date }] })]));
    const onText = vi.fn();
    const result = await new AgentLoop(host).run(input({ message: "给我安排一下明天", onText }));
    expect(catalogs.slice(1)).toEqual([["propose_task_plan"], ["propose_task_plan"]]);
    expect(result.toolCalls.filter(call => call.name === "list_tasks")).toHaveLength(1);
    expect(result.confirmations).toMatchObject([{ type: "task_plan", date }]);
    expect(onText).not.toHaveBeenCalledWith("已准备好");
    expect(prepare).toHaveBeenCalledOnce();
    expect((await store.readTaskDb()).tasks).toEqual([]);
  });

  it("repairs a rejected tomorrow draft before showing the real confirmation", async () => {
    const date = addDays(todayString(), 1);
    const prepare = vi.fn(async (tasks) => {
      if (tasks[0].time !== "09:00") throw Error("任务标题、日期或时间无法识别，请核对后再保存。");
      return { id: "repaired-tomorrow", type: "task_plan" as const, title: "确认安排", description: "点确认后保存",
        content: "虚构草案", date, taskPlanToken: "preview-token" };
    });
    runtime = new AgentRuntime({ store, refreshViews: async () => {}, prepareTaskPlan: prepare });
    const onText = vi.fn();
    responses.push(reply("", [tool("plan_today", { draftTomorrow: true })]),
      reply("确认卡已生成", [tool("propose_task_plan", { tasks: [{ title: "准备虚构材料", date, time: "09:00–10:00" }] })]),
      reply("", [tool("propose_task_plan", { tasks: [{ title: "准备虚构材料", date, time: "09:00" }] })]));
    const result = await new AgentLoop(host).run(input({ message: "给我安排一下明天", onText }));
    expect(catalogs.slice(1, 3)).toEqual([["propose_task_plan"], ["propose_task_plan"]]);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(result.confirmations).toMatchObject([{ type: "task_plan", content: "虚构草案", date }]);
    expect(result.text).toContain("尚未保存任何任务");
    expect(onText).not.toHaveBeenCalledWith("确认卡已生成");
    expect((await store.readTaskDb()).tasks).toEqual([]);
  });

  it("limits execution to four tool rounds even if the final model response asks again", async () => {
    host.executeTools = vi.fn(async (calls: AiToolCall[]) => calls.map(call => ({ callId: call.id!, success: true, output: "纯虚构查询结果", actions: [] })));
    responses.push(...Array.from({ length: 5 }, () => reply("", [tool("query_vault", { domain: "task", operation: "list" })])));
    const result = await new AgentLoop(host).run(input({ message: "读取纯虚构任务。" }));
    expect(host.executeTools).toHaveBeenCalledTimes(4);
    expect(requests).toHaveLength(5);
    expect(result.toolCalls).toHaveLength(4);
    expect(result.text).toContain("本轮处理已到上限");
  });

  it("saves four newly requested tasks in one response with individual undo receipts", async () => {
    responses.push(reply("", Array.from({ length: 4 }, (_, index) => tool("create_task", { title: `纯虚构批量${index}` }, `call-${index}`))), reply("四项任务等待确认。"));
    const execute = vi.spyOn(host, "executeTools");
    const result = await new AgentLoop(host).run(input());
    expect(execute).toHaveBeenCalledOnce();
    expect(result.confirmations).toHaveLength(0);
    expect(result.receipts).toHaveLength(4);
    expect((await store.readTaskDb({ readOnly: true })).tasks).toHaveLength(4);
    await runtime.undoOperation(result.receipts[0].operationId);
    expect((await store.readTaskDb({ readOnly: true })).tasks).toHaveLength(3);
  });

  it("counts writes across rounds and confirms only the remaining write", async () => {
    const tasks = [];
    for (let i = 0; i < 4; i++) tasks.push(await store.createTask({ title: `纯虚构完成${i}` }));
    responses.push(...tasks.map(t => reply("", [tool("complete_task", { taskIdOrTitle: t.id })])), reply("三项已保存，剩余一项待确认。"));
    const result = await new AgentLoop(host).run(input());
    expect(result.receipts).toHaveLength(3);
    expect((await store.readTaskDb({ readOnly: true })).tasks.filter(t => t.status === "completed")).toHaveLength(3);
    expect(result.confirmations[0]).toMatchObject({ type: "tool_batch", batchWriteCount: 4 });
    expect(result.confirmations[0].toolBatch).toHaveLength(1);
    await executeConfirmedToolBatch(result.confirmations[0], runtime, () => {});
    expect((await store.readTaskDb({ readOnly: true })).tasks.every(t => t.status === "completed")).toBe(true);
  });

  it("retains a committed receipt when cancellation arrives after a write", async () => {
    const abort = new AbortController();
    responses.push(reply("", [tool("create_task", { title: "纯虚构取消前已保存" })]));
    const result = await new AgentLoop(host).run(input({ signal: abort.signal, onReceipt: () => abort.abort() }));
    expect(result.receipts).toHaveLength(1);
    expect(result.text).toContain("已创建");
    expect(result.text).toContain("其余处理已停止");
    expect((await store.readTaskDb({ readOnly: true })).tasks).toHaveLength(1);
  });

  it("keeps earlier receipts when a later model request fails", async () => {
    responses.push(reply("", [tool("create_task", { title: "纯虚构回复失败前已保存" })]), Error("Synthetic provider failure"));
    const result = await new AgentLoop(host).run(input());
    expect(result.receipts).toHaveLength(1);
    expect(result.text).toContain("后续回复未完成");
    expect((await store.readTaskDb({ readOnly: true })).tasks).toHaveLength(1);
  });

  it("keeps deep analysis internal and preserves mixed call order", async () => {
    const effects: string[] = [], chunks: string[] = [];
    host.executeTools = async calls => calls.map(call => { effects.push(call.name); return { callId: call.id!, success: true, output: "纯虚构结果", actions: [] }; });
    responses.push(reply("", [tool("query_vault", {}, "read"), tool("deep_analysis", { question: "纯虚构分析", scope: "纯虚构资料" }, "deep"), tool("create_task", {}, "write")]),
      reply("仅供内部使用的纯虚构深度稿"), reply("分析完成。"));
    const original = host.aiForRole;
    host.aiForRole = role => { if (role === "deep") effects.push("deep"); return original(role); };
    const result = await new AgentLoop(host).run(input({ source: "voice", onText: delta => chunks.push(delta) }));
    expect(effects).toEqual(["query_vault", "deep", "create_task"]);
    expect(roles).toEqual(["fast", "deep", "fast"]);
    expect(chunks.join("")).toBe("分析完成。");
    expect(result.usage.inputTokens).toBe(120);
  });

  it("does not estimate missing usage or call a model when disabled", async () => {
    responses.push({ content: "纯虚构无用量回复", toolCalls: [] });
    const result = await new AgentLoop(host).run(input());
    expect(result.usage.inputTokens).toBeUndefined();
    host.settings.ai.provider = "off";
    const before = requests.length;
    const offline = await new AgentLoop(host).run(input());
    expect(requests).toHaveLength(before);
    expect(host.offlineFallback).toHaveBeenCalled();
    expect(offline.usage.model).toBe("offline");
  });

  it("bounds resident context and reads the injected date without changing files", async () => {
    for (let index = 0; index < 20; index++) await store.createTask({ title: `纯虚构长标题${index}${"甲".repeat(100)}`, date: "2026-11-12" });
    const before = await readFile(join(root, store.taskDbPath()), "utf8");
    const context = await buildResidentContext(store, "纯虚构查询", now);
    expect(Buffer.byteLength(context.text, "utf8")).toBeLessThanOrEqual(RESIDENT_CONTEXT_BYTE_LIMIT);
    expect(context.text).toContain("2026-11-12");
    expect(context.text).toContain("必须给确认卡");
    expect(context.text).toContain("不得鼓励");
    expect(await readFile(join(root, store.taskDbPath()), "utf8")).toBe(before);
  });

  it("selects existing model configurations without mutating stored settings", () => {
    const settings = structuredClone(host.settings);
    settings.ai = { ...settings.ai, fallbackProvider: "custom", fallbackEndpoint: "https://fiction-fast.invalid/chat", fallbackModel: "synthetic-fast" };
    expect(settingsForAgentModel(settings, "fast").ai).toMatchObject({ model: "synthetic-fast", fallbackModel: "synthetic-model" });
    expect(settingsForAgentModel(settings, "deep").ai.model).toBe("synthetic-model");
    expect(settings.ai.model).toBe("synthetic-model");
  });

  it("requests DeepSeek non-thinking mode and records actual usage through the fallback transport", async () => {
    const settings = structuredClone(host.settings);
    settings.ai = { ...settings.ai, model: "deepseek-v4-flash", fallbackProvider: "custom",
      fallbackEndpoint: "https://fiction-fallback.invalid/chat", fallbackModel: "kimi-k2.6" };
    const wire = [
      { model: "kimi-k2.6", choices: [{ index: 0, delta: { content: "纯虚构备用回复" }, finish_reason: null }] },
      { model: "kimi-k2.6", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { model: "kimi-k2.6", choices: [], usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 } }
    ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new TypeError("Synthetic transport failure"))
      .mockResolvedValueOnce(new Response(wire, { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetch);
    const result = await new LifeOpsAi(settings).agentTurnStream([{ role: "user", content: "纯虚构问候" }], () => {}, { reasoning: "disabled" });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([settings.ai.endpoint, settings.ai.fallbackEndpoint]);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({
      thinking: { type: "disabled" }, stream_options: { include_usage: true }
    });
    expect(result.providerRun).toMatchObject({ fallbackUsed: true, actualModel: "kimi-k2.6",
      responseUsage: { status: "reported", inputTokens: 120, outputTokens: 8 } });
  });

  it("uses the plugin's tool executor and persists a normal text conversation through the new entry adapter", async () => {
    const message = "请创建任务 纯虚构接入测试。";
    responses.push(reply("", [tool("create_task", { title: "纯虚构接入测试" })]), reply("已创建纯虚构接入测试。"));
    const plugin = Object.assign(Object.create(Plugin.prototype), { app: store.app, store, settings: store.settings,
      ai: host.aiForRole("main"), lifecycleGeneration: 1, unloaded: false, refreshViews: async () => {} });
    const streamed = vi.fn();
    const result = await runAgentTurn.call(plugin, message, [], streamed, { source: "text" });
    expect(result.receipts).toHaveLength(1);
    expect(streamed).toHaveBeenLastCalledWith(result.reply);
    const conversations = store.path(store.settings.folders.aiReports, "Conversations");
    const file = store.app.vault.getMarkdownFiles().find(item => item.path.startsWith(`${conversations}/`));
    expect(await store.readPath(file!.path)).toContain(message);
    expect((await store.readTaskDb({ readOnly: true })).tasks.map(task => task.title)).toEqual(["纯虚构接入测试"]);
  });
});

it("uses the four local commands without a model and gives undo receipts for local writes", async () => {
  store.settings.ai.provider = "off";
  const habit = await store.createHabit({ name: "纯虚构读书", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
  const plugin = Object.assign(Object.create(Plugin.prototype), { app: store.app, store, settings: store.settings,
    ai: host.aiForRole("main"), lifecycleGeneration: 1, unloaded: false, refreshViews: async () => {} });
  const submit = (message: string) => plugin.submitAgentMessage(message, [], { selfTest: true });
  expect((await submit("今天还有什么？")).reply).toContain("没有剩余");
  const created = await submit("建任务：纯虚构整理资料");
  expect(created.receipts).toHaveLength(1);
  expect((await submit("/today")).reply).toContain("纯虚构整理资料");
  const completed = await submit("完成任务：纯虚构整理资料");
  expect(completed.receipts).toHaveLength(1);
  expect((await store.readTaskDb({ readOnly: true })).tasks[0].status).toBe("completed");
  const checked = await submit("打卡 纯虚构读书");
  expect(checked.receipts).toHaveLength(1);
  expect((await store.readHabitDb()).checkins).toEqual([expect.objectContaining({ habitId: habit.id, status: "done" })]);
  const before = await readFile(join(root, store.habitDbPath()), "utf8");
  expect((await submit("删除习惯 纯虚构读书")).actions).toEqual([]);
  expect(await readFile(join(root, store.habitDbPath()), "utf8")).toBe(before);
  expect(requests).toEqual([]);
});

it("keeps a successful query for a requested undo across model rounds", async () => {
  const task = await runtime.executeAiToolCall(tool("create_task", { title: "纯虚构需撤销" }, "undo-original"), "kimi");
  expect(task.success).toBe(true);
  const plugin = Object.assign(Object.create(Plugin.prototype), { app: store.app, store, settings: store.settings,
    ai: host.aiForRole("main"), lifecycleGeneration: 1, unloaded: false, refreshViews: async () => {} });
  responses.push(
    reply("", [tool("query_vault", { domain: "task", operation: "list" }, "prior-query")]),
    reply("", [tool("undo_latest_operation", { taskTitle: "纯虚构需撤销", requirePriorQuery: true }, "undo-after-read")]),
    reply("已撤销纯虚构需撤销。")
  );
  const result = await plugin.submitAgentMessage("请先查询任务，然后撤销刚创建的纯虚构需撤销。", [], { selfTest: true });
  expect(result.reply).toContain("已撤销");
  expect((await store.readTaskDb({ readOnly: true })).tasks).toEqual([]);
  expect(requests).toHaveLength(3);
});

it("keeps a requested query prerequisite and runs a subsequent bare undo locally", async () => {
  const original = await runtime.executeAiToolCall(tool("create_task", { title: "虚构整理盒子" }, "undo-retry-original"), "kimi");
  expect(original.success).toBe(true);
  const plugin = Object.assign(Object.create(Plugin.prototype), { app: store.app, store, settings: store.settings,
    ai: host.aiForRole("main"), lifecycleGeneration: 1, unloaded: false, refreshViews: async () => {} });
  responses.push(
    reply("", [tool("undo_latest_operation", { requirePriorQuery: true }, "unsupported-query-requirement")]),
    reply("", [tool("choose_voice_job_control", { intent: "ordinary", target: "unknown" })]),
    reply("这次没有执行撤销。")
  );
  const refused = await plugin.submitAgentMessage("请先查记录再撤销刚才那个。", [], { selfTest: true });
  expect(refused.reply).toContain("没有执行");
  expect((await store.readTaskDb({ readOnly: true })).tasks).toHaveLength(1);
  const callsBeforeUndo = requests.length;
  const corrected = await plugin.submitAgentMessage("撤销刚才那个。", [], { selfTest: true });
  expect(requests).toHaveLength(callsBeforeUndo);
  expect(corrected.reply).toContain("已撤销");
  expect(corrected.reply).toContain("虚构整理盒子");
  expect((await store.readTaskDb({ readOnly: true })).tasks).toEqual([]);
});

it("keeps the target of an undo when the requested prior query has not run", async () => {
  const task = await runtime.executeAiToolCall(tool("create_task", { title: "虚构目标任务" }, "targeted-undo-original"), "kimi");
  expect(task.success).toBe(true);
  const plugin = Object.assign(Object.create(Plugin.prototype), { app: store.app, store, settings: store.settings,
    ai: host.aiForRole("main"), lifecycleGeneration: 1, unloaded: false, refreshViews: async () => {} });
  responses.push(
    reply("", [tool("undo_latest_operation", { taskTitle: "虚构目标任务", requirePriorQuery: true }, "targeted-undo")]),
    reply("这次没有执行撤销。")
  );
  const result = await plugin.submitAgentMessage("先查记录再撤销虚构目标任务。", [], { selfTest: true });
  expect(result.reply).toContain("没有执行");
  expect(requests).toHaveLength(2);
  expect((await store.readTaskDb({ readOnly: true })).tasks).toHaveLength(1);
});

describe("voice background AgentLoop", () => {
  it.each(["delete_task", "delete_habit"] as const)("offers %s in the first voice turn and prepares confirmation before writing", async name => {
    const task = await store.createTask({ title: "虚构样品清单" });
    const habit = await store.createHabit({ name: "虚构阅读", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    const args = name === "delete_task" ? { taskIdOrTitle: task.title } : { name: habit.name };
    const expectedTarget = name === "delete_task" ? { taskIds: [task.id] } : { habitIds: [habit.id] };
    responses.push(reply("", [tool(name, args)]), reply("请先确认。"));

    const result = await new AgentLoop(host).run(input({ source: "voice", message: `删除${name === "delete_task" ? task.title : habit.name}` }));

    expect(catalogs[0]).toContain(name);
    expect(result.toolCalls).toEqual([{ name, ok: true }]);
    expect(result.confirmations).toMatchObject([{ type: name, ...expectedTarget }]);
    expect((await store.readTaskDb({ readOnly: true })).tasks.some(row => row.id === task.id)).toBe(true);
    expect((await store.readHabitDb()).habits.some(row => row.id === habit.id)).toBe(true);
  });

  it("keeps ordinary voice tools compact and gives the model a bounded read excerpt", async () => {
    const execute = vi.spyOn(host, "executeTools").mockImplementation(async (calls, _message, _signal, onResult) => {
      const result = { callId: calls[0].id!, output: "虚构原文。".repeat(700), success: true, actions: [] };
      onResult(calls[0], result);
      return [result];
    });
    responses.push(reply("", [{ id: "voice-read", name: "query_vault",
      arguments: { domain: "journal", operation: "get", maxChars: 15000, limit: 10 } }]), reply("读到了虚构日记。"));
    const result = await new AgentLoop(host).run(input({ source: "voice", message: "看看虚构日记" }));
    expect(result.text).toBe("读到了虚构日记。");
    expect(catalogs[0]).toContain("record_trade");
    expect(catalogs[0]).toContain("learning_progress");
    expect(catalogs[0]).not.toContain("advance_idea");
    expect(execute.mock.calls[0][0][0].arguments).toMatchObject({ maxChars: 900, limit: 3 });
    expect(requests[1].at(-1)?.content).toContain("只显示已查结果的前部");
    expect(Buffer.byteLength(requests[1].at(-1)!.content)).toBeLessThan(1_650);
  });

  it("acknowledges a long job and keeps two fast questions responsive", async () => {
    const { VoiceJobManager } = await import("../src/voice/jobs");
    let finish!: (result: string) => void;
    const manager = new VoiceJobManager(() => new Promise(resolve => { finish = resolve; }), vi.fn());
    const loop = new AgentLoop(host);
    responses.push(reply("", [{ id: "start-job", name: "start_background_job",
      arguments: { title: "虚构交易月报", question: "复盘虚构交易", scope: "十月" } }]));
    const voice = (message: string) => loop.run(input({ source: "voice", message, voiceJobs: manager }));
    expect((await voice("复盘十月的虚构交易")).text).toBe("好，我去整理一下，好了告诉你。");
    for (const [question, answer] of [["虚构问题一", "短答一。"], ["虚构问题二", "短答二。"]]) {
      responses.push(reply("", [{ id: "route", name: "choose_voice_job_control", arguments: { intent: "ordinary" } }]), reply(answer));
      expect((await voice(question)).text).toBe(answer);
      expect(manager.list()[0].status).toBe("running");
    }
    expect(roles).toEqual(["fast", "fast", "fast", "fast", "fast"]);
    finish("虚构十月报告。");
    await vi.waitFor(() => expect(manager.list()[0].status).toBe("done"));
    expect(manager.takeAnnouncement()?.result).toBe("虚构十月报告。");
  });

  it("preserves the user's relative month when the background dispatcher proposes the wrong year", async () => {
    const { backgroundVoiceQuestion, VoiceJobManager } = await import("../src/voice/jobs");
    const original = "总结上个月的虚构任务完成情况。";
    const rewritten = "总结 2025 年 10 月的任务完成情况。";
    const runBackground = vi.fn(async request => backgroundVoiceQuestion(request));
    const manager = new VoiceJobManager(runBackground, vi.fn());
    responses.push(reply("", [tool("start_background_job", { title: "上月任务完成情况", question: rewritten, scope: "2025-10" })]));

    await new AgentLoop(host).run(input({ source: "voice", message: original, voiceJobs: manager }));

    const background = await runBackground.mock.results[0].value;
    expect(background.split("\n")[0]).toBe(original);
    expect(background).toContain("日期和范围以用户原话为准");
    expect(background).toContain(rewritten);
  });

  it("keeps a new background request separate from a fully played earlier result", async () => {
    const { VoiceJobManager } = await import("../src/voice/jobs");
    const manager = new VoiceJobManager(({ title }, signal) => title === "前一份虚构分析"
      ? Promise.resolve("已经播完的虚构分析。")
      : new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })), vi.fn());
    manager.start({ title: "前一份虚构分析", question: "虚构资料", scope: "" });
    await vi.waitFor(() => expect(manager.list()[0].status).toBe("done"));
    manager.settleAnnouncement(manager.takeAnnouncement()!.id, true);
    responses.push(reply("", [tool("replay_job", { target: "latest" })]), reply("", [tool("start_background_job", {
      title: "新的虚构分析", question: "请在后台整理新的虚构资料", scope: "" })]));
    const result = await new AgentLoop(host).run(input({ source: "voice", message: "请在后台整理新的虚构资料", voiceJobs: manager }));
    expect(catalogs[0]).not.toContain("replay_job");
    expect(result.text).toBe("好，我去整理一下，好了告诉你。");
    expect(manager.list().map(job => job.status)).toEqual(["done", "running"]);
    expect(manager.takeAnnouncement()).toBeUndefined();
    manager.stop();
  });

  it.each(["cancel_job", "undo_latest_operation"])("undoes the latest saved task with an unfinished replay and the model intent %s", async intent => {
    const { VoiceJobManager } = await import("../src/voice/jobs");
    const manager = new VoiceJobManager(async () => "可续播的虚构分析。", vi.fn());
    manager.start({ title: "虚构分析", question: "虚构资料", scope: "" });
    await vi.waitFor(() => expect(manager.list()[0].status).toBe("done"));
    manager.settleAnnouncement(manager.takeAnnouncement()!.id, false);
    await runtime.executeAiToolCall(tool("create_task", { title: "纯虚构待撤销标签" }, "voice-undo-after-replay"), "kimi");
    responses.push(reply("", [tool("choose_voice_job_control", { intent, target: intent === "cancel_job" ? "ambiguous" : "latest" })]));
    if (intent === "cancel_job") responses.push(reply("", [tool("undo_latest_operation", {})]));
    responses.push(voiceUndoApproval());

    const result = await new AgentLoop(host).run(input({ source: "voice", message: "撤销。", voiceJobs: manager }));

    expect(result.voiceSpeech).toContain("已撤销创建任务「纯虚构待撤销标签」");
    expect(result.toolCalls).toContainEqual({ name: "undo_latest_operation", ok: true });
    expect((await store.readTaskDb()).tasks).toEqual([]);
    expect(manager.list()[0]).toMatchObject({ status: "done", announced: false });
  });

  it("cancels ten background jobs through the foreground tool and clarifies multiple matches", async () => {
    const { VoiceJobManager } = await import("../src/voice/jobs");
    const signals: AbortSignal[] = [];
    const manager = new VoiceJobManager((_input, signal) => {
      signals.push(signal);
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }, vi.fn());
    const loop = new AgentLoop(host);
    const cancel = (target: string) => {
      responses.push(reply("", [{ id: "cancel-job", name: "choose_voice_job_control", arguments: { intent: "cancel_job", target } }]));
      return loop.run(input({ source: "voice", message: "上面那个不用了", voiceJobs: manager }));
    };
    manager.start({ title: "虚构交易", question: "虚构", scope: "" });
    manager.start({ title: "虚构学习", question: "虚构", scope: "" });
    manager.start({ title: "虚构阅读", question: "虚构", scope: "" });
    expect(manager.start({ title: "超限", question: "虚构", scope: "" })).toContain("三个");
    expect((await cancel("ambiguous")).text).toContain("虚构交易、虚构学习、虚构阅读");
    expect(signals.every(signal => !signal.aborted)).toBe(true);
    expect((await cancel(manager.list()[1].id)).text).toContain("已经取消");
    expect(signals.map(signal => signal.aborted)).toEqual([false, true, false]);
    expect((await cancel("latest")).text).toContain("虚构阅读");
    expect((await cancel(manager.list()[0].id)).text).toContain("虚构交易");
    for (let index = 0; index < 7; index++) {
      manager.start({ title: `虚构任务${index}`, question: "虚构", scope: "" });
      expect((await cancel("ambiguous")).text).toContain(`已经取消「虚构任务${index}」`);
    }
    expect(signals).toHaveLength(10);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(manager.list().every(job => job.status === "cancelled")).toBe(true);
  });

  it("uses the deep model and blocks an unoffered write from a background job", async () => {
    responses.push(reply("", [{ id: "write", name: "create_task", arguments: { title: "虚构后台越权" } }]),
      reply("仅提供虚构分析。"), reply("这是深度整理后的虚构分析。"));
    const execute = vi.spyOn(host, "executeTools");
    const result = await new AgentLoop(host).run(input({ source: "voice", message: "复盘虚构交易", voiceBackground: true }));
    expect(roles).toEqual(["deep", "deep", "deep"]);
    expect(catalogs[0]).toContain("get_stats");
    expect(catalogs[0]).not.toContain("create_task");
    expect(catalogs[0]).not.toContain("start_background_job");
    expect(execute).not.toHaveBeenCalled();
    expect(result.receipts).toEqual([]);
    expect(result.text).toBe("这是深度整理后的虚构分析。");
    expect(requests[2].map(message => message.role)).toEqual(["system", "user"]);
    expect(requests[2][1].content).toContain("后台任务只允许查询资料");
  });

  it.each([false, true])("keeps the full report while preparing separate speech when the summary fails: %s", async fails => {
    const detail = "# 上月任务\n\n| 周起始日 | 完成数 |\n| --- | --- |\n| 10月12日 | 4 |\n\n后半月完成数增加。建议先补逾期事项。";
    const spoken = "后半月完成得更多。接下来可以先补逾期事项。";
    responses.push(reply("初步答复。"), reply(detail), fails ? new Error("虚构播报模型不可用") : reply(spoken));

    const result = await new AgentLoop(host).run(input({ source: "voice", message: "总结上个月的虚构任务", voiceBackground: true }));

    expect(result.text).toBe(detail);
    expect(result.voiceSpeech).toBe(fails ? "详细内容已经放到面板里了。" : spoken);
    expect(roles).toEqual(["deep", "deep", "fast"]);
    expect(catalogs[2]).toEqual([]);
    expect(requests[2].slice(1)).toEqual([{ role: "user", content: detail }]);
  });

  it.each([
    { name: "same number and unit", spoken: "上周完成三项。", accepted: true },
    { name: "same signed amount", spoken: "上周净收益是负三美元。", accepted: true },
    { name: "same percentage expressed approximately", spoken: "上周完成率是六成左右。", accepted: true },
    { name: "unreported number", spoken: "上周完成四项。", accepted: false },
    { name: "same digits but wrong sign", spoken: "上周净收益是三美元。", accepted: false },
    { name: "same digits but wrong currency", spoken: "上周净收益是负三元人民币。", accepted: false },
    { name: "same digits but wrong period", spoken: "本周完成三项。", accepted: false },
    { name: "amount from a different statement", spoken: "上周完成十项。", accepted: false },
    { name: "transaction count mistaken for amount", spoken: "本周净收益是三美元。", accepted: false },
    { name: "rounded percentage with matching scope", spoken: "本周完成率是约67%。", accepted: true },
    { name: "exact half rounds up", spoken: "本周计划达成率是约68%。", accepted: true },
    { name: "incorrect integer rounding", spoken: "本周完成率是约68%。", accepted: false },
    { name: "invented percentage", spoken: "本周完成率是90%。", accepted: false },
    { name: "rounded percentage still contains a decimal", spoken: "本周完成率是约67.4%。", accepted: false }
  ])("checks numbers in the actual background report speech ($name)", async ({ spoken, accepted }) => {
    const detail = "# 上周回顾\n\n| 项目 | 数量 |\n| --- | --- |\n| 待办计划 | 10 |\n\n上周计划10项。上周完成3项。上周完成率是60%。上周净收益是-3美元。"
      + "本周完成率是67.42%。本周计划达成率是67.5%。本周记录3笔交易。本周净收益是10美元。";
    responses.push(reply("初步答复。"), reply(detail), reply(spoken));

    const result = await new AgentLoop(host).run(input({ source: "voice", message: "总结虚构周报", voiceBackground: true }));

    expect(result.text).toBe(detail);
    expect(hasGroundedSpeechNumbers(detail, spoken)).toBe(accepted);
    expect(result.voiceSpeech).toBe(accepted ? spoken : "上周计划10项。上周完成3项。上周完成率是60%。完整报告还有其他细节。");
    expect(hasGroundedSpeechNumbers(detail, result.voiceSpeech!)).toBe(true);
  });

  for (const [name, facts] of [
    ["交易", ["上周记录4笔交易。", "上周人民币净盈亏是-120元。", "上周美元净盈亏是35美元。"]],
    ["学习", ["上周学习记录75分钟。", "上周完成3项练习。", "上周计划150分钟。"]],
    ["归档", ["这两周覆盖14天。", "这两周返回2篇归档日记。", "这两周12天有日记但未提及归档主题。"]]
  ] as const) it.each(["unavailable", "wrong-number", "markdown"])("keeps actual background " + name + " report facts when speech fails: %s", async mode => {
    const detail = "# 虚构" + name + "报告\n\n" + facts.join("\n");
    responses.push(reply("正在核对。"), reply(detail), mode === "unavailable" ? new Error("虚构口语整理不可用")
      : reply(mode === "wrong-number" ? name === "归档" ? "这两周返回五篇归档日记。" : "上周记录999笔交易。" : "# 请看面板"));
    const result = await new AgentLoop(host).run(input({ source: "voice", voiceBackground: true, message: "总结虚构" + name + "报告" }));
    expect(result.text).toBe(detail);
    for (const fact of facts) expect(result.voiceSpeech).toContain(fact);
    expect(result.voiceSpeech).toBe(facts.join("") + "完整报告还有其他细节。");
    expect(result.voiceSpeech).not.toMatch(/999|面板|#|\|/u);
    expect(hasGroundedSpeechNumbers(detail, result.voiceSpeech!)).toBe(true);
    expect(roles).toEqual(["deep", "deep", "fast"]);
    expect(result.receipts).toEqual([]);
    expect((await store.readTaskDb()).tasks).toEqual([]);
  });

  const taskSpeechReports = [
    { id: "monthly-overdue", detail: "| 周起始日 | 计划数 | 完成数 | 完成率 |\n| --- | ---: | ---: | ---: |\n"
      + "| 2026-10-12 | 10 | 8 | 80% |\n| 2026-10-19 | 10 | 6 | 60% |\n| **整月合计** | 20 | 14 | 70% |\n\n整月另有 **1 项逾期**。",
      facts: ["完成了 14 项任务", "百分之 70", "后段的完成比例有所下降", "1 项任务逾期"],
      spoken: "先处理已经逾期的事，把难的拆小了再做。", fallback: "接下来可以先把逾期的事拆成小步来做。" },
    { id: "weekly-rounding", detail: "# 虚构任务周报\n| 日期 | 计划任务数 | 完成任务数 | 计划完成率 | 逾期 |\n| --- | --- | --- | --- | --- |\n"
      + "| 2026-11-02 | 2 | 1 | 50% | 0 |\n| 2026-11-06 | 1 | 1 | 100% | 0 |\n| 全周汇总 | 3 | 2 | 66.67% | 0 |",
      facts: ["完成了 2 项任务", "大约是百分之 67", "后段的完成比例有所提高"],
      spoken: "先捡起没做完的事，再看看后面怎么排。", fallback: "接下来先看看没做完的事，再调整安排。" },
    { id: "scoped-month", detail: "## 虚构月度任务完成情况\n| 周起始日（周一） | 计划数 | 完成数 | 完成率 |\n|---|---:|---:|---:|\n"
      + "| 2026-10-05 | — | — | — |\n| 2026-10-12 | 7 | 5 | 71.43% |\n| 2026-10-19 | 39 | 26 | 66.67% |\n| 2026-10-26 | 43 | 29 | 67.44% |\n"
      + "| **合计（有数据范围 10/12–10/31）** | **89** | **60** | **67.42%** |\n\n全月另有 1 项逾期。",
      facts: ["按已有记录，完成了 60 项任务", "大约是百分之 67"],
      spoken: "接下来先把没覆盖到的记录核对一下。", fallback: "接下来先核对这份报告没有覆盖到的记录。", omitted: "1 项任务逾期" },
    { id: "unplanned", detail: "### 虚构任务统计\n| 周期 | 计划 | 已完成 | 完成率 |\n| --- | --- | --- | --- |\n| 本期合计 | 0 | 5 | — |",
      facts: ["完成了 5 项任务", "没有预先排计划"],
      spoken: "可以沿用这个节奏，看看什么做法更管用。", fallback: "接下来可以沿用这个节奏，再看看哪些做法最管用。" }
  ];
  it.each(taskSpeechReports.flatMap(report => ["natural", "invented", "unavailable"].map(mode => ({ ...report, mode }))))
    ("keeps the panel report unchanged and speaks checked key points ($id, $mode)", async report => {
      const suggestion = report.mode === "natural" ? reply(report.spoken)
        : report.mode === "invented" ? reply("把剩下 999 项排进计划。") : new Error("虚构口语模型不可用");
      responses.push(reply("初步答复。"), reply(report.detail), suggestion);

      const result = await new AgentLoop(host).run(input({ source: "voice", message: "总结虚构任务完成情况", voiceBackground: true }));

      expect(result.text).toBe(report.detail);
      for (const fact of report.facts) expect(result.voiceSpeech).toContain(fact);
      expect(result.voiceSpeech).toContain(report.mode === "natural" ? report.spoken : report.fallback);
      expect(result.voiceSpeech).not.toMatch(/\||999|看面板|2026-/u);
      if (report.omitted) expect(result.voiceSpeech).not.toContain(report.omitted);
      expect(voiceJobSpeech(result.text, result.voiceSpeech)).toBe(result.voiceSpeech);
      expect(roles).toEqual(["deep", "deep", "fast"]);
      expect(requests[2][1].content).toBe(report.fallback);
    });

  it("keeps all concurrent conversation events on a fresh day", async () => {
    const date = "2025-05-09";
    const events = ["虚构任务开始", "短问答一", "短问答二", "虚构任务结束"];
    await Promise.all(events.map(text => store.appendAgentConversation(text, "虚构答复", date)));
    const file = await store.app.vault.adapter.read(store.path(store.settings.folders.aiReports, "Conversations", `${date}.md`));
    expect(events.map(text => file.indexOf(text))).toEqual([...events.map(text => file.indexOf(text))].sort((a, b) => a - b));
    for (const event of events) expect(file).toContain(event);
  });
});

it("answers a standalone text greeting without reading records or calling the model", async () => {
  const readDashboard = vi.spyOn(store, "getTaskDashboard");
  const result = await new AgentLoop(host).run(input({ message: "下午好！" }));
  expect(result.text).toBe("下午好！");
  expect(result.toolCalls).toEqual([]);
  expect(result.usage.model).toBe("local");
  expect(readDashboard).not.toHaveBeenCalled();
  expect(requests).toEqual([]);
});

it("still handles a task question that begins with a greeting", async () => {
  responses.push(reply("我会先核对今天的任务。"));
  const result = await new AgentLoop(host).run(input({ message: "你好，今天先做什么？" }));
  expect(result.text).toBe("我会先核对今天的任务。");
  expect(requests).toHaveLength(1);
});

it("recalls an explicitly saved recurring appointment without relying on a newly generated answer", async () => {
  const loop = new AgentLoop(host);
  responses.push(reply("", [tool("append_memory_note", { content: "我周五晚上固定整理虚构读书卡。", fileName: "个人画像.md", explicit: true })]));
  const remembered = await loop.run(input({ message: "记住我周五晚上固定整理虚构读书卡。" }));
  expect(remembered.toolCalls).toContainEqual({ name: "append_memory_note", ok: true });
  const beforeRecall = requests.length;
  expect((await loop.run(input({ message: "我星期五晚上有哪些安排？" }))).text).toBe("已确认的固定安排：我周五晚上固定整理虚构读书卡。");
  expect(requests).toHaveLength(beforeRecall);
  responses.push(reply("我需要查当日的虚构待办。"));
  expect((await loop.run(input({ message: "我下周五晚上有哪些安排？" }))).text).toBe("我需要查当日的虚构待办。");
  expect(requests).toHaveLength(beforeRecall + 1);
});

it("records a literal running distance only for the configured manual habit with its exact name", async () => {
  const date = formatDate(now);
  const manual = await store.createHabit({ name: "跑步", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1, startDate: date });
  const other = await store.createHabit({ name: "虚构跑步训练", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
  const loop = new AgentLoop(host);
  const result = await loop.run(input({ message: "我刚跑完 5 公里。" }));
  expect(result.receipts).toHaveLength(1);
  expect((await store.readHabitDb()).checkins).toMatchObject([{ habitId: manual.id, date, value: 5, count: 1 }]);
  expect(requests).toHaveLength(0);
  await store.deleteHabit(manual.id);
  responses.push(reply("请明确要打卡的虚构习惯。"));
  expect((await loop.run(input({ message: "我刚跑完 5 公里。" }))).text).toContain("明确");
  expect(requests).toHaveLength(1);
  expect((await store.readHabitDb()).checkins.some(item => item.habitId === other.id)).toBe(false);
});

it("does not answer with only an older recurring fact when a second confirmed fact uses introductory wording", async () => {
  const loop = new AgentLoop(host);
  for (const content of ["我每周三晚上整理虚构读书卡。", "用户明确要求记住：周三晚上固定开会。"] ) {
    responses.push(reply("", [tool("append_memory_note", { content, fileName: "个人画像.md", explicit: true })]));
    await loop.run(input({ message: "记住：" + content }));
  }
  const before = requests.length;
  responses.push(reply("周三晚上有固定会议，以及整理虚构读书卡。"));
  const result = await loop.run(input({ message: "我周三晚上有什么？" }));
  expect(result.text).toContain("会议"); expect(requests).toHaveLength(before + 1);
  expect(JSON.stringify(requests.at(-1))).toContain("周三晚上固定开会");
});

it("uses an explicit timed reminder locally and preserves its named person in the voice receipt", async () => {
  const loop = new AgentLoop(host);
  const title = "虚构人名叶宁给纸盒贴标签";
  const result = await loop.run(input({ source: "voice", message: `明天下午3:15提醒${title}。` }));
  expect(result.receipts).toHaveLength(1);
  expect(result.voiceSpeech).toContain(title);
  expect(result.voiceSpeech).toContain("15:15");
  expect((await store.readTaskDb()).tasks).toMatchObject([{ title, date: addDays(formatDate(now), 1), time: "15:15" }]);
  expect(requests).toHaveLength(0);
  responses.push(reply("这是复合的虚构提醒。"));
  expect((await loop.run(input({ source: "voice", message: "明天下午三点提醒叶宁下午四点检查纸盒。" }))).text)
    .toBe("这是复合的虚构提醒。");
});

it("locally creates an explicitly requested single timed task and keeps conditional requests on the normal path", async () => {
  const loop = new AgentLoop(host);
  const saved = await loop.run(input({ message: "帮我建明天下午三点整理虚构图册的任务。" }));
  expect(saved.toolCalls).toEqual([{ name: "create_task", ok: true }]);
  expect(saved.receipts).toHaveLength(1);
  expect((await store.readTaskDb()).tasks).toMatchObject([{ title: "整理虚构图册", date: "2026-11-13", time: "15:00" }]);
  expect(requests).toHaveLength(0);
  responses.push(reply("请核对前提。"));
  expect((await loop.run(input({ message: "帮我建明天下午三点见面，然后去取件的任务。" }))).text).toBe("请核对前提。");
  expect(requests).toHaveLength(1);
  expect((await store.readTaskDb()).tasks).toHaveLength(1);
});

it.each([
  ["下周末下午三点提醒虚构检查纸盒。", "2026-11-21", "15:00"],
  ["帮我创建任务 虚构检查纸盒，安排在月底10:30。", "2026-11-30", "10:30"],
  ["帮我建12月5日上午十点虚构检查纸盒的待办。", "2026-12-05", "10:00"]
])("keeps supported date tokens on the explicit local route: %s", async (message, date, time) => {
  const result = await new AgentLoop(host).run(input({ message }));
  expect(requests).toHaveLength(0);
  expect(result.receipts).toHaveLength(1);
  expect((await store.readTaskDb()).tasks).toMatchObject([{ title: "虚构检查纸盒", date, time }]);
});

it("blocks a model-proposed undo for a named voice deletion", async () => {
  const original = await runtime.executeAiToolCall(tool("upsert_idea", { title: "虚构蓝色图册想法", description: "核对虚构目录" }), "kimi");
  expect(original.success).toBe(true);
  responses.push(reply("", [tool("undo_latest_operation", {})]), reply("请核对要删除的想法。"));
  const loop = new AgentLoop(host);
  const result = await loop.run(input({ source: "voice", message: "删除虚构蓝色图册想法。" }));
  expect(result.toolCalls).toContainEqual({ name: "undo_latest_operation", ok: false });
  expect((await new OperationLedger(store).readSettledOperations([original.callId])).verified.has(original.callId)).toBe(true);
});

it.each([
  { source: "text", title: "虚构纸模目录", referencedTitle: "虚构纸模目录" },
  { source: "voice", title: "虚构纸模目录", referencedTitle: "虚构纸模目录" },
  { source: "text", title: "虚构纸模目录，冬版", referencedTitle: "「虚构纸模目录，冬版」" }
] as const)("reads the status, idle days and next step of an exact idea ($source, $referencedTitle)", async ({ source, title, referencedTitle }) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  let result: Awaited<ReturnType<InstanceType<typeof AgentLoop>["run"]>>;
  try {
    vi.setSystemTime(new Date(2026, 9, 28, 12));
    const created = await runtime.executeAiToolCall(tool("upsert_idea", {
      title, description: "用彩纸做目录", nextAction: "核对同类纸样"
    }, "fictional-idea-probe"), "kimi");
    expect(created.success).toBe(true);
    vi.setSystemTime(now);
    const date = formatDate(now);
    for (let index = 0; index < 42; index += 1) {
      const similar = `${title}的虚构分支 ${index}`;
      const fields = { lifeops: "idea", status: "seed", created: date, lastProgress: date, nextReview: addDays(date, 14),
        nextAction: "检查另一张虚构纸样", sources: [] };
      await store.writeFile(store.path(store.settings.folders.ideas, similar + ".md"),
        `---\n${JSON.stringify(fields)}\n---\n\n# ${similar}\n\n虚构正文。\n`);
    }
    responses.push(reply("", [tool("list_ideas", { query: title, draftAdvance: true })]), reply("先给你安排几件事。"));
    result = await new AgentLoop(host).run(input({ source, message: `${referencedTitle}现在什么情况？多久没进展了，记录的下一步是什么？` }));
  } finally { vi.useRealTimers(); }
  expect(result.text).toContain("15 天");
  expect(result.text).toContain("核对同类纸样");
  expect(result.toolCalls).toEqual([{ name: "list_ideas", ok: true }]);
  expect(result.confirmations).toEqual([]);
  expect(result.receipts).toEqual([]);
  expect(requests).toEqual([]);
  expect((await store.readTaskDb()).tasks).toEqual([]);
});

it("answers standalone greetings and device date questions by voice without checking background jobs or loading personal records", async () => {
  const { VoiceJobManager } = await import("../src/voice/jobs");
  const jobs = new VoiceJobManager((_task, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), vi.fn());
  jobs.start({ title: "虚构后台计划", question: "三条虚构计划", scope: "" });
  const readDashboard = vi.spyOn(store, "getTaskDashboard");
  const onVoiceText = vi.fn();
  const loop = new AgentLoop(host);
  const source = "voice" as const;
  try {
    expect(await loop.run(input({ source, message: "你好，简短回答一句。", voiceJobs: jobs, onVoiceText })))
      .toMatchObject({ text: "你好！", usage: { model: "local" } });
    expect(await loop.run(input({ source, message: "今天是几号？只说日期。", voiceJobs: jobs, onVoiceText,
      now: new Date(2027, 0, 1, 0, 2) }))).toMatchObject({ text: "2027年1月1日。", usage: { model: "local" } });
    expect(onVoiceText.mock.calls).toEqual([["你好！"], ["2027年1月1日。"]]);
    expect(jobs.list()[0].status).toBe("running");
    expect(readDashboard).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  } finally { jobs.stop(); }
});

it("answers the device date with the text model disabled and preserves multi-part questions", async () => {
  host.settings.ai.provider = "off";
  const loop = new AgentLoop(host);
  expect((await loop.run(input({ message: "请问，今天几号？", now: new Date(2026, 11, 31, 23, 59) }))).text).toBe("2026年12月31日。");
  expect(requests).toEqual([]);
  host.settings.ai.provider = "custom";
  responses.push(reply("先核对日期和虚构任务。"));
  expect((await loop.run(input({ message: "今天是几号？还有哪些虚构任务？", source: "voice" }))).text).toBe("先核对日期和虚构任务。");
  expect(requests).toHaveLength(1);
});

describe("phone inbox", () => {
  const phoneDate = "2026-01-09";

  it("keeps an unstamped phone date fixed when processing crosses midnight", async () => {
    const { PhoneInbox } = await import("../src/features/phoneInbox/service");
    const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
    const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
    vi.useFakeTimers({ toFake: ["Date"] });
    const source = "整理虚构蓝色纸样。\n整理虚构黄色纸样。\n";
    const seen: string[] = [];
    const inbox = new PhoneInbox({
      store: () => store, enabled: () => true,
      submit: async (_message, turn) => {
        seen.push(turn.date);
        vi.setSystemTime(new Date(2026, 0, 10, 0, 1));
        await turn.assertLineCurrent();
        return { reply: "虚构检查回执。", actions: [] };
      },
      confirm: async () => {}, undo: async () => true, notify: () => {}
    }, new LifeOpsEventBus());
    try {
      vi.setSystemTime(new Date(2026, 0, 9, 23, 59));
      await store.ensureFile(PHONE_INBOX_PATH, source);
      await inbox.scan();
      expect(seen).toEqual([phoneDate, phoneDate]);
      expect(await store.readPath(PHONE_INBOX_PATH)).toBe(source);
    } finally { inbox.stop(); vi.useRealTimers(); }
  });

  it("counts a delayed phone task completion on its captured day and supports undo", async () => {
    const { PhoneInbox } = await import("../src/features/phoneInbox/service");
    const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
    const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
    const { activityNotePath } = await import("../src/activityRecords");
    const { readStats } = await import("../src/features/stats/tools");
    const { summarizeTaskFacts } = await import("../src/contextInjection");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 8, 10));
    try {
      const task = await store.createTask({ title: "虚构检查蓝色样盒", date: phoneDate });
      const other = await store.createTask({ title: "虚构检查黄色样盒", date: "2026-01-10" });
      const syncedAt = new Date(2026, 0, 12, 18);
      vi.setSystemTime(syncedAt);
      const source = `[${phoneDate} 16:20] 蓝色样盒检查完了\n[2026-01-11 18:20] 昨天检查完黄色样盒\n`;
      await store.ensureFile(PHONE_INBOX_PATH, source);
      responses.push(
        reply("", [tool("complete_task", { taskIdOrTitle: task.id })]),
        reply("", [tool("complete_task", { taskIdOrTitle: other.id, date: "昨天" })])
      );
      const inbox = new PhoneInbox({
        store: () => store, enabled: () => true,
        submit: async (message, phoneInbox, signal) => {
          const result = await new AgentLoop(host).run(input({ message, phoneInbox, signal, now: syncedAt, source: "system" }));
          return { reply: result.text, receipts: result.receipts, actions: result.confirmations, toolCalls: result.toolCalls };
        },
        confirm: async () => undefined, undo: id => runtime.undoOperation(id), notify: () => undefined
      }, new LifeOpsEventBus());
      try {
        await inbox.scan();
        const [second, first] = await inbox.list();
        expect(first).toMatchObject({ status: "saved", message: expect.stringContaining(phoneDate) });
        expect(second).toMatchObject({ status: "saved", message: expect.stringContaining("2026-01-10") });
        const completed = await store.getTask(task.id);
        expect(completed).toMatchObject({ status: "completed", completedAt: phoneDate, updatedAt: syncedAt.toISOString(),
          completionLog: [{ completedAt: phoneDate, note: "" }] });
        expect((await store.getTaskDashboard(phoneDate)).completedToday.map(row => row.id)).toEqual([task.id]);
        expect((await store.getTaskDashboard("2026-01-12")).completedToday).toEqual([]);
        const history = await readStats(store, { domain: "tasks", range: { from: phoneDate, to: phoneDate } }, syncedAt);
        expect(JSON.parse(history.output)).toMatchObject({ completedCount: 1, averageCompletionMin: null });
        expect(summarizeTaskFacts([completed], syncedAt, []).completionEvidence).toMatchObject([{ localDate: phoneDate }]);
        expect(await store.readPath(activityNotePath(store, "tasks", phoneDate))).toContain(task.title);
        await inbox.resolve(first.id, "undo");
        expect((await store.getTask(task.id)).status).toBe("active");
        expect((await store.getTask(other.id)).status).toBe("completed");
        expect((await store.getTaskDashboard(phoneDate)).completedToday).toEqual([]);
        expect(await store.readPath(PHONE_INBOX_PATH)).toBe(source);
      } finally { inbox.stop(); }
    } finally { vi.useRealTimers(); }
  });

  it("runs five offline-captured lines once, preserves raw input, and supports approval and targeted undo", async () => {
    const { PhoneInbox, summarizePhoneInbox } = await import("../src/features/phoneInbox/service");
    const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
    const { listIdeas } = await import("../src/features/ideas/notes");
    const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
    const staleTask = await runtime.executeAiToolCall(tool("create_task", { title: "撤掉旧样品" }, "inbox-stale"), "kimi");
    expect(staleTask.success).toBe(true);
    await store.createHabit({ name: "跑步", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1, target: { kind: "number", perDay: 5, unit: "公里" },
      startDate: phoneDate, penaltyThreshold: 3, color: "#27ae60" });
    const notes = [
      "明天下午三点带样品", "今天跑了 5 公里", "想法：做一张园艺地图",
      "今天很平静，想记进日记  ", "请删除撤掉旧样品这个任务"
    ];
    const original = "# 手机随手记\n\n" + notes.map(line => `[${phoneDate} 16:20] ${line}`).join("\n") + "\n";
    await store.ensureFile(PHONE_INBOX_PATH, original);
    const notifications: string[] = [];
    const events = new LifeOpsEventBus();
    const options = {
      store: () => store, enabled: () => true,
      submit: async (text: string, phoneInbox: NonNullable<AgentTurnInput["phoneInbox"]>, signal: AbortSignal) => {
        const result = await new AgentLoop(host).run(input({ message: text, source: "system", phoneInbox, signal }));
        return { reply: result.text, receipts: result.receipts, actions: result.confirmations, toolCalls: result.toolCalls };
      },
      confirm: async (action: Parameters<typeof runConfirmedToolAction>[0], turn: NonNullable<AgentTurnInput["phoneInbox"]>) => {
        await runConfirmedToolAction(action, { store, refreshViews: async () => {}, assertCurrent: turn.assertCurrent }, turn.assertLineCurrent);
      },
      undo: (id: string) => runtime.undoOperation(id),
      notify: (message: string) => { notifications.push(message); }
    };
    responses.push(
      reply("", [tool("create_task", { title: "带样品", date: "明天", time: "15:00" })]),
      reply("", [tool("complete_habit", { name: "跑步", value: 5, unit: "公里" })]),
      reply("", [tool("upsert_idea", { title: "园艺地图", description: "做一张园艺地图" })]),
      reply("", [tool("append_journal_entry", { content: "今天感觉平静。", period: "晚" })]),
      reply("", [tool("delete_task", { taskIdOrTitle: "撤掉旧样品" })])
    );
    const inbox = new PhoneInbox(options, events);
    try {
      await Promise.all([inbox.scan(), inbox.scan()]);
      const rows = await inbox.list();
      expect(rows.map(row => row.status)).toEqual(["confirm", "saved", "saved", "saved", "saved"]);
      expect(rows[3].message).toContain(phoneDate);
      expect(notifications).toEqual([expect.stringContaining("手机随手记已处理 5 条")]);
      expect(requests).toHaveLength(5);
      expect(catalogs.every(tools => !tools.includes("query_vault") && !tools.includes("undo_latest_operation"))).toBe(true);
      expect(store.isManagedSourcePath(PHONE_INBOX_PATH)).toBe(false);
      expect(requests[3].at(-1)?.content).toBe(notes[3]);
      expect(await store.readPath(store.dailyNotePath(phoneDate, "晚"))).toContain(notes[3]);
      expect((await store.readHabitDb()).checkins).toContainEqual(expect.objectContaining({ date: phoneDate, value: 5 }));
      expect(await listIdeas(store)).toEqual([expect.objectContaining({ title: "园艺地图", description: "做一张园艺地图" })]);
      expect((await store.readTaskDb()).tasks).toContainEqual(expect.objectContaining({ title: "带样品", date: "2026-01-10", time: "15:00" }));
      expect((await store.readTaskDb()).tasks.map(task => task.title)).toContain("撤掉旧样品");
      inbox.stop();
      const reopened = new PhoneInbox(options, events);
      try {
        await reopened.scan();
        expect(requests).toHaveLength(5);
        await reopened.resolve(rows[0].id, "confirm");
        expect((await store.readTaskDb()).tasks.map(task => task.title)).not.toContain("撤掉旧样品");
        await reopened.resolve(rows[0].id, "undo");
        expect(rows[4].operationId).toBeDefined();
        const beforeUndo = await reopened.snapshot();
        const firstLineId = rows[4].id;
        await beforeUndo.resolve!(firstLineId, "undo");
        const afterUndo = await reopened.list();
        expect(afterUndo.find(row => row.id === firstLineId)?.undone).toBe(true);
        expect(afterUndo.filter(row => row.id !== firstLineId)).toEqual(beforeUndo.receipts.filter(row => row.id !== firstLineId));
        expect(summarizePhoneInbox(afterUndo)).toContain("已撤销 2 条");
        expect((await store.readTaskDb()).tasks.map(task => task.title)).toEqual(["撤掉旧样品"]);
        expect(await store.readPath(PHONE_INBOX_PATH)).toBe(original);
      } finally { reopened.stop(); }
    } finally { inbox.stop(); }
  });

  it("blocks changes to permissions, rejects out-of-scope tool requests, and declines multiple writes on one line", async () => {
    const turn = { date: phoneDate, assertCurrent: () => {}, assertLineCurrent: vi.fn(async () => {}) };
    const request = input({ message: "纯虚构手机记录", phoneInbox: turn, source: "system" });
    responses.push(reply("", [tool("delete_habit", { name: "甲" }), tool("delete_task", { taskIdOrTitle: "乙" }, "second")]));
    expect((await new AgentLoop(host).run(request)).receipts).toEqual([]);
    responses.push(reply("", [tool("undo_latest_operation", {})]));
    await expect(new AgentLoop(host).run(request)).rejects.toThrow("需要在对话中处理");
    responses.push(reply("", [tool("create_task", { title: "纸船" })]));
    turn.assertLineCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("编辑冲突"));
    await expect(new AgentLoop(host).run(request)).rejects.toThrow("编辑冲突");
    expect((await store.readTaskDb()).tasks).toEqual([]);
  });

  it("places an invalid timestamp or empty stamped line in review without sending it", async () => {
    const { PhoneInbox } = await import("../src/features/phoneInbox/service");
    const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
    const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
    const submit = vi.fn(async () => ({ reply: "请核对。", actions: [] }));
    const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit,
      confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
    try {
      const notes = ["[2026-01-09 25:30] 明天取件", "[2026-02-30 12:00] 明天取餐", "[2026-01-09 15:00]",
        "[2026-01-09 9:00] 明天交虚构色卡", "[2026-01-09 09:00 明天交虚构草图", "[2026-1-9] 明天画虚构地图",
        "［２０２６－０１－０９ ０９：００］明天买虚构便签", ""].join("\n");
      const cleanLine = "虚构排队记录仍需文字模型\n";
      const ai = store.settings.ai;
      store.settings.ai = { ...ai, provider: "off" };
      await store.ensureFile(PHONE_INBOX_PATH, notes + cleanLine);
      await inbox.scan();
      expect(submit).not.toHaveBeenCalled();
      expect((await inbox.list()).map(row => [row.status, row.message])).toEqual([
        ...Array.from({ length: 4 }, () => ["review", expect.stringContaining("核对日期和时间")]),
        ["review", "这一行没有记录内容。"],
        ["review", expect.stringContaining("核对日期和时间")],
        ["review", expect.stringContaining("核对日期和时间")]
      ]);
      expect(await store.readPath(PHONE_INBOX_PATH)).toBe(notes + cleanLine);
      store.settings.ai = ai;
      await inbox.scan();
      expect(submit).toHaveBeenCalledExactlyOnceWith(cleanLine.trim(), expect.anything(), expect.any(AbortSignal));
    } finally { inbox.stop(); }
  });
});

it("uses the requested relative dates for habit creation and writes date-correct receipts", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const name = "虚构剪纸";
  const create = await runtime.executeAiToolCall(tool("create_habit", { name, startDate: "本周一" }, "habit-date-create"), "kimi");
  expect(create.success).toBe(true);
  expect(create.output).toContain("2026-11-09 开始");
  const done = await runtime.executeAiToolCall(tool("complete_habit", { name, date: "大前天" }, "habit-date-done"), "kimi");
  const missed = await runtime.executeAiToolCall(tool("miss_habit", { name, date: "本周二" }, "habit-date-missed"), "kimi");
  expect(done.output).toContain("已完成2026-11-09打卡");
  expect(missed.output).toContain("已记录2026-11-10未完成");
  const invalid = await runtime.executeAiToolCall(tool("complete_habit", { name, date: "2月30日" }, "habit-date-invalid"), "kimi");
  expect(invalid.success).toBe(false);
  const records = await store.readHabitDb();
  expect(records.habits[0]).toMatchObject({ name, startDate: "2026-11-09" });
  expect(records.checkins).toMatchObject([{ date: "2026-11-09", status: "done" }, { date: "2026-11-10", status: "missed" }]);
});

it("waits for a complete phone inbox line while mobile sync updates an unfinished draft", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const saved = vi.fn(async (_text: string) => ({ reply: "请核对。", actions: [] }));
  const events = new LifeOpsEventBus();
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit: saved,
    confirm: async () => {}, undo: async () => true, notify: () => {} }, events);
  try {
    expect(await inbox.snapshot()).toMatchObject({ source: "missing", receipts: [], pending: 0, unfinished: 0 });
    const note = await store.ensureFile(PHONE_INBOX_PATH, "# 手机随手记\n明天去");
    await inbox.scan();
    expect(saved).not.toHaveBeenCalled();
    expect(await inbox.snapshot()).toMatchObject({ source: "available", receipts: [], pending: 0, unfinished: 1 });
    await store.app.vault.modify(note, "# 手机随手记\n明天去拿蓝纸\n另一个未完");
    expect(await inbox.snapshot()).toMatchObject({ pending: 1, unfinished: 1 });
    await inbox.scan();
    expect(saved.mock.calls.map(args => args[0])).toEqual(["明天去拿蓝纸"]);
    expect(await inbox.snapshot()).toMatchObject({ pending: 0, unfinished: 1 });
    await inbox.scan(true);
    expect(saved.mock.calls.map(args => args[0])).toEqual(["明天去拿蓝纸", "另一个未完"]);
    expect(await inbox.snapshot()).toMatchObject({ pending: 0, unfinished: 0 });
    await store.app.vault.modify(note, "# 手机随手记\n明天去拿蓝纸\n另一个未完\n");
    await inbox.scan();
    expect(saved).toHaveBeenCalledTimes(2);
    expect((await inbox.list()).map(row => row.line)).toEqual([3, 2]);
    await store.app.vault.modify(note, "# 手机随手记\n\n明天去拿蓝纸\n另一条已经改过\n");
    const [changed, moved] = await inbox.list();
    expect(changed.sourceUnavailable).toBe(true);
    expect(moved).toMatchObject({ line: 3 });
    expect(moved.sourceUnavailable).toBeUndefined();
    expect(saved).toHaveBeenCalledTimes(2);
  } finally { inbox.stop(); }
});

describe("complete batch task scheduling", () => {
  const tasks = () => Array.from({ length: 5 }, (_, i) => ({ title: `虚构纸样流程${i}`, estimateMin: 30 }));
  const batch = (args: Record<string, unknown> = {}) => tool("schedule_task_batch", { date: "今天", tasks: tasks(), ...args });

  it("creates the entire plan in one user turn and returns only verified saved results", async () => {
    responses.push(reply("", [batch()]));
    const result = await new AgentLoop(host).run(input({ message: "五件虚构纸样工作今天必须完成，全天有时间，排好时间后全部创建。" }));
    expect(result.receipts).toHaveLength(5);
    expect(result.confirmations).toEqual([]);
    expect(result.text).toContain("本批实际保存5项新任务");
    expect(requests).toHaveLength(1);
    expect(catalogs[0]).toContain("schedule_task_batch");
    const saved = (await store.readTaskDb()).tasks;
    expect(saved.map(t => t.title).sort()).toEqual(tasks().map(t => t.title).sort());
    expect(saved.every(t => t.date === formatDate(now) && !!t.startTime && !!t.endTime)).toBe(true);
    await runtime.undoOperation(result.receipts[1].operationId);
    expect((await store.readTaskDb()).tasks).toHaveLength(4);
  });

  it("checks existing tasks when retrying and preserves independently completed work", async () => {
    const loop = new AgentLoop(host);
    responses.push(reply("", [batch()]));
    const first = await loop.run(input());
    const saved = (await store.readTaskDb()).tasks;
    await store.completeTask(saved[0].id);
    responses.push(reply("", [batch()]));
    const retry = await loop.run(input({ message: "继续，全部提交。", history: [
      { role: "assistant", content: first.text, receipts: first.receipts }
    ] }));
    expect(retry.receipts).toEqual([]);
    expect(retry.text).toContain("实际保存0项新任务");
    expect((await store.readTaskDb()).tasks).toHaveLength(5);
    expect((await store.getTask(saved[0].id))?.status).toBe("completed");
  });

  it("does not trust a previous assistant's unsupported claim that all tasks were saved", async () => {
    responses.push(reply("", [batch()]));
    const result = await new AgentLoop(host).run(input({ message: "提交这些今天要做的任务。", history: [
      { role: "user", content: "把五项虚构纸样工作排在今天并创建。" },
      { role: "assistant", content: "五项全部建好了。", receipts: [] }
    ] }));
    expect(result.receipts).toHaveLength(5);
    expect((await store.readTaskDb()).tasks).toHaveLength(5);
  });

  it("reports an exact partial count on failure and does not let a model claim full success", async () => {
    const original = host.executeTools;
    let count = 0;
    host.executeTools = async (...args) => ++count === 3
      ? [{ callId: args[0][0].id!, success: false, output: "虚构磁盘写入失败", actions: [] }]
      : original(...args);
    responses.push(reply("", [batch()]), reply("全部完成，五项已经创建。"));
    const result = await new AgentLoop(host).run(input());
    expect(result.receipts).toHaveLength(2);
    expect(result.text).toContain("本批实际保存2项，后续已停止");
    expect(result.text).not.toContain("五项已经创建");
    expect((await store.readTaskDb()).tasks).toHaveLength(2);
    expect(requests).toHaveLength(1);
  });

  it("stops on missing receipts rather than treating an unverified success flag as a save", async () => {
    host.executeTools = async calls => calls.map(call => ({ callId: call.id!, success: true, output: "保存成功", actions: [] }));
    responses.push(reply("", [batch()]));
    const result = await new AgentLoop(host).run(input());
    expect(result.text).toContain("本批实际保存0项，后续已停止");
    expect((await store.readTaskDb()).tasks).toEqual([]);
  });

  it("preserves the selected day even when time is insufficient", async () => {
    responses.push(reply("", [batch({ availableEnd: "12:40" })]));
    const localNoon = new Date(2026, 10, 12, 12, 0);
    const result = await new AgentLoop(host).run(input({ now: localNoon }));
    expect(result.receipts).toHaveLength(5);
    expect(result.text).toContain("4项在剩余时间内放不下");
    expect((await store.readTaskDb()).tasks.every(t => t.date === formatDate(now))).toBe(true);
  });

  it("still requires one confirmation for four modifications to existing tasks", async () => {
    const saved = [];
    for (let i = 0; i < 4; i++) saved.push(await store.createTask({ title: `虚构已有${i}` }));
    responses.push(reply("", saved.map((t, i) => tool("complete_task", { taskIdOrTitle: t.id }, `complete-${i}`))), reply("等待确认。"));
    const result = await new AgentLoop(host).run(input({ message: "四项已有任务都标记完成。" }));
    expect(result.confirmations).toHaveLength(1);
    expect((await store.readTaskDb()).tasks.every(t => t.status === "active")).toBe(true);
  });
});

it("keeps phone inbox receipts visible when the source is unreadable", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true,
    submit: async () => ({ reply: "虚构待核对。", actions: [] }),
    confirm: async () => undefined, undo: async () => true, notify: () => undefined }, new LifeOpsEventBus());
  try {
    const note = await store.ensureFile(PHONE_INBOX_PATH, "虚构随手记。\n");
    await inbox.scan();
    await store.app.vault.modify(note, "虚构长行。\n".repeat(40_000));
    const snapshot = await inbox.snapshot();
    expect(snapshot).toMatchObject({ source: "unreadable", pending: 0, unfinished: 0,
      receipts: [{ status: "review", message: "虚构待核对。", sourceUnavailable: true }] });
  } finally { inbox.stop(); }
});

it("does not replay permission to process the last phone line after a blocked manual check", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const submit = vi.fn(async (_text: string) => ({ reply: "已核对。", actions: [] }));
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit,
    confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
  const schedule = vi.spyOn(inbox, "schedule").mockImplementation(() => {});
  let finish!: () => void, started!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  try {
    await store.ensureFile(PHONE_INBOX_PATH, "已经写完\n还在修改");
    const writing = runtime.executeLocalOperation("synthetic_concurrent_save", {}, async scope => {
      await scope.writeFile(scope.path(scope.settings.folders.ideas, "synthetic-concurrent-save.md"), "虚构保存");
      started();
      await hold;
    });
    await ready;
    try {
      await expect(inbox.scan(true)).rejects.toThrow("待处理记录暂缓检查");
      expect(schedule).toHaveBeenCalledExactlyOnceWith(10_000);
      expect(submit).not.toHaveBeenCalled();
    } finally { finish(); await writing; }
    await inbox.scan();
    expect(submit.mock.calls.map(args => args[0])).toEqual(["已经写完"]);
    await inbox.scan(true);
    expect(submit.mock.calls.map(args => args[0])).toEqual(["已经写完", "还在修改"]);
  } finally { inbox.stop(); }
});

it("rejects a synced phone row when its final newline is removed during processing", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const original = "虚构记录写完\n";
  const note = await store.ensureFile(PHONE_INBOX_PATH, original);
  const write = vi.fn();
  const inbox = new PhoneInbox({
    store: () => store, enabled: () => true, confirm: async () => {}, undo: async () => true, notify: () => {},
    submit: async (_text, turn) => {
      await turn.assertLineCurrent();
      await store.app.vault.modify(note, original.trimEnd());
      await turn.assertLineCurrent();
      write();
      return { reply: "已保存。", actions: [] };
    }
  }, new LifeOpsEventBus());
  try {
    await inbox.scan();
    expect(write).not.toHaveBeenCalled();
    expect((await inbox.list())[0].status).toBe("review");
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(original.trimEnd());
  } finally { inbox.stop(); }
});

it("leaves a later synced phone row unclaimed if the line changes before its send", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const draft = "虚构第一行\n虚构未写完的第二行";
  const original = draft + "\n";
  const synced = "虚构第一行\n虚构完整第二行\n";
  const note = await store.ensureFile(PHONE_INBOX_PATH, original);
  const submit = vi.fn(async (text: string) => {
    if (text === "虚构第一行") await store.app.vault.modify(note, draft);
    return { reply: "核对完成。", actions: [] };
  });
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit,
    confirm: async () => undefined, undo: async () => true, notify: () => undefined }, new LifeOpsEventBus());
  try {
    await inbox.scan();
    expect(submit.mock.calls.map(([text]) => text)).toEqual(["虚构第一行"]);
    expect(await inbox.snapshot()).toMatchObject({ pending: 0, unfinished: 1, receipts: [{ line: 1 }] });
    await store.app.vault.modify(note, synced);
    await inbox.scan();
    expect(submit.mock.calls.map(([text]) => text)).toEqual(["虚构第一行", "虚构完整第二行"]);
    expect(await inbox.snapshot()).toMatchObject({ pending: 0, unfinished: 0, receipts: [{ line: 2 }, { line: 1 }] });
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(synced);
  } finally { inbox.stop(); }
});

it("keeps the finished phone receipt when sync temporarily removes the input between two rows", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const original = "虚构首行。\n虚构下一行。\n";
  const note = await store.ensureFile(PHONE_INBOX_PATH, original);
  const source = await import("../src/dataFoundation/markdownSources");
  const { readScopedMarkdown } = source;
  const read = vi.spyOn(source, "readScopedMarkdown");
  const notify = vi.fn();
  const submit = vi.fn(async (text: string) => {
    if (text === "虚构首行。") {
      read.mockImplementationOnce(async (...args) => {
        const [, path] = args;
        if (path === PHONE_INBOX_PATH) {
          await store.app.vault.delete(note);
          throw Error("虚构同步临时移除原文件");
        }
        return readScopedMarkdown(...args);
      });
    }
    return { reply: "虚构核对完成。", actions: [] };
  });
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit,
    confirm: async () => {}, undo: async () => true, notify }, new LifeOpsEventBus());
  try {
    await inbox.scan();
    expect(submit).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已处理 1 条"));
    expect(await inbox.snapshot()).toMatchObject({ source: "missing", receipts: [{ sourceUnavailable: true }] });
    await store.ensureFile(PHONE_INBOX_PATH, original);
    await inbox.scan();
    expect(submit.mock.calls.map(([text]) => text)).toEqual(["虚构首行。", "虚构下一行。"]);
    expect((await inbox.snapshot()).receipts).toHaveLength(2);
  } finally { inbox.stop(); vi.restoreAllMocks(); }
});

it.each([false, true])("leaves later phone rows unclaimed if a guarded save starts during a batch (manual: %s)", async manual => {
  const { PhoneInbox, PhoneInboxBusyError } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  let finish!: () => void, started!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  let writing: Promise<unknown> | undefined;
  const submit = vi.fn(async (text: string) => {
    if (text === "虚构第一行") {
      writing = runtime.executeLocalOperation("synthetic_phone_batch_save", {}, async scoped => {
        await scoped.writeFile(store.path(store.settings.folders.ideas, "synthetic-batch.md"), "纯虚构");
        started();
        await hold;
      });
      await ready;
    }
    return { reply: "核对完成。", actions: [] };
  });
  const notify = vi.fn();
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit,
    confirm: async () => undefined, undo: async () => true, notify }, new LifeOpsEventBus());
  const schedule = vi.spyOn(inbox, "schedule").mockImplementation(() => undefined);
  const source = "虚构第一行\n虚构第二行\n";
  try {
    await store.ensureFile(PHONE_INBOX_PATH, source);
    const scan = inbox.scan(manual);
    if (manual) await expect(scan).rejects.toBeInstanceOf(PhoneInboxBusyError);
    else await scan;
    expect(submit.mock.calls.map(([text]) => text)).toEqual(["虚构第一行"]);
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("已处理 1 条"));
    expect(schedule).toHaveBeenCalledExactlyOnceWith(10_000);
    expect((await inbox.list()).map(row => row.line)).toEqual([1]);
    finish();
    await writing;
    await inbox.scan();
    expect(submit.mock.calls.map(([text]) => text)).toEqual(["虚构第一行", "虚构第二行"]);
    expect((await inbox.list()).map(row => row.line)).toEqual([2, 1]);
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(source);
  } finally {
    finish();
    await writing;
    inbox.stop();
  }
});

it("submits phone inbox entries without sending Markdown properties, comments or fenced samples", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const submit = vi.fn(async (_text: string) => ({ reply: "请核对。", actions: [] }));
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit,
    confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
  const original = [
    "\uFEFF---", "project: 虚构属性", "---", "# 手机随手记", "<!--", "虚构模板备注", "-->",
    "%% 行内备注 %%", "%%", "虚构隐藏块", "%%", "~~~text", "虚构示例", "~~~", "[2026-01-09 15:00] 明天取样", ""
  ].join("\r\n");
  try {
    await store.ensureFile(PHONE_INBOX_PATH, original);
    await inbox.scan();
    expect(submit.mock.calls.map(([text]) => text)).toEqual(["明天取样"]);
    expect((await inbox.list()).map(row => row.line)).toEqual([15]);
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(original);
  } finally { inbox.stop(); }
});

function interruptSavedPhoneReceipt(stateName: string, message: string) {
  const vault = store.app.vault;
  const process = vault.process.bind(vault);
  return vi.spyOn(vault, "process").mockImplementation((file, transform) => process(file, current => {
    const next = transform(current);
    if (file.path.endsWith(stateName) && JSON.parse(next).records?.[0]?.status === "saved") throw Error(message);
    return next;
  }));
}

it("recovers a committed phone write whose receipt was interrupted without sending the line again", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH, PHONE_INBOX_STATE } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const submit = vi.fn(async (text: string, phoneInbox: NonNullable<AgentTurnInput["phoneInbox"]>, signal: AbortSignal) => {
    const result = await new AgentLoop(host).run(input({ message: text, source: "system", phoneInbox, signal }));
    expect(result.receipts).toMatchObject([{ operationId: phoneInbox.operationId }]);
    return { reply: result.text, receipts: result.receipts, actions: result.confirmations, toolCalls: result.toolCalls };
  });
  const options = { store: () => store, enabled: () => true, submit, confirm: async () => {},
    undo: (id: string) => runtime.undoOperation(id), notify: () => {} };
  const inbox = new PhoneInbox(options, new LifeOpsEventBus());
  const put = interruptSavedPhoneReceipt(PHONE_INBOX_STATE, "虚构回执写入中断");
  try {
    await store.ensureFile(PHONE_INBOX_PATH, "新增虚构色卡任务\n");
    responses.push(reply("", [tool("create_task", { title: "虚构色卡任务" })]));
    await expect(inbox.scan()).rejects.toThrow("虚构回执写入中断");
    const [originalTask] = (await store.readTaskDb()).tasks;
    expect(originalTask?.title).toBe("虚构色卡任务");
    put.mockRestore();
    inbox.stop();
    const reopened = new PhoneInbox(options, new LifeOpsEventBus());
    try {
      await reopened.scan();
      const [row] = await reopened.list();
      expect(row).toMatchObject({ status: "saved", tool: "create_task" });
      expect(row.pendingOperationId).toBeUndefined();
      expect(submit).toHaveBeenCalledTimes(1);
      await reopened.resolve(row.id, "undo");
      expect((await store.readTaskDb()).tasks).toEqual([]);
      expect((await reopened.list())[0].undone).toBe(true);
    } finally { reopened.stop(); }
  } finally { put.mockRestore(); inbox.stop(); }
});

it("keeps phone lines containing credentials local while processing clean lines", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH, PHONE_INBOX_STATE } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const submit = vi.fn(async (_text: string) => ({ reply: "请核对。", actions: [] }));
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit,
    confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
  const oldKey = store.settings.ai.apiKey;
  const credential = "fictional-config-only-123";
  const syntheticToken = ["sk", "fixture", "test", "ABC123456"].join("-");
  store.settings.ai.apiKey = credential;
  const original = [credential, "请记虚构密钥 " + syntheticToken, "虚构样品准备好了", ""].join("\n");
  try {
    await store.ensureFile(PHONE_INBOX_PATH, original);
    await inbox.scan();
    expect(submit.mock.calls.map(([text]) => text)).toEqual(["虚构样品准备好了"]);
    expect((await inbox.list()).slice(1).every(row => row.status === "review" && row.message.includes("疑似含密钥"))).toBe(true);
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(original);
    const receipt = await store.readPath(store.path(store.settings.folders.aiReports, "System", PHONE_INBOX_STATE));
    expect(receipt).not.toContain(credential);
    expect(receipt).not.toContain(syntheticToken);
  } finally { inbox.stop(); store.settings.ai.apiKey = oldKey; }
});

it("leaves clean phone rows waiting when the configured key lacks storage consent", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const consent = store.settings.privacy!.plaintextCredentialStorageAccepted;
  const oldKey = store.settings.ai.apiKey;
  store.settings.ai.apiKey = "fictional-local-key";
  store.settings.privacy!.plaintextCredentialStorageAccepted = false;
  const submit = vi.fn(async () => ({ reply: "虚构回执。", actions: [] }));
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit,
    confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
  const source = "虚构完整记录\n[2026-01-09 25:30] 虚构异常时刻\n";
  try {
    await store.ensureFile(PHONE_INBOX_PATH, source);
    expect(inbox.autoProcessingReady).toBe(false);
    await inbox.scan();
    expect(submit).not.toHaveBeenCalled();
    expect(await inbox.snapshot()).toMatchObject({ pending: 1, receipts: [{ status: "review" }] });
    store.settings.privacy!.plaintextCredentialStorageAccepted = true;
    expect(inbox.autoProcessingReady).toBe(true);
    await inbox.scan();
    expect(submit).toHaveBeenCalledOnce();
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(source);
  } finally {
    inbox.stop();
    store.settings.ai.apiKey = oldKey;
    store.settings.privacy!.plaintextCredentialStorageAccepted = consent;
  }
});

it("aborts the current phone submission when the inbox is disabled and keeps the input for review", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  let enabled = true;
  const submit = vi.fn((_text: string, _turn: NonNullable<AgentTurnInput["phoneInbox"]>, signal: AbortSignal) =>
    new Promise<import("../src/types").AgentResponse>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
  const inbox = new PhoneInbox({ store: () => store, enabled: () => enabled, submit,
    confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
  const note = "明天取虚构样品\n";
  try {
    await store.ensureFile(PHONE_INBOX_PATH, note);
    const running = inbox.scan();
    const observed = expect(running).rejects.toThrow("手机随手记已停止");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    enabled = false;
    inbox.schedule();
    await observed;
    expect(submit.mock.calls[0][2].aborted).toBe(true);
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(note);
    enabled = true;
    expect((await inbox.list())[0]).toMatchObject({ status: "processing" });
    expect((await store.readTaskDb()).tasks).toEqual([]);
  } finally { inbox.stop(); }
});

it.each([false, true])("requires a fresh manual health form after its location changes (queued: %s)", async queued => {
  const originalFolder = store.settings.folders.health;
  const newFolder = "虚构健康新目录";
  const entry = { date: "2026-11-12", steps: 320 };
  const saveLocalOperation = vi.fn(async (name: string, args: Record<string, unknown>, action: (scope: StoreHost) => Promise<unknown>,
    options?: FactOperationOptions) => {
    if (queued) store.settings.folders.health = newFolder;
    const saved = await runtime.executeLocalOperation(name, args, action, undefined, options);
    if (!saved.success) throw Error(saved.output);
  });
  try {
    Plugin.prototype.openHealthEntryModal.call({ app: store.app, store, saveLocalOperation, refreshViews: async () => {} });
    if (!queued) store.settings.folders.health = newFolder;
    await expect(healthForm.submit!(entry)).rejects.toThrow("健康记录目录已变化");
    expect(saveLocalOperation).toHaveBeenCalledTimes(queued ? 1 : 0);
    expect(store.getFile(store.path(originalFolder, entry.date + ".md"))).toBeNull();
    expect(store.getFile(store.path(newFolder, entry.date + ".md"))).toBeNull();
  } finally {
    healthForm.submit = undefined;
    store.settings.folders.health = originalFolder;
  }
});

it("keeps phone receipts in their original folder when the setting changes during a submission", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH, PHONE_INBOX_STATE } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const originalFolder = store.settings.folders.aiReports;
  const replacementFolder = "虚构回执目录";
  const statePath = (folder: string) => store.path(folder, "System", PHONE_INBOX_STATE);
  const existing = { version: 1, records: [{ id: `${"a".repeat(64)}:1`, line: 1, status: "review", message: "另一目录原有的虚构回执" }] };
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true,
    submit: async (_text, turn) => {
      await turn.assertLineCurrent();
      store.settings.folders.aiReports = replacementFolder;
      await turn.assertLineCurrent();
      return { reply: "迟到的虚构回执", actions: [] };
    },
    confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
  try {
    await store.ensureFile(PHONE_INBOX_PATH, "虚构收件内容\n");
    await store.writeJson(statePath(replacementFolder), existing);
    const error = await inbox.scan().then(() => undefined, error => error);
    expect(await store.readJson(statePath(replacementFolder), null)).toEqual(existing);
    expect(error).toMatchObject({ message: "手机随手记设置已变化。" });
    expect(await store.readJson(statePath(originalFolder), null)).toMatchObject({ records: [{ status: "processing" }] });
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe("虚构收件内容\n");
  } finally {
    inbox.stop();
    store.settings.folders.aiReports = originalFolder;
  }
});

it.each(["folder", "store"] as const)("aborts an in-flight phone submission when its %s changes", async changed => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH, PHONE_INBOX_STATE } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const originalFolder = store.settings.folders.aiReports;
  const replacementFolder = "虚构回执切换目录";
  const note = "虚构正在处理的收件行\n";
  let activeStore = store;
  const submit = vi.fn((_text: string, _turn: NonNullable<AgentTurnInput["phoneInbox"]>, signal: AbortSignal) =>
    new Promise<import("../src/types").AgentResponse>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
  const inbox = new PhoneInbox({ store: () => activeStore, enabled: () => true, submit,
    confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
  await store.ensureFile(PHONE_INBOX_PATH, note);
  const completed = inbox.scan().catch(error => error);
  try {
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    if (changed === "folder") store.settings.folders.aiReports = replacementFolder;
    else activeStore = Object.assign(Object.create(Object.getPrototypeOf(store)), store) as StoreHost;
    inbox.schedule();
    expect(submit.mock.calls[0][2].aborted).toBe(true);
    expect(await completed).toBeInstanceOf(Error);
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(note);
    expect(await store.readJson(store.path(originalFolder, "System", PHONE_INBOX_STATE), null))
      .toMatchObject({ records: [{ status: "processing" }] });
    expect(await store.readJson(store.path(replacementFolder, "System", PHONE_INBOX_STATE), null)).toBeNull();
  } finally {
    inbox.stop();
    await completed;
    store.settings.folders.aiReports = originalFolder;
  }
});

it.each([
  { state: "saved", undo: false, offline: false },
  { state: "undone", undo: true, offline: false },
  { state: "undone with text AI off", undo: true, offline: true }
])("recovers a phone operation after sync removes its receipt ($state)", async ({ undo, offline }) => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH, PHONE_INBOX_STATE } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const statePath = store.path(store.settings.folders.aiReports, "System", PHONE_INBOX_STATE);
  const source = "[2026-11-12 09:00] 整理虚构紫色纸样\n";
  const message = reply("", [tool("create_task", { title: "整理虚构紫色纸样" })]);
  const options = {
    store: () => store, enabled: () => true,
    submit: async (text: string, phoneInbox: NonNullable<AgentTurnInput["phoneInbox"]>, signal: AbortSignal) => {
      const result = await new AgentLoop(host).run(input({ message: text, source: "system", phoneInbox, signal }));
      return { reply: result.text, receipts: result.receipts, actions: result.confirmations, toolCalls: result.toolCalls };
    },
    confirm: async () => {}, undo: (id: string) => runtime.undoOperation(id), notify: () => {}
  };
  const original = new PhoneInbox(options, new LifeOpsEventBus());
  let saved;
  try {
    await store.ensureFile(PHONE_INBOX_PATH, source);
    responses.push(message);
    await original.scan();
    [saved] = await original.list();
    expect(saved.status).toBe("saved");
    if (undo) await original.resolve(saved.id, "undo");
  } finally { original.stop(); }

  await store.writeJson(statePath, { version: 1, records: [] });
  const unseen = offline ? Array.from({ length: 22 }, (_, index) => `虚构离线待读行 ${index + 1}\n`).join("") : "";
  const synchronized = unseen + source;
  if (offline) {
    store.settings.ai.provider = "off";
    await store.writeFile(PHONE_INBOX_PATH, synchronized);
  }
  const reopened = new PhoneInbox(options, new LifeOpsEventBus());
  try {
    // The second response would create another task if the same line were submitted again.
    responses.push(message);
    await reopened.scan();
    expect((await store.readTaskDb()).tasks).toHaveLength(undo ? 0 : 1);
    expect(requests).toHaveLength(1);
    const snapshot = await reopened.snapshot();
    expect(snapshot.receipts).toMatchObject([{
      id: saved.id, operationId: saved.operationId, status: "saved", line: offline ? 23 : 1,
      ...(undo ? { undone: true } : {})
    }]);
    expect(snapshot.pending).toBe(offline ? 22 : 0);
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(synchronized);
  } finally { reopened.stop(); }
});

it("keeps an unrelated receipt that synced while a phone line was processing", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH, PHONE_INBOX_STATE } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const path = store.path(store.settings.folders.aiReports, "System", PHONE_INBOX_STATE);
  const synchronized = { id: `${"a".repeat(64)}:1`, line: 9, status: "review", message: "同步进来的另一条虚构回执" };
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true,
    submit: async () => {
      const doc = await store.readJson(path, { version: 1, records: [] as unknown[] });
      await store.writeJson(path, { ...doc, records: [...doc.records, synchronized] });
      return { reply: "当前虚构记录的回执", actions: [] };
    }, confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
  try {
    await store.ensureFile(PHONE_INBOX_PATH, "虚构手机原文\n");
    await inbox.scan();
    expect(await store.readJson(path, null)).toMatchObject({ records: expect.arrayContaining([
      synchronized, expect.objectContaining({ status: "review", message: "当前虚构记录的回执" })
    ]) });
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe("虚构手机原文\n");
  } finally { inbox.stop(); }
});

it.each([false, true])("preserves synced phone receipts and stops if the claimed receipt disappeared (%s)", async removed => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH, PHONE_INBOX_STATE } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const path = store.path(store.settings.folders.aiReports, "System", PHONE_INBOX_STATE);
  const execute = vi.fn();
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true,
    submit: async (text, turn) => {
      if (text === "虚构后续原文") return { reply: "虚构后续回执", actions: [] };
      const doc = await store.readJson(path, { version: 1, records: [] as import("../src/features/phoneInbox/model").PhoneInboxRecord[] });
      const row = doc.records[0];
      row.status = "dismissed";
      row.message = "同步的新虚构回执";
      delete row.pendingOperationId;
      await store.writeJson(path, removed ? { ...doc, records: [] } : doc);
      await turn.assertLineCurrent();
      execute();
      return { reply: "旧虚构回执", actions: [] };
    }, confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
  try {
    const source = "虚构收件原文\n虚构后续原文\n";
    await store.ensureFile(PHONE_INBOX_PATH, source);
    if (removed) {
      await expect(inbox.scan()).rejects.toThrow("回执已变化");
      expect(await store.readJson(path, null)).toMatchObject({ records: [] });
    } else {
      await inbox.scan();
      expect(await store.readJson(path, null)).toMatchObject({ records: [
        { status: "dismissed", message: "同步的新虚构回执" }, { status: "review", message: "虚构后续回执" }
      ] });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(source);
  } finally { inbox.stop(); }
});

it.each(["lookup", "create"] as const)("preserves the first phone receipt when sync wins the %s race", async stage => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH, PHONE_INBOX_STATE, parsePhoneInbox } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const folder = store.path(store.settings.folders.aiReports, "System");
  const path = store.path(folder, PHONE_INBOX_STATE);
  await store.ensureFolder(folder);
  const source = "虚构首条原文\n虚构后续原文\n";
  const [, later] = parsePhoneInbox(source, todayString());
  const synchronized = { id: later.id, line: later.line, status: "dismissed", message: "虚构同步回执" };
  const writeSyncedDocument = () => writeFileSync(join(root, path), JSON.stringify({ version: 1, records: [synchronized] }));
  const lookup = store.getFile.bind(store);
  const create = store.app.vault.create.bind(store.app.vault);
  let missingReads = 0;
  const getFile = vi.spyOn(store, "getFile").mockImplementation(filePath => {
    const file = lookup(filePath);
    if (stage === "lookup" && filePath === path && !file && ++missingReads === 2) writeSyncedDocument();
    return file;
  });
  const createFile = vi.spyOn(store.app.vault, "create").mockImplementation((filePath, content, options) => {
    if (stage === "create" && filePath === path && !lookup(path)) writeSyncedDocument();
    return create(filePath, content, options);
  });
  const submit = vi.fn(async () => ({ reply: "虚构首条回执", actions: [] }));
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit,
    confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
  try {
    await store.ensureFile(PHONE_INBOX_PATH, source);
    await inbox.scan();
    expect(submit).toHaveBeenCalledExactlyOnceWith("虚构首条原文", expect.anything(), expect.any(AbortSignal));
    expect(await store.readJson(path, null)).toMatchObject({ records: [
      synchronized, expect.objectContaining({ status: "review", message: "虚构首条回执" })
    ] });
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(source);
  } finally { inbox.stop(); createFile.mockRestore(); getFile.mockRestore(); }
});

it("skips a later phone receipt that synced mid-batch and keeps draining the inbox", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH, PHONE_INBOX_STATE, parsePhoneInbox } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const path = store.path(store.settings.folders.aiReports, "System", PHONE_INBOX_STATE);
  const inputLines = Array.from({ length: 22 }, (_, index) => `虚构手机行 ${index + 1}`);
  const source = `${inputLines.join("\n")}\n`;
  const [, second] = parsePhoneInbox(source, todayString());
  const submit = vi.fn(async (text: string) => {
    if (text === inputLines[0]) {
      const doc = await store.readJson(path, { version: 1, records: [] as unknown[] });
      await store.writeJson(path, { ...doc, records: [...doc.records,
        { id: second.id, line: second.line, status: "review", message: "已从虚构同步得到回执" }] });
    }
    return { reply: "虚构回执", actions: [] };
  });
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit,
    confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
  const schedule = vi.spyOn(inbox, "schedule").mockImplementation(() => undefined);
  try {
    await store.ensureFile(PHONE_INBOX_PATH, source);
    await inbox.scan();
    expect(submit.mock.calls.map(([text]) => text)).toEqual([inputLines[0], ...inputLines.slice(2, 20)]);
    expect(schedule).toHaveBeenCalledOnce();
    await inbox.scan();
    expect(submit.mock.calls.map(([text]) => text)).toEqual([inputLines[0], ...inputLines.slice(2)]);
    expect((await inbox.list()).find(row => row.id === second.id)?.message).toBe("已从虚构同步得到回执");
    expect((await inbox.list())).toHaveLength(22);
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(source);
  } finally { inbox.stop(); }
});

it.each(["folder", "record"] as const)("requires a fresh phone confirmation after a %s change", async kind => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH, PHONE_INBOX_STATE } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const originalFolder = store.settings.folders.aiReports;
  const replacementFolder = kind === "folder" ? "虚构回执新目录" : originalFolder;
  const statePath = (folder: string) => store.path(folder, "System", PHONE_INBOX_STATE);
  const confirm = vi.fn(async () => {});
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true, confirm, undo: async () => true, notify: () => {},
    submit: async () => ({ reply: "核对后删除虚构卡片。", actions: [{ id: "proposal:local:agent-turn:fixture", type: "delete_task",
      date: "2026-11-12", title: "虚构旧卡片", description: "待确认", content: "删除虚构旧卡片" }] }) }, new LifeOpsEventBus());
  try {
    await store.ensureFile(PHONE_INBOX_PATH, "删除虚构卡片\n");
    await inbox.scan();
    const snapshot = await inbox.snapshot();
    const [shown] = snapshot.receipts;
    expect(shown.status).toBe("confirm");
    const replacement = { ...shown, action: { ...shown.action!, id: "proposal:local:agent-turn:other", content: "删除虚构新卡片" } };
    await store.writeJson(statePath(replacementFolder), { version: 1, records: [replacement] });
    store.settings.folders.aiReports = replacementFolder;

    await expect(snapshot.resolve!(shown.id, "confirm")).rejects.toThrow(kind === "folder" ? "手机随手记设置已变化" : "这条回执已变化");
    expect(confirm).not.toHaveBeenCalled();
    expect(await store.readJson(statePath(replacementFolder), null)).toMatchObject({ records: [replacement] });
    const refreshed = await inbox.snapshot();
    await refreshed.resolve!(shown.id, "confirm");
    expect(confirm).toHaveBeenCalledExactlyOnceWith(replacement.action, expect.anything());
  } finally {
    inbox.stop();
    store.settings.folders.aiReports = originalFolder;
  }
});

it("reads an already confirmed phone action from the ledger after the original line is moved away", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH, PHONE_INBOX_STATE } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const setup = await runtime.executeAiToolCall(tool("create_task", { title: "虚构旧色卡" }), "kimi");
  expect(setup.success).toBe(true);
  const confirm = vi.fn(async (action: Parameters<typeof runConfirmedToolAction>[0], turn: NonNullable<AgentTurnInput["phoneInbox"]>) => {
    await runConfirmedToolAction(action, { store, refreshViews: async () => {}, assertCurrent: turn.assertCurrent }, turn.assertLineCurrent);
  });
  const options = {
    store: () => store, enabled: () => true,
    submit: async (text: string, phoneInbox: NonNullable<AgentTurnInput["phoneInbox"]>, signal: AbortSignal) => {
      const result = await new AgentLoop(host).run(input({ message: text, source: "system", phoneInbox, signal }));
      return { reply: result.text, receipts: result.receipts, actions: result.confirmations, toolCalls: result.toolCalls };
    },
    confirm, undo: (id: string) => runtime.undoOperation(id), notify: () => {}
  };
  const inbox = new PhoneInbox(options, new LifeOpsEventBus());
  const put = interruptSavedPhoneReceipt(PHONE_INBOX_STATE, "虚构确认回执写入中断");
  try {
    const note = await store.ensureFile(PHONE_INBOX_PATH, "删除虚构旧色卡\n");
    responses.push(reply("", [tool("delete_task", { taskIdOrTitle: "虚构旧色卡" })]));
    await inbox.scan();
    const [proposal] = await inbox.list();
    expect(proposal.status).toBe("confirm");
    await expect(inbox.resolve(proposal.id, "confirm")).rejects.toThrow("虚构确认回执写入中断");
    expect((await store.readTaskDb()).tasks).toEqual([]);
    put.mockRestore();
    await store.app.vault.modify(note, "# 已整理\n");
    await inbox.resolve(proposal.id, "confirm");
    const [saved] = await inbox.list();
    expect(saved).toMatchObject({ status: "saved", sourceUnavailable: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    await inbox.resolve(saved.id, "undo");
    expect((await store.readTaskDb()).tasks[0]?.title).toBe("虚构旧色卡");
  } finally { put.mockRestore(); inbox.stop(); }
});

it.each(["complete", "legacy", "manual"] as const)("checks the original line ending before confirming a %s phone record", async origin => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH, PHONE_INBOX_STATE } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const setup = await runtime.executeAiToolCall(tool("create_task", { title: "虚构旧便签" }), "kimi");
  expect(setup.success).toBe(true);
  const raw = "删除虚构旧便签";
  const note = await store.ensureFile(PHONE_INBOX_PATH, origin === "manual" ? raw : raw + "\n");
  const confirm = vi.fn(async (action: Parameters<typeof runConfirmedToolAction>[0], turn: NonNullable<AgentTurnInput["phoneInbox"]>) => {
    await turn.assertLineCurrent();
    await runConfirmedToolAction(action, { store, refreshViews: async () => {}, assertCurrent: turn.assertCurrent }, turn.assertLineCurrent);
  });
  const inbox = new PhoneInbox({
    store: () => store, enabled: () => true,
    submit: async (text, phoneInbox, signal) => {
      const result = await new AgentLoop(host).run(input({ message: text, source: "system", phoneInbox, signal }));
      return { reply: result.text, receipts: result.receipts, actions: result.confirmations };
    },
    confirm, undo: id => runtime.undoOperation(id), notify: () => {}
  }, new LifeOpsEventBus());
  try {
    responses.push(reply("", [tool("delete_task", { taskIdOrTitle: "虚构旧便签" })]));
    await inbox.scan(origin === "manual");
    const [proposal] = await inbox.list();
    expect(proposal.status).toBe("confirm");
    if (origin === "legacy") {
      const path = store.path(store.settings.folders.aiReports, "System", PHONE_INBOX_STATE);
      const document = await store.readJson<import("../src/features/phoneInbox/model").PhoneInboxDocument>(path, { version: 1, records: [] });
      delete document.records[0].sourceTerminated;
      await store.writeJson(path, document);
    }
    if (origin !== "manual") {
      await store.app.vault.modify(note, raw);
      expect((await inbox.list())[0]).toMatchObject({ line: 1, sourceEditing: true });
      await expect(inbox.resolve(proposal.id, "confirm")).rejects.toThrow("这一行已回到编辑状态");
      expect(confirm).not.toHaveBeenCalled();
      expect((await store.readTaskDb()).tasks.map(task => task.title)).toEqual(["虚构旧便签"]);
      await store.app.vault.modify(note, raw + "\n");
    } else {
      expect(proposal.sourceEditing).toBeUndefined();
    }
    await inbox.resolve(proposal.id, "confirm");
    expect(confirm).toHaveBeenCalledOnce();
    expect((await store.readTaskDb()).tasks).toEqual([]);
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(origin === "manual" ? raw : raw + "\n");
  } finally { inbox.stop(); }
});

it.each([
  {message:'刚才那条，标题改成「虚构指代新名」，先给确认卡。',patch:{title:'虚构指代新名'}},
  {message:'刚才那条的工作区间改为15:00至16:00，等我确认后再保存。',patch:{startTime:'15:00',endTime:'16:00'}},
  {message:'把「虚构指代原名」的备注改成「要先核对」，先给我确认卡。',patch:{note:'要先核对'}}
])('keeps an explicit preview without a title pair: $message',async({message,patch})=>{
  const task=await store.createTask({title:'虚构指代原名',date:'2026-11-12',startTime:'09:00',endTime:'10:00',note:'虚构原备注'});
  const before={db:await store.readPath(store.taskDbPath()),mirror:await store.readPath(store.taskMirrorPath()),ledger:await store.readPath(new OperationLedger(store).filePath)};
  responses.push(reply('',[tool('update_tasks',{updates:[{taskIdOrTitle:task.id,...patch}]},'fictional-independent-preview')]),reply('请核对修改后确认。'));
  const result=await new AgentLoop(host).run(input({message}));
  expect(result.confirmations).toHaveLength(1);expect(result.confirmations[0].type).toBe('tool_batch');expect(result.receipts).toEqual([]);
  expect(await store.readPath(store.taskDbPath())).toBe(before.db);expect(await store.readPath(store.taskMirrorPath())).toBe(before.mirror);
  expect(await store.readPath(new OperationLedger(store).filePath)).toBe(before.ledger);
  expect(result.confirmations[0].toolBatch?.[0].arguments.updates).toMatchObject([{taskIdOrTitle:task.id,...patch}]);
  await executeConfirmedToolBatch(result.confirmations[0],runtime,()=>{});
  expect(await store.getTask(task.id)).toMatchObject({id:task.id,date:'2026-11-12',...patch});
});
it('does not treat a quoted task field as a preview instruction',async()=>{
  const task=await store.createTask({title:'虚构指代原名',date:'2026-11-12'});
  responses.push(reply('',[tool('update_tasks',{updates:[{taskIdOrTitle:task.id,note:'先给确认卡'}]},'fictional-quoted-preview')]),reply('已保存备注。'));
  const result=await new AgentLoop(host).run(input({message:'把「虚构指代原名」的备注改成「先给确认卡」。'}));
  expect(result.confirmations).toEqual([]);expect((await store.getTask(task.id)).note).toBe('先给确认卡');
});
