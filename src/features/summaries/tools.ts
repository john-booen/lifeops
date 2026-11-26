import type { LifeOpsToolDefinition } from "../../toolRegistry";
import { summaryLevels } from "./periods";
import { executeStoredQuery } from "../../storedQueryRead";
import { ISO_DATE_INTERVAL_PATTERN } from "../stats/stats";

export const SUMMARIES_TOOL: LifeOpsToolDefinition = {
  name: "get_summaries",
  description: "周月整体、跨周规律和多领域对照先用本工具；单领域任务数字用get_stats。含through、完成登记数和分币种指标；缺项补统计，缺摘要带日记。核对原话用includeOriginals。",
  safety: "safe",
  parameters: {
    type: "object", additionalProperties: false, required: ["level", "range"],
    properties: {
      level: { type: "string", enum: summaryLevels },
      includeOriginals: { type: "boolean", description: "跨周核对原话时为true；只读片段，保留更正与隐私保护。" },
      query: { type: "string", maxLength: 120, description: "日记主题关键词，最多8词、空格分隔且全部命中；不查当前记忆。" },
      range: { anyOf: [{ type: "string", enum: ["today", "this_week", "last_week", "last_7d", "this_month", "last_month", "last_30d"] },
        { type: "object", additionalProperties: false, required: ["from", "to"],
          properties: { from: { type: "string" }, to: { type: "string" } } }, { type: "string", pattern: ISO_DATE_INTERVAL_PATTERN }] }
    }
  },
  execute: (args,context) => executeStoredQuery("get_summaries",args,context)
};
