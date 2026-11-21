import { expect, it } from "vitest";
import { evidenceCoverage } from "../src/features/summaries/evidenceCoverage";
const range = { from: "2026-10-26", to: "2026-11-08" };
it("counts two matching dates and twelve other dates separately from the number of note excerpts", () => {
  const days = Array.from({ length: 14 }, (_, i) => ({ date: new Date(Date.UTC(2026, 9, 26 + i)).toISOString().slice(0, 10),
    status: [2, 9].includes(i) ? "已返回可读片段" : "有日记，可读正文未命中主题" }));
  const result = evidenceCoverage(range, days, 4, true);
  expect(result.counts).toEqual({ requestedDays: 14, scopeDays: 14, withJournalDays: 14, matchedDays: 2,
    unmatchedDays: 12, missingDays: 0, unavailableDays: 0, limitedDays: 0, outsideScopeDays: 0, returnedNotes: 4 });
  expect(result.summary).toContain("本次覆盖14天"); expect(result.summary).toContain("12天有日记"); expect(result.summary).toContain("4篇片段");
});
it("separates unreadable, missing, and dates outside the read window", () => {
  const result = evidenceCoverage(range, [{ date: "2026-11-03", status: "有日记，片段暂不可核对" },
    { date: "2026-11-04", status: "允许范围未找到日记" }, { date: "2026-11-05", status: "有日记，本次未读齐" }], 0, false);
  expect(result.counts).toMatchObject({ scopeDays: 3, withJournalDays: 2, missingDays: 1, unavailableDays: 1, limitedDays: 1, outsideScopeDays: 11 });
  expect(result.summary).toContain("另11天未在本次原文读取范围"); expect(result.summary).not.toContain("未命中主题；");
});
it("counts local calendar dates across a daylight-saving transition without an hour-based error", () => {
  expect(evidenceCoverage({ from: "2026-10-31", to: "2026-11-02" }, [], 0, false).counts.requestedDays).toBe(3);
});
it.each([
  { days: [{ date: "2026-11-04", status: "已返回可读片段" }, { date: "2026-11-04", status: "允许范围未找到日记" }] },
  { days: [{ date: "2026-11-09", status: "已返回可读片段" }] },
  { days: [{ date: "2026-11-04", status: "unknown" }] }
])("does not invent counts from inconsistent date evidence: %j", ({ days }) => {
  expect(() => evidenceCoverage(range, days, 0, false)).toThrow("无法核对");
});
it.each(["今天", "2026-02-30"])("rejects a noncanonical or impossible resolved date: %s", from => {
  expect(() => evidenceCoverage({ from, to: range.to }, [], 0, false)).toThrow("无法核对");
});
