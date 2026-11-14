import { describe, expect, it } from "vitest";
import { agentsForDomain, classifyTaskComplexity, findLifeOpsAgent } from "../src/agents";

describe("agentTypes", () => {
  it("defines LifeOps Core as the only general entry", () => {
    const agent = findLifeOpsAgent("lifeops-core");

    expect(agent?.domain).toBe("general");
    expect(agent?.canWrite).toBe(false);
  });

  it("lists domain agents", () => {
    expect(agentsForDomain("trading").map((agent) => agent.id)).toEqual(["trading"]);
  });

  it("classifies compound and orchestrated tasks", () => {
    expect(classifyTaskComplexity("帮我看一下今日任务")).toBe("simple");
    expect(classifyTaskComplexity("帮我整理知识库并生成复盘")).toBe("compound");
    expect(classifyTaskComplexity("同时结合任务、交易、健康和桌面截图做完整规划")).toBe("orchestrated");
  });
});
