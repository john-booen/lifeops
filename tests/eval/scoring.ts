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
  createdTaskBatch?: { date: string; notBefore: string; titleIncludes: string[] };
  createdOrClarify?: { titleIncludes: string; dates: string[]; clarify: string[] };
  changedTask?: { id: string; date: string };
  checkin?: EvalCheckin;
  remembered?: (string | string[])[];
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
  fixture?: "without_quiz_cards" | "scheduled_compensation_after_prelude" | "automatic_memory_after_create" | "task_already_undone" | "one_overdue_task" | "device_sleep";
  prelude?: string[];
  checks: EvalChecks;
}
export interface EvalObservation {
  reply: string;
  voiceSpeech?: string;
  tools: { name: string; ok: boolean; detail?: string; facts?: unknown }[];
  writes: Record<string, number>;
  createdTasks: EvalTask[];
  tasks: EvalTask[];
  confirmations: number;
  confirmationActions: { type: string; targetIds: string[] }[];
  receipts: number;
  preludeCreatedTasks: number;
  inputTokens?: number;
  firstTokenMs?: number;
  errorCode?: string;
  checkins?: EvalCheckin[];
  activeMemories?: string[];
  proposedTaskDates?: string[];
  proposedIdeaPlans?: { title: string; steps: { date: string; minutes: number }[] }[];
  createdTrades?: Record<string, unknown>[];
  judge?: { passed: boolean; reason: string };
}

function includesFacts(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(value) && expected.every(item => value.some(candidate => includesFacts(candidate, item)));
  if (expected && typeof expected === "object") return !!value && typeof value === "object"
    && Object.entries(expected).every(([key, item]) => includesFacts((value as Record<string, unknown>)[key], item));
  return value === expected;
}

export function shouldRepeatLatencyMeasurement(question: EvalQuestion, observed: { issues: string[]; transportFailures: number }): boolean {
  return question.checks.maxFirstTokenMs !== undefined && observed.transportFailures > 0 && observed.issues.length > 0
    && observed.issues.every(issue => ["首字时间超标", "缺少首字时间", "缺少实际输入 token 用量"].includes(issue));
}

export function scoreEvaluationCase(question: EvalQuestion, observed: EvalObservation): string[] {
  const { checks } = question;
  const issues: string[] = [];
  if (checks.createdTaskBatch) {
    const batch = checks.createdTaskBatch;
    if (observed.createdTasks.length !== batch.titleIncludes.length
      || !batch.titleIncludes.every(title => observed.createdTasks.some(task => task.title.includes(title)))
      || observed.createdTasks.some(task => task.date !== batch.date
        || !!task.startTime !== !!task.endTime
        || task.startTime && (task.startTime < batch.notBefore || task.endTime! <= task.startTime))
      || observed.createdTasks.some(task => !task.startTime) && !observed.reply.includes("延后风险")) issues.push("批量任务名称、日期或排程不符");
  }
  if (observed.errorCode) issues.push("运行错误 " + observed.errorCode);
  for (const phrase of checks.mustInclude ?? []) {
    if (!observed.reply.includes(phrase)) issues.push("缺少内容 " + phrase);
  }
  for (const phrase of checks.mustSpeak ?? []) {
    if (!observed.voiceSpeech?.includes(phrase)) issues.push("播报缺少内容 " + phrase);
  }
  for (const alternatives of checks.mustIncludeAny ?? []) {
    if (!alternatives.some((phrase) => observed.reply.includes(phrase))) issues.push("缺少同义内容 " + alternatives.join(" / "));
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
