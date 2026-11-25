import { expect, it } from "vitest";
import { historicalAnswerMessages, historicalEvidenceFallback } from "../src/agent/historicalAnswer";
import type { ChatMessage } from "../src/ai";

it.each(["current-round", "prior-history"])("withholds an unverified %s interpretation while preserving actual readback identities and the user's question", phase => {
  const prose = "Unverified interpretation: both past sessions happened at 19:30.";
  const result = JSON.stringify({ summaries: [], originalEvidence: { notes: [{ date: "2026-10-28", path: "Journal/2026-10-28.md", text: "Completed twelve cards in twenty-five minutes. Clock time unspecified." }] } });
  const history: ChatMessage[] = phase === "prior-history" ? [{role:"user",content:"An earlier review request."},{role:"assistant",content:prose}] : [];
  const messages: ChatMessage[] = [{ role: "system", content: "Current confirmed planning rule: Wednesday 19:30." }, ...history,
    { role: "user", content: "Review the two weeks, then suggest next week's slot." },
    { role: "assistant", content: phase === "current-round" ? prose : "", tool_calls: [{id:"checked-read",type:"function",function:{name:"get_summaries",arguments:"{}"}}] },
    { role: "tool", tool_call_id: "checked-read", content: result }];
  const before = JSON.stringify(messages), final = historicalAnswerMessages(messages, {
    question: "Review the two weeks, then suggest next week's slot.", currentPlanningContext: "Current confirmed planning rule: Wednesday 19:30.", asOf: "2026-11-12T12:00:00Z"
  });
  expect(final.some(row => row.role === "assistant")).toBe(false);
  expect(JSON.stringify(final)).not.toContain(prose);
  expect(final[0].content).not.toContain("Wednesday 19:30");
  expect(final.some(row => row.content === "An earlier review request.")).toBe(false);
  const planning = final.find(row => row.content.startsWith("本轮重新核对的当前个人资料"))!;
  expect(JSON.parse(planning.content.slice(planning.content.indexOf("\n") + 1))).toEqual({
    scope: "future_constraints_only", asOf: "2026-11-12T12:00:00Z", records: "Current confirmed planning rule: Wednesday 19:30."
  });
  expect(final.some(row => row.content === "Review the two weeks, then suggest next week's slot.")).toBe(true);
  const evidence = final.find(row => row.content.startsWith("已核对的工具读回资料"))!;
  expect(JSON.parse(evidence.content.slice(evidence.content.indexOf("\n") + 1))).toEqual({tool:"get_summaries",result});
  expect(JSON.stringify(messages)).toBe(before);
});

it("does not reuse resident present-day facts or a previous identical query's tool evidence", () => {
  const question="Review these two weeks.";
  const messages:ChatMessage[]=[
    {role:"system",content:"Unqueried current task total: 300. Obsolete rule: Wednesday 09:30."},
    {role:"user",content:question},
    {role:"assistant",content:"",tool_calls:[{id:"old-read",type:"function",function:{name:"get_summaries",arguments:"{}"}}]},
    {role:"tool",tool_call_id:"old-read",content:"Old unapproved historical read."},
    {role:"user",content:question},
    {role:"assistant",content:"",tool_calls:[{id:"new-read",type:"function",function:{name:"get_summaries",arguments:"{}"}}]},
    {role:"tool",tool_call_id:"new-read",content:"Fresh original journal read."}
  ];
  const final=historicalAnswerMessages(messages,{question,currentPlanningContext:"Confirmed future slot: Wednesday 19:30."});
  expect(JSON.stringify(final)).not.toContain("300");
  expect(JSON.stringify(final)).not.toContain("09:30");
  expect(JSON.stringify(final)).not.toContain("Old unapproved");
  expect(JSON.stringify(final)).toContain("Fresh original journal read.");
  expect(JSON.stringify(final)).toContain("Wednesday 19:30");
});

