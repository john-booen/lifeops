import {spawnSync} from "node:child_process";
import {mkdtemp,rm,writeFile,readFile,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {build} from "esbuild";
import type {App} from "obsidian";
import type {StoreHost} from "../src/store/settingsSlice";
import {beforeAll,afterAll,beforeEach,afterEach,it,expect,vi} from "vitest";
import {DEFAULT_SETTINGS} from "../src/defaults";
import {TRADING_MODEL_FIELDS,TRADING_CASE_FIELDS,type TradingCommand} from "../src/tradingResearch";
import {tradingDocumentPath} from "../src/dataFoundation/tradingPersistence";
vi.mock("obsidian",()=>({App:class{},TFile:class{},TFolder:class{},Notice:class{},normalizePath:(p:string)=>p.replace(/\\/g,"/").replace(/\/{2,}/g,"/")}));
const {LifeOpsStore}=await import("../src/store"),{DiskVault}=await import("./helpers/diskVault"),{AgentRuntime}=await import("../src/agentRuntime");
let bundleRoot:string,executable:string,root:string,store:StoreHost,vault:InstanceType<typeof DiskVault>;
beforeAll(async()=>{bundleRoot=await mkdtemp(join(tmpdir(),"lifeops-trading-child-"));executable=join(bundleRoot,"child.mjs");await build({entryPoints:[resolve("tests/helpers/tradingResearchChild.ts")],outfile:executable,bundle:true,platform:"node",format:"esm",target:"node22",alias:{obsidian:resolve("tests/helpers/obsidianFileMock.ts")},logLevel:"silent"});});
afterAll(async()=>{await rm(bundleRoot,{recursive:true,force:true});});
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"lifeops-trading-process-"));vault=new DiskVault(root);store=new LifeOpsStore({vault} as unknown as App,structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const run=(mode:string,phase="none")=>spawnSync(process.execPath,[executable,root,mode,phase],{encoding:"utf8",timeout:10000,killSignal:"SIGKILL"});
async function files(dir=root):Promise<Record<string,string>>{const output:Record<string,string>={};for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())Object.assign(output,await files(path));else output[path]=await readFile(path,"utf8");}return output;}
async function fixture(kind:"model"|"case"){
  const model={kind:"save_model",input:Object.fromEntries(TRADING_MODEL_FIELDS.map(key=>[key,key==="title"?"纯虚构进程规则":key==="entry"?"虚构条件":""]))} as unknown as TradingCommand;
  if(kind==="case"){const snapshot=await store.getTradingSnapshot(),operationId="local:fiction-original-model";const result=await new AgentRuntime({store,refreshViews:async()=>{}}).executeLocalOperation("fiction_seed",{model},s=>s.applyTradingCommand(model,snapshot.revision,operationId),operationId);expect(result.success,result.output).toBe(true);}
  const snapshot=await store.getTradingSnapshot(),command=kind==="model"?model:{kind:"save_case",input:Object.fromEntries(TRADING_CASE_FIELDS.map(key=>[key,key==="versionId"?snapshot.document.models[0].versions[0].id:key==="date"?"2026-10-04":key==="result"?"纯虚构样本结果":""]))} as TradingCommand;
  await writeFile(join(root,"fiction-command.json"),JSON.stringify({command,revision:snapshot.revision,operationId:`local:fiction-interrupted-${kind}`}),{flag:"wx"});return snapshot;
}
it.each(["model","case"] as const)("protects interrupted %s facts before audit, restores explicitly then saves exactly once",async kind=>{
  const before=await fixture(kind);expect(run("start","after-research").signal).toBe("SIGKILL");const pending=await files(),inspected=run("inspect");expect(inspected.status,inspected.stderr).toBe(0);expect(JSON.parse(inspected.stdout).readable).toBe(false);expect(await files()).toEqual(pending);
  const recovered=run("recover");expect(recovered.status,recovered.stderr).toBe(0);expect(JSON.parse(recovered.stdout).recovery).toBe("restored");expect((await store.getTradingSnapshot()).document).toEqual(before.document);
  const retry=run("start");expect(retry.status,retry.stderr+retry.stdout).toBe(0);const raw=await vault.bytes(tradingDocumentPath(store)),second=run("start");expect(second.status,second.stderr+second.stdout).toBe(0);expect(await vault.bytes(tradingDocumentPath(store))).toBe(raw);const snapshot=await store.getTradingSnapshot();expect(snapshot.document.models).toHaveLength(1);expect(snapshot.document.models[0].versions).toHaveLength(1);expect(snapshot.document.cases).toHaveLength(kind==="case"?1:0);
});
it.each(["after-audit","after-wal"])("keeps audited facts at %s without replaying versions or cases",async phase=>{
  await fixture("case");expect(run("start",phase).signal).toBe("SIGKILL");const raw=await vault.bytes(tradingDocumentPath(store)),inspection=run("inspect");expect(inspection.status,inspection.stderr).toBe(0);expect(JSON.parse(inspection.stdout).readable).toBe(phase==="after-wal");const recovery=run("recover");expect(recovery.status,recovery.stderr).toBe(0);expect(JSON.parse(recovery.stdout).recovery).toBe(phase==="after-wal"?"none":"kept");expect(run("start").status).toBe(0);expect(await vault.bytes(tradingDocumentPath(store))).toBe(raw);expect((await store.getTradingSnapshot()).document.cases).toHaveLength(1);
});
it("preserves an external handwritten conflict after actual kill and refuses to report it restored",async()=>{await fixture("case");expect(run("start","after-research").signal).toBe("SIGKILL");const path=tradingDocumentPath(store),document=JSON.parse(await vault.bytes(path));document.extension="外部冲突保留";const external=JSON.stringify(document);await vault.seed(path,external);const result=run("recover");expect(result.status).not.toBe(0);expect(await vault.bytes(path)).toBe(external);expect(JSON.parse(run("inspect").stdout).readable).toBe(false);});
