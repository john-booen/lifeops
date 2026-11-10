import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));
const { LifeOpsAi } = await import("../src/ai");
interface PromptProbe {
  agentMessages(context: string, message: string, history: [], source: "text" | "voice", mode: "standard"): Array<{ role: string; content: string }>;
}

describe("ordinary personal-memory lookup instructions", () => {
  it.each(["text", "voice"] as const)("requires the original memory wording and checked current provenance in %s", source => {
    const ai = new LifeOpsAi(DEFAULT_SETTINGS) as unknown as PromptProbe;
    const prompt = ai.agentMessages("## Confirmed Personal Memory", "请只读查询我现在已确认的沟通偏好及来源路径。", [], source, "standard")
      .map(message => message.content).join("\n");
    expect(prompt).toContain("完整保留相关正文及标点");
    expect(prompt).toContain("只用核验的确认或更正依据");
    expect(prompt).toContain("查询只用当前有效记忆");
    expect(prompt).toContain("无记录就直说，不邀约重建");
  });
});
