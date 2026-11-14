import { Notice } from "obsidian";
import { contextDataPolicy, dashboardContextData } from "../../contextData";
import { addDays, formatDate } from "../../date";
import { LIFEOPS_VIEW_TYPE, LifeOpsView } from "../../lifeOpsView";
import { decideProactiveDelivery, recordProactiveDelivery, type ProactivePolicyState, type ProactiveTone } from "../../proactivePolicy";
import { stewardCandidate, stewardReminderWindows, type ProactiveCandidate } from "../../scheduler";
import type { StoreHost } from "../../store/settingsSlice";
import type { TaskDashboardData } from "../../types";
import { ideaDaysStalled, listIdeas } from "../ideas/notes";
import { ideaIsStalled, ideaRemindersSinceProgress, recordIdeaReminder } from "../ideas/progress";
import { advanceCompensationDebt, compensationSummaryLine, summarizeCompensationDebt } from "../habits/compensationDebt";
import { isHabitRequiredOn } from "../habits/targets";
import { readHealthDay } from "../health/store";
import { readJournalSignals } from "../journal/signalStore";
import { effectiveLearningTrack } from "../learning/model";
import { countDueQuizCards } from "../learning/quiz";
import { readLearningDocument, visibleLearningTrack } from "../learning/store";
import { buildTodayCard } from "../today/model";
import { readSummary, readSummaryScope } from "../summaries/notes";
import { summaryPeriod } from "../summaries/periods";
import { readStats } from "../stats/tools";
import type { ReviewHost } from "./service";

interface OverloadAlert { taskId: string; reason: string; at: Date }
type Runtime = { openedAt: Date; overload?: OverloadAlert };
const runtimes = new WeakMap<ReviewHost, Runtime>();

export function startStewardReminders(host: ReviewHost, openedAt = new Date()): void {
  runtimes.set(host, { openedAt });
  host.proactiveLifecycle.schedule(0);
}

export function queueTaskOverload(host: ReviewHost, taskId: string, reason: string, now = new Date()): void {
  const runtime = runtimes.get(host);
  if (!runtime || host.unloaded || !host.settings.proactive.enabled || !reason.trim()) return;
  runtime.overload = { taskId, reason: reason.trim(), at: now };
  host.proactiveLifecycle.schedule(0);
}

function firstOpenOnDay(stored: string | undefined, openedAt: Date, now: Date): string | undefined {
  const today = formatDate(now);
  if (stored && formatDate(new Date(stored)) === today) return stored;
  return formatDate(openedAt) === today ? openedAt.toISOString() : stored;
}

function advice(facts: string, tone: ProactiveTone | undefined, next: string): string {
  return facts + (tone === "gentle" ? " 可以先" + next + "。"
    : tone === "strict" ? " 先处理这一步：" + next + "。"
    : " 建议" + next + "。");
}

async function morningReason(store: StoreHost, board: TaskDashboardData, now: Date): Promise<string> {
  const [signals, due, health] = await Promise.all([
    readJournalSignals(store, board.date).catch(() => []),
    countDueQuizCards(store, board.date).catch(() => null),
    readHealthDay(store, board.date).catch(() => undefined)
  ]);
  const card = buildTodayCard(board, signals, now, health);
  const context = dashboardContextData(board);
  const status = card.status.map(item => item.label + item.value).join("，");
  const deviceSleep = health?.sleepHours === undefined ? "" : "，设备睡眠 " + health.sleepHours + " 小时";
  const load = context?.tasks.available === false ? "任务记录暂不可用"
    : card.capacity.typicalCount === null ? "近期完成记录不足，暂无法判断任务负荷"
    : card.capacity.overloaded ? "当前任务超载" : "当前任务未超载";
  const priorities = card.priorities.map(item => item.title).join("、");
  const priorityLine = context?.tasks.available === false ? "" : priorities ? "优先做：" + priorities + "。" : "暂无可排序的任务。";
  const day = formatDate(now);
  const tasks = advanceCompensationDebt(board.tasks, board.habits.map(item => item.habit), day, store.settings.habitCompensation);
  const debt = compensationSummaryLine(summarizeCompensationDebt(tasks, day));
  const compensation = context?.tasks.available === false ? "补偿欠账暂时无法核对。"
    : debt ? "补偿" + debt.replaceAll(" · ", "，") + "。" : "目前没有未完成的补偿。";
  const scope = context?.tasks.filtered ? "仅核对可读任务。" : "";
  return scope + compensation + status + deviceSleep + "。" + load + "。" + priorityLine
    + (due === null ? "复习卡暂不可用。" : "到期复习卡 " + due + " 张。");
}

