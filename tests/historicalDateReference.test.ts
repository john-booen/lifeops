import { expect, it } from "vitest";
import type { AiToolCall } from "../src/ai";
import { bindHistoricalDateReference } from "../src/agent/historicalDateReference";
import type { SummaryQueryRange } from "../src/agent/summaryQueryScope";
const selection: SummaryQueryRange = { level: "day", range: { from: "2026-10-26", to: "2026-11-08" } };
const call: AiToolCall = { id: "fictional-wrong-range", name: "get_summaries", arguments: {
  level: "week", range: { from: "2026-11-02", to: "2026-11-12" }, includeOriginals: true, query: "纸样" } };
it.each(["按刚更正的时间，接着这两周给一条下周建议。", "继续这两个星期的回顾", "用刚才的日期范围", "继续上述区间"])("binds a date reference to the checked selection: %s", message => {
  const before = JSON.stringify([call, selection]), [bound] = bindHistoricalDateReference([call], message, [selection]);
  expect(bound.arguments).toEqual({ ...call.arguments, ...selection });
  expect(bound.id).not.toBe(call.id); expect(JSON.stringify([call, selection])).toBe(before);
});
it.each(["接着这两周，改看2025-10-26至2025-11-08", "不看这两周，改看上周", "改为上个月，不用刚才的范围", "这两周中的第二周", "先看最近七天，再比较上述范围", "写一段问候"])("preserves explicit new, partial or unrelated requests: %s", message => {
  expect(bindHistoricalDateReference([call], message, [selection])).toEqual([call]);
});
it("keeps both sides of a checked comparison and never changes non-summary calls", () => {
  const earlier: SummaryQueryRange = { level: "week", range: { from: "2026-10-12", to: "2026-10-25" } };
  const write = { ...call, name: "reschedule_task" };
  const result = bindHistoricalDateReference([call, write], "接着上述范围", [earlier, selection]);
  expect(result.map(row => row.arguments.range)).toEqual([earlier.range, selection.range, call.arguments.range]);
  expect(result[2]).toBe(write); expect(new Set(result.map(row => row.id)).size).toBe(3);
  expect(bindHistoricalDateReference([call], "接着这两周", [])).toEqual([call]);
});
