import type { LifeOpsAgentDomain } from "./agents";

export type LifeOpsWorkflowId =
  | "daily_startup_briefing"
  | "nightly_consolidation"
  | "weekly_review"
  | "trading_review"
  | "memory_candidate_review"
  | "multimodal_situation_check";

export interface LifeOpsWorkflowStep {
  id: string;
  agentId: string;
  title: string;
  instruction: string;
  outputTarget?: string;
  requiresUserConfirmation?: boolean;
}

export interface LifeOpsWorkflowTemplate {
  id: LifeOpsWorkflowId;
  title: string;
  domain: LifeOpsAgentDomain | "multimodal";
  trigger: "manual" | "startup" | "nightly" | "weekly" | "contextual";
  cadence: string;
  agentIds: string[];
  steps: LifeOpsWorkflowStep[];
  outputTargets: string[];
  privacyNotes: string[];
}

export const LIFEOPS_WORKFLOW_TEMPLATES: LifeOpsWorkflowTemplate[] = [
  {
    id: "daily_startup_briefing",
    title: "打开 Obsidian 时今日简报",
    domain: "planning",
    trigger: "startup",
    cadence: "每天首次打开 Obsidian，可由用户确认后显示",
    agentIds: ["cici-core", "planner", "health"],
    steps: [
      {
        id: "collect-today",
        agentId: "planner",
        title: "汇总今日任务和习惯",
        instruction: "读取今日任务、过期任务、今日必需习惯和最近目标。"
      },
      {
        id: "energy-check",
        agentId: "health",
        title: "补充健康与精力线索",
        instruction: "读取最近健康、睡眠、运动和日记里的精力线索。"
      },
      {
        id: "brief",
        agentId: "cici-core",
        title: "生成一句话重点和 3 个行动",
        instruction: "用短句给出今天最重要的重点、风险和下一步。",
        outputTarget: "LifeOps 面板"
      }
    ],
    outputTargets: ["LifeOps 面板", "LifeOps/Output/AI/Conversations"],
    privacyNotes: ["不主动上传截图或摄像头画面。"]
  },
  {
    id: "nightly_consolidation",
    title: "夜间轻量整合",
    domain: "knowledge",
    trigger: "nightly",
    cadence: "每天晚间，建议先以命令手动触发",
    agentIds: ["cici-core", "planner", "knowledge", "health", "trading"],
    steps: [
      {
        id: "collect-day",
        agentId: "planner",
        title: "汇总当天事实",
        instruction: "整理今天完成、未完成、习惯、日记和新增知识片段。"
      },
      {
        id: "detect-memory",
        agentId: "knowledge",
        title: "提出候选长期记忆",
        instruction: "只提出候选，不自动升级为 active 记忆。",
        outputTarget: "LifeOps/Output/AI/Memory/memory-index.json",
        requiresUserConfirmation: true
      },
      {
        id: "write-review",
        agentId: "cici-core",
        title: "生成晚间复盘草稿",
        instruction: "给出简洁复盘，不虚构没有记录的事实。",
        outputTarget: "日记/晚"
      }
    ],
    outputTargets: ["日记", "LifeOps/Output/AI/Memory", "LifeOps/Output/AI/Quality"],
    privacyNotes: ["记忆升级必须等待用户确认。"]
  },
  {
    id: "weekly_review",
    title: "周整合与模式发现",
    domain: "planning",
    trigger: "weekly",
    cadence: "每周日或用户手动触发",
    agentIds: ["cici-core", "planner", "knowledge", "health", "trading"],
    steps: [
      {
        id: "collect-week",
        agentId: "planner",
        title: "汇总一周任务和目标",
        instruction: "读取本周日记、任务完成、习惯打卡和目标进展。"
      },
      {
        id: "find-patterns",
        agentId: "knowledge",
        title: "寻找反复出现的模式",
        instruction: "为待核对假设列出固定原文支持、反例或缺少反例、日期未知与不确定性；重复记录不等于独立事件，不能按条数认定趋势。"
      },
      {
        id: "next-week",
        agentId: "cici-core",
        title: "生成下周策略",
        instruction: "保存前展示完整回顾核对卡；下次可核对的问题不自动安排任务，记住理解另行本人确认。"
      }
    ],
    outputTargets: ["LifeOps/Output/AI/周报", "LifeOps/Output/AI/Memory"],
    privacyNotes: ["只写摘要和用户确认后的记忆，不保存原始多模态数据。"]
  },
  {
    id: "trading_review",
    title: "交易复盘与纪律检查",
    domain: "trading",
    trigger: "manual",
    cadence: "每次交易后手动触发",
    agentIds: ["cici-core", "trading", "knowledge"],
    steps: [
      {
        id: "match-model",
        agentId: "trading",
        title: "模型匹配检查",
        instruction: "对照交易模型、风控规则和当天交易记录，检查是否遵守纪律。"
      },
      {
        id: "extract-rule",
        agentId: "knowledge",
        title: "提取候选纪律",
        instruction: "如果出现新规则，只提出追加到交易模型的候选动作。",
        requiresUserConfirmation: true
      },
      {
        id: "safe-reply",
        agentId: "cici-core",
        title: "安全回复",
        instruction: "只做复盘和纪律提醒，不给实盘买卖点。"
      }
    ],
    outputTargets: ["LifeOps/TradeReview", "交易模型", "LifeOps/Output/AI/Memory"],
    privacyNotes: ["永远不喊单，不承诺收益，不替用户下交易结论。"]
  },
  {
    id: "memory_candidate_review",
    title: "候选记忆确认",
    domain: "knowledge",
    trigger: "manual",
    cadence: "用户手动确认或晚间整合后弹出",
    agentIds: ["cici-core", "knowledge"],
    steps: [
      {
        id: "list-candidates",
        agentId: "knowledge",
        title: "列出候选记忆",
        instruction: "按重要性、置信度、来源列出 candidate 记忆。"
      },
      {
        id: "confirm",
        agentId: "cici-core",
        title: "等待用户确认",
        instruction: "让用户选择确认、改写、归档或提升层级。",
        requiresUserConfirmation: true
      }
    ],
    outputTargets: ["LifeOps/Output/AI/Memory/memory-index.json"],
    privacyNotes: ["Cici 不能自动把候选写成核心身份。"]
  },
  {
    id: "multimodal_situation_check",
    title: "多模态情境检查",
    domain: "multimodal",
    trigger: "contextual",
    cadence: "语音稳定后再启用，低频、可关闭",
    agentIds: ["cici-core", "vision"],
    steps: [
      {
        id: "collect-summary",
        agentId: "vision",
        title: "采集短期视觉摘要",
        instruction: "只产生文字摘要和过期时间，不保存原始摄像头帧或桌面截图。"
      },
      {
        id: "fuse",
        agentId: "cici-core",
        title: "融合到上下文",
        instruction: "把未过期视觉摘要作为 ContextBlock 提供给回复，不把过期摘要当事实。"
      }
    ],
    outputTargets: ["LifeOps/Output/AI/Vision", "LifeOps ContextBundle"],
    privacyNotes: ["摄像头/桌面原图永不落盘；敏感窗口永不截图。"]
  }
];

