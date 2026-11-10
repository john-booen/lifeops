import { expect, it } from "vitest";
import { habitDateEvidence } from "../src/features/stats/habitEvidence";

const stats = { domain: "habits", range: { from: "2026-11-09", to: "2026-11-12" },
  habits: [
    { name: "虚构存钱", goals: [{ period: "day", missedDates: ["2026-11-11", "2026-11-10"] }] },
    { name: "虚构阅读", goals: [{ period: "day", missedDates: ["2026-11-12"] }] },
    { name: "虚构周目标", goals: [{ period: "week", missedDates: ["2026-11-09"] }] }
  ] };

it("fills omitted dates only for a named habit with verified daily goals", () => {
  expect(habitDateEvidence(JSON.stringify(stats), "虚构存钱有改善空间，11月11日没达标。虚构周目标也要跟进。"))
    .toBe("核对到的未达标日期：「虚构存钱」11-10、11-11。");
});

it("does not repeat complete evidence, mention unrelated records or extend a date range", () => {
  expect(habitDateEvidence(JSON.stringify(stats), "虚构存钱在11-10和11-11没达标。")).toBeUndefined();
  expect(habitDateEvidence(JSON.stringify(stats), "今天没问习惯。")).toBeUndefined();
  expect(habitDateEvidence(JSON.stringify({ ...stats, range: { from: "2026-10-01", to: "2026-11-12" } }), "虚构存钱"))
    .toBeUndefined();
  expect(habitDateEvidence(JSON.stringify({ ...stats, domain: "tasks" }), "虚构存钱")).toBeUndefined();
});
