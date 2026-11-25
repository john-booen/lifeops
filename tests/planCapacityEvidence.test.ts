import { expect, it } from "vitest";
import { formatTodayCapacity, planCapacityEvidence } from "../src/features/tasks/capacityEvidence";

it('keeps the authoritative overload verdict when the model only says the work may not fit',()=>{
  const facts=JSON.stringify({today:{scheduled:12},capacity:{overloaded:true,typicalCount:6}});
  expect(planCapacityEvidence(facts,'今天原排12项，平常完成6项，可能做不完。','我今天的任务会不会做不完，需要挪一些吗？')).toContain('已超载');
});

const facts = JSON.stringify({ today: { scheduled: 12 }, capacity: { overloaded: true, typicalCount: 6 } });

it("restores only a tool-verified deferral suggestion without changing the schedule", () => {
  const plan = JSON.stringify({today:{scheduled:12},capacity:{overloaded:true,typicalCount:6,suggestDefer:["later","missing"]},tasks:[{id:"later",title:"虚构样品归档"}]});
  const answer = "今天原排12项，常态完成6项，已超载。";
  expect(planCapacityEvidence(plan,answer,"今天会不会做不完？")).toBe("可以考虑延后「虚构样品归档」；尚未修改安排。");
  expect(planCapacityEvidence(plan,answer+"建议挪到明天。")).toBeUndefined();
  expect(planCapacityEvidence(plan,"先做虚构样品归档。","今天先做哪件？")).toBeUndefined();
  const unknown = JSON.stringify({today:{scheduled:12},capacity:{overloaded:true,typicalCount:6,suggestDefer:["missing"]},tasks:[]});
  expect(planCapacityEvidence(unknown,answer)).toBeUndefined();
});

it("distinguishes normal load, measured zero, and insufficient history", () => {
  const workload = (scheduled: number, typicalCount: number | null) => JSON.stringify({
    today: { scheduled }, capacity: { overloaded: false, typicalCount, suggestDefer: ["demo"] },
    tasks: [{ id: "demo", title: "虚构任务" }]
  });
  expect(formatTodayCapacity(workload(4, 5.5))).toBe("按近期记录，今天的待办仍在常态负荷内。今天原排 4 项，常态每天完成约 5.5 项。");
  expect(formatTodayCapacity(workload(0, 0))).toContain("今天原排 0 项，常态每天完成约 0 项。");
  expect(formatTodayCapacity(workload(4, null))).toBe("今天原排 4 项。近期缺少常态完成记录，暂时无法判断是否超载。");
  expect(formatTodayCapacity("{}")).toBeUndefined();
});

it("recovers the comparison when an overload answer omitted its usual count", () => {
  expect(planCapacityEvidence(facts, "今天排了 12 项，已经超载。")).toBe("核对到的工作量：今天原排 12 项，常态完成 6 项。");
});

it("adds nothing to a priority-only answer or one that already has both numbers", () => {
  expect(planCapacityEvidence(facts, "先检查虚构样品。")).toBeUndefined();
  expect(planCapacityEvidence(facts, "原排 12 项，平时完成 6 项，已经超载。")).toBeUndefined();
  expect(planCapacityEvidence(JSON.stringify({ today: { scheduled: 12 }, capacity: { overloaded: true } }), "超载。"))
    .toBeUndefined();
});

it("uses the user's workload question when the model gives advice without naming the overload", () => {
  expect(planCapacityEvidence(facts, "建议把整理书架挪到明天。", "我今天的安排会不会超负荷？"))
    .toBe("按记录，今天的待办已超载。今天原排 12 项，常态完成 6 项。");
  expect(planCapacityEvidence(facts, "建议把整理书架挪到明天。", "今天先做哪一件？")).toBeUndefined();
});

it("reports overload when both counts are present but the model only suggests moving tasks", () => {
  const answer = "今天原排 12 项，平时完成 6 项。建议把整理书架挪到明天。";
  expect(planCapacityEvidence(facts, answer, "今天是不是排多了？"))
    .toBe("按记录，今天的待办已超载。");
  expect(planCapacityEvidence(facts, answer, "今天先做哪一件？")).toBeUndefined();
  const withinCapacity = JSON.stringify({ today: { scheduled: 4 }, capacity: { overloaded: false, typicalCount: 6 } });
  expect(planCapacityEvidence(withinCapacity, "今天原排 4 项。", "今天是不是排多了？")).toBeUndefined();
});
