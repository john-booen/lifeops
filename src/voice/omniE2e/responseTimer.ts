import type { VoiceSessionController } from "../voiceRuntime";

const RESPONSE_TIMEOUT_MS = 20_000;

interface OmniResponseTimerState {
  agentVoiceRuntime?: VoiceSessionController;
  agentVoiceResponseTimer: number;
}

export function armOmniResponseTimer(
  view: OmniResponseTimerState,
  onTimeout: (message: string) => void
): void {
  clearOmniResponseTimer(view);
  const runtime = view.agentVoiceRuntime;
  const turn = runtime?.snapshot().currentTurn;
  if (!runtime || turn?.route !== "e2e") return;
  const { generation, turnId } = turn;
  const timer = window.setTimeout(() => {
    if (view.agentVoiceResponseTimer !== timer) return;
    view.agentVoiceResponseTimer = 0;
    if (view.agentVoiceRuntime !== runtime || !runtime.accepts({ generation, turnId })) return;
    const latest = runtime.snapshot().currentTurn;
    if (latest?.route !== "e2e" || latest.modelDone) return;
    onTimeout("Qwen-Omni response timeout after 20s");
  }, RESPONSE_TIMEOUT_MS);
  view.agentVoiceResponseTimer = timer;
}

export function clearOmniResponseTimer(view: OmniResponseTimerState): void {
  if (view.agentVoiceResponseTimer) window.clearTimeout(view.agentVoiceResponseTimer);
  view.agentVoiceResponseTimer = 0;
}
