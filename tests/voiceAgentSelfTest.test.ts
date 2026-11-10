import { describe, expect, it } from "vitest";
import { runVoiceAgentSelfTest } from "../src/voiceCheck";
import type { AgentActionSuggestion } from "../src/types";

describe("runVoiceAgentSelfTest", () => {
  it("passes natural voice replies without action pollution", async () => {
    const report = await runVoiceAgentSelfTest(async (message) => {
      if (message.includes("还没说完")) {
        return { reply: "抱歉，刚才我抢话了。你继续说，我在听。", actions: [] };
      }
      if (message.includes("创建任务")) {
        return { reply: "不好意思，我刚才太急了。我们就聊天，你说吧。", actions: [] };
      }
      return { reply: "那挺好的，想聊什么都可以，我在。", actions: [] };
    }, "2026-06-11T00:00:00.000Z");

    expect(report.ok).toBe(true);
    expect(report.cases).toHaveLength(3);
    expect(report.cases.every((item) => item.actions === 0)).toBe(true);
  });

  it("fails when a voice reply leaks task actions", async () => {
    const report = await runVoiceAgentSelfTest(async (message) => {
      if (message.includes("创建任务")) {
        const leakedAction: AgentActionSuggestion = {
          id: "bad-task-action",
          type: "create_task",
          title: "test",
          description: "bad",
          content: "test",
          date: "2026-06-11"
        };
        return {
          reply: "我会创建任务，放到待确认动作里。",
          actions: [leakedAction]
        };
      }
      if (message.includes("还没说完")) {
        return { reply: "抱歉，我在听，你继续说。", actions: [] };
      }
      return { reply: "那挺好的，想聊什么都可以，我在。", actions: [] };
    });

    expect(report.ok).toBe(false);
    expect(report.cases.find((item) => item.name === "task-flow correction voice")?.failures.join("\n")).toContain("unexpected actions");
  });
});
