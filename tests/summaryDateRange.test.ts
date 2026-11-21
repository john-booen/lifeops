import { expect, it } from "vitest";
import { requestedSummaryDates } from "../src/agent/summaryDateRange";

const now = new Date("2026-11-12T12:00:00+08:00");
const message = "回顾10月26日到11月8日的虚构纸样归档。";
const call = { id: "fictional", name: "get_summaries", arguments: {
  level: "week", range: { from: "2025-10-26", to: "2025-11-08" }, includeOriginals: true, query: "纸样" } };
it("corrects only the invented year and preserves the source call and other arguments", () => {
  expect(requestedSummaryDates([call], message, now)[0]).toEqual({ ...call, arguments: {
    ...call.arguments, range: { from: "2026-10-26", to: "2026-11-08" } } });
  expect(call.arguments.range.from).toBe("2025-10-26");
});
it.each(["2025年" + message, "去年" + message, "回顾2025-10-26到2025-11-08", "回顾12月26日到1月8日",
  message + "再比较9月1日到9月8日", "继续刚才的回顾"]) ("preserves explicit, contextual, crossed or ambiguous dates: %s", text => {
  expect(requestedSummaryDates([call], text, now)[0]).toBe(call);
});
it("keeps prior year context, partial ranges, other tools, invalid and already grounded ranges", () => {
  expect(requestedSummaryDates([call], message, now, [{ role: "user", content: "先看去年2025年的资料" }])[0]).toBe(call);
  for (const range of ["last_week", { from: "2025-10-27", to: "2025-11-08" }, { from: "2025-02-30", to: "2025-11-08" },
    { from: "2026-10-26", to: "2026-11-08" }, null]) {
    const other = { ...call, arguments: { ...call.arguments, range } };
    expect(requestedSummaryDates([other], message, now)[0]).toBe(other);
  }
  const other = { ...call, name: "get_stats" };
  expect(requestedSummaryDates([other], message, now)[0]).toBe(other);
});
