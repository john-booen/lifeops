import { describe, expect, it } from "vitest";
import { runVoiceRuntimeSelfTest } from "../src/voiceCheck";

describe("runVoiceRuntimeSelfTest", () => {
  it("passes the voice runtime checks used by the Obsidian command", () => {
    const report = runVoiceRuntimeSelfTest("2026-06-11T00:00:00.000Z");

    expect(report.ok).toBe(true);
    expect(report.ranAt).toBe("2026-06-11T00:00:00.000Z");
    expect(report.events).toContain("suppress:interrupt-before-transcript");
    expect(report.events).toContain("queue:self-test-turn-2");
    expect(report.checks.map((item) => item.name)).toEqual([
      "backchannel hold",
      "local endpoint sends complete turn",
      "local endpoint holds incomplete turn",
      "first turn sends",
      "interrupt suppresses old speech",
      "busy speech queues",
      "queued input suppresses old speech",
      "queue consumes next input",
      "repair control event detected before LLM",
      "repair control holds current turn",
      "repair control strips before recovered send",
      "managed runtime connects",
      "managed e2e waits for model and playback",
      "managed noise suspicion is reversible",
      "managed cascade interruption aborts active turn",
      "managed next turn starts after interruption",
      "managed runtime invariants hold"
    ]);
    expect(report.checks.every((item) => item.ok)).toBe(true);
  });
});