function eveningReason(board: TaskDashboardData): string {
  const context = dashboardContextData(board);
  const habits = board.habits.filter(item => item.habit.source !== "trades" && isHabitRequiredOn(item.habit, board.date));
  const excusedHabits = habits.filter(item => item.status === "leave").length;
  const missingHabits = habits.filter(item => item.status !== "leave" && item.healthUnrecorded).length;
  const recordedHabits = habits.filter(item => item.status !== "leave" && !item.healthUnrecorded);
  const trades = board.habits.filter(item => item.habit.source === "trades" && (item.requiredToday
    || item.periodUnavailable && isHabitRequiredOn(item.habit, board.date)));
  const tradeProgress = trades.map(item => item.habit.name + " " + (item.periodUnavailable ? "暂不可用"
    : item.periodDone + "/" + item.periodTarget + (item.periodUnit ?? "笔"))).join("、");
  const penalties = board.tasks.filter(task => task.status === "active" && task.habitPunishment?.judgedDate === board.date);
  const tasks = [...new Map([...board.today, ...board.overdue].map(task => [task.id, task])).values()];
  const examples = tasks.slice(0, 3).map(task => task.title).join("、");
  const taskLine = context?.tasks.available === false ? "任务和补偿记录暂不可用。"
    : (context?.tasks.filtered ? "可读任务中还有 " : "还有 ") + tasks.length + " 项今日或逾期任务"
      + (examples ? "，包括" + examples + "。" : "。")
      + (penalties.length ? "今天新生成 " + penalties.length + " 项补偿：" + penalties.map(task => task.title).slice(0, 3).join("、") + "。"
        : "今天暂无新补偿。");
  if (context?.habits.available === false) return taskLine + "习惯和交易目标记录暂不可用。";
  const habitLine = recordedHabits.length
    ? "习惯已完成 " + recordedHabits.filter(item => item.status === "done").length + "/" + recordedHabits.length + " 项。" : "";
  const leaveLine = excusedHabits ? excusedHabits + " 项习惯已请假。" : "";
  const missingLine = missingHabits ? missingHabits + " 项设备习惯缺少读数。" : "";
  return taskLine + (tradeProgress ? "交易目标 " + tradeProgress + "。" : "今日没有待核对的交易目标。")
    + (habits.length ? habitLine + leaveLine + missingLine : "今日没有需核对的习惯。");
}

async function weeklyPlan(store: StoreHost, now: Date) {
  const today = formatDate(now), nextWeek = addDays(today, 1);
  const [doc, scope, tasks] = await Promise.all([readLearningDocument(store), readSummaryScope(store),
    readStats(store, { domain: "tasks", range: "this_week" }, now)]);
  const report = await readSummary(store, summaryPeriod("week", today), scope.hash);
  const plans = doc.tracks.map(track => visibleLearningTrack(store, effectiveLearningTrack(track, nextWeek)))
    .filter(track => track.weeklyMinutes > 0)
    .map(track => track.name + " " + track.weeklyMinutes + " 分钟").join("、");
  const completed = report?.properties.metrics.tasksCompleted ?? (tasks.success ? JSON.parse(tasks.output).completedCount : undefined);
  const summary = typeof completed === "number" ? "本周已完成 " + completed + " 项任务。" : "本周任务数据暂不可用。";
  return {
    text: summary + (report ? "本周摘要已可查看。" : "本周摘要预计 21:30 生成。")
      + (plans ? "下周学习计划：" + plans + "。可以在学习页调整。" : "下周学习时长还没有设置，可以在学习页安排。"),
    summaryPath: report?.path
  };
}

export async function collectStewardCandidates(store: StoreHost, state: ProactivePolicyState, now: Date,
  tone: ProactiveTone | undefined, overload?: OverloadAlert): Promise<ProactiveCandidate[]> {
  const date = formatDate(now), windows = stewardReminderWindows(now, state.firstOpen);
  const due = (kind: ProactiveCandidate["kind"]) => !state.mutedKinds.includes(kind)
    && !state.deliveries.some(row => row.dedupeKey === kind + ":" + date);
  const morning = windows.morning && due("daily_brief"), evening = windows.evening && due("evening_review");
  const [board, ideas, week] = await Promise.all([
    morning || evening ? store.getTaskDashboard(date, { forContext: true }) : undefined,
    windows.idea && due("stalled_idea") ? listIdeas(store) : [],
    windows.weekly && due("weekly_review") ? weeklyPlan(store, now) : undefined
  ]);
  const candidates: ProactiveCandidate[] = [];
  if (overload && windows.overload && formatDate(overload.at) === date) {
    candidates.push(stewardCandidate(now, "task_overload", "任务超载", advice(overload.reason, tone, "推迟或拆小一项"),
      { key: overload.taskId, priority: "high" }));
  }
  if (board && morning) candidates.push(stewardCandidate(now, "daily_brief", "早间简报", await morningReason(store, board, now), { voiceEligible: true }));
  if (board && evening) {
    const reason = eveningReason(board);
    const reminder = dashboardContextData(board)?.tasks.available === false ? reason : advice(reason, tone, "把还没做完的任务过一遍");
    candidates.push(stewardCandidate(now, "evening_review", "晚间检查", reminder));
  }
  if (week) candidates.push(stewardCandidate(now, "weekly_review", "周日计划", week.text, { summaryPath: week.summaryPath }));
  const idea = ideas.filter(item => ideaIsStalled(item, date)).sort((left, right) => left.lastProgress.localeCompare(right.lastProgress)
    || left.created.localeCompare(right.created))[0];
  if (idea) {
    const urgent = ideaRemindersSinceProgress(idea, date).length >= 3;
    candidates.push(stewardCandidate(now, "stalled_idea", "想法进展", "「" + idea.title + "」已有 " + ideaDaysStalled(idea.lastProgress, date) + " 天没有进展。",
      { ideaId: idea.ideaId, priority: urgent ? "high" : "normal" }));
  }
  return candidates;
}

