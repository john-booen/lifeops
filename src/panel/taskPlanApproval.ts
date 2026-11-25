import { recordRevision } from "../operationIdentity";
import { isLiteralTaskConfirmation } from "../features/tasks/confirmationText";
import { isCurrentRequestedToolBatch } from "../toolBatch";
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
  if (action !== delivered[0]) return;
  // The Job registry still checks its private capability at execution/dismissal.
  if (action.type === 'task_plan' && typeof action.taskPlanToken === 'string' && action.taskPlanToken) {
    adjacentPlans.set(view, {action, message, revision: recordRevision(action)}); return;
  }
  if (action.type !== "tool_batch" || !calls?.length
    || calls.some(call => !["update_tasks", "create_task"].includes(call.name))) return;
  const updates = calls.filter(call => call.name === "update_tasks").flatMap(call => Array.isArray(call.arguments.updates) ? call.arguments.updates : []);
  if (!updates.every(row => row && typeof row.expectedRevision === "string")
    || (!updates.length && !isCurrentRequestedToolBatch(action))) return;
  adjacentPlans.set(view, { action, message, revision: recordRevision(action) });
}

/** A literal reply authorizes only the single frozen plan in the immediately preceding response. */
export function consumeAdjacentTaskPlan(view: PlanView, text: string): AgentActionSuggestion | undefined {
  const decision = consumeAdjacentTaskDecision(view, text);
  return decision?.approved ? decision.action : undefined;
}

/** The same adjacent-card protocol can revoke it; this never invokes a model. */
export function consumeAdjacentTaskDecision(view: PlanView, text: string): {action: AgentActionSuggestion; approved: boolean} | undefined {
  const pending = adjacentPlans.get(view); adjacentPlans.delete(view);
  const approved = isLiteralTaskConfirmation(text);
  const cancelled = /^(?:取消|算了|不用了|先不保存)[。！？.!?]*$/u.test(text.trim());
  if ((!approved && !cancelled) || !pending || view.agentMessages.at(-1) !== pending.message
    || view.pendingAgentActions.length !== 1 || view.pendingAgentActions[0] !== pending.action
    || recordRevision(pending.action) !== pending.revision) return;
  return {action: pending.action, approved};
}
