import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROACTIVE_RUNTIME_SETTINGS,
  decideProactiveDelivery,
  emptyProactivePolicyState,
  proactiveFeedbackEffect,
  recordProactiveDelivery,
  recordProactiveFeedback,
  resolveAvailableProactiveChannel,
  serializeProactiveFeedbackAudit,
  visibleProactiveCandidates
} from "../src/proactivePolicy";
import type { ProactiveCandidate } from "../src/scheduler";

function candidate(overrides: Partial<ProactiveCandidate> = {}): ProactiveCandidate {
  return {
    id: "candidate-1",
    kind: "task_overdue",
    title: "处理过期任务",
    reason: "有一项任务已过期",
    priority: "normal",
    createdAt: "2026-07-28T02:00:00.000Z",
    expiresAt: "2026-07-29T02:00:00.000Z",
    dedupeKey: "task_overdue:2026-07-28",
    evidenceRefs: ["task-dashboard:overdue"],
    confidence: 0.72,
    voiceEligible: false,
    ...overrides
  };
}

const enabled = {
  ...DEFAULT_PROACTIVE_RUNTIME_SETTINGS,
  enabled: true,
  quietHoursStart: 0,
  quietHoursEnd: 0,
  minMinutesBetweenCandidates: 0
};

describe("proactive policy", () => {
  it("is enabled by default and uses the panel at level two", () => {
    const item = candidate();
    expect(DEFAULT_PROACTIVE_RUNTIME_SETTINGS.enabled).toBe(true);
    expect(decideProactiveDelivery(item, emptyProactivePolicyState(), { ...enabled, enabled: false }, new Date("2026-07-28T03:00:00.000Z")).deliver).toBe(false);
    expect(decideProactiveDelivery(item, emptyProactivePolicyState(), enabled, new Date("2026-07-28T03:00:00.000Z"))).toMatchObject({
      deliver: true,
      channel: "panel"
    });
  });

  it("deduplicates deliveries and enforces cooldown and daily limit", () => {
    const now = new Date("2026-07-28T03:00:00.000Z");
    const first = candidate();
    const delivered = recordProactiveDelivery(emptyProactivePolicyState(), first, "panel", now);
    expect(decideProactiveDelivery(first, delivered, enabled, now).reason).toBe("duplicate");

    const other = candidate({ id: "candidate-2", kind: "habit_risk", dedupeKey: "habit_risk:2026-07-28" });
    expect(decideProactiveDelivery(other, delivered, {
      ...enabled,
      minMinutesBetweenCandidates: 90
    }, new Date(now.getTime() + 30 * 60_000)).reason).toBe("cooldown");
    expect(decideProactiveDelivery(other, delivered, {
      ...enabled,
      dailyLimit: 1
    }, new Date(now.getTime() + 2 * 60 * 60_000)).reason).toBe("daily_limit");
  });

  it("keeps ordinary reminders quiet and reserves voice for explicit critical cases", () => {
    const now = new Date(2026, 6, 28, 23, 30);
    const normal = candidate();
    expect(decideProactiveDelivery(normal, emptyProactivePolicyState(), {
      ...enabled,
      quietHoursStart: 23,
      quietHoursEnd: 7
    }, now).reason).toBe("quiet_hours");

    const critical = candidate({ priority: "critical", voiceEligible: true });
    expect(decideProactiveDelivery(critical, emptyProactivePolicyState(), {
      ...enabled,
      level: 4,
      highPriorityVoiceEnabled: true,
      quietHoursStart: 23,
      quietHoursEnd: 7
    }, now).channel).toBe("voice");
  });

  it("uses feedback to snooze, dismiss, or mute a reminder kind", () => {
    const now = new Date("2026-07-28T03:00:00.000Z");
    const item = candidate();
    const snoozed = recordProactiveFeedback(emptyProactivePolicyState(), item, "snoozed", now);
    expect(decideProactiveDelivery(item, snoozed, enabled, new Date(now.getTime() + 30 * 60_000)).reason).toBe("candidate_snoozed");
    expect(visibleProactiveCandidates([item], snoozed, new Date(now.getTime() + 30 * 60_000))).toHaveLength(0);

    const muted = recordProactiveFeedback(emptyProactivePolicyState(), item, "never", now);
    expect(muted.mutedKinds).toContain("task_overdue");
    expect(visibleProactiveCandidates([item], muted, now)).toHaveLength(0);
  });

  it("records only a channel the current runtime can actually deliver", () => {
    expect(resolveAvailableProactiveChannel("voice", {
      voiceAvailable: false,
      notificationAvailable: true
    })).toBe("notification");
    expect(resolveAvailableProactiveChannel("voice", {
      voiceAvailable: false,
      notificationAvailable: false
    })).toBe("panel");
    expect(resolveAvailableProactiveChannel("notification", {
      voiceAvailable: false,
      notificationAvailable: false
    })).toBe("panel");
  });

  it("turns an accepted workflow candidate into a deterministic local draft effect", () => {
    expect(proactiveFeedbackEffect(candidate({ workflowId: "weekly_review" }), "accepted")).toEqual({
      kind: "workflow_draft",
      workflowId: "weekly_review"
    });
    expect(proactiveFeedbackEffect(candidate({ workflowId: "weekly_review" }), "dismissed")).toEqual({
      kind: "acknowledged"
    });
    expect(proactiveFeedbackEffect(candidate(), "accepted")).toEqual({ kind: "acknowledged" });
  });

  it("serializes one append-only audit record per feedback response", () => {
    const serialized = serializeProactiveFeedbackAudit({
      candidateId: "candidate-1",
      candidateKind: "task_overdue",
      decision: "accepted",
      recordedAt: "2026-07-28T03:00:00.000Z",
      effect: "acknowledged",
      outcome: "completed"
    });
    expect(serialized.endsWith("\n")).toBe(true);
    expect(JSON.parse(serialized)).toMatchObject({
      candidateId: "candidate-1",
      decision: "accepted",
      outcome: "completed"
    });
  });
});
