import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { setProviderEgressSink } from "../src/privacy";
import type { ProviderEgressAuditRecord } from "../src/privacy";
import type { AiToolCall, AiToolDefinition } from "../src/ai";

vi.mock("obsidian", () => ({
  requestUrl: vi.fn()
}));

const { LifeOpsAi, buildChatRequestBody, buildEmbeddingRequestBody, extractEmbeddingVector, parseToolCalls } = await import("../src/ai");

const requestUrlMock = requestUrl as unknown as ReturnType<typeof vi.fn>;

const TEST_TOOLS: AiToolDefinition[] = [
  tool("create_task"),
  tool("complete_task"),
  tool("delete_task"),
  tool("create_habit"),
  tool("complete_habit"),
  tool("miss_habit")
];

const REAL_PHRASES: Array<{ text: string; call: AiToolCall }> = [
  { text: "我明天得去趟银行", call: call("create_task", { title: "去银行", date: "明天" }) },
  { text: "下午记得去拿快递", call: call("create_task", { title: "拿快递", date: "今天", time: "下午" }) },
  { text: "周五前我要把材料发给李总", call: call("create_task", { title: "把材料发给李总" }) },
  { text: "晚上提醒我复盘一下交易", call: call("create_task", { title: "复盘交易", date: "今天", time: "晚上" }) },
  { text: "明早得联系客户确认合同", call: call("create_task", { title: "联系客户确认合同", date: "明天" }) },
  { text: "下班前把发票整理一下", call: call("create_task", { title: "整理发票", date: "今天" }) },
  { text: "这个创业大赛材料明天继续处理", call: call("create_task", { title: "处理创业大赛材料", date: "明天" }) },
  { text: "我今晚要写一段项目总结", call: call("create_task", { title: "写项目总结", date: "今天", time: "晚上" }) },
  { text: "明天上午九点跟王总打电话", call: call("create_task", { title: "跟王总打电话", date: "明天", time: "09:00" }) },
  { text: "把体检预约这件事排到后天", call: call("create_task", { title: "预约体检", date: "后天" }) },
  { text: "给客户打电话的事办完了", call: call("complete_task", { taskIdOrTitle: "给客户打电话" }) },
  { text: "银行那件事已经处理好了", call: call("complete_task", { taskIdOrTitle: "银行" }) },
  { text: "材料已经发给李总了", call: call("complete_task", { taskIdOrTitle: "材料发给李总" }) },
  { text: "今天的交易复盘写完了", call: call("complete_task", { taskIdOrTitle: "交易复盘" }) },
  { text: "快递拿到了", call: call("complete_task", { taskIdOrTitle: "拿快递" }) },
  { text: "把那个厚崇公众号任务删掉", call: call("delete_task", { taskIdOrTitle: "厚崇公众号" }) },
  { text: "那个莫名其妙的银行任务不要了", call: call("delete_task", { taskIdOrTitle: "银行" }) },
  { text: "删除创业大赛沟通那条待办", call: call("delete_task", { taskIdOrTitle: "创业大赛沟通" }) },
  { text: "客户电话这个任务不用了", call: call("delete_task", { taskIdOrTitle: "客户电话" }) },
  { text: "体检预约那条先删掉", call: call("delete_task", { taskIdOrTitle: "体检预约" }) },
  { text: "我想养成每天早起的习惯", call: call("create_habit", { name: "早起", frequencyUnit: "day", targetCount: 1 }) },
  { text: "加一个每周三次跑步", call: call("create_habit", { name: "跑步", frequencyUnit: "week", targetCount: 3 }) },
  { text: "以后每天背单词也打卡", call: call("create_habit", { name: "背单词", frequencyUnit: "day", targetCount: 1 }) },
  { text: "设置一个每周两次力量训练", call: call("create_habit", { name: "力量训练", frequencyUnit: "week", targetCount: 2 }) },
  { text: "我想每天睡前复盘十分钟", call: call("create_habit", { name: "睡前复盘", frequencyUnit: "day", targetCount: 1 }) },
  { text: "跑步已经跑完了", call: call("complete_habit", { name: "跑步" }) },
  { text: "英语今天打卡了", call: call("complete_habit", { name: "英语" }) },
  { text: "不吃晚饭今天做到了", call: call("complete_habit", { name: "不吃晚饭" }) },
  { text: "最近太累不想健身", call: call("miss_habit", { name: "健身", reason: "太累" }) },
  { text: "今天跑步先请假，膝盖不舒服", call: call("miss_habit", { name: "跑步", reason: "膝盖不舒服" }) }
];

