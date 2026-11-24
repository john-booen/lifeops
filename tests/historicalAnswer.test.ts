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
