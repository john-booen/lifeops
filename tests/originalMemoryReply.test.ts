import {mkdtemp,rm} from 'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{afterEach,beforeEach,expect,it,vi}from'vitest';
import type {StoreHost}from'../src/store/settingsSlice';import type{ChatMessage}from'../src/ai';
import{DEFAULT_SETTINGS}from'../src/defaults';import{createPersonalMemory}from'../src/personalMemory';
import{fileRevision}from'../src/operationIdentity';import{journalDateFromPath}from'../src/journalResolver';
vi.mock('obsidian',()=>({App:class{},TFile:class{},TFolder:class{},Notice:class{},Modal:class{},normalizePath:(p:string)=>p.replace(/\\/g,'/').replace(/\/{2,}/g,'/'),requestUrl:vi.fn(),parseYaml:JSON.parse,stringifyYaml:JSON.stringify}));
const{createFsApp}=await import('./helpers/fsApp');const{LifeOpsStore}=await import('../src/store');
const{AgentRuntime}=await import('../src/agentRuntime');const{originalMemoryReply}=await import('../src/agent/originalMemoryReply');
let root:string,store:StoreHost,messages:ChatMessage[],path:string;
const now=new Date('2026-11-12T12:00:00+08:00'),question='查询虚构方案偏好的原文',right='我长期习惯用两列对照表比较虚构方案。',wrong='我长期习惯只听单一结论，不看方案对照。';
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),'lifeops-original-reply-'));store=new LifeOpsStore(createFsApp(root),structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;await store.initializeVault();
 await store.appendDaily('2026-11-03','日记','模型整理：'+wrong,'晚',right);
 path=store.app.vault.getMarkdownFiles().find(file=>journalDateFromPath(file.path,store.settings.folders.dailyRoot)==='2026-11-03')!.path;
 const raw=await store.readPath(path),doc=await store.readPersonalMemories(),stamp=now.toISOString();
 const record={...createPersonalMemory({kind:'user_rule',content:right,sourceRefs:[{sourceId:'fictional-original',path,capturedAt:stamp,contentHash:fileRevision(raw),extractionVersion:'fictional-v1',excerpt:right,excerptHash:fileRevision(right)}]},stamp),status:'active' as const,confirmedAt:stamp};
 await store.writePersonalMemories({...doc,records:[record]});
 const runtime=new AgentRuntime({store,refreshViews:async()=>{}});messages=[{role:'user',content:question}];
 for(const [id,name,args]of [['memory','query_vault',{domain:'memory',operation:'get',query:'虚构方案'}],['source','inspect_note_understanding_source',{path}]] as const){
  const result=await runtime.executeAiToolCall({id,name,arguments:args},'kimi');expect(result.success,result.output).toBe(true);
  messages.push({role:'assistant',content:'',tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]},{role:'tool',tool_call_id:id,content:result.output});
 }
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
it('replaces a repeated generated claim with only the verified original and source, without writes',async()=>{
 const before=await Promise.all([store.taskDbPath(),store.personalMemoryPath(),store.path(store.settings.folders.aiReports,'Operations','operation-ledger.json')].map(p=>store.readPath(p)));
 const reply=await originalMemoryReply(store,messages,'原话是“'+right+'”。模型整理曾写“'+wrong+'”，不采用。',question,now,()=>{});
 expect(reply).toContain(right);expect(reply!.replaceAll('\\','')).toContain(path);expect(reply).not.toContain('只听单一结论');expect(reply).not.toContain('confidence');
 expect(await Promise.all([store.taskDbPath(),store.personalMemoryPath(),store.path(store.settings.folders.aiReports,'Operations','operation-ledger.json')].map(p=>store.readPath(p)))).toEqual(before);
});
it('leaves a clean original answer and a diary-only comparison alone',async()=>{
 expect(await originalMemoryReply(store,messages,right,question,now,()=>{})).toBeUndefined();
 const diaryOnly=messages.filter(m=>m.role!=='tool'||m.tool_call_id!=='memory').map(m=>m.role==='assistant'&&m.tool_calls?.[0].id==='memory'?{...m,tool_calls:[]}:m);
 expect(await originalMemoryReply(store,diaryOnly,wrong,question,now,()=>{})).toBeUndefined();
});
it('stops a changed original instead of replacing the answer with an old preference',async()=>{
 await store.writeFile(path,await store.readPath(path)+'\n虚构新补充。');
 const reply=await originalMemoryReply(store,messages,wrong,question,now,()=>{});expect(reply).toContain('已变化');expect(reply).not.toContain(right);
});
it('does not borrow old-turn source proof when the question is repeated',async()=>{
 expect(await originalMemoryReply(store,[...messages,{role:'user',content:question}],wrong,question,now,()=>{})).toBeUndefined();
});

it('applies the original-source guard in the actual AgentLoop after a model repeats the rejected paragraph',async()=>{
 const{AgentLoop}=await import('../src/agent/AgentLoop');const runtime=new AgentRuntime({store,refreshViews:async()=>{}});
 store.settings.ai={...store.settings.ai,provider:'custom',endpoint:'https://fiction.invalid',apiKey:'fictional-key',model:'synthetic',dataDisclosureAccepted:true};
 store.settings.privacy={...store.settings.privacy,excludedVaultPrefixes:store.settings.privacy?.excludedVaultPrefixes??[],plaintextCredentialStorageAccepted:true};
 let turn=0;const model=vi.fn(async()=>++turn===1?{content:'',toolCalls:[{id:'memory-loop',name:'query_vault',arguments:{domain:'memory',operation:'get',query:'虚构方案'}},
  {id:'source-loop',name:'inspect_note_understanding_source',arguments:{path}}]}:{content:'你的原话是“'+right+'”。模型另说“'+wrong+'”，这句不采用。',toolCalls:[]});
 const before=await store.readPath(store.taskDbPath());const result=await new AgentLoop({store,settings:store.settings,aiForRole:()=>({agentTurnStream:model}),
  executeTools:async(calls,message,signal,onResult)=>{const results=[];for(const call of calls){const result=await runtime.executeAiToolCall(call,'kimi',message);onResult(call,result);results.push(result);}return results;},offlineFallback:async()=>null
 }).run({message:question,history:[],source:'text',now});
 expect(result.text).toContain(right);expect(result.text).not.toContain('只听单一结论');expect(result.text).toContain('本轮可核对');
 expect(result.receipts).toEqual([]);expect(result.confirmations).toEqual([]);expect(await store.readPath(store.taskDbPath())).toBe(before);
});
