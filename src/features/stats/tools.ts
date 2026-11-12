import type { AiToolDefinition } from "../../ai";
import { journalDateFromPath } from "../../journalResolver";
import { formatDate } from "../../date";
import { isVaultPathExcluded } from "../../privacy";
import type { LifeOpsToolDefinition, ToolExecutionResult } from "../../toolRegistry";
import type { StoreHost } from "../../store/settingsSlice";
import { getStats, resolveStatsRange, statsNamedRanges, type StatsData, type StatsDomain, type StatsGroup, type StatsRange } from "./stats";
import { formatTradeModelLeaders, TRADE_STAT_GROUPS } from "./trades";

export const statsDomains: StatsDomain[] = ["tasks", "habits", "journal", "trades", "ideas", "learning"];
const groups: StatsGroup[] = [...TRADE_STAT_GROUPS, "category"];
const standardRanges = statsNamedRanges.filter(range => range !== "last_week" && range !== "last_month");
const rangeParameter = (names: readonly string[]) => ({ anyOf: [{ type: "string", enum: [...names] }, {
  type: "object", additionalProperties: false,
  properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"]
}] });

export const STATS_TOOL: LifeOpsToolDefinition = {
  name: "get_stats",
  description: "查完成数、完成率、状态趋势和交易盈亏。今日交易目标用 habits 和 today。原币分别报告，明确要求折合美元总额才用 combineUsd。",
  safety: "safe",
  parameters: {
    type: "object", additionalProperties: false,
    properties: {
      domain: { type: "string", enum: statsDomains },
      range: rangeParameter(standardRanges),
      groupBy: { type: "string", enum: groups }, combineUsd: { type: "boolean", description: "用户明确要求把交易盈亏折成美元总额时才传 true。只问笔数或胜率时省略。" },
      rankByNetPnl: { type: "boolean", description: "只问哪个交易模型的净盈亏最高、按原币排名时传 true，同时使用 domain=trades 和 groupBy=model。" }
    }, required: ["domain", "range"]
  },
  execute: (args, context) => readStats(context.store, args, new Date())
};

export function backgroundStatsTool(tool: AiToolDefinition): AiToolDefinition {
  return { ...tool, description: tool.description + " 上周用 last_week，上个月用 last_month。",
    parameters: { ...tool.parameters, properties: {
      ...(tool.parameters.properties as Record<string, unknown>), range: rangeParameter(statsNamedRanges)
    } } };
}

