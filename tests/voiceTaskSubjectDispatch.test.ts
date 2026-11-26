import { expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { VoiceSessionController } from "../src/voice/voiceRuntime";
import { createVoiceSession } from "../src/voiceSession";
import { sendManagedVoiceTurn } from "../src/voice/voiceRealtime";
import type { AgentConversationMessage } from "../src/types";

vi.mock("obsidian", () => ({ Notice: class {} }));

it("dispatches twelve original history messages to the brain, retaining the older task group across interruptions", async () => {
  const history = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `虚构历史${i}` }));
  history[3].content = "虚构逾期四项：蓝鲸资料、星河纸样、海盐备忘、灯塔清单。";
  const model = vi.fn(async (_message: string, _history: AgentConversationMessage[]) => ({ reply: "请核对原四项的周日安排。", actions: [] }));
  const runtime = new VoiceSessionController(); runtime.connect(); runtime.connected();
  let message = "挪到周日吧，周六也有事。";
  const view: any = {
    controller: { settings: { realtimeVoice: { ...DEFAULT_SETTINGS.realtimeVoice, provider: "qwen-omni-realtime", mode: "cascade", triggerEnabled: false, speakReplies: false } },
      submitAgentMessageStream: model, appendAgentConversation: vi.fn(async () => {}) },
    agentVoiceRuntime: runtime, agentVoiceSendInFlight: false, agentBusy: false, agentRecording: true,
    agentSpeaking: false, agentMode: "voice", agentRealtimeClient: { cancelResponse: vi.fn(), resetTranscript: vi.fn() },
    currentVoiceMessageText: () => message, voiceDisplayInput: (s: string) => s, prepareVoiceMessageForSend: (s: string) => s,
    setAgentInput: vi.fn(), tryAcceptPendingActionFromVoice: vi.fn(async () => false), queueCurrentVoiceInput: vi.fn(),
    discardCurrentVoiceTurn: vi.fn(), clearVoiceAutoSendTimer: vi.fn(), beginVoiceProcessingTrace: vi.fn(), markVoiceTrace: vi.fn(),
    rememberSentVoiceTurn: vi.fn(), clearVoiceTurnBufferAfterSend: vi.fn(() => { message = ""; }), invalidateVoicePipeline: vi.fn(),
    setAgentBusy: vi.fn((busy: boolean) => { view.agentBusy = busy; }), transitionVoiceSession: vi.fn(), appendAgentMessage: vi.fn(() => ({})),
    refreshAgentSurfaceState: vi.fn(), setAgentMessageBubbleContent: vi.fn(), scrollAgentTranscriptToBottom: vi.fn(),
    appendAgentQualityLog: vi.fn(async () => {}), appendVoiceMetric: vi.fn(), refreshAgentSuggestions: vi.fn(),
    consumeQueuedVoiceInput: vi.fn(async () => {}), resetCurrentVoiceTurnDraft: vi.fn(), scheduleVoiceAutoSend: vi.fn(),
    voiceSession: createVoiceSession(), pendingAgentActions: [], agentVoiceQueuedAfterBusy: false, agentVoicePipelineGeneration: 0,
    agentVoiceIgnoreSpeechStartUntil: 0, agentMessages: history.slice(), agentOmniE2eAssistantIndex: -1, agentOmniE2eReply: "",
    agentOmniE2eActionSuggestions: 0, agentOmniE2eUserMessage: "", agentOmniE2eStreamMessageEl: null,
    agentVoiceTrace: {}, agentVoiceResponseTimer: 0, agentVoiceFallbackTimer: 0, agentVoiceFallbackReason: "",
    agentOmniPendingAudio: [], agentOmniPlaybackReady: null, agentTtsClient: null
  };
  await sendManagedVoiceTurn(view, "fictional subject continuity");
  expect(model).toHaveBeenCalledOnce();
  expect(model.mock.calls[0]?.[1]).toEqual(history.slice(-12));
  expect(JSON.stringify(model.mock.calls[0]?.[1])).toContain(history[3].content);
  expect(runtime.snapshot().currentTurn?.phase).toBe("completed");
});
