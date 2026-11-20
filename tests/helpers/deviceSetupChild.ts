import fs from "node:fs";
import { join } from "node:path";
import { DeviceCoordinator } from "../../src/features/devices/coordinator";
import { DEVICE_SETUP_OPERATION, DEVICE_WORKSPACE_PATH, type LocalDeviceState } from "../../src/features/devices/execution";
import { AgentRuntime } from "../../src/agentRuntime";
import { DEFAULT_SETTINGS } from "../../src/defaults";
import { decodeFactRecovery } from "../../src/dataFoundation/recoveryEncoding";
import { createFsApp } from "./fsApp";
import type { StoreHost } from "../../src/store/settingsSlice";
const [root, phase] = process.argv.slice(2);
const localFile=join(root,"device-local.json"),vaultRoot=join(root,"vault");
fs.mkdirSync(vaultRoot,{recursive:true});
const storage={load:()=>fs.existsSync(localFile)?JSON.parse(fs.readFileSync(localFile,"utf8")):null,
 save:(value:LocalDeviceState)=>{if(phase==="before-role"&&value.role==="writer")crash();fs.writeFileSync(localFile,JSON.stringify(value));}};
function crash():never{process.kill(process.pid,"SIGKILL");throw Error("Child did not stop");}
const app=createFsApp(vaultRoot),settings=structuredClone(DEFAULT_SETTINGS);
const devices=new DeviceCoordinator(app,()=>settings,storage);await devices.execution.refresh();
const store=devices.createStore() as unknown as StoreHost;
const create=app.vault.create.bind(app.vault),processFile=app.vault.process.bind(app.vault),renameFile=app.vault.rename.bind(app.vault);
const after=(path:string,text:string)=>{
 if(phase==="after-policy"&&path===DEVICE_WORKSPACE_PATH)crash();
 if(phase==="after-audit"&&path.endsWith("/Operations/operation-ledger.json")){
  const doc=JSON.parse(text);if(doc.records.some((row:{toolName:string;status:string})=>row.toolName===DEVICE_SETUP_OPERATION&&row.status==="verified"))crash();
 }
};
app.vault.create=async(path,text)=>{if(phase==="before-policy"&&path===DEVICE_WORKSPACE_PATH)crash();const file=await create(path,text);after(path,text);return file;};
app.vault.process=async(file,updater)=>{const next=await processFile(file,updater);after(file.path,next);return next;};
app.vault.rename=async(file,path)=>{
 if(file.path===DEVICE_WORKSPACE_PATH&&phase==="recovery-before-retain")crash();
 const original=file.path;await renameFile(file,path);
 if(original===DEVICE_WORKSPACE_PATH&&phase==="recovery-after-retain")crash();
};
await devices.chooseWriter(new AgentRuntime({store,refreshViews:async()=>{}}));
const journal=join(vaultRoot,store.settings.folders.aiReports,"Operations","write-recovery.json");
console.log(JSON.stringify({role:devices.execution.role,status:(decodeFactRecovery(JSON.parse(fs.readFileSync(journal,"utf8"))) as {status:string}).status}));
