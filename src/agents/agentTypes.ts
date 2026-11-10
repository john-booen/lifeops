export type LifeOpsAgentDomain = "planning" | "knowledge" | "trading" | "health" | "vision" | "dev" | "general";
export type LifeOpsAgentAutonomy = "reactive" | "scheduled" | "autonomous";
export type LifeOpsAgentMemoryScope = "shared" | "private";
export type LifeOpsTaskComplexity = "simple" | "compound" | "orchestrated";

export interface LifeOpsAgentConfig {
  id: string;
  name: string;
  domain: LifeOpsAgentDomain;
  memoryScope: LifeOpsAgentMemoryScope;
  autonomyLevel: LifeOpsAgentAutonomy;
  skillTags: string[];
  knowledgeDomains: string[];
  canWrite: boolean;
}

export const LIFEOPS_AGENT_CONFIGS: LifeOpsAgentConfig[] = [
  {
    id: "cici-core",
    name: "Cici Core",
    domain: "general",
    memoryScope: "shared",
    autonomyLevel: "reactive",
    skillTags: ["conversation", "routing", "memory-boundary"],
    knowledgeDomains: ["lifeops", "user-context"],
    canWrite: false
  },
  {
    id: "planner",
    name: "Planner Agent",
    domain: "planning",
    memoryScope: "shared",
    autonomyLevel: "scheduled",
    skillTags: ["tasks", "calendar", "habits", "review"],
    knowledgeDomains: ["tasks", "habits", "daily-notes", "goals"],
    canWrite: true
  },
  {
    id: "knowledge",
    name: "Knowledge Agent",
    domain: "knowledge",
    memoryScope: "shared",
    autonomyLevel: "reactive",
    skillTags: ["retrieval", "note-linking", "summarization"],
    knowledgeDomains: ["vault-index", "ideas", "outputs"],
    canWrite: true
  },
  {
    id: "trading",
    name: "Trading Agent",
    domain: "trading",
    memoryScope: "shared",
    autonomyLevel: "reactive",
    skillTags: ["review", "discipline", "model-check"],
    knowledgeDomains: ["trading-reviews", "trading-models", "risk-rules"],
    canWrite: true
  },
  {
    id: "health",
    name: "Health Agent",
    domain: "health",
    memoryScope: "shared",
    autonomyLevel: "scheduled",
    skillTags: ["sleep", "exercise", "energy", "habit-support"],
    knowledgeDomains: ["health", "habits", "daily-notes"],
    canWrite: true
  },
  {
    id: "vision",
    name: "Vision Agent",
    domain: "vision",
    memoryScope: "private",
    autonomyLevel: "scheduled",
    skillTags: ["camera", "desktop", "situation"],
    knowledgeDomains: ["visual-state", "desktop-state"],
    canWrite: false
  },
  {
    id: "dev-router",
    name: "Dev Router Agent",
    domain: "dev",
    memoryScope: "shared",
    autonomyLevel: "reactive",
    skillTags: ["handoff", "implementation-plan", "qa"],
    knowledgeDomains: ["project-docs", "codebase"],
    canWrite: false
  }
];

export function findLifeOpsAgent(id: string): LifeOpsAgentConfig | undefined {
  return LIFEOPS_AGENT_CONFIGS.find((agent) => agent.id === id);
}

export function agentsForDomain(domain: LifeOpsAgentDomain): LifeOpsAgentConfig[] {
  return LIFEOPS_AGENT_CONFIGS.filter((agent) => agent.domain === domain);
}

export function classifyTaskComplexity(input: string): LifeOpsTaskComplexity {
  const text = input.trim();
  const domainHits = [
    /任务|计划|日程|习惯|目标/.test(text),
    /知识库|笔记|资料|检索|总结/.test(text),
    /交易|复盘|模型|风控|纪律/.test(text),
    /健康|睡眠|运动|精力/.test(text),
    /摄像头|截图|桌面|视觉/.test(text),
    /代码|bug|实现|测试/.test(text)
  ].filter(Boolean).length;
  if (domainHits >= 3 || /同时|一起|完整|全流程|自动/.test(text)) return "orchestrated";
  if (domainHits >= 2 || /拆解|规划|复盘|整理/.test(text)) return "compound";
  return "simple";
}
