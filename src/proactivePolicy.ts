import type { ProactiveCandidate, ProactiveCandidateKind } from "./scheduler";
import type { LifeOpsWorkflowId } from "./workflows";

export type ProactiveChannel = "panel" | "notification" | "voice";
export type ProactiveFeedbackDecision = "accepted" | "snoozed" | "dismissed" | "never";
export type ProactiveTone = "gentle" | "direct" | "strict";

export interface ProactiveRuntimeSettings {
  enabled: boolean;
  level: 0 | 1 | 2 | 3 | 4;
  quietHoursStart: number;
  quietHoursEnd: number;
  minMinutesBetweenCandidates: number;
  dailyLimit: number;
  systemNotificationsEnabled: boolean;
  highPriorityVoiceEnabled: boolean;
  tone?: ProactiveTone;
}

export interface ProactiveDelivery {
  candidateId: string;
  dedupeKey: string;
  kind: ProactiveCandidateKind;
  channel: ProactiveChannel;
  deliveredAt: string;
}

export interface ProactiveFeedback {
  candidateId: string;
  kind: ProactiveCandidateKind;
  decision: ProactiveFeedbackDecision;
  createdAt: string;
  snoozedUntil?: string;
}

export type ProactiveFeedbackEffect =
  | { kind: "workflow_draft"; workflowId: LifeOpsWorkflowId }
  | { kind: "acknowledged" };

export interface ProactiveFeedbackAuditRecord {
  candidateId: string;
  candidateKind: ProactiveCandidateKind;
  decision: ProactiveFeedbackDecision;
  recordedAt: string;
  effect: ProactiveFeedbackEffect["kind"];
  outcome: "completed" | "failed";
  workflowId?: LifeOpsWorkflowId;
  workflowPath?: string;
  error?: string;
}

export interface ProactivePolicyState {
  version: 1;
  deliveries: ProactiveDelivery[];
  feedback: ProactiveFeedback[];
  mutedKinds: ProactiveCandidateKind[];
}

export interface ProactivePolicyDecision {
  deliver: boolean;
  channel: ProactiveChannel;
  reason: string;
}

export interface ProactiveChannelCapabilities {
  notificationAvailable: boolean;
  voiceAvailable: boolean;
}

export const DEFAULT_PROACTIVE_RUNTIME_SETTINGS: ProactiveRuntimeSettings = {
  enabled: true,
  level: 2,
  quietHoursStart: 23,
  quietHoursEnd: 7,
  minMinutesBetweenCandidates: 90,
  dailyLimit: 6,
  systemNotificationsEnabled: false,
  highPriorityVoiceEnabled: false,
  tone: "direct"
};

export function emptyProactivePolicyState(): ProactivePolicyState {
  return { version: 1, deliveries: [], feedback: [], mutedKinds: [] };
}

export function decideProactiveDelivery(
  candidate: ProactiveCandidate,
  state: ProactivePolicyState,
  settings: ProactiveRuntimeSettings,
  now = new Date()
): ProactivePolicyDecision {
  if (!settings.enabled || settings.level < 2) {
    return { deliver: false, channel: "panel", reason: "proactive_disabled" };
  }
  if (state.mutedKinds.includes(candidate.kind)) {
    return { deliver: false, channel: "panel", reason: "kind_muted" };
  }
  const expiresAt = candidate.expiresAt ? Date.parse(candidate.expiresAt) : Number.POSITIVE_INFINITY;
  if (expiresAt <= now.getTime()) {
    return { deliver: false, channel: "panel", reason: "candidate_expired" };
  }
  const snoozed = [...state.feedback].reverse().find((item) => (
    item.kind === candidate.kind
      && item.decision === "snoozed"
      && item.snoozedUntil
      && Date.parse(item.snoozedUntil) > now.getTime()
  ));
  if (snoozed) return { deliver: false, channel: "panel", reason: "candidate_snoozed" };
  const dedupeKey = candidate.dedupeKey ?? `${candidate.kind}:${candidate.createdAt.slice(0, 10)}`;
  if (state.deliveries.some((item) => item.dedupeKey === dedupeKey)) {
    return { deliver: false, channel: "panel", reason: "duplicate" };
  }
  const today = localDateKey(now);
  const deliveredToday = state.deliveries.filter((item) => localDateKey(new Date(item.deliveredAt)) === today);
  if (deliveredToday.length >= (candidate.steward ? Math.min(6, settings.dailyLimit) : settings.dailyLimit)) {
    return { deliver: false, channel: "panel", reason: "daily_limit" };
  }
  if (candidate.steward ? inQuietHours(now, 23, 7)
    : inQuietHours(now, settings.quietHoursStart, settings.quietHoursEnd) && candidate.priority !== "critical") {
    return { deliver: false, channel: "panel", reason: "quiet_hours" };
  }
  const latest = candidate.steward ? state.deliveries.filter(item => item.kind === candidate.kind).at(-1) : state.deliveries.at(-1);
  const interval = candidate.steward ? Math.max(90, settings.minMinutesBetweenCandidates) : settings.minMinutesBetweenCandidates;
  if (latest && now.getTime() - Date.parse(latest.deliveredAt) < interval * 60_000) {
    return { deliver: false, channel: "panel", reason: "cooldown" };
  }
  if (candidate.steward) return { deliver: true, channel: "panel", reason: "steward_reminder" };

  if (
    candidate.priority === "critical"
      && settings.level >= 4
      && settings.highPriorityVoiceEnabled
      && candidate.voiceEligible
  ) {
    return { deliver: true, channel: "voice", reason: "explicit_high_priority_voice" };
  }
  if (
    (candidate.priority === "high" || candidate.priority === "critical")
      && settings.level >= 3
      && settings.systemNotificationsEnabled
  ) {
    return { deliver: true, channel: "notification", reason: "important_notification" };
  }
  return { deliver: true, channel: "panel", reason: "panel_candidate" };
}

