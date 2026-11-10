import type { VoiceMetricEntry, VoiceMetricEvent } from "./types";
import { voiceLatencyStages } from "./voice/latency";

export interface SerializedVoiceMetricEntry {
  loggedAt: string;
  event: VoiceMetricEvent;
  provider?: string;
  model?: string;
  mode?: "voice" | "text";
  phase?: string;
  captureMode?: string;
  queueLength?: number;
  generation?: number;
  latency?: VoiceMetricEntry["latency"];
  textLength?: number;
  reason?: string;
  asrFirstMs?: number;
  asrDoneMs?: number;
  modelFirstMs?: number;
  modelDoneMs?: number;
  ttsFirstMs?: number;
  ttsDoneMs?: number;
  totalMs?: number;
  bargeInCommandMs?: number;
  actionSuggestions?: number;
  errorCode?: string;
  errorMessage?: string;
}

const STRING_LIMITS: Partial<Record<keyof SerializedVoiceMetricEntry, number>> = {
  provider: 80,
  model: 120,
  phase: 40,
  captureMode: 60,
  reason: 180,
  errorCode: 120,
  errorMessage: 300
};

const NUMERIC_KEYS: Array<keyof SerializedVoiceMetricEntry> = [
  "queueLength",
  "generation",
  "textLength",
  "asrFirstMs",
  "asrDoneMs",
  "modelFirstMs",
  "modelDoneMs",
  "ttsFirstMs",
  "ttsDoneMs",
  "totalMs",
  "bargeInCommandMs",
  "actionSuggestions"
];

export function serializeVoiceMetricEntry(entry: VoiceMetricEntry, loggedAt = new Date().toISOString()): string {
  return JSON.stringify(normalizeVoiceMetricEntry(entry, loggedAt));
}

export function normalizeVoiceMetricEntry(entry: VoiceMetricEntry, loggedAt = new Date().toISOString()): SerializedVoiceMetricEntry {
  const normalized: SerializedVoiceMetricEntry = {
    loggedAt,
    event: entry.event
  };

  assignString(normalized, "provider", entry.provider);
  assignString(normalized, "model", entry.model);
  if (entry.mode === "voice" || entry.mode === "text") normalized.mode = entry.mode;
  assignString(normalized, "phase", entry.phase);
  assignString(normalized, "captureMode", entry.captureMode);
  assignString(normalized, "reason", entry.reason);
  assignString(normalized, "errorCode", entry.errorCode);
  assignString(normalized, "errorMessage", entry.errorMessage);

  if (entry.latency) {
    const latency = Object.fromEntries(voiceLatencyStages.flatMap(stage => {
      const value = entry.latency?.[stage];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? [[stage, Math.round(value)]] : [];
    }));
    if (Object.keys(latency).length) normalized.latency = latency;
  }

  for (const key of NUMERIC_KEYS) {
    assignNumber(normalized, key, entry[key as keyof VoiceMetricEntry]);
  }

  return normalized;
}

function assignString<T extends keyof SerializedVoiceMetricEntry>(
  target: SerializedVoiceMetricEntry,
  key: T,
  value: unknown
): void {
  if (typeof value !== "string") return;
  const limit = STRING_LIMITS[key] ?? 120;
  const cleaned = value.replace(/\s+/g, " ").trim().slice(0, limit);
  if (!cleaned) return;
  target[key] = cleaned as SerializedVoiceMetricEntry[T];
}

function assignNumber<T extends keyof SerializedVoiceMetricEntry>(
  target: SerializedVoiceMetricEntry,
  key: T,
  value: unknown
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  target[key] = Math.max(0, Math.round(value)) as SerializedVoiceMetricEntry[T];
}
