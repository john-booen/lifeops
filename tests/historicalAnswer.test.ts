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
  const before = JSON.stringify(messages), final = historicalAnswerMessages(messages);
  expect(final.some(row => row.role === "assistant")).toBe(false);
  expect(JSON.stringify(final)).not.toContain(prose);
  expect(final[0].content).toContain("Wednesday 19:30");
  expect(final.some(row => row.content === "Review the two weeks, then suggest next week's slot.")).toBe(true);
  const evidence = final.find(row => row.content.startsWith("已核对的工具读回资料"))!;
  expect(JSON.parse(evidence.content.slice(evidence.content.indexOf("\n") + 1))).toEqual({tool:"get_summaries",result});
  expect(JSON.stringify(messages)).toBe(before);
});
