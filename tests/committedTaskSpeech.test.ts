import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentRuntime, type ToolCallResult } from "../src/agentRuntime";
import { OperationLedger } from "../src/dataFoundation/operationLedger";
import { committedTaskSpeechReply, retainCommittedTaskSpeechResponse, committedTaskSpeechForResponse } from "../src/voice/committedTaskSpeech";
import type { AgentResponse } from "../src/types";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({ App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {},
  ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: false },
  Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  requestUrl: () => { throw Error("No external HTTP in speech projection test"); } }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, store: StoreHost, vault: InstanceType<typeof DiskVault>, runtime: AgentRuntime;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-committed-speech-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault, workspace: { getLeavesOfType: () => [] } } as unknown as App,
    structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
  runtime = new AgentRuntime({ store, refreshViews: async () => {} });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const create = (title = "纯虚构语音任务", callId = "fictional-speech-create") => runtime.executeToolCall({
  toolName: "create_task", arguments: { title, date: "明天", time: "15:00" },
  source: "system", confirmedByUser: true, callId
});
function project(result: ToolCallResult, message = "帮我创建一个明天下午三点的任务", results = [result], host = store) {
  const response: AgentResponse = { reply: result.output, actions: [] };
  retainCommittedTaskSpeechResponse(host,response,results,message);
  return committedTaskSpeechForResponse(host,response,response.reply);
}
it("projects the actual new committed receipt while disk, original reply, Ledger and Undo remain intact", async () => {
  const before = [await vault.bytes(store.taskDbPath()), await vault.bytes(store.taskMirrorPath())];
  const saved = await create(); expect(saved.success).toBe(true);
  const task = (await store.readTaskDb()).tasks[0], original = saved.output;
  const files = [store.taskDbPath(), store.taskMirrorPath(), new OperationLedger(store).filePath];
  const after = await Promise.all(files.map(p => vault.bytes(p)));
  const spoken = project(saved);
  expect(spoken).toBe(original.replace(`已从任务库读回校验（ID：${task.id}）。`, "已从任务库读回校验。"));
  expect(spoken).not.toContain(task.id); expect(spoken).toContain(task.title); expect(spoken).toContain("15:00");
  expect(saved.output).toBe(original); expect(await Promise.all(files.map(p => vault.bytes(p)))).toEqual(after);
  expect((await store.readJson<any>(files[2], { records: [] })).records[0].result.output).toBe(original);
  const undone = await runtime.executeToolCall({ toolName: "undo_latest_operation", arguments: {},
    source: "system", confirmedByUser: true, callId: "fictional-speech-undo" });
  expect(undone.success).toBe(true);
  expect([await vault.bytes(files[0]), await vault.bytes(files[1])]).toEqual(before);
});
it.each(["任务编号", "ID", "id", "内部标识", "taskId", "task_id", "ID007"])("keeps the full receipt when the person mentions %s", async identifier => {
  const saved = await create(); expect(project(saved, `创建任务并告诉我${identifier}`)).toBe(saved.output);
});
it("keeps ID-like literal task titles and all title numbers exactly", async () => {
  const title = "ID-007、蓝色海豚七；已从任务库读回校验（ID：task-123-copy）。";
  const saved = await create(title), spoken = project(saved);
  expect(spoken).toContain(title);
  expect(spoken).toBe(saved.output.slice(0, saved.output.lastIndexOf("已从任务库读回校验（ID：")) + "已从任务库读回校验。");
});
it("a copied or deserialized receipt does not acquire the original Runtime evidence", async () => {
  const saved = await create();
  for (const copy of [{ ...saved }, JSON.parse(JSON.stringify(saved))]) expect(project(copy)).toBe(saved.output);
});
it("the original receipt used with another Store does not acquire speech projection", async () => {
  const saved = await create(), other = new LifeOpsStore(store.app, structuredClone(store.settings)) as unknown as StoreHost;
  expect(project(saved, "创建任务", [saved], other)).toBe(saved.output);
});
it("cached success is not treated as a newly committed task", async () => {
  await create(); const cached = await create(); expect(cached.success).toBe(true); expect(project(cached)).toBe(cached.output);
});
it("mixed outputs and changed response text retain the original complete text", async () => {
  const saved = await create(); expect(project(saved, "创建任务", [saved, saved])).toBe(saved.output);
  const reply = saved.output + " 另外请核对编号。";
  expect(committedTaskSpeechReply(store, { reply, actions: [] }, [saved], "创建任务")).toBe(reply);
});
it("a failed tool result cannot get a shortened success claim", async () => {
  const failed = await runtime.executeToolCall({ toolName: "create_task", arguments: {}, source: "system", callId: "fictional-failed" });
  expect(failed.success).toBe(false); expect(project(failed)).toBe(failed.output);
});
it("binds only the original response and does not serialize or mutate its visible receipt",async()=>{
  const saved=await create(),response:AgentResponse={reply:saved.output,actions:[]},raw=JSON.stringify(response);
  retainCommittedTaskSpeechResponse(store,response,[saved],"创建任务");
  expect(committedTaskSpeechForResponse(store,response,response.reply)).not.toContain("（ID：");
  expect(JSON.stringify(response)).toBe(raw);expect(response.reply).toBe(saved.output);
  for(const copy of [{...response},JSON.parse(raw)])expect(committedTaskSpeechForResponse(store,copy,copy.reply)).toBe(saved.output);
  const other=new LifeOpsStore(store.app,structuredClone(store.settings))as unknown as StoreHost;
  expect(committedTaskSpeechForResponse(other,response,response.reply)).toBe(saved.output);
  const originalVault=store.app.vault;
  try{(store.app as any).vault={};expect(committedTaskSpeechForResponse(store,response,response.reply)).toBe(saved.output);}
  finally{(store.app as any).vault=originalVault;}
});
it("changed text or later pending actions cannot reuse the original response's speech projection",async()=>{
  const saved=await create(),response:AgentResponse={reply:saved.output,actions:[]};
  retainCommittedTaskSpeechResponse(store,response,[saved],"创建任务");
  const changed=saved.output+" 原样保留编号。";
  expect(committedTaskSpeechForResponse(store,response,changed)).toBe(changed);
  response.reply=changed;expect(committedTaskSpeechForResponse(store,response,saved.output)).toBe(saved.output);
  response.reply=saved.output;response.actions=[{}as never];
  expect(committedTaskSpeechForResponse(store,response,response.reply)).toBe(saved.output);
});