export async function runStewardReminders(host: ReviewHost, now = new Date()): Promise<void> {
  const runtime = runtimes.get(host);
  if (!runtime || !host.settings.proactive.enabled || host.proactiveCycleRunning) return;
  const generation = host.proactiveLifecycle.generation;
  const ownerStore = host.store;
  const store = ownerStore as unknown as StoreHost;
  const dataPolicy = contextDataPolicy(store);
  const active = () => !host.unloaded && host.settings.proactive.enabled && host.proactiveLifecycle.isCurrent(generation);
  const ownsCycle = () => active() && host.store === ownerStore && contextDataPolicy(store) === dataPolicy;
  const current = () => {
    if (!ownsCycle()) throw Error("主动提醒已停止。");
  };
  host.proactiveCycleRunning = true;
  try {
    const prior = await store.readProactivePolicyState();
    const firstOpen = firstOpenOnDay(prior.firstOpen, runtime.openedAt, now);
    const candidates = await collectStewardCandidates(store, { ...prior, firstOpen }, now, host.settings.proactive.tone, runtime.overload);
    current();
    if (prior.firstOpen === firstOpen && !candidates.some(item => decideProactiveDelivery(item, prior, host.settings.proactive, now).deliver)) return;
    const delivered: ProactiveCandidate[] = [];
    await host.saveLocalOperation("scheduled_steward_reminders", { date: formatDate(now) }, async scope => {
      const persisted = await scope.readProactivePolicyState();
      const started = firstOpenOnDay(persisted.firstOpen, runtime.openedAt, now);
      let state: ProactivePolicyState = { ...persisted, firstOpen: started };
      for (const item of candidates) {
        current();
        const decision = decideProactiveDelivery(item, state, host.settings.proactive, now);
        if (!decision.deliver) continue;
        const candidate = { ...item, channel: decision.channel };
        if (item.ideaId) {
          const reminder = await recordIdeaReminder(scope, item.ideaId, formatDate(now));
          if (!reminder) continue;
          candidate.reason = reminder;
        }
        delivered.push(candidate);
        state = recordProactiveDelivery(state, candidate, decision.channel, now);
      }
      if (delivered.length) await scope.appendProactiveCandidates(delivered);
      if (delivered.length || persisted.firstOpen !== started) await scope.writeProactivePolicyState(state);
    }, { assertCurrent: current });
    current();
    for (const candidate of delivered) {
      try { host.dispatchProactiveCandidate(candidate); } catch { /* The panel record is already saved. */ }
      const decision = { deliver: true, channel: "panel", reason: "steward_reminder" };
      host.lifeOpsEvents.publish({ type: "proactive.candidate", source: "runtime", payload: { candidate, decision } });
      host.lifeOpsEvents.publish({ type: "proactive.delivered", source: "runtime",
        payload: { candidateId: candidate.id, requestedChannel: decision.channel, channel: decision.channel, reason: decision.reason } });
      if (candidate.kind === "task_overload" && runtime.overload && candidate.dedupeKey.endsWith(":" + runtime.overload.taskId)) runtime.overload = undefined;
    }
    if (delivered.length) await host.refreshViews().catch(() => undefined);
  } catch {
    if (ownsCycle()) console.warn("LifeOps 主动提醒暂时无法保存，下次会重试。");
    else if (active()) host.proactiveLifecycle.schedule(0);
  } finally { host.proactiveCycleRunning = false; }
}

export function deliverStewardReminder(host: ReviewHost, candidate: ProactiveCandidate): void {
  new Notice(candidate.title + "\n" + candidate.reason, 10_000);
  if (!candidate.voiceEligible || host.settings.realtimeVoice.speakReplies !== true) return;
  const view = host.app.workspace.getLeavesOfType(LIFEOPS_VIEW_TYPE)[0]?.view;
  if (view instanceof LifeOpsView) view.speakStewardReminder(candidate.title + "。" + candidate.reason);
}

export async function withWeeklySummary(store: StoreHost, candidates: ProactiveCandidate[]): Promise<ProactiveCandidate[]> {
  if (!candidates.some(item => item.steward && item.kind === "weekly_review")) return candidates;
  const scope = await readSummaryScope(store);
  return Promise.all(candidates.map(async item => {
    if (!item.steward || item.kind !== "weekly_review") return item;
    const note = await readSummary(store, summaryPeriod("week", formatDate(new Date(item.createdAt))), scope.hash);
    const reason = item.reason.replace(/本周摘要(?:已可查看|预计 21:30 生成)。/,
      note ? "本周摘要已可查看。" : "本周摘要暂未生成。");
    return { ...item, reason, summaryPath: note?.path };
  }));
}
