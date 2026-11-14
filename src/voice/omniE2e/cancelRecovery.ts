import { UNCONFIRMED_VOICE_CANCEL_MESSAGE } from "../../bailianRealtime";
import type { AgentConversationMessage } from "../../types";
import type { VoiceSessionController } from "../voiceRuntime";
import { normalizeVoiceTriggerText } from "../voiceTrigger";

interface CancelRecoveryView {
  viewClosed?: boolean;
  agentMode: string;
  agentVoiceConversation: boolean;
  agentVoiceReady: boolean;
  agentRealtimeClient: object | null;
  agentVoiceRuntime?: VoiceSessionController;
  agentOmniE2eUserMessage: string;
  agentOmniE2eAssistantIndex: number;
  agentOmniE2eStreamMessageEl: HTMLElement | null;
  agentMessages: AgentConversationMessage[];
  voiceDisplayInput?(text: string): string;
  appendAgentMessage?(message: AgentConversationMessage): unknown;
  setAgentMessageBubbleContent(element: HTMLElement, text: string): void;
}

const cancelledInputs = new WeakMap<object, { text: string; client: object }>();

export function clearCancelledVoiceInput(view: object): void {
  cancelledInputs.delete(view);
}

export function canRepeatCancelledVoiceInput(view: Pick<CancelRecoveryView, "viewClosed" | "agentMode" | "agentVoiceConversation"
  | "agentVoiceReady" | "agentRealtimeClient" | "voiceDisplayInput">, text: string): boolean {
  const lost = cancelledInputs.get(view);
  const visible = view.voiceDisplayInput?.(text) ?? text;
  return Boolean(lost && !view.viewClosed && view.agentMode === "voice" && view.agentVoiceConversation
    && view.agentVoiceReady && view.agentRealtimeClient && view.agentRealtimeClient !== lost.client
    && normalizeVoiceTriggerText(visible).value === normalizeVoiceTriggerText(lost.text).value);
}

export function recordUnconfirmedOmniCancellation(view: CancelRecoveryView, reason: string): boolean {
  if (reason !== UNCONFIRMED_VOICE_CANCEL_MESSAGE) return false;
  const text = view.agentVoiceRuntime?.snapshot().currentTurn?.transcript || view.agentOmniE2eUserMessage;
  clearCancelledVoiceInput(view);
  if (text?.trim() && view.agentRealtimeClient) cancelledInputs.set(view, { text, client: view.agentRealtimeClient });

  // Preserve the notice in the visible conversation while the status reports reconnection.
  const index = view.agentOmniE2eAssistantIndex;
  const notice: AgentConversationMessage = { role: "assistant", content: reason };
  if (index >= 0 && view.agentMessages[index]?.role === "assistant") {
    const messages = view.agentMessages.slice();
    messages[index] = notice;
    view.agentMessages = messages.slice(-12);
    if (view.agentOmniE2eStreamMessageEl) view.setAgentMessageBubbleContent(view.agentOmniE2eStreamMessageEl, reason);
  } else {
    view.agentMessages = [...view.agentMessages, notice].slice(-12);
    view.appendAgentMessage?.(notice);
  }
  return true;
}
