import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {App} from "obsidian";
import {beforeEach,afterEach,expect,it,vi} from "vitest";
import {DEFAULT_SETTINGS} from "../src/defaults";
import type {StoreHost} from "../src/store/settingsSlice";
import type {ToolCallResult} from "../src/agentRuntime";
import {getLifeOpsTool} from "../src/toolRegistry";
import {bindTaskPlanConfirmation} from "../src/features/tasks/planConfirmation";
import {parseVaultTasks} from "../src/vaultApi";
vi.mock("obsidian",()=>({App:class{},Notice:class{},TFile:class{},TFolder:class{},normalizePath:(p:string)=>p.replace(/\\/g,"/").replace(/\/{2,}/g,"/")}));
const {LifeOpsStore}=await import("../src/store"),{AgentRuntime}=await import("../src/agentRuntime"),{DiskVault}=await import("./helpers/diskVault");
let root:string,store:StoreHost,vault:InstanceType<typeof DiskVault>,runtime:InstanceType<typeof AgentRuntime>;
const date="2026-11-25";
beforeEach(async()=>{
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(2026,10,25,10));
  root=await mkdtemp(join(tmpdir(),"lifeops-deadline-tools-"));vault=new DiskVault(root);
  store=new LifeOpsStore({vault} as unknown as App,structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;await store.initializeVault();
  runtime=new AgentRuntime({store,refreshViews:async()=>{}});
});
afterEach(async()=>{vi.restoreAllMocks();vi.useRealTimers();await rm(root,{recursive:true,force:true});});
const facts=()=>Promise.all([store.taskDbPath(),store.taskMirrorPath()].map(p=>vault.bytes(p)));
const create=(args:Record<string,unknown>)=>runtime.executeAiToolCall({id:"fictional-deadline-create",name:"create_task",arguments:{title:"虚构蓝纸周整理",...args}},"kimi");
const batch=(tasks:Record<string,unknown>[])=>runtime.executeAiToolCall({id:"fictional-deadline-batch",name:"schedule_task_batch",arguments:{date,availableStart:"10:00",tasks}},"kimi");
function preview(id:string,dueDate:string):ToolCallResult{return{callId:"fictional-deadline-preview",success:true,output:"",actions:[{id:"fictional-deadline-card",type:"tool_batch",title:"核对任务",description:"",content:"",date,toolBatch:[{id:"fictional-deadline-update",name:"update_tasks",arguments:{updates:[{taskIdOrTitle:id,dueDate}]}}]}]};}