describe("AI tool calling", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  afterEach(() => {
    setProviderEgressSink(null);
    vi.unstubAllGlobals();
  });

  it.each(["stream", "finite"] as const)("hides echoed tool results from the %s answer", async transport => {
    const parts = ["İ核对。<res", "ult><name>get_stats</name><output>虚构内部资料</output></res", "ult>本周跑步完成25%。<result>未闭合的虚构内部资料"];
    const fetchMock = vi.fn().mockResolvedValueOnce(streamResponse([
      ...parts.map(content => streamData({ choices: [{ delta: { content } }] })), "data: [DONE]"
    ]));
    vi.stubGlobal("fetch", fetchMock);
    requestUrlMock.mockResolvedValueOnce({ status: 200, json: { choices: [{ message: { content: parts.join("") } }] } });
    const onText = vi.fn();
    const response = await new LifeOpsAi(testSettings()).agentTurnStream([
      { role: "user", content: "评价虚构一周" },
      { role: "tool", tool_call_id: "fictional-read", content: "纯虚构统计" }
    ], onText, { preferFinite: transport === "finite" });
    expect(response.content).toBe("İ核对。本周跑步完成25%。");
    expect(response.toolCalls).toEqual([]);
    expect(onText.mock.calls.map(([content]) => content)).toEqual(transport === "finite"
      ? [response.content] : ["İ核对。", response.content, response.content]);
  });

  it("serializes actual source receipts with only read tools on the delegated fallback configuration", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(streamResponse([streamData({ choices: [{ delta: { content: "纯虚构依据及反例。" } }] }), "data: [DONE]"])); vi.stubGlobal("fetch", fetchMock);
    const ai = new LifeOpsAi(testSettings()), receipt = "纯虚构末页正文，不是摘要。", reads = [{ calls: [{ id: "read-page", name: "query_vault", arguments: { domain: "journal", operation: "get", path: "虚构.md", offset: 18000 } }], results: [{ callId: "read-page", success: true, output: receipt }] }];
    await ai.delegatedReplyStream("ctx", "分析最近日记", [], () => {}, "text", { tools: [tool("query_vault"), ...TEST_TOOLS], sourceReadTurns: reads });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string); expect(body.tools.map((item: any) => item.function.name)).toEqual(["query_vault"]); expect(body.tool_choice).toBe("auto");
    expect(body.messages.find((item: any) => item.role === "tool")).toMatchObject({ tool_call_id: "read-page", content: receipt }); expect(JSON.stringify(body.messages)).toContain("mtime不是日记日期");
  });
  it("keeps the final delegated source analysis answer-only and refuses an untrusted write receipt before transport", async () => {
    const ai = new LifeOpsAi(testSettings()), fetchMock = vi.fn().mockResolvedValueOnce(streamResponse([streamData({ choices: [{ delta: { content: "有限分析" } }] }), "data: [DONE]"])); vi.stubGlobal("fetch", fetchMock);
    await ai.delegatedReplyStream("ctx", "分析最近日记", [], () => {}, "text", { sourceReadTurns: [] });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string); expect(body.tools).toBeUndefined(); expect(body.tool_choice).toBeUndefined();
    await expect(ai.delegatedReplyStream("ctx", "分析", [], () => {}, "text", { tools: TEST_TOOLS, sourceReadTurns: [{ calls: [{ id: "write", name: "create_task", arguments: {} }], results: [{ callId: "write", success: true, output: "不能冒作只读" }] }] })).rejects.toThrow("只读原文回执"); expect(fetchMock).toHaveBeenCalledOnce(); expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it("adds OpenAI-compatible tool definitions to the chat request body", () => {
    const body = buildChatRequestBody("model-a", [{ role: "user", content: "hello" }], { tools: TEST_TOOLS });

    expect(body.temperature).toBe(0.2);
    expect(body.tools).toHaveLength(6);
    expect(body.tool_choice).toBe("auto");
    expect(JSON.stringify(body.tools)).toContain("create_task");
  });

  it("uses non-thinking Kimi requests for chat and tool calls", () => {
    const body = buildChatRequestBody("kimi-k2.6", [{ role: "user", content: "hello" }], { tools: TEST_TOOLS });

    expect(body).not.toHaveProperty("temperature");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.tools).toHaveLength(6);
  });

  it.each(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"])("bounds requested historical reasoning effort for %s", model => {
    const body = buildChatRequestBody(model, [{ role: "user", content: "只根据已读原文核对历史。" }],
      { reasoning: "enabled", reasoningEffort: "low", maxTokens: 4096 });
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("low"); expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty("tools");
  });

  it("keeps effort off other models, non-thinking and unrequested DeepSeek requests", () => {
    for (const model of ["kimi-k2.6", "model-a"]) expect(buildChatRequestBody(model, [],
      { reasoning: "enabled", reasoningEffort: "low" })).not.toHaveProperty("reasoning_effort");
    expect(buildChatRequestBody("deepseek-v4-flash", [], { reasoning: "disabled", reasoningEffort: "low" })).not.toHaveProperty("reasoning_effort");
    expect(buildChatRequestBody("deepseek-v4-flash", [], { reasoning: "enabled" })).not.toHaveProperty("reasoning_effort");
  });

  it("keeps standard embedding input as a plain string", () => {
    const body = buildEmbeddingRequestBody("text-embedding-v4", "hello");

    expect(body).toEqual({
      model: "text-embedding-v4",
      input: "hello"
    });
  });

  it("extracts standard OpenAI-compatible embedding vectors", () => {
    expect(extractEmbeddingVector({ data: [{ embedding: [0.1, 0.2] }] })).toEqual([0.1, 0.2]);
    expect(extractEmbeddingVector({ data: { embedding: [0.3, 0.4] } })).toEqual([]);
  });

  it("parses standard OpenAI tool calls", () => {
    const calls = parseToolCalls(modelToolResponse(call("create_task", { title: "去银行", date: "明天" })).json);

    expect(withoutIds(calls)).toEqual([call("create_task", { title: "去银行", date: "明天" })]);
  });

  it("parses multiple standard tool calls", () => {
    const calls = parseToolCalls({
      choices: [{
        message: {
          content: "",
          tool_calls: [
            rawToolCall(call("create_task", { title: "去银行" })),
            rawToolCall(call("complete_habit", { name: "跑步" }))
          ]
        }
      }]
    });

    expect(calls.map((item) => item.name)).toEqual(["create_task", "complete_habit"]);
  });

  it("parses object arguments without stringifying assumptions", () => {
    const calls = parseToolCalls({ tool_calls: [{ name: "miss_habit", arguments: { name: "健身", reason: "太累" } }] });

    expect(calls[0].arguments).toEqual({ name: "健身", reason: "太累" });
  });

  it("parses fenced JSON tool fallback content", () => {
    const calls = parseToolCalls([
      "```lifeops-tool",
      JSON.stringify({ tool_calls: [call("complete_task", { taskIdOrTitle: "拿快递" })], reply: "好" }),
      "```"
    ].join("\n"));

    expect(calls).toEqual([call("complete_task", { taskIdOrTitle: "拿快递" })]);
  });

  it("parses tagged JSON tool fallback content", () => {
    const calls = parseToolCalls(`<tool_call>${JSON.stringify(call("create_habit", { name: "早起" }))}</tool_call>`);

    expect(calls).toEqual([call("create_habit", { name: "早起" })]);
  });

  it("ignores invalid tool argument JSON without throwing", () => {
    const calls = parseToolCalls({ tool_calls: [{ function: { name: "create_task", arguments: "{" } }] });

    expect(calls).toEqual([{ name: "create_task", arguments: {} }]);
  });

  it("returns no calls for ordinary text", () => {
    expect(parseToolCalls("今天天气不错，先轻松聊一下。")).toEqual([]);
  });

  it("returns content and tool calls from agentReply", async () => {
    requestUrlMock.mockResolvedValueOnce(modelToolResponse(call("create_task", { title: "去银行", date: "明天" }), "我来安排。"));
    const ai = new LifeOpsAi(testSettings());

    const result = await ai.agentReply("ctx", "我明天得去趟银行", [], "text", { tools: TEST_TOOLS });

    expect(result.content).toBe("我来安排。");
    expect(withoutIds(result.toolCalls)).toEqual([call("create_task", { title: "去银行", date: "明天" })]);
  });

  it("audits Provider request metadata without copying private request text", async () => {
    const records: ProviderEgressAuditRecord[] = [];
    setProviderEgressSink((record) => {
      records.push(record);
    });
    requestUrlMock.mockResolvedValueOnce(modelToolResponse(call("create_task", { title: "测试" }), "已处理。"));
    const privateText = "这是不应出现在外发审计里的私人原话";
    const ai = new LifeOpsAi(testSettings());

    await ai.agentReply("# Retrieved Vault Notes\n\n### 私密/A.md\n正文", privateText, [], "text", { tools: TEST_TOOLS });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      capability: "text",
      purpose: "tool_chat",
      sourceCount: 1,
      contentLogged: false
    });
    expect(records[0].requestBytes).toBeGreaterThan(0);
    expect(JSON.stringify(records[0])).not.toContain(privateText);
  });

  it("performs zero Provider requests before text disclosure is accepted", async () => {
    const settings = testSettings();
    settings.ai.dataDisclosureAccepted = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ai = new LifeOpsAi(settings);

    const result = await ai.agentReply("private context", "hello", [], "text", { tools: TEST_TOOLS });

    expect(result.content).toContain("尚未授权 text Provider 数据发送");
    expect(requestUrlMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("performs zero Provider requests before plaintext credential risk is accepted", async () => {
    const settings = testSettings();
    settings.privacy = {
      excludedVaultPrefixes: [],
      plaintextCredentialStorageAccepted: false
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ai = new LifeOpsAi(settings);

    await expect(ai.agentReply("private context", "hello", [], "text", { tools: TEST_TOOLS }))
      .rejects.toThrow("data.json");
    expect(requestUrlMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("excludes echoed credentials and Provider error payloads from text errors", async () => {
    const secret = "provider-secret-123456";
    const settings = testSettings();
    settings.ai.apiKey = secret;
    requestUrlMock.mockResolvedValueOnce({
      status: 401,
      text: "",
      json: { error: { message: `Authorization: Bearer ${secret}` } }
    });
    const ai = new LifeOpsAi(settings);

    const error = await ai.agentReply("ctx", "hello", [], "text", { tools: TEST_TOOLS })
      .then(() => "no error", (reason: unknown) => reason instanceof Error ? reason.message : String(reason));

    expect(error).toContain("auth");
    expect(error).not.toContain("Authorization");
    expect(error).not.toContain(secret);
  });

  it("keeps the excluded Tingwu/OSS path at zero network requests", async () => {
    const settings = testSettings();
    settings.voice.provider = "aliyun-tingwu";
    settings.voice.dataDisclosureAccepted = true;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ai = new LifeOpsAi(settings);

    await expect(ai.transcribeAudio(new Blob(["audio"]))).rejects.toThrow("Tingwu/OSS 旧转写链已从 LifeOps 0.2 排除");
    expect(requestUrlMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accumulates streamed tool call deltas from agentReplyStream", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(streamResponse([
      streamData({ choices: [{ delta: { content: "我来" } }] }),
      streamData({ choices: [{ delta: { content: "安排。" } }] }),
      streamData({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call-create-task",
              type: "function",
              function: {
                name: "create_task",
                arguments: "{\"title\":\"去"
              }
            }]
          }
        }]
      }),
      streamData({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: {
                arguments: "银行\",\"date\":\"明天\"}"
              }
            }]
          }
        }]
      }),
      "data: [DONE]"
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const ai = new LifeOpsAi(testSettings());
    const seen: string[] = [];

    const result = await ai.agentReplyStream("ctx", "我明天得去趟银行", [], (content) => seen.push(content), "text", { tools: TEST_TOOLS });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { stream?: boolean; tools?: unknown[] };

    expect(body.stream).toBe(true);
    expect(body.tools).toHaveLength(6);
    expect(result.content).toBe("我来安排。");
    expect(seen.at(-1)).toBe("我来安排。");
    expect(withoutIds(result.toolCalls)).toEqual([call("create_task", { title: "去银行", date: "明天" })]);
  });

  it.each(["", " ", null, undefined])("fails closed when the provider finishes a parameterless tool call without an object (%j)", async args => {
    const pendingCall = { id: "undo-synthetic", type: "function", function: { name: "undo_latest_operation", arguments: args } };
    const fetchMock = vi.fn().mockImplementation(async () => streamResponse([
      streamData({ choices: [{ delta: { tool_calls: [{ index: 0, ...pendingCall }] } }] }),
      "data: [DONE]"
    ]));
    vi.stubGlobal("fetch", fetchMock);
    requestUrlMock.mockResolvedValue({ status: 200, json: { choices: [{ message: { tool_calls: [pendingCall] } }] } });
    const ai = new LifeOpsAi(testSettings());
    await expect(ai.agentReplyStream("ctx", "虚构测试", [], () => {}, "text", { tools: TEST_TOOLS })).rejects.toThrow();
    await expect(ai.agentReply("ctx", "虚构测试", [], "text", { tools: TEST_TOOLS })).rejects.toThrow();
  });

  it("accepts streamed tool-only responses without visible text", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(streamResponse([
      streamData({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call-complete-habit",
              type: "function",
              function: {
                name: "complete_habit",
                arguments: "{\"name\":\"跑步\"}"
              }
            }]
          }
        }]
      }),
      "data: [DONE]"
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const ai = new LifeOpsAi(testSettings());
    const onText = vi.fn();

    const result = await ai.agentReplyStream("ctx", "跑步已经跑完了", [], onText, "text", { tools: TEST_TOOLS });

    expect(result.content).toBe("");
    expect(onText).not.toHaveBeenCalled();
    expect(withoutIds(result.toolCalls)).toEqual([call("complete_habit", { name: "跑步" })]);
  });

  it("returns tool evidence to the model before producing the user-facing answer", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(streamResponse([
      streamData({ choices: [{ delta: { content: "根据原文，最后一篇日记是 7 月 27 日。" } }] }),
      "data: [DONE]"
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const ai = new LifeOpsAi(testSettings());
    const seen: string[] = [];

    const result = await ai.agentReplyAfterToolResultsStream(
      "ctx",
      "读我最后一篇日记",
      [],
      [{ id: "call-journal", name: "query_vault", arguments: { domain: "journal", operation: "get" } }],
      [{ callId: "call-journal", success: true, output: "path: 日记/2026-07-27晚.md\n原文：复盘交易" }],
      (text) => seen.push(text),
      "text",
      { tools: TEST_TOOLS }
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { tools?: unknown[]; messages?: Array<{ role: string; content: string; tool_call_id?: string }> };

    expect(body.tools).toBeUndefined();
    expect(body.messages?.some((item) => item.role === "tool" && item.tool_call_id === "call-journal" && item.content.includes("日记/2026-07-27晚.md"))).toBe(true);
    expect(result.content).toContain("7 月 27 日");
    expect(seen.at(-1)).toContain("7 月 27 日");
  });



  it("sends a bounded weekly proposal as a nonstream tool request with the actual read receipt", async () => {
    requestUrlMock.mockResolvedValueOnce(modelToolResponse(call("propose_weekly_review", { sourceToken: "fiction-token", hypotheses: [] })));
    const ai = new LifeOpsAi(testSettings()), calls = [{ id: "fiction-weekly-read", name: "inspect_weekly_review_sources", arguments: { paths: ["Notes/纯虚构.md"] } }];
    const result = await ai.agentWeeklyReviewProposal("ctx", "请核对周回顾", [], calls,
      [{ callId: calls[0].id, success: true, output: '{"sourceToken":"fiction-token","notes":[]}' }], "text", { tools: [tool("propose_weekly_review"), ...TEST_TOOLS] });
    const body = JSON.parse(requestUrlMock.mock.calls[0][0].body);
    expect(body.stream).toBeUndefined(); expect(body.tools.map((tool: any) => tool.function.name)).toEqual(["propose_weekly_review"]);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "propose_weekly_review" } });
    expect(body.messages.some((message: any) => message.role === "tool" && message.tool_call_id === calls[0].id && message.content.includes("fiction-token"))).toBe(true);
    expect(result.toolCalls[0].name).toBe("propose_weekly_review");
  });
  it("sends only a token-bound note proposal with the actual source tool receipt", async () => {
    requestUrlMock.mockResolvedValueOnce(modelToolResponse(call("propose_note_understanding", { sourceToken: "fiction-token", path: "Notes/纯虚构.md", candidates: [] })));
    const ai = new LifeOpsAi(testSettings()), calls = [{ id: "fiction-note-source", name: "inspect_note_understanding_source", arguments: { path: "Notes/纯虚构.md" } }], raw = '{"sourceToken":"fiction-token","path":"Notes/纯虚构.md","text":"纯虚构原文"}';
    await ai.agentNoteUnderstandingProposal("ctx", "请重新核对", [], calls, [{ callId: calls[0].id, success: true, output: raw }], "text", { tools: [tool("propose_note_understanding"), ...TEST_TOOLS] });
    const body = JSON.parse(requestUrlMock.mock.calls[0][0].body); expect(body.stream).toBeUndefined(); expect(body.tools.map((tool: any) => tool.function.name)).toEqual(["propose_note_understanding"]); expect(body.tool_choice.function.name).toBe("propose_note_understanding"); expect(body.messages.find((message: any) => message.role === "tool")).toMatchObject({ tool_call_id: calls[0].id, content: raw });
  });
  it("refuses an unrelated or mismatched note read before requesting a provider", async () => {
    const ai = new LifeOpsAi(testSettings()); await expect(ai.agentNoteUnderstandingProposal("ctx", "请核对", [], [{ id: "fiction-note-source", name: "inspect_note_understanding_source", arguments: {} }], [{ callId: "different", success: true, output: "纯虚构" }], "text", { tools: [tool("propose_note_understanding")] })).rejects.toThrow("原文未完成核对"); expect(requestUrlMock).not.toHaveBeenCalled();
  });
  it("cancels a note followup before any provider request", async () => {
    const ai = new LifeOpsAi(testSettings()), controller = new AbortController(); controller.abort(); await expect(ai.agentNoteUnderstandingProposal("ctx", "请核对", [], [], [], "text", { signal: controller.signal, tools: [tool("propose_note_understanding")] })).rejects.toThrow(); expect(requestUrlMock).not.toHaveBeenCalled();
  });
  it("does not send a weekly followup for a failed or unrelated read receipt", async () => {
    const ai = new LifeOpsAi(testSettings());
    await expect(ai.agentWeeklyReviewProposal("ctx", "请核对", [], [{ id: "wrong-read", name: "query_vault", arguments: {} }], [{ callId: "wrong-read", success: true, output: "纯虚构" }], "text", { tools: [tool("propose_weekly_review")] })).rejects.toThrow("原文未完成核对");
    expect(requestUrlMock).not.toHaveBeenCalled();
  });
  it("cancels the weekly followup before a provider request", async () => {
    const ai = new LifeOpsAi(testSettings()), controller = new AbortController(); controller.abort();
    await expect(ai.agentWeeklyReviewProposal("ctx", "请核对", [], [], [], "text", { signal: controller.signal, tools: [tool("propose_weekly_review")] })).rejects.toThrow(); expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it("aborts a routed voice brain request without starting fallback requests", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ai = new LifeOpsAi(testSettings());
    const controller = new AbortController();
    const request = ai.agentReplyStream(
      "ctx",
      "分析我的日记",
      [],
      vi.fn(),
      "voice",
      { signal: controller.signal }
    );

    controller.abort("barge_in");

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it.each(REAL_PHRASES)("sends tools and parses the expected call for real phrase: $text", async (item) => {
    const ai = new LifeOpsAi(testSettings());
    requestUrlMock.mockResolvedValueOnce(modelToolResponse(item.call, "收到。"));
    const result = await ai.agentReply("ctx", item.text, [], "text", { tools: TEST_TOOLS });
    const body = JSON.parse(requestUrlMock.mock.calls.at(-1)?.[0].body ?? "{}") as { tools?: unknown[]; messages?: Array<{ content?: string }> };

    expect(body.tools).toHaveLength(6);
    expect(body.messages?.at(-1)?.content).toContain(item.text);
    expect(withoutIds(result.toolCalls)).toEqual([item.call]);
  });

  it("keeps disabled AI as a text result without tools", async () => {
    const ai = new LifeOpsAi(DEFAULT_SETTINGS);

    const result = await ai.agentReply("ctx", "我明天得去趟银行", [], "text", { tools: TEST_TOOLS });

    expect(result.content).toContain("AI 未启用");
    expect(result.toolCalls).toEqual([]);
  });
});

function tool(name: string): AiToolDefinition {
  return {
    name,
    description: name,
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  };
}

function call(name: string, args: Record<string, unknown>): AiToolCall {
  return {
    name,
    arguments: args
  };
}

function withoutIds(calls: AiToolCall[]): AiToolCall[] {
  return calls.map((item) => ({
    name: item.name,
    arguments: item.arguments
  }));
}

function rawToolCall(toolCall: AiToolCall): Record<string, unknown> {
  return {
    id: `call-${toolCall.name}`,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments)
    }
  };
}

function modelToolResponse(toolCall: AiToolCall, content = ""): { status: number; text: string; json: Record<string, unknown> } {
  return {
    status: 200,
    text: "",
    json: {
      choices: [{
        message: {
          content,
          tool_calls: [rawToolCall(toolCall)]
        }
      }]
    }
  };
}

function streamData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`;
}

function streamResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n\n`));
      }
      controller.close();
    }
  }), { status: 200 });
}

function testSettings(): typeof DEFAULT_SETTINGS {
  return {
    ...DEFAULT_SETTINGS,
    privacy: {
      ...DEFAULT_SETTINGS.privacy,
      excludedVaultPrefixes: [],
      plaintextCredentialStorageAccepted: true
    },
    ai: {
      ...DEFAULT_SETTINGS.ai,
      provider: "openai-compatible",
      endpoint: "https://example.test/chat",
      model: "tool-model",
      apiKey: "test-key",
      dataDisclosureAccepted: true
    }
  };
}
