import type { LifeOpsToolDefinition } from "../../toolRegistry";
import { summaryLevels } from "./periods";
import { executeStoredQuery } from "../../storedQueryRead";
import { ISO_DATE_INTERVAL_PATTERN } from "../stats/stats";
import { summaryMetricNames } from "./notes";

export const SUMMARIES_TOOL: LifeOpsToolDefinition = {
  name: "get_summaries",
  description: "周月整体、跨周规律及多领域跨期对照先读本工具；同句含任务和交易比较时分两期读。只比数字用metrics列所问字段，含through；缺项补统计。单领域数字用get_stats，原话用includeOriginals。",
  safety: "safe",
  parameters: {
    type: "object", additionalProperties: false, required: ["level", "range"],
    properties: {
      level: { type: "string", enum: summaryLevels },
      metrics: { type: "array", items: { type: "string", enum: summaryMetricNames }, minItems: 1, maxItems: summaryMetricNames.length, uniqueItems: true,
        description: "只比指标时列所问字段，返回日期与指标，省略摘要正文。" },
      includeOriginals: { type: "boolean", description: "跨周核对原话时为true；只读片段，保留更正与隐私保护。" },
      query: { type: "string", maxLength: 120, description: "日记主题关键词，最多8词、空格分隔且全部命中；不查当前记忆。" },
      range: { anyOf: [{ type: "string", enum: ["today", "this_week", "last_week", "last_7d", "this_month", "last_month", "last_30d"] },
        { type: "object", additionalProperties: false, required: ["from", "to"],
          properties: { from: { type: "string" }, to: { type: "string" } } }, { type: "string", pattern: ISO_DATE_INTERVAL_PATTERN }] }
    }
  },
  execute: (args,context) => executeStoredQuery("get_summaries",args,context)
};
