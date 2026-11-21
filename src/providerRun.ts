import type { ProviderAttempt, ProviderErrorCode, ProviderIncompleteReason, ProviderRequestOptions, ProviderResponseUsage, ProviderRunResult } from "./types";
import { redactSensitiveText } from "./credentialSecurity";
import { normalizeProviderResponseUsage } from "./voice/realtimeResponseUsage";

export interface ProviderTarget { provider: string; model: string; transport?: ProviderAttempt["transport"] }
export type ProviderTransportObserver = (target: ProviderTarget) => void;
export interface ProviderRequestAttempt<T> extends ProviderTarget {
  transport: ProviderAttempt["transport"];
  /** Host routing identity, never copied into an attempt or request payload. */
  fallback?: boolean;
  execute: (signal?: AbortSignal, observeTransport?: ProviderTransportObserver) => Promise<T>;
}

export interface ProviderRunOptions extends ProviderRequestOptions {
  /** In-memory audit context only. Never copied into a run or an event. */
  sensitiveValues?: readonly string[];
  /** Additive request-private context from loaded settings and observed adapter keys. */
  additionalSensitiveValues?: () => readonly string[];
  /** Bounds preflight and response parsing too, even for an uncooperative adapter. */
  timeoutMs?: number;
  preflight?: (signal?: AbortSignal) => void | Promise<void>;
}

export class ProviderTransportError extends Error {
  constructor(readonly code: ProviderErrorCode, message: string, readonly httpStatus?: number) { super(message); }
}

/** Only created at a transport boundary: no HTTP request reached the service. */
export class ProviderDnsLookupError extends ProviderTransportError {
  constructor() { super("network", "AI 服务域名暂时无法解析。"); }
}

export function normalizeProviderConnectionError(error: unknown): unknown {
  if (!error || typeof error !== "object") return error;
  const value = error as { name?: string; code?: unknown; message?: unknown; cause?: { code?: unknown } };
  if (value.name === "AbortError" || value.name === "TimeoutError") return error;
  const code = value.code ?? value.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN"
    || typeof value.message === "string" && /^net::ERR_NAME_NOT_RESOLVED(?:$|\s)/.test(value.message)) return new ProviderDnsLookupError();
  return error;
}

/** A received answer that cannot be used as a completed text or tool turn.
 * Terminal: changing transport/provider would silently repeat a paid request. */
export class ProviderResponseIncompleteError extends ProviderTransportError {
  constructor(readonly incompleteReason: ProviderIncompleteReason, readonly reportedModel?: string, httpStatus = 200) {
    super("response_incomplete", "AI 回答未完成，本次已停止。", httpStatus);
  }
}

export class ProviderRunFailure extends Error {
  constructor(readonly providerRun: ProviderRunResult, readonly code: ProviderErrorCode, message?: string) {
    super(message ?? (code === "cancelled" ? "AI request aborted" : code === "response_incomplete" ? "AI 回答未完成，本次已停止。"
      : code === "network" ? runNetworkMessage(providerRun) : `AI 请求失败（${code}）。`));
    this.name = code === "cancelled" ? "AbortError" : "ProviderRunError";
  }
}

function runNetworkMessage(run: ProviderRunResult): string {
  return run.attempts.at(-1)?.networkFailure === "dns"
    ? "AI 服务域名暂时无法解析，重连后仍未恢复。请稍后重发，已保存的记录保留。"
    : "AI 暂时未能连接。请稍后重发，已保存的记录保留。";
}

// Identifiers are not free-form provider payloads or URLs. Invalid values are
// represented as unknown instead of copying arbitrary text into quality logs.
export function providerIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(value) && !value.includes("://") ? value : undefined;
}

export function providerAuditIdentifier(value: unknown, credentials: readonly string[] = []): string | undefined {
  return typeof value === "string" ? providerIdentifier(redactSensitiveText(value, [...credentials])) : undefined;
}

export function providerRunStart(target: ProviderTarget, credentials: readonly string[] = []): ProviderRunResult {
  return { requestedProvider: providerAuditIdentifier(target.provider, credentials) ?? "unknown", requestedModel: providerAuditIdentifier(target.model, credentials) ?? "unknown", status: "unavailable", fallbackUsed: false, attempts: [] };
}

