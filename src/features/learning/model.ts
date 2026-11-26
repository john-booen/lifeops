import { addDays, formatDate, normalizeJournalDate, startOfWeek, weekDates } from "../../date";
import { isContextSourcePath } from "../../sourceReferences";

export const LEARNING_TRACKS = { english: "英语", trading: "交易系统", quant: "量化", ai: "AI" } as const;
export type LearningTrackId = keyof typeof LEARNING_TRACKS;
export type LearningUnitStatus = "todo" | "doing" | "done";

export interface LearningUnit { id: string; title: string; status: LearningUnitStatus; doneAt?: string }
export interface LearningSession { date: string; minutes?: number; notePath?: string; summary?: string; key?: string }
interface LearningPlanFields {
  goal: string;
  targetDate?: string;
  weeklyMinutes: number;
  folders: string[];
  units: LearningUnit[];
}
export interface ScheduledLearningPlan extends LearningPlanFields { from: string }
export interface LearningTrack extends LearningPlanFields {
  id: LearningTrackId;
  name: string;
  sessions: LearningSession[];
  nextPlan?: ScheduledLearningPlan;
}
export interface LearningDocument { version: 1; tracks: LearningTrack[] }

export function isLearningTrackId(value: unknown): value is LearningTrackId {
  return typeof value === "string" && Object.hasOwn(LEARNING_TRACKS, value);
}
export function isLearningUnitStatus(value: unknown): value is LearningUnitStatus {
  return value === "todo" || value === "doing" || value === "done";
}
export function isLearningDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && normalizeJournalDate(value) === value;
}
const minutesIn = (value: unknown, max: number, min = 1) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
export const isLearningMinutes = (value: unknown): value is number => minutesIn(value, 1440);
export const isLearningWeeklyMinutes = (value: unknown): value is number => minutesIn(value, 10_080);
const singleLine = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\r\n]/.test(value);

function validPlan(plan: LearningPlanFields): boolean {
  return typeof plan.goal === "string" && plan.goal.length <= 500
    && (plan.targetDate === undefined || isLearningDate(plan.targetDate)) && minutesIn(plan.weeklyMinutes, 10_080, 0)
    && Array.isArray(plan.folders) && plan.folders.every(folder => isContextSourcePath(folder))
    && Array.isArray(plan.units) && plan.units.every(unit => unit && singleLine(unit.id, 120) && singleLine(unit.title, 150)
      && isLearningUnitStatus(unit.status) && (unit.doneAt === undefined || isLearningDate(unit.doneAt)))
    && new Set(plan.units.map(unit => unit.id)).size === plan.units.length;
}

export function validLearningDocument(value: unknown): value is LearningDocument {
  const doc = value as LearningDocument | undefined;
  if (!doc || doc.version !== 1 || !Array.isArray(doc.tracks) || doc.tracks.some(track =>
    !track || !isLearningTrackId(track.id) || !singleLine(track.name, 40) || !validPlan(track)
    || track.nextPlan !== undefined && (!track.nextPlan || !isLearningDate(track.nextPlan.from)
      || startOfWeek(track.nextPlan.from) !== track.nextPlan.from || !validPlan(track.nextPlan))
    || !Array.isArray(track.sessions) || track.sessions.some(session => !session || !isLearningDate(session.date)
      || session.minutes !== undefined && !isLearningMinutes(session.minutes)
      || session.notePath !== undefined && !isContextSourcePath(session.notePath)
      || session.summary !== undefined && (typeof session.summary !== "string" || session.summary.length > 600)
      || session.key !== undefined && !singleLine(session.key, 280)))) return false;
  return new Set(doc.tracks.map(track => track.id)).size === doc.tracks.length;
}

export function effectiveLearningTrack(track: LearningTrack, date: string): LearningTrack {
  if (!track.nextPlan || track.nextPlan.from > date) return track;
  const { from: _from, ...plan } = track.nextPlan;
  const current = new Map(track.units.map(unit => [unit.id, unit]));
  const done = track.units.filter(unit => unit.status === "done");
  const upcoming = plan.units.flatMap(unit => {
    const old = current.get(unit.id);
    return old?.status === "done" ? [] : [{ ...unit, status: old?.status ?? unit.status }];
  });
  return { ...track, ...plan, units: [...done, ...upcoming], nextPlan: undefined };
}

export function learningProgress(input: LearningTrack, now: Date) {
  const today = formatDate(now), weekStart = startOfWeek(today), nextWeek = weekDates(addDays(weekStart, 7));
  const track = effectiveLearningTrack(input, today), upcoming = effectiveLearningTrack(track, nextWeek[0]);
  const sessions = track.sessions.filter(session => session.date >= weekStart && session.date <= today);
  const completedUnits = track.units.filter(unit => unit.status === "done").length;
  const totalUnits=track.units.length,completionPercent=totalUnits?Math.round(completedUnits*10_000/totalUnits)/100:null;
  return { completedUnits, totalUnits: track.units.length,
    completionPercent,unitCountBasis:"current_registered_units" as const,
    unitProgressLabel:totalUnits?`${completedUnits}/${totalUnits} 单元（${completionPercent}%）`:"尚未登记学习单元，完成率未知",
    weekStart, sessionCount: sessions.length, weeklyMinutes: track.weeklyMinutes || null,
    recordedMinutes: sessions.reduce((total, session) => total + (session.minutes ?? 0), 0),
    sessionsWithoutMinutes: sessions.filter(session => session.minutes === undefined).length,
    nextWeek: { from: nextWeek[0], to: nextWeek.at(-1)!, weeklyMinutes: upcoming.weeklyMinutes || null,
      goal: upcoming.goal || null, targetDate: upcoming.targetDate, remaining: upcoming.units.filter(unit => unit.status !== "done") } };
}
