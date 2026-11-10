import { addDays, datesBetween, formatDate, normalizeJournalDate, startOfWeek } from "../../date";
import type { HabitCheckin, HabitDefinition, LifeOpsTask } from "../../types";
import { JOURNAL_SIGNAL_FIELDS, type SignalValues } from "../journal/signals";
import { habitMeasurementUnit, habitRecordedAmount, isHabitRequiredOn, numericHabitGoalProgress } from "../habits/targets";
import type { Trade } from "../trading/types";
import type { IdeaNote } from "../ideas/notes";
import type { LearningTrack } from "../learning/model";
import { tradeStats, type TradeStatGroup, type TradeStatsSettings } from "./trades";

export type StatsDomain = "tasks" | "habits" | "journal" | "trades" | "ideas" | "learning";
export const statsNamedRanges = ["today", "last_3d", "this_week", "last_week", "last_7d", "this_month", "last_month", "last_30d"] as const;
export type StatsRange = { from: string; to: string } | typeof statsNamedRanges[number];
export type StatsGroup = "category" | TradeStatGroup;
export interface StatsRequest {
  domain: StatsDomain;
  range: StatsRange;
  groupBy?: StatsGroup;
  combineUsd?: boolean;
}

export interface JournalStatsEntry {
  date: string;
  signals?: Partial<SignalValues>;
}

export interface StatsData {
  tasks?: readonly LifeOpsTask[];
  habits?: readonly HabitDefinition[];
  checkins?: readonly HabitCheckin[];
  journal?: readonly JournalStatsEntry[];
  trades?: readonly Trade[];
  tradeSettings?: TradeStatsSettings;
  ideas?: readonly (Pick<IdeaNote, "created" | "lastProgress" | "status"> & { stalled: boolean })[];
  learning?: readonly LearningTrack[];
}

type DayRange = { from: string; to: string };
type DateGrouping = "day" | "week";
type Completion = { task: LifeOpsTask; date: string; elapsedMin: number | null };

const round = (value: number) => Math.round(value * 100) / 100;
const mean = (values: number[]) => values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
const percent = (done: number, target: number) => target ? round(done / target * 100) : null;
const inRange = (date: string, range: DayRange) => date >= range.from && date <= range.to;
const dateKey = (date: string, group: DateGrouping) => group === "week" ? startOfWeek(date) : date;

export function resolveStatsRange(range: StatsRange, now: Date): DayRange {
  if (!Number.isFinite(now.getTime())) throw Error("统计时间无效。");
  const today = formatDate(now);
  if (typeof range === "object" && range !== null) {
    const { from, to } = range;
    if (typeof from !== "string" || typeof to !== "string"
      || normalizeJournalDate(from, today) !== from || normalizeJournalDate(to, today) !== to || !from || from > to) {
      throw Error("统计区间需要有效的起止日期，开始日期不能晚于结束日期。");
    }
    return { from, to };
  }
  if (range === "last_week") {
    const to = addDays(startOfWeek(today), -1);
    return { from: addDays(to, -6), to };
  }
  if (range === "last_month") {
    const to = addDays(today.slice(0, 7) + "-01", -1);
    return { from: to.slice(0, 7) + "-01", to };
  }
  const start = {
    today, last_3d: addDays(today, -2), this_week: startOfWeek(today), last_7d: addDays(today, -6),
    this_month: today.slice(0, 7) + "-01", last_30d: addDays(today, -29)
  };
  if (!Object.hasOwn(start, range)) throw Error("不支持这个统计区间。");
  return { from: start[range], to: today };
}

export function getStats(request: StatsRequest, data: StatsData, now: Date) {
  const range = resolveStatsRange(request.range, now);
  const { domain, groupBy } = request;
  const group = groupBy === "day" || groupBy === "week" ? groupBy : undefined;
  switch (domain) {
    case "tasks": return { domain, range, ...taskStats(data.tasks ?? [], range, now, group) };
    case "habits": return { domain, range, ...habitStats(data.habits ?? [], data.checkins ?? [], range, now, group) };
    case "journal": return { domain, range, ...journalStats(data.journal ?? [], range, group) };
    case "trades": return { domain, range, ...tradeStats(data.trades ?? [], range, groupBy as TradeStatGroup | undefined, data.tradeSettings, request.combineUsd) };
    case "ideas": return { domain, range, ...ideaStats(data.ideas ?? [], range, group) };
    case "learning": return { domain, range, ...learningStats(data.learning ?? [], range, group) };
  }
}

