import type { AiChatResult, ChatMessage } from "../ai";

const starts = ["<｜｜DSML｜｜", "<｜DSML｜"];
export const TOOL_PROTOCOL_UNAVAILABLE = "模型这次没有返回可用的正文。已完成的操作以保存回执为准，本次没有执行额外工具，请稍后继续。";

/** Wire-format text is never decoded into executable calls. */
export const isLeakedToolProtocol = (text: string): boolean => starts.some(start => text.trimStart().startsWith(start));
export const holdToolProtocolPrefix = (text: string): boolean => !!text.trimStart()
  && starts.some(start => start.startsWith(text.trimStart()) || text.trimStart().startsWith(start));

export function toolProtocolRepairMessages(messages: ChatMessage[]): ChatMessage[] {
  const instruction = "本次服务没有返回可显示的正文。只根据本轮用户要求、已读资料和实际保存回执直接回答；不要调用工具、不要输出内部协议，不声称执行了额外操作。资料不足时说明具体缺项，不编造。";
  return messages[0]?.role === "system"
    ? [{ ...messages[0], content: messages[0].content + "\n" + instruction }, ...messages.slice(1)]
    : [{ role: "system", content: instruction }, ...messages];
}

export function unavailableToolProtocol(response: AiChatResult): AiChatResult {
  return { ...response, content: TOOL_PROTOCOL_UNAVAILABLE, toolCalls: [] };
}
