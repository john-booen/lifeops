import { describe, expect, it } from "vitest";
import { allowSpeakerBargeIn, isSpeakerEcho, recordSpeakerPhrase, resetSpeakerEcho, ServerVoiceEndpoint, speakerMicVoice,
  voiceVadSilenceMs } from "../src/voice/continuousInput";

describe("continuous voice input", () => {
  it.each([true, false])("submits one final only when stop and final agree (stop first: %s)", stopFirst => {
    const gate = new ServerVoiceEndpoint();
    const stopped = { type: "stopped", itemId: "one" } as const;
    const final = { type: "final", itemId: "one", text: "今天完成几项？" } as const;
    expect(gate.accept({ type: "started", itemId: "one" })).toEqual({});
    expect(gate.accept({ type: "preview", itemId: "one", text: "今天" })).toEqual({});
    expect(gate.accept(stopFirst ? stopped : final)).toEqual({});
    expect(gate.accept(stopFirst ? final : stopped)).toEqual({ ready: final.text });
    expect(gate.accept(final)).toBeUndefined();
  });

  it("ignores a retired item and never dispatches a rejected item", () => {
    const gate = new ServerVoiceEndpoint();
    gate.accept({ type: "started", itemId: "old" });
    gate.accept({ type: "started", itemId: "new" });
    expect(gate.accept({ type: "final", itemId: "old", text: "过时语音" })).toBeUndefined();
    gate.accept({ type: "rejected", itemId: "new" });
    expect(gate.accept({ type: "stopped", itemId: "new" })).toBeUndefined();
    expect(gate.accept({ type: "final", itemId: "new", text: "被拒绝的语音" })).toBeUndefined();
  });

  it("only strengthens the microphone threshold during playback when cancellation is absent or an echo is found", () => {
    const owner = {}, other = {};
    resetSpeakerEcho(owner, true);
    expect(speakerMicVoice(owner, 0.02, true, 1_000)).toBe(true);
    recordSpeakerPhrase(owner, "今天还有两个任务要做。", 1_000);
    expect(isSpeakerEcho(owner, "今天还有两个任务", 1_100)).toBe(true);
    expect(isSpeakerEcho(other, "今天还有两个任务", 1_100)).toBe(false);
    expect(speakerMicVoice(owner, 0.02, true, 1_500)).toBe(false);
    expect(allowSpeakerBargeIn(owner, true, 1_500)).toBe(false);
    expect(speakerMicVoice(owner, 0.04, true, 1_510)).toBe(true);
    expect(allowSpeakerBargeIn(owner, true, 1_520)).toBe(true);
    expect(speakerMicVoice(owner, 0.02, false, 1_600)).toBe(true);
    expect(isSpeakerEcho(owner, "今天还有两个任务", 11_000)).toBe(false);
    expect(isSpeakerEcho(owner, "明天下午见客户", 1_100)).toBe(false);
    resetSpeakerEcho(other, false);
    expect(speakerMicVoice(other, 0.02, true, 1_000)).toBe(false);
  });

  it("uses 700 ms for legacy settings and preserves a supported configured value", () => {
    expect(voiceVadSilenceMs(undefined)).toBe(700);
    expect(voiceVadSilenceMs(900)).toBe(900);
    expect(voiceVadSilenceMs(299)).toBe(700);
    expect(voiceVadSilenceMs(3001)).toBe(700);
  });
});
