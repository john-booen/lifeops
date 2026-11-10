import type {ToolCallResult} from "../agentRuntime";
import type {StoreHost} from "../store/settingsSlice";
import type {VaultQueryRead} from "../vaultQueryRead";

/** Local capability; copying its visible text does not copy its authority. */
export interface RealtimeToolOutput {readonly text:string;}
interface Entry {readonly text:string;readonly read?:VaultQueryRead;readonly committed:boolean;claimed:boolean;}
const outputs=new WeakMap<RealtimeToolOutput,Entry>();

export async function produceRealtimeToolOutput(store:StoreHost,result:ToolCallResult,text:string,read?:VaultQueryRead):Promise<RealtimeToolOutput>{
 if(read){
  const [{isOwnedVaultQueryRead},{isOwnedStoredQueryRead}]=await Promise.all([import("../vaultQuery"),import("../storedQueryRead")]);
  if(!result.success||read.text!==result.output||!(isOwnedVaultQueryRead(store,read)||isOwnedStoredQueryRead(store,read)))throw Error("实时查询读取身份无法核对。");
 }
 const {hasCommittedToolReceipt}=await import("../agentRuntime");
 const output=Object.freeze({text});
 outputs.set(output,{text,read,committed:hasCommittedToolReceipt(result,store),claimed:false});
 return output;
}
export function disposeRealtimeToolOutput(output:unknown):void{
 if(!output||typeof output!=="object")return;
 const entry=outputs.get(output as RealtimeToolOutput);
 if(!entry||entry.claimed)return;
 outputs.delete(output as RealtimeToolOutput);entry.read?.dispose();
}

/** Owns query-dependent server history until the socket is retired. A final
 * response does not erase function_call_output or derived assistant items. */
export class RealtimeToolOutputs {
 private readonly reads=new Set<VaultQueryRead>();
 get protected():boolean{return this.reads.size>0;}
 get allowsCandidateObservation():boolean{return [...this.reads].every(read=>read.allowsCandidateObservation!==false);}
 claim(output:RealtimeToolOutput):{text:string;committed:boolean}{
  const entry=outputs.get(output);
  if(!entry||entry.claimed||output.text!==entry.text)throw Error("实时工具结果身份无法核对。");
  entry.claimed=true;
  if(entry.read){
   if(this.reads.size>=16){entry.read.dispose();throw Error("本次语音查询范围已满，请重新开始语音。");}
   this.reads.add(entry.read);
  }
  return {text:entry.text,committed:entry.committed};
 }
 assertCurrent():void{for(const read of this.reads)read.assertCurrent();}
 async duringCandidateObservation(operation:()=>Promise<void>):Promise<void>{
  if(!this.allowsCandidateObservation)throw Error("本轮查询待确认候选，不能更新候选列表。");
  this.assertCurrent();
  await operation();
  this.assertCurrent();
 }
 dispose():void{let failed=false,failure:unknown;for(const read of this.reads)try{read.dispose();}catch(error){if(!failed){failed=true;failure=error;}}this.reads.clear();if(failed)throw failure;}
}
