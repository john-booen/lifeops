import type { AiChatResult, AiToolDefinition, ChatMessage } from "../ai";
import { formatTaskListReply } from "../features/tasks/planTools";

export interface TaskLookupResolution {
  tool: AiToolDefinition;
  messages: ChatMessage[];
  ids: Set<string>;
  fallback: string;
}

/** A read result is not an executable confirmation, regardless of model prose. */
export function taskLookupResolution(messages: ChatMessage[], results: ReadonlyMap<string, { success: boolean; output: string }>,
  tools: AiToolDefinition[], today: string): TaskLookupResolution | undefined {
  const last = messages.at(-1);
  if (last?.role !== "tool" || !last.tool_call_id) return;
  const call = messages.flatMap(message => message.tool_calls ?? []).find(row => row.id === last.tool_call_id);
  const result = results.get(last.tool_call_id), updateTool = tools.find(tool => tool.name === "update_tasks");
  if (call?.function.name !== "list_tasks" || !result?.success || !updateTool) return;
  let payload: { tasks?: { id?: unknown }[]; truncated?: boolean };
  try { payload = JSON.parse(result.output); } catch { return; }
  if (!Array.isArray(payload.tasks) || payload.tasks.length < 4) return;
  const ids = new Set(payload.tasks.flatMap(task => typeof task.id === "string" && task.id ? [task.id] : []));
  if (ids.size !== payload.tasks.length) return;
  const properties = updateTool.parameters.properties as Record<string, unknown> | undefined;
  if (!properties?.updates) return;
  const tool: AiToolDefinition = { name: "resolve_task_lookup", description: "按用户原请求区分只读答复与待确认的整批修改；此工具本身不保存。",
    parameters: { type: "object", additionalProperties: false, properties: {
      kind: { type: "string", enum: ["read_only", "prepare_updates", "unclear"] },
      reply: { type: "string" }, coversAllRequested: { type: "boolean" }, updates: properties.updates
    }, required: ["kind"] } };
  const instruction = "刚才只读取了任务清单，尚未生成修改确认卡，也没有保存。必须调用resolve_task_lookup核对原始用户请求。"
    + "用户仅要查询、解释、假设或建议时选read_only，reply只回答所问，不声称生成卡或保存。"
    + "用户明确要求准备至少四条已有任务的修改时，选prepare_updates，把全部所要求的修改一次放进updates，coversAllRequested=true。"
    + "taskIdOrTitle必须照抄已读ID，保留未要求改变的字段。不要从助手自写表格或口头承诺推导用户授权。"
    + "未确定的想法、条件句或只讨论不要变成修改；清单不足或无法完整表达就选unclear，不编造确认卡。";
  return { tool, ids, messages: messages.map((message, index) => index === 0 && message.role === "system"
    ? { ...message, content: message.content + "\n" + instruction } : message),
    fallback: "任务清单已读回，但尚未生成可执行的调整卡，也没有保存修改。\n" + formatTaskListReply(result.output, today) };
}

export function resolvedTaskLookup(response: AiChatResult, lookup: TaskLookupResolution): AiChatResult {
  const unavailable = () => ({ ...response, content: lookup.fallback, toolCalls: [] });
  const call = response.toolCalls[0];
  if (response.toolCalls.length !== 1 || call.name !== lookup.tool.name) return unavailable();
  const args = call.arguments;
  if (Object.keys(args).some(key => !["kind", "reply", "coversAllRequested", "updates"].includes(key))) return unavailable();
  if (args.kind === "read_only" && args.updates === undefined && typeof args.reply === "string" && args.reply.trim()) {
    return { ...response, content: args.reply.trim(), toolCalls: [] };
  }
  if (args.kind !== "prepare_updates" || args.coversAllRequested !== true || !Array.isArray(args.updates)
    || args.updates.length < 4 || args.updates.length > 20) return unavailable();
  const ids = args.updates.map(row => row && typeof row === "object" && !Array.isArray(row) ? row.taskIdOrTitle : undefined);
  if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !lookup.ids.has(id))) return unavailable();
  return { ...response, content: "", toolCalls: [{ name: "update_tasks", arguments: { updates: args.updates } }] };
}
