import type { RealtimeVoiceSettings } from "./types";
import { voiceVadSilenceMs } from "./voice/continuousInput";
import { asrHotwords } from "./voice/realtimeAsrOptions";

export function migrateRealtimeVoiceSettings(settings: RealtimeVoiceSettings): RealtimeVoiceSettings {
  const breeze = { home: "", python: "", referenceAudio: "", referenceText: "" };
  for (const key of Object.keys(breeze) as Array<keyof typeof breeze>) {
    const value = settings.breeze?.[key];
    if (typeof value === "string") breeze[key] = value;
  }
  return { ...settings, mode: "cascade", vadSilenceMs: voiceVadSilenceMs(settings.vadSilenceMs), breeze,
    asrEngine: settings.asrEngine === "streaming-hotwords" ? settings.asrEngine : "realtime",
    asrHotwords: asrHotwords(settings.asrHotwords).join("\n") };
}
