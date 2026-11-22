import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
  normalizePath: (s: string) => s.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { createFsApp } = await import("./helpers/fsApp");
const { formatTaskListReply, repeatedTaskListPriority } = await import("../src/features/tasks/planTools");
let root: string, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
const date = "2068-11-21";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-task-lookup-pages-"));
  store = new LifeOpsStore(createFsApp(root), structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault(); runtime = new AgentRuntime({ store, refreshViews: async () => {} });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function lookup(args: Record<string, unknown>) {
 const result=await runtime.executeAiToolCall({name:"list_tasks",arguments:args},"kimi");expect(result.success,result.output).toBe(true);return JSON.parse(result.output);
}
it("finds named past and future tasks without a supplied date and preserves original dates",async()=>{
 const old=await store.createTask({title:"虚构蓝盒旧任务",date:"2001-02-03",time:"15:15"});
 const future=await store.createTask({title:"虚构蓝盒新任务",date:"2099-02-04",time:"16:00"});
 const bytes=await store.readPath(store.taskDbPath()),data=await lookup({query:"虚构蓝盒"});
 expect(data).toMatchObject({date:null,dateScope:"all",count:2});expect(data.tasks.map((t:{id:string})=>t.id)).toEqual([old.id,future.id]);
 expect(data.tasks).toMatchObject([{date:old.date,endDate:old.endDate},{date:future.date,endDate:future.endDate}]);expect(await store.readPath(store.taskDbPath())).toBe(bytes);
});
it("retains an explicit date when title lookup is restricted",async()=>{
 const first=await store.createTask({title:"虚构纸盒一",date:"2068-11-21"});await store.createTask({title:"虚构纸盒二",date:"2068-11-22"});
 const data=await lookup({query:"虚构纸盒",date:"2068-11-21"});expect(data.count).toBe(1);expect(data.tasks[0].id).toBe(first.id);expect(data.dateScope).toBeUndefined();
});
it("keeps plain and priority lists scoped to today",async()=>{
 const {todayString}=await import("../src/date"),today=todayString();const current=await store.createTask({title:"虚构时范围当前",date:today});
 await store.createTask({title:"虚构时范围未来",date:"2099-02-04"});
 for(const args of [{},{query:"虚构时范围",order:"priority",limit:2}]){const data=await lookup(args);expect(data.date).toBe(today);expect(data.tasks.map((t:{id:string})=>t.id)).toEqual([current.id]);}
});
it("shows all-date lookup dates in the local readable answer",async()=>{
 const task=await store.createTask({title:"虚构跨天纸盒",date:"2099-02-04",endDate:"2099-02-06",startTime:"15:00",endTime:"16:00"});
 const data=await lookup({query:"虚构跨天纸盒"}),reply=formatTaskListReply(JSON.stringify(data),"2068-11-21");
 expect(reply).toContain("所有日期");expect(reply).toContain(task.date);expect(reply).toContain(task.endDate);expect(reply).toContain("15:00");expect(reply).not.toContain("今天");
});
it("keeps the status filter and bounded pages across dates",async()=>{
 const ids=[];for(let i=0;i<24;i++)ids.push((await store.createTask({title:"虚构跨日期页"+i,date:i%2?"2099-02-04":"2001-02-03"})).id);
 await store.completeTask(ids[0]);const one=await lookup({query:"虚构跨日期页",limit:20}),two=await lookup({query:"虚构跨日期页",limit:20,offset:one.nextOffset});
 expect(one.count).toBe(23);expect(two.count).toBe(23);expect(two.truncated).toBe(false);expect(new Set([...one.tasks,...two.tasks].map(t=>t.id)).size).toBe(23);
 const done=await lookup({query:"虚构跨日期页",status:"completed"});expect(done.tasks.map((t:{id:string})=>t.id)).toEqual([ids[0]]);
});
it("does not widen an invalid explicit date into all-date lookup",async()=>{
 await store.createTask({title:"虚构不能泄漏的纸盒",date:"2099-02-04"});const result=await runtime.executeAiToolCall({name:"list_tasks",arguments:{query:"虚构不能泄漏的纸盒",date:"不是日期"}},"kimi");
 expect(result.success).toBe(false);expect(result.output).not.toContain("2099-02-04");
});
it("keeps excluded task records unavailable across dates",async()=>{
 await store.createTask({title:"虚构私密纸盒",date:"2099-02-04"});store.settings.privacy={...store.settings.privacy,excludedVaultPrefixes:[store.taskDbPath()]};
 const result=await runtime.executeAiToolCall({name:"list_tasks",arguments:{query:"纸盒"}},"kimi");expect(result.success).toBe(false);expect(result.output).not.toContain("虚构私密纸盒");
});
