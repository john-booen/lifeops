import { providerAuditIdentifier, providerIdentifier } from "./providerRun";
import { utf8RequestBytes } from "./privacy";
import type { ProviderRequestAudit, ProviderRequestOptions } from "./types";

const counts = ["requestBytes", "messageCount", "messageChars", "toolSchemaChars"] as const;
const countIsValid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Rebuild only metadata. Unknown fields, endpoints and payloads cannot pass. */
export function normalizeRequestAudit(value: unknown): ProviderRequestAudit | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  if (item.stage !== "prepared" || (item.transport !== "request_url" && item.transport !== "stream")
    || counts.some(key => !countIsValid(item[key]))) return;
  const event: ProviderRequestAudit = {
    stage: "prepared", requestedProvider: providerIdentifier(item.requestedProvider) ?? "unknown",
    requestedModel: providerIdentifier(item.requestedModel) ?? "unknown", transport: item.transport as ProviderRequestAudit["transport"],
    requestBytes: item.requestBytes as number, messageCount: item.messageCount as number,
    messageChars: item.messageChars as number, toolSchemaChars: item.toolSchemaChars as number
  };
  if (countIsValid(item.maxOutputTokens) && item.maxOutputTokens > 0) event.maxOutputTokens = item.maxOutputTokens;
  return event;
}

/** Synchronous, observational only; an observer cannot stall or retry a request. */
export function notifyRequestAudit(
  rawBody: string, target: { provider: string; model: string; apiKey: string },
  transport: ProviderRequestAudit["transport"], options: ProviderRequestOptions,
  credentials: readonly string[] = []
): void {
  if (!options.onRequestAudit) return;
  try {
    const body = JSON.parse(rawBody);
    if (!Array.isArray(body.messages) || body.messages.some((message: { content?: unknown }) => typeof message?.content !== "string")) return;
    const knownCredentials = [...credentials, target.apiKey, target.apiKey.trim()];
    const safeIdentity = (value: string) => providerAuditIdentifier(value, knownCredentials) ?? "unknown";
    const event = normalizeRequestAudit({ stage: "prepared", requestedProvider: safeIdentity(target.provider), requestedModel: safeIdentity(target.model), transport,
      requestBytes: utf8RequestBytes(rawBody), messageCount: body.messages.length,
      messageChars: body.messages.reduce((sum: number, message: { content: string }) => sum + message.content.length, 0),
      toolSchemaChars: body.tools === undefined ? 0 : JSON.stringify(body.tools).length, maxOutputTokens: body.max_tokens });
    if (!event) return;
    const pending: unknown = options.onRequestAudit(event);
    if (pending && typeof (pending as PromiseLike<unknown>).then === "function") void Promise.resolve(pending).catch(() => undefined);
  } catch { /* Metrics never change transport, response or retry behavior. */ }
}
