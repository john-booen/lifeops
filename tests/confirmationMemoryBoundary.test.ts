import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {App} from "obsidian";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {DEFAULT_SETTINGS} from "../src/defaults";
import {OperationLedger} from "../src/dataFoundation/operationLedger";
vi.mock("obsidian",()=>({App:class{},Plugin:class{},TFile:class{},TFolder:class{},WorkspaceLeaf:class{},ItemView:class{},Modal:class{open(){}},PluginSettingTab:class{},Setting:class{},Platform:{isDesktopApp:true},Notice:class{},normalizePath:(p:string)=>p.replace(/\\/g,"/").replace(/\/{2,}/g,"/"),setIcon:vi.fn(),requestUrl:()=>{throw Error("Offline test");}}));
const {LifeOpsStore}=await import("../src/store"),{DiskVault}=await import("./helpers/diskVault"),{default:Plugin}=await import("../src/main");
let root:string,store:any,plugin:any,memoryId:string;
const original="纯虚构原记忆",approved="纯虚构已经核对的内容",unapproved="纯虚构没有批准的替换内容";
beforeEach(async()=>{
 vi.stubGlobal("window",globalThis);root=await mkdtemp(join(tmpdir(),"lifeops-confirm-memory-"));const vault=new DiskVault(root),app={vault,workspace:{getLeavesOfType:()=>[]}}as unknown as App;store=new LifeOpsStore(app,structuredClone(DEFAULT_SETTINGS));await store.initializeVault();
 await store.upsertPersonalMemory({kind:"current_state",content:original,sourceRefs:[]});memoryId=(await store.readPersonalMemories()).records[0].id;
 plugin=Object.assign(Object.create(Plugin.prototype),{app,store,settings:store.settings,lifecycleGeneration:1,unloaded:false,updateStatusBar:async()=>{},refreshViews:async()=>{},lifeOpsEvents:{publish:()=>{}}});
});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});});
async function card(kind:"review"|"append"){
 if(kind==="append")return {id:"fiction-memory-legacy-append",type:"update_memory"as const,title:"批量整理保留的记忆卡",description:"确认后保存",content:approved,date:"2026-11-05",memoryFile:"当前状态.md"};
 const result=await plugin.executeAgentToolCall({id:`fiction-memory-${kind}`,name:"review_personal_memory",arguments:{memoryId,decision:"correct",correctedContent:approved}},"纯虚构明确记忆核对");expect(result.actions).toHaveLength(1);return result.actions[0];
}
function holdClaim(){
 const claim=OperationLedger.prototype.claim;let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(yes=>entered=yes),gate=new Promise<void>(yes=>release=yes);
 vi.spyOn(OperationLedger.prototype,"claim").mockImplementation(async function(this:OperationLedger,input){const result=await claim.call(this,input);if(input.operationId.startsWith("confirmed:")){entered();await gate;}return result;});return {ready,release};
}
it.each(["review","append"]as const)("keeps the exact already claimed %s content if its caller object changes during claim",async kind=>{
 const action=await card(kind),held=holdClaim(),pending=plugin.executeAgentAction(action);await held.ready;if(kind==="review")action.correctedMemoryContent=unapproved;else action.content=unapproved;held.release();await pending;
 const fresh=new LifeOpsStore(plugin.app,structuredClone(store.settings)),records=(await fresh.readPersonalMemories()).records;expect(records.some(record=>record.content===approved&&record.status==="active")).toBe(true);expect(records.some(record=>record.content===unapproved)).toBe(false);
});
it.each(["review","append"]as const)("does not save a %s confirmation after the actual Main lifecycle changes during claim",async kind=>{
 const action=await card(kind),before=await plugin.app.vault.bytes(store.personalMemoryPath()),held=holdClaim(),pending=plugin.executeAgentAction(action),rejected=expect(pending).rejects.toThrow(/停止|关闭|结束/);await held.ready;plugin.lifecycleGeneration++;held.release();await rejected;
 expect(await plugin.app.vault.bytes(store.personalMemoryPath())).toBe(before);const fresh=new LifeOpsStore(plugin.app,structuredClone(store.settings));expect((await fresh.readPersonalMemories()).records.some(record=>record.content===approved)).toBe(false);
});
it("normal explicit review saves once and can be read by a fresh Store",async()=>{
 const action=await card("review");await plugin.executeAgentAction(action);await plugin.executeAgentAction(action);const fresh=new LifeOpsStore(plugin.app,structuredClone(store.settings)),records=(await fresh.readPersonalMemories()).records;
 expect(records.filter(record=>record.id===memoryId&&record.content===approved&&record.status==="active")).toHaveLength(1);
});
it.each(["ordinary","mismatched-undo","derived-undo","other-operations"]as const)("does not open Operations writes or recovery to %s",async kind=>{
 const {runFactOperation,inspectFactRecovery,fileRevision}=await import("../src/dataFoundation/factOperation");
 const identity=kind==="ordinary"?{operationId:"ordinary-internal-test"}:{operationId:kind==="mismatched-undo"?"undo:different":"undo:approved",auditId:"approved",auditStatus:"reverted"as const,...(kind==="derived-undo"?{purpose:"derived"as const}:{})};
 const path=store.path(store.settings.folders.aiReports,"Operations",kind==="other-operations"?"another.json":"operation-ledger.json"),file=store.getFile(path),before=file?await plugin.app.vault.read(file):null;
 await expect(runFactOperation(store,identity,scope=>scope.writeFile(path,'{"version":1,"records":[]}'),async()=>{})).rejects.toThrow();
 expect(store.getFile(path)?await plugin.app.vault.read(store.getFile(path)):null).toBe(before);
 const after='{"version":1,"records":[]}';
 expect(()=>inspectFactRecovery(store,JSON.stringify({version:1,...identity,status:"pending",entries:[{path,before,after,beforeHash:fileRevision(before),afterHash:fileRevision(after)}]}))).toThrow();
});
