import { detectVoiceControlEvent, shouldInterruptAssistantForTranscript } from "../../voiceSession";
import type { VoiceBargeInController } from "../voiceBargeIn";
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
