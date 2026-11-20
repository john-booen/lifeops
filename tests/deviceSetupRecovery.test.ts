import fs from "node:fs";
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
vi.mock("obsidian",()=>({App:class{},Plugin:class{},TFile:class{},TFolder:class{},Notice:class{},Modal:class{},ItemView:class{},WorkspaceLeaf:class{},PluginSettingTab:class{},Setting:class{},Platform:{isDesktopApp:true},setIcon:vi.fn(),normalizePath:(s:string)=>s.replace(/\\/g,"/").replace(/\/{2,}/g,"/"),requestUrl:()=>{throw Error("No provider in recovery fixture");},parseYaml:JSON.parse,stringifyYaml:JSON.stringify}));
const ui = vi.hoisted(() => ({ host: undefined as import("../src/features/devices/modal").DeviceUiHost | undefined }));
vi.mock("../src/features/devices/modal", () => ({ DeviceSettingsModal: class { constructor(host: typeof ui.host) { ui.host = host; } open() {} }, DeviceCaptureModal: class {} }));
vi.mock("../src/features/summaries/service", () => ({ startSummarySchedule: vi.fn(async () => {}) }));
vi.mock("../src/features/review/reminders", () => ({ startStewardReminders: vi.fn() }));
vi.mock("../src/features/memory/summaryMemory", () => ({ startMemoryMaintenance: vi.fn(async () => {}) }));
const {createFsApp}=await import("./helpers/fsApp");const {DeviceCoordinator}=await import("../src/features/devices/coordinator");
const {DEFAULT_SETTINGS}=await import("../src/defaults");const {AgentRuntime}=await import("../src/agentRuntime");
const {DEVICE_WORKSPACE_PATH}=await import("../src/features/devices/execution");
const {factRecoveryPath,hasPendingFactOperation}=await import("../src/dataFoundation/factOperation");
const {operationFingerprint}=await import("../src/dataFoundation/operationLedger");
const {default:LifeOpsPlugin}=await import("../src/main");
import type {LocalDeviceState} from "../src/features/devices/execution";import type {StoreHost} from "../src/store/settingsSlice";
let root:string,bundleRoot:string,executable:string;
beforeAll(async()=>{bundleRoot=await mkdtemp(join(tmpdir(),"lifeops-device-setup-child-"));executable=join(bundleRoot,"child.mjs");await build({entryPoints:[resolve("tests/helpers/deviceSetupChild.ts")],outfile:executable,bundle:true,platform:"node",format:"esm",target:"node22",alias:{obsidian:resolve("tests/helpers/obsidianFileMock.ts")},logLevel:"silent"});});
afterAll(async()=>{await rm(bundleRoot,{recursive:true,force:true});});
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"lifeops-device-setup-recovery-"));await mkdir(join(root,"vault"));});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
function killed(phase:string){const child=spawnSync(process.execPath,[executable,root,phase],{encoding:"utf8",timeout:10000});expect(child.error).toBeUndefined();expect(child.signal,child.stderr).toBe("SIGKILL");}
async function reopen(){const localFile=join(root,"device-local.json"),settings=structuredClone(DEFAULT_SETTINGS),app=createFsApp(join(root,"vault"));const storage={load:()=>JSON.parse(fs.readFileSync(localFile,"utf8")),save:(value:LocalDeviceState)=>fs.writeFileSync(localFile,JSON.stringify(value))};const devices=new DeviceCoordinator(app,()=>settings,storage);await devices.execution.refresh();const store=devices.createStore() as unknown as StoreHost;return{app,settings,devices,store,runtime:new AgentRuntime({store,refreshViews:async()=>{}})};}
it.each(["before-policy","after-policy","after-audit","before-role"])("resumes first-party setup after an actual process kill at %s",async phase=>{
 killed(phase);const a=await reopen();expect(a.devices.execution.role).toBe("setup");
 await a.devices.chooseWriter(a.runtime);
 expect(a.devices.execution.canWriteFacts).toBe(true);expect(await hasPendingFactOperation(a.store)).toBe(false);
 const wire=JSON.parse(await readFile(join(root,"vault",DEVICE_WORKSPACE_PATH),"utf8"));expect(wire.executionDeviceId).toBe(a.devices.execution.deviceId);
 await a.store.initializeVault();const result=await a.runtime.executeToolCall({toolName:"create_task",arguments:{title:"纯虚构恢复后纸盒",date:"2066-01-05"},source:"system",callId:"fictional-device-after-recovery"});expect(result.success).toBe(true);
 expect((await a.store.readTaskDb()).tasks).toHaveLength(1);
});

async function snapshot() {
 const files=(await readdir(join(root,"vault"),{recursive:true,withFileTypes:true})).filter(row=>row.isFile());
 return Object.fromEntries(await Promise.all(files.map(async row=>{const path=join(row.parentPath,row.name);return[path,await readFile(path,"utf8")];})));
}
async function editJson(path:string,change:(value:any)=>void){const value=JSON.parse(await readFile(path,"utf8"));change(value);await writeFile(path,JSON.stringify(value));}

