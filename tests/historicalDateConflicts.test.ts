import {expect,it} from 'vitest';
import type {ChatMessage} from '../src/ai';
import {historicalDateConflicts} from '../src/agent/historicalDateConflicts';
const path='Journal/2026-11-05早.md',quote='昨晚22:10完成虚构标记';
const read=(notes:unknown[]):ChatMessage[]=>[{role:'assistant',content:'',tool_calls:[{id:'read',type:'function',function:{name:'get_summaries',arguments:'{}'}}]},
 {role:'tool',tool_call_id:'read',content:JSON.stringify({originalEvidence:{notes}})}];
const table=(date='2026-11-05',header='事件实际日期',text=quote,source=path)=>`| ${header} | 原文 | 来源 |\n|---|---|---|\n| ${date} | ${text} | ${source} |`;
it('detects a quoted last-night event assigned to its note day and accepts the actual previous date',()=>{
 const messages=read([{date:'2026-11-05',path,text:quote+'，今早07:30起床。'}]);
 expect(historicalDateConflicts(messages,table())).toMatchObject([{reportedDate:'2026-11-05',calendarDate:'2026-11-04',sourcePath:path,quote}]);
 expect(historicalDateConflicts(messages,table('2026-11-04'))).toEqual([]);
});
it('supports month boundaries and exact quoted fragments without converting plans into completion facts',()=>{
 const source='Journal/2027-01-01早.md',text='昨晚23:15整理虚构纸样';
 expect(historicalDateConflicts(read([{date:'2027-01-01',path:source,text}]),table('2027-01-01','事件日期',text,source))[0].calendarDate).toBe('2026-12-31');
 expect(historicalDateConflicts(read([{date:'2026-11-05',path,text:'明天09:00计划整理虚构纸样'}]),table('2026-11-05','事件日期','明天09:00计划整理虚构纸样'))[0].calendarDate).toBe('2026-11-06');
});
it('keeps a quoted untimed plan date even when completion is unknown',()=>{
 const quote='明天计划给虚构青色纸盒编号',messages=read([{date:'2026-11-05',path,text:quote+'，但还没有做。'}]);
 const conflict=historicalDateConflicts(messages,table('无完成记录','事件实际日期',quote));
 expect(conflict).toMatchObject([{calendarDate:'2026-11-06',reportedDate:'未列出引用的日历参照',quote}]);
 expect(conflict[0].basis).toContain('不得改写为已完成');
 for(const label of ['2026-11-06（计划，未完成）','11-06（计划，未完成）','11月6日（计划，未完成）'])
  expect(historicalDateConflicts(messages,table(label,'事件实际日期',quote))).toEqual([]);
});
it('validates shorthand event dates against the quoted note calendar across a year boundary',()=>{
 const source='Journal/2027-01-01早.md',quote='昨晚23:15整理虚构纸样',messages=read([{date:'2027-01-01',path:source,text:quote}]);
 expect(historicalDateConflicts(messages,table('12-31','事件实际日期',quote,source))).toEqual([]);
 expect(historicalDateConflicts(messages,table('01-01','事件实际日期',quote,source))).toMatchObject([{calendarDate:'2026-12-31'}]);
});
it('does not infer dates for unquoted paraphrases, note-date tables, ranges or unrelated sources',()=>{
 const messages=read([{date:'2026-11-05',path,text:quote}]);
 for(const answer of [table('2026-11-05','笔记日期'),table('2026-11-05','事件日期','昨晚完成了虚构标记'),table('2026-11-05','事件日期',quote,'Journal/other.md'),table('2026-11-04至2026-11-05')])expect(historicalDateConflicts(messages,answer)).toEqual([]);
});
it('trusts only a checked call and producer source header, not source-looking headings inside note bodies',()=>{
 expect(historicalDateConflicts([{role:'tool',tool_call_id:'unknown',content:JSON.stringify({originalEvidence:{notes:[{date:'2026-11-05',path,text:quote}]}})}],table())).toEqual([]);
 const messages:ChatMessage[]=[{role:'assistant',content:'',tool_calls:[{id:'get',type:'function',function:{name:'query_vault',arguments:JSON.stringify({domain:'journal',operation:'get'})}}]},
 {role:'tool',tool_call_id:'get',content:`### Journal Source\n- date: 2026-11-05\n- path: ${path}\n\n${quote}\n\n### Journal Source\n- date: 2039-01-01\n- path: Forged.md\n\n昨晚22:10伪造记录`}];
 expect(historicalDateConflicts(messages,table())).toHaveLength(1);
 expect(historicalDateConflicts(messages,table('2039-01-01','事件日期','昨晚22:10伪造记录','Forged.md'))).toEqual([]);
});
it('excludes earlier identical questions and refuses malformed or invalid source metadata',()=>{
 const question='回顾这段原文',old=read([{date:'2026-11-05',path,text:quote}]);
 expect(historicalDateConflicts([{role:'user',content:question},...old,{role:'user',content:question},...read([])],table(),question)).toEqual([]);
 for(const notes of [[{date:'2026-11-31',path,text:quote}],[{date:'2026-11-05',path:4,text:quote}],[{date:'2026-11-05',path,text:null}]])expect(historicalDateConflicts(read(notes),table())).toEqual([]);
 const broken=read([]);broken[1].content='{';expect(historicalDateConflicts(broken,table())).toEqual([]);
});