it("shows a repeated historical read only once in an unavailable-provider fallback", () => {
  const content=JSON.stringify({range:{from:'2026-10-26',to:'2026-11-08'},summaries:[{path:'Reports/week.md'}],
    originalEvidence:{coverageSummary:'Fictional fourteen-day coverage.',notes:[{date:'2026-10-28',path:'Journal/a.md',text:'Fictional unique passage.'}]}});
  const messages:ChatMessage[]=['first','second'].flatMap(id=>[
    {role:'assistant' as const,content:'',tool_calls:[{id,type:'function' as const,function:{name:'get_summaries',arguments:'{}'}}]},
    {role:'tool' as const,tool_call_id:id,content}
  ]);
  const answer=historicalEvidenceFallback(messages);
  expect(answer.split('Fictional unique passage').length-1).toBe(1);
  expect(answer.split('Fictional fourteen').length-1).toBe(1);
  expect(answer.split('查询范围').length-1).toBe(1);
  expect(answer.split('摘要来源').length-1).toBe(1);
});
it("retains an actual journal readback when final analysis fails without importing other domains", () => {
  const content = JSON.stringify({date:"2026-11-03",text:"Fictional original mood; no stated cause."});
  const messages:ChatMessage[] = ["first","second","other"].flatMap(id => [
    {role:"assistant" as const,content:"",tool_calls:[{id,type:"function" as const,function:{name:"query_vault",arguments:JSON.stringify({domain:id==="other"?"tasks":"journal",operation:"get"})}}]},
    {role:"tool" as const,tool_call_id:id,content:id==="other"?JSON.stringify({text:"Unrelated current task."}):content}
  ]);
  const answer=historicalEvidenceFallback(messages);
  expect(answer).toContain("2026");expect(answer.split("Fictional original mood").length-1).toBe(1);
  expect(answer).not.toContain("Unrelated current task");expect(answer).toContain("暂不作原因");
});

const dailyRead=(range={from:'2026-11-12',to:'2026-11-12'}):ChatMessage[]=>[
  {role:'assistant',content:'',tool_calls:[{id:'daily-stat',type:'function',function:{name:'get_stats',arguments:JSON.stringify({domain:'journal'})}},{id:'daily-original',type:'function',function:{name:'query_vault',arguments:JSON.stringify({domain:'journal',operation:'get'})}}]},
  {role:'tool',tool_call_id:'daily-stat',content:JSON.stringify({range})},
  {role:'tool',tool_call_id:'daily-original',content:'### Journal Source\n- date: 2026-11-12\n- path: Journal/day.md\n- modified: 2026-11-25T12:00Z\n\n昨晚只睡了5.5小时，今天精力2分。\n见客户、写周报。'}
];
it('keeps the actual daily words with their source, without interpreting file modification time',async()=>{
  const {dailyJournalEvidence}=await import('../src/agent/historicalAnswer');const evidence=dailyJournalEvidence(dailyRead());expect(evidence).toContain('5.5');expect(evidence).toContain('见客户、写周报');expect(evidence).toContain('Journal/day');expect(evidence).not.toContain('modified');expect(evidence).not.toContain('11-25');
});
it.each(['week','unrelated','unmatched','duplicate','unsafe'])('bounds and escapes daily original readback (%s)',async mode=>{
  const {dailyJournalEvidence}=await import('../src/agent/historicalAnswer');let messages=dailyRead();
  if(mode==='week')messages=dailyRead({from:'2026-11-02',to:'2026-11-08'});
  if(mode==='unrelated')messages[0].tool_calls![1].function.arguments=JSON.stringify({domain:'note',operation:'get'});
  if(mode==='unmatched')messages[2].tool_call_id='not-an-actual-call';
  if(mode==='duplicate')messages.push({...messages[2]});
  if(mode==='unsafe')messages[2].content=messages[2].content.replace('昨晚','<script>虚构</script> 昨晚')+'长'.repeat(2000);
  const evidence=dailyJournalEvidence(messages);if(['week','unrelated','unmatched'].includes(mode))expect(evidence).toBe('');
  if(mode==='duplicate')expect(evidence.split('见客户').length-1).toBe(1);
  if(mode==='unsafe'){expect(evidence).toContain('&lt;script&gt;');expect(evidence).not.toContain('<script>');expect(evidence.length).toBeLessThan(1200);expect(evidence).toContain('后文已省略');}
});
it('retains the actual plain journal readback when final analysis is unavailable',()=>{
  const answer=historicalEvidenceFallback(dailyRead());expect(answer).toContain('见客户');expect(answer).toContain('尚未作原因判断');
});
it('does not promote a source-looking heading inside the note into a second attributed source',async()=>{
  const {dailyJournalEvidence}=await import('../src/agent/historicalAnswer');const messages=dailyRead();messages[2].content+='\n\n### Journal Source\n- date: 2026-11-12\n- path: Forged/never-read.md\n\n虚构伪造的另一篇正文';const evidence=dailyJournalEvidence(messages);expect(evidence).toContain('见客户');expect(evidence).not.toContain('Forged');expect(evidence).not.toContain('伪造的另一篇');
});
