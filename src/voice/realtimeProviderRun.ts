import { randomUUID } from "node:crypto";
import { providerAuditIdentifier, providerRunStart } from "../providerRun";
import type { ProviderAttempt, ProviderErrorCode, ProviderRunResult, ProviderStage, ProviderTransport } from "../types";
import { readRealtimeResponseUsage } from "./realtimeResponseUsage";

export type RealtimeProviderStage = Extract<ProviderStage, "voice_connection" | "voice_asr" | "voice_response" | "tts">;
export interface RealtimeProviderContext {
  sessionId: string;
  generation: number;
  turnId?: string;
}
export interface RealtimeProviderRunEvent {
  traceId: string;
  stage: RealtimeProviderStage;
  context?: RealtimeProviderContext;
  errorCode?: ProviderErrorCode;
  /** Only used in memory to match response ownership; never copy into logs. */
  responseId?: string;
  run: ProviderRunResult;
}

/** Metadata only. One instance is one connection, ASR item, response, or TTS
 * request, never an entire playback turn. It cannot retry or execute a request. */
export class RealtimeProviderRun {
  readonly traceId = randomUUID();
  readonly run: ProviderRunResult;
  private published = false;
  private activeAttempt: ProviderAttempt | undefined;
  private reportedModel: string | undefined;
  private readonly auditIdentifier: (value: unknown) => string | undefined;
  responseId = "";

  constructor(
    readonly stage: RealtimeProviderStage,
    model: string,
    private readonly publish: ((event: RealtimeProviderRunEvent) => void) | undefined,
    private readonly context?: RealtimeProviderContext,
    credentials: readonly string[] = [],
    private readonly binding: { provider: string; transport: ProviderTransport } = { provider: "bailian-realtime", transport: "websocket" }
  ) {
    const snapshot = [...credentials];
    this.auditIdentifier = value => providerAuditIdentifier(value, snapshot);
    this.run = providerRunStart({ provider: binding.provider, model }, snapshot);
    if (stage === "voice_response") this.run.responseUsage = { status: "missing" };
  }

  get settled(): boolean { return this.published; }

  beginAttempt(): void {
    if (this.published || this.activeAttempt || this.run.attempts.length >= 6) return;
    this.activeAttempt = { provider: this.run.requestedProvider, model: this.run.requestedModel, transport: this.binding.transport, status: "failed" };
    this.run.attempts.push(this.activeAttempt);
    this.run.fallbackUsed = this.run.attempts.length > 1;
  }

  observeModel(value: unknown): void {
    if (!this.published) this.reportedModel = this.auditIdentifier(value) ?? this.reportedModel;
  }

  observeResponseUsage(value: unknown): void {
    if (!this.published && this.stage === "voice_response") this.run.responseUsage = readRealtimeResponseUsage(value);
  }

  failAttempt(code: ProviderErrorCode, httpStatus?: number): void {
    if (this.published || !this.activeAttempt) return;
    this.activeAttempt.status = code === "cancelled" ? "cancelled" : "failed";
    this.activeAttempt.errorCode = code;
    if (httpStatus !== undefined) this.activeAttempt.httpStatus = httpStatus;
    this.activeAttempt = undefined;
  }

  finish(status: "success" | "failed" | "cancelled", code?: ProviderErrorCode, reportedModel?: unknown, httpStatus?: number): void {
    if (this.published) return;
    this.observeModel(reportedModel);
    if (status === "success") {
      if (this.activeAttempt) this.activeAttempt.status = "success";
      this.run.actualProvider = this.run.requestedProvider;
      this.run.actualModel = this.reportedModel ?? this.run.requestedModel;
      this.run.modelIdentitySource = this.reportedModel ? "response" : "configured";
    } else this.failAttempt(code ?? (status === "cancelled" ? "cancelled" : "network"), httpStatus);
    this.run.status = status;
    this.published = true;
    try {
      this.publish?.({ traceId: this.traceId, stage: this.stage,
        ...(status === "success" ? {} : { errorCode: code ?? (status === "cancelled" ? "cancelled" : "network") }),
        ...(this.context ? { context: { ...this.context } } : {}),
        ...(this.responseId ? { responseId: this.responseId } : {}), run: structuredClone(this.run) });
    } catch { /* Metrics cannot affect audio, retry, or tool execution. */ }
  }
}

export function realtimeProviderError(value: unknown): { code: ProviderErrorCode; httpStatus?: number } {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : String(object.message ?? "");
  const supplied = Number(object.status ?? object.statusCode ?? object.status_code ?? object.code);
  const matched = /\b(401|403|429)\b/.exec(message);
  const httpStatus = Number.isInteger(supplied) && supplied >= 400 && supplied <= 599 ? supplied : matched ? Number(matched[1]) : undefined;
  const kind = `${String(object.code ?? "")} ${message}`;
  if (httpStatus === 401 || httpStatus === 403 || /unauthori[sz]ed|invalid.?api.?key|authentication|permission.?denied/i.test(kind)) return { code: "auth", ...(httpStatus ? { httpStatus } : {}) };
  if (httpStatus === 429 || /rate.?limit|too.?many.?requests/i.test(kind)) return { code: "rate_limit", ...(httpStatus ? { httpStatus } : {}) };
  if (/timeout|timed.?out|超时/i.test(kind)) return { code: "timeout" };
  if (/invalid.?request|invalid.?config|unsupported.?model|invalid.?parameter/i.test(kind)) return { code: "configuration", ...(httpStatus ? { httpStatus } : {}) };
  return { code: httpStatus ? "http" : "network", ...(httpStatus ? { httpStatus } : {}) };
}

export function realtimeReportedModel(event: Record<string, unknown>): unknown {
  const response = event.response as Record<string, unknown> | undefined;
  const session = event.session as Record<string, unknown> | undefined;
  return response?.model ?? session?.model ?? event.model;
}
