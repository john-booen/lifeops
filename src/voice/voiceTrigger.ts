import type { LifeOpsSettings } from "../types";

export interface VoiceTriggerMatch {
  start: number;
  end: number;
}

export interface NormalizedVoiceTriggerText {
  value: string;
  map: Array<{ start: number; end: number }>;
}

export function voiceTriggerEnabled(settings: LifeOpsSettings): boolean {
  return Boolean(settings.realtimeVoice.triggerEnabled);
}

export function voiceTriggerTimeoutSec(settings: LifeOpsSettings): number {
  const value = Number(settings.realtimeVoice.triggerSessionTimeoutSec);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 45;
}

export function voiceTriggerLabel(settings: LifeOpsSettings): string {
  return parseVoiceTriggerPhrases(settings.realtimeVoice.triggerPhrases)[0] || "西西";
}

export function parseVoiceTriggerPhrases(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[,，、\n]/u)
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}

export function findVoiceTrigger(text: string, phrases: string[]): VoiceTriggerMatch | null {
  const normalizedText = normalizeVoiceTriggerText(text);
  if (!normalizedText.value) return null;

  let lastMatch: VoiceTriggerMatch | null = null;
  for (const phrase of phrases) {
    const normalizedPhrase = normalizeVoiceTriggerText(phrase).value;
    if (!normalizedPhrase) continue;
    if (/^(.)\1+$/u.test(normalizedPhrase)) {
      const char = normalizedPhrase[0];
      const runPattern = new RegExp(`${escapeRegExp(char)}{${normalizedPhrase.length},}`, "gu");
      for (const match of normalizedText.value.matchAll(runPattern)) {
        const index = match.index ?? 0;
        const endIndex = index + match[0].length - 1;
        const candidate = {
          start: normalizedText.map[index]?.start ?? 0,
          end: normalizedText.map[endIndex]?.end ?? text.length
        };
        if (!lastMatch || candidate.start >= lastMatch.start) {
          lastMatch = candidate;
        }
      }
    }
    let searchFrom = 0;
    while (searchFrom < normalizedText.value.length) {
      const index = normalizedText.value.indexOf(normalizedPhrase, searchFrom);
      if (index < 0) break;
      const endIndex = index + normalizedPhrase.length - 1;
      if (isVoiceTriggerBoundaryMatch(normalizedText.value, normalizedPhrase, index, endIndex)) {
        const candidate = {
          start: normalizedText.map[index]?.start ?? 0,
          end: normalizedText.map[endIndex]?.end ?? text.length
        };
        if (!lastMatch || candidate.start >= lastMatch.start) {
          lastMatch = candidate;
        }
      }
      searchFrom = index + 1;
    }
  }
  return lastMatch;
}

export function stripVoiceTriggers(text: string, phrases: string[]): { text: string; matched: boolean } {
  let value = text.trim();
  let matched = false;
  let guard = 0;
  while (guard < 8) {
    guard += 1;
    const match = findVoiceTrigger(value, phrases);
    if (!match) break;
    matched = true;
    value = cleanupVoiceTriggerText(`${value.slice(0, match.start)} ${value.slice(match.end)}`);
  }
  return { text: value, matched };
}

export function cleanupVoiceTriggerText(text: string): string {
  return text
    .replace(/^[\s,，。.!！?？:：;；\-—、]+/u, "")
    .replace(/[\s,，。.!！?？:：;；\-—、]+$/u, "")
    .replace(/[\s,，。.!！?？:：;；\-—、]{2,}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function voiceTranscriptFragments(text: string, minNormalizedChars: number): string[] {
  const normalizedFull = normalizeVoiceTriggerText(text).value;
  const fragments = new Set<string>();
  if (normalizedFull.length >= minNormalizedChars) fragments.add(text.trim());

  for (const part of text.split(/[。.!！?？；;\n]+/u)) {
    const value = part.trim();
    if (!value) continue;
    if (normalizeVoiceTriggerText(value).value.length >= minNormalizedChars) {
      fragments.add(value);
    }
  }

  return Array.from(fragments);
}

export function normalizeVoiceTriggerText(text: string): NormalizedVoiceTriggerText {
  let value = "";
  const map: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const char of text) {
    const start = offset;
    const end = offset + char.length;
    offset = end;
    if (!/[\p{L}\p{N}]/u.test(char)) continue;
    value += char.toLocaleLowerCase();
    map.push({ start, end });
  }
  return { value, map };
}

export function isVoiceTriggerBoundaryMatch(text: string, phrase: string, start: number, end: number): boolean {
  if (!/^[a-z0-9]+$/i.test(phrase)) return true;
  const previous = start > 0 ? text[start - 1] : "";
  const next = end + 1 < text.length ? text[end + 1] : "";
  return !/[a-z0-9]/i.test(previous) && !/[a-z0-9]/i.test(next);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
