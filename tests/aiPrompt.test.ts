import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { AgentConversationMessage } from "../src/types";

vi.mock("obsidian", () => ({
  requestUrl: vi.fn()
}));

const { LifeOpsAi } = await import("../src/ai");

interface AgentMessageProbe {
  agentMessages(
    context: string,
    message: string,
    history?: AgentConversationMessage[],
    source?: "text" | "voice"
  ): Array<{ role: string; content: string }>;
}

describe("LifeOpsAi voice prompt", () => {
  it("uses the compact steward principles for standard voice requests", () => {
    const ai = new LifeOpsAi(DEFAULT_SETTINGS) as unknown as AgentMessageProbe;
    const messages = ai.agentMessages(
      "# LifeOps Voice Context\n\n## Tasks\n\n- task",
      "今天有哪些任务",
      [],
      "voice"
    );
    const system = messages[0].content;

    expect(system).toContain("须确认卡");
    expect(system).toContain("Obsidian 知识库");
    expect(system).toContain("当前是实时语音");
  });
});
