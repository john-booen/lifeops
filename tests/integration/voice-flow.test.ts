import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsApp } from "../helpers/fsApp";
import { LifeOpsStore } from "../../src/store";
import type { StoreHost } from "../../src/store/settingsSlice";
import { AgentRuntime } from "../../src/agentRuntime";
import { providerRunStart, ProviderRunFailure } from "../../src/providerRun";
import { runConfirmedToolAction } from "../../src/toolRegistry";
import {
  addEchoText,
  appendTurnText,
  beginNewTurn,
  clearEchoMemories,
  createVoiceSession,
  decideLocalVoiceEndpoint,
  detectVoiceControlEvent,
  finalizeTurn,
  isAlreadySent,
  isEchoTranscript,
  shouldHoldVoiceTurnForControl,
  stripVoiceControlPhrases,
  transition
} from "../../src/voiceSession";
import { DEFAULT_SETTINGS } from "../../src/defaults";
import { BailianConnectionTimeoutError, BailianRealtimeClient } from "../../src/bailianRealtime";
import { BailianRealtimeTtsClient } from "../../src/bailianTtsRealtime";
import { VoiceBargeInController } from "../../src/voice/voiceBargeIn";
import { VoiceSessionController } from "../../src/voice/voiceRuntime";
import { armOmniResponseTimer, clearOmniResponseTimer } from "../../src/voice/omniE2e/responseTimer";
import * as breezeSpeech from "../../src/voice/breezeSpeech";
import * as playbackInput from "../../src/voice/playbackInput";
import type { BreezeResidentWorker } from "../../src/voice/breezeResident";
import type { AgentSubmissionOptions } from "../../src/types";
import { createVoiceWorklet } from "../eval/voiceWorklet";
import { recordSpeakerPhrase, resetSpeakerEcho, ServerVoiceEndpoint } from "../../src/voice/continuousInput";
import { beginHeardSpeech, rememberHeardPhrase } from "../../src/voice/interruption";

const TEST_REALTIME_SETTINGS = {
  ...DEFAULT_SETTINGS.realtimeVoice,
  dataDisclosureAccepted: true,
  plaintextCredentialStorageAccepted: true
};
import {
  finishOmniE2eVoiceTurn,
  fallbackOmniResponseToBrain,
  executeOmniE2eToolCall,
  handleOmniE2eAudioDelta,
  handleOmniE2eAudioDone,
  handleOmniE2eAudioOutputEvent,
  handleCascadeCapture,
  handleOmniE2eBargeInEvent,
  handleOmniE2eResponseCreated,
  handleRealtimeDisconnect,
  handleOmniE2eSpeechStarted,
  handleOmniE2eSpeechStopped,
  hasActiveVoiceRuntimeTurn,
  interruptManagedVoiceTurn,
  interruptOmniE2eVoiceTurn,
  observeOmniE2eBargeInTranscript,
  sendManagedVoiceTurn,
  sendOmniE2eVoiceTurn,
  startSystemSpeechForActiveTurn
} from "../../src/voice/voiceRealtime";
import { cleanupRealtimeAudio, voiceJobsForPanel } from "../../src/voice/voiceRealtime";
import { handleVoiceJobTool } from "../../src/voice/jobs";

it("lets only the current Omni runtime's active response time out", () => {
  const callbacks: Array<() => void> = [];
  const clearTimeout = vi.fn();
  vi.stubGlobal("window", { setTimeout: (callback: () => void) => callbacks.push(callback), clearTimeout });
  const start = () => {
    const runtime = new VoiceSessionController({ provider: "offline-synthetic" });
    runtime.connect();
    runtime.connected();
    runtime.beginTurn({ route: "e2e" });
    return runtime;
  };
  const view = { agentVoiceRuntime: start(), agentVoiceResponseTimer: 0 };
  const fallback = vi.fn();
  try {
    armOmniResponseTimer(view, fallback);
    view.agentVoiceRuntime = start();
    armOmniResponseTimer(view, fallback);
    expect(clearTimeout).toHaveBeenCalledWith(1);
    callbacks[0]();
    expect(view.agentVoiceResponseTimer).toBe(2);
    expect(fallback).not.toHaveBeenCalled();
    callbacks[1]();
    expect(fallback).toHaveBeenCalledExactlyOnceWith("Qwen-Omni response timeout after 20s");
    expect(view.agentVoiceResponseTimer).toBe(0);
    armOmniResponseTimer(view, fallback);
    view.agentVoiceRuntime = start();
    callbacks[2]();
    expect(fallback).toHaveBeenCalledTimes(1);
    armOmniResponseTimer(view, fallback);
    clearOmniResponseTimer(view);
    callbacks[3]();
    expect(fallback).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});

const websocketMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;

  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    readonly sent: string[] = [];
    readonly handlers = new Map<string, Handler[]>();
    readyState = MockWebSocket.CONNECTING;

    constructor(readonly url: string, readonly options?: { headers?: Record<string, string> }) {
      instances.push(this);
    }

    on(event: string, handler: Handler): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      if (event === "open") this.readyState = MockWebSocket.OPEN;
      if (event === "close") this.readyState = MockWebSocket.CLOSED;
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(code = 1000, reason = Buffer.alloc(0)): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", code, reason);
    }

    terminate(): void {
      this.readyState = MockWebSocket.CLOSED;
    }
  }

  const instances: MockWebSocket[] = [];
  return { instances, MockWebSocket };
});

vi.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
  TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  Notice: class Notice {
    constructor(readonly message: string) {}
  }
}));

vi.mock("ws", () => ({
  default: websocketMock.MockWebSocket
}));

const { audioRms, base64ToPcm16, floatTo16kPcm, observeLocalVoiceEnergy, pcm16ToBase64 } = await import("../../src/voice/voiceRealtime");
const { applyComposerPanel } = await import("../../src/panel/composer");
class CascadeComposerTestView {}
applyComposerPanel(CascadeComposerTestView);
const sendThroughComposer = (view: object) => (CascadeComposerTestView.prototype as any).sendVoiceTurnIfReady.call(view);
const { applySuggestionsPanel } = await import("../../src/panel/suggestions");

describe("Tool Safety voice confirmation boundary", () => {
  it.each(["delete_task", "delete_habit", "update_memory", "review_memory", "task_plan"])(
    "does not accept spoken confirmation for %s", async (type) => {
      class TestView {}
      applySuggestionsPanel(TestView as any);
      const view = Object.assign(new TestView(), {
        pendingAgentActions: [{ id: "card", type }],
        acceptAgentSuggestion: vi.fn()
      }) as any;
      expect(await view.tryAcceptPendingActionFromVoice("确认")).toBe(false);
      expect(view.acceptAgentSuggestion).not.toHaveBeenCalled();
      expect(view.pendingAgentActions).toHaveLength(1);
    }
  );

  it.each(["active", "completed", "interrupted", "failed", "missing", "reject_identity"])(
    "uses only active turn text for tool authorization: %s", async (phase) => {
      const execute = vi.fn(async () => ({ reply: "检查完成", actions: [] }));
      const runtime = new VoiceSessionController({ provider: "offline-synthetic" }); runtime.connect(); runtime.connected();
      if (phase !== "missing") {
        runtime.beginTurn({ route: "e2e", transcript: "请写入日记：今日进展" });
        runtime.transitionTurn("routing"); runtime.transitionTurn("generating");
        if (phase === "completed") runtime.complete();
        if (phase === "interrupted") runtime.interrupt();
        if (phase === "failed") runtime.fail();
        if (phase === "reject_identity") vi.spyOn(runtime, "accepts").mockReturnValue(false);
      }
      const view = {
        controller: { executeAgentToolCall: execute },
        agentVoiceRuntime: runtime,
        agentInput: "提醒我买菜", currentVoiceMessageText: () => "提醒我买菜",
        agentOmniE2eAssistantIndex: 0, agentOmniE2eReply: "",
        agentMessages: [{ role: "assistant", content: "" }],
        agentVoiceTrace: {}, setAgentMessageBubbleContent: vi.fn(),
        scrollAgentTranscriptToBottom: vi.fn(), refreshAgentSurfaceState: vi.fn(), markVoiceTrace: vi.fn()
      } as any;
      const call = { id: "call", name: "append_journal_entry", arguments: { content: "今日进展" } };
      await executeOmniE2eToolCall(view, call);
      if (phase === "active") expect(execute).toHaveBeenCalledWith(call, "请写入日记：今日进展", expect.any(Function));
      else expect(execute).not.toHaveBeenCalled();
    }
  );
});

