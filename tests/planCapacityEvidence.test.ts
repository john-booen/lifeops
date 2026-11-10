import { expect, it } from "vitest";
import { planCapacityEvidence } from "../src/features/tasks/capacityEvidence";

const facts = JSON.stringify({ today: { scheduled: 12 }, capacity: { overloaded: true, typicalCount: 6 } });

it("recovers the comparison when an overload answer omitted its usual count", () => {
  expect(planCapacityEvidence(facts, "今天排了 12 项，已经超载。")).toBe("核对到的工作量：今天原排 12 项，常态完成 6 项。");
});

it("adds nothing to a priority-only answer or one that already has both numbers", () => {
  expect(planCapacityEvidence(facts, "先检查虚构样品。")).toBeUndefined();
  expect(planCapacityEvidence(facts, "原排 12 项，平时完成 6 项，已经超载。")).toBeUndefined();
  expect(planCapacityEvidence(JSON.stringify({ today: { scheduled: 12 }, capacity: { overloaded: true } }), "超载。"))
    .toBeUndefined();
});
