import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {App} from "obsidian";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {DEFAULT_SETTINGS} from "../src/defaults";
import {BailianRealtimeClient} from "../src/bailianRealtime";
import type {StoreHost} from "../src/store/settingsSlice";
const ws=vi.hoisted(()=>{
 class Socket {
  static OPEN=1;readyState=0;sent:any[]=[];handlers=new Map<string,Function[]>();
  constructor(){sockets.push(this);}
  on(name:string,fn:Function){this.handlers.set(name,[...(this.handlers.get(name)??[]),fn]);return this;}
  emit(name:string,...args:any[]){if(name==="open")this.readyState=1;if(name==="close")this.readyState=3;for(const fn of this.handlers.get(name)??[])fn(...args);}
  message(value:unknown){this.emit("message",JSON.stringify(value));}
  send(value:string){this.sent.push(JSON.parse(value));}
  close(){this.emit("close",1000,Buffer.alloc(0));}terminate(){this.readyState=3;}
 }
 const sockets:Socket[]=[];return {Socket,sockets};
});
vi.mock("ws",()=>({default:ws.Socket}));
vi.mock("obsidian",()=>({App:class{},Plugin:class{},TFile:class{},TFolder:class{},WorkspaceLeaf:class{},ItemView:class{},Modal:class{},PluginSettingTab:class{},Setting:class{},Platform:{isDesktopApp:true},Notice:class{},normalizePath:(p:string)=>p.replace(/\\/g,"/").replace(/\/{2,}/g,"/"),setIcon:vi.fn(),requestUrl:()=>{throw Error("Offline test");}}));
const {LifeOpsStore}=await import("../src/store"),{DiskVault}=await import("./helpers/diskVault"),{default:Plugin}=await import("../src/main");
const {executeOmniE2eToolCall}=await import("../src/voice/voiceRealtime");
const {VoiceSessionController}=await import("../src/voice/voiceRuntime");
const {disposeRealtimeToolOutput,RealtimeToolOutputs}=await import("../src/voice/realtimeToolOutput");
const {finishOmniE2eVoiceTurn,handleOmniE2eResponseCreated}=await import("../src/voice/voiceRealtime");
const {settleCommittedOmniTool}=await import("../src/voice/voiceRealtime");
const {handleOmniE2eAudioDelta}=await import("../src/voice/voiceRealtime");
const {projectDocumentPath}=await import("../src/dataFoundation/projectPersistence");
const {emptyProjectDocument}=await import("../src/projectContinuity");
const {tradingDocumentPath,emptyTradingDocument}=await import("../src/tradingResearch");
let root:string,vault:InstanceType<typeof DiskVault>,store:StoreHost,plugin:any;
const clients:BailianRealtimeClient[]=[];
const looseOutputs:unknown[]=[];
const original="纯虚构待核对：蓝鲸在旧位置。",changed="纯虚构待核对：蓝鲸在新位置。";
const tool={id:"fiction-omni-query",name:"list_personal_memory_candidates",arguments:{}};
const tick=()=>new Promise<void>(yes=>setTimeout(yes,0));
const flush=async()=>{for(let i=0;i<8;i++)await tick();};
beforeEach(async()=>{
 vi.stubGlobal("window",globalThis);ws.sockets.length=0;
 root=await mkdtemp(join(tmpdir(),"lifeops-omni-output-"));vault=new DiskVault(root);
 const app={vault,workspace:{getLeavesOfType:()=>[]}}as unknown as App;
 store=new LifeOpsStore(app,structuredClone(DEFAULT_SETTINGS))as unknown as StoreHost;
 await store.initializeVault();await store.upsertPersonalMemory({kind:"current_state",content:original,sourceRefs:[]});
 plugin=Object.assign(Object.create(Plugin.prototype),{app,store,settings:store.settings,lifecycleGeneration:1,unloaded:false,updateStatusBar:async()=>{},refreshViews:async()=>{},lifeOpsEvents:{publish:()=>{}}});
});
afterEach(async()=>{clients.splice(0).forEach(client=>client.close());looseOutputs.splice(0).forEach(disposeRealtimeToolOutput);vi.restoreAllMocks();vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});});
async function change(){const doc=await store.readPersonalMemories();doc.records[0].content=changed;await vault.seed(store.personalMemoryPath(),JSON.stringify(doc));}
function view(transcript="请列出待确认记忆"){const runtime=new VoiceSessionController();runtime.connect();runtime.connected();runtime.beginTurn({route:"e2e",transcript});runtime.transitionTurn("routing","fiction");runtime.transitionTurn("generating","fiction");return {viewClosed:false,agentTextRequestGeneration:1,agentVoicePipelineGeneration:1,agentVoiceRuntime:runtime,controller:plugin,pendingAgentActions:[],agentOmniE2eReply:"",agentReply:"",agentOmniE2eAssistantIndex:-1,refreshAgentSuggestions:vi.fn()}as any;}
async function opened(onToolCall:any,options:any={},callbacks:any={}){
 const settings={...DEFAULT_SETTINGS.realtimeVoice,mode:"omni-e2e"as const,apiKey:"synthetic",dataDisclosureAccepted:true,plaintextCredentialStorageAccepted:true};
 const client=new BailianRealtimeClient(settings,{onToolCall,...callbacks},options);clients.push(client);
 const connected=client.connect(),socket=ws.sockets.at(-1)!;socket.emit("open");await connected;
 client.createResponse();socket.message({type:"response.created",response:{id:"fiction-planning"}});return {client,socket};
}
function call(socket:InstanceType<typeof ws.Socket>){socket.message({type:"response.function_call_arguments.done",response_id:"fiction-planning",call_id:tool.id,name:tool.name,arguments:"{}"});}
function planningDone(socket:InstanceType<typeof ws.Socket>){socket.message({type:"response.done",response:{id:"fiction-planning",status:"completed"}});}
const sent=(socket:InstanceType<typeof ws.Socket>,type:string)=>socket.sent.filter(event=>event.type===type);

