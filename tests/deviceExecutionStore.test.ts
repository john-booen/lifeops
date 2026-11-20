import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import { DeviceExecution, type DeviceWorkspace, type LocalDeviceState } from "../src/features/devices/execution";
vi.mock("obsidian",()=>({App:class{},TFile:class{},TFolder:class{},Notice:class{},normalizePath:(s:string)=>s.replace(/\\/g,"/").replace(/\/{2,}/g,"/"),requestUrl:vi.fn(),parseYaml:JSON.parse,stringifyYaml:JSON.stringify}));
const {createFsApp}=await import("./helpers/fsApp");const {LifeOpsStore}=await import("../src/store");
const {OperationLedger}=await import("../src/dataFoundation/operationLedger");
let root:string,store:StoreHost,policy:DeviceExecution,workspace:DeviceWorkspace|null;
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),"lifeops-device-execution-store-"));workspace=null;
 const app=createFsApp(root);const seed=new LifeOpsStore(app,structuredClone(DEFAULT_SETTINGS));await seed.initializeVault();
 let local:LocalDeviceState|null=null;
 policy=new DeviceExecution({load:()=>local,save:value=>{local=structuredClone(value);}},async()=>workspace,()=>[(seed as unknown as StoreHost).path(seed.settings.folders.aiReports,"Operations","operation-ledger.json"),(seed as unknown as StoreHost).path(seed.settings.folders.aiReports,"Operations","write-recovery.json")]);
 const guarded=new LifeOpsStore(app,seed.settings,{canWriteFacts:()=>policy.canWriteFacts,assertWriteAllowed:(identity,target)=>policy.assertWriteAllowed(identity,target)});
 store=guarded as unknown as StoreHost;
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
it("blocks a companion fact and audit claim while preserving the actual disk data",async()=>{
 await policy.useCaptureMode();const before=await store.readPath(store.taskDbPath());
 await expect(store.createTask({title:"纯虚构禁止直接保存",date:"2066-01-04"})).rejects.toThrow("执行端");
 expect(await store.readPath(store.taskDbPath())).toBe(before);
 await expect(new OperationLedger(store).claim({operationId:"local:fictional-blocked",toolName:"create_task",arguments:{title:"纯虚构"},source:"system"})).rejects.toThrow("执行端");
});
it("permits the selected execution device to save through the existing store",async()=>{
 await policy.useWriterMode(async value=>{workspace=structuredClone(value);});
 const task=await store.createTask({title:"纯虚构执行端保存",date:"2066-01-04"});
 expect((await store.readTaskDb()).tasks.map(row=>row.id)).toContain(task.id);
});
it("rolls back the operation when the local role changes before commit",async()=>{
 await policy.useWriterMode(async value=>{workspace=structuredClone(value);});const path=store.path(store.settings.folders.ideas,"纯虚构设备角色.md");
 await expect(store.runFactOperation!({operationId:"local:device-role-change"},async scope=>{
  await scope.writeFile(path,"纯虚构内容");await policy.useCaptureMode();
 },async()=>{})).rejects.toThrow("执行端");
 expect(store.getFile(path)).toBeNull();
});
it("passes the exact first-party setup identity into the existing audit and fact boundary",async()=>{
 await policy.useWriterMode(async (value,operationId)=>{
  const ledger=new OperationLedger(store);
  const claim=await ledger.claim({operationId,toolName:"local_configure_device_execution",arguments:{workspaceId:value.workspaceId},source:"system"});
  expect(claim.kind).toBe("execute");
  await store.runFactOperation!({operationId},async()=>{workspace=structuredClone(value);},async()=>{});
 });
 expect(policy.canWriteFacts).toBe(true);
});
