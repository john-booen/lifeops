import { describe, expect, it } from "vitest";
import {
  isVoiceBackchannelOnly,
  isVoiceClearlyIncompleteTurn,
  isVoiceHoldOnlyTurn,
  isVoiceLikelyCompleteTurn,
  mergeVoiceTurnText,
  voiceEndpointDelayMs,
  VOICE_ENDPOINT_DELAYS
} from "../src/voiceSession";

describe("voiceEndpointDelayMs", () => {
  it("still waits a small stable window for short complete utterances", () => {
    const delay = voiceEndpointDelayMs("你好啊，今天怎么样？");
    expect(delay).toBeGreaterThanOrEqual(2000);
    expect(delay).toBeLessThanOrEqual(2600);
  });

  it("holds backchannel fillers instead of sending them as full turns", () => {
    expect(isVoiceBackchannelOnly("嗯")).toBe(true);
    expect(isVoiceBackchannelOnly("对对")).toBe(true);
    expect(voiceEndpointDelayMs("嗯")).toBeGreaterThanOrEqual(VOICE_ENDPOINT_DELAYS.maxMs);
    expect(voiceEndpointDelayMs("好")).toBeGreaterThanOrEqual(VOICE_ENDPOINT_DELAYS.maxMs);
  });

  it("holds thinking fillers but not interrupt or stop phrases", () => {
    expect(isVoiceHoldOnlyTurn("我想一下")).toBe(true);
    expect(isVoiceHoldOnlyTurn("我还没说完")).toBe(false);
    expect(isVoiceHoldOnlyTurn("等一下")).toBe(false);
  });

  it("waits longer when the utterance clearly continues", () => {
    expect(voiceEndpointDelayMs("我觉得这个事情还有一个问题")).toBeGreaterThanOrEqual(VOICE_ENDPOINT_DELAYS.longMs);
  });

  it("exposes completion signals for the realtime endpoint layer", () => {
    expect(isVoiceLikelyCompleteTurn("今天还可以吧")).toBe(true);
    expect(isVoiceClearlyIncompleteTurn("但是我还想说")).toBe(true);
    expect(isVoiceLikelyCompleteTurn("但是我还想说")).toBe(false);
  });

  it("does not quickly send short unfinished correction fragments", () => {
    expect(voiceEndpointDelayMs("不是")).toBeGreaterThanOrEqual(VOICE_ENDPOINT_DELAYS.longMs);
    expect(voiceEndpointDelayMs("我想")).toBeGreaterThanOrEqual(VOICE_ENDPOINT_DELAYS.longMs);
  });

  it("waits for thinking pauses in conversational fragments", () => {
    expect(voiceEndpointDelayMs("我也在想啊")).toBeGreaterThanOrEqual(VOICE_ENDPOINT_DELAYS.longMs);
    expect(voiceEndpointDelayMs("到底要不要现在")).toBeGreaterThanOrEqual(VOICE_ENDPOINT_DELAYS.longMs);
    expect(voiceEndpointDelayMs("你不是，你不应")).toBeGreaterThanOrEqual(VOICE_ENDPOINT_DELAYS.longMs);
    expect(isVoiceClearlyIncompleteTurn("嗯。帮我把那个去银行的。")).toBe(true);
    expect(isVoiceClearlyIncompleteTurn("我真是服了这个垃圾我他妈修。")).toBe(true);
  });

  it("waits longer for long unfinished speech", () => {
    const text = "我今天想把这个事情从头到尾说清楚，第一部分是上午的状态，第二部分是下午发生的变化，第三部分是我想让你帮我判断接下来";
    expect(voiceEndpointDelayMs(text)).toBeGreaterThanOrEqual(VOICE_ENDPOINT_DELAYS.longMs);
  });

  it("uses a moderate delay for medium complete speech", () => {
    const delay = voiceEndpointDelayMs("我今天状态不太好，你帮我分析一下原因和接下来怎么调整");
    expect(delay).toBeGreaterThan(VOICE_ENDPOINT_DELAYS.quickMs);
    expect(delay).toBeLessThanOrEqual(VOICE_ENDPOINT_DELAYS.longMs);
  });
});

describe("mergeVoiceTurnText", () => {
  it("appends separate realtime ASR segments into one turn", () => {
    expect(mergeVoiceTurnText("我先说第一点", "然后还有第二点")).toBe("我先说第一点 然后还有第二点");
  });

  it("keeps cumulative ASR text when the next segment already contains the previous text", () => {
    expect(mergeVoiceTurnText("我先说第一点", "我先说第一点然后还有第二点")).toBe("我先说第一点然后还有第二点");
  });

  it("does not duplicate repeated partial text", () => {
    expect(mergeVoiceTurnText("我先说第一点", "第一点")).toBe("我先说第一点");
  });
});
