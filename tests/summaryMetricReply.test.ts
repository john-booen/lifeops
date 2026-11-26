import{it,expect,vi}from'vitest';import type{ChatMessage}from'../src/ai';
vi.mock('obsidian',()=>({parseYaml:JSON.parse,stringifyYaml:JSON.stringify,normalizePath:(p:string)=>p}));
const{summaryMetricConflicts,summaryMetricEvidence}=await import('../src/agent/summaryMetricReply');
const question='比较两期登记数字。',now=new Date('2026-11-12T20:00:00+08:00');
const base=[{period:'2026-10',from:'2026-10-01',through:'2026-10-31',metrics:{tasksCompleted:60,tradePnlCny:5,tradePnlUsd:15}},{period:'2026-11',from:'2026-11-01',through:'2026-11-12',metrics:{tasksCompleted:46,tradePnlCny:180,tradePnlUsd:120}}];
const messages=(rows:unknown[]=base):ChatMessage[]=>[{role:'user',content:question},{role:'assistant',content:'',tool_calls:[{id:'original-summary-read',type:'function',function:{name:'get_summaries',arguments:'{}'}}]},{role:'tool',tool_call_id:'original-summary-read',content:JSON.stringify({level:'month',requestedMetrics:['tasksCompleted','tradePnlCny','tradePnlUsd'],summaries:rows})}];
const table=(usd=['15','120'])=>'| 指标 | 2026年10月（10月1日—31日） | 2026年11月（统计至11月12日） |\n|---|---:|---:|\n| 任务完成数 | 60 | 46 |\n| 人民币净盈亏 | 5 | 180 |\n| 美元净盈亏 | '+usd.join(' | ')+' |';
it('catches the real reversed USD columns even when every number appears somewhere in the reply',()=>{
 const conflicts=summaryMetricConflicts(messages(),table(['120','15']),question,now);expect(conflicts).toEqual(expect.arrayContaining([expect.objectContaining({period:'2026-10',metric:'tradePnlUsd',expected:15,reported:'120'}),expect.objectContaining({period:'2026-11',metric:'tradePnlUsd',expected:120,reported:'15'})]));expect(conflicts).toHaveLength(2);
});
it('accepts correct attributed values and the current partial-month cutoff',()=>{
 expect(summaryMetricConflicts(messages(),table()+'\n\n本月统计至2026年11月12日，不是整月数据。',question,now)).toEqual([]);
});
it('validates a transposed table using explicit period rows and currency columns',()=>{
 const correct='| 月份 | 任务完成数 | 人民币净盈亏 | 美元净盈亏 |\n|---|---:|---:|---:|\n| 2026-10 | 60 | 5 | 15 |\n| 2026-11 | 46 | 180 | 120 |';expect(summaryMetricConflicts(messages(),correct,question,now)).toEqual([]);expect(summaryMetricConflicts(messages(),correct.replace('60 | 5 | 15','60 | 15 | 5'),question,now)).toHaveLength(2);
});
it('accepts reversed presentation order only when each column keeps its own source values',()=>{
 const answer='| 指标 | 本月 | 上个月 |\n|---|---:|---:|\n| 任务完成数 | 46 | 60 |\n| CNY | 180 | 5 |\n| USD | 120 | 15 |';expect(summaryMetricConflicts(messages(),answer,question,now)).toEqual([]);
});
it('checks each period heading in a plain labelled fact block',()=>{
 const answer='2026-10\n任务完成数：60\n人民币净盈亏：5\n美元净盈亏：15\n\n2026-11\n任务完成数：46\n人民币净盈亏：180\n美元净盈亏：120';expect(summaryMetricConflicts(messages(),answer,question,now)).toEqual([]);expect(summaryMetricConflicts(messages(),answer.replace('美元净盈亏：120','美元净盈亏：15'),question,now)).toContainEqual(expect.objectContaining({period:'2026-11',metric:'tradePnlUsd',expected:120}));
});
it('requires the selected multi-period metrics to be attributable instead of accepting a bag of correct numbers',()=>{
 expect(summaryMetricConflicts(messages(),'60、46、5、180、15、120。',question,now)).toHaveLength(6);
});
it('does not replace unknown figures with zero and does not round away fractional currency',()=>{
 const rows=structuredClone(base) as any[];rows[0].metrics.tradePnlUsd=null;expect(summaryMetricConflicts(messages(rows),table(['0','120']),question,now)).toContainEqual(expect.objectContaining({period:'2026-10',metric:'tradePnlUsd',expected:null}));expect(summaryMetricConflicts(messages(rows),table(['暂不可核对','120']),question,now)).toEqual([]);rows[0].metrics.tradePnlUsd=0.2;expect(summaryMetricConflicts(messages(rows),table(['0','120']),question,now)).toHaveLength(1);
});
it('keeps task identity counts exact and permits normal displayed percentage precision',()=>{
 const rows=base.map(r=>({...r,metrics:{taskCompletionPercent:70.27,tasksCompleted:r.metrics.tasksCompleted}})),answer='| 指标 | 2026-10 | 2026-11 |\n|---|---:|---:|\n| 任务完成数 | 60 | 46 |\n| 计划完成率 | 70.3% | 70.3% |';expect(summaryMetricConflicts(messages(rows),answer,question,now)).toEqual([]);expect(summaryMetricConflicts(messages(rows),answer.replace('60 | 46','60 | 45.6'),question,now)).toHaveLength(1);
});
it('withholds conflicting period readbacks rather than selecting a convenient version',()=>{
 const rows=[...base,{...base[0],metrics:{...base[0].metrics,tradePnlUsd:99}}];expect(summaryMetricConflicts(messages(rows),table(),question,now)).toContainEqual(expect.objectContaining({period:'2026-10',metric:'source'}));expect(summaryMetricEvidence(messages(rows),question)).not.toContain('2026-10（');
});
it('ignores unowned JSON and a previous occurrence of the same question',()=>{
 const prior=messages(),current:ChatMessage[]=[{role:'user',content:question},{role:'tool',tool_call_id:'foreign-read',content:JSON.stringify({summaries:base})}];expect(summaryMetricConflicts([...prior,...current],table(['120','15']),question,now)).toEqual([]);expect(summaryMetricEvidence([...prior,...current],question)).toBe('');
});
it('prints source-attributed fallback columns directly and preserves negative and unknown values',()=>{
 const rows=structuredClone(base) as any[];rows[0].metrics.tradePnlCny=-5;rows[1].metrics.tradePnlUsd=null;const text=summaryMetricEvidence(messages(rows),question);expect(text).toContain('2026-10（2026-10-01 至 2026-10-31）');expect(text).toContain('2026-11（2026-11-01 至 2026-11-12）');expect(text).toContain('| 人民币净盈亏（CNY） | -5 | 180 |');expect(text).toContain('| 美元净盈亏（USD） | 15 | 暂不可核对 |');expect(summaryMetricConflicts(messages(rows),text,question,now)).toEqual([]);
});
it('does not demand unasked figures from a complete narrative review or validate future goals as past facts',()=>{
 const full=messages();const payload=JSON.parse(full[2].content);delete payload.requestedMetrics;full[2].content=JSON.stringify(payload);expect(summaryMetricConflicts(full,'已核对两期来源，可以继续分析。',question,now)).toEqual([]);expect(summaryMetricEvidence(full,question)).toBe('');expect(summaryMetricConflicts(messages(),table()+'\n\n下一步（建议）\n2026年11月的任务完成数目标：99',question,now)).toEqual([]);
});

