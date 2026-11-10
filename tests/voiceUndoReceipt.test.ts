import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {App,TFile} from "obsidian";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {DEFAULT_SETTINGS} from "../src/defaults";
import type {StoreHost} from "../src/store/settingsSlice";
import {AgentRuntime,getCommittedContextEvidence,getCommittedTaskEvidence,hasCommittedToolReceipt} from "../src/agentRuntime";
import {OperationLedger} from "../src/dataFoundation/operationLedger";
import {factRecoveryPath} from "../src/dataFoundation/factOperation";
import {produceRealtimeToolOutput,RealtimeToolOutputs} from "../src/voice/realtimeToolOutput";
const ws=vi.hoisted(()=>{
 const sockets:any[]=[];
 class Socket {static OPEN=1;readyState=0;sent:any[]=[];handlers=new Map<string,Function[]>();constructor(){sockets.push(this);}on(name:string,fn:Function){this.handlers.set(name,[...(this.handlers.get(name)??[]),fn]);return this;}emit(name:string,...args:any[]){if(name==="open")this.readyState=1;if(name==="close")this.readyState=3;for(const fn of this.handlers.get(name)??[])fn(...args);}message(value:unknown){this.emit("message",JSON.stringify(value));}send(text:string){this.sent.push(JSON.parse(text));}close(){this.readyState=3;this.emit("close");}}
 return {Socket,sockets};
});
vi.mock("ws",()=>({default:ws.Socket}));
vi.mock("obsidian",()=>({App:class{},Plugin:class{},TFile:class{},TFolder:class{},WorkspaceLeaf:class{},ItemView:class{},Modal:class{open(){}},PluginSettingTab:class{},Setting:class{},Platform:{isDesktopApp:true},Notice:class{},normalizePath:(p:string)=>p.replace(/\\/g,"/").replace(/\/{2,}/g,"/"),setIcon:vi.fn(),requestUrl:()=>{throw Error("Offline voice undo test");}}));
const {LifeOpsStore}=await import("../src/store"),{DiskVault}=await import("./helpers/diskVault"),{default:Plugin}=await import("../src/main");
const {BailianRealtimeClient}=await import("../src/bailianRealtime"),{VoiceSessionController}=await import("../src/voice/voiceRuntime"),{executeOmniE2eToolCall}=await import("../src/voice/voiceRealtime");
let root:string,vault:InstanceType<typeof DiskVault>,store:StoreHost,runtime:AgentRuntime,plugin:any,taskId:string,before:string[],after:string[];
const originalCall="fiction-original-task",ownCall="fiction-voice-undo",clients:InstanceType<typeof BailianRealtimeClient>[]=[];
const readTasks=async()=>[await vault.bytes(store.taskDbPath()),await vault.bytes(store.taskMirrorPath())];
const audit=async(id:string)=>(await store.readJson<any>(new OperationLedger(store).filePath,{records:[]})).records.find((r:any)=>r.operationId===id);
const undo=(callId=ownCall)=>runtime.executeToolCall({toolName:"undo_latest_operation",arguments:{},source:"system",confirmedByUser:true,callId});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>resolve=yes);return {resolve,promise};};
beforeEach(async()=>{
 vi.stubGlobal("window",globalThis);ws.sockets.length=0;root=await mkdtemp(join(tmpdir(),"lifeops-voice-undo-"));vault=new DiskVault(root);const app={vault,workspace:{getLeavesOfType:()=>[]}}as unknown as App;store=new LifeOpsStore(app,structuredClone(DEFAULT_SETTINGS))as unknown as StoreHost;await store.initializeVault();
 plugin=Object.assign(Object.create(Plugin.prototype),{app,store,settings:store.settings,lifecycleGeneration:1,unloaded:false,refreshViews:async()=>{},updateStatusBar:async()=>{},lifeOpsEvents:{publish:()=>{}}});runtime=new AgentRuntime({store,refreshViews:async()=>{}});before=await readTasks();const saved=await runtime.executeToolCall({toolName:"create_task",arguments:{title:"纯虚构待撤销语音任务"},source:"system",confirmedByUser:true,callId:originalCall});expect(saved.success).toBe(true);taskId=(await store.readTaskDb()).tasks[0].id;after=await readTasks();
});
afterEach(async()=>{clients.splice(0).forEach(client=>client.close());vi.restoreAllMocks();vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});});
it("refuses a missing selected undo record without invoking restoration or changing real files",async()=>{
 const ledger=new OperationLedger(store),raw=await vault.bytes(ledger.filePath),restore=vi.fn(async()=>{});
 await expect(ledger.revert("fiction-missing-original",restore)).rejects.toThrow("未找到操作记录");
 expect(restore).not.toHaveBeenCalled();expect(await readTasks()).toEqual(after);expect(await vault.bytes(ledger.filePath)).toBe(raw);
});
it.each(["missing-claim","new-attempt","settled-claim","changed-arguments","failed-receipt"]as const)("refuses %s before touching the original undo or either audit",async kind=>{
 const ledger=new OperationLedger(store),claimed=await ledger.claim({operationId:ownCall,toolName:"undo_latest_operation",source:"system",arguments:{}}),claim=structuredClone(claimed.record);
 const document=JSON.parse(await vault.bytes(ledger.filePath)),own=document.records.find((record:any)=>record.operationId===ownCall);
 if(kind==="missing-claim")document.records=document.records.filter((record:any)=>record.operationId!==ownCall);
 else if(kind==="new-attempt")own.attempts++;
 else if(kind==="settled-claim")own.status="verified";
 else if(kind==="changed-arguments")own.arguments={unexpected:"纯虚构替换"};
 await vault.seed(ledger.filePath,JSON.stringify(document));const raw=await vault.bytes(ledger.filePath),restore=vi.fn(async()=>{});
 await expect(ledger.revert(originalCall,restore,{claim,result:{success:kind!=="failed-receipt",output:"纯虚构撤销回执",actions:[]}})).rejects.toThrow("执行记录发生变化");
 expect(restore).not.toHaveBeenCalled();expect(await readTasks()).toEqual(after);expect(await vault.bytes(ledger.filePath)).toBe(raw);expect((await audit(originalCall)).status).toBe("verified");
});
it("returns private reverse-file evidence and a local receipt only after both actual undo audits settle",async()=>{
 const result=await undo();expect(result.success).toBe(true);expect(await readTasks()).toEqual(before);expect((await audit(originalCall)).status).toBe("reverted");expect((await audit(ownCall)).status).toBe("verified");
 const evidence=getCommittedContextEvidence(result,store);expect(evidence).toBeDefined();expect(evidence!.files.map(file=>file.path)).toEqual(expect.arrayContaining([store.taskDbPath(),store.taskMirrorPath()]));expect(evidence!.files.every(file=>!file.path.includes("/Operations/"))).toBe(true);
 expect(evidence!.files.find(file=>file.path===store.taskDbPath())).toMatchObject({before:after[0],after:before[0]});expect(getCommittedTaskEvidence(result,store)).toBeUndefined();expect((await audit(ownCall)).result.undo).toBeUndefined();
 const owner=new RealtimeToolOutputs();expect(owner.claim(await produceRealtimeToolOutput(store,result,result.output)).committed).toBe(true);owner.dispose();const fresh=new LifeOpsStore(plugin.app,structuredClone(store.settings));expect((await fresh.readTaskDb()).tasks.some(task=>task.id===taskId)).toBe(false);
});
it("does not give a copied, cached or wrong-host undo receipt new source authority",async()=>{
 const result=await undo(),evidence=getCommittedContextEvidence(result,store);expect(evidence).toBeDefined();expect(getCommittedContextEvidence({...result},store)).toBeUndefined();expect(getCommittedContextEvidence(result,new LifeOpsStore(plugin.app,structuredClone(store.settings))as unknown as StoreHost)).toBeUndefined();
 evidence!.files[0].after="纯虚构伪造方向";expect(getCommittedContextEvidence(result,store)!.files[0].after).not.toBe("纯虚构伪造方向");const cached=await undo();expect(cached.success).toBe(true);expect(getCommittedContextEvidence(cached,store)).toBeUndefined();expect(await readTasks()).toEqual(before);
 const originalRetry=await runtime.executeToolCall({toolName:"create_task",arguments:{title:"纯虚构待撤销语音任务"},source:"system",confirmedByUser:true,callId:originalCall});expect(originalRetry.success).toBe(false);expect(await readTasks()).toEqual(before);
});
it.each([1,2])("inherits the actual async guard and rolls back if commit checkpoint %i rejects",async checkpoint=>{
 let checks=0;const result=await runtime.executeToolCall({toolName:"undo_latest_operation",arguments:{},source:"system",confirmedByUser:true,callId:ownCall},{assertCurrent:()=>{},assertBeforeCommit:async()=>{checks++;if(checks===checkpoint)throw Error("纯虚构原文提交前已变化");}});
 expect(result.success).toBe(false);expect(checks).toBe(checkpoint);expect(await readTasks()).toEqual(after);expect((await audit(originalCall)).status).toBe("verified");expect((await audit(ownCall)).status).toBe("failed");expect(getCommittedContextEvidence(result,store)).toBeUndefined();
 expect((await undo("fiction-retry-guard")).success).toBe(true);expect(await readTasks()).toEqual(before);
});
it.each(["business","audit"]as const)("restores actual files and both audits when cancelled after the %s write",async where=>{
 const entered=deferred(),release=deferred(),process=vault.process.bind(vault);let paused=false,closed=false;
 vi.spyOn(vault,"process").mockImplementation(async(file:TFile,updater)=>{const raw=await process(file,updater);const gate=where==="business"?file.path===store.taskMirrorPath():file.path===new OperationLedger(store).filePath&&JSON.parse(raw).records.some((record:any)=>record.operationId===originalCall&&record.status==="reverted");if(gate&&!paused){paused=true;entered.resolve();await release.promise;}return raw;});
 const pending=runtime.executeToolCall({toolName:"undo_latest_operation",arguments:{},source:"system",confirmedByUser:true,callId:ownCall},{assertCurrent:()=>{if(closed)throw Error("纯虚构停止");}});await entered.promise;closed=true;release.resolve();const result=await pending;
 expect(result.success).toBe(false);expect(await readTasks()).toEqual(after);expect((await audit(originalCall)).status).toBe("verified");expect((await audit(ownCall)).status).toBe("failed");expect(getCommittedContextEvidence(result,store)).toBeUndefined();expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("rolled_back");
 closed=false;expect((await undo()).success).toBe(true);expect(await readTasks()).toEqual(before);
});
it("keeps the private local success receipt when only the completed undo WAL tail fails",async()=>{
 const process=vault.process.bind(vault);let failed=false;vi.spyOn(vault,"process").mockImplementation(async(file:TFile,updater)=>{const next=updater(await vault.bytes(file.path));if(!failed&&file.path===factRecoveryPath(store)&&JSON.parse(next).operationId.startsWith("undo:")&&JSON.parse(next).status==="committed"){failed=true;throw Error("纯虚构尾WAL写失败");}return process(file,()=>next);});
 const result=await undo();expect(failed).toBe(true);expect(result.success).toBe(true);expect(await readTasks()).toEqual(before);expect(getCommittedContextEvidence(result,store)).toBeUndefined();expect(hasCommittedToolReceipt(result,store)).toBe(true);const owner=new RealtimeToolOutputs();expect(owner.claim(await produceRealtimeToolOutput(store,result,result.output)).committed).toBe(true);owner.dispose();expect((await audit(originalCall)).status).toBe("reverted");expect((await audit(ownCall)).status).toBe("verified");
});
it("does not claim a new undo if the selected original was already undone by another actual operation",async()=>{
 const latest=OperationLedger.prototype.latestReversible,entered=deferred(),release=deferred();vi.spyOn(OperationLedger.prototype,"latestReversible").mockImplementation(async function(this:OperationLedger){const record=await latest.call(this);entered.resolve();await release.promise;return record;});
 const pending=undo();await entered.promise;await runtime.undoOperation(originalCall);release.resolve();const result=await pending;expect(result.success).toBe(false);expect(getCommittedContextEvidence(result,store)).toBeUndefined();expect(await readTasks()).toEqual(before);expect((await audit(ownCall)).status).toBe("failed");
});
it.each(["missing","different"]as const)("keeps a tail-failure receipt private without context authority when WAL becomes %s",async replacement=>{
 const process=vault.process.bind(vault);let failed=false;
 vi.spyOn(vault,"process").mockImplementation(async(file:TFile,updater)=>{const next=updater(await vault.bytes(file.path));if(!failed&&file.path===factRecoveryPath(store)&&JSON.parse(next).operationId.startsWith("undo:")&&JSON.parse(next).status==="committed"){failed=true;throw Error("纯虚构尾写失败");}return process(file,()=>next);});
 runtime=new AgentRuntime({store,refreshViews:async()=>{if(failed){if(replacement==="missing")await vault.delete(store.getFile(factRecoveryPath(store))!);else await vault.seed(factRecoveryPath(store),JSON.stringify({version:1,operationId:"fiction-other-complete",status:"committed",entries:[]}));}}});
 const result=await undo();expect(result.success).toBe(true);expect(getCommittedContextEvidence(result,store)).toBeUndefined();expect(hasCommittedToolReceipt(result,store)).toBe(true);expect(hasCommittedToolReceipt({...result},store)).toBe(false);expect(await readTasks()).toEqual(before);
});
it("preserves only the actual local receipt if its optional postcommit Ledger read fails",async()=>{
 const read=store.readJson.bind(store);let failed=false;vi.spyOn(store,"readJson").mockImplementation(async(path:any,fallback:any)=>{
  const value=await read(path,fallback);if(!failed&&path===new OperationLedger(store).filePath){const own=(value as any).records?.find((record:any)=>record.operationId===ownCall);const raw=store.getFile(factRecoveryPath(store))?JSON.parse(await vault.bytes(factRecoveryPath(store))):null;if(own?.status==="verified"&&raw?.status==="committed"&&raw.undoToolOperationId===ownCall){failed=true;throw Error("纯虚构提交后读取失败");}}return value;
 });
 const result=await undo();expect(failed).toBe(true);expect(result.success).toBe(true);expect(getCommittedContextEvidence(result,store)).toBeUndefined();expect(hasCommittedToolReceipt(result,store)).toBe(true);expect(await readTasks()).toEqual(before);
});
it("fails an actual atomic undo audit write without leaving either original facts or false receipts changed",async()=>{
 const process=vault.process.bind(vault);let failed=false;vi.spyOn(vault,"process").mockImplementation(async(file:TFile,updater)=>{const next=updater(await vault.bytes(file.path));if(!failed&&file.path===new OperationLedger(store).filePath&&JSON.parse(next).records.some((record:any)=>record.operationId===ownCall&&record.status==="verified")){failed=true;throw Error("纯虚构原子审计写失败");}return process(file,()=>next);});
 const result=await undo();expect(failed).toBe(true);expect(result.success).toBe(false);expect(await readTasks()).toEqual(after);expect((await audit(originalCall)).status).toBe("verified");expect((await audit(ownCall)).status).toBe("failed");expect(hasCommittedToolReceipt(result,store)).toBe(false);expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("rolled_back");
 expect((await undo()).success).toBe(true);expect(await readTasks()).toEqual(before);
});
it.each(["original-id","ordinary-identity","changed-claim","invalid-release-phase"]as const)("rejects %s undo recovery metadata without changing actual files",async kind=>{
 await undo();const raw=await vault.bytes(factRecoveryPath(store)),document=JSON.parse(raw),{inspectFactRecovery}=await import("../src/dataFoundation/factOperation");
 if(kind==="original-id")document.undoToolOperationId=originalCall;else if(kind==="ordinary-identity")document.operationId="fiction-ordinary";else if(kind==="changed-claim")document.undoToolClaim.operationId="fiction-other-claim";else{document.rollbackComplete=true;document.rollbackRequired=true;}
 const current=await readTasks();expect(()=>inspectFactRecovery(store,JSON.stringify(document))).toThrow();expect(await readTasks()).toEqual(current);expect(await vault.bytes(factRecoveryPath(store))).toBe(raw);
});
it.each(["ordered","undo-first","failed-query","changed-source"])("uses the actual text host's current query before ordered undo: %s",async kind=>{
 const query={id:"fiction-prior-text-query",name:"query_vault",arguments:{domain:kind==="failed-query"?"unsupported-fictional-domain":"note",operation:"get",path:store.taskMirrorPath()}},revert={id:ownCall,name:"undo_latest_operation",arguments:{requirePriorQuery:true}},calls=kind==="undo-first"?[revert,query]:[query,revert];
 const afterQuery=async(call:any)=>{if(kind==="changed-source"&&call.name==="query_vault")await vault.seed(store.taskMirrorPath(),(await vault.bytes(store.taskMirrorPath()))+"\n纯虚构外部修改\n");};
 const result=await plugin.executeToolCalls(calls,"请查询后撤销上一步",undefined,undefined,afterQuery);
 if(kind==="failed-query")expect(result.results.find((r:any)=>r.callId===query.id).success).toBe(false);
 const undone=result.results.find((r:any)=>r.callId===ownCall);expect(undone.success,undone.output).toBe(kind==="ordered");
 if(kind==="ordered"){expect(await readTasks()).toEqual(before);expect((await audit(ownCall)).status).toBe("verified");}
 else {expect(await audit(ownCall)).toBeUndefined();expect((await audit(originalCall)).status).toBe("verified");expect((await readTasks())[0]).toBe(after[0]);if(kind==="changed-source")expect((await readTasks())[1]).toContain("纯虚构外部修改");else expect(await readTasks()).toEqual(after);}
});
it("does not undo first when the actual voice turn requests a query before undo",async()=>{
 const controller=new VoiceSessionController();controller.connect();controller.connected();controller.beginTurn({route:"e2e",transcript:"请查询后撤销上一步"});controller.transitionTurn("routing","fiction");controller.transitionTurn("generating","fiction");const host={viewClosed:false,agentTextRequestGeneration:1,agentVoicePipelineGeneration:1,agentVoiceRuntime:controller,controller:plugin,pendingAgentActions:[],agentOmniE2eReply:"",agentReply:"",agentOmniE2eAssistantIndex:-1,refreshAgentSuggestions:vi.fn()}as any;
 const client=new BailianRealtimeClient({...DEFAULT_SETTINGS.realtimeVoice,mode:"omni-e2e",apiKey:"synthetic",dataDisclosureAccepted:true,plaintextCredentialStorageAccepted:true},{onToolCall:call=>executeOmniE2eToolCall(host,call,true)});clients.push(client);host.agentRealtimeClient=client;const connection=client.connect(),socket=ws.sockets.at(-1)!;socket.emit("open");await connection;
 expect(client.hasProtectedToolOutputs()).toBe(false);
 const result=await executeOmniE2eToolCall(host,{id:ownCall,name:"undo_latest_operation",arguments:{requirePriorQuery:true}},true);
 expect(typeof result==="string"?result:result.text).toContain("本轮查询尚未成功核对");expect(await readTasks()).toEqual(after);expect(await audit(ownCall)).toBeUndefined();expect((await audit(originalCall)).status).toBe("verified");
});
it("does not reuse an earlier voice turn's successful query for a new query-then-undo request",async()=>{
 const controller=new VoiceSessionController();controller.connect();controller.connected();controller.beginTurn({route:"e2e",transcript:"请查询这篇纯虚构任务记录"});controller.transitionTurn("routing","fiction");controller.transitionTurn("generating","fiction");const host={viewClosed:false,agentTextRequestGeneration:1,agentVoicePipelineGeneration:1,agentVoiceRuntime:controller,controller:plugin,pendingAgentActions:[],agentOmniE2eReply:"",agentReply:"",agentOmniE2eAssistantIndex:-1,refreshAgentSuggestions:vi.fn()}as any;
 const client=new BailianRealtimeClient({...DEFAULT_SETTINGS.realtimeVoice,mode:"omni-e2e",apiKey:"synthetic",dataDisclosureAccepted:true,plaintextCredentialStorageAccepted:true},{onToolCall:call=>executeOmniE2eToolCall(host,call,true)});clients.push(client);host.agentRealtimeClient=client;const connection=client.connect(),socket=ws.sockets.at(-1)!;socket.emit("open");await connection;client.createResponse();socket.message({type:"response.created",response:{id:"fiction-prior-turn-query"}});
 socket.message({type:"response.function_call_arguments.done",response_id:"fiction-prior-turn-query",call_id:"fiction-prior-turn-read",name:"query_vault",arguments:JSON.stringify({domain:"note",operation:"get",path:store.taskMirrorPath()})});await vi.waitFor(()=>expect(client.hasProtectedToolOutputs()).toBe(true));
 controller.transitionTurn("completed","fiction-query-finished");controller.beginTurn({route:"e2e",transcript:"请查询后撤销上一步"});controller.transitionTurn("routing","fiction");controller.transitionTurn("generating","fiction");
 const result=await executeOmniE2eToolCall(host,{id:ownCall,name:"undo_latest_operation",arguments:{requirePriorQuery:true}},true);
 expect(typeof result==="string"?result:result.text).toContain("本轮查询尚未成功核对");expect(await readTasks()).toEqual(after);expect(await audit(ownCall)).toBeUndefined();expect((await audit(originalCall)).status).toBe("verified");
});
it.each(["normal","independent-source-after-admission"])("ends the actual client on its private undo receipt after a prior query, without another model request: %s",async kind=>{
 const queryPath=kind==="normal"?store.taskMirrorPath():"纯虚构独立查询笔记.md";
 if(kind!=="normal")await vault.seed(queryPath,"纯虚构原始资料");
 const controller=new VoiceSessionController();controller.connect();controller.connected();controller.beginTurn({route:"e2e",transcript:"请查询后撤销上一步"});controller.transitionTurn("routing","fiction");controller.transitionTurn("generating","fiction");const host={viewClosed:false,agentTextRequestGeneration:1,agentVoicePipelineGeneration:1,agentVoiceRuntime:controller,controller:plugin,pendingAgentActions:[],agentOmniE2eReply:"",agentReply:"",agentOmniE2eAssistantIndex:-1,refreshAgentSuggestions:vi.fn()}as any;
 const onToolCommitted=vi.fn(),onToolContextError=vi.fn();const client=new BailianRealtimeClient({...DEFAULT_SETTINGS.realtimeVoice,mode:"omni-e2e",apiKey:"synthetic",dataDisclosureAccepted:true,plaintextCredentialStorageAccepted:true},{onToolCall:call=>executeOmniE2eToolCall(host,call,true),onToolCommitted,onToolContextError});clients.push(client);host.agentRealtimeClient=client;const connection=client.connect(),socket=ws.sockets.at(-1)!;socket.emit("open");await connection;client.createResponse();socket.message({type:"response.created",response:{id:"fiction-planning"}});
 socket.message({type:"response.function_call_arguments.done",response_id:"fiction-planning",call_id:"fiction-query",name:"query_vault",arguments:JSON.stringify({domain:"note",operation:"get",path:queryPath})});await vi.waitFor(()=>expect(socket.sent.filter((event:any)=>event.item?.type==="function_call_output")).toHaveLength(1));expect(client.hasProtectedToolOutputs()).toBe(true);
 let changed=false;
 if(kind!=="normal"){const process=vault.process.bind(vault);vi.spyOn(vault,"process").mockImplementation(async(file:TFile,updater)=>{const next=await process(file,updater);if(!changed&&file.path===new OperationLedger(store).filePath&&JSON.parse(next).records.some((r:any)=>r.operationId===ownCall&&r.status==="executing")){changed=true;await vault.seed(queryPath,"纯虚构后来内容保留");}return next;});}
 socket.message({type:"response.function_call_arguments.done",response_id:"fiction-planning",call_id:ownCall,name:"undo_latest_operation",arguments:"{}"});await vi.waitFor(()=>expect(onToolCommitted).toHaveBeenCalledOnce());expect(onToolCommitted.mock.calls[0][0]).toContain("已撤销");expect(socket.readyState).toBe(3);expect(onToolContextError).not.toHaveBeenCalled();expect(socket.sent.filter((event:any)=>event.type==="response.create")).toHaveLength(1);expect(socket.sent.filter((event:any)=>event.item?.type==="function_call_output")).toHaveLength(1);expect(client.hasProtectedToolOutputs()).toBe(false);expect(await readTasks()).toEqual(before);
 if(kind!=="normal"){expect(changed).toBe(true);expect(await vault.bytes(queryPath)).toBe("纯虚构后来内容保留");}
});