export function getWorkflowTemplate(id: LifeOpsWorkflowId): LifeOpsWorkflowTemplate | undefined {
  return LIFEOPS_WORKFLOW_TEMPLATES.find((template) => template.id === id);
}

export function workflowTemplatesForDomain(domain: LifeOpsWorkflowTemplate["domain"]): LifeOpsWorkflowTemplate[] {
  return LIFEOPS_WORKFLOW_TEMPLATES.filter((template) => template.domain === domain);
}

export function workflowTemplateToMarkdown(template: LifeOpsWorkflowTemplate): string {
  return [
    `## ${template.title}`,
    `- id: ${template.id}`,
    `- trigger: ${template.trigger}`,
    `- cadence: ${template.cadence}`,
    `- agents: ${template.agentIds.join(", ")}`,
    "",
    "### Steps",
    ...template.steps.map((step, index) => [
      `${index + 1}. ${step.title}`,
      `   - agent: ${step.agentId}`,
      `   - instruction: ${step.instruction}`,
      step.outputTarget ? `   - output: ${step.outputTarget}` : "",
      step.requiresUserConfirmation ? "   - requires user confirmation: yes" : ""
    ].filter(Boolean).join("\n")),
    "",
    "### Outputs",
    ...template.outputTargets.map((target) => `- ${target}`),
    "",
    "### Privacy",
    ...template.privacyNotes.map((note) => `- ${note}`)
  ].join("\n");
}

export function workflowCatalogToMarkdown(templates: LifeOpsWorkflowTemplate[] = LIFEOPS_WORKFLOW_TEMPLATES): string {
  return [
    "# LifeOps Workflow Templates",
    "",
    "> 这些模板只定义流程和边界，不会自动执行写入、截图或记忆升级。",
    "",
    ...templates.map((template) => workflowTemplateToMarkdown(template))
  ].join("\n\n");
}

export function workflowRunDraftMarkdown(template: LifeOpsWorkflowTemplate, createdAt = new Date().toISOString()): string {
  return [
    `# ${template.title} 草稿`,
    "",
    `- workflowId: ${template.id}`,
    `- createdAt: ${createdAt}`,
    `- trigger: ${template.trigger}`,
    `- cadence: ${template.cadence}`,
    "",
    "## 执行边界",
    "- 这是手动触发的工作流草稿，不代表后台自动执行。",
    "- 需要写入任务、记忆、交易模型或知识库时，仍需要用户确认。",
    "- 不保存摄像头原始帧或桌面原始截图。",
    "",
    "## 步骤清单",
    ...template.steps.map((step) => [
      `- [ ] ${step.title}`,
      `  - agent: ${step.agentId}`,
      `  - instruction: ${step.instruction}`,
      step.outputTarget ? `  - output: ${step.outputTarget}` : "",
      step.requiresUserConfirmation ? "  - confirmation: required" : ""
    ].filter(Boolean).join("\n")),
    "",
    "## 输出位置",
    ...template.outputTargets.map((target) => `- ${target}`),
    "",
    "## 隐私和安全",
    ...template.privacyNotes.map((note) => `- ${note}`)
  ].join("\n");
}