function learningStats(tracks: readonly LearningTrack[], range: DayRange, group?: DateGrouping) {
  return { tracks: tracks.map(track => {
    const sessions = track.sessions.filter(session => inRange(session.date, range));
    const completedUnits = track.units.filter(unit => unit.status === "done").length;
    const totals = (entries: readonly LearningTrack["sessions"][number][]) => ({
      sessions: entries.length, minutes: entries.reduce((total, session) => total + (session.minutes ?? 0), 0),
      sessionsWithoutMinutes: entries.filter(session => session.minutes === undefined).length
    });
    const byDate = new Map<string, typeof sessions>();
    if (group) for (const session of sessions) {
      const date = dateKey(session.date, group), bucket = byDate.get(date) ?? [];
      bucket.push(session);
      byDate.set(date, bucket);
    }
    return { id: track.id, name: track.name, ...totals(sessions), completedUnits, totalUnits: track.units.length,
      completionPercent: percent(completedUnits, track.units.length), weeklyMinutes: track.weeklyMinutes || null,
      ...(group ? { groups: [...byDate.keys()].sort().map(date => ({ date, ...totals(byDate.get(date)!) })) } : {}) };
  }) };
}

function ideaStats(ideas: NonNullable<StatsData["ideas"]>, range: DayRange, group?: DateGrouping) {
  const currentByStatus: Record<string, number> = {};
  const buckets = new Map<string, { created: number; progressed: number }>();
  let created = 0, progressed = 0;
  const count = (date: string, kind: "created" | "progressed") => {
    if (!inRange(date, range)) return;
    if (kind === "created") created++;
    else progressed++;
    if (group) {
      const key = dateKey(date, group), bucket = buckets.get(key) ?? { created: 0, progressed: 0 };
      bucket[kind]++;
      buckets.set(key, bucket);
    }
  };
  for (const idea of ideas) {
    currentByStatus[idea.status] = (currentByStatus[idea.status] ?? 0) + 1;
    count(idea.created, "created");
    if (idea.lastProgress > idea.created) count(idea.lastProgress, "progressed");
  }
  return { currentByStatus, stalled: ideas.filter(idea => idea.stalled).length, created, progressed,
    ...(group ? { groups: [...buckets.keys()].sort().map(date => ({ date, ...buckets.get(date)! })) } : {}) };
}

export function taskCompletionEvents(tasks: readonly LifeOpsTask[], range: DayRange, now: Date): Completion[] {
  return tasks.flatMap(task => {
    const recorded = new Set((task.completionLog ?? []).map(event => event.completedAt));
    if (task.status === "completed" && task.completedAt) recorded.add(task.completedAt);
    const createdAt = Date.parse(task.createdAt);
    return [...recorded].flatMap(value => {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return [];
      const stamp = Date.parse(value);
      if (!Number.isFinite(stamp) || stamp > now.getTime() || Number(value.slice(11, 13)) > 23
        || !normalizeJournalDate(value.slice(0, 10), range.to)) return [];
      const date = formatDate(new Date(stamp));
      if (!inRange(date, range)) return [];
      return [{ task, date, elapsedMin: Number.isFinite(createdAt) && createdAt <= stamp ? (stamp - createdAt) / 60_000 : null }];
    });
  });
}

export function todayTaskCounts(tasks: readonly LifeOpsTask[], date: string, now: Date) {
  const completed = new Set(taskCompletionEvents(tasks, { from: date, to: date }, now).map(event => event.task.id));
  const planned = tasks.filter(task => task.status !== "abandoned" && (task.date === date || task.dueDate === date)).map(task => task.id);
  return { completed: completed.size, scheduled: new Set(planned).size, total: new Set([...completed, ...planned]).size };
}

function taskTotals(planned: readonly LifeOpsTask[], completed: readonly Completion[], today: string) {
  const completedIds = new Set(completed.map(event => event.task.id));
  const completedPlannedCount = planned.filter(task => completedIds.has(task.id)).length;
  return {
    plannedCount: planned.length, completedCount: completed.length, completedPlannedCount,
    completionPercent: percent(completedPlannedCount, planned.length),
    overdueCount: planned.filter(task => task.status === "active" && (task.dueDate || task.date) < today).length,
    averageCompletionMin: mean(completed.flatMap(event => event.elapsedMin === null ? [] : [event.elapsedMin]))
  };
}

function taskStats(tasks: readonly LifeOpsTask[], range: DayRange, now: Date, group?: DateGrouping) {
  const today = formatDate(now);
  const planned = tasks.filter(task => inRange(task.date || task.dueDate, range));
  const completed = taskCompletionEvents(tasks, range, now);
  const categories = new Set([...planned, ...completed.map(event => event.task)].map(task => task.category || "未分类"));
  const byCategory = Object.fromEntries([...categories].sort().map(category => [category,
    taskTotals(planned.filter(task => (task.category || "未分类") === category),
      completed.filter(event => (event.task.category || "未分类") === category), today)]));
  const groups = group ? [...new Set([...planned.map(task => dateKey(task.date || task.dueDate, group)),
    ...completed.map(event => dateKey(event.date, group))])].sort().map(date => ({
      date, ...taskTotals(planned.filter(task => dateKey(task.date || task.dueDate, group) === date),
        completed.filter(event => dateKey(event.date, group) === date), today)
    })) : undefined;
  return { ...taskTotals(planned, completed, today), byCategory, groups };
}

