import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {App} from "obsidian";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {DEFAULT_SETTINGS} from "../src/defaults";
import {todayString} from "../src/date";
import {RealtimeInstructionsBoundary,type RealtimeInstructionsSnapshot} from "../src/voice/realtimeInstructionsBoundary";
import {BailianRealtimeClient} from "../src/bailianRealtime";
import type {StoreHost} from "../src/store/settingsSlice";
const ws=vi.hoisted(()=>{
 class Socket{
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
let root:string,vault:InstanceType<typeof DiskVault>,store:StoreHost,plugin:any,note:string;
const boundaries:RealtimeInstructionsBoundary[]=[],clients:BailianRealtimeClient[]=[],snapshots:RealtimeInstructionsSnapshot[]=[];
const original="纯虚构来源：蓝鲸在左边。",replacement="纯虚构来源：蓝鲸在右边。";
const flush=async()=>{for(let i=0;i<12;i++)await new Promise<void>(yes=>setTimeout(yes,0));};
beforeEach(async()=>{
 vi.stubGlobal("window",globalThis);ws.sockets.length=0;
 root=await mkdtemp(join(tmpdir(),"lifeops-instructions-raw-"));vault=new DiskVault(root);
 const app={vault,workspace:{getLeavesOfType:()=>[]}}as unknown as App;
 store=new LifeOpsStore(app,structuredClone(DEFAULT_SETTINGS))as unknown as StoreHost;await store.initializeVault();
 note=store.path(store.settings.folders.aiReports,"Conversations",`${todayString()}.md`);await vault.seed(note,original);
 // Model the real app's unchanged cached metadata while disk bytes change.
 // Actual source validation still reads the physical temporary file.
 const stat=structuredClone(vault.getFileByPath(note)!.stat),get=vault.getAbstractFileByPath.bind(vault);
 vi.spyOn(vault,"getAbstractFileByPath").mockImplementation(path=>{const file=get(path);if(file?.path===note)Object.assign(file,{stat:{...stat}});return file;});
 plugin=Object.assign(Object.create(Plugin.prototype),{app,store,settings:store.settings,lifecycleGeneration:1,unloaded:false,updateStatusBar:async()=>{},refreshViews:async()=>{}});
});
afterEach(async()=>{vi.useRealTimers();clients.splice(0).forEach(client=>client.close());boundaries.splice(0).forEach(boundary=>boundary.cancel());snapshots.splice(0).forEach(snapshot=>snapshot.dispose());vi.restoreAllMocks();vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});});
async function actual():Promise<RealtimeInstructionsSnapshot>{
 const snapshot = { instructions: original, baseInstructions: original, assertCurrent() {},
  async assertSourcesCurrent() { if (await vault.bytes(note) !== original) throw Error("source changed"); }, dispose() {} };
 snapshots.push(snapshot); return snapshot;
}
async function change(){await vault.seed(note,replacement);expect(await vault.bytes(note)).toBe(replacement);}
function immediate(snapshot:RealtimeInstructionsSnapshot,audit?:()=>Promise<void>){
 let boundary!:RealtimeInstructionsBoundary;const send=vi.fn((payload:any)=>boundary.acceptSessionEvent({type:"session.updated",session:payload.session}));
 boundary=new RealtimeInstructionsBoundary({prepare:async()=>snapshot,isCurrent:()=>true,send,audit});boundaries.push(boundary);return {boundary,send};
}
it("checks actual raw source before sending session.update",async()=>{
 const snapshot=await actual(),{boundary,send}=immediate(snapshot);await change();
 await expect(boundary.prepareForResponse(()=>true)).rejects.toMatchObject({code:"stale"});expect(send).not.toHaveBeenCalled();
});
it("checks actual raw source again after disclosure audit and before the wire send",async()=>{
 const snapshot=await actual(),{boundary,send}=immediate(snapshot,change);
 await expect(boundary.prepareForResponse(()=>true)).rejects.toMatchObject({code:"stale"});expect(send).not.toHaveBeenCalled();
});
it("checks actual raw source after the exact acknowledgement before returning the response token",async()=>{
 const snapshot=await actual();let boundary!:RealtimeInstructionsBoundary,wire:any;
 boundary=new RealtimeInstructionsBoundary({prepare:async()=>snapshot,isCurrent:()=>true,send:payload=>{wire=payload;}});boundaries.push(boundary);
 const pending=boundary.prepareForResponse(()=>true).catch(error=>error);await vi.waitFor(()=>expect(wire).toBeDefined());await change();
 boundary.acceptSessionEvent({type:"session.updated",session:wire.session});expect(await pending).toMatchObject({code:"stale"});
});
it("forwards the actual raw validator on the managed token",async()=>{
 const snapshot=await actual(),{boundary}=immediate(snapshot),token=await boundary.prepareForResponse(()=>true);await change();
 expect(()=>token.assertCurrent()).not.toThrow();expect(token.assertSourcesCurrent).toBeTypeOf("function");
 await expect(token.assertSourcesCurrent!()).rejects.toMatchObject({code:"stale"});token.dispose();
});
it("bounds the final token raw read and denies its late completion after release",async()=>{
 let release!:()=>void;const read=new Promise<void>(yes=>release=yes),dispose=vi.fn();let hang=false;
 const snapshot={instructions:"纯虚构资料",baseInstructions:"纯虚构底稿",assertCurrent(){},assertSourcesCurrent:()=>hang?read:Promise.resolve(),dispose};
 let boundary!:RealtimeInstructionsBoundary;
 boundary=new RealtimeInstructionsBoundary({timeoutMs:25,prepare:async()=>snapshot,isCurrent:()=>true,send:payload=>boundary.acceptSessionEvent({type:"session.updated",session:payload.session})});boundaries.push(boundary);
 const token=await boundary.prepareForResponse(()=>true);hang=true;expect(token.assertSourcesCurrent).toBeTypeOf("function");vi.useFakeTimers();
 const pending=token.assertSourcesCurrent!().catch(error=>error);await vi.advanceTimersByTimeAsync(25);expect(await pending).toMatchObject({code:"timeout"});
 token.dispose();release();await Promise.resolve();expect(dispose).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it("keeps the raw validator receiver and denies a changed owner after its await",async()=>{
 let release!:()=>void;const read=new Promise<void>(yes=>release=yes);let hang=false,current=true;
 const snapshot={instructions:"纯虚构资料",baseInstructions:"纯虚构底稿",assertCurrent(){},async assertSourcesCurrent(){expect(this).toBe(snapshot);if(hang)await read;},dispose:vi.fn()};
 const {boundary}=immediate(snapshot);const token=await boundary.prepareForResponse(()=>current);hang=true;expect(token.assertSourcesCurrent).toBeTypeOf("function");
 const pending=token.assertSourcesCurrent!().catch(error=>error);await Promise.resolve();current=false;release();expect(await pending).toMatchObject({code:"stale"});token.dispose();
});
it("actual client retires acknowledged stale instructions without response.create or ordinary fallback",async()=>{
 const onToolContextError=vi.fn(),onError=vi.fn();const settings={...DEFAULT_SETTINGS.realtimeVoice,mode:"omni-e2e"as const,apiKey:"synthetic",dataDisclosureAccepted:true,plaintextCredentialStorageAccepted:true};
 const client=new BailianRealtimeClient(settings,{onToolContextError,onError},{mode:"omni-e2e",prepareInstructions:()=>actual()});clients.push(client);
 const connected=client.connect(),socket=ws.sockets.at(-1)!;socket.emit("open");await connected;client.createResponse();
 await vi.waitFor(()=>expect(socket.sent.filter(x=>x.type==="session.update")).toHaveLength(2));const wire=socket.sent.at(-1);
 await change();socket.message({type:"session.updated",session:wire.session});await flush();
 expect(onToolContextError).toHaveBeenCalledOnce();expect(onError).not.toHaveBeenCalled();expect(socket.readyState).toBe(3);expect(socket.sent.filter(x=>x.type==="response.create")).toHaveLength(0);
});
it.each(["before-wire","after-ack"])("cancels %s raw validation and releases a late snapshot without sending a response",async phase=>{
 let release!:()=>void;const read=new Promise<void>(yes=>release=yes),dispose=vi.fn();let count=0,entered=false;
 const snapshot={instructions:"纯虚构资料",baseInstructions:"纯虚构底稿",assertCurrent(){},async assertSourcesCurrent(){if(++count===(phase==="before-wire"?1:3)){entered=true;await read;}},dispose};
 let boundary!:RealtimeInstructionsBoundary;const send=vi.fn((payload:any)=>boundary.acceptSessionEvent({type:"session.updated",session:payload.session}));
 boundary=new RealtimeInstructionsBoundary({prepare:async()=>snapshot,isCurrent:()=>true,send});boundaries.push(boundary);
 const pending=boundary.prepareForResponse(()=>true).catch(error=>error);await vi.waitFor(()=>expect(entered).toBe(true));boundary.cancel();
 expect(await pending).toMatchObject({code:"cancelled"});expect(dispose).toHaveBeenCalledOnce();release();await flush();expect(send).toHaveBeenCalledTimes(phase==="before-wire"?0:1);
});
it("actual client rechecks raw source at the last handoff before response.create",async()=>{
 const source=await actual();let count=0;const prepared={...source,async assertSourcesCurrent(){if(++count===4)await change();await source.assertSourcesCurrent!();}};
 const onToolContextError=vi.fn(),onError=vi.fn(),settings={...DEFAULT_SETTINGS.realtimeVoice,mode:"omni-e2e"as const,apiKey:"synthetic",dataDisclosureAccepted:true,plaintextCredentialStorageAccepted:true};
 const client=new BailianRealtimeClient(settings,{onToolContextError,onError},{mode:"omni-e2e",prepareInstructions:async()=>prepared});clients.push(client);
 const connected=client.connect(),socket=ws.sockets.at(-1)!;socket.emit("open");await connected;client.createResponse();
 await vi.waitFor(()=>expect(socket.sent.filter(x=>x.type==="session.update")).toHaveLength(2));socket.message({type:"session.updated",session:socket.sent.at(-1).session});
 await vi.waitFor(()=>expect(onToolContextError).toHaveBeenCalledOnce());expect(count).toBe(4);expect(onError).not.toHaveBeenCalled();expect(socket.readyState).toBe(3);expect(socket.sent.filter(x=>x.type==="response.create")).toHaveLength(0);
});
it("actual client cancellation rejects a late final raw handoff without publishing or reporting a failure",async()=>{
 const source=await actual();let count=0,entered=false,release!:()=>void;const read=new Promise<void>(yes=>release=yes),dispose=vi.fn(()=>source.dispose());
 const prepared={...source,dispose,async assertSourcesCurrent(){if(++count===4){entered=true;await read;}await source.assertSourcesCurrent!();}};
 const onToolContextError=vi.fn(),onError=vi.fn(),settings={...DEFAULT_SETTINGS.realtimeVoice,mode:"omni-e2e"as const,apiKey:"synthetic",dataDisclosureAccepted:true,plaintextCredentialStorageAccepted:true};
 const client=new BailianRealtimeClient(settings,{onToolContextError,onError},{mode:"omni-e2e",prepareInstructions:async()=>prepared});clients.push(client);
 const connected=client.connect(),socket=ws.sockets.at(-1)!;socket.emit("open");await connected;client.createResponse();
 await vi.waitFor(()=>expect(socket.sent.filter(x=>x.type==="session.update")).toHaveLength(2));socket.message({type:"session.updated",session:socket.sent.at(-1).session});
 await vi.waitFor(()=>expect(entered).toBe(true));client.cancelResponse();release();await vi.waitFor(()=>expect(dispose).toHaveBeenCalledOnce());
 expect(onToolContextError).not.toHaveBeenCalled();expect(onError).not.toHaveBeenCalled();expect(socket.sent.filter(x=>x.type==="response.create")).toHaveLength(0);
});
