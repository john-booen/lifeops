import { recordRevision } from "../../src/operationIdentity";
import { normalizeJournalDate } from "../../src/date";
import { hasEquivalentDateAlias } from "./dateAliases";
import { hasJournalEvidence, type JournalEvidenceCheck, type JournalToolRead } from "./journalEvidence";

export interface EvalTask {
  id: string;
  title: string;
  date: string;
  time?: string;
  startTime?: string;
  endTime?: string;
  dueDate?: string;
}
export interface EvalCheckin { habitId: string; date: string; value?: number; count: number; status: string }
type EvalToolFact = { name: string; output: Record<string, unknown> | Record<string, unknown>[] };
interface EvalChecks {
  mustInclude?: string[];
  mustSpeak?: string[];
  mustIncludeAny?: string[][];
  mustNotInclude?: string[];
  mustCallTools?: string[];
  mustSucceedTools?: string[];
  journalEvidence?: JournalEvidenceCheck;
  mustSucceedAnyTool?: string[];
  mustNotCallTools?: string[];
  expectWrites?: Record<string, number>;
  maxInputTokens?: number;
  maxFirstTokenMs?: number;
  maxReplyChars?: number;
  minConfirmations?: number;
  maxConfirmations?: number;
  minReceipts?: number;
  confirmationTarget?: { type: string; targetId: string };
  preludeCreatedTasks?: number;
  absentTaskTitle?: string;
  createdTask?: { titleIncludes: string; date: string } &
    ({ time: string; endTime?: never } | { endTime: string; time?: never });
  createdTaskBatch?: { date: string; notBefore: string; titleIncludes: string[]; unscheduled?: true };
  phoneBatch?: { created: number; existing: number };
  updatedTasks?: Array<{ fromTitleIncludes: string; title: string }>;
  plannedTaskChanges?: { titlePrefix: string; count: number; fromHour: number; date: string };
  mixedTaskOutcome?: { edits: Array<{ from: string; to: string }>; createdTitles: string[]; date: string };
  createdOrClarify?: { titleIncludes: string; dates: string[]; clarify: string[] };
  changedTask?: { id: string; date: string };
  checkin?: EvalCheckin;
  remembered?: (string | string[])[];
  rememberedKind?: string;
  notRemembered?: string[];
  taskPlan?: { date: string; maxTasks: number };
  ideaPlan?: { titleIncludes: string; from: string; to: string; maxSteps: number };
  orderedIncludes?: string[];
  createdTrades?: Record<string, unknown>[];
  toolFacts?: EvalToolFact[];
  anyToolFacts?: EvalToolFact[];
  judge?: string;
}
export interface EvalQuestion {
  id: string;
  milestone: string;
  domain: string;
  mode: "text" | "voice";
  input: string;
  history: { role: "user" | "assistant"; content: string }[];
  fixture?: "without_quiz_cards" | "scheduled_compensation_after_prelude" | "automatic_memory_after_create" | "task_already_undone" | "one_overdue_task" | "device_sleep" | "cross_week_after_correction" | "eleven_task_plans" | "mixed_title_batch" | "sparse_legacy_summary" | "task_interval_meaning" | "source_relative_dates" | "summary_original_memory" | "task_lookup_prose" | "bound_memory_restatement" | "malformed_tool_protocol" | "quoted_diary_memory" | "historical_followup_correction" | "deferred_title_confirmation";
  prelude?: string[];
  afterPreludeHistory?: { role: "user" | "assistant"; content: string }[];
  phoneCaptureDate?: string;
  checks: EvalChecks;
}
export interface EvalObservation {
  journalToolReads?: JournalToolRead[];
  reply: string;
  voiceSpeech?: string;
  tools: { name: string; ok: boolean; detail?: string; facts?: unknown }[];
  writes: Record<string, number>;
  createdTasks: EvalTask[];
  tasks: EvalTask[];
  preparedTasks?: EvalTask[];
  confirmations: number;
  confirmationActions: { type: string; targetIds: string[] }[];
  receipts: number;
  preludeCreatedTasks: number;
  inputTokens?: number;
  firstTokenMs?: number;
  errorCode?: string;
  checkins?: EvalCheckin[];
  activeMemories?: string[];
  activeMemoryRecords?: { kind: string; content: string }[];
  proposedTaskDates?: string[];
  proposedTaskChanges?: Array<{ name: string; arguments: Record<string, unknown> }>;
  proposedIdeaPlans?: { title: string; steps: { date: string; minutes: number }[] }[];
  createdTrades?: Record<string, unknown>[];
  judge?: { passed: boolean; reason: string };
  phoneInbox?: { status: string; sourceUnchanged: boolean; taskBatch?: { created: number; existing: number } };
}

