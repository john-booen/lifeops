import { previousSavedTask } from "../src/agent/taskTimeCorrection";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentLoop, type AgentLoopHost } from "../src/agent/AgentLoop";
import { AgentRuntime } from "../src/agentRuntime";
import { OperationLedger } from "../src/dataFoundation/operationLedger";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
  normalizePath: (s: string) => s.replace(/\\/g, "/"), parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { createFsApp } = await import("./helpers/fsApp");
const { LifeOpsStore } = await import("../src/store");
let root: string, store: StoreHost, runtime: AgentRuntime, host: AgentLoopHost;
const model = vi.fn();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-recent-change-"));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.ai = { ...settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", model: "fiction", apiKey: "fiction", dataDisclosureAccepted: true };
  settings.privacy = { ...settings.privacy, excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
  store = new LifeOpsStore(createFsApp(root), settings) as unknown as StoreHost; await store.initializeVault();
  runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  model.mockReset().mockResolvedValue({ content: "这是讨论内容，没有执行撤销。", toolCalls: [] });
  host = { settings, store, aiForRole: () => ({ agentTurnStream: model }), offlineFallback: async () => null,
    executeTools: async (calls, message, _signal, onResult) => Promise.all(calls.map(async call => {
      const result = await runtime.executeAiToolCall(call, "kimi", message); onResult(call, result); return result;
    })) };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function made() {
 const result=await runtime.executeAiToolCall({id:"receipt-context-created",name:"create_task",arguments:{title:"虚构收据纸盒",date:"2099-02-04",time:"15:15"}},"kimi");
 expect(result.success).toBe(true);return (await store.readTaskDb()).tasks[0];
}
for(const source of ["text","voice"] as const) {
 it(`continues after a single title/note edit and undoes only the clock in ${source}`,async()=>{
  const original=await made(),edit=await runtime.executeAiToolCall({id:"receipt-context-edited",name:"update_tasks",arguments:{updates:[{taskIdOrTitle:original.id,title:"虚构收据蓝色纸盒",note:"原备注必须保留"}]}},"kimi");
  expect(edit.success,edit.output).toBe(true);const edited=(await store.readTaskDb()).tasks[0];
  const history=[{role:"assistant" as const,content:edit.output,receipts:[edit.receipt!]}];
  const result=await new AgentLoop(host).run({source,message:"请把刚才那条的时间改到下午四点。",history,now:new Date("2026-11-22T12:00:00+08:00")});
  expect(result.toolCalls).toEqual([{name:"reschedule_task",ok:true}]);expect(result.receipts).toHaveLength(1);expect(model).not.toHaveBeenCalled();
  expect((await store.readTaskDb()).tasks).toMatchObject([{id:edited.id,title:edited.title,note:edited.note,date:edited.date,endDate:edited.endDate,time:"16:00"}]);
  await runtime.undoOperation(result.receipts[0].operationId);expect((await store.readTaskDb()).tasks).toEqual([edited]);
 });
}
it("includes the current scheduled date/time in a verified edited-task reference",async()=>{
 const task=await made(),edited=await runtime.executeAiToolCall({id:"receipt-context-meta",name:"update_tasks",arguments:{updates:[{taskIdOrTitle:task.id,note:"虚构备注"}]}},"kimi");
 const ref=await previousSavedTask(store,[{role:"assistant",content:edited.output,receipts:[edited.receipt!]}]);
 expect(ref).toMatchObject({id:task.id,title:task.title,date:task.date,endDate:task.endDate,time:"15:15"});
});
it("does not pick one object from an attested multiple-task edit",async()=>{
 const first=await made(),second=await store.createTask({title:"虚构另一纸盒",date:"2099-02-05"});
 const edited=await runtime.executeAiToolCall({id:"receipt-context-many",name:"update_tasks",arguments:{updates:[{taskIdOrTitle:first.id,note:"备注甲"},{taskIdOrTitle:second.id,note:"备注乙"}]}},"kimi");
 expect(edited.success,edited.output).toBe(true);expect(await previousSavedTask(store,[{role:"assistant",content:edited.output,receipts:[edited.receipt!]}])).toBeUndefined();
});
it("rejects an edited-task reference after its title changes again",async()=>{
 const task=await made(),edited=await runtime.executeAiToolCall({id:"receipt-context-stale",name:"update_tasks",arguments:{updates:[{taskIdOrTitle:task.id,title:"虚构第一次改名"}]}},"kimi");
 await runtime.executeAiToolCall({id:"receipt-context-other",name:"update_tasks",arguments:{updates:[{taskIdOrTitle:task.id,title:"虚构后来改名"}]}},"kimi");
 expect(await previousSavedTask(store,[{role:"assistant",content:edited.output,receipts:[edited.receipt!]}])).toBeUndefined();
});

it("moves an attested future task to tonight with the current explicit date",async()=>{
 const result=await runtime.executeAiToolCall({id:"receipt-tonight",name:"create_task",arguments:{title:"虚构今晚纸盒",date:"2099-02-04",time:"15:15"}},"kimi");
 const prior=(await store.readTaskDb()).tasks[0];const reply=await new AgentLoop(host).run({source:"text",message:"把刚才那条改到今晚八点",history:[{role:"assistant",content:result.output,receipts:[result.receipt!]}],now:new Date("2026-11-22T12:00:00+08:00")});
 expect(reply.receipts).toHaveLength(1);expect((await store.readTaskDb()).tasks[0]).toMatchObject({id:prior.id,date:"2026-11-22",endDate:prior.endDate,time:"20:00"});expect(model).not.toHaveBeenCalled();
 await runtime.undoOperation(reply.receipts[0].operationId);expect((await store.readTaskDb()).tasks).toEqual([prior]);
});

for(const source of ["text","voice"] as const)it(`keeps the date and changes the actual clock after an explicit preservation clause in ${source}`,async()=>{
 const created=await runtime.executeAiToolCall({id:"receipt-preserved-clock",name:"create_task",arguments:{title:"虚构靛色纸样夹",date:"2099-02-04",time:"15:00"}},"kimi");
 const prior=(await store.readTaskDb()).tasks[0],reply=await new AgentLoop(host).run({source,message:"不对，刚刚那条改成下午三点十五，日期不变。",history:[{role:"assistant",content:created.output,receipts:[created.receipt!]}],now:new Date("2026-11-22T12:00:00+08:00")});
 expect(reply.toolCalls).toEqual([{name:"reschedule_task",ok:true}]);const saved=(await store.readTaskDb()).tasks[0];expect(saved).toMatchObject({id:prior.id,date:prior.date,time:"15:15"});expect(saved.endTime).toBe(prior.endTime);expect(model).not.toHaveBeenCalled();
 if(source==="voice")expect(reply.voiceSpeech).toContain("15:15");await runtime.undoOperation(reply.receipts[0].operationId);expect((await store.readTaskDb()).tasks).toEqual([prior]);
});
