import { describe, expect, it } from "vitest";
import { VoiceE2eCircuitBreaker } from "../src/voice/voiceCircuitBreaker";

describe("VoiceE2eCircuitBreaker", () => {
  it("opens after three consecutive failures and bypasses E2E", () => {
    const breaker = new VoiceE2eCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 60_000,
      now: () => 1_000
    });

    breaker.recordFailure("failure-1");
    breaker.recordFailure("failure-2");
    expect(breaker.allowPrimary()).toBe(true);
    breaker.recordFailure("failure-3");

    expect(breaker.snapshot()).toMatchObject({
      state: "open",
      consecutiveFailures: 3,
      nextProbeAt: 61_000,
      lastErrorCode: "failure-3"
    });
    expect(breaker.allowPrimary()).toBe(false);
  });

  it("allows a half-open probe after cooldown and closes on success", () => {
    let now = 1_000;
    const breaker = new VoiceE2eCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 5_000,
      now: () => now
    });
    breaker.recordFailure("provider_down");

    now = 5_999;
    expect(breaker.allowPrimary()).toBe(false);
    now = 6_000;
    expect(breaker.allowPrimary()).toBe(true);
    expect(breaker.snapshot().state).toBe("half-open");

    breaker.recordSuccess();
    expect(breaker.snapshot()).toEqual({
      state: "closed",
      consecutiveFailures: 0,
      openedAt: null,
      nextProbeAt: null,
      lastErrorCode: null
    });
  });

  it("reopens immediately when a half-open probe fails", () => {
    let now = 1_000;
    const breaker = new VoiceE2eCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 5_000,
      now: () => now
    });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    now = 6_000;
    expect(breaker.allowPrimary()).toBe(true);

    breaker.recordFailure("probe_failed");

    expect(breaker.snapshot()).toMatchObject({
      state: "open",
      consecutiveFailures: 3,
      openedAt: 6_000,
      nextProbeAt: 11_000
    });
  });
});