export function assertProviderActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("AI request aborted"); error.name = "AbortError"; throw error;
}

/** Stops waiting even when the underlying adapter cannot cancel its I/O. Late
 * values are ignored; callers must also check before each transport starts. */
export async function awaitProviderActive<T>(execute: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  assertProviderActive(signal);
  if (!signal) return execute();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => { const error = new Error("AI request aborted"); error.name = "AbortError"; reject(error); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    assertProviderActive(signal);
    const result = await Promise.race([execute(), cancelled]);
    assertProviderActive(signal);
    return result;
  } finally { signal.removeEventListener("abort", onAbort); }
}

export async function runProviderRequest<T extends { reportedModel?: string; responseUsage?: ProviderResponseUsage }>(
  target: ProviderTarget,
  attempts: ProviderRequestAttempt<T>[],
  options: ProviderRunOptions = {}
): Promise<T & { providerRun: ProviderRunResult }> {
  if (options.timeoutMs === undefined) return executeProviderRequest(target, attempts, options);
  const request = new AbortController();
  const abort = () => request.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => {
    const error = new Error("AI 请求超时"); error.name = "TimeoutError"; request.abort(error);
  }, options.timeoutMs);
  try { return await executeProviderRequest(target, attempts, { ...options, signal: request.signal }); }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}

