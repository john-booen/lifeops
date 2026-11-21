import {request} from "node:https";
import {assertProviderActive,normalizeProviderConnectionError,ProviderTransportError,ProviderResponseIncompleteError} from "./providerRun";

/** A fresh TLS connection when Chromium returns no usable finite response. */
export function nodeHttpsText(url: string, headers: Record<string,string>, body: string,
  signal: AbortSignal | undefined, timeoutMs: number): Promise<{status:number;json:unknown}> {
  const endpoint=new URL(url);
  if(endpoint.protocol!=="https:"||endpoint.username||endpoint.password)throw new ProviderTransportError("configuration","独立连接需要无凭据的 HTTPS 服务地址。");
  if(timeoutMs<=0)throw new ProviderTransportError("timeout","AI 请求超时");
  assertProviderActive(signal);
  return new Promise((resolve,reject)=>{
    let done=false,receivedHeaders=false;
    const finish=(error?:unknown,value?:{status:number;json:unknown})=>{
      if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener("abort",abort);
      if(error)reject(normalizeProviderConnectionError(error));else resolve(value!);
    };
    const req=request(endpoint,{method:"POST",headers:{...headers,"Content-Length":String(Buffer.byteLength(body))},agent:false},res=>{
      receivedHeaders=true;
      const status=res.statusCode??0;
      // Never follow a redirect with the user's credentials.
      if(status<200||status>=300){res.resume();finish(undefined,{status,json:{}});return;}
      const chunks:Buffer[]=[];let bytes=0;
      const incomplete=()=>finish(new ProviderResponseIncompleteError("missing",undefined,status));
      res.on("data",chunk=>{bytes+=chunk.length;if(bytes>4*1024*1024){finish(new ProviderResponseIncompleteError("unknown",undefined,status));req.destroy();res.destroy();}else chunks.push(Buffer.from(chunk));});
      res.on("error",incomplete);res.on("aborted",incomplete);
      res.on("end",()=>{if(res.complete===false){incomplete();return;}try{finish(undefined,{status,json:JSON.parse(Buffer.concat(chunks).toString("utf8"))});}catch{finish(new ProviderResponseIncompleteError("unknown",undefined,status));}});
    });
    const abort=()=>{const error=new Error("AI request aborted");error.name="AbortError";finish(error);req.destroy();};
    const timer=setTimeout(()=>{finish(receivedHeaders?new ProviderResponseIncompleteError("missing"):new ProviderTransportError("timeout","AI 请求超时"));req.destroy();},Math.max(1,timeoutMs));
    req.on("error",error=>finish(receivedHeaders?new ProviderResponseIncompleteError("missing"):error));signal?.addEventListener("abort",abort,{once:true});
    if(signal?.aborted){abort();return;}
    req.end(body);
  });
}

export function isChromiumConnectionClosed(error:unknown):boolean {
  return error instanceof Error&&/^net::ERR_CONNECTION_(?:CLOSED|RESET)(?:$|\s)/.test(error.message);
}
