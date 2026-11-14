import { contextDataPolicy, readContextHabits, readContextTasks } from "../contextData";
import { configuredCredentials, redactSensitiveText } from "../credentialSecurity";
import { addDays, formatDate } from "../date";
import { readTradeStatsData } from "../features/stats/tradeData";
import type { StoreHost } from "../store/settingsSlice";
import { asrHotwords, streamingAsrEndpoint } from "./realtimeAsrOptions";

export function canUseStreamingHotwords(endpoint: string): boolean {
  try { streamingAsrEndpoint(endpoint); return true; }
  catch { return false; }
}

export async function collectSessionHotwords(store: StoreHost, configured: string | undefined, now = new Date()): Promise<string[]> {
  const policy = contextDataPolicy(store);
  const credentials = configuredCredentials(store.settings);
  const manual = asrHotwords(configured);
  if (manual.length === 50) return manual;
  const [habits, tasks, trades] = await Promise.allSettled([readContextHabits(store), readContextTasks(store), readTradeStatsData(store)]);
  if (policy !== contextDataPolicy(store)) return manual;
  const today = formatDate(now), from = addDays(today, -6);
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  const stopwords = new Set(["今天", "明天", "任务", "确认", "安排", "整理", "完成", "跟进", "一下", "需要", "准备", "继续"]);
  const keywords = tasks.status === "fulfilled" ? tasks.value.tasks
    .filter(task => [task.date, task.createdAt.slice(0, 10), task.updatedAt.slice(0, 10)].some(day => day >= from && day <= today))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .flatMap(task => [...segmenter.segment(task.title)].filter(({ isWordLike, segment }) =>
      isWordLike && Array.from(segment).length > 1 && !/^\d+$/u.test(segment) && !stopwords.has(segment)).map(({ segment }) => segment)) : [];
  const automatic = [
    ...(habits.status === "fulfilled" ? habits.value.database.habits.filter(habit => !habit.startDate || habit.startDate <= today).map(habit => habit.name) : []),
    ...(trades.status === "fulfilled" ? trades.value.trades.slice().sort((a, b) => b.openedAt.localeCompare(a.openedAt)).map(trade => trade.symbol) : []),
    ...keywords
  ];
  return asrHotwords([...manual, ...automatic.filter(word => redactSensitiveText(word, credentials) === word
    && redactSensitiveText(word.normalize("NFKC"), credentials) === word.normalize("NFKC"))].join("\n"));
}
