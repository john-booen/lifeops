import { detectVoiceControlEvent, shouldInterruptAssistantForTranscript } from "../../voiceSession";
import type { AudioOutputActor } from "../audioOutput";
import type { VoiceBargeInController, VoiceBargeInEvent } from "../voiceBargeIn";
import type { VoiceSessionController } from "../voiceRuntime";

interface OmniInputView {
  agentVoiceRuntime?: VoiceSessionController;
  agentVoiceBargeIn?: VoiceBargeInController;
  voiceDisplayInput?(text: string): string | undefined;
}

export function handleOmniE2eSpeechStarted(view: OmniInputView, queueAfterPlayback: boolean): void {
  if (queueAfterPlayback) return;
  const runtime = view.agentVoiceRuntime;
  const current = runtime?.snapshot().currentTurn;
  if (
    !runtime
    || !current
    || current.phase === "completed"
    || current.phase === "interrupted"
    || current.phase === "failed"
  ) {
    return;
  }
  view.agentVoiceBargeIn?.suspect?.({
    generation: current.generation,
    turnId: current.turnId,
    playbackId: current.playbackId
  });
}

export function handleOmniE2eSpeechStopped(view: OmniInputView): void {
  view.agentVoiceBargeIn?.speechStopped?.();
}

export function observeOmniE2eBargeInTranscript(
  view: OmniInputView,
  text: string,
  queueAfterPlayback: boolean
): void {
  if (view.agentVoiceBargeIn?.snapshot?.().phase !== "suspected") return;
  const transcript = (view.voiceDisplayInput?.(text) || text).replace(/\s+/g, " ").trim();
  if (!transcript) return;
  const controlIntent = Boolean(detectVoiceControlEvent(transcript));
  if (!controlIntent && queueAfterPlayback) return;
  view.agentVoiceBargeIn.observeTranscript(transcript, {
    controlIntent,
    meaningful: shouldInterruptAssistantForTranscript({
      assistantSpeaking: true,
      transcript,
      controlEvent: controlIntent
    })
  });
}

interface OmniBargeInView extends OmniInputView {
  agentAudioOutput?: Pick<AudioOutputActor, "duck" | "restore">;
  clearVoiceAutoSendTimer?(): void;
  appendVoiceMetric?(event: "voice_speech_started" | "voice_speech_stopped", detail: { reason: string }): void;
}

export function handleOmniE2eBargeInEvent(
  view: OmniBargeInView,
  event: VoiceBargeInEvent,
  interruptTurn: (reason: string) => void
): void {
  const runtime = view.agentVoiceRuntime;
  if (!runtime) return;
  if (!runtime.accepts({
    generation: event.identity.generation,
    turnId: event.identity.turnId,
    ...(event.identity.playbackId ? { playbackId: event.identity.playbackId } : {})
  })) {
    return;
  }

  if (event.type === "suspected") {
    if (event.identity.playbackId) {
      view.agentAudioOutput?.duck?.(event.identity.playbackId, 0.18, 80);
    }
    view.clearVoiceAutoSendTimer?.();
    view.appendVoiceMetric?.("voice_speech_started", {
      reason: "barge_in_suspected"
    });
    return;
  }

  if (event.type === "false-alarm" || event.type === "reset") {
    if (event.identity.playbackId) {
      view.agentAudioOutput?.restore?.(event.identity.playbackId, 120);
    }
    if (event.type === "false-alarm") {
      view.appendVoiceMetric?.("voice_speech_stopped", {
        reason: "barge_in_false_alarm"
      });
    }
    return;
  }

  view.appendVoiceMetric?.("voice_speech_started", {
    reason: `barge_in_confirmed:${event.reason}`
  });
  interruptTurn(`barge-in confirmed: ${event.reason}`);
  view.agentVoiceBargeIn?.reset?.("barge_in_applied");
}

type NativePlaybackView = {
  agentBusy?: boolean;
  agentSpeaking?: boolean;
  agentTtsClient?: unknown;
  agentSpeechSources?: { size: number };
  agentOmniPendingAudio?: readonly unknown[];
  agentMode?: string;
  agentRecording?: boolean;
  agentVoiceConversation?: boolean;
  agentAudioOutput?: Pick<AudioOutputActor, "snapshot">;
};

/** Keep a drained native reply while its verified result finishes saving. */
export function canQueueAfterNativePlayback(view: NativePlaybackView, completeModel: boolean, playbackRuntime?: VoiceSessionController): boolean {
  if (!playbackRuntime || !view.agentBusy || view.agentSpeaking
    || view.agentTtsClient || view.agentSpeechSources?.size || view.agentOmniPendingAudio?.length || view.agentMode !== "voice"
    || !view.agentRecording || !view.agentVoiceConversation) return false;
  const current = playbackRuntime.snapshot().currentTurn;
  const output = view.agentAudioOutput?.snapshot?.();
  return Boolean(current && current.phase !== "completed" && current.phase !== "interrupted"
    && current.phase !== "failed" && (current.modelDone || completeModel) && current.playbackDrained
    && current.nativeAudioStarted && current.outputOwner === "native-e2e"
    && current.playbackId && output?.playbackId === current.playbackId
    && output.owner === "native-e2e" && output.status === "completed");
}
