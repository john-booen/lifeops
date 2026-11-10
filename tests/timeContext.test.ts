import { describe, expect, it } from "vitest";
import { getTimeContext, inferTimeOfDay, isTradingWindow, timeContextToMarkdown } from "../src/timeContext";

describe("getTimeContext", () => {
  it("classifies local day parts and weekly review day", () => {
    const context = getTimeContext(new Date(2026, 5, 14, 22, 10));

    expect(context.date).toBe("2026-06-14");
    expect(context.weekday).toBe("周日");
    expect(context.timeOfDay).toBe("night");
    expect(context.isWorkday).toBe(false);
    expect(context.isWeeklyReviewDay).toBe(true);
    expect(context.season).toBe("夏");
  });

  it("detects China market and global overlap windows", () => {
    expect(isTradingWindow(new Date(2026, 5, 11, 10, 0))).toBe(true);
    expect(isTradingWindow(new Date(2026, 5, 11, 16, 0))).toBe(true);
    expect(isTradingWindow(new Date(2026, 5, 13, 10, 0))).toBe(false);
  });

  it("renders a compact markdown block for prompts", () => {
    const markdown = timeContextToMarkdown(getTimeContext(new Date(2026, 5, 11, 9, 35)));

    expect(markdown).toContain("Runtime Time Context");
    expect(markdown).toContain("2026-06-11");
    expect(markdown).toContain("交易时段");
  });

  it("keeps early morning as night", () => {
    expect(inferTimeOfDay(new Date(2026, 5, 11, 6, 30))).toBe("night");
    expect(inferTimeOfDay(new Date(2026, 5, 11, 7, 0))).toBe("morning");
  });
});
