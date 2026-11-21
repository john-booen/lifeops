import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {requestUrl} from "obsidian";
import {DEFAULT_SETTINGS} from "../src/defaults";
import {LifeOpsAi} from "../src/ai";
import {normalizeProviderConnectionError,ProviderDnsLookupError,ProviderTransportError,runProviderRequest} from "../src/providerRun";
import {normalizeQualityLogEntry} from "../src/qualityLog";
vi.mock("obsidian",()=>({requestUrl:vi.fn()}));
beforeEach(()=>{vi.useFakeTimers();vi.mocked(requestUrl).mockReset();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
const target={provider:"fictional",model:"synthetic"};
const answer={content:"纯虚构恢复成功",toolCalls:[]};
const dns=()=>new ProviderDnsLookupError();
it.each([{code:"ENOTFOUND"},{code:"EAI_AGAIN"},{cause:{code:"ENOTFOUND"}},{message:"net::ERR_NAME_NOT_RESOLVED"}])("recognizes transport DNS evidence without logging error payload: %j",error=>{
 expect(normalizeProviderConnectionError(error)).toBeInstanceOf(ProviderDnsLookupError);
 expect(JSON.stringify(normalizeProviderConnectionError({...error,secret:"synthetic-private-key"}))).not.toContain("synthetic-private-key");
});
it.each([new TypeError("Failed to fetch"),Object.assign(new Error("reset"),{code:"ECONNRESET"}),new Error("private payload mentions ENOTFOUND"),Object.assign(new Error("stopped"),{name:"AbortError",code:"ENOTFOUND"})])("does not treat ambiguous or cancelled failures as safe DNS retry",error=>{
 expect(normalizeProviderConnectionError(error)).toBe(error);
});
it("recovers a temporary pre-send DNS failure once after the configured route has failed",async()=>{
 const execute=vi.fn().mockRejectedValueOnce(dns()).mockResolvedValueOnce(answer);
 const pending=runProviderRequest<{content:string;reportedModel?:string}>(target,[{...target,transport:"request_url",execute}]);
 await vi.advanceTimersByTimeAsync(999);expect(execute).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(1);const result=await pending;
 expect(result.content).toBe(answer.content);expect(execute).toHaveBeenCalledTimes(2);
 expect(result.providerRun.attempts[0]).toMatchObject({errorCode:"network",networkFailure:"dns"});
 expect(result.providerRun.status).toBe("success");
});
it("stops after one recovery attempt and retains a body-free DNS diagnosis",async()=>{
 const execute=vi.fn().mockRejectedValue(dns());
 const pending=runProviderRequest(target,[{...target,transport:"request_url",execute}]).catch(error=>error);
 await vi.advanceTimersByTimeAsync(1000);const error=await pending;
 expect(execute).toHaveBeenCalledTimes(2);expect(error.message).toContain("域名");
 const log=normalizeQualityLogEntry({inputSource:"text",providerRuns:[error.providerRun]});
 expect(log.providerRuns![0].attempts.every(row=>row.networkFailure==="dns")).toBe(true);
});
it("tries the configured alternate before scheduling a recovery of its last pre-send failure",async()=>{
 const primary=vi.fn().mockRejectedValue(new ProviderTransportError("rate_limit","limited",429));
 const alternate=vi.fn().mockRejectedValueOnce(dns()).mockResolvedValueOnce(answer);
 const pending=runProviderRequest(target,[{...target,transport:"stream",execute:primary},{provider:"alternate",model:"synthetic-2",transport:"request_url",execute:alternate}]);
 await vi.advanceTimersByTimeAsync(1000);const result=await pending;
 expect(primary).toHaveBeenCalledOnce();expect(alternate).toHaveBeenCalledTimes(2);expect(result.providerRun.actualProvider).toBe("alternate");
});
it.each([new Error("generic network failure"),new ProviderTransportError("rate_limit","limited",429),new ProviderTransportError("auth","denied",401)])("does not repeat an ambiguous or HTTP failure",async error=>{
 const execute=vi.fn().mockRejectedValue(error);await expect(runProviderRequest(target,[{...target,transport:"request_url",execute}])).rejects.toThrow();
 expect(execute).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it("cancels while waiting without sending a delayed request or retaining its timer",async()=>{
 const signal=new AbortController(),execute=vi.fn().mockRejectedValue(dns());
 const pending=runProviderRequest(target,[{...target,transport:"request_url",execute}],{signal:signal.signal}).catch(error=>error);
 await vi.advanceTimersByTimeAsync(500);signal.abort();const error=await pending;
 expect(error.name).toBe("AbortError");expect(execute).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it("uses the real text transport boundary for recoverable DNS while leaving malformed HTTP bodies terminal",async()=>{
 const s=structuredClone(DEFAULT_SETTINGS);s.privacy={...s.privacy,plaintextCredentialStorageAccepted:true,excludedVaultPrefixes:[]};
 Object.assign(s.ai,{provider:"synthetic",model:"synthetic",endpoint:"https://fiction.invalid",apiKey:"synthetic-key",dataDisclosureAccepted:true,fallbackProvider:"off"});
 vi.mocked(requestUrl).mockRejectedValueOnce(new Error("net::ERR_NAME_NOT_RESOLVED")).mockResolvedValueOnce({status:200,json:{choices:[{message:{content:"纯虚构回复"},finish_reason:"stop"}]}} as never);
 const pending=new LifeOpsAi(s).agentReply("纯虚构上下文","虚构问候");await vi.advanceTimersByTimeAsync(1000);
 expect((await pending).content).toBe("纯虚构回复");expect(requestUrl).toHaveBeenCalledTimes(2);
});