function includesFacts(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(value) && expected.every(item => value.some(candidate => includesFacts(candidate, item)));
  if (expected && typeof expected === "object") return !!value && typeof value === "object"
    && Object.entries(expected).every(([key, item]) => includesFacts((value as Record<string, unknown>)[key], item));
  return value === expected;
}

function hasEquivalentImprovementHeading(reply: string, alternatives: string[]): boolean {
  // This group asks for a next action. A positively labelled improvement with
  // an actual action is equivalent; a mention, quotation or empty heading is not.
  if (alternatives.length !== 4 || !["下一步", "收尾", "后续", "后续动作"].every(label => alternatives.includes(label))) return false;
  return reply.split("\n").some(line => {
    const match = line.match(/^\s*(?:\*\*)?(?:一条)?改进建议(?:[（(][^）)\n]{1,35}[）)])?(?:\*\*)?\s*[：:]\s*(.+)$/u);
    if (!match) return false;
    const action = match[1].replace(/\*\*/gu, "").trim();
    return action.length >= 12 && !/^(?:没有|暂无|无[。！!\s]|无法|不能|不提供|待补|略|[.…]+)/u.test(action)
      && /^(?:给|把|为|设|将|安排|留出|增加|减少|先|每天|建议)/u.test(action);
  });
}

export function shouldRepeatLatencyMeasurement(question: EvalQuestion, observed: { issues: string[]; transportFailures: number }): boolean {
  return question.checks.maxFirstTokenMs !== undefined && observed.transportFailures > 0 && observed.issues.length > 0
    && observed.issues.every(issue => ["首字时间超标", "缺少首字时间", "缺少实际输入 token 用量"].includes(issue));
}

