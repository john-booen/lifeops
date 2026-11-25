import { expect, it } from "vitest";
import { scoreEvaluationCase, shouldRepeatLatencyMeasurement, type EvalObservation, type EvalQuestion } from "./eval/scoring";
import { recordRevision } from "../src/operationIdentity";
import questions from "./eval/questions.json";

it("accepts the observed equivalent absence phrase without relaxing evidence or zero-write checks", () => {
  const anxiety = questions.find(row => row.id === "recent-anxiety-19")! as EvalQuestion;
  const valid = { ...observed, reply: "你感到焦虑，容易拖延，但日记里没写原因，不能编造。",
    tools: [{ name: "query_vault", ok: true }], journalToolReads: [{ name: "query_vault", phase: "current_turn" as const,
      args: { domain: "journal", operation: "get" }, ok: true,
      output: "### Journal Source\n- date: 2026-11-09\n- path: Daily/2026-11-09.md\n- source: vault\n- evidence: vault:Daily/2026-11-09.md\n\n感到焦虑，容易拖延。" }], writes: {
      "tasks.created": 0, "tasks.deleted": 0, "tasks.rescheduled": 0, "habits.deleted": 0 } };
  expect(scoreEvaluationCase(anxiety, valid)).toEqual([]);
  expect(scoreEvaluationCase(anxiety, { ...valid, journalToolReads: [] })).not.toEqual([]);
  expect(scoreEvaluationCase(anxiety, { ...valid, journalToolReads: valid.journalToolReads.map(read => ({ ...read, ok: false })) })).not.toEqual([]);
  expect(scoreEvaluationCase(anxiety, { ...valid, writes: { ...valid.writes, "tasks.created": 1 } })).not.toEqual([]);
  expect(scoreEvaluationCase(anxiety, { ...valid, reply: "焦虑，容易拖延，因为工作压力很大。" })).not.toEqual([]);
});

const question: EvalQuestion = { id: "create", milestone: "M1", domain: "tasks", mode: "text", input: "建任务", history: [],
  checks: { expectWrites: { "tasks.created": 1 }, minReceipts: 1, maxConfirmations: 0,
    createdTask: { titleIncludes: "见客户", date: "2026-11-13", time: "15:00" } } };
const task = { id: "synthetic", title: "见客户", date: "2026-11-13", time: "15:00" };
const observed: EvalObservation = { reply: "已建好", tools: [], writes: { "tasks.created": 1 }, createdTasks: [task],
  tasks: [task], confirmations: 0, confirmationActions: [], receipts: 1, preludeCreatedTasks: 0 };

const weekQuestion = questions.find(row => row.id === "previous-week-summary-37")! as EvalQuestion;
const improvementObservation: EvalObservation = { ...observed, reply: "上周完成26项。\n**一条改进建议（建议，不是已定规则）**：给阅读定一个固定落点，提前留出三十分钟。",
  tools: [{ name: "get_summaries", ok: true, facts: { level: "week", summaries: [{ period: "2026-W45", metrics: { tasksCompleted: 26 }, complete: true }] } }],
  writes: { "tasks.created": 0, "tasks.deleted": 0 }, createdTasks: [], tasks: [], receipts: 0 };

