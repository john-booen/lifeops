import type { ProviderResponseUsage, ProviderTokenDetails } from "../types";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/** Read only documented counters; never retain the raw usage or response body.
 * https://www.alibabacloud.com/help/en/model-studio/server-events */
export function readRealtimeResponseUsage(value: unknown): ProviderResponseUsage {
  if (value === undefined || value === null) return { status: "missing" };
  return readCounts(value, true);
}

/** Rebuild the allowlist again at the persistence boundary. */
export function normalizeProviderResponseUsage(value: unknown): ProviderResponseUsage {
  if (!record(value)) return { status: "invalid" };
  if (value.status === "missing" || value.status === "invalid") return { status: value.status };
  return value.status === "reported" ? readCounts(value, false) : { status: "invalid" };
}

function readCounts(value: unknown, wire: boolean): ProviderResponseUsage {
  const invalid: ProviderResponseUsage = { status: "invalid" };
  if (!record(value)) return invalid;
  const inputTokens = value[wire ? "input_tokens" : "inputTokens"];
  const outputTokens = value[wire ? "output_tokens" : "outputTokens"];
  const totalTokens = value[wire ? "total_tokens" : "totalTokens"];
  if (!count(inputTokens) || !count(outputTokens) || !count(totalTokens)
    || !Number.isSafeInteger(inputTokens + outputTokens) || inputTokens + outputTokens !== totalTokens) return invalid;
  const input = details(value, wire ? "input_tokens_details" : "inputDetails", inputTokens, wire);
  const output = details(value, wire ? "output_tokens_details" : "outputDetails", outputTokens, wire);
  if (input === false || output === false) return invalid;
  return { status: "reported", inputTokens, outputTokens, totalTokens,
    ...(input ? { inputDetails: input } : {}), ...(output ? { outputDetails: output } : {}) };
}

function details(parent: Record<string, unknown>, key: string, total: number, wire: boolean): ProviderTokenDetails | undefined | false {
  if (!own(parent, key)) return undefined;
  const value = parent[key];
  if (!record(value)) return false;
  const result: ProviderTokenDetails = {};
  let sum = 0;
  for (const [raw, name] of [[wire ? "text_tokens" : "textTokens", "textTokens"],
    [wire ? "audio_tokens" : "audioTokens", "audioTokens"]] as const) {
    if (!own(value, raw)) continue;
    const tokens = value[raw];
    if (!count(tokens)) return false;
    sum += tokens;
    if (!Number.isSafeInteger(sum) || sum > total) return false;
    result[name] = tokens;
  }
  // Other modalities may account for the rest; absent counts are never zero.
  return Object.keys(result).length ? result : undefined;
}
