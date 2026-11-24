import type { AiToolDefinition } from "../ai";
import { startsReadOnlyLookup } from "./readOnlyTaskLookup";

/** An explicit lookup inside memory needs a real read, not the shortened prompt. */
export function requestedMemoryLookup(message: string): boolean {
  return startsReadOnlyLookup(message) && (message.includes("记忆里") || message.includes("记忆中"));
}

export function memoryLookupTool(tool: AiToolDefinition): AiToolDefinition {
  return { ...tool, description: "按本轮明确对象读取当前个人记忆；用对象关键词查询，初始上下文省略不表示不存在。",
    parameters: { ...tool.parameters, properties: {
      ...(tool.parameters.properties as Record<string, unknown>),
      domain: { type: "string", enum: ["memory"] }, operation: { type: "string", enum: ["get"] },
      query: { type: "string", minLength: 1, maxLength: 120, description: "本轮点名对象的关键词，不填整句问题。" }
    }, required: ["domain", "operation", "query"] }
  };
}
