import type {ChatMessage} from '../ai';
import type {StoreHost} from '../store/settingsSlice';
import {readPersonalMemoryWithSources} from '../personalMemorySources';
import {selectPersonalMemories} from '../personalMemory';
import {journalNarrationForMemory} from '../features/memory/summaryOriginals';
import {assertNoteUnderstandingReadResult} from '../noteUnderstandingSource';

const quote=(text:string)=>text.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!))
  .replace(/[\\`*_{}\[\]()#+.!|~$=-]/g,'\\$&').replace(/\r\n?/g,'\n').replace(/\n/g,'\n> ');

/** A memory answer must not reproduce generated source text as a second
 * personal claim. Uses actual read types and original provenance, not intent. */
export async function originalMemoryReply(store:StoreHost,messages:ChatMessage[],answer:string,
  question:string,now:Date,current:()=>void):Promise<string|undefined>{
  for(let i=messages.length-1;i>=0;i--)if(messages[i].role==='user'&&messages[i].content===question){messages=messages.slice(i);break;}
  const calls=new Map(messages.flatMap(message=>message.tool_calls??[]).map(call=>[call.id,call.function]));
  const queries:string[]=[],sources:Array<{output:string;path:string;text:string}>=[];
  for(const message of messages){
    if(message.role!=='tool')continue;const call=calls.get(message.tool_call_id??'');if(!call)continue;
    try{
      const args=JSON.parse(call.arguments);
      if(call.name==='query_vault'&&args.domain==='memory'&&args.operation==='get')queries.push(typeof args.query==='string'?args.query:'');
      if(call.name==='inspect_note_understanding_source'){
        const data=JSON.parse(message.content);
        if(typeof data.path==='string'&&typeof data.text==='string'&&typeof data.sourceToken==='string')sources.push({output:message.content,path:data.path,text:data.text});
      }
    }catch{/* A malformed or failed read supplies no proof. */}
  }
  if(!queries.length||!sources.length)return;
  for(const source of sources.slice(0,8)){
    try{await assertNoteUnderstandingReadResult(source.output,store);current();}
    catch{current();return '这份原文或记忆来源已变化，请重新查询；本轮没有确认旧偏好。';}
  }
  current();const memory=await readPersonalMemoryWithSources(store);current();
  const records=[...new Map(queries.flatMap(query=>selectPersonalMemories(memory.records,query,memory.records.length,now)).map(record=>[record.id,record])).values()];
  const witnessed:Array<{content:string;path:string}>=[];let reproduced=false;
  for(const source of sources.slice(0,8)){
    const original=journalNarrationForMemory(source.text);
    const matching=records.filter(record=>record.sourceRefs.some(ref=>ref.path===source.path)&&original.includes(record.content));
    if(!matching.length)continue;
    // Complete source paragraphs may contain labels. Compare bounded literal
    // fragments; no semantic inference about the generated text is made.
    const fragments=source.text.slice(0,256*1024).split(/[：:，。；！？\r\n]/u)
      .map(text=>text.trim()).filter(text=>text.length>=8&&text.length<=1000&&!original.includes(text)).slice(0,2000);
    if(!fragments.some(fragment=>answer.includes(fragment)))continue;
    try{await assertNoteUnderstandingReadResult(source.output,store);current();}
    catch{current();return '这份原文或记忆来源已变化，请重新查询；本轮没有确认旧偏好。';}
    reproduced=true;witnessed.push(...matching.map(record=>({content:record.content,path:source.path})));
  }
  if(!reproduced)return;
  const rows=[...new Map(witnessed.map(row=>[JSON.stringify(row),row])).values()].slice(0,8);
  return ['本轮可核对的本人原话：',...rows.map(row=>'> '+quote(row.content)+'\n\n来源：'+quote(row.path)),
    '以上按原文核对；摘要或模型整理不作为你的偏好依据。没有创建任务，也没有要求重新确认。'].join('\n\n');
}
