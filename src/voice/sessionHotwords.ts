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

export function safeManualHotwords(settings: StoreHost["settings"], configured: string | undefined): string[] {
  const credentials = configuredCredentials(settings);
  const source = configured?.slice(0, 8000).split(/[,，\n]+/u)
    .filter(word => safeHotword(word, credentials)).join("\n");
  return asrHotwords(source);
}

function safeHotword(word: string, credentials: string[]): boolean {
  const normalized = word.normalize("NFKC");
  return redactSensitiveText(word, credentials) === word && redactSensitiveText(normalized, credentials) === normalized;
}

function titleHotwordFragments(title: string, segmenter: Intl.Segmenter, stopwords: Set<string>): string[] {
  const segments = [...segmenter.segment(title)];
  const words = segments.filter(({ isWordLike, segment }) => isWordLike && Array.from(segment).length > 1
    && !/^\d+$/u.test(segment) && !stopwords.has(segment)).map(({ segment }) => segment);
  const joined: string[] = [];
  // ICU can split a name or an object word into single characters. Join only
  // contiguous Han tokens, without crossing punctuation or expanding the source.
  const usable = (part: (typeof segments)[number]) => part.isWordLike && /^\p{Script=Han}+$/u.test(part.segment)
    && !stopwords.has(part.segment);
  for (let start = 0; start < segments.length && joined.length < 50; start++) {
    if (!usable(segments[start])) continue;
    let text = segments[start].segment, hasSingle = Array.from(text).length === 1;
    for (let end = start + 1; end < Math.min(start + 4, segments.length) && joined.length < 50; end++) {
      const part = segments[end]; if (!usable(part)) break;
      text += part.segment; if (Array.from(text).length > 4) break;
      hasSingle ||= Array.from(part.segment).length === 1;
      if (hasSingle) joined.push(text);
    }
  }
  return [...words, ...joined];
}

export async function collectSessionHotwords(store: StoreHost, configured: string | undefined, now = new Date()): Promise<string[]> {
  const policy = contextDataPolicy(store);
  const credentials = configuredCredentials(store.settings);
  const manual = safeManualHotwords(store.settings, configured);
  if (manual.length === 50) return manual;
  const [habits, tasks, trades] = await Promise.allSettled([readContextHabits(store), readContextTasks(store), readTradeStatsData(store)]);
  if (policy !== contextDataPolicy(store)) return manual;
  const today = formatDate(now), from = addDays(today, -6);
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  const stopwords = new Set(["今天", "明天", "任务", "确认", "安排", "整理", "完成", "跟进", "一下", "需要", "准备", "继续"]);
  const keywords = tasks.status === "fulfilled" ? tasks.value.tasks
    .filter(task => [task.date, formatDate(new Date(task.createdAt)), formatDate(new Date(task.updatedAt))]
      .some(day => day >= from && day <= today))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .filter(task => safeHotword(task.title, credentials))
    .flatMap(task => titleHotwordFragments(task.title, segmenter, stopwords)) : [];
  const automatic = [
    ...(habits.status === "fulfilled" ? habits.value.database.habits.filter(habit => !habit.startDate || habit.startDate <= today).map(habit => habit.name) : []),
    ...(trades.status === "fulfilled" ? trades.value.trades.slice().sort((a, b) => b.openedAt.localeCompare(a.openedAt)).map(trade => trade.symbol) : []),
    ...keywords
  ];
  return asrHotwords([...manual, ...automatic.filter(word => safeHotword(word, credentials))].join("\n"));
}
