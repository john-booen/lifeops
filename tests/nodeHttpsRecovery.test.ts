import {EventEmitter} from "node:events";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {requestUrl} from "obsidian";
import {request} from "node:https";
import {DEFAULT_SETTINGS} from "../src/defaults";
import {LifeOpsAi} from "../src/ai";
import {nodeHttpsText} from "../src/nodeHttpsText";
import {normalizeQualityLogEntry} from "../src/qualityLog";
vi.mock("obsidian",()=>({requestUrl:vi.fn()}));vi.mock("node:https",()=>({request:vi.fn()}));
let serve:(res:EventEmitter&{statusCode:number;complete:boolean;resume:()=>void;destroy:()=>void})=>void;
let destroyed=vi.fn<()=>void>(),sent=vi.fn<(body:string)=>void>();
const response={model:"synthetic",choices:[{finish_reason:"stop",message:{content:"纯虚构独立连接已恢复"}}]};
beforeEach(()=>{
 vi.mocked(requestUrl).mockReset();vi.mocked(request).mockReset();destroyed=vi.fn();sent=vi.fn();
 serve=res=>{res.emit("data",Buffer.from(JSON.stringify(response)));res.emit("end");};
 vi.mocked(request).mockImplementation(((_url:unknown,_options:unknown,callback:(res:any)=>void)=>{
  const req=Object.assign(new EventEmitter(),{destroy:destroyed,end:(body:string)=>{sent(body);queueMicrotask(()=>{const res=Object.assign(new EventEmitter(),{statusCode:200,complete:true,resume:vi.fn(),destroy:vi.fn()});callback(res);serve(res);});}});return req;
 }) as never);
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
function configured(){const s=structuredClone(DEFAULT_SETTINGS);s.privacy={...s.privacy,plaintextCredentialStorageAccepted:true,excludedVaultPrefixes:[]};Object.assign(s.ai,{provider:"synthetic",model:"synthetic",endpoint:"https://fiction.invalid/v1/chat",apiKey:"fictional-key",dataDisclosureAccepted:true,fallbackProvider:"off"});return s;}
it("recovers Chromium connection closure through a fresh TLS request to the exact same configured endpoint",async()=>{
 vi.mocked(requestUrl).mockRejectedValue(new Error("net::ERR_CONNECTION_CLOSED"));const audits:any[]=[];
 const r=await new LifeOpsAi(configured()).agentReply("纯虚构上下文","虚构问题",[],"text",{onRequestAudit:a=>{audits.push(a);}});
 expect(r.content).toBe(response.choices[0].message.content);expect(requestUrl).toHaveBeenCalledOnce();expect(request).toHaveBeenCalledOnce();
 const [url,options]=vi.mocked(request).mock.calls[0] as any;expect(url.href).toBe("https://fiction.invalid/v1/chat");
 expect(options.headers.Authorization).toBe("Bearer fictional-key");expect(options.agent).toBe(false);expect(options.rejectUnauthorized).not.toBe(false);
 expect(sent.mock.calls[0][0]).toBe((vi.mocked(requestUrl).mock.calls[0][0] as {body:string}).body);
 expect(r.providerRun?.attempts[0].transport).toBe("node_https");expect(audits.map(a=>a.transport)).toEqual(["request_url","node_https"]);
 expect(normalizeQualityLogEntry({providerRuns:[r.providerRun!]}).providerRuns![0].attempts[0].transport).toBe("node_https");
});
it.each([new Error("net::ERR_NAME_NOT_RESOLVED"),new TypeError("Failed to fetch"),new Error("private message mentioning ERR_CONNECTION_CLOSED")])("does not switch to an independent transport without exact connection-close evidence",async error=>{
 vi.mocked(requestUrl).mockRejectedValue(error);const abort=new AbortController();
 // An immediate cancellation bounds the existing DNS recovery timer in this refusal test.
 const pending=new LifeOpsAi(configured()).agentReply("虚构","虚构",[],"text",{signal:abort.signal}).catch(e=>e);
 await Promise.resolve();abort.abort();await pending;expect(request).not.toHaveBeenCalled();
});
it("does not follow an HTTP redirect or forward credentials to another host",async()=>{
 serve=()=>{};vi.mocked(request).mockImplementation(((_url:unknown,_options:unknown,cb:(r:any)=>void)=>{
  const req=Object.assign(new EventEmitter(),{destroy:destroyed,end:()=>queueMicrotask(()=>cb({statusCode:302,resume:vi.fn()}))});return req;
 }) as never);
 const r=await nodeHttpsText("https://fiction.invalid",{Authorization:"Bearer fictional-key"},"{}",undefined,1000);
 expect(r.status).toBe(302);expect(request).toHaveBeenCalledOnce();
});
it("does not repeat a request on a partial answer even when an alternate provider is configured",async()=>{
 vi.mocked(requestUrl).mockRejectedValue(new Error("net::ERR_CONNECTION_RESET"));serve=res=>{res.emit("data",Buffer.from('{"choices":['));res.complete=false;res.emit("aborted");};
 const s=configured();Object.assign(s.ai,{fallbackProvider:"deepseek",fallbackEndpoint:"https://alternate.invalid",fallbackApiKey:"fictional-second-key",fallbackModel:"synthetic-2"});
 await expect(new LifeOpsAi(s).agentReply("虚构","虚构")).rejects.toMatchObject({code:"response_incomplete"});
 expect(requestUrl).toHaveBeenCalledOnce();expect(request).toHaveBeenCalledOnce();
});
it("aborts a pending independent request when the user cancels",async()=>{
 serve=()=>{};const abort=new AbortController();const pending=nodeHttpsText("https://fiction.invalid",{},"{}",abort.signal,1000).catch(e=>e);
 await Promise.resolve();abort.abort();expect((await pending).name).toBe("AbortError");expect(destroyed).toHaveBeenCalledOnce();
});
it("refuses an expired deadline before sending anything",()=>{
 expect(()=>nodeHttpsText("https://fiction.invalid",{},"{}",undefined,0)).toThrow("超时");expect(request).not.toHaveBeenCalled();
});
it("rechecks source validity before the independent connection and sends nothing after it changes",async()=>{
 vi.mocked(requestUrl).mockRejectedValue(new Error("net::ERR_CONNECTION_CLOSED"));let checks=0;
 await expect(new LifeOpsAi(configured()).agentReply("虚构","虚构",[],"text",{assertTextRequestCurrent:()=>{if(++checks>2)throw Error("source changed");}})).rejects.toMatchObject({name:"AbortError"});
 expect(request).not.toHaveBeenCalled();
});
it("does not switch provider or transport after streaming answer text has already arrived",async()=>{
 let pull=0;const fetch=vi.fn(async()=>new Response(new ReadableStream({pull(controller){
  if(pull++===0)controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{index:0,delta:{content:"纯虚构半截"}}]})+'\n\n'));
  else controller.error(new TypeError("connection closed"));
 }})));vi.stubGlobal("fetch",fetch);
 await expect(new LifeOpsAi(configured()).agentReplyStream("虚构","虚构",[],vi.fn())).rejects.toMatchObject({code:"response_incomplete"});
 expect(fetch).toHaveBeenCalledOnce();expect(requestUrl).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
});
