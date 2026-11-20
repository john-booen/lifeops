import { mkdtemp, rm, cp, mkdir, readFile } from "node:fs/promises";
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
