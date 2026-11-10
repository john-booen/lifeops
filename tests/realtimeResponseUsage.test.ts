import { describe, expect, it } from "vitest";
import { readRealtimeResponseUsage, normalizeProviderResponseUsage } from "../src/voice/realtimeResponseUsage";
import { serializeQualityLogEntry } from "../src/qualityLog";
import type { QualityLogEntry } from "../src/types";

const usage = { input_tokens: 336, output_tokens: 41, total_tokens: 377,
  input_tokens_details: { text_tokens: 228, audio_tokens: 108 },
  output_tokens_details: { text_tokens: 9, audio_tokens: 32 } };

describe("response usage metadata boundary", () => {
  it.each([undefined, null])("keeps missing usage distinct from zero (%s)", value => {
    expect(readRealtimeResponseUsage(value)).toEqual({ status: "missing" });
  });
  it("preserves genuine zeros and does not fill absent modalities", () => {
    expect(readRealtimeResponseUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0,
      output_tokens_details: { text_tokens: 0 } })).toEqual({
      status: "reported", inputTokens: 0, outputTokens: 0, totalTokens: 0, outputDetails: { textTokens: 0 }
    });
  });
  it("accepts documented counters, with partial details and unknown fields omitted", () => {
    const parsed = readRealtimeResponseUsage({ ...usage, plugins: { search: { count: 1, strategy: "private" } },
      output_tokens_details: { text_tokens: 9, audio_tokens: 32, transcript: "private" }, response: "private" });
    expect(parsed).toEqual({ status: "reported", inputTokens: 336, outputTokens: 41, totalTokens: 377,
      inputDetails: { textTokens: 228, audioTokens: 108 }, outputDetails: { textTokens: 9, audioTokens: 32 } });
    expect(JSON.stringify(parsed)).not.toContain("private");
    expect(readRealtimeResponseUsage({ input_tokens: 336, output_tokens: 41, total_tokens: 377,
      input_tokens_details: { text_tokens: 228, image_tokens: 108 } })).toEqual({
      status: "reported", inputTokens: 336, outputTokens: 41, totalTokens: 377, inputDetails: { textTokens: 228 }
    });
  });
  it.each([-1, 1.1, "336", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined])(
    "rejects invalid known counters (%s) without coercion", input_tokens => {
      expect(readRealtimeResponseUsage({ ...usage, input_tokens })).toEqual({ status: "invalid" });
    });
  it.each([
    [], "private", {}, { ...usage, total_tokens: 378 },
    { ...usage, input_tokens_details: null }, { ...usage, output_tokens_details: [] },
    { ...usage, input_tokens_details: { text_tokens: 337 } },
    { ...usage, output_tokens_details: { text_tokens: 30, audio_tokens: 32 } },
    { ...usage, output_tokens_details: { text_tokens: "private" } },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER }
  ])("marks malformed or inconsistent receipts invalid", value => {
    expect(readRealtimeResponseUsage(value)).toEqual({ status: "invalid" });
  });
  it("owns fresh count objects independently of the transport payload", () => {
    const wire = structuredClone(usage), parsed = readRealtimeResponseUsage(wire);
    wire.input_tokens_details.text_tokens = 0;
    expect(parsed).toMatchObject({ inputDetails: { textTokens: 228 } });
  });
  it("revalidates and strips nested payloads at persistence, including forged status objects", () => {
    const observed = readRealtimeResponseUsage(usage);
    const line = serializeQualityLogEntry({ providerRuns: [{ requestedProvider: "bailian-realtime",
      requestedModel: "synthetic-omni", status: "success", fallbackUsed: false, attempts: [],
      responseUsage: { ...observed, responseId: "private-server-id", apiKey: "private-key", output: "private-body",
        inputDetails: { textTokens: 228, audioTokens: 108, transcript: "private-transcript" } }
    }] } as unknown as QualityLogEntry);
    expect(line).not.toContain("private");
    expect(JSON.parse(line).providerRuns[0].responseUsage).toEqual(observed);
    expect(normalizeProviderResponseUsage({ status: "reported", inputTokens: 1, outputTokens: 2,
      totalTokens: 3, outputDetails: { audioTokens: "private" } })).toEqual({ status: "invalid" });
    expect(normalizeProviderResponseUsage({ status: "missing", inputTokens: 0, body: "private" })).toEqual({ status: "missing" });
    expect(normalizeProviderResponseUsage({ status: "private" })).toEqual({ status: "invalid" });
  });
});
