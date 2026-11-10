import { expect, it } from "vitest";
import { scoreEvaluationCase, shouldRepeatLatencyMeasurement, type EvalObservation, type EvalQuestion } from "./eval/scoring";

const question: EvalQuestion = { id: "create", milestone: "M1", domain: "tasks", mode: "text", input: "建任务", history: [],
  checks: { expectWrites: { "tasks.created": 1 }, minReceipts: 1, maxConfirmations: 0,
    createdTask: { titleIncludes: "见客户", date: "2026-11-13", time: "15:00" } } };
const task = { id: "synthetic", title: "见客户", date: "2026-11-13", time: "15:00" };
const observed: EvalObservation = { reply: "已建好", tools: [], writes: { "tasks.created": 1 }, createdTasks: [task],
  tasks: [task], confirmations: 0, confirmationActions: [], receipts: 1, preludeCreatedTasks: 0 };

it("scores actual created rows and receipts instead of trusting a completion claim", () => {
  expect(scoreEvaluationCase(question, observed)).toEqual([]);
  expect(scoreEvaluationCase(question, { ...observed, createdTasks: [], writes: { "tasks.created": 0 } }))
    .toEqual(expect.arrayContaining(["新建任务的标题、日期或时间不符", "写入数量 tasks.created 期望 1，实际 0"]));
});

it("detects missing usage, slow replies, forbidden calls and a missing confirmation card", () => {
  const guarded = { ...question, checks: { maxInputTokens: 6000, maxFirstTokenMs: 3000,
    mustNotCallTools: ["delete_habit"], minConfirmations: 1 } };
  expect(scoreEvaluationCase(guarded, { ...observed, tools: [{ name: "delete_habit", ok: true }], firstTokenMs: 4000 }))
    .toEqual(expect.arrayContaining(["缺少实际输入 token 用量", "首字时间超标", "调用了禁止工具 delete_habit", "缺少确认卡"]));
});

it("repeats a latency measurement only after an observed transport failure and a correct answer", () => {
  const timed = { ...question, checks: { maxInputTokens: 6000, maxFirstTokenMs: 3000 } };
  const interrupted = { issues: ["缺少实际输入 token 用量", "首字时间超标"], transportFailures: 1 };
  expect(shouldRepeatLatencyMeasurement(timed, interrupted)).toBe(true);
  expect(shouldRepeatLatencyMeasurement(timed, { ...interrupted, transportFailures: 0 })).toBe(false);
  expect(shouldRepeatLatencyMeasurement(timed, { ...interrupted, issues: [...interrupted.issues, "缺少内容 见客户"] })).toBe(false);
  expect(shouldRepeatLatencyMeasurement(question, interrupted)).toBe(false);
});

it("requires a real successful setup before accepting an undo scenario", () => {
  const undo = { ...question, checks: { preludeCreatedTasks: 1, absentTaskTitle: "见客户" } };
  expect(scoreEvaluationCase(undo, observed)).toEqual(expect.arrayContaining(["前置建任务未完成", "撤销后任务仍存在"]));
});

it("rejects a task deletion card when the user asked to delete a specific habit", () => {
  const guarded = { ...question, checks: { minConfirmations: 1, maxConfirmations: 1,
    confirmationTarget: { type: "delete_habit", targetId: "habit-eval-read" } } };
  expect(scoreEvaluationCase(guarded, { ...observed, confirmations: 1,
    confirmationActions: [{ type: "delete_task", targetIds: ["synthetic"] }] })).toContain("确认卡类型或目标不符，实际 delete_task");
  expect(scoreEvaluationCase(guarded, { ...observed, confirmations: 1,
    confirmationActions: [{ type: "delete_habit", targetIds: ["habit-eval-read"] }] })).toEqual([]);
});

it("requires the observed quantity, stored memory and exact task change for the new cases", () => {
  const measured: EvalQuestion = { ...question, checks: {
    checkin: { habitId: "run", date: "2026-11-12", count: 1, status: "done", value: 5 },
    remembered: ["周三", "开会"], changedTask: { id: task.id, date: task.date }, mustSucceedTools: ["complete_habit"]
  } };
  expect(scoreEvaluationCase(measured, { ...observed, tools: [{ name: "complete_habit", ok: false }] }))
    .toEqual(["工具未成功完成 complete_habit", "未读回指定习惯、日期、次数和实际数值", "未读回有效的个人记忆"]);
  expect(scoreEvaluationCase(measured, { ...observed, tools: [{ name: "complete_habit", ok: true }],
    checkins: [measured.checks.checkin!], activeMemories: ["每周三晚上开会"] })).toEqual([]);
});

it("accepts equivalent meeting wording only when the active memory contains the weekday and time", () => {
  const memory = { ...question, checks: { remembered: ["周三", "晚", ["开会", "会议"]] } };
  expect(scoreEvaluationCase(memory, { ...observed, activeMemories: ["每周三晚上有会议。"] })).toEqual([]);
  expect(scoreEvaluationCase(memory, { ...observed, activeMemories: ["每周三下午有会议。", "周三晚上跑步。"] }))
    .toContain("未读回有效的个人记忆");
});

it("checks actual proposed dates and limits and accepts a real weekend clarification", () => {
  const plan: EvalQuestion = { ...question, checks: { taskPlan: { date: "2026-11-13", maxTasks: 2 }, minConfirmations: 1 } };
  expect(scoreEvaluationCase(plan, { ...observed, confirmations: 1, proposedTaskDates: ["2026-11-14"] }))
    .toContain("确认卡日期或任务数量超出预期");
  expect(scoreEvaluationCase(plan, { ...observed, confirmations: 1, proposedTaskDates: ["2026-11-13"] })).toEqual([]);
  const weekend: EvalQuestion = { ...question, checks: { createdOrClarify: {
    titleIncludes: "理发", dates: ["2026-11-14", "2026-11-15"], clarify: ["周六还是周日"]
  } } };
  expect(scoreEvaluationCase(weekend, { ...observed, createdTasks: [], receipts: 0, reply: "周六还是周日？" })).toEqual([]);
  expect(scoreEvaluationCase(weekend, { ...observed, createdTasks: [], receipts: 0,
    reply: "周六和周日你倾向哪一天？" })).toEqual([]);
  expect(scoreEvaluationCase(weekend, { ...observed, createdTasks: [], receipts: 0,
    reply: "请问你具体是**周六（11月14日）**还是**周日（11月15日）**去理发？" })).toEqual([]);
  expect(scoreEvaluationCase(weekend, { ...observed, createdTasks: [], receipts: 0,
    reply: "周末有两天，您想哪天去？我按您说的日期记下。" })).toEqual([]);
  expect(scoreEvaluationCase(weekend, { ...observed, createdTasks: [], receipts: 0,
    reply: "周末有两天，任选一天都可以。" })).toContain("没有在有效周末建任务或询问具体日期");
  expect(scoreEvaluationCase(weekend, { ...observed, createdTasks: [], receipts: 0,
    reply: "周六（11月14日）和周日（11月15日）都适合理发。" })).toContain("没有在有效周末建任务或询问具体日期");
  expect(scoreEvaluationCase(weekend, observed)).toContain("没有在有效周末建任务或询问具体日期");
});
