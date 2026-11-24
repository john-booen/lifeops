import type { LifeOpsToolDefinition } from "../../toolRegistry";
import { summaryLevels } from "./periods";
import { executeStoredQuery } from "../../storedQueryRead";
import { ISO_DATE_INTERVAL_PATTERN } from "../stats/stats";

export const SUMMARIES_TOOL: LifeOpsToolDefinition = {
  name: "get_summaries",
  description: "历史总结、跨周规律及月度对比先用本工具。含指标与日期来源；摘要缺失时带同范围日记证据。要核对原话可加includeOriginals。",
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