async function queried(callbacks:any={},options:any={},transcript?:string){
 const host=view(transcript);const openedClient=await opened((call:any)=>executeOmniE2eToolCall(host,call,true),options,callbacks);
 host.agentRealtimeClient=openedClient.client;call(openedClient.socket);
 await vi.waitFor(()=>expect(sent(openedClient.socket,"conversation.item.create").some(event=>event.item?.type==="function_call_output")).toBe(true));
 return {...openedClient,host};
}
it("holds unchanged query data after tool send and after final completion until socket retirement",async()=>{
 const {client,socket}=await queried();planningDone(socket);
 await vi.waitFor(()=>expect(sent(socket,"response.create")).toHaveLength(2));
 socket.message({type:"response.created",response:{id:"fiction-answer"}});
 socket.message({type:"response.text.delta",response_id:"fiction-answer",delta:"纯虚构回复"});
 socket.message({type:"response.done",response:{id:"fiction-answer",status:"completed"}});
 await flush();expect(client.hasProtectedToolOutputs()).toBe(true);await client.assertToolOutputsCurrent();
 client.close();expect(client.hasProtectedToolOutputs()).toBe(false);
});
it.each(["cancel","close"])("disposes late returned capabilities after %s and never resumes a new response",async how=>{
 let release!:()=>void,returned!:()=>void;const host=view(),ready=new Promise<void>(yes=>returned=yes),gate=new Promise<void>(yes=>release=yes);
 const {client,socket}=await opened(async(call:any)=>{const output=await executeOmniE2eToolCall(host,call,true);returned();await gate;return output;});
 const on=vi.fn(()=>({})),offref=vi.fn();Object.assign(vault,{on,offref});call(socket);await ready;
 if(how==="cancel")client.cancelResponse();else client.close();release();await flush();
 expect(sent(socket,"conversation.item.create")).toHaveLength(0);expect(offref).toHaveBeenCalledTimes(on.mock.calls.length);
});
it("rejects a copied opaque result even when its visible text matches",async()=>{
 const onToolContextError=vi.fn(),host=view(),{socket}=await opened(async(call:any)=>{
  const output=await executeOmniE2eToolCall(host,call,true);looseOutputs.push(output);return {...output as object};
 },{}, {onToolContextError});call(socket);await vi.waitFor(()=>expect(onToolContextError).toHaveBeenCalledOnce());
 expect(sent(socket,"conversation.item.create")).toHaveLength(0);
});
function finishable(host:any){
 plugin.settings.realtimeVoice={...plugin.settings.realtimeVoice,mode:"omni-e2e",speakReplies:false};
 Object.assign(host,{agentRecording:true,agentMode:"voice",agentOmniE2eAssistantIndex:0,agentMessages:[{role:"assistant",content:"准备回复"}],agentOmniE2eStreamMessageEl:null,
  agentOmniE2eUserMessage:"请列出待核对记忆",agentVoiceTrace:{},agentOmniPendingAudio:[],agentOmniPlaybackReady:null,agentVoiceSendInFlight:true,
  voiceSession:{inputQueue:[]},markVoiceTrace:vi.fn(),setAgentBusy:vi.fn(),appendAgentQualityLog:vi.fn(async()=>{}),refreshAgentSurfaceState:vi.fn(),
  currentVoiceMessageText:()=>"",resetCurrentVoiceTurnDraft:vi.fn(),transitionVoiceSession:vi.fn()});return host;
}
it("writes a protected query's final quality row once when manual stop retires the socket",async()=>{
 const {host,client}=await queried();finishable(host);host.agentRecording=false;
 handleOmniE2eResponseCreated(host,{eventType:"response.created",responseId:"fiction-answer",status:"in_progress"});
 await finishOmniE2eVoiceTurn(host,"纯虚构完成");
 expect(host.appendAgentQualityLog).toHaveBeenCalledOnce();expect(client.hasProtectedToolOutputs()).toBe(false);
});
it("releases all real listeners if the handoff receiver rejects",async()=>{
 const on=vi.fn(()=>({})),offref=vi.fn();Object.assign(vault,{on,offref});
 await expect(plugin.executeAgentToolCall(tool,"请列出待确认记忆",()=>{},()=>{throw Error("fiction receiver stopped");})).rejects.toThrow("fiction receiver stopped");
 expect(offref).toHaveBeenCalledTimes(on.mock.calls.length);
});
it("cannot forge a committed write from a copied receipt object",async()=>{
 const onToolContextError=vi.fn(),onToolCommitted=vi.fn(),{socket}=await opened(()=>({text:"已保存",committed:true}),{}, {onToolContextError,onToolCommitted});
 call(socket);await vi.waitFor(()=>expect(onToolContextError).toHaveBeenCalledOnce());
 expect(onToolCommitted).not.toHaveBeenCalled();expect(sent(socket,"conversation.item.create")).toHaveLength(0);
});
it("preserves a newly committed real task, ends capture and emits only its private Runtime receipt",async()=>{
 const {host,client,socket}=await queried({}, {}, "请查询后创建任务：纯虚构语音回执任务");finishable(host);
 Object.assign(host,{clearVoiceWarmupTimer:vi.fn(),clearVoiceLocalEndpointTimer:vi.fn(),clearVoiceNoTranscriptTimer:vi.fn(),cleanupAgentMedia:vi.fn()});
 handleOmniE2eResponseCreated(host,{eventType:"response.created",responseId:"fiction-planning",status:"in_progress"});
 plugin.recordConversationMemory=vi.fn(async()=>{});let settled:Promise<void>|undefined;
 (client as any).callbacks.onToolCommitted=(text:string,response:any)=>{settled=settleCommittedOmniTool(host,text,response);};
 socket.message({type:"response.function_call_arguments.done",response_id:"fiction-planning",call_id:"fiction-real-save",name:"create_task",arguments:JSON.stringify({title:"纯虚构语音回执任务"})});
 await vi.waitFor(()=>expect(settled).toBeDefined());await settled;
 expect((await store.readTaskDb()).tasks.some(task=>task.title==="纯虚构语音回执任务")).toBe(true);
 expect(host.agentReply).toContain("纯虚构语音回执任务");expect(host.agentReply).not.toContain(original);
 expect(host.agentRecording).toBe(false);expect(host.cleanupAgentMedia).toHaveBeenCalledOnce();expect(host.agentRealtimeClient).toBeNull();
 expect(sent(socket,"response.create")).toHaveLength(1);expect(client.hasProtectedToolOutputs()).toBe(false);
 expect(host.transitionVoiceSession).toHaveBeenCalledWith("idle",expect.any(String));
});
it("keeps a protected query as text when native audio is absent without another TTS connection",async()=>{
 const {host}=await queried();finishable(host);plugin.settings.realtimeVoice.speakReplies=true;
 handleOmniE2eResponseCreated(host,{eventType:"response.created",responseId:"fiction-answer",status:"in_progress"});
 await finishOmniE2eVoiceTurn(host,"纯虚构已核对的文字回复");
 expect(ws.sockets).toHaveLength(1);expect(host.agentReply).toBe("纯虚构已核对的文字回复");expect(host.agentVoiceRuntime.snapshot().currentTurn.phase).toBe("completed");
});
it("bounds held actual source scopes and releases all listeners at retirement",async()=>{
 const on=vi.fn(()=>({})),offref=vi.fn();Object.assign(vault,{on,offref});const boundary=new RealtimeToolOutputs();
 for(let index=0;index<17;index++){
  let output:any;await plugin.executeAgentToolCall({...tool,id:`fiction-bounded-${index}`},"请查询待核对记忆",()=>{},(value:any)=>output=value);
  if(index<16)boundary.claim(output);else expect(()=>boundary.claim(output)).toThrow("范围已满");
 }
 boundary.dispose();expect(offref).toHaveBeenCalledTimes(on.mock.calls.length);
});
it("preserves a new turn when an old committed receipt's final auxiliary log fails late",async()=>{
 const {host,client,socket}=await queried({}, {}, "请查询后创建任务：纯虚构旧回执任务");finishable(host);
 handleOmniE2eResponseCreated(host,{eventType:"response.created",responseId:"fiction-planning",status:"in_progress"});
 Object.assign(host,{clearVoiceWarmupTimer:vi.fn(),clearVoiceLocalEndpointTimer:vi.fn(),clearVoiceNoTranscriptTimer:vi.fn(),cleanupAgentMedia:vi.fn()});
 plugin.recordConversationMemory=vi.fn(async()=>{});
 let reject!:(error:Error)=>void,logging!:()=>void,settled:Promise<void>|undefined;
 const entered=new Promise<void>(yes=>logging=yes),gate=new Promise<void>((_,no)=>reject=no);
 host.appendAgentQualityLog=vi.fn(()=>{logging();return gate;});
 (client as any).callbacks.onToolCommitted=(text:string,response:any)=>{settled=settleCommittedOmniTool(host,text,response);};
 socket.message({type:"response.function_call_arguments.done",response_id:"fiction-planning",call_id:"fiction-late-commit",name:"create_task",arguments:JSON.stringify({title:"纯虚构旧回执任务"})});
 await entered;const runtime=host.agentVoiceRuntime;runtime.connect();runtime.connected();runtime.beginTurn({route:"e2e",transcript:"纯虚构新的提问"});
 host.agentReply="纯虚构新回合回复";host.agentOmniE2eReply=host.agentReply;host.agentVoiceSendInFlight=true;host.agentRecording=true;
 const newClient={close:vi.fn()};host.agentRealtimeClient=newClient;host.setAgentBusy.mockClear();
 reject(Error("fiction old auxiliary log rejected"));await settled;
 expect(host.agentReply).toBe("纯虚构新回合回复");expect(host.agentOmniE2eReply).toBe("纯虚构新回合回复");
 expect(host.agentVoiceSendInFlight).toBe(true);expect(host.agentRecording).toBe(true);expect(host.agentRealtimeClient).toBe(newClient);expect(host.setAgentBusy).not.toHaveBeenCalled();
 expect((await store.readTaskDb()).tasks.filter(task=>task.title==="纯虚构旧回执任务")).toHaveLength(1);
});
it("allows a project's own unconfirmed observation while holding the original facts",async()=>{
 const host=view(),{client,socket}=await opened((call:any)=>executeOmniE2eToolCall(host,call,true));host.agentRealtimeClient=client;
 socket.message({type:"response.function_call_arguments.done",response_id:"fiction-planning",call_id:"fiction-project-observation",name:"query_projects",arguments:"{}"});
 await vi.waitFor(()=>expect(client.hasProtectedToolOutputs()).toBe(true));finishable(host);
 handleOmniE2eResponseCreated(host,{eventType:"response.created",responseId:"fiction-answer",status:"in_progress"});
 const observe=vi.spyOn(plugin,"recordConversationMemory").mockImplementation(async()=>{await store.upsertPersonalMemory({kind:"current_state",content:"纯虚构新观察候选"});});
 await finishOmniE2eVoiceTurn(host,"纯虚构项目查询完成");expect(observe).toHaveBeenCalledOnce();
 await client.assertToolOutputsCurrent();expect(host.agentVoiceRuntime.snapshot().currentTurn.phase).toBe("completed");
 expect((await store.readPersonalMemories()).records.every(record=>record.status!=="active")).toBe(true);
});
