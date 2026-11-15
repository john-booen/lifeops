import type { BailianRealtimeClient } from "../../bailianRealtime";
import type { RealtimeInstructionsBoundary } from "./instructionsBoundary";
import type { VoiceSessionController } from "../voiceRuntime";

export const CONTEXT_CHANGED_MESSAGE = "语音资料刚刚变化，旧回复已停止。请重新查询。";

interface OmniContextView {
  agentRealtimeClient?: Pick<BailianRealtimeClient, "close"> | null;
  agentVoiceRuntime?: Pick<VoiceSessionController, "snapshot">;
  agentTextRequestGeneration?: number;
  agentRealtimeStartGeneration?: number;
  viewClosed?: boolean;
  agentReply: string;
  agentAudioOutput?: { cancel?(playbackId: string, reason: string): void };
  transitionVoiceSession?: unknown;
  clearVoiceWarmupTimer?: unknown;
  currentVoiceMessageText?: unknown;
  refreshAgentSurfaceState?(): void;
}

export function withdrawOmniContext<View extends OmniContextView>(
  view: View,
  message: string,
  withdrawText: () => void,
  failTurn: () => void,
  stopRecording: (view: View, silent: true) => Promise<void>
): void {
  const client = view.agentRealtimeClient;
  const runtime = view.agentVoiceRuntime;
  const turn = runtime?.snapshot().currentTurn;
  const textGeneration = view.agentTextRequestGeneration;
  const captureGeneration = view.agentRealtimeStartGeneration;
  const ownsPresentation = () => !view.viewClosed && view.agentVoiceRuntime === runtime
    && view.agentTextRequestGeneration === textGeneration;
  const ownsCapture = () => ownsPresentation() && view.agentRealtimeClient === client
    && view.agentRealtimeStartGeneration === captureGeneration
    && runtime?.snapshot().currentTurn?.turnId === turn?.turnId;
  if (!ownsCapture()) return;
  withdrawText();
  if (!ownsCapture()) return;
  // Retire the turn before callbacks from playback cancellation can run.
  failTurn();
  if (!ownsCapture()) return;
  if (turn?.playbackId) view.agentAudioOutput?.cancel?.(turn.playbackId, "query_context_changed");
  if (!ownsCapture()) return;
  if (!(view.transitionVoiceSession && view.clearVoiceWarmupTimer && view.currentVoiceMessageText)) {
    client?.close();
    return;
  }
  // Silent stop invalidates provider callbacks before it closes the connection.
  const stopped = stopRecording(view, true);
  const stoppedGeneration = view.agentRealtimeStartGeneration;
  void stopped.finally(() => {
    if (!ownsPresentation() || view.agentRealtimeStartGeneration !== stoppedGeneration) return;
    view.agentReply = message;
    view.refreshAgentSurfaceState?.();
  }).catch(() => undefined);
}

type ProtectedContextClient = Pick<BailianRealtimeClient, "assertContextSourcesCurrent" | "assertContextSourcesCurrentNow">;

export async function checkActiveOmniSources(
  view: { agentRealtimeClient?: BailianRealtimeClient | null },
  capturePresentation: () => () => boolean,
  onInvalid: () => void
): Promise<boolean> {
  const client = view.agentRealtimeClient;
  if (!client?.hasProtectedContextSources?.()) return true;
  const presentationCurrent = capturePresentation();
  return checkContextSources(client, () => view.agentRealtimeClient === client && presentationCurrent(), onInvalid);
}

export async function checkContextSources(client: ProtectedContextClient, isCurrent: () => boolean, onInvalid: () => void): Promise<boolean> {
  try {
    await client.assertContextSourcesCurrent();
    if (!isCurrent()) return false;
    client.assertContextSourcesCurrentNow();
    return true;
  } catch {
    if (isCurrent()) onInvalid();
    return false;
  }
}

interface ResponseContextHost {
  hasProtectedSources(): boolean;
  assertSourcesCurrent(): Promise<void>;
  assertSourcesCurrentNow(): void;
}

export async function prepareOmniResponseContext(
  host: ResponseContextHost,
  instructions: RealtimeInstructionsBoundary | undefined,
  current: () => boolean,
  send: () => void
): Promise<void> {
  await host.assertSourcesCurrent();
  if (!current()) return;
  const snapshot = await instructions?.prepareForResponse(current);
  try {
    if (!current()) return;
    if (host.hasProtectedSources()) await host.assertSourcesCurrent();
    if (!current()) return;
    await snapshot?.assertSourcesCurrent?.();
    if (!current()) return;
    snapshot?.assertCurrent();
    await host.assertSourcesCurrent();
    if (!current()) return;
    snapshot?.assertCurrent();
    host.assertSourcesCurrentNow();
    send();
  } finally { snapshot?.dispose(); }
}
