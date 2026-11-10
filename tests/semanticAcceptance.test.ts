import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { agentToolsForChat } from "../src/toolRegistry";
import type { AiToolCall } from "../src/ai";

vi.mock("obsidian", () => ({
  requestUrl: vi.fn()
}));

const { LifeOpsAi } = await import("../src/ai");
const requestUrlMock = requestUrl as unknown as ReturnType<typeof vi.fn>;

type AcceptanceDomain = "journal" | "task" | "habit" | "trade" | "health" | "personal_memory";

interface SemanticAcceptanceScenario {
  domain: AcceptanceDomain;
  message: string;
  expected: AiToolCall;
}

const SCENARIOS: SemanticAcceptanceScenario[] = [
  { domain: "journal", message: "我最后一篇日记主要写了什么？", expected: call("query_vault", { domain: "journal", operation: "get" }) },
  { domain: "journal", message: "找找最近日记里提到项目复盘的段落", expected: call("query_vault", { domain: "journal", operation: "search", query: "项目复盘" }) },
  { domain: "journal", message: "列出最近五篇日记让我挑一篇", expected: call("query_vault", { domain: "journal", operation: "list", sort: "newest", limit: 5 }) },
  { domain: "journal", message: "把今天第一次独立跑完五公里写进晚间日记", expected: call("append_journal_entry", { content: "今天第一次独立跑完五公里", date: "今天", period: "晚" }) },

  { domain: "task", message: "提醒我明天下午三点给王总发合同", expected: call("create_task", { title: "给王总发合同", date: "明天", time: "15:00" }) },
  { domain: "task", message: "周五之前安排一下整理报销材料", expected: call("create_task", { title: "整理报销材料", date: "周五" }) },
  { domain: "task", message: "体检预约这项已经办完了", expected: call("complete_task", { taskIdOrTitle: "体检预约" }) },
  { domain: "task", message: "把那个重复的银行待办删掉", expected: call("delete_task", { taskIdOrTitle: "银行" }) },

  { domain: "habit", message: "帮我建立每天早起的习惯", expected: call("create_habit", { name: "早起", frequencyUnit: "day", targetCount: 1 }) },
  { domain: "habit", message: "加一个每周三次力量训练", expected: call("create_habit", { name: "力量训练", frequencyUnit: "week", targetCount: 3 }) },
  { domain: "habit", message: "今天英语背词已经打卡了", expected: call("complete_habit", { name: "英语背词" }) },
  { domain: "habit", message: "今天跑步没做，膝盖有点不舒服", expected: call("miss_habit", { name: "跑步", reason: "膝盖不舒服" }) },

  { domain: "trade", message: "找出交易笔记里关于回踩确认的规则", expected: call("query_vault", { domain: "trade", operation: "search", query: "回踩确认" }) },
  { domain: "trade", message: "读一下我最近更新的交易模型", expected: call("query_vault", { domain: "trade", operation: "get", sort: "newest" }) },
  { domain: "trade", message: "列出最近三份交易复盘", expected: call("query_vault", { domain: "trade", operation: "list", sort: "newest", limit: 3 }) },
  { domain: "trade", message: "把这条写进交易模型：没有止损位置就不入场", expected: call("append_trading_model_note", { content: "没有止损位置就不入场", date: "今天" }) },

  { domain: "health", message: "读一下我最近的健康记录", expected: call("query_vault", { domain: "health", operation: "get", sort: "newest" }) },
  { domain: "health", message: "找找健康记录里提到睡眠不足的地方", expected: call("query_vault", { domain: "health", operation: "search", query: "睡眠不足" }) },
  { domain: "health", message: "列出过去几次体重记录", expected: call("query_vault", { domain: "health", operation: "list", query: "体重" }) },
  { domain: "health", message: "把今天睡了七小时、精力一般写进晚间健康记录", expected: call("append_journal_entry", { content: "今天睡了七小时，精力一般", date: "今天", period: "晚", heading: "健康" }) },

  { domain: "personal_memory", message: "你记得我的沟通偏好是什么？", expected: call("query_vault", { domain: "memory", operation: "get", query: "沟通偏好" }) },
  { domain: "personal_memory", message: "有哪些个人记忆还等着我确认？", expected: call("list_personal_memory_candidates", { limit: 10 }) },
  { domain: "personal_memory", message: "确认刚才那条个人记忆", expected: call("review_personal_memory", { memoryId: "memory-1", decision: "confirm" }) },
  { domain: "personal_memory", message: "记住我以后希望回答先给结论", expected: call("append_memory_note", { content: "用户希望回答先给结论", fileName: "个人画像.md" }) }
];

describe("semantic core 24-case natural-language acceptance", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it("covers four scenarios in every required domain", () => {
    const counts = SCENARIOS.reduce<Record<string, number>>((result, scenario) => {
      result[scenario.domain] = (result[scenario.domain] ?? 0) + 1;
      return result;
    }, {});

    expect(SCENARIOS).toHaveLength(24);
    expect(counts).toEqual({
      journal: 4,
      task: 4,
      habit: 4,
      trade: 4,
      health: 4,
      personal_memory: 4
    });
  });

  it.each(SCENARIOS)("routes mocked-provider scenario [$domain] $message", async ({ message, expected }) => {
    requestUrlMock.mockResolvedValueOnce(mockProviderToolResponse(expected));
    const ai = new LifeOpsAi(mockProviderSettings());

    const result = await ai.agentReply(
      "只使用本地事实和工具。",
      message,
      [],
      "text",
      { tools: agentToolsForChat() }
    );
    const request = JSON.parse(requestUrlMock.mock.calls[0][0].body as string) as {
      messages?: Array<{ content?: string }>;
      tools?: Array<{ function?: { name?: string } }>;
    };

    expect(requestUrlMock).toHaveBeenCalledTimes(1);
    expect(request.messages?.at(-1)?.content).toContain(message);
    expect(request.tools?.some((tool) => tool.function?.name === expected.name)).toBe(true);
    expect(result.toolCalls.map(withoutId)).toEqual([expected]);
  });
});

function call(name: string, args: Record<string, unknown>): AiToolCall {
  return { name, arguments: args };
}

function withoutId(value: AiToolCall): AiToolCall {
  return { name: value.name, arguments: value.arguments };
}

function mockProviderToolResponse(toolCall: AiToolCall): { status: number; text: string; json: Record<string, unknown> } {
  return {
    status: 200,
    text: "",
    json: {
      choices: [{
        message: {
          content: "",
          tool_calls: [{
            id: `mock-${toolCall.name}`,
            type: "function",
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments)
            }
          }]
        }
      }]
    }
  };
}

function mockProviderSettings(): typeof DEFAULT_SETTINGS {
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
      endpoint: "https://mock-provider.invalid/chat",
      model: "semantic-acceptance-mock",
      apiKey: "mock-only",
      dataDisclosureAccepted: true
    }
  };
}
