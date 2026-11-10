import { describe, expect, it } from "vitest";
import {
  decideLocalVoiceEndpoint,
  decideVoiceTurnReadiness,
  detectVoiceControlEvent,
  shouldHoldVoiceTurnForControl,
  shouldIgnoreVoiceSpeechStart,
  shouldInterruptAssistantForTranscript,
  shouldSuppressAssistantSpeech,
  shouldSuppressAssistantSpeechForQueue,
  stripVoiceControlPhrases
} from "../src/voiceSession";
import { beginNewTurn, createVoiceSession, dequeueInput, enqueueInput, finalizeTurn, transition } from "../src/voiceSession";

describe("voiceRuntime", () => {
  it("holds fillers instead of sending them to the model", () => {
    expect(decideVoiceTurnReadiness({
      mode: "voice",
      recording: true,
      busy: false,
      text: "嗯",
      visibleText: "嗯",
      recentDuplicate: false,
      alreadySent: false
    })).toEqual({ decision: "hold", reason: "hold_only_turn" });
  });

  it("queues real speech while the agent is busy", () => {
    expect(decideVoiceTurnReadiness({
      mode: "voice",
      recording: true,
      busy: true,
      text: "我还想补充一句，刚才不是这个意思",
      visibleText: "我还想补充一句，刚才不是这个意思",
      recentDuplicate: false,
      alreadySent: false
    })).toEqual({ decision: "queue", reason: "agent_busy" });
  });

  it("sends ready voice turns and suppresses duplicates", () => {
    expect(decideVoiceTurnReadiness({
      mode: "voice",
      recording: true,
      busy: false,
      text: "今天过得还可以，你听我继续说",
      visibleText: "今天过得还可以，你听我继续说",
      recentDuplicate: false,
      alreadySent: false
    }).decision).toBe("send");

    expect(decideVoiceTurnReadiness({
      mode: "voice",
      recording: true,
      busy: false,
      text: "今天过得还可以",
      recentDuplicate: true,
      alreadySent: false
    }).decision).toBe("duplicate");
  });

  it("uses local silence to close a complete voice turn before server final transcript", () => {
    expect(decideLocalVoiceEndpoint({
      mode: "voice",
      recording: true,
      busy: false,
      text: "今天还可以吧",
      visibleText: "今天还可以吧",
      recentDuplicate: false,
      alreadySent: false,
      silenceMs: 1100
    })).toEqual({ decision: "idle", reason: "local_silence_too_short" });

    expect(decideLocalVoiceEndpoint({
      mode: "voice",
      recording: true,
      busy: false,
      text: "今天还可以吧",
      visibleText: "今天还可以吧",
      recentDuplicate: false,
      alreadySent: false,
      silenceMs: 2300
    })).toEqual({ decision: "send", reason: "ready" });
  });

  it("does not force-send incomplete speech on local silence", () => {
    expect(decideLocalVoiceEndpoint({
      mode: "voice",
      recording: true,
      busy: false,
      text: "但是我还想说",
      visibleText: "但是我还想说",
      recentDuplicate: false,
      alreadySent: false,
      silenceMs: 2300
    })).toEqual({ decision: "hold", reason: "local_endpoint_incomplete_turn" });
  });

  it("detects repair control events before they become normal chat", () => {
    const event = detectVoiceControlEvent("喂，能听到我说话吗？我还没说完吧");
    expect(event?.kind).toBe("repair_keep_listening");
    expect(event?.reply).toContain("我在");
    expect(detectVoiceControlEvent("喂，今天怎么样")).toBeNull();
  });

  it("holds the current turn after a repair control event until new content arrives", () => {
    const held = detectVoiceControlEvent("喂，能听到我说话吗？我还没说完吧")?.signature ?? "";
    expect(shouldHoldVoiceTurnForControl({
      text: "喂，能听到我说话吗？我还没说完吧",
      heldSignature: held,
      nowMs: 1000,
      holdUntilMs: 5000
    })).toBe(true);

    expect(shouldHoldVoiceTurnForControl({
      text: "喂，能听到我说话吗？我还没说完吧，后面我想说今天状态其实还可以",
      heldSignature: held,
      nowMs: 2000,
      holdUntilMs: 5000
    })).toBe(false);

    expect(shouldHoldVoiceTurnForControl({
      text: "喂，能听到我说话吗？我还没说完吧，后面我想说今天状态其实还可以",
      heldSignature: held,
      nowMs: 7000,
      holdUntilMs: 5000
    })).toBe(false);
  });

  it("strips control phrases before sending a recovered substantive turn", () => {
    expect(stripVoiceControlPhrases("喂，能听到我说话吗？我还没说完吧，后面我想说今天状态其实还可以"))
      .toBe("后面我想说今天状态其实还可以");
  });

  it("suppresses assistant speech when queued user input exists", () => {
    expect(shouldSuppressAssistantSpeechForQueue(1)).toBe(true);
    expect(shouldSuppressAssistantSpeechForQueue(0)).toBe(false);
  });

  it("suppresses assistant speech as soon as the user interrupts, even before transcript finalizes", () => {
    expect(shouldSuppressAssistantSpeech({
      queueLength: 0,
      interruptedWhileBusy: true
    })).toBe(true);

    expect(shouldSuppressAssistantSpeech({
      queueLength: 0,
      interruptedWhileBusy: false
    })).toBe(false);
  });

  it("does not treat submit-tail audio as a stale-model interruption", () => {
    expect(shouldIgnoreVoiceSpeechStart({
      agentBusy: true,
      assistantSpeaking: false,
      nowMs: 1000,
      ignoreUntilMs: 1800
    })).toBe(true);

    expect(shouldIgnoreVoiceSpeechStart({
      agentBusy: true,
      assistantSpeaking: true,
      nowMs: 1000,
      ignoreUntilMs: 1800
    })).toBe(true);

    expect(shouldIgnoreVoiceSpeechStart({
      agentBusy: true,
      assistantSpeaking: false,
      nowMs: 2200,
      ignoreUntilMs: 1800
    })).toBe(false);
  });

  it("protects assistant playback from its own VAD echo during the guard window", () => {
    expect(shouldIgnoreVoiceSpeechStart({
      agentBusy: false,
      assistantSpeaking: true,
      nowMs: 1200,
      ignoreUntilMs: 2400
    })).toBe(true);

    expect(shouldIgnoreVoiceSpeechStart({
      agentBusy: false,
      assistantSpeaking: true,
      nowMs: 3000,
      ignoreUntilMs: 2400
    })).toBe(true);
  });

  it("does not interrupt assistant playback from noise-like transcripts", () => {
    expect(shouldInterruptAssistantForTranscript({
      assistantSpeaking: true,
      transcript: "嗯"
    })).toBe(false);

    expect(shouldInterruptAssistantForTranscript({
      assistantSpeaking: true,
      transcript: "停一下",
      controlEvent: true
    })).toBe(true);

    expect(shouldInterruptAssistantForTranscript({
      assistantSpeaking: true,
      transcript: "我换个说法，刚才不是这个意思"
    })).toBe(true);
  });

  it("simulates a busy-agent interruption flowing into the voice queue", () => {
    let session = createVoiceSession();
    session = transition(session, "warming");
    session = transition(session, "listening");
    session = beginNewTurn(session, { turnId: "turn-1" });

    const firstDecision = decideVoiceTurnReadiness({
      mode: "voice",
      recording: true,
      busy: false,
      text: "今天还可以吧，我想跟你聊一下",
      recentDuplicate: false,
      alreadySent: false
    });
    expect(firstDecision.decision).toBe("send");

    session = finalizeTurn(session, "今天还可以吧，我想跟你聊一下");
    session = transition(session, "processing");

    expect(shouldSuppressAssistantSpeech({
      queueLength: session.inputQueue.length,
      interruptedWhileBusy: true
    })).toBe(true);

    const interruptedDecision = decideVoiceTurnReadiness({
      mode: "voice",
      recording: true,
      busy: true,
      text: "等一下，我还没说完，后面还有一句",
      visibleText: "等一下，我还没说完，后面还有一句",
      recentDuplicate: false,
      alreadySent: false
    });
    expect(interruptedDecision.decision).toBe("queue");

    session = enqueueInput(session, {
      text: "等一下，我还没说完，后面还有一句",
      source: "voice",
      turnId: "turn-2",
      priority: "interrupt"
    });
    expect(session.inputQueue).toHaveLength(1);
    expect(shouldSuppressAssistantSpeech({
      queueLength: session.inputQueue.length,
      interruptedWhileBusy: false
    })).toBe(true);

    session = transition(session, "listening");
    const queued = dequeueInput(session);
    expect(queued.next?.text).toBe("等一下，我还没说完，后面还有一句");
    session = beginNewTurn(queued.session, { turnId: queued.next?.turnId, resetQueue: false });
    expect(session.inputQueue).toHaveLength(0);
  });
});
