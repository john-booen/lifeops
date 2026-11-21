import { recordRevision } from "../operationIdentity";
import { isLiteralTaskConfirmation } from "../features/tasks/confirmationText";
import type { AgentActionSuggestion, AgentConversationMessage } from "../types";

interface PlanView {
  agentMessages: AgentConversationMessage[];
  pendingAgentActions: AgentActionSuggestion[];
}
const adjacentPlans = new WeakMap<object, { action: AgentActionSuggestion; message: AgentConversationMessage; revision: string }>();

export function armAdjacentTaskPlan(view: PlanView, message: AgentConversationMessage, delivered: AgentActionSuggestion[]): void {
  adjacentPlans.delete(view);
  if (view.pendingAgentActions.length !== 1 || delivered.length !== 1) return;
  const action = view.pendingAgentActions[0], calls = action.toolBatch;
  if (action !== delivered[0] || action.type !== "tool_batch" || !calls?.length
    || calls.some(call => !["update_tasks", "create_task"].includes(call.name))) return;
  const updates = calls.filter(call => call.name === "update_tasks").flatMap(call => Array.isArray(call.arguments.updates) ? call.arguments.updates : []);
  if (!updates.length || !updates.every(row => row && typeof row.expectedRevision === "string")) return;
  adjacentPlans.set(view, { action, message, revision: recordRevision(action) });
}

/** A literal reply authorizes only the single frozen plan in the immediately preceding response. */
export function consumeAdjacentTaskPlan(view: PlanView, text: string): AgentActionSuggestion | undefined {
  const pending = adjacentPlans.get(view); adjacentPlans.delete(view);
  if (!isLiteralTaskConfirmation(text) || !pending || view.agentMessages.at(-1) !== pending.message
    || view.pendingAgentActions.length !== 1 || view.pendingAgentActions[0] !== pending.action
    || recordRevision(pending.action) !== pending.revision) return;
  return pending.action;
}
