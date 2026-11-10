import type { ProviderErrorCode, ProviderRunResult, ProviderStage, ProviderTransport, QualityLogEntry } from "./types";
import { providerIdentifier } from "./providerRun";
import { normalizeRequestAudit } from "./requestAudit";
import { normalizeProviderResponseUsage } from "./voice/realtimeResponseUsage";

export interface SerializedQualityLogEntry {
  loggedAt: string;
  providerTraceId?: string;
  providerStage?: ProviderStage;
  inputSource: "text" | "voice" | "gateway" | "unknown";
  asrFirstMs?: number;
  asrDoneMs?: number;
  modelFirstMs?: number;
  modelDoneMs?: number;
  ttsFirstMs?: number;
  captureMode?: string;
  retrievalHits?: number;
  actionSuggestions?: number;
  userAcceptedActions?: number;
  rejectedActions?: number;
  agentRoute?: "local_direct" | "realtime_voice" | "conversation" | "deep_reasoning" | "action";
  agentRunMs?: number;
  contextSources?: string[];
  contextFailures?: string[];
  delegationStatus?: "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
  fallbackUsed?: boolean;
  localFallbackUsed?: boolean;
  providerRuns?: ProviderRunResult[];
  requestAudits?: import("./types").ProviderRequestAudit[];
  requestAuditDropped?: number;
  contextChars?: number;
  toolCalls?: { name: string; ok: boolean }[];
  errorCode?: string;
  errorMessage?: string;
}

export function serializeQualityLogEntry(entry: QualityLogEntry, loggedAt = new Date().toISOString()): string {
  return JSON.stringify(normalizeQualityLogEntry(entry, loggedAt));
}

export function normalizeQualityLogEntry(entry: QualityLogEntry, loggedAt = new Date().toISOString()): SerializedQualityLogEntry {
  const normalized: SerializedQualityLogEntry = {
    loggedAt,
    inputSource: entry.inputSource ?? "unknown"
  };
  if (typeof entry.providerTraceId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(entry.providerTraceId)) normalized.providerTraceId = entry.providerTraceId;
  const stages: ProviderStage[] = ["classification", "daily_review", "trading_review", "transcription", "vision", "screen", "embedding", "voice_connection", "voice_asr", "voice_response", "tts", "system_speech"];
  if (entry.providerStage && stages.includes(entry.providerStage)) normalized.providerStage = entry.providerStage;

  assignNumber(normalized, "asrFirstMs", entry.asrFirstMs);
  assignNumber(normalized, "asrDoneMs", entry.asrDoneMs);
  assignNumber(normalized, "modelFirstMs", entry.modelFirstMs);
  assignNumber(normalized, "modelDoneMs", entry.modelDoneMs);
  assignNumber(normalized, "ttsFirstMs", entry.ttsFirstMs);
  assignNumber(normalized, "retrievalHits", entry.retrievalHits);
  assignNumber(normalized, "actionSuggestions", entry.actionSuggestions);
  assignNumber(normalized, "userAcceptedActions", entry.userAcceptedActions);
  assignNumber(normalized, "rejectedActions", entry.rejectedActions);
  assignNumber(normalized, "agentRunMs", entry.agentRunMs);
  assignNumber(normalized, "contextChars", entry.contextChars);
  if (Array.isArray(entry.toolCalls)) normalized.toolCalls = entry.toolCalls.slice(0, 100).flatMap(call =>
    typeof call?.name === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,80}$/.test(call.name)
      ? [{ name: call.name, ok: call.ok === true }] : []);

  if (entry.captureMode?.trim()) normalized.captureMode = entry.captureMode.trim();
  if (entry.agentRoute) normalized.agentRoute = entry.agentRoute;
  if (entry.delegationStatus) normalized.delegationStatus = entry.delegationStatus;
  if (typeof entry.fallbackUsed === "boolean") normalized.fallbackUsed = entry.fallbackUsed;
  if (typeof entry.localFallbackUsed === "boolean") normalized.localFallbackUsed = entry.localFallbackUsed;
  if (entry.providerRuns?.length) normalized.providerRuns = entry.providerRuns.slice(0, 16).map(normalizeProviderRun);
  if (Array.isArray(entry.requestAudits) && entry.requestAudits.length) {
    const audits = entry.requestAudits.slice(0, 16).map(normalizeRequestAudit).filter((item): item is NonNullable<typeof item> => !!item);
    normalized.requestAudits = audits;
    const dropped = Number.isSafeInteger(entry.requestAuditDropped) && entry.requestAuditDropped! >= 0 ? entry.requestAuditDropped! : 0;
    normalized.requestAuditDropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + entry.requestAudits.length - audits.length);
  }
  const contextSources = normalizeStringList(entry.contextSources, 20, 240);
  if (contextSources.length > 0) normalized.contextSources = contextSources;
  const contextFailures = normalizeStringList(entry.contextFailures, 12, 80);
  if (contextFailures.length > 0) normalized.contextFailures = contextFailures;
  if (entry.errorCode?.trim()) normalized.errorCode = entry.errorCode.trim();
  if (entry.errorMessage?.trim()) normalized.errorMessage = entry.errorMessage.trim().slice(0, 300);

  return normalized;
}