it("recognizes an explicit actionable improvement as an equivalent next step in the original week criterion", () => {
  expect(scoreEvaluationCase(weekQuestion, improvementObservation)).toEqual([]);
});
it("does not accept empty or negative improvement headings", () => {
  for (const action of ["没有。", "暂无可提供的改进建议。", "无法给出有依据的改进建议。", "……", "待补充。", "给阅读。"])
    expect(scoreEvaluationCase(weekQuestion, { ...improvementObservation, reply: "完成26项。\n**一条改进建议**：" + action })).not.toEqual([]);
});
it("does not count quoted, questioned or negated improvement labels as a next action", () => {
  for (const label of ["> 一条改进建议", "没有改进建议", "你问我一条改进建议", "一条改进建议？"])
    expect(scoreEvaluationCase(weekQuestion, { ...improvementObservation, reply: "完成26项。\n" + label + "：给阅读定一个固定落点，提前留出三十分钟。" })).not.toEqual([]);
});
it("does not accept a bare improvement claim without an action", () => {
  expect(scoreEvaluationCase(weekQuestion, { ...improvementObservation, reply: "完成26项。\n改进建议：上周阅读的记录缺少了三天。" })).not.toEqual([]);
});
it("keeps the original week statistics and actual successful tool facts mandatory", () => {
  expect(scoreEvaluationCase(weekQuestion, { ...improvementObservation, reply: improvementObservation.reply.replace("26", "25") })).not.toEqual([]);
  expect(scoreEvaluationCase(weekQuestion, { ...improvementObservation, tools: [] })).not.toEqual([]);
  expect(scoreEvaluationCase(weekQuestion, { ...improvementObservation, tools: [{ ...improvementObservation.tools[0], ok: false }] })).not.toEqual([]);
});
it("does not let an improvement heading waive the original week zero-write limits", () => {
  expect(scoreEvaluationCase(weekQuestion, { ...improvementObservation, writes: { "tasks.created": 1, "tasks.deleted": 0 } })).not.toEqual([]);
});
it("does not add the improvement alias to differently scoped criteria", () => {
  for (const group of [["下一步"], ["收尾", "后续"], ["下一步", "收尾", "后续", "其他"]])
    expect(scoreEvaluationCase({ ...weekQuestion, checks: { mustIncludeAny: [group] } }, improvementObservation)).not.toEqual([]);
});

it("requires actual active-memory readback to establish that an attributed quote is unavailable",()=>{
  const memory:EvalQuestion={...question,checks:{notRemembered:["虚构引用规则"]}};
  expect(scoreEvaluationCase(memory,{...observed,activeMemories:[]})).toEqual([]);
  expect(scoreEvaluationCase(memory,{...observed,activeMemories:["其他有依据的本人规则"]})).toEqual([]);
  expect(scoreEvaluationCase(memory,{...observed,reply:"我没有采纳",activeMemories:["虚构引用规则"]})).not.toEqual([]);
  expect(scoreEvaluationCase(memory,{...observed,reply:"我没有采纳"})).not.toEqual([]);
});

it("recognizes equivalent slash dates only when the original criteria already allow a yearless date", () => {
  const date: EvalQuestion = { ...question, checks: { mustIncludeAny: [["2026-11-03", "11月3日", "11-03"]] } };
  for (const reply of ["11/3 21:15", "11/03 21:15", "2026/11/3 21:15"]) expect(scoreEvaluationCase(date, { ...observed, reply })).toEqual([]);
  for (const reply of ["11/4 21:15", "11/30 21:15", "111/3 21:15", "2025/11/3 21:15"]) expect(scoreEvaluationCase(date, { ...observed, reply })).not.toEqual([]);
});
it("accepts spaced Chinese dates without changing the allowed day or year", () => {
  const date: EvalQuestion = { ...question, checks: { mustIncludeAny: [["2026-11-03", "11月3日", "11-03"]] } };
  for (const reply of ["11 月 3 日 21:15", "2026 年 11 月 03 日 21:15", "11\u00a0月\u00a03\u00a0日"]) expect(scoreEvaluationCase(date, { ...observed, reply })).toEqual([]);
  for (const reply of ["11 月 4 日", "11 月 30 日", "2025 年 11 月 3 日", "111 月 3 日", "11 月 3 日4"]) expect(scoreEvaluationCase(date, { ...observed, reply })).not.toEqual([]);
});
it("does not add spaced aliases to explicit-year-only or mixed requirements", () => {
  for (const group of [["2026-11-03"], ["2026-11-03", "11月3日", "周三"], ["2026-02-30", "2月30日"]]) {
    const date: EvalQuestion = { ...question, checks: { mustIncludeAny: [group] } };
    expect(scoreEvaluationCase(date, { ...observed, reply: "2026 年 11 月 3 日；2 月 30 日" })).not.toEqual([]);
  }
});
it("does not remove explicit-year or non-date requirements through date aliases", () => {
  for (const alternatives of [["2026-11-03"], ["11月3日", "明天"], ["2026-11-03", "2026-11-04"]]) {
    expect(scoreEvaluationCase({ ...question, checks: { mustIncludeAny: [alternatives] } }, { ...observed, reply: "11/3 21:15" })).not.toEqual([]);
  }
});

