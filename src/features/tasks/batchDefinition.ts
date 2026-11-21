import type { AiToolDefinition } from "../../ai";

export const TASK_BATCH_TOOL: AiToolDefinition = {
  name: "schedule_task_batch",
  description: "用户明确要求把多项事情安排并保存时，一次提交全部新任务；程序统一排时间、逐项保存并核对回执，无需再逐条询问。仅讨论、先给草案或未授权保存时不用，改用 propose_task_plan。保留用户指定的今天和必做事项，不因历史完成量少而删减。",
  parameters: { type: "object", additionalProperties: false, properties: {
    date: { type: "string", description: "用户要求的日期，例如今天。" },
    availableStart: { type: "string", description: "用户指定的可用开始 HH:mm；未指定省略，今天从当前时间之后排。" },
    availableEnd: { type: "string", description: "用户指定的可用结束 HH:mm；未指定省略，暂以22:00作排程边界并说明。" },
    tasks: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: false,
      properties: { title: { type: "string", description: "具体动作及对象，保留纠正后的人名、项目名，按依赖和优先顺序排列。" },
        estimateMin: { type: "integer", minimum: 1, maximum: 720, description: "分钟估算；未提供时程序暂按30分钟，并明确都是暂估。" },
        category: { type: "string" } }, required: ["title"] } }
  }, required: ["date", "tasks"] }
};