function normalizeProviderRun(run: ProviderRunResult): ProviderRunResult {
  const errorCodes: ProviderErrorCode[] = ["timeout", "auth", "rate_limit", "cancelled", "network", "http", "invalid_response", "configuration", "response_incomplete"];
  return {
    requestedProvider: providerIdentifier(run.requestedProvider) ?? "unknown",
    requestedModel: providerIdentifier(run.requestedModel) ?? "unknown",
    ...(providerIdentifier(run.actualProvider) ? { actualProvider: run.actualProvider } : {}),
    ...(providerIdentifier(run.actualModel) ? { actualModel: run.actualModel } : {}),
    ...(["response", "configured"].includes(run.modelIdentitySource ?? "") ? { modelIdentitySource: run.modelIdentitySource } : {}),
    status: ["success", "failed", "cancelled", "unavailable"].includes(run.status) ? run.status : "failed",
    fallbackUsed: run.fallbackUsed === true,
    ...(run.responseUsage === undefined ? {} : { responseUsage: normalizeProviderResponseUsage(run.responseUsage) }),
    attempts: (Array.isArray(run.attempts) ? run.attempts : []).slice(0, 8).map(attempt => ({
      provider: providerIdentifier(attempt.provider) ?? "unknown",
      model: providerIdentifier(attempt.model) ?? "unknown",
      transport: (["stream", "request_url", "fetch", "websocket"] as ProviderTransport[]).includes(attempt.transport) ? attempt.transport : "unknown",
      status: ["success", "failed", "cancelled"].includes(attempt.status) ? attempt.status : "failed",
      ...(attempt.errorCode && errorCodes.includes(attempt.errorCode) ? { errorCode: attempt.errorCode } : {}),
      ...(["length", "content_filter", "unknown", "missing"].includes(attempt.incompleteReason ?? "") ? { incompleteReason: attempt.incompleteReason } : {}),
      ...(typeof attempt.httpStatus === "number" && Number.isInteger(attempt.httpStatus) && attempt.httpStatus >= 100 && attempt.httpStatus <= 599 ? { httpStatus: attempt.httpStatus } : {})
    }))
  };
}

function assignNumber<T extends keyof SerializedQualityLogEntry>(
  target: SerializedQualityLogEntry,
  key: T,
  value: QualityLogEntry[T & keyof QualityLogEntry]
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  target[key] = Math.max(0, Math.round(value)) as SerializedQualityLogEntry[T];
}

function normalizeStringList(values: string[] | undefined, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(
    values
      .map((value) => typeof value === "string" ? value.trim().slice(0, maxLength) : "")
      .filter(Boolean)
  )].slice(0, maxItems);
}
