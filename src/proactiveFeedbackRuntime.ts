import {
  proactiveFeedbackEffect,
  recordProactiveFeedback,
  type ProactiveFeedbackAuditRecord,
  type ProactiveFeedbackDecision,
  type ProactiveFeedbackEffect,
  type ProactivePolicyState
} from "./proactivePolicy";
import type { ProactiveCandidate } from "./scheduler";
import type { LifeOpsWorkflowId } from "./workflows";

export interface ProactiveFeedbackRuntimeDependencies {
  writePolicyState(state: ProactivePolicyState): Promise<void>;
  createWorkflowDraft(workflowId: LifeOpsWorkflowId, candidate: ProactiveCandidate): Promise<string>;
  appendAudit(record: ProactiveFeedbackAuditRecord): Promise<void>;
}

export interface ProactiveFeedbackRuntimeResult {
  state: ProactivePolicyState;
  effect: ProactiveFeedbackEffect;
  workflowPath?: string;
}

export async function executeProactiveFeedback(
  candidates: ProactiveCandidate[],
  state: ProactivePolicyState,
  candidateId: string,
  decision: ProactiveFeedbackDecision,
  dependencies: ProactiveFeedbackRuntimeDependencies,
  now = new Date()
): Promise<ProactiveFeedbackRuntimeResult> {
  const candidate = candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`找不到主动候选：${candidateId}`);
  if (decision === "accepted" && state.feedback.some(item => item.candidateId === candidateId && item.decision === "accepted")) {
    return { state, effect: { kind: "acknowledged" } };
  }

  const updated = recordProactiveFeedback(state, candidate, decision, now);
  await dependencies.writePolicyState(updated);
  const effect = proactiveFeedbackEffect(candidate, decision);
  let workflowPath: string | undefined;
  let effectError: Error | undefined;

  try {
    if (effect.kind === "workflow_draft") {
      workflowPath = await dependencies.createWorkflowDraft(effect.workflowId, candidate);
    }
  } catch (error) {
    effectError = error instanceof Error ? error : new Error(String(error));
  }

  await dependencies.appendAudit({
    candidateId,
    candidateKind: candidate.kind,
    decision,
    recordedAt: now.toISOString(),
    effect: effect.kind,
    outcome: effectError ? "failed" : "completed",
    workflowId: effect.kind === "workflow_draft" ? effect.workflowId : undefined,
    workflowPath,
    error: effectError?.message
  });

  if (effectError) throw effectError;
  return { state: updated, effect, workflowPath };
}
