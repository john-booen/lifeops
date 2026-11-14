import type { AiToolCall } from "../../ai";
import type { BailianRealtimeCallbacks, BailianRealtimeOptions, BailianRealtimeResponseEvent } from "../../bailianRealtime";
import { agentToolsForRealtime } from "../../toolRegistry";
import type { RealtimeToolOutput } from "../realtimeToolOutput";
import { buildOmniE2eInstructions } from "./instructions";

interface OmniSessionView {
  agentVoiceReady: boolean;
  agentRecording: boolean;
  agentRealtimeClient: unknown;
  markVoiceTrace(event: "firstTranscript" | "transcriptDone"): void;
  updateRealtimeTranscript(text: string, final?: boolean): void;
  handleVoiceSpeechStopped(source: "server-vad", final: false): void;
  controller: { appendQualityLog(event: { inputSource: "voice"; errorCode: string }): Promise<unknown> };
}

interface OmniSessionHandlers<View extends OmniSessionView> {
  observeTranscript(view: View, text: string): void;
  sendVoiceTurn(view: View, reason: string): Promise<void>;
  speechStarted(view: View): void;
  speechStopped(view: View): void;
  responseCreated(view: View, response: BailianRealtimeResponseEvent): void;
  responseText(view: View, text: string, response: BailianRealtimeResponseEvent): void;
  audioDelta(view: View, audio: string, sampleRate: number, response: BailianRealtimeResponseEvent): void;
  audioDone(view: View, response: BailianRealtimeResponseEvent): void;
  responseDone(view: View, text: string, response: BailianRealtimeResponseEvent): Promise<void>;
  responseFailed(view: View, message: string, response: BailianRealtimeResponseEvent): Promise<void>;
  executeTool(view: View, call: AiToolCall): Promise<string | RealtimeToolOutput>;
  toolContextError(view: View, message: string): void;
  toolCommitted(view: View, text: string, response: BailianRealtimeResponseEvent): Promise<void>;
  stopRecording(view: View, cancel: boolean): Promise<void>;
}

export function omniSessionOptions(context: string): BailianRealtimeOptions {
  return { instructions: buildOmniE2eInstructions(context), tools: agentToolsForRealtime(), maxModelRetries: 5 };
}

export function createOmniCallbacks<View extends OmniSessionView>(view: View, host: OmniSessionHandlers<View>): BailianRealtimeCallbacks {
  const transcript = (text: string, final: boolean) => {
    if (!view.agentVoiceReady) return;
    view.markVoiceTrace(final ? "transcriptDone" : "firstTranscript");
    host.observeTranscript(view, text);
    view.updateRealtimeTranscript(text, final);
    if (final) void host.sendVoiceTurn(view, "semantic_vad transcript completed");
  };
  return {
    onTranscriptDelta: text => transcript(text, false),
    onTranscriptDone: text => transcript(text, true),
    onSpeechStarted: () => host.speechStarted(view),
    onSpeechStopped: () => {
      host.speechStopped(view);
      view.handleVoiceSpeechStopped("server-vad", false);
    },
    onSpeechRejected: () => host.speechStopped(view),
    onResponseCreated: response => host.responseCreated(view, response),
    onResponseTextDelta: (text, response) => host.responseText(view, text, response),
    onAudioDelta: (audio, rate, response) => host.audioDelta(view, audio, rate, response),
    onResponseAudioDone: response => host.audioDone(view, response),
    onResponseDone: (text, response) => { void host.responseDone(view, text, response); },
    onResponseFailed: (message, response) => { void host.responseFailed(view, message, response); },
    onToolCall: call => host.executeTool(view, call),
    onToolContextError: message => host.toolContextError(view, message),
    onToolCommitted: (text, response) => { void host.toolCommitted(view, text, response); },
    onToolSessionRetired: () => {
      if (view.agentRecording && view.agentRealtimeClient) void host.stopRecording(view, true);
    },
    onModelRetry: () => {
      void view.controller.appendQualityLog({ inputSource: "voice", errorCode: "qwen_omni_model_retry" }).catch(() => undefined);
    }
  };
}
