import { describe, expect, it } from "vitest";
import { normalizeQualityLogEntry, serializeQualityLogEntry } from "../src/qualityLog";
import type { QualityLogEntry } from "../src/types";

describe("quality log serialization", () => {
  it("serializes metrics as one JSONL-safe object", () => {
    const line = serializeQualityLogEntry({
      inputSource: "voice",
      asrFirstMs: 120.4,
      modelDoneMs: 980.8,
      captureMode: "audio-worklet",
      retrievalHits: 3,
      actionSuggestions: 2,
      agentRoute: "deep_reasoning",
      agentRunMs: 1200.6,
      contextSources: [" 日记/2026-07-28.md ", "日记/2026-07-28.md"],
      contextFailures: ["semantic"],
      delegationStatus: "completed",
      fallbackUsed: false
    }, "2026-06-11T00:00:00.000Z");

    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      loggedAt: "2026-06-11T00:00:00.000Z",
      inputSource: "voice",
      asrFirstMs: 120,
      modelDoneMs: 981,
      captureMode: "audio-worklet",
      retrievalHits: 3,
      actionSuggestions: 2,
      agentRoute: "deep_reasoning",
      agentRunMs: 1201,
      contextSources: ["日记/2026-07-28.md"],
      contextFailures: ["semantic"],
      delegationStatus: "completed",
      fallbackUsed: false
    });
  });

  it("does not preserve accidental full conversation fields", () => {
    const entry = {
      inputSource: "text",
      modelFirstMs: 300,
      userMessage: "完整用户消息不应进入质量日志",
      assistantReply: "完整助手回复不应进入质量日志"
    } as QualityLogEntry & { userMessage: string; assistantReply: string };

    const normalized = normalizeQualityLogEntry(entry, "2026-06-11T00:00:00.000Z");

    expect(JSON.stringify(normalized)).not.toContain("完整用户消息");
    expect(JSON.stringify(normalized)).not.toContain("完整助手回复");
  });

  it("trims and caps error messages", () => {
    const normalized = normalizeQualityLogEntry({
      inputSource: "voice",
      errorCode: " ASR_TIMEOUT ",
      errorMessage: ` ${"x".repeat(400)} `
    }, "2026-06-11T00:00:00.000Z");

    expect(normalized.errorCode).toBe("ASR_TIMEOUT");
    expect(normalized.errorMessage).toHaveLength(300);
  });

  it("retains only allowlisted provider facts and strips accidental transport payloads", () => {
    const normalized = normalizeQualityLogEntry({ providerRuns: [{
      requestedProvider: "kimi", requestedModel: "model", actualProvider: "deepseek", actualModel: "https://private.invalid/?key=secret",
      status: "success", fallbackUsed: true, endpoint: "https://private.invalid", apiKey: "secret", response: "private body",
      attempts: [{ provider: "kimi", model: "model", transport: "request_url", status: "failed", errorCode: "auth", httpStatus: 401, error: "private body" }]
    }] } as unknown as QualityLogEntry);
    expect(normalized.providerRuns?.[0].attempts[0]).toEqual({ provider: "kimi", model: "model", transport: "request_url", status: "failed", errorCode: "auth", httpStatus: 401 });
    expect(JSON.stringify(normalized)).not.toMatch(/private|secret|apiKey|endpoint|response/);
  });
});
