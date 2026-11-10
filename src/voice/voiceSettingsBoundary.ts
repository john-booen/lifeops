import { createHash } from "node:crypto";
import type { LifeOpsSettings } from "../types";

/** Memory-only comparison; neither credentials nor this digest are persisted or logged. */
export function voiceSettingsRevision(settings: LifeOpsSettings): string {
  const { confidenceThreshold: _confidence, ...ai } = settings.ai;
  const {
    speakReplies: _speakReplies, autoSendOnStop: _autoSend,
    triggerEnabled: _trigger, triggerPhrases: _phrases, triggerSessionTimeoutSec: _timeout,
    ...realtimeVoice
  } = settings.realtimeVoice;
  return createHash("sha256").update(JSON.stringify({
    ai, realtimeVoice, voice: settings.voice,
    credentialStorageAccepted: settings.privacy?.plaintextCredentialStorageAccepted === true,
    excludedVaultPrefixes: [...(settings.privacy?.excludedVaultPrefixes ?? [])].sort()
  })).digest("hex");
}