export function recordProactiveDelivery(
  state: ProactivePolicyState,
  candidate: ProactiveCandidate,
  channel: ProactiveChannel,
  now = new Date()
): ProactivePolicyState {
  const delivery: ProactiveDelivery = {
    candidateId: candidate.id,
    dedupeKey: candidate.dedupeKey ?? `${candidate.kind}:${candidate.createdAt.slice(0, 10)}`,
    kind: candidate.kind,
    channel,
    deliveredAt: now.toISOString()
  };
  return {
    ...state,
    deliveries: [...state.deliveries, delivery].slice(-500)
  };
}

export function resolveAvailableProactiveChannel(
  requested: ProactiveChannel,
  capabilities: ProactiveChannelCapabilities
): ProactiveChannel {
  if (requested === "voice") {
    if (capabilities.voiceAvailable) return "voice";
    return capabilities.notificationAvailable ? "notification" : "panel";
  }
  if (requested === "notification" && !capabilities.notificationAvailable) return "panel";
  return requested;
}

export function recordProactiveFeedback(
  state: ProactivePolicyState,
  candidate: ProactiveCandidate,
  decision: ProactiveFeedbackDecision,
  now = new Date()
): ProactivePolicyState {
  const feedback: ProactiveFeedback = {
    candidateId: candidate.id,
    kind: candidate.kind,
    decision,
    createdAt: now.toISOString(),
    snoozedUntil: decision === "snoozed"
      ? new Date(now.getTime() + 60 * 60_000).toISOString()
      : undefined
  };
  return {
    ...state,
    feedback: [...state.feedback, feedback].slice(-500),
    mutedKinds: decision === "never"
      ? Array.from(new Set([...state.mutedKinds, candidate.kind]))
      : state.mutedKinds
  };
}

export function proactiveFeedbackEffect(
  candidate: ProactiveCandidate,
  decision: ProactiveFeedbackDecision
): ProactiveFeedbackEffect {
  if (decision === "accepted" && candidate.workflowId) {
    return { kind: "workflow_draft", workflowId: candidate.workflowId };
  }
  return { kind: "acknowledged" };
}

export function serializeProactiveFeedbackAudit(record: ProactiveFeedbackAuditRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function visibleProactiveCandidates(
  candidates: ProactiveCandidate[],
  state: ProactivePolicyState,
  now = new Date()
): ProactiveCandidate[] {
  const hiddenIds = new Set(state.feedback
    .filter((item) => (
      item.decision === "dismissed"
        || item.decision === "accepted"
        || item.decision === "never"
        || item.decision === "snoozed" && Boolean(item.snoozedUntil && Date.parse(item.snoozedUntil) > now.getTime())
    ))
    .map((item) => item.candidateId));
  return candidates.filter((candidate) => (
    !hiddenIds.has(candidate.id)
      && !state.mutedKinds.includes(candidate.kind)
      && (!candidate.expiresAt || Date.parse(candidate.expiresAt) > now.getTime())
  ));
}

function inQuietHours(now: Date, startHour: number, endHour: number): boolean {
  const hour = now.getHours();
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