it("exposes independent deadline fields on creation, editing and each batch item",()=>{
  const createProps=getLifeOpsTool("create_task")!.parameters.properties as Record<string,unknown>;
  const updateProps=(getLifeOpsTool("update_tasks")!.parameters.properties as Record<string,any>).updates.items.properties;
  const batchProps=(getLifeOpsTool("schedule_task_batch")!.parameters.properties as Record<string,any>).tasks.items.properties;
  for(const properties of [createProps,updateProps,batchProps])expect(properties).toHaveProperty("dueDate");
  for(const properties of [createProps,updateProps,batchProps])expect(properties).toHaveProperty("dueTime");
});
it("saves a cross-month period and a separate hard deadline in real JSON, Markdown and the receipt, then undoes exactly",async()=>{
  const before=await facts();const result=await create({date,endDate:"2026-12-02",scheduleMode:"window",dueDate:"2026-12-03",dueTime:"17:30"});
  expect(result.success,result.output).toBe(true);
  expect((await store.readTaskDb({readOnly:true})).tasks).toMatchObject([{date,endDate:"2026-12-02",scheduleMode:"window",dueDate:"2026-12-03",dueTime:"17:30",time:""}]);
  expect(parseVaultTasks(await vault.bytes(store.taskMirrorPath()))).toMatchObject([{dueDate:"2026-12-03",dueTime:"17:30"}]);
  expect(result.output).toContain("必须截止2026-12-03 17:30");
  expect(await runtime.undoOperation(result.receipt!.operationId)).toBe(true);expect(await facts()).toEqual(before);
});
it("accepts only a deadline without inventing a work date, start or plan end",async()=>{
  const result=await create({dueDate:"明天",dueTime:"09:00"});expect(result.success,result.output).toBe(true);
  expect((await store.readTaskDb()).tasks).toMatchObject([{date:"",endDate:"",dueDate:"2026-11-26",dueTime:"09:00",time:""}]);
});
it("does not turn a period's plan end into an implicit hard deadline",async()=>{
  const result=await create({date,endDate:"2026-12-02",scheduleMode:"window"});expect(result.success,result.output).toBe(true);
  expect((await store.readTaskDb()).tasks).toMatchObject([{endDate:"2026-12-02",dueDate:"",dueTime:""}]);
});
it.each([{dueDate:"2026-02-30"},{dueDate:25},{dueDate:true},{dueDate:"2026-12-03",dueTime:"25:00"},{dueDate:"2026-12-03",dueTime:17},{dueTime:"17:30"},{dueDate:"",dueTime:"17:30"}])("rejects invalid deadline input before any task write: %j",async args=>{
  const before=await facts(),write=vi.spyOn(store,"createTask");const result=await create({date,...args});
  expect(result.success).toBe(false);expect(write).not.toHaveBeenCalled();expect(await facts()).toEqual(before);
});
it("rolls back a creation whose stored deadline disagrees with the read-back result",async()=>{
  const before=await facts(),original=store.createTask;
  vi.spyOn(store,"createTask").mockImplementation(async function(this:StoreHost,input){const task=await original.call(this,input);await this.updateTask(task.id,t=>({...t,dueTime:"09:00"}));return task;});
  const result=await create({date,dueDate:"2026-12-03",dueTime:"17:30"});expect(result.success).toBe(false);expect(await facts()).toEqual(before);
});
it("edits and clears a deadline while retaining the period, task identity and notes",async()=>{
  const task=await store.createTask({title:"虚构原有期间",date,endDate:"2026-12-02",scheduleMode:"window",note:"虚构原备注",dueDate:"2026-12-03",dueTime:"17:30"});
  const before=await facts(),edit=await runtime.executeAiToolCall({id:"fictional-deadline-edit",name:"update_tasks",arguments:{updates:[{taskIdOrTitle:task.id,dueDate:"2026-12-04"}]}},"kimi");
  expect(edit.success,edit.output).toBe(true);expect(await store.getTask(task.id)).toMatchObject({id:task.id,endDate:"2026-12-02",note:"虚构原备注",dueDate:"2026-12-04",dueTime:"17:30"});
  expect(edit.output).toContain("2026-12-04 17:30");await runtime.undoOperation(edit.receipt!.operationId);expect(await facts()).toEqual(before);
  const cleared=await runtime.executeAiToolCall({id:"fictional-deadline-clear",name:"update_tasks",arguments:{updates:[{taskIdOrTitle:task.id,dueDate:""}]}},"kimi");
  expect(cleared.success,cleared.output).toBe(true);expect(await store.getTask(task.id)).toMatchObject({date,endDate:"2026-12-02",dueDate:"",dueTime:"",note:"虚构原备注"});
});
it("shows both deadline versions in a frozen card and refuses it after another task change",async()=>{
  const task=await store.createTask({title:"虚构确认截止",date,dueDate:"2026-12-03",dueTime:"17:30"});const before=await facts(),card=preview(task.id,"2026-12-04");
  await bindTaskPlanConfirmation(store,card);expect(card.success,card.output).toBe(true);expect(card.actions[0].content).toContain("2026-12-03 17:30");expect(card.actions[0].content).toContain("2026-12-04 17:30");expect(await facts()).toEqual(before);
  await store.updateTask(task.id,t=>({...t,note:"虚构另一端后来修改"}));const current=await facts();
  const result=await runtime.executeToolCall({toolName:"update_tasks",arguments:card.actions[0].toolBatch![0].arguments,source:"system",callId:"fictional-confirm-deadline",confirmedByUser:true});
  expect(result.success).toBe(false);expect(await facts()).toEqual(current);
});
it("saves every batch deadline and reports a schedule that exceeds one without moving it to tomorrow",async()=>{
  const result=await batch([{title:"虚构早截止",estimateMin:30,dueDate:date,dueTime:"10:15"},{title:"虚构跨月截止",estimateMin:20,dueDate:"2026-12-03",dueTime:"17:30"}]);
  expect(result.success,result.output).toBe(true);expect(result.receipt?.taskBatch).toEqual({created:2,existing:0});
  expect((await store.readTaskDb()).tasks).toMatchObject([{date,dueDate:date,dueTime:"10:15"},{date,dueDate:"2026-12-03",dueTime:"17:30"}]);
  expect(result.output).toContain("晚于必须截止");
});
it("rejects an invalid second batch deadline without partially creating the first task",async()=>{
  const before=await facts(),result=await batch([{title:"虚构先正确",dueDate:"2026-12-03"},{title:"虚构后错误",dueDate:"2026-02-30"}]);
  expect(result.success).toBe(false);expect(await facts()).toEqual(before);
});
it("does not silently reuse a same-name task with a different requested deadline",async()=>{
  const task=await store.createTask({title:"虚构已有同名",date,dueDate:"2026-12-03"}),before=await facts();
  const result=await batch([{title:task.title,dueDate:"2026-12-04"}]);expect(result.success).toBe(false);expect(result.output).toContain("截止");expect(await facts()).toEqual(before);
});
