import { describe, expect, it, vi } from "vitest";
import { agentToolsForChat, agentToolsForRealtime, getLifeOpsTool } from "../src/toolRegistry";

vi.mock("obsidian", () => ({ requestUrl: vi.fn(() => { throw new Error("Network forbidden in tool schema tests"); }) }));
const { buildChatRequestBody } = await import("../src/ai");

describe("current model request writing destinations", () => {
  it.each([
    ["append_knowledge_note", "知识记录", "要沉淀的知识正文。"],
    ["append_trading_model_note", "交易学习记录", "要沉淀的交易模型正文。"]
  ])("keeps %s in its own activity domain with the explicit valid-date and intent contract", (name, destination, contentDescription) => {
    // Use production tool definitions and the exact chat payload builder, not archived evaluation requests.
    const body = buildChatRequestBody("kimi-k2.6", [{ role: "user", content: "示例请求" }], { tools: agentToolsForChat() });
    const chat = (body.tools as Array<{ function: { name: string; description: string; parameters: unknown } }>)
      .find(tool => tool.function.name === name)!.function;
    const realtime = agentToolsForRealtime().find(tool => tool.name === name)!;
    for (const schema of [chat, realtime]) {
      expect(schema.description).toContain(`指定日期的${destination}`);
      expect(schema.description).toContain("用户明确要求");
      expect(schema.description).not.toContain("日记");
      expect(schema.parameters).toEqual({
        type: "object",
        properties: {
          content: { type: "string", description: contentDescription },
          date: { type: "string", description: "有效日期或相对日期；补记指定日期，省略为今天。" }
        },
        required: ["content"]
      });
    }
    expect(getLifeOpsTool(name)?.safety).toBe("direct-write");
    expect(realtime.description).toContain("安全等级：direct-write");
  });
});
