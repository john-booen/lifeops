import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {DEFAULT_SETTINGS} from "../src/defaults";
import {BailianRealtimeClient} from "../src/bailianRealtime";
import type {RealtimeInstructionsSnapshot} from "../src/voice/realtimeInstructionsBoundary";
import {VoiceSessionController} from "../src/voice/voiceRuntime";
const ws = vi.hoisted(() => {
  class Socket {
    static OPEN = 1; static CLOSED = 3; readyState = 0; sent: any[] = []; handlers = new Map<string, Function[]>();
    constructor(){sockets.push(this);}
    on(name:string,fn:Function){this.handlers.set(name,[...(this.handlers.get(name)??[]),fn]);return this;}
    emit(name:string,...args:any[]){if(name === "open")this.readyState=1;if(name === "close")this.readyState=3;for(const fn of this.handlers.get(name)??[])fn(...args);}
    message(event:unknown){this.emit("message",JSON.stringify(event));}
    send(value: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(value)); callback?.(); }
    close(){this.emit("close",1000,Buffer.alloc(0));} terminate(){this.readyState=3;}
  }
  const sockets:Socket[]=[];return {Socket,sockets};
});
vi.mock("ws",()=>({default:ws.Socket}));
const settings={...DEFAULT_SETTINGS.realtimeVoice,mode:"omni-e2e" as const,apiKey:"synthetic",dataDisclosureAccepted:true,plaintextCredentialStorageAccepted:true};
const pcm=Buffer.from(new Int16Array([12,-12]).buffer).toString("base64");
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const requests=(socket:InstanceType<typeof ws.Socket>,type:string)=>socket.sent.filter(event=>event.type===type);
const acknowledge=(socket:InstanceType<typeof ws.Socket>)=>socket.message({type:"session.updated",session:{instructions:requests(socket,"session.update").at(-1).session.instructions}});
const snapshot=(label:string,expiresAt?:number):RealtimeInstructionsSnapshot=>({instructions:`纯虚构当前观察${label}`,baseInstructions:"纯虚构非视觉底座",expiresAt,
  assertCurrent:()=>{if(expiresAt!==undefined&&Date.now()>=expiresAt)throw Error("expired");},dispose:vi.fn()});