export async function readStats(store: StoreHost, args: Record<string, unknown>, now: Date): Promise<ToolExecutionResult> {
  const domain = args.domain as StatsDomain, groupBy = args.groupBy as StatsGroup | undefined;
  if (!statsDomains.includes(domain) || groupBy !== undefined && !groups.includes(groupBy)) {
    return { success: false, output: "统计领域或分组无效。", actions: [] };
  }
  const data: StatsData = {};
  let partial = false, tradeGoalsUnavailable = false;
  try {
    if (domain === "tasks") {
      const { readContextTasks } = await import("../../contextData");
      const result = await readContextTasks(store);
      if (!result.available) return { success: false, output: "任务记录暂不可用，无法计算。", actions: [] };
      data.tasks = result.tasks; partial = !!result.filtered;
    } else if (domain === "habits") {
      const { readContextHabits } = await import("../../contextData");
      const result = await readContextHabits(store);
      if (!result.available) return { success: false, output: "习惯记录暂不可用，无法计算。", actions: [] };
      tradeGoalsUnavailable = result.tradeUnavailable === true;
      data.habits = tradeGoalsUnavailable ? result.database.habits.filter(habit => habit.source !== "trades") : result.database.habits;
      data.checkins = result.database.checkins;
    } else if (domain === "trades") {
      const { readTradeStatsData } = await import("./tradeData");
      const result = await readTradeStatsData(store);
      data.trades = result.trades;
      data.tradeSettings = result.settings;
      partial = result.filtered;
    } else if (domain === "ideas") {
      const [{ listIdeas }, { ideaIsStalled }] = await Promise.all([import("../ideas/notes"), import("../ideas/progress")]);
      if (isVaultPathExcluded(store.settings.folders.ideas, store.settings.privacy?.excludedVaultPrefixes)) {
        return { success: false, output: "想法目录已排除，无法统计。", actions: [] };
      }
      const today = formatDate(now);
      data.ideas = (await listIdeas(store)).map(idea => ({ ...idea, stalled: ideaIsStalled(idea, today) }));
    } else if (domain === "learning") {
      const { readLearningDocument, visibleLearningTrack } = await import("../learning/store");
      const { effectiveLearningTrack } = await import("../learning/model");
      data.learning = (await readLearningDocument(store)).tracks.map(track => {
        const visible = visibleLearningTrack(store, effectiveLearningTrack(track, formatDate(now)));
        if (visible.sessions.length !== track.sessions.length) partial = true;
        return visible;
      });
    } else if (domain === "journal") {
      const { readJournalSignals } = await import("../journal/signalStore");
      const root = store.settings.folders.dailyRoot;
      const excluded = store.settings.privacy?.excludedVaultPrefixes;
      if (isVaultPathExcluded(root, excluded)) return { success: false, output: "日记目录已排除，无法计算。", actions: [] };
      const range = resolveStatsRange(args.range as StatsRange, now);
      const entries = store.app.vault.getMarkdownFiles().flatMap(file => {
        const date = journalDateFromPath(file.path, root, range.to.slice(0, 4));
        if (!date || date < range.from || date > range.to) return [];
        if (isVaultPathExcluded(file.path, excluded)) { partial = true; return []; }
        return store.isManagedSourcePath(file.path) ? [{ date, path: file.path }] : [];
      });
      if (store.settings.externalVaults?.length) {
        const { externalFilesForCategory, externalJournalRoot } = await import("../externalVault/catalog");
        for (const { file, reference } of await externalFilesForCategory(store, "journal")) {
          const date = journalDateFromPath(file.path, externalJournalRoot(store.settings, file.path), range.to.slice(0, 4));
          if (date && date >= range.from && date <= range.to) entries.push({ date, path: reference });
        }
      }
      const signals = new Map<string, Awaited<ReturnType<typeof readJournalSignals>>[number]>();
      for (const date of new Set(entries.map(entry => entry.date))) {
        const notes = await readJournalSignals(store, date).catch(() => { partial = true; return []; });
        for (const note of notes) signals.set(note.sources[0].path, note);
      }
      data.journal = entries.map(({ date, path }) => ({ date, signals: signals.get(path) }));
    }
    const stats = getStats({ domain, range: args.range as StatsRange, groupBy, combineUsd: args.combineUsd === true }, data, now);
    let modelRanking: string | undefined;
    if (stats.domain === "trades" && stats.groupBy === "model" && stats.groups) {
      const { readTradingDocument, tradingDocumentPath } = await import("../../dataFoundation/tradingPersistence");
      if (stats.groups.length && !isVaultPathExcluded(tradingDocumentPath(store), store.settings.privacy?.excludedVaultPrefixes)) {
        const document = await readTradingDocument(store).catch(() => undefined);
        if (document) {
          const { visibleTradingVersion } = await import("../../tradingTools");
          const names = new Map(document.models.flatMap(model => {
            const version = model.versions.at(-1);
            return version && visibleTradingVersion(store, version, document) ? [[model.id, version.title] as const] : [];
          }));
          stats.groups = stats.groups.map(group => ({ ...group, label: names.get(group.key) ?? group.key }));
        }
      }
      if (args.combineUsd !== true) modelRanking = formatTradeModelLeaders(stats.groups, stats.range, partial);
    }
    return { success: true, output: JSON.stringify({ ...(modelRanking ? { modelRanking } : {}), ...stats,
      ...(partial ? { scope: "只统计允许读取的记录" } : {}),
      ...(tradeGoalsUnavailable ? { tradeGoals: "交易记录暂不可用，交易目标进度未知" } : {}) }), actions: [] };
  } catch (error) {
    return { success: false, output: error instanceof Error ? error.message : "统计暂时无法完成。", actions: [] };
  }
}
