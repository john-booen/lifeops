import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {DEFAULT_SETTINGS} from "../src/defaults";
import {BailianRealtimeClient} from "../src/bailianRealtime";
import {setTimeout as wallTimeout,clearTimeout as wallClear} from "node:timers";
const wallTasks=new Set<ReturnType<typeof wallTimeout>>();

const ws=vi.hoisted(()=>{
 class Socket {
  static OPEN=1;readyState=0;sent:any[]=[];handlers=new Map<string,Function[]>();
  constructor(){sockets.push(this);}
  on(n:string,f:Function){this.handlers.set(n,[...(this.handlers.get(n)||[]),f]);return this;}
  emit(n:string,...args:any[]){if(n==="open")this.readyState=1;if(n==="close")this.readyState=3;for(const f of this.handlers.get(n)||[])f(...args);}
  message(event:any){this.emit("message",JSON.stringify(event));}
  send(raw:string){const p=JSON.parse(raw);this.sent.push(p);if(p.type==="session.update")queueMicrotask(()=>this.message({type:"session.updated",session:p.session}));}
  close(){this.emit("close",1000,Buffer.alloc(0));}terminate(){this.readyState=3;}
 }
 const sockets:Socket[]=[];return{Socket,sockets};
});
vi.mock("ws",()=>({default:ws.Socket}));
let client:BailianRealtimeClient;
beforeEach(()=>{vi.useFakeTimers();const fakeSet=globalThis.setTimeout,fakeClear=globalThis.clearTimeout;vi.spyOn(globalThis,"setTimeout").mockImplementation(((callback:()=>void,delay?:number)=>{if(delay!==0)return Reflect.apply(fakeSet,globalThis,[callback,delay]);let handle:ReturnType<typeof wallTimeout>;handle=wallTimeout(()=>{wallTasks.delete(handle);callback();},0);wallTasks.add(handle);return handle;})as typeof setTimeout);vi.spyOn(globalThis,"clearTimeout").mockImplementation(((handle:ReturnType<typeof wallTimeout>)=>{if(wallTasks.delete(handle))wallClear(handle);else Reflect.apply(fakeClear,globalThis,[handle]);})as typeof clearTimeout);vi.stubGlobal("window",globalThis);vi.stubGlobal("fetch",()=>{throw Error("No external network");});ws.sockets.length=0;});
afterEach(()=>{client?.close();expect(wallTasks.size).toBe(0);vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
const flush=async()=>{for(let n=0;n<15;n++)await new Promise<void>(resolve=>wallTimeout(resolve,0));};
async function opened(callbacks:any){
 const runs:any[]=[];
 client=new BailianRealtimeClient({...DEFAULT_SETTINGS.realtimeVoice,mode:"omni-e2e",apiKey:"fictional-offline",dataDisclosureAccepted:true,plaintextCredentialStorageAccepted:true},{...callbacks,onProviderRun:e=>runs.push(e)});
 const connected=client.connect(),socket=ws.sockets.at(-1)!;socket.emit("open");await connected;await flush();
 return{socket,runs};
}
const creates=(s:InstanceType<typeof ws.Socket>)=>s.sent.filter(p=>p.type==="response.create");
const created=(id:string)=>({type:"response.created",response:{id}});
const done=(id:string,status="completed")=>({type:"response.done",response:{id,status}});
async function output(socket:InstanceType<typeof ws.Socket>,id:string,text:string){socket.message({type:"response.text.delta",response_id:id,delta:text});socket.message({type:"response.audio.delta",response_id:id,delta:"AQACAA=="});socket.message(done(id));await flush();}

it("retires ambiguous cancellation before another create and never publishes late old events",async()=>{
 const callbacks={onResponseCreated:vi.fn(),onResponseTextDelta:vi.fn(),onAudioDelta:vi.fn(),onResponseDone:vi.fn(),onTransportError:vi.fn(),onError:vi.fn()};
 const{socket,runs}=await opened(callbacks);client.createResponse();await flush();expect(creates(socket)).toHaveLength(1);
 client.cancelResponse();client.createResponse();await flush();await vi.advanceTimersByTimeAsync(1999);expect(socket.readyState).toBe(1);
 await vi.advanceTimersByTimeAsync(1);expect(socket.readyState).toBe(3);expect(creates(socket)).toHaveLength(1);expect(callbacks.onTransportError).toHaveBeenCalledOnce();expect(callbacks.onTransportError.mock.calls[0][0]).toContain("重说");
 socket.message(created("late-old"));await output(socket,"late-old","OLD_CANCELLED");socket.message(created("new-cannot-exist-on-old-socket"));await output(socket,"new-cannot-exist-on-old-socket","INVALID_NEW");
 for(const key of ["onResponseCreated","onResponseTextDelta","onAudioDelta","onResponseDone","onError"] as const)expect(callbacks[key]).not.toHaveBeenCalled();
 expect(runs.filter(e=>e.stage==="voice_response")).toHaveLength(1);expect(runs.find(e=>e.stage==="voice_response").run.status).toBe("cancelled");
});

it("keeps known-ID timeout continuation while rejecting old content",async()=>{
 const callbacks={onResponseTextDelta:vi.fn(),onAudioDelta:vi.fn(),onResponseDone:vi.fn(),onTransportError:vi.fn()};const{socket}=await opened(callbacks);
 client.createResponse();await flush();socket.message(created("known-old"));await flush();client.cancelResponse();client.createResponse();await vi.advanceTimersByTimeAsync(2000);await flush();
 expect(socket.readyState).toBe(1);expect(creates(socket)).toHaveLength(2);await output(socket,"known-old","OLD_CANCELLED");socket.message(created("new-owned"));await output(socket,"new-owned","NEW_REPLY");
 expect(callbacks.onResponseDone).toHaveBeenCalledOnce();expect(callbacks.onResponseDone.mock.calls[0][0]).toBe("NEW_REPLY");expect(callbacks.onAudioDelta).toHaveBeenCalledOnce();expect(callbacks.onTransportError).not.toHaveBeenCalled();
});

it("continues after the cancelled response is identified and acknowledged before timeout",async()=>{
 const callbacks={onResponseDone:vi.fn(),onTransportError:vi.fn()};const{socket}=await opened(callbacks);
 client.createResponse();await flush();client.cancelResponse();client.createResponse();socket.message(created("now-known-old"));socket.message(done("now-known-old","cancelled"));await flush();
 expect(creates(socket)).toHaveLength(2);expect(socket.readyState).toBe(1);socket.message(created("new-owned"));await output(socket,"new-owned","NEW_REPLY");await vi.advanceTimersByTimeAsync(2000);
 expect(callbacks.onResponseDone).toHaveBeenCalledOnce();expect(callbacks.onResponseDone.mock.calls[0][0]).toBe("NEW_REPLY");expect(callbacks.onTransportError).not.toHaveBeenCalled();
});

it.each(["disconnect","error"] as const)("reports ambiguous cancellation through the %s fallback once, with no timers revived by cleanup",async kind=>{
 const report=vi.fn(),callbacks=kind==="disconnect"?{onDisconnected:report}:{onError:report};const{socket}=await opened(callbacks);
 client.createResponse();await flush();client.cancelResponse();client.createResponse();await vi.advanceTimersByTimeAsync(2000);
 expect(socket.readyState).toBe(3);expect(report).toHaveBeenCalledOnce();client.cancelResponse();client.createResponse();await vi.advanceTimersByTimeAsync(12000);
 expect(report).toHaveBeenCalledOnce();expect(creates(socket)).toHaveLength(1);expect(vi.getTimerCount()).toBe(0);
});

it("does not treat a terminal frame without response identity as permission to reuse the ambiguous socket",async()=>{
 const onTransportError=vi.fn(),{socket}=await opened({onTransportError});client.createResponse();await flush();client.cancelResponse();client.createResponse();
 socket.message({type:"response.done",response:{status:"cancelled"}});await flush();expect(socket.readyState).toBe(3);expect(creates(socket)).toHaveLength(1);expect(onTransportError).toHaveBeenCalledOnce();
});
