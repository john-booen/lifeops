import { expect, it } from "vitest";
import { scoreEvaluationCase, shouldRepeatLatencyMeasurement, type EvalObservation, type EvalQuestion } from "./eval/scoring";

const question: EvalQuestion = { id: "create", milestone: "M1", domain: "tasks", mode: "text", input: "建任务", history: [],
  checks: { expectWrites: { "tasks.created": 1 }, minReceipts: 1, maxConfirmations: 0,
    createdTask: { titleIncludes: "见客户", date: "2026-11-13", time: "15:00" } } };
const task = { id: "synthetic", title: "见客户", date: "2026-11-13", time: "15:00" };
const observed: EvalObservation = { reply: "已建好", tools: [], writes: { "tasks.created": 1 }, createdTasks: [task],
  tasks: [task], confirmations: 0, confirmationActions: [], receipts: 1, preludeCreatedTasks: 0 };

it("requires both dated references while accepting one combined read or two separate weekly reads",()=>{
 const references=["2026-10-28","2026-11-04"].map(date=>({name:"get_summaries",output:{originalEvidence:{notes:[{date}]}}}));
 const crossWeek:EvalQuestion={...question,checks:{toolFacts:references}};
 const separate=references.map(row=>({name:row.name,ok:true,facts:row.output}));
 expect(scoreEvaluationCase(crossWeek,{...observed,tools:separate})).toEqual([]);
 expect(scoreEvaluationCase(crossWeek,{...observed,tools:[{name:"get_summaries",ok:true,facts:{originalEvidence:{notes:[{date:"2026-10-28"},{date:"2026-11-04"}]}}}]})).toEqual([]);
 expect(scoreEvaluationCase(crossWeek,{...observed,tools:separate.slice(0,1)})).toHaveLength(1);
});

it("requires content correction on the original task identity and preserves its schedule", () => {
  const correction: EvalQuestion = { ...question, checks: { updatedTasks: [{ fromTitleIncludes: "虚构旧标题", title: "虚构新标题" }] } };
  const prior = { ...task, id: "fictional-existing", title: "虚构旧标题", startTime: "15:00", endTime: "16:00" };
  const current = { ...prior, title: "虚构新标题" };
  const valid = { ...observed, preparedTasks: [prior], tasks: [current] };
  expect(scoreEvaluationCase(correction, valid)).toEqual([]);
  expect(scoreEvaluationCase(correction, { ...valid, tasks: [{ ...current, id: "fictional-recreated" }] })).toHaveLength(1);
  expect(scoreEvaluationCase(correction, { ...valid, tasks: [{ ...current, startTime: "15:30" }] })).toHaveLength(1);
});

it("scores actual created rows and receipts instead of trusting a completion claim", () => {
  expect(scoreEvaluationCase(question, observed)).toEqual([]);
  expect(scoreEvaluationCase(question, { ...observed, createdTasks: [], writes: { "tasks.created": 0 } }))
    .toEqual(expect.arrayContaining(["新建任务的标题、日期或时间不符", "写入数量 tasks.created 期望 1，实际 0"]));
});

it("requires a saved whole-phone receipt and retained source, and rejects invented past slots", () => {
  const phone: EvalQuestion = { ...question, checks: { phoneBatch: { created: 1, existing: 0 },
    createdTaskBatch: { date: task.date, notBefore: "00:00", titleIncludes: [task.title], unscheduled: true } } };
  const unscheduled = { id: task.id, title: task.title, date: task.date };
  const valid: EvalObservation = { ...observed, createdTasks: [unscheduled],
    phoneInbox: { status: "saved", sourceUnchanged: true, taskBatch: { created: 1, existing: 0 } } };
  expect(scoreEvaluationCase(phone, valid)).toEqual([]);
  expect(scoreEvaluationCase(phone, { ...valid, phoneInbox: { ...valid.phoneInbox!, status: "review" } }))
    .toContain("手机原文、整批保存状态或实际数量回执未核对通过");
  expect(scoreEvaluationCase(phone, { ...valid, phoneInbox: { ...valid.phoneInbox!, sourceUnchanged: false } })).toHaveLength(1);
  expect(scoreEvaluationCase(phone, { ...valid, createdTasks: [{ ...unscheduled, startTime: "10:00", endTime: "11:00" }] }))
    .toContain("批量任务名称、日期或排程不符");
});

it("requires a planned finish without storing a start or point appointment", () => {
  const finish: EvalQuestion = { ...question, checks: { createdTask: {
    titleIncludes: task.title, date: task.date, endTime: "15:00"
  } } };
  const issue = "新建任务的标题、日期或时间不符";
  const endOnly = { ...task, time: "", endTime: "15:00" };
  expect(scoreEvaluationCase(finish, observed)).toContain(issue);
  expect(scoreEvaluationCase(finish, { ...observed, createdTasks: [endOnly] })).toEqual([]);
  expect(scoreEvaluationCase(finish, { ...observed, createdTasks: [{ ...endOnly, startTime: "14:00" }] })).toContain(issue);
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

it("checks the actual spoken receipt separately from the panel reply", () => {
  const named: EvalQuestion = { ...question, mode: "voice", checks: { mustInclude: ["虚构纸盒"], mustSpeak: ["虚构纸盒", "15:15"] } };
  const panelOnly = { ...observed, reply: "已记下虚构纸盒，15:15。" };
  expect(scoreEvaluationCase(named, panelOnly)).toContain("播报缺少内容 15:15");
  expect(scoreEvaluationCase(named, { ...panelOnly, reply: "已记下虚构纸盒。", voiceSpeech: "15:15 给虚构纸盒贴标签。" })).toEqual([]);
});
