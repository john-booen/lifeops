import {expect,it,vi} from 'vitest';
import type {AiToolCall} from '../src/ai';
import type {ToolCallResult} from '../src/agentRuntime';
import {getStats} from '../src/features/stats/stats';
import type {LifeOpsTask} from '../src/types';
vi.mock('obsidian',()=>({Notice:class{},normalizePath:(path:string)=>path}));
const{taskReadBatchReply}=await import('../src/agent/taskReadBatchReply');
const today='2026-11-12',range={from:'2026-11-02',to:'2026-11-08'};
const task={id:'fictional-repeat',title:'虚构重复完成',status:'active',date:'2026-11-04',createdAt:'2026-11-04T08:00:00+08:00',completionLog:[{completedAt:'2026-11-04T09:00:00+08:00',note:''},{completedAt:'2026-11-04T10:00:00+08:00',note:''}],priority:'none',quadrant:'important-not-urgent',category:'work',project:'',endDate:'',time:'',dueDate:'',dueTime:'',repeatUnit:'none',repeatInterval:1,repeatUntil:'',parentTaskId:'',note:'',source:'manual',sourceNotePath:'',updatedAt:'',completedAt:'',sortOrder:0} as LifeOpsTask;
const output=JSON.stringify(getStats({domain:'tasks',range},{tasks:[task]},new Date('2026-11-12T12:00:00+08:00')));
const calls:AiToolCall[]=[{id:'fictional-count',name:'get_stats',arguments:{domain:'tasks',range,directReply:'completed_tasks'}},{id:'fictional-meaning',name:'get_stats',arguments:{domain:'tasks',range,directReply:'task_meaning'}}];
const results=():ToolCallResult[]=>calls.map(call=>({callId:call.id!,success:true,output,actions:[]}));
it('preserves a distinct-task count and the requested metric definitions in one factual response',()=>{
 const reply=taskReadBatchReply(calls,results().reverse(),today)!;
 expect(reply).toContain('1 个任务（共 2 次完成记录）');expect(reply).toContain('任务统计口径');expect(reply).not.toContain('需要我');
});
it('does not consume a pending card, attempted write, unselected interpretation or grouped read',()=>{
 const pending=results();pending[1].actions=[{id:'fictional-card',type:'tool_batch',title:'虚构待确认',description:'虚构卡片尚未执行',content:'虚构确认内容',date:today}];expect(taskReadBatchReply(calls,pending,today)).toBeUndefined();
 for(const second of [{...calls[1],name:'create_task'},{...calls[1],arguments:{domain:'tasks',range}},{...calls[1],arguments:{domain:'tasks',range,groupBy:'day',directReply:'task_summary'}}])expect(taskReadBatchReply([calls[0],second],results(),today)).toBeUndefined();
});
it('keeps missing and failed reads out of a supposedly complete batch',()=>{
 expect(taskReadBatchReply(calls,results().slice(0,1),today)).toBeUndefined();
 const failed=results();failed[1].success=false;expect(taskReadBatchReply(calls,failed,today)).toBeUndefined();
 expect(taskReadBatchReply(calls.slice(0,1),results().slice(0,1),today)).toBeUndefined();
});