beforeEach(() => {
  clearEchoMemories();
  websocketMock.instances.length = 0;
  vi.stubGlobal("window", {
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("voice integration flow", () => {
  it("closes the output when leaving voice and renders again on the next start", async () => {
    const output = createVoiceWorklet(() => undefined);
    const view = Object.assign(new CascadeComposerTestView(), {
      agentAudioOutput: output.actor,
      agentVoiceConversation: true,
      clearVoiceLocalEndpointTimer: vi.fn(), clearVoiceNoTranscriptTimer: vi.fn(),
      invalidateVoicePipeline: vi.fn(), interruptAgentSpeech: vi.fn(),
      stopAgentRecording: vi.fn(), refreshAgentSurfaceState: vi.fn()
    }) as any;
    const pcm = new Int16Array(512).fill(8192);
    try {
      await output.actor.start("old", "fallback-tts");
      expect(output.actor.appendPcm16("old", pcm, 48_000)).toBe(true);
      expect(output.render().some(sample => sample !== 0)).toBe(true);

      view.stopVoiceStandby();

      expect(view.stopAgentRecording).toHaveBeenCalledWith(true);
      expect(output.actor.snapshot()?.status).toBe("cancelled");
      expect(await output.actor.resume()).toBe(false);
      expect(output.render().every(sample => sample === 0)).toBe(true);
      await output.actor.start("new", "fallback-tts");
      expect(output.actor.appendPcm16("new", pcm, 48_000)).toBe(true);
      expect(output.render().some(sample => sample !== 0)).toBe(true);
    } finally {
      await output.actor.close();
    }
  });

  it("disconnects audio nodes and releases media when voice capture is cleaned up", () => {
    const processor = { onaudioprocess: vi.fn(), disconnect: vi.fn() };
    const source = { disconnect: vi.fn() };
    const close = vi.fn(async () => undefined);
    const cleanupAgentMedia = vi.fn();
    const view = {
      clearVoiceWarmupTimer: vi.fn(),
      clearVoiceLocalEndpointTimer: vi.fn(),
      clearVoiceNoTranscriptTimer: vi.fn(),
      agentAudioProcessor: processor,
      agentAudioSource: source,
      agentAudioContext: { close },
      agentAudioWorklet: null,
      cleanupAgentMedia
    } as any;

    cleanupRealtimeAudio(view);

    expect(processor.onaudioprocess).toBeNull();
    expect(processor.disconnect).toHaveBeenCalledOnce();
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(cleanupAgentMedia).toHaveBeenCalledOnce();
    expect(view.agentAudioProcessor).toBeNull();
    expect(view.agentAudioSource).toBeNull();
    expect(view.agentAudioContext).toBeNull();
  });

  it("opens no socket before realtime voice disclosure is accepted", () => {
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      dataDisclosureAccepted: false,
      apiKey: "test-key"
    });

    expect(() => client.connect()).toThrow("尚未授权 voice Provider 数据发送");
    expect(websocketMock.instances).toHaveLength(0);
  });

  it("opens no socket before plaintext credential storage risk is accepted", () => {
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      plaintextCredentialStorageAccepted: false,
      apiKey: "test-key"
    });

    expect(() => client.connect()).toThrow("data.json");
    expect(websocketMock.instances).toHaveLength(0);
  });

  it("treats the runtime as authoritative when a legacy busy projection is stale", () => {
    const runtime = new VoiceSessionController({ provider: "qwen-test" });
    runtime.connect();
    runtime.connected();

    expect(hasActiveVoiceRuntimeTurn({
      agentVoiceRuntime: runtime,
      agentVoiceSendInFlight: true
    })).toBe(false);

    runtime.beginTurn({ route: "e2e", transcript: "你好" });
    expect(hasActiveVoiceRuntimeTurn({
      agentVoiceRuntime: runtime,
      agentVoiceSendInFlight: false
    })).toBe(true);

    runtime.interrupt("test cleanup");
    expect(hasActiveVoiceRuntimeTurn({
      agentVoiceRuntime: runtime,
      agentVoiceSendInFlight: true
    })).toBe(false);

    expect(hasActiveVoiceRuntimeTurn({
      agentVoiceSendInFlight: true
    })).toBe(true);
  });

  it("moves from audio energy to a finalized non-duplicate voice turn", () => {
    const input = Float32Array.from({ length: 4800 }, (_, index) => Math.sin(index / 8) * 0.05);
    const pcm = floatTo16kPcm(input, 48_000);
    const encoded = pcm16ToBase64(pcm);
    const decoded = base64ToPcm16(encoded);

    expect(audioRms(input)).toBeGreaterThan(0.01);
    expect(pcm.length).toBe(1600);
    expect(decoded.length).toBe(pcm.length);

    let session = createVoiceSession();
    session = transition(session, "warming", "integration voice start");
    session = transition(session, "listening", "integration listening");
    session = beginNewTurn(session, { turnId: "integration-turn-1" });
    session = appendTurnText(session, "今天还可以吧");

    const decision = decideLocalVoiceEndpoint({
      mode: "voice",
      recording: true,
      busy: false,
      text: session.turnText,
      visibleText: session.turnText,
      recentDuplicate: false,
      alreadySent: isAlreadySent(session, session.turnText),
      silenceMs: 2300
    });

    expect(decision).toEqual({ decision: "send", reason: "ready" });
    session = finalizeTurn(session, session.turnText);
    expect(isAlreadySent(session, "今天还可以吧")).toBe(true);
  });

  it("releases substantive content after repair control phrases and suppresses assistant echo", () => {
    const controlText = "喂，能听到我说话吗？我还没说完吧，后面我想说今天状态还可以";
    const controlEvent = detectVoiceControlEvent(controlText);

    expect(controlEvent?.kind).toBe("repair_keep_listening");
    expect(shouldHoldVoiceTurnForControl({
      text: controlText,
      heldSignature: controlEvent?.signature ?? "",
      nowMs: 1000,
      holdUntilMs: 5000
    })).toBe(false);
    expect(stripVoiceControlPhrases(controlText)).toBe("后面我想说今天状态还可以");

    addEchoText("我在，刚才我先不抢。你继续说，我听着。");
    expect(isEchoTranscript("你继续说我听着")).toBe(true);
    expect(isEchoTranscript("今天状态还可以")).toBe(false);
  });

  it("consumes a barge-in control phrase before gating the first follow-up question", () => {
    class VoiceView {}
    applyComposerPanel(VoiceView as any);
    const heldSignature = detectVoiceControlEvent("等一下")?.signature ?? "";
    const view = Object.assign(new VoiceView(), {
      controller: {
        settings: {
          realtimeVoice: {
            ...TEST_REALTIME_SETTINGS,
            triggerEnabled: false
          }
        }
      },
      voiceSession: createVoiceSession(),
      agentVoiceControlHoldSignature: heldSignature,
      agentVoiceControlHoldUntil: Date.now() + 8_000,
      agentVoiceSentTurnTexts: [],
      agentMessages: [],
      agentReply: "",
      knownVoiceTranscriptFragments: () => [],
      refreshAgentSurfaceState: vi.fn()
    }) as any;

    expect(view.prepareVoiceMessageForSend("等一下。现在只回答一加一等于几。"))
      .toBe("现在只回答一加一等于几");
    expect(view.agentVoiceControlHoldSignature).toBe(heldSignature);
    view.clearVoiceTurnBufferAfterSend();
    expect(view.agentVoiceControlHoldSignature).toBe("");
    expect(view.agentVoiceControlHoldUntil).toBe(0);

    view.agentVoiceControlHoldSignature = heldSignature;
    view.agentVoiceControlHoldUntil = Date.now() + 8_000;
    expect(view.prepareVoiceMessageForSend("等一下"))
      .toBeNull();
    expect(view.agentVoiceControlHoldSignature).toBe("");
    expect(view.agentVoiceControlHoldUntil).toBe(0);
    expect(view.agentInput).toBe("");
  });

  it("does not let macOS fallback speech interrupt its own active turn", () => {
    vi.useFakeTimers();
    class MockSpeechSynthesisUtterance {
      lang = "";
      rate = 1;
      pitch = 1;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(readonly text: string) {}
    }
    vi.stubGlobal("SpeechSynthesisUtterance", MockSpeechSynthesisUtterance);
    const speak = vi.fn((utterance: MockSpeechSynthesisUtterance) => utterance.onstart?.());
    Object.assign(window, {
      speechSynthesis: {
        speak,
        cancel: vi.fn(),
        speaking: true
      }
    });

    const runtime = new VoiceSessionController({ provider: "qwen-test" });
    runtime.connect();
    runtime.connected();
    runtime.beginTurn({ route: "brain", transcript: "读一下最后一篇日记" });
    runtime.transitionTurn("endpointing");
    runtime.transitionTurn("routing");
    runtime.transitionTurn("generating");
    runtime.updateAssistantText("我看看啊，最后一篇日记的内容比较长。");
    runtime.markModelDone();
    const suspect = vi.fn();
    const view = {
      controller: {
        settings: {
          realtimeVoice: {
            ...TEST_REALTIME_SETTINGS,
            speakReplies: true
          }
        }
      },
      agentVoiceRuntime: runtime,
      agentVoiceBargeIn: { suspect },
      agentVoiceSystemSpeechActive: false,
      agentVoiceFallbackTimer: 0,
      agentTtsClient: null,
      agentOmniPlaybackReady: null,
      agentOmniPendingAudio: [],
      agentSpeaking: false,
      agentVoiceTrace: {},
      markVoiceTrace: vi.fn(),
      transitionVoiceSession: vi.fn(),
      refreshAgentSurfaceState: vi.fn()
    } as any;

    startSystemSpeechForActiveTurn(
      view,
      "我看看啊，最后一篇日记的内容比较长。",
      "test fallback"
    );
    handleOmniE2eSpeechStarted(view);

    expect(speak).toHaveBeenCalledOnce();
    expect(view.agentVoiceSystemSpeechActive).toBe(true);
    expect(isEchoTranscript("我看看啊")).toBe(true);
    expect(suspect).not.toHaveBeenCalled();
  });

  it("maps realtime WebSocket VAD and transcript events into callbacks", async () => {
    const callbacks = {
      onOpen: vi.fn(),
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
      onTranscriptDelta: vi.fn(),
      onTranscriptDone: vi.fn(),
      onResponseCreated: vi.fn(),
      onResponseDone: vi.fn(),
      onAudioDelta: vi.fn(),
      onTransportError: vi.fn(),
      onError: vi.fn()
    };
    const settings = {
      ...TEST_REALTIME_SETTINGS,
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime",
      model: "qwen-test"
    };
    const client = new BailianRealtimeClient(settings, callbacks);

    const connected = client.connect();
    const socket = websocketMock.instances[0];
    expect(socket.url).toContain("model=qwen-test");
    expect(socket.options?.headers?.Authorization).toBe("Bearer test-key");

    socket.emit("open");
    await connected;

    const sessionUpdate = JSON.parse(socket.sent[0]) as {
      type: string;
      session: {
        input_audio_transcription: { language?: string };
        turn_detection: { type: string; silence_duration_ms: number };
      };
    };
    expect(callbacks.onOpen).toHaveBeenCalled();
    expect(sessionUpdate.type).toBe("session.update");
    expect(sessionUpdate.session.input_audio_transcription.language).toBe("zh");
    expect(sessionUpdate.session.turn_detection).toMatchObject({
      type: "server_vad",
      silence_duration_ms: 700
    });

    socket.emit("error", new Error("transport dropped"));
    expect(callbacks.onTransportError).toHaveBeenCalledWith("transport dropped");
    expect(callbacks.onError).not.toHaveBeenCalled();

    socket.emit("message", JSON.stringify({ type: "response.created", response: { id: "unsolicited-model" } }));
    socket.emit("message", JSON.stringify({ type: "response.audio.delta", response_id: "unsolicited-model", delta: "AQACAA==" }));
    socket.emit("message", JSON.stringify({ type: "response.done", response: { id: "unsolicited-model", status: "completed" } }));
    socket.emit("message", JSON.stringify({ type: "error", response_id: "unsolicited-model", error: { message: "虚构模型回合失败" } }));
    expect(callbacks.onResponseCreated).not.toHaveBeenCalled();
    expect(callbacks.onAudioDelta).not.toHaveBeenCalled();
    expect(callbacks.onResponseDone).not.toHaveBeenCalled();
    expect(callbacks.onTranscriptDelta).not.toHaveBeenCalled();
    socket.emit("message", JSON.stringify({
      type: "input_audio_buffer.speech_started",
      item_id: "normal-speech",
      audio_start_ms: 100
    }));
    socket.emit("message", JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "normal-speech",
      text: "今天"
    }));
    socket.emit("message", JSON.stringify({
      type: "input_audio_buffer.speech_stopped",
      item_id: "normal-speech",
      audio_end_ms: 1_000
    }));
    socket.emit("message", JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "normal-speech",
      transcript: "今天还可以"
    }));
    client.appendPcm16("AAAA");
    client.commit();

    expect(callbacks.onSpeechStarted).toHaveBeenCalledTimes(1);
    expect(callbacks.onSpeechStopped).toHaveBeenCalledTimes(1);
    expect(callbacks.onTranscriptDelta).toHaveBeenCalledWith("今天");
    expect(callbacks.onTranscriptDone).toHaveBeenCalledWith("今天还可以");
    expect(socket.sent.map((payload) => JSON.parse(payload).type)).toContain("input_audio_buffer.append");
    expect(socket.sent.map((payload) => JSON.parse(payload).type)).toContain("input_audio_buffer.commit");
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("ignores a short VAD item even when its transcript arrives after speech_stopped", async () => {
    const callbacks = {
      onSpeechStarted: vi.fn(),
      onSpeechStopped: vi.fn(),
      onSpeechRejected: vi.fn(),
      onTranscriptDelta: vi.fn(),
      onTranscriptDone: vi.fn()
    };
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      mode: "omni-e2e",
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime",
      model: "qwen-test"
    }, callbacks, { mode: "omni-e2e" });

    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;

    socket.emit("message", JSON.stringify({
      type: "input_audio_buffer.speech_started",
      item_id: "noise-item",
      audio_start_ms: 100
    }));
    socket.emit("message", JSON.stringify({
      type: "input_audio_buffer.speech_stopped",
      item_id: "noise-item",
      audio_end_ms: 320
    }));
    socket.emit("message", JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "noise-item",
      text: "嗯"
    }));
    socket.emit("message", JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "noise-item",
      transcript: "嗯"
    }));

    expect(callbacks.onSpeechStarted).toHaveBeenCalledOnce();
    expect(callbacks.onSpeechStopped).not.toHaveBeenCalled();
    expect(callbacks.onSpeechRejected).toHaveBeenCalledWith({
      itemId: "noise-item",
      durationMs: 220
    });
    expect(callbacks.onTranscriptDelta).not.toHaveBeenCalled();
    expect(callbacks.onTranscriptDone).not.toHaveBeenCalled();
    expect(socket.sent.map((payload) => JSON.parse(payload).type)).not.toContain("response.create");
  });

  it("starts Qwen-Omni E2E sessions with audio output and realtime tools", async () => {
    const callbacks = {
      onOpen: vi.fn(),
      onResponseCreated: vi.fn(),
      onResponseTextDelta: vi.fn(),
      onAudioDelta: vi.fn(),
      onResponseAudioDone: vi.fn(),
      onResponseDone: vi.fn(),
      onToolCall: vi.fn(async () => "已模拟创建任务：整理会议纪要。"),
      onError: vi.fn()
    };
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      mode: "omni-e2e",
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime",
      model: "qwen-test",
      omniVoice: "Tina"
    }, callbacks, {
      mode: "omni-e2e",
      instructions: "你是 Cici。",
      tools: [{
        type: "function",
        name: "create_task",
        description: "Create task",
        parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }
      }]
    });

    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;

    const sessionUpdate = JSON.parse(socket.sent[0]) as {
      type: string;
      session: {
        modalities: string[];
        turn_detection: { type: string; threshold: number; silence_duration_ms: number };
        input_audio_transcription: { model: string; language: string };
        output_audio_format: string;
        voice: string;
        tools: unknown[];
      };
    };
    expect(sessionUpdate.type).toBe("session.update");
    expect(sessionUpdate.session.modalities).toEqual(["text", "audio"]);
    expect(sessionUpdate.session.turn_detection).toEqual({
      type: "semantic_vad",
      threshold: 0.8,
      silence_duration_ms: 1500,
      create_response: false,
      interrupt_response: false
    });
    expect(sessionUpdate.session.input_audio_transcription).toEqual({
      model: "qwen3-asr-flash-realtime",
      language: "zh"
    });
    expect(sessionUpdate.session.output_audio_format).toBe("pcm16");
    expect(sessionUpdate.session.voice).toBe("Tina");
    expect(sessionUpdate.session.tools).toHaveLength(1);

    client.appendPcm16("AAAA");
    client.appendAssistantMessage("本地检索已经回答。");
    client.createResponse();
    expect(socket.sent.map((payload) => JSON.parse(payload).type)).not.toContain("input_audio_buffer.commit");
    expect(socket.sent.map((payload) => JSON.parse(payload).type)).toContain("response.create");
    const localAssistantMessage = socket.sent
      .map((payload) => JSON.parse(payload))
      .find((payload) => payload.type === "conversation.item.create" && payload.item?.role === "assistant");
    expect(localAssistantMessage?.item.content).toEqual([{
      type: "text",
      text: "本地检索已经回答。"
    }]);

    socket.emit("message", JSON.stringify({ type: "response.created", response: { id: "response-tool" } }));
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: "response-tool",
      call_id: "call_1",
      name: "create_task",
      arguments: JSON.stringify({ title: "整理会议纪要" })
    }));
    await Promise.resolve();
    await Promise.resolve();
    socket.emit("message", JSON.stringify({
      type: "response.output_item.done",
      response_id: "response-tool",
      item: {
        id: "call_1",
        type: "function_call",
        name: "create_task",
        arguments: JSON.stringify({ title: "整理会议纪要" })
      }
    }));
    await Promise.resolve();
    socket.emit("message", JSON.stringify({ type: "response.done", response: { id: "response-tool" } }));
    socket.emit("message", JSON.stringify({ type: "response.created", response: { id: "response-final" } }));
    socket.emit("message", JSON.stringify({ type: "response.text.delta", response_id: "response-final", delta: "好的" }));
    socket.emit("message", JSON.stringify({ type: "response.audio.delta", response_id: "response-final", delta: "base64-audio" }));
    socket.emit("message", JSON.stringify({ type: "response.audio.done", response_id: "response-final" }));
    socket.emit("message", JSON.stringify({
      type: "response.done",
      response: { id: "response-final", status: "completed" }
    }));

    expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith({
      eventType: "response.created",
      responseId: "response-final",
      status: "",
      toolContinuation: { previousResponseId: "response-tool", callIds: ["call_1"] }
    });
    expect(callbacks.onResponseTextDelta).toHaveBeenCalledWith("好的", {
      eventType: "response.text.delta",
      responseId: "response-final",
      status: ""
    });
    expect(callbacks.onAudioDelta).toHaveBeenCalledWith("base64-audio", 24000, {
      eventType: "response.audio.delta",
      responseId: "response-final",
      status: ""
    });
    expect(callbacks.onResponseAudioDone).toHaveBeenCalledWith({
      eventType: "response.audio.done",
      responseId: "response-final",
      status: ""
    });
    expect(callbacks.onToolCall).toHaveBeenCalledWith({
      id: "call_1",
      name: "create_task",
      arguments: { title: "整理会议纪要" }
    });
    expect(callbacks.onToolCall).toHaveBeenCalledTimes(1);
    const functionOutput = socket.sent.map((payload) => JSON.parse(payload)).find((payload) => (
      payload.type === "conversation.item.create" && payload.item?.type === "function_call_output"
    ));
    expect(functionOutput?.item.call_id).toBe("call_1");
    expect(functionOutput?.item.output).toContain("已模拟创建任务");
    expect(socket.sent.map((payload) => JSON.parse(payload).type).filter((type) => type === "response.create")).toHaveLength(2);
    expect(callbacks.onResponseDone).toHaveBeenCalledWith("好的", {
      eventType: "response.done",
      responseId: "response-final",
      status: "completed"
    });
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it.each(["tool-first", "done-first"])("hands off completed tools through the production response bridge: %s", async (order) => {
    const runtime = new VoiceSessionController();
    runtime.connect();
    runtime.connected();
    const original = runtime.beginTurn({ route: "e2e", transcript: "查看昨晚日记" });
    runtime.transitionTurn("routing");
    runtime.transitionTurn("generating");
    const view = {
      controller: { settings: { realtimeVoice: { ...TEST_REALTIME_SETTINGS, mode: "omni-e2e" } } },
      agentVoiceRuntime: runtime
    } as any;
    const resolvers = new Map<string, (value: string) => void>();
    const callbacks = {
      onToolCall: vi.fn((call: { id?: string }) => new Promise<string>((resolve) => resolvers.set(call.id!, resolve))),
      onResponseCreated: vi.fn((event) => handleOmniE2eResponseCreated(view, event)),
      onResponseTextDelta: vi.fn(), onAudioDelta: vi.fn(), onResponseFailed: vi.fn(), onError: vi.fn()
    };
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS, mode: "omni-e2e", apiKey: "test-key", endpoint: "wss://example.test/realtime"
    }, callbacks);
    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;
    client.createResponse();
    socket.emit("message", JSON.stringify({ type: "response.created", response: { id: "tool-source" } }));
    for (const id of ["query-1", "query-2"]) socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done", response_id: "tool-source",
      call_id: id, name: "query_vault", arguments: "{}"
    }));
    const finishSource = () => socket.emit("message", JSON.stringify({
      type: "response.done", response: { id: "tool-source", status: "completed" }
    }));
    if (order === "done-first") finishSource();
    resolvers.get("query-1")!("昨晚日记");
    await Promise.resolve();
    expect(socket.sent.map((value) => JSON.parse(value).type).filter((type) => type === "response.create")).toHaveLength(1);
    resolvers.get("query-2")!("相关条目");
    await Promise.resolve();
    if (order === "tool-first") finishSource();
    expect(socket.sent.map((value) => JSON.parse(value).type).filter((type) => type === "response.create")).toHaveLength(2);

    socket.emit("message", JSON.stringify({ type: "response.text.delta", response_id: "tool-source", delta: "迟到旧文字" }));
    socket.emit("message", JSON.stringify({ type: "response.created", response: { id: "tool-answer" } }));
    expect(runtime.snapshot().currentTurn).toMatchObject({
      turnId: original.turnId, generation: original.generation, responseId: "tool-answer", phase: "generating"
    });
    expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith({
      eventType: "response.created", responseId: "tool-answer", status: "",
      toolContinuation: { previousResponseId: "tool-source", callIds: ["query-1", "query-2"] }
    });
    socket.emit("message", JSON.stringify({ type: "response.audio.delta", response_id: "tool-source", delta: "old-audio" }));
    socket.emit("message", JSON.stringify({ type: "response.failed", response_id: "tool-source", error: { message: "old failure" } }));
    finishSource();
    socket.emit("message", JSON.stringify({ type: "response.text.delta", response_id: "tool-answer", delta: "昨晚记录如下" }));
    socket.emit("message", JSON.stringify({ type: "response.audio.delta", response_id: "tool-answer", delta: "new-audio" }));
    expect(callbacks.onResponseTextDelta).toHaveBeenCalledOnce();
    expect(callbacks.onAudioDelta).toHaveBeenCalledOnce();
    expect(callbacks.onResponseFailed).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(runtime.snapshot().currentTurn?.responseId).toBe("tool-answer");
    clearTimeout(view.agentVoiceResponseTimer);
    client.close();
  });

  it("revokes a pending tool response handoff when stopped", async () => {
    const runtime = new VoiceSessionController();
    runtime.connect(); runtime.connected(); runtime.beginTurn({ route: "e2e" });
    runtime.transitionTurn("routing"); runtime.transitionTurn("generating");
    const view = { controller: { settings: { realtimeVoice: { ...TEST_REALTIME_SETTINGS, mode: "omni-e2e" } } }, agentVoiceRuntime: runtime } as any;
    const onCreated = vi.fn((event) => handleOmniE2eResponseCreated(view, event));
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS, mode: "omni-e2e", apiKey: "test-key", endpoint: "wss://example.test/realtime"
    }, { onResponseCreated: onCreated, onToolCall: async () => "查询结果" });
    const connected = client.connect(); const socket = websocketMock.instances[0]; socket.emit("open"); await connected;
    client.createResponse();
    socket.emit("message", JSON.stringify({ type: "response.created", response: { id: "tool-source" } }));
    socket.emit("message", JSON.stringify({ type: "response.function_call_arguments.done", response_id: "tool-source", call_id: "query", name: "query_vault", arguments: "{}" }));
    socket.emit("message", JSON.stringify({ type: "response.done", response: { id: "tool-source" } }));
    await Promise.resolve();
    runtime.interrupt(); client.cancelResponse();
    // A late duplicate source.done must not settle cancellation of the successor request.
    socket.emit("message", JSON.stringify({ type: "response.done", response: { id: "tool-source" } }));
    socket.emit("message", JSON.stringify({ type: "response.created", response: { id: "late-tool-answer" } }));
    expect(onCreated).toHaveBeenCalledOnce();
    expect(runtime.snapshot().currentTurn).toMatchObject({ responseId: "tool-source", phase: "interrupted" });
    clearTimeout(view.agentVoiceResponseTimer); client.close();
  });

  it("does not let unrelated responses rebind the production runtime", () => {
    const runtime = new VoiceSessionController();
    runtime.connect(); runtime.connected(); runtime.beginTurn({ route: "e2e" });
    runtime.transitionTurn("routing"); runtime.transitionTurn("generating");
    const view = { controller: { settings: { realtimeVoice: { ...TEST_REALTIME_SETTINGS, mode: "omni-e2e" } } }, agentVoiceRuntime: runtime } as any;
    handleOmniE2eResponseCreated(view, { eventType: "response.created", responseId: "first", status: "" });
    handleOmniE2eResponseCreated(view, { eventType: "response.created", responseId: "unrelated", status: "" });
    expect(runtime.snapshot().currentTurn).toMatchObject({ responseId: "first", phase: "failed" });
    clearTimeout(view.agentVoiceResponseTimer);
  });

  it("isolates cancelled response events from the next Omni response", async () => {
    const callbacks = {
      onResponseTextDelta: vi.fn(),
      onAudioDelta: vi.fn(),
      onResponseDone: vi.fn()
    };
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      mode: "omni-e2e",
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime",
      model: "qwen-test"
    }, callbacks, { mode: "omni-e2e" });

    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;

    client.createResponse();
    socket.emit("message", JSON.stringify({ type: "response.created", response: { id: "old-response" } }));
    socket.emit("message", JSON.stringify({
      type: "response.text.delta",
      response_id: "old-response",
      delta: "旧回答"
    }));

    client.cancelResponse();
    client.createResponse();
    socket.emit("message", JSON.stringify({
      type: "response.audio.delta",
      response_id: "old-response",
      delta: "late-old-audio"
    }));
    socket.emit("message", JSON.stringify({ type: "response.done", response: { id: "old-response" } }));

    socket.emit("message", JSON.stringify({ type: "response.created", response: { id: "new-response" } }));
    socket.emit("message", JSON.stringify({
      type: "response.text.delta",
      response_id: "new-response",
      delta: "新回答"
    }));
    socket.emit("message", JSON.stringify({
      type: "response.audio.delta",
      response_id: "new-response",
      delta: "new-audio"
    }));
    socket.emit("message", JSON.stringify({ type: "response.done", response: { id: "new-response" } }));

    expect(socket.sent.map((payload) => JSON.parse(payload).type).filter((type) => type === "response.create")).toHaveLength(2);
    expect(callbacks.onAudioDelta).toHaveBeenCalledTimes(1);
    expect(callbacks.onAudioDelta).toHaveBeenCalledWith("new-audio", 24000, {
      eventType: "response.audio.delta",
      responseId: "new-response",
      status: ""
    });
    expect(callbacks.onResponseDone).toHaveBeenCalledTimes(1);
    expect(callbacks.onResponseDone).toHaveBeenCalledWith("新回答", {
      eventType: "response.done",
      responseId: "new-response",
      status: ""
    });
  });

  it.each([
    ["cancel-pending", "resolve"], ["cancel-pending", "reject"],
    ["cancelled", "resolve"], ["cancelled", "reject"],
    ["tool-response-completed", "resolve"], ["tool-response-completed", "reject"],
    ["close", "resolve"], ["close", "reject"],
    ["reconnect", "resolve"], ["reconnect", "reject"],
    ["failed", "resolve"], ["failed", "reject"]
  ])("ignores late tool %s / %s after its response is invalidated", async (boundary, outcome) => {
    let resolveTool!: (value: string) => void;
    let rejectTool!: (error: Error) => void;
    const callbacks = {
      onToolCall: vi.fn(() => new Promise<string>((resolve, reject) => {
        resolveTool = resolve;
        rejectTool = reject;
      })),
      onResponseFailed: vi.fn(),
      onError: vi.fn()
    };
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      mode: "omni-e2e",
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime"
    }, callbacks);
    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;
    client.createResponse();
    socket.emit("message", JSON.stringify({ type: "response.created", response: { id: "old-tool-response" } }));
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done",
      response_id: "old-tool-response",
      call_id: "late-query",
      name: "query_vault",
      arguments: JSON.stringify({ domain: "journal", operation: "get", date: "昨天", period: "晚" })
    }));
    expect(callbacks.onToolCall).toHaveBeenCalledOnce();

    if (boundary === "close" || boundary === "reconnect") {
      client.close();
      if (boundary === "reconnect") {
        const reconnected = client.connect();
        websocketMock.instances[1].emit("open");
        await reconnected;
        client.createResponse();
        expect(websocketMock.instances[1].sent.map((value) => JSON.parse(value).type)).toContain("response.create");
      }
    } else if (boundary === "failed") {
      socket.emit("message", JSON.stringify({
        type: "response.done", response: { id: "old-tool-response", status: "failed" }
      }));
      client.createResponse();
    } else {
      if (boundary === "tool-response-completed") {
        socket.emit("message", JSON.stringify({ type: "response.done", response: { id: "old-tool-response" } }));
      }
      client.cancelResponse();
      if (boundary === "cancelled") {
        socket.emit("message", JSON.stringify({ type: "response.done", response: { id: "old-tool-response" } }));
        client.createResponse();
        socket.emit("message", JSON.stringify({ type: "response.created", response: { id: "new-response" } }));
      }
    }
    const sentBefore = websocketMock.instances.map((instance) => [...instance.sent]);
    if (outcome === "resolve") resolveTool("旧查询结果");
    else rejectTool(new Error("旧查询失败"));
    await Promise.resolve();
    await Promise.resolve();

    expect(websocketMock.instances.map((instance) => instance.sent)).toEqual(sentBefore);
    expect(callbacks.onError).not.toHaveBeenCalled();
    client.close();
  });

  it("discards a queued tool continuation when the user cancels", async () => {
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      mode: "omni-e2e",
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime"
    }, { onToolCall: async () => "查询完成" });
    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;
    client.createResponse();
    socket.emit("message", JSON.stringify({ type: "response.created", response: { id: "queued-tool-response" } }));
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done", response_id: "queued-tool-response",
      call_id: "query", name: "query_vault", arguments: "{}"
    }));
    await Promise.resolve();
    client.cancelResponse();
    socket.emit("message", JSON.stringify({ type: "response.done", response: { id: "queued-tool-response" } }));
    expect(socket.sent.map((value) => JSON.parse(value).type).filter((type) => type === "response.create")).toHaveLength(1);
    client.close();
  });

  it.each(["{", "[]", "null", ""])("does not execute an Omni undo on malformed arguments (%j)", async args => {
    const onToolCall = vi.fn(async () => "不应该调用");
    const client = new BailianRealtimeClient({ ...TEST_REALTIME_SETTINGS, mode: "omni-e2e", apiKey: "test-key" }, { onToolCall });
    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;
    client.createResponse();
    socket.emit("message", JSON.stringify({ type: "response.created", response: { id: "bad-args" } }));
    socket.emit("message", JSON.stringify({ type: "response.function_call_arguments.done", response_id: "bad-args",
      call_id: "undo-bad", name: "undo_latest_operation", arguments: args }));
    expect(onToolCall).not.toHaveBeenCalled();
    const output = socket.sent.map(value => JSON.parse(value)).find(value => value.item?.type === "function_call_output");
    expect(output?.item).toMatchObject({ call_id: "undo-bad", output: expect.stringContaining("未执行操作") });
    client.close();
  });

  it("ignores messages from a retired socket after reconnecting", async () => {
    const callbacks = { onToolCall: vi.fn(), onResponseTextDelta: vi.fn(), onDisconnected: vi.fn(), onTransportError: vi.fn() };
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      mode: "omni-e2e",
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime"
    }, callbacks);
    const connected = client.connect();
    const oldSocket = websocketMock.instances[0];
    oldSocket.emit("open");
    await connected;
    client.close();
    const reconnected = client.connect();
    websocketMock.instances[1].emit("open");
    await reconnected;
    oldSocket.emit("message", JSON.stringify({ type: "response.text.delta", delta: "旧连接迟到内容" }));
    oldSocket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done", call_id: "old-call", name: "query_vault", arguments: "{}"
    }));
    oldSocket.emit("error", new Error("旧连接错误"));
    oldSocket.emit("close", 1000, Buffer.from("旧连接关闭"));
    expect(callbacks.onResponseTextDelta).not.toHaveBeenCalled();
    expect(callbacks.onToolCall).not.toHaveBeenCalled();
    expect(callbacks.onDisconnected).not.toHaveBeenCalled();
    expect(callbacks.onTransportError).not.toHaveBeenCalled();
    client.close();
  });

  it("continues an uncancelled tool that resolves after response.done", async () => {
    let resolveTool!: (value: string) => void;
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      mode: "omni-e2e",
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime"
    }, { onToolCall: () => new Promise<string>((resolve) => { resolveTool = resolve; }) });
    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;
    client.createResponse();
    socket.emit("message", JSON.stringify({ type: "response.created", response: { id: "slow-query-response" } }));
    socket.emit("message", JSON.stringify({
      type: "response.function_call_arguments.done", response_id: "slow-query-response",
      call_id: "slow-query", name: "query_vault", arguments: "{}"
    }));
    socket.emit("message", JSON.stringify({ type: "response.done", response: { id: "slow-query-response" } }));
    resolveTool("没有昨天晚间日记");
    await Promise.resolve();
    const sent = socket.sent.map((value) => JSON.parse(value));
    expect(sent.filter((payload) => payload.type === "response.create")).toHaveLength(2);
    expect(sent.find((payload) => payload.item?.type === "function_call_output")?.item.output).toBe("没有昨天晚间日记");
    client.close();
  });

  it.each(["cancel", "reconnect"])("does not revive an obsolete model retry after %s", async (boundary) => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      mode: "omni-e2e",
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime"
    });
    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;
    socket.emit("message", JSON.stringify({ type: "error", error: { message: "ModelServingError: overloaded" } }));
    if (boundary === "cancel") client.cancelResponse();
    else {
      client.close();
      const reconnected = client.connect();
      websocketMock.instances[1].emit("open");
      await reconnected;
    }
    const sentBefore = websocketMock.instances.map((instance) => [...instance.sent]);
    await vi.advanceTimersByTimeAsync(500);
    expect(websocketMock.instances.map((instance) => instance.sent)).toEqual(sentBefore);
    client.close();
  });

  it("releases a failed Omni response so the next turn can start", async () => {
    const callbacks = {
      onResponseFailed: vi.fn(),
      onResponseDone: vi.fn(),
      onError: vi.fn()
    };
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      mode: "omni-e2e",
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime",
      model: "qwen-test"
    }, callbacks, { mode: "omni-e2e" });

    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;

    client.createResponse();
    socket.emit("message", JSON.stringify({
      type: "response.created",
      response: { id: "failed-response" }
    }));
    socket.emit("message", JSON.stringify({
      type: "response.done",
      response: {
        id: "failed-response",
        status: "failed",
        status_details: {
          error: { message: "upstream generation failed" }
        }
      }
    }));

    expect(callbacks.onResponseFailed).toHaveBeenCalledWith("upstream generation failed", {
      eventType: "response.done",
      responseId: "failed-response",
      status: "failed"
    });
    expect(callbacks.onResponseDone).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();

    client.createResponse();
    expect(socket.sent.map((payload) => JSON.parse(payload).type).filter((type) => (
      type === "response.create"
    ))).toHaveLength(2);
  });

  it("retries Qwen-Omni model serving errors with exponential backoff and logs each retry", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
      btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    });
    const callbacks = {
      onModelRetry: vi.fn(),
      onError: vi.fn()
    };
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      mode: "omni-e2e",
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime",
      model: "qwen-test"
    }, callbacks, { mode: "omni-e2e" });

    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;
    client.createResponse();

    const expectedDelays = [500, 1_000, 2_000, 4_000, 8_000];
    for (const delayMs of expectedDelays) {
      socket.emit("message", JSON.stringify({
        type: "error",
        error: { message: "ModelServingError: overloaded" }
      }));
      await vi.advanceTimersByTimeAsync(delayMs);
    }

    expect(callbacks.onModelRetry).toHaveBeenCalledTimes(5);
    expect(callbacks.onModelRetry.mock.calls.map(([retry]) => retry.delayMs)).toEqual(expectedDelays);
    expect(socket.sent.map((payload) => JSON.parse(payload).type).filter((type) => type === "response.create")).toHaveLength(6);

    socket.emit("message", JSON.stringify({
      type: "error",
      error: { message: "ModelServingError: overloaded" }
    }));
    expect(callbacks.onError).toHaveBeenCalledWith("ModelServingError: overloaded");
  });

  it("settles a cancelled Omni turn immediately so an interruption can be sent", () => {
    const cancelResponse = vi.fn();
    const setAgentBusy = vi.fn();
    const transitionVoiceSession = vi.fn();
    const refreshAgentSurfaceState = vi.fn();
    const invalidateVoicePipeline = vi.fn();
    const view = {
      controller: { settings: { realtimeVoice: { ...TEST_REALTIME_SETTINGS, mode: "omni-e2e" } } },
      agentVoiceSendInFlight: true,
      agentRealtimeClient: { cancelResponse },
      agentOmniE2eAssistantIndex: 1,
      agentOmniE2eReply: "旧回答的一部分",
      agentOmniE2eStreamMessageEl: null,
      agentMessages: [
        { role: "user", content: "旧问题" },
        { role: "assistant", content: "" }
      ],
      invalidateVoicePipeline,
      setAgentBusy,
      transitionVoiceSession,
      refreshAgentSurfaceState,
      setAgentMessageBubbleContent: vi.fn()
    } as any;

    expect(interruptOmniE2eVoiceTurn(view, "user barge-in")).toBe(true);
    expect(cancelResponse).toHaveBeenCalledOnce();
    expect(invalidateVoicePipeline).toHaveBeenCalledWith("user barge-in");
    expect(view.agentVoiceSendInFlight).toBe(false);
    expect(view.agentOmniE2eAssistantIndex).toBe(-1);
    expect(view.agentMessages[1].content).toBe("旧回答的一部分");
    expect(setAgentBusy).toHaveBeenCalledWith(false);
    expect(transitionVoiceSession).toHaveBeenCalledWith("listening", "user barge-in");
  });

  it("cancels the active Omni response once and clears queued playback on barge-in", () => {
    class VoiceView {}
    applyComposerPanel(VoiceView as any);
    const stop = vi.fn();
    const disconnect = vi.fn();
    const cancelResponse = vi.fn();
    const view = Object.assign(new VoiceView(), {
      controller: { settings: { realtimeVoice: { ...TEST_REALTIME_SETTINGS, mode: "omni-e2e" } } },
      agentVoiceSendInFlight: true,
      agentRealtimeClient: { cancelResponse },
      agentOmniE2eAssistantIndex: 1,
      agentOmniE2eReply: "旧回答",
      agentOmniE2eStreamMessageEl: null,
      agentMessages: [
        { role: "user", content: "旧问题" },
        { role: "assistant", content: "" }
      ],
      agentSpeechPlaybackId: 0,
      agentSpeaking: true,
      agentTtsClient: null,
      agentSpeechSources: new Set([{ stop, disconnect }]),
      agentSpeechAudioContext: null,
      agentSpeechAudioCursor: 0,
      invalidateVoicePipeline: vi.fn(),
      setAgentBusy: vi.fn(),
      transitionVoiceSession: vi.fn(),
      refreshAgentSurfaceState: vi.fn(),
      setAgentMessageBubbleContent: vi.fn(),
      appendVoiceMetric: vi.fn()
    }) as any;

    view.interruptAgentSpeech();

    expect(cancelResponse).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(view.agentSpeechSources.size).toBe(0);
    expect(view.agentSpeaking).toBe(false);
  });

  it("does not send an empty Omni request when VAD has no usable transcript", async () => {
    const createResponse = vi.fn();
    const discardCurrentVoiceTurn = vi.fn();
    const view = {
      controller: { settings: { realtimeVoice: { ...TEST_REALTIME_SETTINGS, mode: "omni-e2e", triggerEnabled: false } } },
      agentVoiceSendInFlight: false,
      agentBusy: false,
      currentVoiceMessageText: () => "",
      discardCurrentVoiceTurn,
      agentRealtimeClient: { createResponse },
      setAgentInput: vi.fn(),
      voiceDisplayInput: (text: string) => text,
      prepareVoiceMessageForSend: (text: string) => text,
      tryAcceptPendingActionFromVoice: vi.fn(),
      queueCurrentVoiceInput: vi.fn(),
      clearVoiceAutoSendTimer: vi.fn(),
      beginVoiceProcessingTrace: vi.fn(),
      markVoiceTrace: vi.fn(),
      rememberSentVoiceTurn: vi.fn(),
      clearVoiceTurnBufferAfterSend: vi.fn(),
      setAgentBusy: vi.fn(),
      transitionVoiceSession: vi.fn(),
      appendAgentMessage: vi.fn(),
      refreshAgentSurfaceState: vi.fn(),
      voiceSession: createVoiceSession(),
      agentVoiceQueuedAfterBusy: false,
      agentVoicePipelineGeneration: 0,
      agentMessages: [],
      agentOmniE2eAssistantIndex: -1,
      agentOmniE2eReply: "",
      agentOmniE2eActionSuggestions: 0,
      agentOmniE2eUserMessage: "",
      agentOmniE2eStreamMessageEl: null
    } as any;

    await sendOmniE2eVoiceTurn(view, "empty transcript test");

    expect(createResponse).not.toHaveBeenCalled();
    expect(discardCurrentVoiceTurn).toHaveBeenCalledWith("我没有收到有效的语音文字，所以不会发送空请求。请再说一遍。");
    expect(view.agentMessages).toEqual([]);

    view.currentVoiceMessageText = () => "嗯嗯";
    await sendOmniE2eVoiceTurn(view, "backchannel test");
    expect(createResponse).not.toHaveBeenCalled();
    expect(discardCurrentVoiceTurn).toHaveBeenCalledWith("已忽略没有实际问题的短声音。");
  });

  it.each([false, true])("keeps an Omni turn busy until playback is drained (native output failure %s)", async nativeFailure => {
    const runtime = new VoiceSessionController({ provider: "qwen-test" });
    runtime.connect();
    runtime.connected();
    const createResponse = vi.fn();
    const output = {
      start: vi.fn(async () => undefined),
      appendPcm16: vi.fn(() => true),
      appendCue: vi.fn(() => true),
      finish: vi.fn(() => true),
      cancel: vi.fn(() => true),
      fail: vi.fn(() => true)
    };
    let currentText = "你好";
    const view = {
      controller: {
        settings: {
          realtimeVoice: {
            ...TEST_REALTIME_SETTINGS,
            mode: "omni-e2e",
            ...(nativeFailure ? { ttsEngine: "breeze-local" } : {}),
            triggerEnabled: false,
            speakReplies: true
          }
        },
        appendAgentConversation: vi.fn(async () => undefined)
      },
      agentVoiceRuntime: runtime,
      agentAudioOutput: output,
      agentOmniPlaybackReady: null,
      agentOmniPendingAudio: [],
      agentVoiceSendInFlight: false,
      agentBusy: false,
      agentRecording: true,
      agentSpeaking: false,
      agentRealtimeClient: {
        createResponse,
        cancelResponse: vi.fn()
      },
      currentVoiceMessageText: () => currentText,
      voiceDisplayInput: (text: string) => text,
      prepareVoiceMessageForSend: (text: string) => text,
      setAgentInput: vi.fn(),
      tryAcceptPendingActionFromVoice: vi.fn(async () => false),
      queueCurrentVoiceInput: vi.fn(),
      discardCurrentVoiceTurn: vi.fn(),
      clearVoiceAutoSendTimer: vi.fn(),
      beginVoiceProcessingTrace: vi.fn(),
      markVoiceTrace: vi.fn(),
      rememberSentVoiceTurn: vi.fn(),
      clearVoiceTurnBufferAfterSend: vi.fn(() => {
        currentText = "";
      }),
      setAgentBusy: vi.fn((busy: boolean) => {
        view.agentBusy = busy;
      }),
      transitionVoiceSession: vi.fn(),
      appendAgentMessage: vi.fn(() => ({})),
      refreshAgentSurfaceState: vi.fn(),
      setAgentMessageBubbleContent: vi.fn(),
      scrollAgentTranscriptToBottom: vi.fn(),
      appendAgentQualityLog: vi.fn(async () => undefined),
      refreshAgentSuggestions: vi.fn(),
      consumeQueuedVoiceInput: vi.fn(async () => undefined),
      resetCurrentVoiceTurnDraft: vi.fn(),
      scheduleVoiceAutoSend: vi.fn(),
      voiceSession: createVoiceSession(),
      pendingAgentActions: [],
      agentVoiceQueuedAfterBusy: false,
      agentVoicePipelineGeneration: 0,
      agentVoiceIgnoreSpeechStartUntil: 0,
      agentMessages: [],
      agentOmniE2eAssistantIndex: -1,
      agentOmniE2eReply: "",
      agentOmniE2eActionSuggestions: 0,
      agentOmniE2eUserMessage: "",
      agentOmniE2eStreamMessageEl: null,
      agentVoiceTrace: {},
      agentSpeechSources: new Set()
    } as any;

    await sendOmniE2eVoiceTurn(view, "test endpoint");
    expect(createResponse).toHaveBeenCalledOnce();
    expect(runtime.snapshot().currentTurn?.phase).toBe("generating");

    const created = {
      eventType: "response.created",
      responseId: "response-a",
      status: ""
    };
    handleOmniE2eResponseCreated(view, created);
    const audioEvent = {
      eventType: "response.audio.delta",
      responseId: "response-a",
      status: ""
    };
    const pcmBase64 = Buffer.from(new Int16Array([1000, -1000]).buffer).toString("base64");
    handleOmniE2eAudioDelta(view, pcmBase64, 24_000, audioEvent);
    await Promise.resolve();
    await Promise.resolve();
    expect(output.appendPcm16).toHaveBeenCalledOnce();

    const playbackId = runtime.snapshot().currentTurn?.playbackId ?? "";
    if (nativeFailure) {
      handleOmniE2eAudioOutputEvent(view, {
        type: "failed", owner: "native-e2e", playbackId, timestamp: Date.now(), errorCode: "synthetic_failure"
      });
      handleOmniE2eAudioDelta(view, pcmBase64, 24_000, audioEvent);
      await Promise.resolve();
      await Promise.resolve();
      expect(output.appendPcm16).toHaveBeenCalledOnce();
      expect(runtime.snapshot().currentTurn?.outputOwner).toBe("none");
    }
    handleOmniE2eAudioDone(view, {
      eventType: "response.audio.done",
      responseId: "response-a",
      status: ""
    });
    if (nativeFailure) expect(output.finish).not.toHaveBeenCalled();
    const localSpeak = vi.fn(async (_text: string, emit: (pcm: string) => void) => emit(pcmBase64));
    const local = nativeFailure ? vi.spyOn(breezeSpeech, "sessionBreeze")
      .mockReturnValue({ speak: localSpeak } as unknown as BreezeResidentWorker) : undefined;
    await finishOmniE2eVoiceTurn(view, "你好，我在。", {
      eventType: "response.done",
      responseId: "response-a",
      status: "completed"
    });
    const owner = nativeFailure ? "fallback-tts" : "native-e2e";
    if (nativeFailure) {
      expect(localSpeak).toHaveBeenCalledExactlyOnceWith("你好，我在。", expect.any(Function), expect.any(AbortSignal));
      expect(output.start.mock.calls).toEqual([[playbackId, "native-e2e"], [playbackId, "fallback-tts"]]);
      handleOmniE2eAudioDelta(view, pcmBase64, 24_000, audioEvent);
      await vi.waitFor(() => expect(output.finish).toHaveBeenCalledOnce());
      expect(output.appendPcm16).toHaveBeenCalledTimes(2);
      local?.mockRestore();
    }

    expect(view.agentVoiceSendInFlight).toBe(true);
    expect(view.agentBusy).toBe(true);
    expect(runtime.snapshot().currentTurn).toMatchObject({
      modelDone: true,
      playbackDrained: false
    });

    handleOmniE2eAudioOutputEvent(view, {
      type: "started",
      playbackId,
      owner,
      timestamp: 1
    });
    handleOmniE2eAudioOutputEvent(view, {
      type: "drained",
      playbackId,
      owner,
      timestamp: 2
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.snapshot().currentTurn?.phase).toBe("completed");
    expect(view.agentVoiceSendInFlight).toBe(false);
    expect(view.agentBusy).toBe(false);

    currentText = "再说一句";
    view.agentVoiceSendInFlight = true;
    view.agentBusy = true;
    await sendOmniE2eVoiceTurn(view, "stale projection recovery");

    expect(createResponse).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot().currentTurn).toMatchObject({
      phase: "generating",
      transcript: "再说一句"
    });
    window.clearTimeout(view.agentVoiceResponseTimer);
  });

  it("completes a new turn after interrupting a long native voice reply", async () => {
    const runtime = new VoiceSessionController({ provider: "qwen-test" });
    runtime.connect();
    runtime.connected();
    const createResponse = vi.fn();
    const cancelResponse = vi.fn();
    const output = {
      start: vi.fn(async () => undefined),
      appendPcm16: vi.fn(() => true),
      finish: vi.fn(() => true),
      cancel: vi.fn(() => true),
      fail: vi.fn(() => true),
      duck: vi.fn(() => true),
      restore: vi.fn(() => true)
    };
    let currentText = "";
    let view: any;
    const bargeIn = new VoiceBargeInController({
      onEvent: (event) => handleOmniE2eBargeInEvent(view, event)
    });
    view = {
      controller: {
        settings: {
          realtimeVoice: {
            ...TEST_REALTIME_SETTINGS,
            mode: "omni-e2e",
            triggerEnabled: false,
            speakReplies: true
          }
        },
        appendAgentConversation: vi.fn(async () => undefined)
      },
      agentVoiceRuntime: runtime,
      agentVoiceCircuitBreaker: {
        allowPrimary: vi.fn(() => true),
        recordSuccess: vi.fn(),
        recordFailure: vi.fn()
      },
      agentVoiceBargeIn: bargeIn,
      agentAudioOutput: output,
      agentOmniPlaybackReady: null,
      agentOmniPendingAudio: [],
      agentVoiceSendInFlight: false,
      agentBusy: false,
      agentRecording: true,
      agentSpeaking: false,
      agentMode: "voice",
      agentRealtimeClient: {
        createResponse,
        cancelResponse,
        resetTranscript: vi.fn()
      },
      currentVoiceMessageText: () => currentText,
      voiceDisplayInput: (text: string) => text,
      prepareVoiceMessageForSend: (text: string) => text,
      setAgentInput: vi.fn(),
      tryAcceptPendingActionFromVoice: vi.fn(async () => false),
      queueCurrentVoiceInput: vi.fn(),
      discardCurrentVoiceTurn: vi.fn(),
      clearVoiceAutoSendTimer: vi.fn(),
      beginVoiceProcessingTrace: vi.fn(),
      markVoiceTrace: vi.fn(),
      rememberSentVoiceTurn: vi.fn(),
      clearVoiceTurnBufferAfterSend: vi.fn(() => {
        currentText = "";
      }),
      invalidateVoicePipeline: vi.fn(),
      setAgentBusy: vi.fn((busy: boolean) => {
        view.agentBusy = busy;
      }),
      transitionVoiceSession: vi.fn(),
      appendAgentMessage: vi.fn(() => ({})),
      refreshAgentSurfaceState: vi.fn(),
      setAgentMessageBubbleContent: vi.fn(),
      scrollAgentTranscriptToBottom: vi.fn(),
      appendAgentQualityLog: vi.fn(async () => undefined),
      appendVoiceMetric: vi.fn(),
      refreshAgentSuggestions: vi.fn(),
      consumeQueuedVoiceInput: vi.fn(async () => undefined),
      resetCurrentVoiceTurnDraft: vi.fn(),
      scheduleVoiceAutoSend: vi.fn(),
      voiceSession: createVoiceSession(),
      pendingAgentActions: [],
      agentVoiceQueuedAfterBusy: false,
      agentVoicePipelineGeneration: 0,
      agentVoiceIgnoreSpeechStartUntil: 0,
      agentMessages: [],
      agentOmniE2eAssistantIndex: -1,
      agentOmniE2eReply: "",
      agentOmniE2eActionSuggestions: 0,
      agentOmniE2eUserMessage: "",
      agentOmniE2eStreamMessageEl: null,
      agentVoiceTrace: {},
      agentVoiceResponseTimer: 0,
      agentVoiceFallbackTimer: 0,
      agentVoiceFallbackReason: ""
    };

    const pcmBase64 = Buffer.from(new Int16Array([900, -900]).buffer).toString("base64");
    const startNativeReply = async (responseId: string): Promise<string> => {
      handleOmniE2eResponseCreated(view, {
        eventType: "response.created",
        responseId,
        status: ""
      });
      handleOmniE2eAudioDelta(view, pcmBase64, 24_000, {
        eventType: "response.audio.delta",
        responseId,
        status: ""
      });
      await Promise.resolve();
      await Promise.resolve();
      const playbackId = runtime.snapshot().currentTurn?.playbackId ?? "";
      handleOmniE2eAudioOutputEvent(view, {
        type: "started",
        playbackId,
        owner: "native-e2e",
        timestamp: 1
      });
      return playbackId;
    };
    const completeNativeReply = async (
      responseId: string,
      playbackId: string,
      reply: string
    ): Promise<void> => {
      handleOmniE2eAudioDone(view, {
        eventType: "response.audio.done",
        responseId,
        status: ""
      });
      await finishOmniE2eVoiceTurn(view, reply, {
        eventType: "response.done",
        responseId,
        status: "completed"
      });
      handleOmniE2eAudioOutputEvent(view, {
        type: "drained",
        playbackId,
        owner: "native-e2e",
        timestamp: 2
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };

    currentText = "第一轮你好";
    await sendOmniE2eVoiceTurn(view, "turn one");
    const firstPlayback = await startNativeReply("response-1");
    await completeNativeReply("response-1", firstPlayback, "第一轮回复完成。");
    expect(runtime.snapshot().currentTurn?.phase).toBe("completed");

    currentText = "第二轮请说得长一点";
    await sendOmniE2eVoiceTurn(view, "turn two");
    await startNativeReply("response-2");
    expect(runtime.snapshot().currentTurn?.phase).toBe("playing");

    handleOmniE2eSpeechStarted(view);
    observeOmniE2eBargeInTranscript(view, "等一下");

    expect(runtime.snapshot().currentTurn?.phase).toBe("interrupted");
    expect(cancelResponse).toHaveBeenCalledTimes(1);
    expect(output.cancel).toHaveBeenCalled();
    expect(view.agentVoiceSendInFlight).toBe(false);
    expect(view.agentBusy).toBe(false);

    currentText = "第三轮继续回答我的新问题";
    await sendOmniE2eVoiceTurn(view, "turn three after interruption");
    const thirdPlayback = await startNativeReply("response-3");
    await completeNativeReply("response-3", thirdPlayback, "第三轮正常回复。");

    expect(createResponse).toHaveBeenCalledTimes(3);
    expect(runtime.snapshot().currentTurn).toMatchObject({
      phase: "completed",
      transcript: "第三轮继续回答我的新问题",
      assistantText: "第三轮正常回复。"
    });
    expect(view.agentVoiceSendInFlight).toBe(false);
    expect(view.agentBusy).toBe(false);
    expect(bargeIn.snapshot().phase).toBe("idle");
  });

  it.each(["interruption", "network"] as const)("runs cascade through the shared runtime and accepts a new turn after %s", async failure => {
    const runtime = new VoiceSessionController({ provider: "qwen-test" });
    runtime.connect();
    runtime.connected();
    const createResponse = vi.fn();
    let currentText = "第一轮请帮我分析今天的状态";
    let callCount = 0;
    let firstSignal: AbortSignal | undefined;
    const submitAgentMessageStream = vi.fn((
      _message: string,
      _history: unknown[],
      onText: (content: string) => void,
      options: { signal?: AbortSignal }
    ) => {
      callCount += 1;
      if (callCount === 1) {
        firstSignal = options.signal;
        if (failure === "network") {
          const run = providerRunStart({ provider: "fictional-text", model: "fictional-model" });
          return Promise.reject(new ProviderRunFailure(run, "network"));
        }
        return new Promise<{ reply: string; actions: never[] }>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      const reply = "第二轮已经正常接上。";
      onText(reply);
      return Promise.resolve({ reply, actions: [] });
    });
    const view = {
      controller: {
        settings: {
          realtimeVoice: {
            ...TEST_REALTIME_SETTINGS,
            mode: "cascade",
            triggerEnabled: false,
            speakReplies: true
          }
        },
        submitAgentMessageStream,
        appendAgentConversation: vi.fn(async () => undefined)
      },
      agentVoiceRuntime: runtime,
      agentVoiceSendInFlight: false,
      agentBusy: false,
      agentRecording: true,
      agentSpeaking: false,
      agentMode: "voice",
      agentRealtimeClient: {
        createResponse,
        cancelResponse: vi.fn(),
        resetTranscript: vi.fn()
      },
      currentVoiceMessageText: () => currentText,
      voiceDisplayInput: (text: string) => text,
      prepareVoiceMessageForSend: (text: string) => text,
      setAgentInput: vi.fn(),
      tryAcceptPendingActionFromVoice: vi.fn(async () => false),
      queueCurrentVoiceInput: vi.fn(),
      discardCurrentVoiceTurn: vi.fn(),
      clearVoiceAutoSendTimer: vi.fn(),
      beginVoiceProcessingTrace: vi.fn(),
      markVoiceTrace: vi.fn(),
      rememberSentVoiceTurn: vi.fn(),
      clearVoiceTurnBufferAfterSend: vi.fn(() => {
        currentText = "";
      }),
      invalidateVoicePipeline: vi.fn(),
      setAgentBusy: vi.fn((busy: boolean) => {
        view.agentBusy = busy;
      }),
      transitionVoiceSession: vi.fn(),
      appendAgentMessage: vi.fn(() => ({})),
      refreshAgentSurfaceState: vi.fn(),
      setAgentMessageBubbleContent: vi.fn(),
      scrollAgentTranscriptToBottom: vi.fn(),
      appendAgentQualityLog: vi.fn(async () => undefined),
      appendVoiceMetric: vi.fn(),
      refreshAgentSuggestions: vi.fn(),
      consumeQueuedVoiceInput: vi.fn(async () => undefined),
      resetCurrentVoiceTurnDraft: vi.fn(),
      scheduleVoiceAutoSend: vi.fn(),
      voiceSession: createVoiceSession(),
      pendingAgentActions: [],
      agentVoiceQueuedAfterBusy: false,
      agentVoicePipelineGeneration: 0,
      agentVoiceIgnoreSpeechStartUntil: 0,
      agentMessages: [],
      agentOmniE2eAssistantIndex: -1,
      agentOmniE2eReply: "",
      agentOmniE2eActionSuggestions: 0,
      agentOmniE2eUserMessage: "",
      agentOmniE2eStreamMessageEl: null,
      agentVoiceTrace: {},
      agentVoiceResponseTimer: 0,
      agentVoiceFallbackTimer: 0,
      agentVoiceFallbackReason: "",
      agentOmniPendingAudio: [],
      agentOmniPlaybackReady: null,
      agentTtsClient: null
    } as any;

    const firstTurn = sendManagedVoiceTurn(view, "cascade turn one");
    await vi.waitFor(() => expect(submitAgentMessageStream).toHaveBeenCalledTimes(1));

    expect(createResponse).not.toHaveBeenCalled();
    if (failure === "interruption") {
      expect(firstSignal?.aborted).toBe(false);
      expect(runtime.snapshot().currentTurn).toMatchObject({
        route: "brain", phase: "generating", transcript: "第一轮请帮我分析今天的状态"
      });
      expect(interruptManagedVoiceTurn(view, "cascade barge-in")).toBe(true);
    }
    await firstTurn;
    expect(firstSignal?.aborted).toBe(true);

    if (failure === "network") {
      const acknowledgement = "已收到这句语音，文字模型暂时连不上。可以稍后再问。";
      expect(runtime.snapshot()).toMatchObject({ lastErrorCode: "text_model_network", currentTurn: { phase: "failed" } });
      expect(view.agentReply).toBe(acknowledgement);
      expect(view.agentMessages.at(-1)?.content).toBe(acknowledgement);
      expect(view.transitionVoiceSession).toHaveBeenLastCalledWith("listening", "realtime response failed");
    } else {
      expect(runtime.snapshot().currentTurn?.phase).toBe("interrupted");
    }
    expect(view.agentVoiceSendInFlight).toBe(false);
    expect(view.agentBusy).toBe(false);

    currentText = "第二轮请回答我刚才的新问题";
    await sendManagedVoiceTurn(view, "cascade turn two");

    expect(submitAgentMessageStream).toHaveBeenCalledTimes(2);
    expect(createResponse).not.toHaveBeenCalled();
    expect(runtime.snapshot().currentTurn).toMatchObject({
      route: "brain",
      phase: "completed",
      transcript: "第二轮请回答我刚才的新问题",
      assistantText: "第二轮已经正常接上。",
      outputOwner: "system",
      playbackDrained: true
    });
    expect(view.agentMessages.at(-1)).toEqual({
      role: "assistant",
      content: "第二轮已经正常接上。"
    });
    expect(view.agentVoiceSendInFlight).toBe(false);
    expect(view.agentBusy).toBe(false);
  });

  it.each([
    { resident: false, text: "看看我最后一篇日记是哪一天", serverFinal: false },
    { resident: true, text: "看看我最后一篇日记是哪一天", serverFinal: false },
    { resident: true, text: "看看我最后一篇日记是哪一天", serverFinal: false, playbackFailure: "playing" },
    { resident: true, text: "看看我最后一篇日记是哪一天", serverFinal: false, playbackFailure: "before first frame" },
    { resident: true, text: "看看我最后一篇日记是哪一天", serverFinal: false, playbackFailure: "chunk delivery" },
    { resident: false, text: "对。", serverFinal: true },
    { resident: false, text: "不对不对。", serverFinal: true }
  ])("routes cascade input $text through the same agent (resident Breeze $resident, failure $playbackFailure)", async ({ resident, text, serverFinal, playbackFailure }) => {
    const runtime = new VoiceSessionController({ provider: "qwen-test" });
    runtime.connect();
    runtime.connected();
    const createResponse = vi.fn();
    const resetTranscript = vi.fn();
    const reply = "你最后一篇日记是今天的晨间记录。";
    class SystemUtterance {
      onstart?: () => void;
      onend?: () => void;

      constructor(readonly text: string) {}
    }
    const systemSpeak = vi.fn((utterance: SystemUtterance) => utterance.onstart?.());
    if (playbackFailure) {
      vi.stubGlobal("SpeechSynthesisUtterance", SystemUtterance);
      Object.assign(window, { speechSynthesis: { speak: systemSpeak, cancel: vi.fn() } });
    }
    const responseGate: { finish?: () => void; speak?: () => void } = {};
    const speak = vi.fn(async (_text: string, emit: (pcm: string) => void) => emit(Buffer.from([1, 2, 3, 4]).toString("base64")));
    const local = resident ? vi.spyOn(breezeSpeech, "sessionBreeze").mockReturnValue({ speak } as unknown as BreezeResidentWorker) : undefined;
    const submitAgentMessageStream = vi.fn((
      _message: string,
      _history: unknown[],
      onText: (content: string) => void,
      options: AgentSubmissionOptions
    ) => new Promise<{ reply: string; actions: [] }>((resolve) => {
      responseGate.speak = () => options.onVoiceText?.(reply);
      responseGate.finish = () => {
        onText(reply);
        resolve({ reply, actions: [] });
      };
    }));
    let currentText = serverFinal ? "" : text;
    const view = {
      controller: {
        settings: {
          realtimeVoice: {
            ...TEST_REALTIME_SETTINGS,
            mode: "cascade",
            ...(resident ? { ttsEngine: "breeze-local" } : {}),
            triggerEnabled: false,
            speakReplies: true
          }
        },
        submitAgentMessageStream
      },
      agentVoiceRuntime: runtime,
      agentVoiceSendInFlight: false,
      agentBusy: false,
      agentRecording: true,
      agentSpeaking: false,
      agentMode: "voice",
      agentRealtimeClient: { createResponse, resetTranscript },
      currentVoiceMessageText: () => currentText,
      voiceDisplayInput: (text: string) => text,
      prepareVoiceMessageForSend: (text: string) => text,
      setAgentInput: vi.fn(),
      tryAcceptPendingActionFromVoice: vi.fn(async () => false),
      queueCurrentVoiceInput: vi.fn(),
      discardCurrentVoiceTurn: vi.fn(),
      clearVoiceAutoSendTimer: vi.fn(),
      beginVoiceProcessingTrace: vi.fn(),
      markVoiceTrace: vi.fn(),
      rememberSentVoiceTurn: vi.fn(),
      clearVoiceTurnBufferAfterSend: vi.fn(() => {
        currentText = "";
      }),
      setAgentBusy: vi.fn((busy: boolean) => {
        view.agentBusy = busy;
      }),
      transitionVoiceSession: vi.fn(),
      appendAgentMessage: vi.fn(() => ({})),
      refreshAgentSurfaceState: vi.fn(),
      setAgentMessageBubbleContent: vi.fn(),
      scrollAgentTranscriptToBottom: vi.fn(),
      appendAgentQualityLog: vi.fn(async () => undefined),
      refreshAgentSuggestions: vi.fn(),
      consumeQueuedVoiceInput: vi.fn(async () => undefined),
      resetCurrentVoiceTurnDraft: vi.fn(),
      scheduleVoiceAutoSend: vi.fn(),
      speakAgentReply: vi.fn(),
      voiceSession: createVoiceSession(),
      pendingAgentActions: [],
      agentVoiceQueuedAfterBusy: false,
      agentVoicePipelineGeneration: 0,
      agentVoiceIgnoreSpeechStartUntil: 0,
      agentMessages: [],
      agentOmniE2eAssistantIndex: -1,
      agentOmniE2eReply: "",
      agentOmniE2eActionSuggestions: 0,
      agentOmniE2eUserMessage: "",
      agentOmniE2eStreamMessageEl: null,
      agentVoiceTrace: {},
      agentCameraPersonaHint: ""
    } as any;
    const output = resident ? createVoiceWorklet(event => handleOmniE2eAudioOutputEvent(view, event)) : undefined;
    if (output) view.agentAudioOutput = output.actor;

    let turn: Promise<void> | undefined;
    if (serverFinal) {
      view.agentVoiceReady = true;
      view.handleVoiceSpeechStarted = vi.fn();
      view.handleVoiceSpeechStopped = vi.fn();
      view.updateRealtimeTranscript = (value: string) => { currentText = value; };
      view.sendVoiceTurnIfReady = () => (turn = sendManagedVoiceTurn(view, "server-vad finalized"));
      const endpoint = new ServerVoiceEndpoint(), itemId = "fictional-short-voice";
      handleCascadeCapture(view, endpoint, { type: "started", itemId });
      handleCascadeCapture(view, endpoint, { type: "stopped", itemId });
      handleCascadeCapture(view, endpoint, { type: "final", itemId, text });
    } else {
      turn = sendManagedVoiceTurn(view, "test cascade route");
    }
    await vi.waitFor(() => expect(submitAgentMessageStream).toHaveBeenCalledTimes(1));

    expect(view.agentReply).toBe("LifeOps 正在处理...");
    expect(view.appendAgentMessage).toHaveBeenCalledWith({ role: "assistant", content: "" });
    expect(view.setAgentInput).toHaveBeenLastCalledWith("");
    expect(resetTranscript).toHaveBeenCalledOnce();
    expect(view.scrollAgentTranscriptToBottom).toHaveBeenCalled();

    if (output) {
      if (playbackFailure === "chunk delivery") {
        vi.spyOn(output.actor, "appendPcm16").mockImplementationOnce(() => {
          throw new DOMException("Synthetic worklet transfer failure", "DataCloneError");
        });
      }
      responseGate.speak?.();
      if (playbackFailure === "chunk delivery") {
        await vi.waitFor(() => expect(output.actor.snapshot()?.status).toBe("failed"));
      } else {
        await vi.waitFor(() => expect(output.actor.snapshot()?.chunksQueued).toBe(1));
        if (playbackFailure !== "before first frame") output.render();
      }
      expect(speak).toHaveBeenCalledExactlyOnceWith(reply, expect.any(Function), expect.any(AbortSignal));
      expect(runtime.snapshot().currentTurn).toMatchObject({ modelDone: false });
      if (playbackFailure) {
        if (playbackFailure !== "chunk delivery") {
          const playing = output.actor.snapshot()!;
          handleOmniE2eAudioOutputEvent(view, { type: "failed", owner: "fallback-tts",
            playbackId: playing.playbackId, errorCode: "synthetic_failure", timestamp: Date.now() });
        }
        expect(runtime.snapshot().currentTurn).toMatchObject({ modelDone: false,
          playbackDrained: playbackFailure === "playing", outputOwner: playbackFailure === "playing" ? "none" : "system" });
        expect(systemSpeak).not.toHaveBeenCalled();
      }
    }
    responseGate.finish?.();
    await turn;
    if (output) {
      if (!playbackFailure) {
        await vi.waitFor(() => expect(output.actor.snapshot()?.status).toBe("draining"));
        output.render();
      }
      if (playbackFailure && playbackFailure !== "playing") {
        await vi.waitFor(() => expect(systemSpeak).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: reply })));
        expect(runtime.snapshot().currentTurn?.phase).toBe("playing");
        systemSpeak.mock.calls[0][0].onend?.();
      } else {
        expect(systemSpeak).not.toHaveBeenCalled();
      }
      await vi.waitFor(() => expect(runtime.snapshot().currentTurn?.phase).toBe("completed"));
      if (playbackFailure) {
        expect(runtime.snapshot().sessionPhase).toBe("listening");
        expect(view.agentBusy).toBe(false);
        expect(view.agentVoiceSendInFlight).toBe(false);
      }
      await output.actor.close();
      local?.mockRestore();
    }

    expect(createResponse).not.toHaveBeenCalled();
    expect(submitAgentMessageStream).toHaveBeenCalledWith(
      text,
      [],
      expect.any(Function),
      expect.objectContaining({
        source: "voice",
        signal: expect.any(Object),
        providerTraceId: expect.stringMatching(/^[a-zA-Z0-9_-]+$/)
      })
    );
    expect(runtime.snapshot().currentTurn).toMatchObject({
      route: "brain",
      phase: "completed",
      assistantText: reply
    });
    expect(view.agentMessages.at(-1)).toEqual({
      role: "assistant",
      content: reply
    });
    expect(view.speakAgentReply).not.toHaveBeenCalled();
    expect(runtime.snapshot().currentTurn).toMatchObject({
      outputOwner: playbackFailure === "playing" ? "none" : resident && !playbackFailure ? "fallback-tts" : "system",
      playbackDrained: true
    });
  });

  it("dispatches a finalized server item directly and never dispatches a rendered reply echoed back", () => {
    const view = {
      controller: { settings: DEFAULT_SETTINGS },
      agentVoiceReady: true, agentSpeaking: true,
      handleVoiceSpeechStarted: vi.fn(), handleVoiceSpeechStopped: vi.fn(), markVoiceTrace: vi.fn(),
      updateRealtimeTranscript: vi.fn(), sendVoiceTurnIfReady: vi.fn(async () => undefined)
    };
    const endpoint = new ServerVoiceEndpoint(), spoken = "今天还有两个任务没有完成。";
    recordSpeakerPhrase(view, spoken);
    handleCascadeCapture(view, endpoint, { type: "started", itemId: "echo" });
    handleCascadeCapture(view, endpoint, { type: "preview", itemId: "echo", text: spoken });
    handleCascadeCapture(view, endpoint, { type: "stopped", itemId: "echo" });
    handleCascadeCapture(view, endpoint, { type: "final", itemId: "echo", text: spoken });
    expect(view.updateRealtimeTranscript).not.toHaveBeenCalled();
    expect(view.sendVoiceTurnIfReady).not.toHaveBeenCalled();
    handleCascadeCapture(view, endpoint, { type: "started", itemId: "backchannel" });
    handleCascadeCapture(view, endpoint, { type: "stopped", itemId: "backchannel" });
    handleCascadeCapture(view, endpoint, { type: "final", itemId: "backchannel", text: "对。" });
    expect(view.updateRealtimeTranscript).not.toHaveBeenCalled();
    expect(view.sendVoiceTurnIfReady).not.toHaveBeenCalled();
    view.agentSpeaking = false;
    handleCascadeCapture(view, endpoint, { type: "started", itemId: "user" });
    handleCascadeCapture(view, endpoint, { type: "final", itemId: "user", text: "明天下午见客户。" });
    expect(view.sendVoiceTurnIfReady).not.toHaveBeenCalled();
    handleCascadeCapture(view, endpoint, { type: "stopped", itemId: "user" });
    expect(view.updateRealtimeTranscript).toHaveBeenCalledExactlyOnceWith("明天下午见客户。", true, true);
    expect(view.sendVoiceTurnIfReady).toHaveBeenCalledOnce();
  });

  it("compares low playback echo and independently louder repetition with the same transcript", () => {
    const view = {
      controller: { settings: { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, dataDisclosureAccepted: false } } },
      agentMode: "voice", agentVoiceReady: true, agentSpeaking: false, agentVoiceTrace: {}, agentVoiceLocalSpeechActive: true,
      handleVoiceSpeechStarted: vi.fn(), handleVoiceSpeechStopped: vi.fn(), markVoiceTrace: vi.fn(),
      clearVoiceLocalEndpointTimer: vi.fn(),
      updateRealtimeTranscript: vi.fn(), sendVoiceTurnIfReady: vi.fn(async () => undefined)
    };
    const waveform = (amplitude: number) => Float32Array.from({ length: 640 }, (_, i) => amplitude * Math.sin(i * Math.PI / 16));
    const endpoint = new ServerVoiceEndpoint(), spoken = "今天还有两个任务没有完成。";
    resetSpeakerEcho(view, true);
    observeLocalVoiceEnergy(view, waveform(0.13));
    recordSpeakerPhrase(view, spoken);
    const captured = (id: string, gain: number) => {
      handleCascadeCapture(view, endpoint, { type: "started", itemId: id });
      for (let frame = 0; frame < 8; frame++) observeLocalVoiceEnergy(view, waveform(gain));
      handleCascadeCapture(view, endpoint, { type: "stopped", itemId: id });
      handleCascadeCapture(view, endpoint, { type: "final", itemId: id, text: spoken });
    };
    view.agentSpeaking = true;
    captured("speaker-bleed", 0.02);
    expect(view.sendVoiceTurnIfReady).not.toHaveBeenCalled();
    view.agentSpeaking = false;
    captured("near-repetition", 0.13);
    expect(view.sendVoiceTurnIfReady).not.toHaveBeenCalled();
    handleCascadeCapture(view, endpoint, { type: "started", itemId: "new-question" });
    handleCascadeCapture(view, endpoint, { type: "stopped", itemId: "new-question" });
    handleCascadeCapture(view, endpoint, { type: "final", itemId: "new-question", text: "明天有哪些待办？" });
    expect(view.sendVoiceTurnIfReady).toHaveBeenCalledOnce();
  });

  it("keeps a pending cascade receipt through a speech onset and preview, then accepts a final correction", () => {
    const runtime = new VoiceSessionController();
    runtime.connect();
    runtime.connected();
    runtime.beginTurn({ route: "action", transcript: "撤销。" });
    runtime.transitionTurn("routing", "test undo");
    runtime.transitionTurn("generating", "test undo receipt pending");
    const view = Object.assign(new CascadeComposerTestView(), {
      controller: { settings: { realtimeVoice: { ...TEST_REALTIME_SETTINGS, mode: "cascade", triggerEnabled: false } } },
      agentMode: "voice", agentBusy: true, agentSpeaking: false, agentSpeechSources: new Set(),
      agentVoiceReady: true, agentVoiceRuntime: runtime, agentVoiceIgnoreSpeechStartUntil: 0,
      agentOmniE2eReply: "", agentOmniE2eAssistantIndex: -1,
      agentVoiceTurnRevision: 0, agentVoiceTurnText: "", agentVoiceActivePartial: "", agentVoiceBaseInput: "",
      agentVoiceControlHoldSignature: "", agentVoiceControlHoldUntil: 0,
      voiceSession: createVoiceSession(), setAgentInput: vi.fn(), clearVoiceNoTranscriptTimer: vi.fn(),
      clearVoiceAutoSendTimer: vi.fn(), clearVoiceLocalEndpointTimer: vi.fn(), appendVoiceMetric: vi.fn(),
      invalidateVoicePipeline: vi.fn(), interruptAgentSpeech: vi.fn(), refreshAgentSurfaceState: vi.fn(),
      setAgentBusy: vi.fn(), transitionVoiceSession: vi.fn()
    }) as any;

    view.handleVoiceSpeechStarted("local-vad");
    expect(runtime.snapshot().currentTurn?.phase).toBe("generating");
    view.updateRealtimeTranscript("等一下，我刚才", false, false, true);

    expect(view.agentVoiceActivePartial).toBe("等一下，我刚才");
    expect(view.invalidateVoicePipeline).not.toHaveBeenCalled();
    expect(view.interruptAgentSpeech).not.toHaveBeenCalled();
    expect(view.agentVoiceControlHoldUntil).toBe(0);
    expect(view.prepareVoiceMessageForSend("等一下，我刚才问的是上周。", true)).toBe("等一下，我刚才问的是上周。");

    view.updateRealtimeTranscript("等一下，我刚才问的是上周。", true, true);
    expect(runtime.snapshot().currentTurn?.phase).toBe("interrupted");
    expect(view.agentVoiceTurnText).toBe("等一下，我刚才问的是上周。");
  });

  it("keeps a long result in the panel, waits for idle and replays after playback is interrupted", async () => {
    const runtime = new VoiceSessionController();
    runtime.connect(); runtime.connected();
    const speak = vi.fn(async (_text: string, emit: (pcm: string) => void) => {
      emit(Buffer.from(new Int16Array(600).fill(8192).buffer).toString("base64"));
    });
    const local = vi.spyOn(breezeSpeech, "sessionBreeze").mockReturnValue({ speak } as unknown as BreezeResidentWorker);
    const save = vi.fn(async () => undefined);
    let currentText = "", finish!: (reply: { reply: string; voiceSpeech: string; actions: [] }) => void;
    const result = "# 虚构月报\n\n| 周起始日 | 完成数 |\n| --- | --- |\n| 10月12日 | 3 |\n\n3个虚构案例集中在第2周。";
    const voiceSpeech = "三个虚构案例集中在第二周。";
    const submit = vi.fn(async (message: string, _history: unknown[], onText: (text: string) => void, options: AgentSubmissionOptions) => {
      if (options.voiceBackground) return new Promise<{ reply: string; voiceSpeech: string; actions: [] }>(resolve => { finish = resolve; });
      let reply = message + "的短答。";
      if (message === "分析十月虚构交易") reply = handleVoiceJobTool(options.voiceJobs!, { id: "start", name: "start_background_job",
        arguments: { title: "十月交易", question: message, scope: "十月" } }).output;
      if (message === "继续说刚才那个") reply = handleVoiceJobTool(options.voiceJobs!, { id: "replay", name: "replay_job",
        arguments: { target: "ambiguous" } }).output;
      onText(reply);
      return { reply, actions: [] };
    });
    const view = {
      controller: { settings: { realtimeVoice: { ...TEST_REALTIME_SETTINGS, mode: "cascade", ttsEngine: "breeze-local", speakReplies: true } },
        appendAgentConversation: save, submitAgentMessageStream: submit },
      agentVoiceRuntime: runtime, agentBusy: false, agentRecording: true, agentVoiceConversation: true,
      agentVoiceReady: true, agentSpeaking: false, agentMode: "voice", agentRealtimeClient: { resetTranscript: vi.fn() },
      currentVoiceMessageText: () => currentText, voiceDisplayInput: (text: string) => text, prepareVoiceMessageForSend: (text: string) => text,
      setAgentInput: vi.fn(), tryAcceptPendingActionFromVoice: vi.fn(async () => false), queueCurrentVoiceInput: vi.fn(),
      clearVoiceAutoSendTimer: vi.fn(), beginVoiceProcessingTrace: vi.fn(), markVoiceTrace: vi.fn(), rememberSentVoiceTurn: vi.fn(),
      clearVoiceTurnBufferAfterSend: () => { currentText = ""; }, setAgentBusy: (busy: boolean) => { view.agentBusy = busy; },
      transitionVoiceSession: vi.fn(), appendAgentMessage: vi.fn(() => ({})), refreshAgentSurfaceState: vi.fn(), refreshVoiceJobs: vi.fn(),
      setAgentMessageBubbleContent: vi.fn(), scrollAgentTranscriptToBottom: vi.fn(), appendAgentQualityLog: vi.fn(async () => undefined),
      refreshAgentSuggestions: vi.fn(), consumeQueuedVoiceInput: vi.fn(async () => undefined), resetCurrentVoiceTurnDraft: vi.fn(),
      invalidateVoicePipeline: vi.fn(), handleVoiceSpeechStarted: vi.fn(), handleVoiceSpeechStopped: vi.fn(),
      updateRealtimeTranscript: (text: string) => { currentText = text; },
      sendVoiceTurnIfReady: () => sendThroughComposer(view),
      voiceSession: createVoiceSession(), pendingAgentActions: [], agentVoicePipelineGeneration: 0, agentMessages: [],
      agentOmniE2eAssistantIndex: -1, agentOmniE2eReply: "", agentVoiceTrace: {}
    } as any;
    const output = createVoiceWorklet(event => handleOmniE2eAudioOutputEvent(view, event));
    view.agentAudioOutput = output.actor;
    const drain = async () => {
      const turnId = runtime.snapshot().currentTurn?.turnId;
      await vi.waitFor(() => expect(output.actor.snapshot()?.status).toBe("draining"));
      for (let index = 0; index < 64 && output.actor.snapshot()?.status === "draining"; index++) output.render();
      await vi.waitFor(() => {
        const current = runtime.snapshot().currentTurn;
        expect(current?.turnId !== turnId || current?.phase === "completed",
          JSON.stringify({ phase: current?.phase, transcript: current?.transcript, modelDone: current?.modelDone,
            output: output.actor.snapshot(), settled: save.mock.calls.length, speaks: speak.mock.calls.length })).toBe(true);
      });
    };
    const ask = async (text: string) => { currentText = text; await sendManagedVoiceTurn(view); await drain(); };
    try {
      await ask("分析十月虚构交易");
      await ask("虚构短问一");
      await ask("虚构短问二");
      expect(voiceJobsForPanel(view)[0].status).toBe("running");
      const endpoint = new ServerVoiceEndpoint();
      handleCascadeCapture(view, endpoint, { type: "started", itemId: "waiting" });
      finish({ reply: result, voiceSpeech, actions: [] });
      await vi.waitFor(() => expect(voiceJobsForPanel(view)[0]).toMatchObject({ result, announced: false }));
      expect(speak).toHaveBeenCalledTimes(3);
      handleCascadeCapture(view, endpoint, { type: "rejected", itemId: "waiting" });
      await vi.waitFor(() => expect(output.actor.snapshot()?.status).toBe("draining"));
      expect(output.render().some(sample => sample > 0)).toBe(true);
      expect(interruptManagedVoiceTurn(view)).toBe(true);
      expect(output.render().every(sample => sample === 0)).toBe(true);
      expect(voiceJobsForPanel(view)[0]).toMatchObject({ result, announced: false });
      for (const itemId of ["replay-once", "replay-again"]) {
        handleCascadeCapture(view, endpoint, { type: "started", itemId });
        handleCascadeCapture(view, endpoint, { type: "stopped", itemId });
        handleCascadeCapture(view, endpoint, { type: "final", itemId, text: "继续说刚才那个" });
        handleCascadeCapture(view, endpoint, { type: "final", itemId, text: "继续说刚才那个" });
        await vi.waitFor(() => expect(runtime.snapshot().currentTurn?.transcript).toBe("继续说刚才那个"));
        await drain();
        await vi.waitFor(() => expect(runtime.snapshot().currentTurn).toMatchObject({ transcript: "", modelDone: true }));
        await drain();
      }
      expect(submit.mock.calls.filter(([text]) => text === "继续说刚才那个")).toHaveLength(2);
      expect(voiceJobsForPanel(view)[0]).toMatchObject({ result, announced: true });
      const audioText = speak.mock.calls.map(([text]) => text).join(" ");
      expect(audioText.split(voiceSpeech)).toHaveLength(4);
      expect(audioText).not.toContain("周起始日");
      expect(audioText).not.toContain("| 10月12日 | 3 |");
      const events = save.mock.calls as unknown as string[][];
      expect(events.filter(([label]) => label.includes("语音后台任务")).map(([, body]) => body))
        .toEqual(["已开始", "已完成\n\n" + result]);
      expect(events.some(([label]) => label === "虚构短问二")).toBe(true);
    } finally {
      local.mockRestore();
      await output.actor.close();
    }
  });

  it("keeps cascade playback through noise and incidental speech and cuts it for a directed request", async ({ onTestFinished }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    Object.assign(window, { setTimeout, clearTimeout });
    const review = vi.spyOn(playbackInput, "classifyPlaybackInput").mockImplementation(async (_settings, text) => {
      if (text === "停一下，我想问明天的任务。") return "accept";
      return text === "我。" ? undefined : "ignore";
    });
    onTestFinished(() => { review.mockRestore(); });
    const measurements: number[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      const runtime = new VoiceSessionController(), save = vi.fn(async () => undefined), stopTts = vi.fn();
      runtime.connect(); runtime.connected(); runtime.beginTurn({ route: "brain", transcript: "虚构用户问题。" });
      runtime.transitionTurn("endpointing"); runtime.transitionTurn("routing"); runtime.transitionTurn("generating");
      runtime.selectOutputOwner("fallback-tts"); runtime.bindPlayback("active-" + attempt);
      const view = Object.assign(new CascadeComposerTestView(), {
        controller: { settings: { ai: { dataDisclosureAccepted: true }, realtimeVoice: { ...TEST_REALTIME_SETTINGS, mode: "cascade", triggerEnabled: false } }, appendAgentConversation: save },
        agentMode: "voice", agentVoiceReady: true, agentRecording: true, agentVoiceConversation: true,
        agentVoiceRuntime: runtime, agentTtsClient: { cancel: stopTts }, agentVoiceTrace: {},
        agentSpeaking: false, agentVoiceSystemSpeechActive: false, agentVoiceLocalSpeechActive: false,
        agentSpeechSources: new Set(), agentVoiceTurnRevision: 0, voiceSession: createVoiceSession(),
        agentVoiceTurnText: "", agentVoiceActivePartial: "", agentVoiceBaseInput: "", agentVoiceRawInput: "", agentInput: "",
        agentOmniE2eUserMessage: "虚构用户问题。", agentOmniE2eReply: "第一句已经完整。第二句还未说完。第三句未播放。",
        agentMessages: [{ role: "user", content: "虚构用户问题。" }, { role: "assistant", content: "未播全文" }],
        agentOmniE2eAssistantIndex: 1, invalidateVoicePipeline: vi.fn(), setAgentBusy: vi.fn(), transitionVoiceSession: vi.fn(),
        refreshAgentSurfaceState: vi.fn(), clearVoiceNoTranscriptTimer: vi.fn(), clearVoiceLocalEndpointTimer: vi.fn(),
        clearVoiceAutoSendTimer: vi.fn(), interruptAgentSpeech: vi.fn(), setAgentInput: vi.fn(),
        sendVoiceTurnIfReady: vi.fn(), markVoiceTrace: vi.fn(), appendVoiceMetric: vi.fn()
      }) as any;
      view.agentVoiceBargeIn = new VoiceBargeInController({ onEvent: event => handleOmniE2eBargeInEvent(view, event) });
      const endpoint = new ServerVoiceEndpoint();
      const worklet = createVoiceWorklet(event => handleOmniE2eAudioOutputEvent(view, event));
      view.agentAudioOutput = worklet.actor;
      await worklet.actor.start("active-" + attempt, "fallback-tts");
      worklet.actor.appendPcm16("active-" + attempt, new Int16Array(4096).fill(8192), 48_000);
      expect(worklet.render().some(value => value > 0)).toBe(true);
      beginHeardSpeech(view);
      rememberHeardPhrase(view, "第一句已经完整。", true);
      rememberHeardPhrase(view, "第二句还未说完。", false);
      observeLocalVoiceEnergy(view, new Float32Array(640).fill(0.004));
      expect(worklet.actor.snapshot()?.status).toBe("playing");
      for (const noise of [0.027, 0.026, 0.009, 0.014, 0.037, 0.009]) {
        vi.advanceTimersByTime(40);
        observeLocalVoiceEnergy(view, new Float32Array(640).fill(noise));
        expect(worklet.actor.snapshot()?.status).toBe("playing");
      }
      const quietSpeech = attempt % 2 === 0;
      const speech = new Float32Array(640).fill(quietSpeech ? 0.023 : 0.08);
      handleCascadeCapture(view, endpoint, { type: "started", itemId: "noise" });
      for (let frame = 0; frame < 15; frame++) {
        vi.advanceTimersByTime(40);
        observeLocalVoiceEnergy(view, speech);
      }
      handleCascadeCapture(view, endpoint, { type: "rejected", itemId: "noise" });
      expect(review).not.toHaveBeenCalled();

      const incidentalSpeech = attempt % 2 === 0 ? "我。" : "欢迎收看今天的比赛。";
      handleCascadeCapture(view, endpoint, { type: "started", itemId: "incidental" });
      handleCascadeCapture(view, endpoint, { type: "stopped", itemId: "incidental" });
      handleCascadeCapture(view, endpoint, { type: "final", itemId: "incidental", text: incidentalSpeech });
      await Promise.resolve();
      expect(review).toHaveBeenCalledExactlyOnceWith(expect.anything(), incidentalSpeech, "虚构用户问题。", expect.any(AbortSignal));
      expect(worklet.actor.snapshot()?.status).toBe("playing");
      expect(stopTts).not.toHaveBeenCalled();
      expect(view.sendVoiceTurnIfReady).not.toHaveBeenCalled();

      let acceptEarlier!: (decision: "accept") => void;
      review.mockImplementationOnce(() => new Promise(resolve => { acceptEarlier = resolve; }));
      handleCascadeCapture(view, endpoint, { type: "started", itemId: "earlier" });
      handleCascadeCapture(view, endpoint, { type: "stopped", itemId: "earlier" });
      handleCascadeCapture(view, endpoint, { type: "final", itemId: "earlier", text: "虚构旧问。" });
      const earlierSignal = review.mock.calls.at(-1)?.[3];
      expect(earlierSignal?.aborted).toBe(false);
      handleCascadeCapture(view, endpoint, { type: "started", itemId: "user" });
      expect(earlierSignal?.aborted).toBe(true);
      acceptEarlier("accept");
      await Promise.resolve();
      expect(view.sendVoiceTurnIfReady).not.toHaveBeenCalled();
      expect(worklet.actor.snapshot()?.status).toBe("playing");
      handleCascadeCapture(view, endpoint, { type: "stopped", itemId: "user" });
      const confirmedAt = performance.now();
      handleCascadeCapture(view, endpoint, { type: "final", itemId: "user", text: "停一下，我想问明天的任务。" });
      expect(earlierSignal?.aborted).toBe(true);
      expect(stopTts).not.toHaveBeenCalled();
      await Promise.resolve();
      vi.advanceTimersByTime(3);
      expect(worklet.render().every(value => value === 0)).toBe(true);
      measurements.push(performance.now() - confirmedAt);
      expect(runtime.snapshot().currentTurn?.phase).toBe("interrupted");
      expect(stopTts).toHaveBeenCalledOnce();
      expect(view.agentVoiceTurnText).toBe("停一下，我想问明天的任务。");
      expect(view.sendVoiceTurnIfReady).toHaveBeenCalledOnce();
      expect(save).toHaveBeenCalledExactlyOnceWith("虚构用户问题。", "第一句已经完整。\n（被打断，末句未播完）", expect.any(Function));
      expect(view.agentMessages.at(-1)?.content).not.toContain("第三句");
      clearTimeout(view.agentVoiceNoTranscriptTimer);
      await worklet.actor.close();
      review.mockClear();
    }
    expect(measurements).toHaveLength(20);
    expect(Math.max(...measurements)).toBeLessThanOrEqual(300);
  });

  it.for([false, true])("pauses nearby playback without a new request (text disclosure=%s)", async (dataDisclosureAccepted, { onTestFinished }) => {
    const review = vi.spyOn(playbackInput, "classifyPlaybackInput");
    onTestFinished(() => { review.mockRestore(); });
    const runtime = new VoiceSessionController();
    runtime.connect(); runtime.connected(); runtime.beginTurn({ route: "brain", transcript: "虚构问题。" });
    runtime.transitionTurn("endpointing"); runtime.transitionTurn("routing"); runtime.transitionTurn("generating");
    runtime.selectOutputOwner("fallback-tts"); runtime.bindPlayback("pause-check");
    const stopTts = vi.fn(), save = vi.fn(async () => undefined);
    const view = Object.assign(new CascadeComposerTestView(), {
      controller: { settings: { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, dataDisclosureAccepted },
        realtimeVoice: { ...DEFAULT_SETTINGS.realtimeVoice, triggerEnabled: false } }, appendAgentConversation: save },
      agentMode: "voice", agentRecording: true, agentVoiceConversation: true, agentVoiceReady: true, agentSpeaking: false,
      agentVoiceRuntime: runtime, agentTtsClient: { cancel: stopTts }, agentVoiceTrace: {},
      agentSpeechSources: new Set(), agentSpeechPlaybackId: 0, agentMessages: [], agentOmniE2eAssistantIndex: -1,
      agentOmniE2eUserMessage: "虚构问题。", agentOmniE2eReply: "已经说过的句子。",
      invalidateVoicePipeline: vi.fn(), setAgentBusy: vi.fn(), transitionVoiceSession: vi.fn(),
      refreshAgentSurfaceState: vi.fn(), appendVoiceMetric: vi.fn(), handleVoiceSpeechStarted: vi.fn(),
      handleVoiceSpeechStopped: vi.fn(), markVoiceTrace: vi.fn(), clearVoiceNoTranscriptTimer: vi.fn(),
      clearVoiceLocalEndpointTimer: vi.fn(), updateRealtimeTranscript: vi.fn(), sendVoiceTurnIfReady: vi.fn()
    }) as any;
    const worklet = createVoiceWorklet(event => handleOmniE2eAudioOutputEvent(view, event));
    view.agentAudioOutput = worklet.actor;
    onTestFinished(async () => { await worklet.actor.close(); });
    const sample = (amplitude: number) => Float32Array.from({ length: 640 }, (_, i) => amplitude * Math.sin(i * Math.PI / 16));
    resetSpeakerEcho(view, true);
    observeLocalVoiceEnergy(view, sample(0.15));
    await worklet.actor.start("pause-check", "fallback-tts");
    worklet.actor.appendPcm16("pause-check", new Int16Array(4096).fill(8192), 48_000);
    beginHeardSpeech(view);
    rememberHeardPhrase(view, "已经说过的句子。", true);
    expect(worklet.render().some(sample => sample > 0)).toBe(true);
    view.agentSpeaking = true;
    const endpoint = new ServerVoiceEndpoint();
    function hear(itemId: string, amplitude: number, text: string) {
      handleCascadeCapture(view, endpoint, { type: "started", itemId });
      for (let i = 0; i < 8; i++) observeLocalVoiceEnergy(view, sample(amplitude));
      handleCascadeCapture(view, endpoint, { type: "stopped", itemId });
      handleCascadeCapture(view, endpoint, { type: "final", itemId, text });
    }
    hear("far", 0.025, "停一下");
    hear("far-wait", 0.025, "等一下");
    expect(stopTts).not.toHaveBeenCalled();
    expect(worklet.actor.snapshot()?.status).toBe("playing");
    hear("near", 0.13, "停一下");
    handleCascadeCapture(view, endpoint, { type: "final", itemId: "near", text: "停一下" });
    expect(stopTts).toHaveBeenCalledOnce();
    expect(worklet.render().every(sample => sample === 0)).toBe(true);
    expect(runtime.snapshot().currentTurn?.phase).toBe("interrupted");
    expect(view.transitionVoiceSession).toHaveBeenLastCalledWith("listening", "user paused voice playback");
    expect(view.agentRecording).toBe(true);
    expect(save).toHaveBeenCalledExactlyOnceWith("虚构问题。", "已经说过的句子。\n（被打断）", expect.any(Function));
    expect(review).not.toHaveBeenCalled();
    expect(view.updateRealtimeTranscript).not.toHaveBeenCalled();
    expect(view.sendVoiceTurnIfReady).not.toHaveBeenCalled();
    hear("new-question", 0.13, "明天有哪些待办？");
    expect(view.updateRealtimeTranscript).toHaveBeenCalledExactlyOnceWith("明天有哪些待办？", true, true);
    expect(view.sendVoiceTurnIfReady).toHaveBeenCalledOnce();
  });

  it("filters incidental speech during playback without text model disclosure", () => {
    const onlineReview = vi.spyOn(playbackInput, "classifyPlaybackInput");
    const view = {
      controller: { settings: { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, dataDisclosureAccepted: false } } },
      agentMode: "voice", agentRecording: true, agentVoiceReady: true, agentSpeaking: true,
      handleVoiceSpeechStarted: vi.fn(), handleVoiceSpeechStopped: vi.fn(), markVoiceTrace: vi.fn(),
      updateRealtimeTranscript: vi.fn(), sendVoiceTurnIfReady: vi.fn()
    };
    const endpoint = new ServerVoiceEndpoint();
    const hear = (itemId: string, text: string) => {
      handleCascadeCapture(view, endpoint, { type: "started", itemId });
      handleCascadeCapture(view, endpoint, { type: "stopped", itemId });
      handleCascadeCapture(view, endpoint, { type: "final", itemId, text });
    };
    try {
      hear("background", "欢迎收看今天的比赛。");
      hear("background-question", "今晚一起吃什么？");
      expect(view.sendVoiceTurnIfReady).not.toHaveBeenCalled();
      hear("directed", "停一下，我想问明天的任务。");
      expect(view.updateRealtimeTranscript).toHaveBeenCalledExactlyOnceWith("停一下，我想问明天的任务。", true, true);
      expect(view.sendVoiceTurnIfReady).toHaveBeenCalledOnce();
      expect(onlineReview).not.toHaveBeenCalled();
    } finally {
      onlineReview.mockRestore();
    }
  });

  it.each([["对", false], ["是", true], ["确认", true]] as const)("checks persisted task deletion after the spoken answer %s", async (answer, approved) => {
    const runtime = new VoiceSessionController();
    runtime.connect(); runtime.connected();
    const speak = vi.fn(async (_text: string, emit: (pcm: string) => void) => {
      emit(Buffer.from(new Int16Array(160).fill(8192).buffer).toString("base64"));
    });
    const root = await mkdtemp(join(tmpdir(), "lifeops-voice-delete-"));
    const store = new LifeOpsStore(createFsApp(root), structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    const context = { store, refreshViews: async () => undefined };
    const agent = new AgentRuntime(context);
    let currentText = "";
    const submit = vi.fn(async (message: string) => {
      const result = await agent.executeToolCall({
        toolName: "delete_task", callId: "synthetic-delete", source: "kimi", userMessage: message,
        arguments: { taskIdOrTitle: message.slice("删除".length) }
      });
      expect(result.success).toBe(true);
      return { reply: "确认卡已准备。", actions: result.actions };
    });
    const save = vi.fn(async () => undefined);
    const execute = vi.fn(async (action: Parameters<typeof runConfirmedToolAction>[0]) => {
      expect(await runConfirmedToolAction(action, context)).toBe(true);
      return "已删除 1 个任务。";
    });
    class TestView extends CascadeComposerTestView {}
    applySuggestionsPanel(TestView);
    const view = Object.assign(new TestView(), {
      controller: { settings: { ai: { dataDisclosureAccepted: true }, realtimeVoice: { ...TEST_REALTIME_SETTINGS, mode: "cascade", ttsEngine: "breeze-local", speakReplies: true } },
        appendAgentConversation: save, submitAgentMessageStream: submit, executeAgentAction: execute, appendQualityLog: vi.fn(async () => undefined) },
      agentVoiceRuntime: runtime, agentBusy: false, agentRecording: true, agentVoiceConversation: true,
      agentVoiceReady: true, agentSpeaking: false, agentMode: "voice", agentRealtimeClient: { resetTranscript: vi.fn() },
      currentVoiceMessageText: () => currentText, voiceDisplayInput: (text: string) => text, prepareVoiceMessageForSend: (text: string) => text,
      setAgentInput: vi.fn(), queueCurrentVoiceInput: vi.fn(), recoverTimedOutAgentBusy: vi.fn(),
      discardCurrentVoiceTurn: () => { currentText = ""; },
      clearVoiceAutoSendTimer: vi.fn(), beginVoiceProcessingTrace: vi.fn(), markVoiceTrace: vi.fn(), rememberSentVoiceTurn: vi.fn(),
      clearVoiceTurnBufferAfterSend: () => { currentText = ""; }, setAgentBusy: (busy: boolean) => { view.agentBusy = busy; },
      transitionVoiceSession: vi.fn(), appendAgentMessage: vi.fn(() => ({})), refreshAgentSurfaceState: vi.fn(),
      setAgentMessageBubbleContent: vi.fn(), scrollAgentTranscriptToBottom: vi.fn(), appendAgentQualityLog: vi.fn(async () => undefined),
      refreshAgentSuggestions: vi.fn(), consumeQueuedVoiceInput: vi.fn(async () => undefined), resetCurrentVoiceTurnDraft: vi.fn(),
      handleVoiceSpeechStarted: vi.fn(), handleVoiceSpeechStopped: vi.fn(), updateRealtimeTranscript: (text: string) => { currentText = text; },
      sendVoiceTurnIfReady: () => sendThroughComposer(view),
      voiceSession: createVoiceSession(), pendingAgentActions: [], agentVoicePipelineGeneration: 0, agentMessages: [],
      agentOmniE2eAssistantIndex: -1, agentOmniE2eReply: "", agentVoiceTrace: {}
    }) as any;
    const endpoint = new ServerVoiceEndpoint();
    const output = createVoiceWorklet(event => handleOmniE2eAudioOutputEvent(view, event));
    view.agentAudioOutput = output.actor;
    const say = async (itemId: string, text: string) => {
      handleCascadeCapture(view, endpoint, { type: "started", itemId });
      handleCascadeCapture(view, endpoint, { type: "stopped", itemId });
      handleCascadeCapture(view, endpoint, { type: "final", itemId, text });
      await vi.waitFor(() => expect(output.actor.snapshot()?.status).toBe("draining"));
      for (let index = 0; index < 32 && output.actor.snapshot()?.status === "draining"; index++) output.render();
      await vi.waitFor(() => expect(runtime.snapshot().currentTurn?.phase).toBe("completed"));
    };
    const local = vi.spyOn(breezeSpeech, "sessionBreeze").mockReturnValue({ speak } as unknown as BreezeResidentWorker);
    const review = vi.spyOn(playbackInput, "classifyPlaybackInput").mockResolvedValue("ignore");
    try {
      await store.initializeVault();
      const task = await store.createTask({ title: "虚构样品盒贴签" });
      const other = await store.createTask({ title: "虚构样品盒盘点" });
      const taskIds = async () => (await store.readTaskDb()).tasks.map(task => task.id);
      await say("delete", `删除${task.title}`);
      expect(speak.mock.calls[0][0]).toBe(`要删除任务「${task.title}」吗？`);
      expect(await taskIds()).toEqual(expect.arrayContaining([task.id, other.id]));
      currentText = "是";
      await sendManagedVoiceTurn(view);
      expect(execute).not.toHaveBeenCalled();
      await say("answer", `${answer}。`);
      handleCascadeCapture(view, endpoint, { type: "final", itemId: "answer", text: `${answer}。` });
      expect(execute).toHaveBeenCalledTimes(approved ? 1 : 0);
      expect(submit).toHaveBeenCalledOnce();
      expect(view.pendingAgentActions).toEqual([]);
      expect(new Set(await taskIds())).toEqual(new Set(approved ? [other.id] : [task.id, other.id]));
      const receipt = approved ? "已删除 1 个任务。" : "好，这项已取消。";
      expect(speak.mock.calls.at(-1)?.[0]).toBe(receipt);
      expect(save).toHaveBeenCalledWith(`${answer}。`, receipt, expect.any(Function));
      expect(review).not.toHaveBeenCalled();
    } finally {
      review.mockRestore();
      local.mockRestore();
      await output.actor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the LifeOps brain and releases the turn when an Omni response fails", async () => {
    const runtime = new VoiceSessionController({ provider: "qwen-test" });
    runtime.connect();
    runtime.connected();
    runtime.beginTurn({ route: "e2e", transcript: "帮我看看今天的日记" });
    runtime.transitionTurn("endpointing");
    runtime.transitionTurn("routing");
    runtime.transitionTurn("generating");
    runtime.bindResponse("response-a");
    const cancelResponse = vi.fn();
    const reply = "今天的日记重点是休息和恢复。";
    let releaseFallback!: () => void;
    const fallbackReady = new Promise<void>(resolve => { releaseFallback = resolve; });
    const submitAgentMessageStream = vi.fn(async (
      _message: string,
      _history: unknown[],
      onText: (content: string) => void
    ) => {
      await fallbackReady;
      onText(reply);
      return { reply, actions: [] };
    });
    const view = {
      controller: {
        settings: {
          realtimeVoice: {
            ...TEST_REALTIME_SETTINGS,
            mode: "omni-e2e",
            speakReplies: false
          }
        },
        submitAgentMessageStream,
        appendQualityLog: vi.fn(async () => undefined),
        appendAgentConversation: vi.fn(async () => undefined)
      },
      agentVoiceRuntime: runtime,
      agentRealtimeClient: {
        cancelResponse,
        appendAssistantMessage: vi.fn()
      },
      agentAudioOutput: { cancel: vi.fn() },
      agentTtsClient: null,
      agentVoiceSendInFlight: true,
      agentBusy: true,
      agentRecording: true,
      agentSpeaking: false,
      agentMode: "voice",
      agentMessages: [
        { role: "user", content: "帮我看看今天的日记" },
        { role: "assistant", content: "" }
      ],
      agentOmniE2eAssistantIndex: 1,
      agentOmniE2eReply: "",
      agentOmniE2eActionSuggestions: 0,
      agentOmniE2eUserMessage: "帮我看看今天的日记",
      agentOmniE2eStreamMessageEl: {},
      agentOmniPendingAudio: [],
      agentOmniPlaybackReady: null,
      agentVoiceFallbackReason: "",
      agentVoiceResponseTimer: 0,
      agentVoiceFallbackTimer: 0,
      agentVoiceTrace: {},
      agentCameraPersonaHint: "",
      pendingAgentActions: [],
      voiceSession: createVoiceSession(),
      updateAgentMessage: vi.fn(),
      markVoiceTrace: vi.fn(),
      refreshAgentSurfaceState: vi.fn(),
      setAgentMessageBubbleContent: vi.fn(),
      scrollAgentTranscriptToBottom: vi.fn(),
      refreshAgentSuggestions: vi.fn(),
      appendAgentQualityLog: vi.fn(async () => undefined),
      setAgentBusy: vi.fn((busy: boolean) => {
        view.agentBusy = busy;
      }),
      currentVoiceMessageText: () => "",
      resetCurrentVoiceTurnDraft: vi.fn(),
      transitionVoiceSession: vi.fn()
    } as any;

    const fallback = fallbackOmniResponseToBrain(view, "provider failed", {
      eventType: "response.failed",
      responseId: "response-a",
      status: "failed"
    });

    await vi.waitFor(() => expect(submitAgentMessageStream).toHaveBeenCalledOnce());
    handleOmniE2eResponseCreated(view, { eventType: "response.created", responseId: "late-response", status: "in_progress" });
    await finishOmniE2eVoiceTurn(view, "迟到的虚构原生回复", {
      eventType: "response.done", responseId: "response-a", status: "completed"
    });
    expect(runtime.snapshot().currentTurn).toMatchObject({ route: "brain", phase: "generating", modelDone: false });
    expect(view.agentOmniE2eReply).toBe("");
    releaseFallback();
    await fallback;

    expect(cancelResponse).toHaveBeenCalledTimes(1);
    expect(submitAgentMessageStream).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().currentTurn).toMatchObject({
      route: "brain",
      phase: "completed",
      assistantText: reply
    });
    expect(view.agentVoiceSendInFlight).toBe(false);
    expect(view.agentBusy).toBe(false);
  });

  it("moves a dropped voice session into bounded reconnect recovery", () => {
    vi.useFakeTimers();
    const runtime = new VoiceSessionController({ provider: "qwen-test" });
    runtime.connect();
    runtime.connected();
    runtime.beginTurn({ route: "e2e", transcript: "你好" });
    runtime.transitionTurn("endpointing");
    runtime.transitionTurn("routing");
    runtime.transitionTurn("generating");
    const recordFailure = vi.fn();
    const view = {
      controller: {
        settings: {
          realtimeVoice: {
            ...TEST_REALTIME_SETTINGS,
            provider: "qwen-omni-realtime"
          }
        },
        appendQualityLog: vi.fn(async () => undefined)
      },
      agentMode: "voice",
      agentVoiceConversation: true,
      agentRecording: true,
      agentVoiceReady: true,
      agentVoiceRuntime: runtime,
      agentVoiceCircuitBreaker: { recordFailure },
      agentVoiceBargeIn: { reset: vi.fn() },
      agentAudioOutput: { cancel: vi.fn() },
      agentTtsClient: null,
      agentVoiceSendInFlight: false,
      agentOmniPendingAudio: [],
      agentOmniPlaybackReady: null,
      agentVoiceFallbackReason: "",
      agentVoiceResponseTimer: 0,
      agentVoiceFallbackTimer: 0,
      agentVoiceReconnectTimer: 0,
      agentVoiceReconnectAttempts: 0,
      agentAudioProcessor: null,
      agentAudioSource: null,
      agentAudioContext: null,
      agentAudioWorklet: null,
      agentVoiceLocalSpeechActive: false,
      agentVoiceLocalSpeechStartedAt: 0,
      agentVoiceLocalLastSpeechAt: 0,
      agentVoiceIgnoreSpeechStartUntil: 0,
      clearVoiceWarmupTimer: vi.fn(),
      clearVoiceLocalEndpointTimer: vi.fn(),
      clearVoiceNoTranscriptTimer: vi.fn(),
      cleanupAgentMedia: vi.fn(),
      setAgentBusy: vi.fn(),
      transitionVoiceSession: vi.fn(),
      refreshAgentSurfaceState: vi.fn()
    } as any;

    handleRealtimeDisconnect(view, 1006, "connection dropped");
    handleRealtimeDisconnect(view, 1006, "duplicate close event");

    expect(runtime.snapshot().sessionPhase).toBe("recovering");
    expect(view.agentVoiceReconnectAttempts).toBe(1);
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(view.agentReply).toContain("正在重连（1/5）");
    expect(view.agentVoiceReconnectTimer).not.toBe(0);
    window.clearTimeout(view.agentVoiceReconnectTimer);
  });

  it("returns an explicit tool result when a voice tool call fails", async () => {
    const appendQualityLog = vi.fn(async () => undefined);
    const view = {
      controller: {
        settings: {
          realtimeVoice: {
            ...TEST_REALTIME_SETTINGS,
            mode: "omni-e2e"
          }
        },
        executeAgentToolCall: vi.fn(async () => {
          throw new Error("Vault 文件不可写");
        }),
        appendQualityLog
      },
      agentVoiceRuntime: null,
      agentVoiceSendInFlight: true,
      agentOmniE2eAssistantIndex: 0,
      agentOmniE2eReply: "",
      agentMessages: [{ role: "assistant", content: "" }],
      agentVoiceTrace: {},
      agentReply: "",
      setAgentMessageBubbleContent: vi.fn(),
      scrollAgentTranscriptToBottom: vi.fn(),
      refreshAgentSurfaceState: vi.fn(),
      markVoiceTrace: vi.fn()
    } as any;

    const result = await executeOmniE2eToolCall(view, {
      id: "tool-a",
      name: "create_task",
      arguments: { title: "测试任务" }
    });

    expect(result).toContain("create_task");
    expect(result).toContain("Vault 文件不可写");
    expect(result).toContain("本次操作没有完成");
    expect(appendQualityLog).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "omni_tool_call_failed"
    }));
  });

  it("ducks on suspected barge-in, restores noise, and cancels only after confirmation", () => {
    const runtime = new VoiceSessionController({ provider: "qwen-test" });
    runtime.connect();
    runtime.connected();
    const turn = runtime.beginTurn({ route: "e2e", transcript: "旧问题" });
    runtime.transitionTurn("endpointing");
    runtime.transitionTurn("routing");
    runtime.transitionTurn("generating");
    runtime.bindPlayback("playback-a");

    const cancelResponse = vi.fn();
    turn.abortController.signal.addEventListener("abort", () => {
      if (runtime.snapshot().currentTurn?.phase === "interrupted") cancelResponse();
    });
    const output = {
      duck: vi.fn(() => true),
      restore: vi.fn(() => true),
      cancel: vi.fn(() => true)
    };
    let view: any;
    const bargeIn = new VoiceBargeInController({
      onEvent: (event) => handleOmniE2eBargeInEvent(view, event)
    });
    view = {
      controller: {
        settings: {
          realtimeVoice: {
            ...TEST_REALTIME_SETTINGS,
            mode: "omni-e2e"
          }
        }
      },
      agentVoiceRuntime: runtime,
      agentVoiceBargeIn: bargeIn,
      agentAudioOutput: output,
      agentVoiceSendInFlight: true,
      agentBusy: true,
      agentSpeaking: true,
      agentRealtimeClient: { cancelResponse },
      agentOmniPendingAudio: [],
      agentOmniPlaybackReady: Promise.resolve(),
      agentOmniE2eAssistantIndex: 1,
      agentOmniE2eReply: "旧回答",
      agentOmniE2eStreamMessageEl: null,
      agentMessages: [
        { role: "user", content: "旧问题" },
        { role: "assistant", content: "" }
      ],
      voiceDisplayInput: (text: string) => text,
      clearVoiceAutoSendTimer: vi.fn(),
      appendVoiceMetric: vi.fn(),
      invalidateVoicePipeline: vi.fn(),
      setAgentBusy: vi.fn((busy: boolean) => {
        view.agentBusy = busy;
      }),
      transitionVoiceSession: vi.fn(),
      refreshAgentSurfaceState: vi.fn(),
      setAgentMessageBubbleContent: vi.fn()
    };

    handleOmniE2eSpeechStarted(view);
    expect(bargeIn.snapshot().phase).toBe("suspected");
    expect(output.duck).toHaveBeenCalledWith("playback-a", 0.18, 80);
    expect(cancelResponse).not.toHaveBeenCalled();

    handleOmniE2eSpeechStopped(view);
    expect(bargeIn.snapshot().phase).toBe("idle");
    expect(output.restore).toHaveBeenCalledWith("playback-a", 120);
    expect(runtime.snapshot().currentTurn?.phase).toBe("generating");

    handleOmniE2eSpeechStarted(view);
    observeOmniE2eBargeInTranscript(view, "等一下，我还没说完");

    expect(runtime.snapshot().currentTurn?.phase).toBe("interrupted");
    expect(cancelResponse).toHaveBeenCalledOnce();
    expect(view.agentVoiceSendInFlight).toBe(false);
    expect(view.agentBusy).toBe(false);
  });

  it("uses the same reversible barge-in gate for cascade turns", () => {
    const runtime = new VoiceSessionController({ provider: "qwen-test" });
    runtime.connect();
    runtime.connected();
    runtime.beginTurn({ route: "brain", transcript: "旧问题" });
    runtime.transitionTurn("endpointing");
    runtime.transitionTurn("routing");
    runtime.transitionTurn("generating");

    let view: any;
    const bargeIn = new VoiceBargeInController({
      onEvent: (event) => handleOmniE2eBargeInEvent(view, event)
    });
    view = {
      controller: {
        settings: {
          realtimeVoice: {
            ...TEST_REALTIME_SETTINGS,
            mode: "cascade"
          }
        }
      },
      agentVoiceRuntime: runtime,
      agentVoiceBargeIn: bargeIn,
      agentVoiceSendInFlight: true,
      agentBusy: true,
      agentSpeaking: false,
      agentRealtimeClient: { cancelResponse: vi.fn() },
      agentOmniPendingAudio: [],
      agentOmniPlaybackReady: null,
      agentOmniE2eAssistantIndex: 1,
      agentOmniE2eReply: "",
      agentOmniE2eStreamMessageEl: null,
      agentMessages: [
        { role: "user", content: "旧问题" },
        { role: "assistant", content: "" }
      ],
      voiceDisplayInput: (text: string) => text,
      clearVoiceAutoSendTimer: vi.fn(),
      appendVoiceMetric: vi.fn(),
      invalidateVoicePipeline: vi.fn(),
      setAgentBusy: vi.fn((busy: boolean) => {
        view.agentBusy = busy;
      }),
      transitionVoiceSession: vi.fn(),
      refreshAgentSurfaceState: vi.fn(),
      setAgentMessageBubbleContent: vi.fn()
    };

    handleOmniE2eSpeechStarted(view);
    observeOmniE2eBargeInTranscript(view, "嗯");
    expect(bargeIn.snapshot().phase).toBe("suspected");
    expect(runtime.snapshot().currentTurn?.phase).toBe("generating");

    handleOmniE2eSpeechStopped(view);
    expect(bargeIn.snapshot().phase).toBe("idle");
    expect(runtime.snapshot().currentTurn?.phase).toBe("generating");

    handleOmniE2eSpeechStarted(view);
    observeOmniE2eBargeInTranscript(view, "等一下，我换一个问题");

    expect(runtime.snapshot().currentTurn?.phase).toBe("interrupted");
    expect(view.agentVoiceSendInFlight).toBe(false);
    expect(view.agentBusy).toBe(false);
  });

  it("does not let local RMS noise endpoint an Omni turn", () => {
    const handleVoiceSpeechStarted = vi.fn();
    const view = {
      agentVoiceReady: true,
      agentMode: "voice",
      controller: {
        settings: {
          realtimeVoice: {
            ...TEST_REALTIME_SETTINGS,
            mode: "omni-e2e"
          }
        }
      },
      handleVoiceSpeechStarted
    } as any;

    observeLocalVoiceEnergy(view, Float32Array.from({ length: 1024 }, () => 0.9));

    expect(handleVoiceSpeechStarted).not.toHaveBeenCalled();
  });

  it("streams Qwen-Omni assistant text from audio transcript events", async () => {
    const callbacks = {
      onResponseTextDelta: vi.fn(),
      onResponseDone: vi.fn(),
      onError: vi.fn()
    };
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      mode: "omni-e2e",
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime",
      model: "qwen-test",
      omniVoice: "Tina"
    }, callbacks, { mode: "omni-e2e" });

    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;

    client.createResponse();
    socket.emit("message", JSON.stringify({ type: "response.audio_transcript.delta", delta: "当然" }));
    socket.emit("message", JSON.stringify({ type: "response.audio_transcript.delta", delta: "可以。" }));
    socket.emit("message", JSON.stringify({ type: "response.done" }));

    expect(callbacks.onResponseTextDelta).toHaveBeenNthCalledWith(1, "当然", {
      eventType: "response.audio_transcript.delta",
      responseId: "",
      status: ""
    });
    expect(callbacks.onResponseTextDelta).toHaveBeenNthCalledWith(2, "当然可以。", {
      eventType: "response.audio_transcript.delta",
      responseId: "",
      status: ""
    });
    expect(callbacks.onResponseDone).toHaveBeenCalledWith("当然可以。", {
      eventType: "response.done",
      responseId: "",
      status: ""
    });
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("uses completed audio transcript text when text deltas are absent", async () => {
    const callbacks = {
      onResponseTextDelta: vi.fn(),
      onResponseDone: vi.fn()
    };
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      mode: "omni-e2e",
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime",
      model: "qwen-test"
    }, callbacks, { mode: "omni-e2e" });

    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;

    client.createResponse();
    socket.emit("message", JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "message",
        content: [{ type: "audio", transcript: "我已经帮你创建好了。" }]
      }
    }));
    socket.emit("message", JSON.stringify({ type: "response.done" }));

    expect(callbacks.onResponseTextDelta).toHaveBeenCalledWith("我已经帮你创建好了。", {
      eventType: "response.output_item.done",
      responseId: "",
      status: ""
    });
    expect(callbacks.onResponseDone).toHaveBeenCalledWith("我已经帮你创建好了。", {
      eventType: "response.done",
      responseId: "",
      status: ""
    });
  });

  it("keeps the response text when a later audio transcript also arrives", async () => {
    const callbacks = {
      onResponseTextDelta: vi.fn(),
      onResponseDone: vi.fn()
    };
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      mode: "omni-e2e",
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime",
      model: "qwen-test"
    }, callbacks, { mode: "omni-e2e" });

    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;

    client.createResponse();
    socket.emit("message", JSON.stringify({ type: "response.audio_transcript.delta", delta: "虚构语音预览" }));
    socket.emit("message", JSON.stringify({ type: "response.text.delta", delta: "已核对的虚构原文。" }));
    socket.emit("message", JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "message",
        content: [{ type: "audio", transcript: "我已经帮你创建好了。" }]
      }
    }));
    socket.emit("message", JSON.stringify({ type: "response.done" }));

    expect(callbacks.onResponseTextDelta).toHaveBeenCalledTimes(2);
    expect(callbacks.onResponseTextDelta).toHaveBeenLastCalledWith("已核对的虚构原文。", {
      eventType: "response.text.delta",
      responseId: "",
      status: ""
    });
    expect(callbacks.onResponseDone).toHaveBeenCalledWith("已核对的虚构原文。", {
      eventType: "response.done",
      responseId: "",
      status: ""
    });
  });

  it("reports realtime transcription failures instead of silently ignoring them", async () => {
    const callbacks = {
      onOpen: vi.fn(),
      onTranscriptDelta: vi.fn(),
      onError: vi.fn()
    };
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime"
    }, callbacks);

    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;

    socket.emit("message", JSON.stringify({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "Language code is not recognized" }
    }));

    expect(callbacks.onError).toHaveBeenCalledWith("Language code is not recognized");
    expect(callbacks.onTranscriptDelta).not.toHaveBeenCalled();
  });

  it("reports passive realtime socket closes even when the code is normal", async () => {
    const callbacks = {
      onOpen: vi.fn(),
      onError: vi.fn()
    };
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime"
    }, callbacks);

    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;
    socket.emit("close", 1000, Buffer.from("server closed"));

    expect(callbacks.onError).toHaveBeenCalledWith("server closed");
  });

  it("rejects connection setup when the socket closes before opening", async () => {
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime"
    });
    const connected = client.connect();
    const rejection = expect(connected).rejects.toThrow("连接关闭：1000");
    websocketMock.instances[0].emit("close", 1000, Buffer.alloc(0));
    await rejection;
    client.close();
  });

  it("exposes passive realtime disconnects as typed lifecycle events", async () => {
    const callbacks = {
      onDisconnected: vi.fn(),
      onError: vi.fn()
    };
    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime"
    }, callbacks);

    const connected = client.connect();
    const socket = websocketMock.instances[0];
    socket.emit("open");
    await connected;
    socket.emit("close", 1011, Buffer.from("upstream restarted"));

    expect(callbacks.onDisconnected).toHaveBeenCalledWith({
      code: 1011,
      reason: "upstream restarted"
    });
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("reports passive TTS socket closes instead of swallowing code 1000", async () => {
    const callbacks = {
      onOpen: vi.fn(),
      onError: vi.fn()
    };
    const client = new BailianRealtimeTtsClient({
      ...TEST_REALTIME_SETTINGS,
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime"
    }, callbacks);

    const speaking = client.speak("你好");
    const rejection = expect(speaking).rejects.toThrow("连接关闭：1000");
    const socket = websocketMock.instances[0];
    socket.emit("open");
    socket.emit("close", 1000, Buffer.alloc(0));
    await rejection;

    expect(callbacks.onError).toHaveBeenCalledWith("连接关闭：1000");
  });

  it("rejects a realtime WebSocket connection that never opens", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
      btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    });

    const client = new BailianRealtimeClient({
      ...TEST_REALTIME_SETTINGS,
      apiKey: "test-key",
      endpoint: "wss://example.test/realtime"
    });
    const connected = client.connect();
    expect(websocketMock.instances).toHaveLength(1);
    const rejection = expect(connected).rejects.toThrow(BailianConnectionTimeoutError);

    await vi.advanceTimersByTimeAsync(12_000);

    await rejection;
    expect(websocketMock.instances[0].readyState).toBe(websocketMock.MockWebSocket.CLOSED);
  });
});
