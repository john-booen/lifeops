import { describe, expect, it } from "vitest";
import {
  VoiceBargeInController,
  type VoiceBargeInEvent
} from "../src/voice/voiceBargeIn";

function createHarness() {
  let now = 1_000;
  let nextTimer = 1;
  const timers = new Map<number, () => void>();
  const events: VoiceBargeInEvent[] = [];
  const controller = new VoiceBargeInController({
    confirmationMs: 500,
    now: () => now,
    setTimer: (callback) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (timerId) => {
      timers.delete(timerId);
    },
    onEvent: (event) => events.push(event)
  });
  return {
    controller,
    events,
    advance: (ms: number) => {
      now += ms;
    },
    fireTimers: () => {
      const pending = Array.from(timers.values());
      timers.clear();
      pending.forEach((callback) => callback());
    }
  };
}

const identity = {
  generation: 3,
  turnId: "turn-a",
  playbackId: "playback-a"
};

describe("VoiceBargeInController", () => {
  it("treats speech start as a reversible suspicion", () => {
    const harness = createHarness();
    expect(harness.controller.suspect(identity)).toBe(true);
    expect(harness.controller.snapshot()).toMatchObject({
      phase: "suspected",
      identity
    });
    expect(harness.events.at(-1)).toMatchObject({
      type: "suspected",
      reason: "speech_started"
    });
  });

  it("restores a short false alarm when speech stops before confirmation", () => {
    const harness = createHarness();
    harness.controller.suspect(identity);
    harness.advance(180);
    expect(harness.controller.speechStopped()).toBe("idle");
    expect(harness.events.at(-1)).toMatchObject({
      type: "false-alarm",
      reason: "speech_stopped_before_confirmation",
      elapsedMs: 180
    });
  });

  it("confirms immediately on meaningful transcript", () => {
    const harness = createHarness();
    harness.controller.suspect(identity);
    harness.advance(120);
    expect(harness.controller.observeTranscript("等一下，我还没说完", {
      meaningful: true
    })).toBe("confirmed");
    expect(harness.events.at(-1)).toMatchObject({
      type: "confirmed",
      reason: "meaningful_transcript",
      textLength: 9
    });
  });

  it("confirms control intent even before a long utterance", () => {
    const harness = createHarness();
    harness.controller.suspect(identity);
    expect(harness.controller.observeTranscript("等一下", {
      controlIntent: true,
      meaningful: false
    })).toBe("confirmed");
    expect(harness.events.at(-1)?.reason).toBe("control_intent");
  });

  it("does not confirm a backchannel-only transcript", () => {
    const harness = createHarness();
    harness.controller.suspect(identity);
    expect(harness.controller.observeTranscript("嗯嗯", {
      meaningful: false
    })).toBe("suspected");
    harness.controller.speechStopped();
    expect(harness.events.some((event) => event.type === "confirmed")).toBe(false);
  });

  it("confirms sustained speech after the threshold", () => {
    const harness = createHarness();
    harness.controller.suspect(identity);
    harness.advance(500);
    harness.fireTimers();
    expect(harness.controller.snapshot()).toMatchObject({
      phase: "confirmed",
      confirmationReason: "sustained_speech"
    });
    expect(harness.events.at(-1)).toMatchObject({
      type: "confirmed",
      elapsedMs: 500
    });
  });

  it("clears the pending timer when reset", () => {
    const harness = createHarness();
    harness.controller.suspect(identity);
    harness.controller.reset("turn_settled");
    harness.advance(500);
    harness.fireTimers();
    expect(harness.controller.snapshot().phase).toBe("idle");
    expect(harness.events.some((event) => event.type === "confirmed")).toBe(false);
  });
});