it.each(["foreign-device","changed-policy","changed-claim","extra-claim-argument","different-layout","business-journal","stopped"])("refuses %s without changing any fictional vault file or granting a role",async kind=>{
 killed("after-policy");
 if(kind==="foreign-device")await editJson(join(root,"device-local.json"),value=>{value.deviceId=randomUUID();});
 const a=await reopen(),journalPath=join(root,"vault",factRecoveryPath(a.store));
 if(kind==="changed-policy")await editJson(join(root,"vault",DEVICE_WORKSPACE_PATH),value=>{value.workspaceId=randomUUID();});
 if(kind==="changed-claim"||kind==="extra-claim-argument")await editJson(join(root,"vault",a.settings.folders.aiReports,"Operations/operation-ledger.json"),value=>{
  const row=value.records.find((row:any)=>row.toolName==="scheduled_configure_device_execution");
  if(kind==="changed-claim")row.arguments.executionDeviceId=randomUUID();else row.arguments.unexpected="fictional";
  row.fingerprint=operationFingerprint(row.toolName,row.arguments);
 });
 if(kind==="different-layout")a.settings.folders.tasks="纯虚构变更目录/任务";
 if(kind==="business-journal")await editJson(journalPath,value=>{value.entries[0].path=a.settings.folders.tasks+"/fictional.md";});
 if(kind==="stopped")a.devices.execution.stop();
 const before=await snapshot(),local=await readFile(join(root,"device-local.json"),"utf8");
 await expect(a.devices.chooseWriter(a.runtime)).rejects.toThrow();
 expect(await snapshot()).toEqual(before);expect(await readFile(join(root,"device-local.json"),"utf8")).toBe(local);
 expect(a.devices.execution.role).toBe("setup");expect(a.devices.execution.canWriteFacts).toBe(false);
});

it("keeps a later policy edit made during recovery intact and leaves the setup role unprivileged",async()=>{
 killed("after-policy");const a=await reopen(),processFile=a.app.vault.process.bind(a.app.vault);let changed=false;
 // Interleave an external edit at the first recovery journal update, before the guarded delete.
 a.app.vault.process=async(file,updater)=>{
  if(!changed&&file.path===factRecoveryPath(a.store)){changed=true;await editJson(join(root,"vault",DEVICE_WORKSPACE_PATH),value=>{value.workspaceId="11111111-1111-1111-1111-111111111111";});}
  return processFile(file,updater);
 };
 await expect(a.devices.chooseWriter(a.runtime)).rejects.toThrow();
 expect(changed).toBe(true);expect(JSON.parse(await readFile(join(root,"vault",DEVICE_WORKSPACE_PATH),"utf8")).workspaceId).toBe("11111111-1111-1111-1111-111111111111");
 expect(a.devices.execution.canWriteFacts).toBe(false);expect(await hasPendingFactOperation(a.store)).toBe(true);
});

it("refuses an externally removed policy after its audit has already finished",async()=>{
 killed("after-audit");const a=await reopen();await rm(join(root,"vault",DEVICE_WORKSPACE_PATH));
 const before=await snapshot();await expect(a.devices.chooseWriter(a.runtime)).rejects.toThrow();
 expect(await snapshot()).toEqual(before);expect(a.devices.execution.canWriteFacts).toBe(false);
});

it.each(["recovery-before-retain","recovery-after-retain"])("can resume again when the recovery itself is killed at %s",async phase=>{
 killed("after-policy");killed(phase);const a=await reopen();
 await a.devices.chooseWriter(a.runtime);
 expect(a.devices.execution.canWriteFacts).toBe(true);expect(await hasPendingFactOperation(a.store)).toBe(false);
 expect(JSON.parse(await readFile(join(root,"vault",DEVICE_WORKSPACE_PATH),"utf8")).executionDeviceId).toBe(a.devices.execution.deviceId);
});

it("reaches the narrow recovery through the production device-settings handler",async()=>{
 killed("before-policy");const a=await reopen();
 const bootstrap=vi.fn(async()=>{await a.store.initializeVault();}),refreshViews=vi.fn(async()=>{});
 const plugin=Object.assign(Object.create(LifeOpsPlugin.prototype),{app:a.app,devices:a.devices,settings:a.settings,store:a.store,
  activeProviderRequests:new Set(),createAgentRuntime:()=>a.runtime,proactiveLifecycle:{setEnabled:vi.fn()},
  bootstrapDataFoundation:bootstrap,refreshViews});
 plugin.openDeviceSettings();await ui.host!.chooseWriter();
 expect(bootstrap).toHaveBeenCalledOnce();expect(refreshViews).toHaveBeenCalledOnce();
 expect(a.devices.execution.canWriteFacts).toBe(true);expect(await hasPendingFactOperation(a.store)).toBe(false);
});
