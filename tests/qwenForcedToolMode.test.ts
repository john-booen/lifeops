import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { AiToolDefinition } from "../src/ai";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));
const { LifeOpsAi, buildChatRequestBody } = await import("../src/ai");
const requestUrlMock = vi.mocked(requestUrl);
const tool: AiToolDefinition = {
  name: "propose_task_plan", description: "生成待确认任务草稿",
  parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }
};
const forced = { type: "function", function: { name: tool.name } } as const;
const messages = [{ role: "user", content: "合成临时任务，先给确认卡" }] as const;
const rawCall = { id: "synthetic-card", type: "function", function: { name: tool.name, arguments: '{"title":"合成临时任务"}' } };

describe("Qwen forced function mode", () => {
  beforeEach(() => requestUrlMock.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  it("uses the supported non-thinking mode for an explicitly selected Qwen function", () => {
    const body = buildChatRequestBody("qwen3.8-flash", [...messages], { tools: [tool], toolChoice: forced });
    expect(body).toMatchObject({ model: "qwen3.8-flash", enable_thinking: false, temperature: 0.2, tool_choice: forced });
    expect(body.tools).toHaveLength(1);
    expect(body).not.toHaveProperty("thinking");
  });

  it("recognizes the exact configured model independent of whitespace/case without changing its wire name", () => {
    const body = buildChatRequestBody(" QWEN3.8-FLASH ", [...messages], { tools: [tool], toolChoice: forced });
    expect(body.enable_thinking).toBe(false);
    expect(body.model).toBe(" QWEN3.8-FLASH ");
  });

  it.each([undefined, "auto", "none"] as const)("preserves Qwen conversation mode for tool choice %s", (toolChoice) => {
    expect(buildChatRequestBody("qwen3.8-flash", [...messages], { tools: [tool], toolChoice })).not.toHaveProperty("enable_thinking");
  });

  it.each([undefined, []])("does not select a Qwen function mode when tools are absent: %j", (tools) => {
    const body = buildChatRequestBody("qwen3.8-flash", [...messages], { tools, toolChoice: forced });
    expect(body).not.toHaveProperty("enable_thinking");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it.each(["", " ", "unavailable_function"])("does not invent an offered function for a mismatched forced name: %j", (name) => {
    const toolChoice = { type: "function", function: { name } } as const;
    const body = buildChatRequestBody("qwen3.8-flash", [...messages], { tools: [tool], toolChoice });
    expect(body).not.toHaveProperty("enable_thinking");
    expect(body.tool_choice).toEqual(toolChoice);
    expect(body.tools).toHaveLength(1);
  });

  it.each(["qwen3.8-plus", "qwen3.8-flash-latest", "qwen3.8-flash-unknown", "qwen-plus", "deepseek-chat", "model-a"])("preserves other model protocols: %s", (model) => {
    const body = buildChatRequestBody(model, [...messages], { tools: [tool], toolChoice: forced });
    expect(body).not.toHaveProperty("enable_thinking");
    expect(body.tool_choice).toEqual(forced);
  });

  it("retains the existing Kimi non-thinking protocol", () => {
    const body = buildChatRequestBody("kimi-k2.6", [...messages], { tools: [tool], toolChoice: forced });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body).not.toHaveProperty("enable_thinking");
    expect(body).not.toHaveProperty("temperature");
  });

  it("serializes the original finite SDK request with non-thinking and returns the model's tool arguments", async () => {
    const json = { model: "qwen3.8-flash", choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [rawCall] } }] };
    requestUrlMock.mockResolvedValueOnce({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), text: JSON.stringify(json), json });
    const result = await new LifeOpsAi(settings()).agentReply("虚构上下文", messages[0].content, [], "voice", { tools: [tool], toolChoice: forced });
    expect(requestUrlMock).toHaveBeenCalledOnce();
    const request = requestUrlMock.mock.calls[0][0];
    expect(typeof request).toBe("object");
    if (typeof request === "string") throw new Error("expected SDK request object");
    expect(request.url).toBe("https://example.test/qwen");
    expect(JSON.parse(request.body as string)).toMatchObject({ model: "qwen3.8-flash", enable_thinking: false, tool_choice: forced, max_tokens: 280 });
    expect(result.toolCalls).toEqual([{ id: rawCall.id, name: tool.name, arguments: { title: "合成临时任务" } }]);
  });

  it("serializes the original stream request with the same mode and parses streamed tool arguments", async () => {
    const parts = [
      { model: "qwen3.8-flash", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...rawCall }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
    ];
    const wire = parts.map(p => `data: ${JSON.stringify(p)}\n\n`).join("") + "data: [DONE]\n\n";
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(wire, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onText = vi.fn();
    const result = await new LifeOpsAi(settings()).agentReplyStream("虚构上下文", messages[0].content, [], onText, "voice", { tools: [tool], toolChoice: forced });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestUrlMock).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ enable_thinking: false, tool_choice: forced, stream: true, max_tokens: 280 });
    expect(result.toolCalls).toEqual([{ id: rawCall.id, name: tool.name, arguments: { title: "合成临时任务" } }]);
    expect(onText).not.toHaveBeenCalled();
  });
});

function settings(): typeof DEFAULT_SETTINGS {
  return {
    ...DEFAULT_SETTINGS,
    privacy: { ...DEFAULT_SETTINGS.privacy, excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true },
    ai: { ...DEFAULT_SETTINGS.ai, provider: "openai-compatible", endpoint: "https://example.test/qwen", model: "qwen3.8-flash", apiKey: "synthetic-key", dataDisclosureAccepted: true }
  };
}
