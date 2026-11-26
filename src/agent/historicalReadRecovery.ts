import type {AiToolCall,ChatMessage} from '../ai';
import type {StoreHost} from '../store/settingsSlice';
import type {VaultQueryRead} from '../vaultQueryRead';
import {readStoredQueryWithSources} from '../storedQueryRead';
import {recordRevision} from '../operationIdentity';
import {assertProviderActive} from '../providerRun';
import {hasPendingFactOperation,waitForFactOperations} from '../dataFoundation/factOperation';
import {readPersonalMemoryWithSources} from '../personalMemorySources';
import {createPersonalMemoryContextFilter,personalMemoryContextRevision} from '../personalMemoryContext';
import {selectPersonalMemories} from '../personalMemory';
import {historicalOriginalExcerpts} from './historicalAnswer';
import {captureSummaryQueryScope,type SummaryQueryScope} from './summaryQueryScope';

/** Host-owned date selections only. Provider failure grants no write or model
 * retry authority; reread permitted sources rather than reuse old prose. */
export async function recoverHistoricalRead(store:StoreHost,calls:readonly AiToolCall[],question:string,now:Date,
  assertCurrent:()=>void,signal?:AbortSignal):Promise<{text:string;scopes:SummaryQueryScope[]}|undefined>{
  if(!calls.length||calls.length>2||calls.some(call=>call.name!=='get_summaries'))return;
  const settings=recordRevision(store.settings),reads:VaultQueryRead[]=[];
  const current=()=>{assertProviderActive(signal);assertCurrent();if(recordRevision(store.settings)!==settings)throw Error('查询设置已变化。');};
  try{
    current();await waitForFactOperations(store,{signal,assertCurrent:current});current();
    if(await hasPendingFactOperation(store))return;
    const memory=await readPersonalMemoryWithSources(store);current();
    const messages:ChatMessage[]=[{role:'user',content:question}],coverage:string[]=[];
    for(const [index,call]of structuredClone(calls).entries()){
      current();const read=await readStoredQueryWithSources(store,'get_summaries',call.arguments);reads.push(read);
      current();await read.assertSourcesCurrent();read.assertCurrent();
      const id='recovered-history:'+index;
      messages.push({role:'assistant',content:'',tool_calls:[{id,type:'function',function:{name:'get_summaries',arguments:JSON.stringify(call.arguments)}}]},
        {role:'tool',tool_call_id:id,content:read.text});
      const data=JSON.parse(read.text),range=data.range;
      if(typeof range?.from!=='string'||typeof range.to!=='string')return;
      coverage.push(range.from+' 至 '+range.to+(typeof data.originalEvidence?.coverageSummary==='string'?'\n'+data.originalEvidence.coverageSummary:''));
    }
    for(const read of reads){await read.assertSourcesCurrent();read.assertCurrent();current();}
    if(await hasPendingFactOperation(store))return;
    const latest=await readPersonalMemoryWithSources(store);current();
    if(personalMemoryContextRevision(memory.records,now)!==personalMemoryContextRevision(latest.records,now))return;
    for(const read of reads)read.assertCurrent();
    let remaining=2400;const notes:string[]=[];
    for(const record of selectPersonalMemories(latest.records,question,latest.records.length,now).sort((a,b)=>Number(b.kind==='user_rule')-Number(a.kind==='user_rule'))){
      if(!record.confirmedAt||notes.length>=4||record.content.length>remaining)continue;
      remaining-=record.content.length;notes.push(record.content);
    }
    const literal=(text:string)=>text.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!)).replace(/[\\`*_{}\[\]()#+.!|~$=-]/g,'\\$&').replace(/\r\n?/g,'\n').replace(/\n/g,'\n> ');
    const evidence=historicalOriginalExcerpts(messages,question);
    const reply=['模型响应未完成，本次没有执行新的修改。以下只是重新核对的资料，分析和具体建议尚未完成。',
      ...coverage,evidence||'这次没有取得可引用的本人原文片段；不能据此判断没有行动。',
      ...(notes.length?['后续安排参考（当前已确认记录，不代表历史发生时刻）：',...notes.map(note=>'> '+literal(note))]:[])
    ].join('\n\n');
    current();if(createPersonalMemoryContextFilter(latest.records)(reply)!==reply)return;
    const scopes=reads.map(read=>captureSummaryQueryScope(store,read));
    if(scopes.some(scope=>!scope))return;
    return{text:reply,scopes:scopes as SummaryQueryScope[]};
  }finally{for(const read of reads)read.dispose();}
}