it("requires the same remembered content in the requested active category, not another record or its reply", () => {
  const memory: EvalQuestion = { ...question, checks: { remembered: ["虚构规则"], rememberedKind: "user_rule" } };
  const valid = { ...observed, activeMemories: ["虚构规则"], activeMemoryRecords: [{ kind: "user_rule", content: "虚构规则" }] };
  expect(scoreEvaluationCase(memory, valid)).toEqual([]);
  expect(scoreEvaluationCase(memory, { ...valid, activeMemoryRecords: [{ kind: "core_profile", content: "虚构规则" }] })).not.toEqual([]);
  expect(scoreEvaluationCase(memory, { ...valid, activeMemoryRecords: [{ kind: "user_rule", content: "别的规则" }] })).not.toEqual([]);
});

it("requires all original identities, frozen versions and new titles in one mixed task plan", () => {
  const plan: EvalQuestion = { ...question, checks: { mixedTaskOutcome: { edits: [{ from: task.title, to: "虚构新名称" }],
    createdTitles: ["虚构新纸袋"], date: task.date } } };
  const update = { taskIdOrTitle: task.id, title: "虚构新名称", expectedRevision: recordRevision(task) };
  const calls = [{ name: "update_tasks", arguments: { updates: [update] } },
    { name: "create_task", arguments: { title: "虚构新纸袋", date: task.date } }];
  const score = (proposedTaskChanges: EvalObservation["proposedTaskChanges"]) => scoreEvaluationCase(plan, { ...observed,
    confirmations: 1, receipts: 0, writes: { "tasks.created": 0, "tasks.deleted": 0, "tasks.rescheduled": 0, "tasks.timeChanged": 0 }, preparedTasks: [task], proposedTaskChanges });
  expect(score(calls)).toEqual([]); expect(score(calls.slice(1))).toHaveLength(1);
  expect(score([{ ...calls[0], arguments: { updates: [{ ...update, expectedRevision: "old" }] } }, calls[1]])).toHaveLength(1);
  expect(score([calls[0], { name: "create_task", arguments: { title: "虚构新纸袋", date: "2026-11-14" } }])).toHaveLength(1);
  expect(score([...calls, { name: "delete_task", arguments: { taskId: task.id } }])).toHaveLength(1);
  const saved = { ...observed, confirmations: 0, receipts: 2, writes: { "tasks.created": 1, "tasks.deleted": 0, "tasks.rescheduled": 0, "tasks.timeChanged": 0 },
    preparedTasks: [task], tasks: [{ ...task, title: "虚构新名称" }, { ...task, id: "new", title: "虚构新纸袋" }], createdTasks: [{ ...task, id: "new", title: "虚构新纸袋" }] };
  expect(scoreEvaluationCase(plan, saved)).toEqual([]);
  expect(scoreEvaluationCase(plan, { ...saved, tasks: [task] })).toHaveLength(1);
});

it("rejects an incomplete, unbound or silently renamed whole-plan preview", () => {
  const before = Array.from({ length: 4 }, (_, i) => ({ ...task, id: `fictional-plan-${i}`, title: `虚构区间纸样0${i + 1}` }));
  const updates = before.map((row, i) => ({ taskIdOrTitle: row.id, startTime: String(9 + i).padStart(2, "0") + ":00",
    endTime: String(9 + i).padStart(2, "0") + ":30", expectedRevision: recordRevision(row) }));
  const plan: EvalQuestion = { ...question, checks: { plannedTaskChanges: { titlePrefix: "虚构区间纸样", count: 4, fromHour: 9, date: task.date } } };
  const proposal = (rows: unknown[]) => ({ ...observed, preparedTasks: before,
    proposedTaskChanges: [{ name: "update_tasks", arguments: { updates: rows } }] });
  expect(scoreEvaluationCase(plan, proposal(updates))).toEqual([]);
  expect(scoreEvaluationCase(plan, proposal(updates.slice(1)))).toHaveLength(1);
  expect(scoreEvaluationCase(plan, proposal(updates.map(row => ({ ...row, expectedRevision: "old-version" }))))).toHaveLength(1);
  expect(scoreEvaluationCase(plan, proposal(updates.map(row => ({ ...row, title: "虚构不应更名" }))))).toHaveLength(1);
});

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