it('normalizes generated advice so alternate headings cannot bypass next-week calendar checking',async()=>{
 const{normalizeAdviceHeadings,futureCalendarConflicts}=await import('../src/agent/futureCalendar');const text='历史指标已核对。\n\n**改进（有依据）**：建议下周一（2026-11-09）整理虚构蓝纸。';expect(futureCalendarConflicts(text,now.toISOString())).toEqual([]);const normalized=normalizeAdviceHeadings(text);expect(normalized).toContain('**下一步（建议）**');expect(futureCalendarConflicts(normalized,now.toISOString())).toHaveLength(1);expect(normalizeAdviceHeadings('### 建议\n只做一项小调整。')).toContain('### 下一步（建议）');
});
it('leaves cited source headings, code, historical labels and established next-step headings untouched',async()=>{
 const{normalizeAdviceHeadings}=await import('../src/agent/futureCalendar');const text='> **改进（有依据）**：本人原话\n```text\n**建议**：代码内原词\n```\n### 上周的改进\n**下一步（建议）**：已规范\n建议（原文）：本人历史建议';expect(normalizeAdviceHeadings(text)).toBe(text);
});

it('does not attribute monthly totals to a single-day header that merely shares its month prefix',()=>{
 const answer=table().replace('2026年10月（10月1日—31日）','2026-10-01').replace('2026年11月（统计至11月12日）','2026-11-12');expect(summaryMetricConflicts(messages(),answer,question,now).length).toBeGreaterThan(0);
});
it('does not normalize headings inside a longer fenced source block after a shorter fence token',async()=>{
 const{normalizeAdviceHeadings}=await import('../src/agent/futureCalendar');const quoted='````text\n```\n**建议**：仍是代码内原词\n````';expect(normalizeAdviceHeadings(quoted)).toBe(quoted);
});

it('checks earlier periods from multiple bounded reads instead of silently dropping them after fourteen rows',()=>{
 const rows=Array.from({length:16},(_,i)=>{const date=new Date(Date.UTC(2025,7+i,1)),key=date.toISOString().slice(0,7);return{period:key,from:key+'-01',through:key+'-20',metrics:{tasksCompleted:i+1}};}),both=messages(rows.slice(0,8));const first=JSON.parse(both[2].content);first.requestedMetrics=['tasksCompleted'];both[2].content=JSON.stringify(first);both.push({role:'assistant',content:'',tool_calls:[{id:'second-bounded-read',type:'function',function:{name:'get_summaries',arguments:'{}'}}]},{role:'tool',tool_call_id:'second-bounded-read',content:JSON.stringify({requestedMetrics:['tasksCompleted'],summaries:rows.slice(8)})});const answer='| 指标 | '+rows.map(r=>r.period).join(' | ')+' |\n|---|'+rows.map(()=>'---:').join('|')+'|\n| 任务完成数 | '+rows.map((_,i)=>i===0?'999':String(i+1)).join(' | ')+' |';expect(summaryMetricConflicts(both,answer,question,now)).toContainEqual(expect.objectContaining({period:rows[0].period,metric:'tasksCompleted',expected:1,reported:'999'}));
});
it('keeps source code protected when a fence-like line has a language suffix and is not a closing fence',async()=>{
 const{normalizeAdviceHeadings}=await import('../src/agent/futureCalendar');const text='```text\n```js\n**建议**：仍在源码中\n```';expect(normalizeAdviceHeadings(text)).toBe(text);
});