async function executeProviderRequest<T extends { reportedModel?: string; responseUsage?: ProviderResponseUsage }>(
  target: ProviderTarget,
  attempts: ProviderRequestAttempt<T>[],
  options: ProviderRunOptions
): Promise<T & { providerRun: ProviderRunResult }> {
  const credentials = [...(options.sensitiveValues ?? [])];
  let auditContextFailed = false;
  const collectAdapterCredentials = () => {
    if (!options.additionalSensitiveValues) return;
    try {
      const values = options.additionalSensitiveValues();
      if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw Error("Invalid audit credential context");
      for (const value of values) if (value && !credentials.includes(value)) credentials.push(value);
    } catch { auditContextFailed = true; }
  };
  const auditIdentifier = (value: unknown) => auditContextFailed ? undefined : providerAuditIdentifier(value, credentials);
  const run = providerRunStart(target, credentials);
  let published = false;
  let activeRow: ProviderAttempt | undefined;
  const publish = () => {
    if (published) return;
    collectAdapterCredentials();
    run.requestedProvider = auditIdentifier(run.requestedProvider) ?? "unknown";
    run.requestedModel = auditIdentifier(run.requestedModel) ?? "unknown";
    if (run.actualProvider !== undefined) run.actualProvider = auditIdentifier(run.actualProvider) ?? "unknown";
    if (run.actualModel !== undefined) run.actualModel = auditIdentifier(run.actualModel) ?? "unknown";
    for (const row of run.attempts) {
      row.provider = auditIdentifier(row.provider) ?? "unknown";
      row.model = auditIdentifier(row.model) ?? "unknown";
    }
    published = true;
    try { options.onProviderRun?.(structuredClone(run)); } catch { /* Metrics cannot retry an answer. */ }
  };
  // A synchronous delegation wrapper can settle on the same abort before this
  // request's promise unwinds. Publish cancellation at the signal boundary so
  // its final quality row cannot miss the provider that was interrupted.
  const onAbort = () => {
    const code = providerAbortCode(options.signal);
    run.status = code === "timeout" ? "failed" : "cancelled";
    if (activeRow) { activeRow.status = code === "timeout" ? "failed" : "cancelled"; activeRow.errorCode = code; }
    publish();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let lastCode: ProviderErrorCode = "configuration";
  let configurationMessage: string | undefined;
  try {
    assertProviderActive(options.signal);
    if (options.preflight) await awaitProviderActive(async () => options.preflight!(options.signal), options.signal);
    const candidates = [...attempts];
    let retriedDns = false;
    for (let index = 0; index < candidates.length; index++) {
      const attempt = candidates[index];
      assertProviderActive(options.signal);
      const row: ProviderAttempt = { provider: auditIdentifier(attempt.provider) ?? "unknown", model: auditIdentifier(attempt.model) ?? "unknown", transport: attempt.transport, status: "failed" };
      run.attempts.push(row);
      activeRow = row;
      run.fallbackUsed = run.fallbackUsed || attempt.fallback === true || run.attempts.length > 1;
      const observeTransport: ProviderTransportObserver = target => {
        if (published || activeRow !== row || options.signal?.aborted) return;
        try {
          collectAdapterCredentials();
          const provider = auditIdentifier(target.provider) ?? "unknown";
          const model = auditIdentifier(target.model) ?? "unknown";
          row.provider = provider;
          row.model = model;
          const transport = target.transport;
          if (transport && ["stream", "request_url", "node_https", "fetch", "websocket"].includes(transport)) row.transport = transport;
        } catch {
          // Diagnostic metadata cannot prevent I/O or retry the business request.
          row.provider = "unknown";
          row.model = "unknown";
        }
      };
      try {
        const result = await awaitProviderActive(() => attempt.execute(options.signal, observeTransport), options.signal);
        collectAdapterCredentials();
        row.status = "success";
        run.status = "success";
        run.actualProvider = row.provider;
        const reported = auditIdentifier(result.reportedModel);
        run.actualModel = reported ?? row.model;
        run.modelIdentitySource = reported ? "response" : "configured";
        if (result.responseUsage !== undefined) run.responseUsage = normalizeProviderResponseUsage(result.responseUsage);
        activeRow = undefined;
        publish();
        return { ...result, reportedModel: auditIdentifier(result.reportedModel), providerRun: run };
      } catch (error) {
        const interrupted = options.signal?.aborted || (error instanceof Error && error.name === "AbortError");
        lastCode = interrupted ? providerAbortCode(options.signal) : providerErrorCode(error);
        row.errorCode = lastCode;
        if (error instanceof ProviderDnsLookupError) row.networkFailure = "dns";
        if (error instanceof ProviderTransportError && error.httpStatus !== undefined) row.httpStatus = error.httpStatus;
        row.status = lastCode === "cancelled" ? "cancelled" : "failed";
        if (error instanceof ProviderResponseIncompleteError) {
          row.incompleteReason = error.incompleteReason;
          run.actualProvider = row.provider;
          const reported = auditIdentifier(error.reportedModel);
          run.actualModel = reported ?? row.model;
          run.modelIdentitySource = reported ? "response" : "configured";
        }
        if (lastCode === "configuration") configurationMessage = error instanceof ProviderTransportError ? error.message : "请先确认 API Key 在本机 data.json 中的存储设置。";
        if (interrupted) throw error;
        if (lastCode === "response_incomplete") throw error;
        activeRow = undefined;
        if (error instanceof ProviderDnsLookupError && !retriedDns && index === candidates.length - 1) {
          // All configured routes have failed. Retry only the last proven pre-send
          // DNS failure once, never an ambiguous disconnect or a partial answer.
          retriedDns = true;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await awaitProviderActive(() => new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); }), options.signal); }
          finally { clearTimeout(timer); }
          candidates.push(attempt);
        }
      }
    }
    run.status = "failed";
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) { lastCode = providerAbortCode(options.signal); run.status = lastCode === "timeout" ? "failed" : "cancelled"; }
    else {
      lastCode = providerErrorCode(error); run.status = "failed";
      if (error instanceof ProviderTransportError && lastCode === "configuration") configurationMessage = error.message;
    }
  } finally { options.signal?.removeEventListener("abort", onAbort); }
  publish();
  throw new ProviderRunFailure(run, lastCode, !auditContextFailed && lastCode === "configuration" && configurationMessage ? redactSensitiveText(configurationMessage, credentials) : undefined);
}

export function providerAbortCode(signal?: AbortSignal): "timeout" | "cancelled" {
  return signal?.reason instanceof Error && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled";
}

function providerErrorCode(error: unknown): ProviderErrorCode {
  if (error instanceof ProviderTransportError) return error.code;
  if (error instanceof Error && /请求超时/.test(error.message)) return "timeout";
  if (error instanceof Error && /data\.json/.test(error.message)) return "configuration";
  return "network";
}
