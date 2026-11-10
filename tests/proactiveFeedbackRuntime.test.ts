import { describe, expect, it, vi } from "vitest";
import { executeProactiveFeedback } from "../src/proactiveFeedbackRuntime";
import { emptyProactivePolicyState } from "../src/proactivePolicy";
import type { ProactiveCandidate } from "../src/scheduler";

function candidate(overrides: Partial<ProactiveCandidate> = {}): ProactiveCandidate {
  return {
    id: "weekly-1",
    kind: "weekly_review",
    title: "周复盘",
    reason: "该收束本周了",
    priority: "high",
    workflowId: "weekly_review",
    createdAt: "2026-08-23T10:00:00.000Z",
    expiresAt: "2026-08-24T10:00:00.000Z",
    dedupeKey: "weekly_review:2026-08-23",
    evidenceRefs: [],
    confidence: 0.8,
    voiceEligible: false,
    ...overrides
  };
}

function dependencies() {
  return {
    writePolicyState: vi.fn(async () => undefined),
    createWorkflowDraft: vi.fn(async () => "AI 报告/Workflows/weekly.md"),
    appendAudit: vi.fn(async () => undefined)
  };
}

describe("proactive feedback runtime", () => {
  it("persists acceptance, creates a local workflow draft, and audits completion", async () => {
    const deps = dependencies();
    const result = await executeProactiveFeedback(
      [candidate()],
      emptyProactivePolicyState(),
      "weekly-1",
      "accepted",
      deps,
      new Date("2026-08-23T10:05:00.000Z")
    );

    expect(deps.writePolicyState).toHaveBeenCalledOnce();
    expect(deps.createWorkflowDraft).toHaveBeenCalledWith("weekly_review", expect.objectContaining({ id: "weekly-1" }));
    expect(deps.appendAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "completed",
      effect: "workflow_draft",
      workflowPath: "AI 报告/Workflows/weekly.md"
    }));
    expect(result.workflowPath).toBe("AI 报告/Workflows/weekly.md");
  });

  it("audits workflow failures before returning the same error", async () => {
    const deps = dependencies();
    deps.createWorkflowDraft.mockRejectedValueOnce(new Error("draft failed"));

    await expect(executeProactiveFeedback(
      [candidate()],
      emptyProactivePolicyState(),
      "weekly-1",
      "accepted",
      deps
    )).rejects.toThrow("draft failed");
    expect(deps.appendAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      error: "draft failed"
    }));
  });

  it("records dismissals without creating a workflow draft", async () => {
    const deps = dependencies();
    const result = await executeProactiveFeedback(
      [candidate()],
      emptyProactivePolicyState(),
      "weekly-1",
      "dismissed",
      deps
    );

    expect(deps.createWorkflowDraft).not.toHaveBeenCalled();
    expect(deps.appendAudit).toHaveBeenCalledWith(expect.objectContaining({ effect: "acknowledged" }));
    expect(result.effect).toEqual({ kind: "acknowledged" });
  });

  it("rejects stale candidate ids without mutating policy or audit state", async () => {
    const deps = dependencies();
    await expect(executeProactiveFeedback(
      [candidate()],
      emptyProactivePolicyState(),
      "missing",
      "accepted",
      deps
    )).rejects.toThrow("找不到主动候选：missing");
    expect(deps.writePolicyState).not.toHaveBeenCalled();
    expect(deps.appendAudit).not.toHaveBeenCalled();
  });
});
