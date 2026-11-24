import {expect,it} from 'vitest';
import {taskLookupResolution,resolvedTaskLookup} from '../src/agent/taskLookupResolution';
import type {AiToolDefinition,ChatMessage,AiChatResult} from '../src/ai';

it('does not turn a derived display mode into a bulk task edit during lookup recovery',()=>{
  const rows=Array.from({length:4},(_,i)=>({id:'fictional-task-'+i}));
  const tools:AiToolDefinition[]=[{name:'update_tasks',description:'fictional update',parameters:{type:'object',properties:{updates:{
    type:'array',items:{type:'object',additionalProperties:false,properties:{taskIdOrTitle:{type:'string'},startTime:{type:'string'},endTime:{type:'string'},scheduleMode:{enum:['fixed','window']}}}
  }}}}];
  const messages:ChatMessage[]=[{role:'assistant',content:'',tool_calls:[{id:'lookup',type:'function',function:{name:'list_tasks',arguments:'{}'}}]},
    {role:'tool',tool_call_id:'lookup',content:JSON.stringify({tasks:rows})}];
  const before=JSON.stringify(tools),lookup=taskLookupResolution(messages,new Map([['lookup',{success:true,output:messages[1].content}]]),tools,'2026-11-24')!;
  const schema=lookup.tool.parameters.properties as any;
  expect(schema.updates.items.properties.scheduleMode).toBeUndefined();
  expect(JSON.stringify(tools)).toBe(before);
  const response={content:'',toolCalls:[{name:'resolve_task_lookup',arguments:{kind:'prepare_updates',coversAllRequested:true,
    updates:rows.map(row=>({taskIdOrTitle:row.id,startTime:'09:00',endTime:'09:30',scheduleMode:'window'}))}}]} as AiChatResult;
  expect(resolvedTaskLookup(response,lookup).toolCalls).toEqual([]);
  for(const row of response.toolCalls[0].arguments.updates as Array<Record<string,unknown>>)delete row.scheduleMode;
  expect(resolvedTaskLookup(response,lookup).toolCalls[0].name).toBe('update_tasks');
});