export function scoreEvaluationCase(question: EvalQuestion, observed: EvalObservation): string[] {
  const { checks } = question;
  const issues: string[] = [];
  if (checks.journalEvidence && !hasJournalEvidence(observed.journalToolReads ?? [], checks.journalEvidence)) issues.push("缺少同范围原始日记依据");
  if (checks.mixedTaskOutcome) {
    const plan = checks.mixedTaskOutcome, calls = observed.proposedTaskChanges ?? [];
    const alreadySaved = observed.confirmations === 0 && observed.receipts >= 2
      && observed.writes["tasks.created"] === plan.createdTitles.length && observed.writes["tasks.deleted"] === 0
      && observed.writes["tasks.rescheduled"] === 0 && observed.writes["tasks.timeChanged"] === 0
      && observed.createdTasks.length === plan.createdTitles.length
      && observed.tasks.length === (observed.preparedTasks?.length ?? 0) + plan.createdTitles.length
      && plan.edits.every(edit => {
        return observed.preparedTasks?.filter(row => row.title === edit.from).length === 1;
      }) && (observed.preparedTasks ?? []).every(before => {
        const current = observed.tasks.find(row => row.id === before.id);
        const title = plan.edits.find(edit => edit.from === before.title)?.to ?? before.title;
        if (!current || current.title !== title) return false;
        const { updatedAt: _old, ...old } = before as unknown as Record<string, unknown>;
        const { updatedAt: _new, ...next } = current as unknown as Record<string, unknown>;
        return recordRevision({ ...old, title }) === recordRevision(next);
      }) && plan.createdTitles.every(title => observed.createdTasks.filter(row => row.title === title && row.date === plan.date).length === 1);
    const updates = calls.filter(call => call.name === "update_tasks").flatMap(call => Array.isArray(call.arguments.updates) ? call.arguments.updates : []);
    const creates = calls.filter(call => call.name === "create_task");
    const safelyPrepared = observed.confirmations === 1 && observed.receipts === 0
      && recordRevision(observed.tasks) === recordRevision(observed.preparedTasks ?? [])
      && ["tasks.created", "tasks.deleted", "tasks.rescheduled", "tasks.timeChanged"].every(key => observed.writes[key] === 0);
    if (!alreadySaved && (!safelyPrepared || calls.some(call => !["update_tasks", "create_task"].includes(call.name)) || updates.length !== plan.edits.length
      || plan.edits.some(edit => {
        const originals = observed.preparedTasks?.filter(row => row.title === edit.from) ?? [];
        const rows = updates.filter(row => row?.taskIdOrTitle === originals[0]?.id);
        return originals.length !== 1 || rows.length !== 1 || rows[0].title !== edit.to || rows[0].expectedRevision !== recordRevision(originals[0])
          || Object.keys(rows[0]).some(key => !["taskIdOrTitle", "title", "expectedRevision"].includes(key));
      }) || creates.length !== plan.createdTitles.length || plan.createdTitles.some(title => {
        const rows = creates.filter(call => call.arguments.title === title);
        return rows.length !== 1 || normalizeJournalDate(String(rows[0].arguments.date)) !== plan.date;
      }))) issues.push("混合任务既未全部保存并核对，也未完整保留在同一待确认计划");
  }
  if (checks.plannedTaskChanges) {
    const plan = checks.plannedTaskChanges;
    const originals = observed.preparedTasks?.filter(row => row.title.startsWith(plan.titlePrefix)).sort((a, b) => a.title.localeCompare(b.title)) ?? [];
    const calls = observed.proposedTaskChanges ?? [], updates = calls[0]?.arguments.updates;
    const rows = Array.isArray(updates) ? updates as Array<Record<string, unknown>> : [];
    if (calls.length !== 1 || calls[0].name !== "update_tasks" || originals.length !== plan.count || rows.length !== plan.count
      || originals.some((before, index) => {
        const matching = rows.filter(row => row.taskIdOrTitle === before.id);
        if (matching.length !== 1) return true;
        const row = matching[0], hour = String(plan.fromHour + index).padStart(2, "0");
        return row.startTime !== hour + ":00" || row.endTime !== hour + ":30"
          || row.expectedRevision !== recordRevision(before)
          || row.date !== undefined && normalizeJournalDate(String(row.date)) !== plan.date
          || Object.keys(row).some(key => !["taskIdOrTitle", "startTime", "endTime", "date", "expectedRevision"].includes(key));
      })) issues.push("完整计划未在一份绑定原任务版本的确认卡中准备齐全");
  }
  for (const edit of checks.updatedTasks ?? []) {
    const originals = observed.preparedTasks?.filter(task => task.title.includes(edit.fromTitleIncludes)) ?? [];
    const prior = originals.length === 1 ? originals[0] : undefined;
    const current = prior && observed.tasks.find(task => task.id === prior.id);
    if (!prior || current?.title !== edit.title
      || (["date", "time", "startTime", "endTime", "dueDate"] as const).some(key => (current?.[key] ?? "") !== (prior?.[key] ?? ""))) {
      issues.push("任务内容未按原编号及原安排更正：" + edit.fromTitleIncludes);
    }
  }
  if (checks.createdTaskBatch) {
    const batch = checks.createdTaskBatch;
    if (observed.createdTasks.length !== batch.titleIncludes.length
      || !batch.titleIncludes.every(title => observed.createdTasks.some(task => task.title.includes(title)))
      || observed.createdTasks.some(task => task.date !== batch.date
        || batch.unscheduled && !!(task.time || task.startTime || task.endTime)
        || !!task.startTime !== !!task.endTime
        || task.startTime && (task.startTime < batch.notBefore || task.endTime! <= task.startTime))
      || !batch.unscheduled && observed.createdTasks.some(task => !task.startTime) && !observed.reply.includes("延后风险")) issues.push("批量任务名称、日期或排程不符");
  }
  if (checks.phoneBatch) {
    const row = observed.phoneInbox;
    if (row?.status !== "saved" || !row.sourceUnchanged || !includesFacts(row.taskBatch, checks.phoneBatch)) {
      issues.push("手机原文、整批保存状态或实际数量回执未核对通过");
    }
  }
  if (observed.errorCode) issues.push("运行错误 " + observed.errorCode);
  for (const phrase of checks.mustInclude ?? []) {
    if (!observed.reply.includes(phrase)) issues.push("缺少内容 " + phrase);
  }
  for (const phrase of checks.mustSpeak ?? []) {
    if (!observed.voiceSpeech?.includes(phrase)) issues.push("播报缺少内容 " + phrase);
  }
  for (const alternatives of checks.mustIncludeAny ?? []) {
    if (!alternatives.some((phrase) => observed.reply.includes(phrase)) && !hasEquivalentDateAlias(observed.reply, alternatives)
      && !hasEquivalentImprovementHeading(observed.reply, alternatives)) issues.push("缺少同义内容 " + alternatives.join(" / "));
  }
  for (const phrase of checks.mustNotInclude ?? []) {
    if (observed.reply.includes(phrase)) issues.push("包含禁止内容 " + phrase);
  }
  for (const name of checks.mustCallTools ?? []) {
    if (!observed.tools.some((tool) => tool.name === name)) issues.push("未调用工具 " + name);
  }
  for (const name of checks.mustSucceedTools ?? []) {
    if (!observed.tools.some(tool => tool.name === name && tool.ok)) issues.push("工具未成功完成 " + name);
  }
  const alternatives = checks.mustSucceedAnyTool ?? [];
  if (alternatives.length && !observed.tools.some(tool => tool.ok && alternatives.includes(tool.name))) {
    issues.push("没有成功查询 " + alternatives.join(" / "));
  }
  const hasToolFact = (tool: EvalToolFact) => observed.tools.some(item => item.name === tool.name && item.ok && includesFacts(item.facts, tool.output));
  for (const tool of checks.toolFacts ?? []) {
    if (!hasToolFact(tool)) issues.push("工具读回的范围或统计不符 " + tool.name);
  }
  if (checks.anyToolFacts?.length && !checks.anyToolFacts.some(hasToolFact)) {
    issues.push("工具没有读回可核对的范围和统计 " + checks.anyToolFacts.map(tool => tool.name).join(" / "));
  }
  if (checks.createdTrades && !includesFacts(observed.createdTrades, checks.createdTrades)) issues.push("新建交易的字段与原话不符");
  if (checks.judge && !observed.judge?.passed) issues.push("裁判题未通过 " + (observed.judge?.reason ?? "未返回判断"));
  if (checks.orderedIncludes) {
    let position = -1;
    for (const phrase of checks.orderedIncludes) {
      position = observed.reply.indexOf(phrase, position + 1);
      if (position < 0) { issues.push("回复的顺序或内容不符 " + checks.orderedIncludes.join("、")); break; }
    }
  }
  for (const name of checks.mustNotCallTools ?? []) {
    if (observed.tools.some((tool) => tool.name === name)) issues.push("调用了禁止工具 " + name);
  }
  for (const [name, expected] of Object.entries(checks.expectWrites ?? {})) {
    if (observed.writes[name] !== expected) issues.push(`写入数量 ${name} 期望 ${expected}，实际 ${observed.writes[name] ?? "未知"}`);
  }
  if (checks.createdTask) {
    const expected = checks.createdTask;
    const matched = observed.createdTasks.some((task) => task.title.includes(expected.titleIncludes)
      && task.date === expected.date && (expected.endTime === undefined
        ? (task.startTime || task.time) === expected.time
        : task.endTime === expected.endTime && !task.startTime && !task.time));
    if (!matched) issues.push("新建任务的标题、日期或时间不符");
  }
  if (checks.createdOrClarify) {
    const { titleIncludes, dates, clarify } = checks.createdOrClarify;
    const created = observed.createdTasks.length === 1 && observed.receipts > 0
      && observed.createdTasks[0].title.includes(titleIncludes) && dates.includes(observed.createdTasks[0].date);
    const reply = observed.reply.replace(/\*\*/g, "").replace(/((?:周|星期)[六日天])[（(]\d{1,2}月\d{1,2}日[）)]/g, "$1");
    const namedWeekendDays = /(?:周|星期)六/.test(reply) && /(?:周|星期)[日天]/.test(reply);
    const weekendChoice = namedWeekendDays && /哪[一两]?[天日]|[选挑]一个/.test(reply)
      || /周末有(?:两|二|2)天[，,。]\s*(?:你|您)?(?:想|希望)哪一?[天日]/u.test(reply);
    const asked = observed.createdTasks.length === 0 && (weekendChoice || clarify.some(phrase => reply.includes(phrase)));
    if (!created && !asked) issues.push("没有在有效周末建任务或询问具体日期");
  }
  if (checks.changedTask && !observed.tasks.some(task => task.id === checks.changedTask!.id && task.date === checks.changedTask!.date)) {
    issues.push("原任务的日期没有按要求更新");
  }
  if (checks.checkin) {
    const expected = checks.checkin;
    if (!observed.checkins?.some(item => item.habitId === expected.habitId && item.date === expected.date
      && item.status === expected.status && item.count === expected.count && item.value === expected.value)) {
      issues.push("未读回指定习惯、日期、次数和实际数值");
    }
  }
  if (checks.remembered && !observed.activeMemories?.some(content => checks.remembered!.every(phrase =>
    (typeof phrase === "string" ? [phrase] : phrase).some(word => content.includes(word))))) {
    issues.push("未读回有效的个人记忆");
  }
  if (checks.rememberedKind && !observed.activeMemoryRecords?.some(record => record.kind === checks.rememberedKind
    && checks.remembered?.every(phrase => (typeof phrase === "string" ? [phrase] : phrase).some(word => record.content.includes(word))))) {
    issues.push("未在指定类别读回同一条有效记忆");
  }
  if (checks.notRemembered && (!Array.isArray(observed.activeMemories)
    || checks.notRemembered.some(phrase => observed.activeMemories!.some(content => content.includes(phrase))))) {
    issues.push("未证实指定内容已排除在可用个人记忆之外");
  }
  if (checks.taskPlan) {
    const proposed = observed.proposedTaskDates ?? [];
    if (proposed.length < 1 || proposed.length > checks.taskPlan.maxTasks || proposed.some(date => date !== checks.taskPlan!.date)) {
      issues.push("确认卡日期或任务数量超出预期");
    }
  }
  if (checks.ideaPlan) {
    const expected = checks.ideaPlan, plans = observed.proposedIdeaPlans ?? [];
    if (plans.length !== 1 || !plans[0].title.includes(expected.titleIncludes) || !plans[0].steps.length
      || plans[0].steps.length > expected.maxSteps || plans[0].steps.some(step =>
        step.date < expected.from || step.date > expected.to || step.minutes < 1 || step.minutes > 120)) {
      issues.push("想法确认卡的目标、日期或任务时长不符");
    }
  }
  if (checks.absentTaskTitle && observed.tasks.some((task) => task.title.includes(checks.absentTaskTitle!))) issues.push("撤销后任务仍存在");
  if (checks.preludeCreatedTasks !== undefined && observed.preludeCreatedTasks !== checks.preludeCreatedTasks) issues.push("前置建任务未完成");
  if (checks.minConfirmations !== undefined && observed.confirmations < checks.minConfirmations) issues.push("缺少确认卡");
  if (checks.maxConfirmations !== undefined && observed.confirmations > checks.maxConfirmations) issues.push("确认卡数量超出预期");
  if (checks.confirmationTarget) {
    const target = checks.confirmationTarget;
    if (!observed.confirmationActions.some((action) => action.type === target.type
      && action.targetIds.length === 1 && action.targetIds[0] === target.targetId)) {
      issues.push("确认卡类型或目标不符，实际 " + (observed.confirmationActions.map((action) => action.type).join("、") || "无"));
    }
  }
  if (checks.minReceipts !== undefined && observed.receipts < checks.minReceipts) issues.push("缺少写入回执");
  if (checks.maxReplyChars !== undefined && Array.from(observed.reply).length > checks.maxReplyChars) issues.push("回复过长");
  if (checks.maxInputTokens !== undefined) {
    if (observed.inputTokens === undefined) issues.push("缺少实际输入 token 用量");
    else if (observed.inputTokens > checks.maxInputTokens) issues.push("输入 token 超标");
  }
  if (checks.maxFirstTokenMs !== undefined) {
    if (observed.firstTokenMs === undefined) issues.push("缺少首字时间");
    else if (observed.firstTokenMs > checks.maxFirstTokenMs) issues.push("首字时间超标");
  }
  return issues;
}