it("checks a requested single-task preview from the actual frozen card and rejects prose or premature writes",()=>{
 const q=questions.find(row=>row.id==="single-task-requested-preview-83")! as EvalQuestion,before={id:"fictional-single-card",title:"虚构指代预览蓝纸",date:"2026-11-12",startTime:"09:00",endTime:"10:00"},update={taskIdOrTitle:before.id,title:"虚构蓝纸待核对新名",expectedRevision:recordRevision(before)};
 const valid:EvalObservation={...observed,reply:"请核对虚构蓝纸待核对新名，尚未修改。",tasks:[before],preparedTasks:[before],createdTasks:[],confirmations:1,confirmationActions:[{type:"tool_batch",targetIds:[]}],receipts:0,proposedTaskChanges:[{name:"update_tasks",arguments:{updates:[update]}}],writes:{"tasks.created":0,"tasks.deleted":0,"tasks.rescheduled":0,"tasks.timeChanged":0}};
 expect(scoreEvaluationCase(q,valid)).toEqual([]);
 for(const bad of[{...valid,confirmations:0,proposedTaskChanges:[]},{...valid,tasks:[{...before,title:update.title}]},{...valid,proposedTaskChanges:[{name:"update_tasks",arguments:{updates:[{...update,expectedRevision:"unverified"}]}}]},{...valid,proposedTaskChanges:[{name:"update_tasks",arguments:{updates:[{...update,note:"unrequested"}]}}]}])expect(scoreEvaluationCase(q,bad)).not.toEqual([]);
});


it("checks the actual period and independent deadline and rejects missing, conflated or only claimed fields",()=>{
  const q=questions.find(row=>row.id==="period-task-independent-deadline-84")! as EvalQuestion;
  const period={id:"fictional-period-deadline",title:"虚构银杏跨月整理",date:"2026-11-25",endDate:"2026-12-02",scheduleMode:"window" as const,dueDate:"2026-12-03",dueTime:"17:30"};
  const valid:EvalObservation={...observed,reply:"已按期间和独立交付期限保存。",tools:[{name:"create_task",ok:true}],createdTasks:[period],tasks:[period],confirmations:0,confirmationActions:[],receipts:1,writes:{"tasks.created":1,"tasks.deleted":0,"tasks.rescheduled":0,"tasks.timeChanged":0}};
  expect(scoreEvaluationCase(q,valid)).toEqual([]);
  // The UI and daily classifier intentionally support a legacy implicit window.
  expect(scoreEvaluationCase(q,{...valid,createdTasks:[{...period,scheduleMode:undefined}]})).toEqual([]);
  for(const patch of [{dueDate:"2026-12-02"},{dueTime:undefined},{scheduleMode:"fixed"},{date:"2026-11-26"},{endDate:""},{time:"09:00"},{startTime:"09:00",endTime:"10:00"}])expect(scoreEvaluationCase(q,{...valid,createdTasks:[{...period,...patch} as typeof period]})).not.toEqual([]);
  for(const bad of [{...valid,createdTasks:[]},{...valid,receipts:0},{...valid,createdTasks:[period,{...period,id:"extra"}]}])expect(scoreEvaluationCase(q,bad)).not.toEqual([]);
});

it('requires a real new-task card and unchanged fact files, rather than a promise to wait',()=>{
  const q=questions.find(row=>row.id==='creation-must-wait-for-confirmation-85')! as EvalQuestion;
  const valid:EvalObservation={...observed,confirmations:1,confirmationActions:[{type:'tool_batch',targetIds:[],content:'新建虚构青色样本贴标签，尚未保存。'}],confirmationProtectedFilesUnchanged:true,receipts:0,writes:{'tasks.created':0,'tasks.deleted':0,'tasks.rescheduled':0,'tasks.timeChanged':0}};
  expect(scoreEvaluationCase(q,valid)).toEqual([]);
  for(const bad of [{...valid,confirmationProtectedFilesUnchanged:false},{...valid,confirmations:0,confirmationActions:[]},{...valid,receipts:1},{...valid,confirmationActions:[{type:'update_memory',targetIds:[],content:'虚构青色样本'}]}])expect(scoreEvaluationCase(q,bad)).not.toEqual([]);
});
