import { readContextTasks } from "../../contextData";
import { formatDate } from "../../date";
import type { StoreHost } from "../../store/settingsSlice";
import { readJournalSignals } from "../journal/signalStore";
import { currentSignalValues } from "../journal/signals";
import { taskCompletionEvents } from "../stats/stats";
import { readStats, statsDomains } from "../stats/tools";
import type { tradeStats } from "../stats/trades";
import { readSummary, summaryPathAllowed, type SummaryMetrics } from "./notes";
import { summaryPeriodsInRange, type SummaryPeriod } from "./periods";

export function conversationUserTurns(raw: string, protect: (text: string) => string): string[] {
  const headers = /^## \d{1,2}:\d{2}:\d{2}[^\S\r\n]*\r?\n\s*?### 我\r?\n([\s\S]*?)(?=\r?\n### LifeOps Agent\r?\n)/gm;
  return [...raw.matchAll(headers)].slice(-24).map(match => protect(match[1].trim()).slice(0, 500)).filter(Boolean);
}

async function readConversation(store: StoreHost, day: string, protect: (text: string) => string): Promise<string[]> {
  const path = store.path(store.settings.folders.aiReports, "Conversations", day + ".md");
  if (!summaryPathAllowed(store, path) || store.getFile(path)?.path !== path) return [];
  const raw = await store.readPath(path);
  return summaryPathAllowed(store, path) ? conversationUserTurns(raw, protect) : [];
}

async function collectDailySignals(store: StoreHost, day: string, now: Date, protect: (text: string) => string) {
  const [signals, conversation, tasks] = await Promise.all([
    readJournalSignals(store, day).catch(() => []), readConversation(store, day, protect).catch(() => []),
    readContextTasks(store).catch(() => undefined)
  ]);
  const penalties = tasks?.available ? tasks.tasks.flatMap(task => {
    const penalty = task.habitPunishment;
    return penalty && penalty.judgedDate === day ? [{ title: task.title, status: task.status, evidence: penalty.evidence }] : [];
  }) : null;
  const completedTasks = tasks?.available
    ? [...new Set(taskCompletionEvents(tasks.tasks, { from: day, to: day }, now).map(event => event.task.title))].slice(0, 15)
    : null;
  return {
    signals: signals.map(({ sources: _sources, quotes: _quotes, ...signal }) => signal),
    signalValues: currentSignalValues(signals), conversation, completedTasks, penalties
  };
}

export async function collectChildSummaries(store: StoreHost, period: SummaryPeriod, through: string,
  scope: { hash: string; protect: (text: string) => string }) {
  if (period.level === "day") return [];
  const childLevel = period.level === "week" ? "day" : "week";
  const childPeriods = summaryPeriodsInRange(childLevel, { from: period.from, to: through });
  const notes = await Promise.all(childPeriods.map(child => readSummary(store, child, scope.hash)));
  return notes.flatMap((note, index) => note ? [{
    key: childPeriods[index].key, from: note.properties.from, to: note.properties.through,
    complete: note.properties.complete, text: scope.protect(note.text).slice(0, period.level === "week" ? 950 : 1800)
  }] : []);
}

const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
type TradeTotals = Pick<SummaryMetrics, "tradePnlCny" | "tradePnlUsd">;

function tradeSummaryTotals(stats: ReturnType<typeof tradeStats> | null): TradeTotals {
  return {
    tradePnlCny: numeric(stats?.byCurrency.CNY.totalPnl),
    tradePnlUsd: numeric(stats?.byCurrency.USD.totalPnl)
  };
}

export async function readSummaryTradeTotals(store: StoreHost, range: { from: string; to: string }, now: Date): Promise<TradeTotals | undefined> {
  const result = await readStats(store, { domain: "trades", range }, now);
  return result.success ? tradeSummaryTotals(JSON.parse(result.output)) : undefined;
}

export function sameSummaryTradeTotals(a: TradeTotals, b: TradeTotals): boolean {
  return a.tradePnlCny === b.tradePnlCny && a.tradePnlUsd === b.tradePnlUsd;
}

export async function collectSummaryData(store: StoreHost, period: SummaryPeriod, now: Date, protect: (text: string) => string,
  summaries: Awaited<ReturnType<typeof collectChildSummaries>>) {
  const through = [formatDate(now), period.to].sort()[0];
  const range = { from: period.from, to: through };
  const [statsEntries, daily] = await Promise.all([
    Promise.all(statsDomains.map(async domain => {
      const result = await readStats(store, { domain, range }, now);
      return [domain, result.success ? JSON.parse(result.output) : null] as const;
    })),
    period.level === "day" ? collectDailySignals(store, period.from, now, protect) : undefined
  ]);
  const stats = Object.fromEntries(statsEntries);
  const metrics: SummaryMetrics = {
    taskCompletionPercent: numeric(stats.tasks?.completionPercent),
    tasksCompleted: numeric(stats.tasks?.completedCount),
    energy: numeric(daily?.signalValues.energy ?? stats.journal?.signalAverages.energy),
    ...tradeSummaryTotals(stats.trades)
  };
  return { through, stats, daily, summaries, metrics };
}
export type SummaryData = Awaited<ReturnType<typeof collectSummaryData>>;
