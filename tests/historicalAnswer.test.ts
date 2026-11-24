import { expect, it } from "vitest";
import { historicalAnswerMessages } from "../src/agent/historicalAnswer";
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
