import { describe, expect, it } from "vitest";
import { normalizeVoiceMetricEntry, serializeVoiceMetricEntry } from "../src/voiceMetrics";
import type { VoiceMetricEntry } from "../src/types";
import { markVoiceLatency, markVoiceLatencyCapture, resetVoiceLatencyCapture, takeVoiceLatencyCapture } from "../src/voice/latency";

describe("voice metrics serialization", () => {
  it("serializes a JSONL-safe voice turn metric", () => {
    const line = serializeVoiceMetricEntry({
      event: "voice_turn_completed",
      provider: "qwen-omni-realtime",
      model: "qwen3.5-omni-plus-realtime",
      mode: "voice",
      phase: "listening",
      captureMode: "audio-worklet",
      queueLength: 1.2,
      generation: 3,
      textLength: 18,
      asrFirstMs: 240.2,
      modelDoneMs: 1234.8,
      ttsFirstMs: 520,
      actionSuggestions: 2
    }, "2026-06-23T00:00:00.000Z");

    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      loggedAt: "2026-06-23T00:00:00.000Z",
      event: "voice_turn_completed",
      provider: "qwen-omni-realtime",
      model: "qwen3.5-omni-plus-realtime",
      mode: "voice",
      phase: "listening",
      captureMode: "audio-worklet",
      queueLength: 1,
      generation: 3,
      textLength: 18,
      asrFirstMs: 240,
      modelDoneMs: 1235,
      ttsFirstMs: 520,
      actionSuggestions: 2
    });
  });

  it("drops accidental transcript-like fields and caps messages", () => {
    const entry = {
      event: "voice_error",
      reason: " ".repeat(2) + "x".repeat(260),
      errorMessage: " ".repeat(2) + "y".repeat(360),
      userTranscript: "这句完整语音不应该进指标日志"
    } as VoiceMetricEntry & { userTranscript: string };

    const normalized = normalizeVoiceMetricEntry(entry, "2026-06-23T00:00:00.000Z");

    expect(JSON.stringify(normalized)).not.toContain("完整语音");
    expect(normalized.reason).toHaveLength(180);
    expect(normalized.errorMessage).toHaveLength(300);
  });

  it("serializes only finite timing points and preserves zero for the clock origin", () => {
    const latency = { t0: 0, t1: 120.3, t2: 699.8, t3: 740, t4: 3210, t5: Infinity, transcript: "虚构文字" };
    const saved = JSON.parse(serializeVoiceMetricEntry({ event: "voice_latency_sample", latency }));
    expect(saved.latency).toEqual({ t0: 0, t1: 120, t2: 700, t3: 740, t4: 3210 });
    expect(JSON.stringify(saved)).not.toContain("虚构文字");
  });

  it("hands each completed capture to its own reply and ignores duplicate playback notifications", () => {
    const firstView = {}, secondView = {};
    markVoiceLatencyCapture(firstView, "t0");
    markVoiceLatencyCapture(firstView, "t1");
    markVoiceLatencyCapture(secondView, "t0");
    const first = takeVoiceLatencyCapture(firstView);
    expect(first).toMatchObject({ t0: expect.any(Number), t1: expect.any(Number) });
    expect(takeVoiceLatencyCapture(firstView)).toBeUndefined();
    expect(markVoiceLatency(first, "t5")).toBe(true);
    expect(markVoiceLatency(first, "t5")).toBe(false);
    resetVoiceLatencyCapture(secondView);
    expect(takeVoiceLatencyCapture(secondView)).toBeUndefined();
  });
});