function habitTotals(habit: HabitDefinition, checkins: NonNullable<StatsData["checkins"]>, days: string[], dailyGroup = false) {
  const required = days.filter(date => isHabitRequiredOn(habit, date));
  const targetPeriods = habit.frequencyUnit === "week" ? new Set(required.map(startOfWeek)).size : required.length;
  const targetCount = dailyGroup && habit.frequencyUnit === "week" ? null : targetPeriods * habit.targetCount;
  const selected = new Set(days);
  const done = checkins.filter(item => item.status === "done" && selected.has(item.date));
  const doneCount = done.reduce((sum, item) => sum + (Number.isFinite(item.count) && item.count > 0 ? item.count : 1), 0);
  const configuredUnit = habit.target?.kind === "number" ? habit.target.unit : undefined;
  const byUnit = new Map<string | undefined, number[]>();
  for (const item of done) {
    if (typeof item.value !== "number" || !Number.isFinite(item.value)) continue;
    const unit = habitMeasurementUnit(item.valueUnit) ?? configuredUnit;
    const values = byUnit.get(unit);
    if (values) values.push(item.value);
    else byUnit.set(unit, [item.value]);
  }
  const measures = [...byUnit].map(([unit, values]) => ({ unit: unit ?? null,
    total: round(values.reduce((sum, value) => sum + value, 0)), average: mean(values) }));
  const totals = { doneCount, targetCount, completionPercent: percent(doneCount, targetCount ?? 0),
    valueTotal: measures.length === 1 ? measures[0].total : null, valueAverage: measures.length === 1 ? measures[0].average : null,
    ...(measures.length > 1 ? { valuesByUnit: measures } : measures[0]?.unit ? { valueUnit: measures[0].unit } : {}) };
  if (habit.target?.kind !== "number") return totals;
  const goals = numericHabitGoalProgress(habit, checkins, required, days, !dailyGroup);
  return { ...totals, targetCount: null, unit: habit.target.unit, goals,
    completionPercent: percent(goals.reduce((sum, goal) => sum + goal.met, 0), goals.reduce((sum, goal) => sum + goal.periods, 0)) };
}

function habitStats(habits: readonly HabitDefinition[], checkins: NonNullable<StatsData["checkins"]>, range: DayRange, now: Date, group?: DateGrouping) {
  const today = formatDate(now), days = datesBetween(range.from, range.to);
  const periods = new Map<string, string[]>();
  if (group) for (const date of days) {
    const key = dateKey(date, group);
    const period = periods.get(key);
    if (period) period.push(date);
    else periods.set(key, [date]);
  }
  return { habits: habits.map(habit => {
    const entries = checkins.filter(item => item.habitId === habit.id && item.date >= habit.startDate && item.date <= today);
    const numeric = habit.target?.kind === "number" ? habit.target : undefined;
    const checked = new Set(entries.filter(item => item.status === "done"
      && (!numeric || (numeric.perDay ? habitRecordedAmount(habit, item) >= numeric.perDay : habitRecordedAmount(habit, item) > 0))).map(item => item.date));
    let streak = 0;
    let current = checked.has(today) ? today : addDays(today, -1);
    while (checked.has(current)) { streak++; current = addDays(current, -1); }
    const day = days.length === 1 ? days[0] : undefined;
    const target = habit.source === "trades" && day && numeric?.perDay && isHabitRequiredOn(habit, day) ? numeric.perDay : undefined;
    const checkin = target !== undefined ? entries.find(item => item.date === day) : undefined;
    const actual = habitRecordedAmount(habit, checkin);
    return { id: habit.id, name: habit.name, ...habitTotals(habit, entries, days), currentStreak: streak,
      ...(target !== undefined ? { dailyTradeGoal: checkin?.status === "leave" ? { target, status: "leave" }
        : { target, actual, remaining: Math.max(0, target - actual), status: actual >= target ? "met" : "pending" } } : {}),
      ...(habit.punishment?.enabled ? { punishment: habit.punishment } : {}),
      groups: group ? [...periods].map(([date, period]) => ({ date, ...habitTotals(habit, entries, period, group === "day") })) : undefined };
  }) };
}

function journalTotals(entries: readonly JournalStatsEntry[]) {
  return { count: entries.length, signalAverages: Object.fromEntries(JOURNAL_SIGNAL_FIELDS.map(field => [field,
    mean(entries.flatMap(entry => {
      const value = entry.signals?.[field];
      return typeof value === "number" && Number.isFinite(value) ? [value] : [];
    }))])) };
}

function journalStats(journal: readonly JournalStatsEntry[], range: DayRange, group: DateGrouping = "day") {
  const entries = journal.filter(entry => inRange(entry.date, range));
  const byDate = new Map<string, JournalStatsEntry[]>();
  for (const entry of entries) {
    const date = dateKey(entry.date, group);
    const entriesForDate = byDate.get(date);
    if (entriesForDate) entriesForDate.push(entry);
    else byDate.set(date, [entry]);
  }
  const groups = [...byDate.keys()].sort().map(date => ({ date, ...journalTotals(byDate.get(date)!) }));
  return { ...journalTotals(entries), groups };
}
