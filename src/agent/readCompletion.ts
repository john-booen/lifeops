import type { AiChatResult, AiToolDefinition, ChatMessage } from "../ai";
import type { ToolCallResult } from "../agentRuntime";

export const READ_COMPLETION_TOOL: AiToolDefinition = {
  name: "verify_read_completion",
  description: "只核对已读结果是否完成用户整句请求，不查询、不保存。",
  parameters: { type: "object", additionalProperties: false, properties: {
    disposition: { type: "string", enum: ["complete", "continue"] }
  }, required: ["disposition"] }
};

export function readCompletionMessages(messages: ChatMessage[], results: readonly ToolCallResult[], request: string, answer: string): ChatMessage[] {
  return [...messages, ...results.map(result => ({ role: "tool" as const, tool_call_id: result.callId, content: result.output })),
    { role: "system", content: "只核对当前已读结果能否结束整句。必须调用verify_read_completion。"
      + "只有候选答复已根据核对结果完成全部只读要求、且没有剩余请求时，才选complete。只读要求可以包含数字、清单、指标定义或已有依据的解释建议。"
      + "用户还要求尚未执行的创建、修改、排程、其他领域查询，或候选尚未覆盖的解释建议时，选continue；不能以本次answerMode/directReply提示代替用户整句。"
      + "未来条件、举例和引用不构成写入授权；本核对不执行任何工具，不新增授权。不确定也选continue。"
      + "\n本轮用户原请求：\n" + request + "\n候选只读答复：\n" + answer }];
}

export function readCompletionConfirmed(response: AiChatResult): boolean {
  const [call] = response.toolCalls;
  return response.toolCalls.length === 1 && call.name === READ_COMPLETION_TOOL.name
    && Object.keys(call.arguments).length === 1 && call.arguments.disposition === "complete";
}

export const CONTINUE_AFTER_READ = "本轮查询只完成了部分请求。继续按最初用户整句完成尚未完成的内容；不要仅因answerMode或directReply提示而结束。"
  + "不要重复已经成功的读取；沿原工具处理创建、修改、规划或说明。此核对不提供写入授权，取消、等待确认及举例保护仍按原规则执行。";
