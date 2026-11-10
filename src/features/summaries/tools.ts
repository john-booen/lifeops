import type { LifeOpsToolDefinition } from "../../toolRegistry";
import type { StatsRange } from "../stats/stats";
import { resolveSummaryRange, summaryLevels, summaryPeriodsInRange, type SummaryLevel } from "./periods";

export const SUMMARIES_TOOL: LifeOpsToolDefinition = {
  name: "get_summaries",
  description: "上周总结和本月对比上月时先用本工具。跨月读 this_month 和 last_month，或给跨两月的日期区间。含完成数、完成率和分币种盈亏。",
  safety: "safe",
  parameters: {
    type: "object", additionalProperties: false, required: ["level", "range"],
    properties: {
      level: { type: "string", enum: summaryLevels },
      range: { anyOf: [{ type: "string", enum: ["today", "this_week", "last_week", "last_7d", "this_month", "last_month", "last_30d"] },
        { type: "object", additionalProperties: false, required: ["from", "to"],
          properties: { from: { type: "string" }, to: { type: "string" } } }] }
    }
  },
  async execute(args, context) {
    const level = args.level as SummaryLevel, { store } = context;
    try {
      if (!summaryLevels.includes(level)) throw Error("请选择日、周或月摘要。");
      const range = resolveSummaryRange(args.range as StatsRange | "last_week" | "last_month", new Date());
      const periods = summaryPeriodsInRange(level, range);
      const { readSummary, readSummaryScope } = await import("./notes");
      const scope = await readSummaryScope(store);
      const summaries = [];
      for (const period of periods.slice(-14)) {
        context.assertCurrent?.();
        const note = await readSummary(store, period, scope.hash);
        if (note) summaries.push({
          period: period.key, from: period.from, through: note.properties.through, complete: note.properties.complete,
          generatedBy: note.properties.generatedBy, metrics: note.properties.metrics,
          summary: scope.protect(note.text).slice(0, 1600), path: note.path
        });
      }
      if ((await readSummaryScope(store)).hash !== scope.hash) throw Error("摘要可读取的资料范围有变化，请重试。");
      context.assertCurrent?.();
      return { success: true, output: JSON.stringify({ level, range, summaries,
        ...(periods.length > 14 ? { coverage: "只读取最近 14 个周期，查询较早日期请缩小区间。" } : {}),
        ...(summaries.length ? {} : { coverage: "这个区间没有可读取的摘要，可以查原始记录。" }) }), actions: [] };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      return { success: false, output: error instanceof Error ? error.message : "摘要暂时无法读取。", actions: [] };
    }
  }
};