beforeEach(()=>{vi.useFakeTimers();ws.sockets.length=0;vi.stubGlobal("window",globalThis);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
async function opened(prepare:()=>Promise<RealtimeInstructionsSnapshot>,callbacks:any={}){
  const client=new BailianRealtimeClient(settings,callbacks,{prepareInstructions:prepare,instructions:"纯虚构非视觉底座"});
  const connected=client.connect(),socket=ws.sockets.at(-1)!;socket.emit("open");await connected;
  socket.message({type:"session.updated",session:{instructions:"纯虚构非视觉底座"}});return {client,socket};
}

describe("production response.create always crosses the context acknowledgement barrier",()=>{
  it("blocks duplicate first requests until the precise current instruction echo",async()=>{
    const scope=snapshot("首轮"),{client,socket}=await opened(async()=>scope);
    client.createResponse();client.createResponse();await flush();
    expect(requests(socket,"response.create")).toHaveLength(0);expect(requests(socket,"session.update")).toHaveLength(2);
    socket.message({type:"session.updated",session:{instructions:"旧确认"}});await flush();expect(requests(socket,"response.create")).toHaveLength(0);
    acknowledge(socket);await flush();expect(requests(socket,"response.create")).toHaveLength(1);expect(scope.dispose).toHaveBeenCalledOnce();client.close();
  });
  it("cancels pending local preparation without cancelling a server response that never existed",async()=>{
    let resolve!:(value:RealtimeInstructionsSnapshot)=>void;const scope=snapshot("迟到");
    const {client,socket}=await opened(()=>new Promise<RealtimeInstructionsSnapshot>(yes=>resolve=yes));
    client.createResponse();await flush();client.cancelResponse();resolve(scope);await flush();
    expect(requests(socket,"response.create")).toHaveLength(0);expect(requests(socket,"response.cancel")).toHaveLength(0);
    expect(requests(socket,"session.update")).toHaveLength(1);expect(scope.dispose).toHaveBeenCalledOnce();client.close();
  });
  it("cannot send after close or use a late acknowledgement",async()=>{
    const {client,socket}=await opened(async()=>snapshot("停止"));client.createResponse();await flush();
    const ack=requests(socket,"session.update").at(-1).session.instructions;client.close();
    socket.message({type:"session.updated",session:{instructions:ack}});await flush();expect(requests(socket,"response.create")).toHaveLength(0);
  });
  it("fails closed on expiry during acknowledgement and keeps PCM and transcription available",async()=>{
    const onError=vi.fn(),onTranscriptDone=vi.fn(),{client,socket}=await opened(async()=>snapshot("过期",Date.now()+100),{onError,onTranscriptDone});
    client.createResponse();await flush();await vi.advanceTimersByTimeAsync(100);acknowledge(socket);await flush();
    expect(requests(socket,"response.create")).toHaveLength(0);expect(onError).toHaveBeenCalledOnce();
    client.appendPcm16(pcm);socket.message({type:"conversation.item.input_audio_transcription.completed",item_id:"synthetic-asr",transcript:"纯虚构仍保留的输入"});
    expect(requests(socket,"input_audio_buffer.append")).toHaveLength(1);expect(onTranscriptDone).toHaveBeenCalledWith("纯虚构仍保留的输入");
    expect(requests(socket,"input_audio_buffer.clear")).toHaveLength(0);expect(socket.readyState).toBe(1);client.close();
  });
  it("refreshes the tool continuation at the common production response gate",async()=>{
    let count=0;const {client,socket}=await opened(async()=>snapshot(String(++count)),{onToolCall:async()=>"纯虚构工具结果"});
    client.createResponse();await flush();acknowledge(socket);await flush();
    socket.message({type:"response.created",response:{id:"tool-source"}});
    socket.message({type:"response.function_call_arguments.done",response_id:"tool-source",call_id:"synthetic-call",name:"query_vault",arguments:"{}"});
    socket.message({type:"response.done",response:{id:"tool-source",status:"completed"}});await flush();
    expect(count).toBe(2);expect(requests(socket,"response.create")).toHaveLength(1);
    acknowledge(socket);await flush();expect(requests(socket,"response.create")).toHaveLength(2);client.close();
  });
  it("refreshes a queued response instead of reusing the preceding snapshot",async()=>{
    let count=0;const {client,socket}=await opened(async()=>snapshot(String(++count)));
    client.createResponse();await flush();acknowledge(socket);await flush();socket.message({type:"response.created",response:{id:"first"}});
    client.createResponse();socket.message({type:"response.text.delta",response_id:"first",delta:"纯虚构已完成"});
    socket.message({type:"response.done",response:{id:"first",status:"completed"}});await flush();
    expect(count).toBe(2);expect(requests(socket,"response.create")).toHaveLength(1);acknowledge(socket);await flush();
    expect(requests(socket,"response.create")).toHaveLength(2);client.close();
  });
  it("refreshes model retries instead of reusing the failed attempt's context",async()=>{
    let count=0;const {client,socket}=await opened(async()=>snapshot(String(++count)));
    client.createResponse();await flush();acknowledge(socket);await flush();
    socket.message({type:"error",error:{message:"ModelServingError"}});await vi.advanceTimersByTimeAsync(500);await flush();
    expect(count).toBe(2);expect(requests(socket,"response.create")).toHaveLength(1);acknowledge(socket);await flush();
    expect(requests(socket,"response.create")).toHaveLength(2);client.close();
  });
  it("removes an expired live slot while input continues without a new response or audio reset",async()=>{
    const {client,socket}=await opened(async()=>snapshot("短期",Date.now()+1000));
    client.createResponse();await flush();acknowledge(socket);await flush();
    socket.message({type:"response.created",response:{id:"playing"}});client.appendPcm16(pcm);
    await vi.advanceTimersByTimeAsync(1000);await flush();
    expect(requests(socket,"session.update").at(-1).session.instructions).toContain("纯虚构非视觉底座");
    expect(requests(socket,"session.update").at(-1).session.instructions).not.toContain("纯虚构当前观察");
    acknowledge(socket);await flush();client.appendPcm16(pcm);
    expect(requests(socket,"response.create")).toHaveLength(1);expect(requests(socket,"response.cancel")).toHaveLength(0);
    expect(requests(socket,"input_audio_buffer.clear")).toHaveLength(0);expect(requests(socket,"input_audio_buffer.commit")).toHaveLength(0);
    expect(requests(socket,"input_audio_buffer.append")).toHaveLength(2);expect(socket.readyState).toBe(1);client.close();
  });
});
