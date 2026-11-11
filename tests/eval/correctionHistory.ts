import { personalMemoryContextRevision } from "../../src/personalMemoryContext";
import { attestAgentHistoryResponse, bindAgentHistoryResponse } from "../../src/personalMemoryHistory";
import { memorySourcePolicy, readPersonalMemoryWithSources } from "../../src/personalMemorySources";
import type { StoreHost } from "../../src/store/settingsSlice";
import type { AgentConversationMessage } from "../../src/types";
import type { EvalQuestion } from "./scoring";

export async function correctionHistory(question: EvalQuestion, store: StoreHost): Promise<AgentConversationMessage[]> {
  const history = structuredClone(question.history);
  if (!history.length || question.domain !== "voice-correction" && question.fixture !== "task_already_undone") return history;

  // These pairs stand in for completed turns in the same fictional vault and policy.
  const memories = (await readPersonalMemoryWithSources(store)).records;
  const revision = personalMemoryContextRevision(memories), policy = memorySourcePolicy(store);
  for (let index = 0; index < history.length; index += 2) {
    const user = history[index], assistant = history[index + 1];
    if (user?.role !== "user" || assistant?.role !== "assistant") throw Error("虚构纠正历史缺少完整问答对。");
    const response = attestAgentHistoryResponse({ reply: assistant.content, actions: [] }, store, revision, policy, user.content);
    bindAgentHistoryResponse(response, user, assistant);
  }
  return history;
}
