import { mkdtemp, rm, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("obsidian",()=>({App:class{},TFile:class{},TFolder:class{},Notice:class{},normalizePath:(s:string)=>s.replace(/\\/g,"/").replace(/\/{2,}/g,"/"),requestUrl:vi.fn(),parseYaml:JSON.parse,stringifyYaml:JSON.stringify}));
const { createFsApp } = await import("./helpers/fsApp");
const { DeviceCoordinator } = await import("../src/features/devices/coordinator");
const { DEFAULT_SETTINGS } = await import("../src/defaults");
const { AgentRuntime } = await import("../src/agentRuntime");
const { DEVICE_WORKSPACE_PATH } = await import("../src/features/devices/execution");
const { parseDeviceCapture } = await import("../src/features/phoneInbox/deviceCapture");
const { parseDeviceWorkspaceFile } = await import("../src/features/devices/workspace");
const { factRecoveryPath, recoverFactOperation } = await import("../src/dataFoundation/factOperation");
import type { LocalDeviceState } from "../src/features/devices/execution";
import type { StoreHost } from "../src/store/settingsSlice";
const roots:string[]=[];
async function device() {
 const root=await mkdtemp(join(tmpdir(),"lifeops-device-coordinator-"));roots.push(root);
 const settings=structuredClone(DEFAULT_SETTINGS);const app=createFsApp(root);
 let local:LocalDeviceState|null=null;
 const storage={load:()=>local,save:(value:LocalDeviceState)=>{local=structuredClone(value);}};
 const devices=new DeviceCoordinator(app,()=>settings,storage);await devices.execution.refresh();
 const store=devices.createStore() as unknown as StoreHost;
 const runtime=new AgentRuntime({store,refreshViews:async()=>{}});
 return {root,settings,devices,store,runtime,app,storage};
}
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
it.each(["initial setup", "layout update"])("keeps the terminal WAL old-readable immediately after %s, with full audit undo retained",async phase=>{
 const a=await device();
 await a.devices.chooseWriter(a.runtime);
 let before:string|null=null;
 if(phase==="layout update"){
  before=await a.store.readPath(DEVICE_WORKSPACE_PATH);
  a.settings.folders.ideas="纯虚构改版目录/想法";
  await a.devices.publishLayout(a.runtime);
 }
 // No intervening business operation may replace the setup WAL before this check.
 const raw=JSON.parse(await a.store.readPath(factRecoveryPath(a.store)));
 expect(raw).toMatchObject({version:1,status:"committed",entries:[]});
 const ledger=JSON.parse(await a.store.readPath(a.store.path(a.settings.folders.aiReports,"Operations","operation-ledger.json")));
 const claim=ledger.records.find((row:{operationId:string})=>row.operationId===raw.operationId);
 expect(claim).toMatchObject({toolName:"scheduled_configure_device_execution",status:"verified",result:{success:true,
  undo:{kind:"restore_guarded_files",files:[{path:DEVICE_WORKSPACE_PATH,before,after:await a.store.readPath(DEVICE_WORKSPACE_PATH)}]}}});
 expect(a.devices.execution.canWriteFacts).toBe(true);
});
it("keeps the complete pending setup WAL when its terminal write fails and compacts only after recovery",async()=>{
 const a=await device(),process=a.app.vault.process.bind(a.app.vault);let failed=false;
 a.app.vault.process=async(file,updater)=>process(file,raw=>{
  const next=updater(raw);
  if(file.path===factRecoveryPath(a.store)&&JSON.parse(next).status==="committed"&&!failed){failed=true;throw Error("fictional terminal disk failure");}
  return next;
 });
 await a.devices.chooseWriter(a.runtime);
 const pending=JSON.parse(await a.store.readPath(factRecoveryPath(a.store)));
 expect(failed).toBe(true);expect(pending.status).toBe("pending");
 expect(pending.entries).toHaveLength(1);
 expect(pending.entries[0]).toMatchObject({path:DEVICE_WORKSPACE_PATH,before:null,after:await a.store.readPath(DEVICE_WORKSPACE_PATH)});
 a.app.vault.process=process;
 expect(await recoverFactOperation(a.store)).toBe("kept");
 expect(JSON.parse(await a.store.readPath(factRecoveryPath(a.store)))).toMatchObject({status:"committed",entries:[]});
});
it("retains full rollback evidence until the final setup guard accepts",async()=>{
 const a=await device(),execute=a.runtime.executeLocalOperation.bind(a.runtime);let checks=0;
 vi.spyOn(a.runtime,"executeLocalOperation").mockImplementation((name,args,save,id,options)=>execute(name,args,save,id,{
  ...options,assertBeforeCommit:async()=>{if(++checks===2)throw Error("fictional setup cancelled at final guard");}
 }));
 await expect(a.devices.chooseWriter(a.runtime)).rejects.toThrow("cancelled at final guard");
 expect(checks).toBe(2);expect(a.store.getFile(DEVICE_WORKSPACE_PATH)).toBeNull();
 expect(a.devices.execution.canWriteFacts).toBe(false);expect(a.devices.execution.role).toBe("setup");
 expect(JSON.parse(await a.store.readPath(factRecoveryPath(a.store)))).toMatchObject({status:"rolled_back",entries:[]});
});
it("preserves a competing policy and the full pending WAL if the policy changes at terminal compaction",async()=>{
 const a=await device(),process=a.app.vault.process.bind(a.app.vault);let changed=false,external="";
 a.app.vault.process=async(file,updater)=>{
  if(file.path===factRecoveryPath(a.store)&&!changed){
   const next=JSON.parse(updater(await a.store.readPath(file.path)));
   if(next.status==="committed"){
    changed=true;external=JSON.stringify({...JSON.parse(await a.store.readPath(DEVICE_WORKSPACE_PATH)),executionDeviceId:"11111111-1111-4111-8111-111111111111"});
    await writeFile(join(a.root,DEVICE_WORKSPACE_PATH),external);
   }
  }
  return process(file,updater);
 };
 await expect(a.devices.chooseWriter(a.runtime)).rejects.toThrow();
 expect(changed).toBe(true);expect(await a.store.readPath(DEVICE_WORKSPACE_PATH)).toBe(external);
 const wal=JSON.parse(await a.store.readPath(factRecoveryPath(a.store)));
 expect(wal.status).toBe("pending");expect(wal.entries).toHaveLength(1);
 expect(wal.entries[0].path).toBe(DEVICE_WORKSPACE_PATH);expect(wal.entries[0].after).not.toBe(external);
 expect(a.devices.execution.canWriteFacts).toBe(false);
});
it("boots an empty real vault into its selected executor with a content-free shared layout",async()=>{
 const a=await device();a.settings.folders.tasks="纯虚构共享目录/任务";
 a.settings.ai.apiKey="fictional-key-should-not-sync";
 await a.devices.chooseWriter(a.runtime);await a.store.initializeVault();
 expect(a.devices.execution.canWriteFacts).toBe(true);
 const wire=await readFile(join(a.root,DEVICE_WORKSPACE_PATH),"utf8");
 expect(wire).not.toContain("fictional-key");expect(wire).not.toContain("apiKey");
 expect(parseDeviceWorkspaceFile(JSON.parse(wire)).layout.folders.tasks).toBe("纯虚构共享目录/任务");
 const ledger=JSON.parse(await a.store.readPath(a.store.path(a.settings.folders.aiReports,"Operations","operation-ledger.json")));
 expect(ledger.records.find((row: {toolName:string})=>row.toolName==="scheduled_configure_device_execution")?.status).toBe("verified");
});
it("syncs layout to an independently identified companion that queues offline inputs but cannot overwrite tasks",async()=>{
 const a=await device(),b=await device();a.settings.folders.tasks="纯虚构共享目录/任务";
 await a.devices.chooseWriter(a.runtime);await a.store.initializeVault();
 await mkdir(dirname(join(b.root,DEVICE_WORKSPACE_PATH)),{recursive:true});
 await cp(join(a.root,DEVICE_WORKSPACE_PATH),join(b.root,DEVICE_WORKSPACE_PATH));
 await b.devices.execution.useCaptureMode();
 expect(b.settings.folders.tasks).toBe(a.settings.folders.tasks);
 expect(b.devices.execution.deviceId).not.toBe(a.devices.execution.deviceId);
 await expect(b.devices.chooseWriter(b.runtime)).rejects.toThrow("已有执行端");
 await expect(b.store.createTask({title:"纯虚构不能直接写",date:"2066-01-05"})).rejects.toThrow("执行端");
 const path=await b.devices.queueCapture("纯虚构：明天整理笔记",new Date("2066-01-04T23:50:00Z"),"Asia/Shanghai");
 const text=await readFile(join(b.root,path),"utf8");
 const row=parseDeviceCapture(text,path);expect(row.date).toBe("2066-01-05");expect(row.text).toContain("纯虚构");
 expect(b.store.getFile(b.store.taskDbPath())).toBeNull();
 await mkdir(dirname(join(a.root,path)),{recursive:true});await cp(join(b.root,path),join(a.root,path));
 expect(parseDeviceCapture(await readFile(join(a.root,path),"utf8"),path)).toEqual(row);
});
it("publishes directory changes without sharing provider secrets and preserves the local device identity on reopen",async()=>{
 const a=await device();await a.devices.chooseWriter(a.runtime);await a.store.initializeVault();
 a.settings.folders.ideas="纯虚构/想法";a.settings.realtimeVoice.apiKey="fictional-private-key";
 await a.devices.publishLayout(a.runtime);
 expect(parseDeviceWorkspaceFile(JSON.parse(await readFile(join(a.root,DEVICE_WORKSPACE_PATH),"utf8"))).layout.folders.ideas).toBe("纯虚构/想法");
 const reopened=new DeviceCoordinator(a.app,()=>a.settings,a.storage);await reopened.execution.refresh();
 expect(reopened.execution.deviceId).toBe(a.devices.execution.deviceId);expect(reopened.execution.canWriteFacts).toBe(true);
});
it("holds malformed sync metadata and rejects configured credentials in pending raw captures",async()=>{
 const a=await device();await a.devices.execution.useCaptureMode();
 a.settings.ai.apiKey="synthetic-secret-cannot-queue";
 await expect(a.devices.queueCapture("纯虚构 " + a.settings.ai.apiKey)).rejects.toThrow("密钥");
 expect(a.store.getFile(DEVICE_WORKSPACE_PATH)).toBeNull();
 expect(()=>parseDeviceWorkspaceFile({version:1,workspaceId:a.devices.execution.deviceId,executionDeviceId:a.devices.execution.deviceId,layout:{folders:{...a.settings.folders,tasks:"../escape"}}})).toThrow();
});
it("rejects a symlinked capture root before writing any input outside the fictional vault",async()=>{
 const a=await device();await a.devices.execution.useCaptureMode();
 const outside=await mkdtemp(join(tmpdir(),"lifeops-device-outside-"));roots.push(outside);
 const {symlink,readdir}=await import("node:fs/promises");
 await mkdir(join(a.root,"输入"),{recursive:true});await symlink(outside,join(a.root,"输入/设备随手记"));
 await expect(a.devices.queueCapture("纯虚构禁止越界")).rejects.toThrow("目录需要核对");
 expect(await readdir(outside)).toEqual([]);
});

it("stops an established executor on a synced competing policy while preserving both copies and raw capture",async()=>{
 const a=await device();await a.devices.chooseWriter(a.runtime);await a.store.initializeVault();
 const original=await a.store.readPath(DEVICE_WORKSPACE_PATH);
 const conflict="输入/设备协作.sync-conflict-20660104-123456-ABCDEFG.json";
 const competing=JSON.stringify({...JSON.parse(original),executionDeviceId:"11ec4614-9488-4c39-b75c-a5cd3a72e1b7"});
 await a.app.vault.create(conflict,competing);
 await expect(a.store.createTask({title:"纯虚构冲突时不得写入"})).rejects.toThrow("同步冲突");
 expect(a.devices.execution.canWriteFacts).toBe(false);
 expect(a.devices.execution.problemMessage).toContain("同步冲突");
 expect((await a.store.readTaskDb()).tasks).toHaveLength(0);
 expect(await a.store.readPath(DEVICE_WORKSPACE_PATH)).toBe(original);
 expect(await a.store.readPath(conflict)).toBe(competing);
 const queued=await a.devices.queueCapture("纯虚构冲突期间保留原话");
 expect(parseDeviceCapture(await a.store.readPath(queued),queued).text).toContain("保留原话");
 // Fictional fixture: retain the competing copy outside the active policy names after review.
 await a.app.vault.rename(a.store.getFile(conflict)!,"输入/纯虚构已核对的设备副本.json");
 await a.devices.execution.refresh();expect(a.devices.execution.canWriteFacts).toBe(true);
 expect(a.devices.execution.problemMessage).toBe("");
 await a.store.createTask({title:"纯虚构核对后可继续"});expect((await a.store.readTaskDb()).tasks).toHaveLength(1);
});

it("reopens with a competing policy in capture-only state and cannot re-elect itself",async()=>{
 const a=await device();await a.devices.chooseWriter(a.runtime);await a.store.initializeVault();
 await a.app.vault.create("输入/设备协作.sync-conflict-20660104-123456-ABCDEFG.json","{}");
 const reopened=new DeviceCoordinator(a.app,()=>a.settings,a.storage);
 await reopened.execution.refresh();
 expect(reopened.execution.canWriteFacts).toBe(false);expect(reopened.execution.problemMessage).toContain("同步冲突");
 const store=reopened.createStore() as unknown as StoreHost;
 await expect(reopened.chooseWriter(new AgentRuntime({store,refreshViews:async()=>{}}))).rejects.toThrow("同步冲突");
 const path=await reopened.queueCapture("纯虚构重开仍保留原话");
 expect(parseDeviceCapture(await store.readPath(path),path).text).toContain("仍保留原话");
});

it("honors an excluded workspace path before enumerating its directory",async()=>{
 const a=await device();await a.devices.chooseWriter(a.runtime);await a.store.initializeVault();
 a.settings.privacy={...a.settings.privacy,excludedVaultPrefixes:["输入/设备协作.json"]};
 const list=vi.spyOn(a.app.vault.adapter,"list");
 await expect(a.devices.execution.refresh()).rejects.toThrow("不允许读取");
 expect(list).not.toHaveBeenCalled();expect(a.devices.execution.canWriteFacts).toBe(false);
 list.mockRestore();
});

it("refreshes a writer on policy conflict events and ignores unrelated writer events",async()=>{
 const a=await device();await a.devices.chooseWriter(a.runtime);await a.store.initializeVault();
 const refs:unknown[]=[],cleanups:Array<()=>void>=[],refresh=vi.fn(async()=>{});
 a.devices.watch(ref=>refs.push(ref),cleanup=>cleanups.push(cleanup),refresh);
 try {
  await a.app.vault.create("输入/纯虚构普通记录.md","原始文字");
  await new Promise(resolve=>setTimeout(resolve,400));expect(refresh).not.toHaveBeenCalled();
  await a.app.vault.create("输入/设备协作.sync-conflict-20660104-123456-ABCDEFG.json","{}");
  await vi.waitFor(()=>expect(refresh).toHaveBeenCalledOnce(),{timeout:1500});
  expect(a.devices.execution.canWriteFacts).toBe(false);
  const file=a.store.getFile("输入/设备协作.sync-conflict-20660104-123456-ABCDEFG.json")!;
  await a.app.vault.rename(file,"输入/纯虚构已核对副本.json");
  await vi.waitFor(()=>expect(refresh).toHaveBeenCalledTimes(2),{timeout:1500});
  expect(a.devices.execution.canWriteFacts).toBe(true);
 }finally{cleanups.forEach(cleanup=>cleanup());refs.forEach(ref=>a.app.vault.offref(ref as never));}
});
