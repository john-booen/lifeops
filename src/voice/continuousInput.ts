export const DEFAULT_VOICE_VAD_SILENCE_MS = 700;
export const SPEAKER_ECHO_LEVEL = 0.032;

export function voiceVadSilenceMs(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 300 && value <= 3000
    ? value : DEFAULT_VOICE_VAD_SILENCE_MS;
}

export type CascadeCaptureEvent =
  | { type: "started" | "stopped" | "rejected"; itemId: string }
  | { type: "preview" | "final"; itemId: string; text: string };

interface Capture { id: string; stopped: boolean; final?: string; delivered: boolean }

/** A realtime item is actionable only once both its stop and final text are known. */
export class ServerVoiceEndpoint {
  private capture?: Capture;

  get awaitingTranscript(): boolean { return Boolean(this.capture && !this.capture.delivered); }

  accept(event: CascadeCaptureEvent): { ready?: string } | undefined {
    if (event.type === "started") {
      if (event.itemId && this.capture?.id === event.itemId) return;
      this.capture = { id: event.itemId, stopped: false, delivered: false };
      return {};
    }
    const capture = this.capture;
    if (!capture || capture.delivered || capture.id && event.itemId && event.itemId !== capture.id) return;
    capture.id ||= event.itemId;
    if (event.type === "rejected") { capture.delivered = true; return {}; }
    if (event.type === "stopped") capture.stopped = true;
    if (event.type === "final") capture.final ??= event.text;
    if (!capture.stopped || capture.final === undefined) return {};
    capture.delivered = true;
    return { ready: capture.final };
  }
}

interface SpeakerEcho {
  useLevelGate: boolean;
  nearSpeechAt: number;
  phrases: Array<{ text: string; expires: number }>;
}
const speakerEcho = new WeakMap<object, SpeakerEcho>();
const newEcho = (useLevelGate = false): SpeakerEcho => ({ useLevelGate, nearSpeechAt: -Infinity, phrases: [] });
const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "").slice(0, 180);

export function resetSpeakerEcho(owner: object, browserEchoCancellation?: boolean): void {
  speakerEcho.set(owner, newEcho(browserEchoCancellation === false));
}

export function recordSpeakerPhrase(owner: object, phrase: string, now = performance.now()): void {
  const text = normalize(phrase);
  if (!text) return;
  const state = speakerEcho.get(owner) ?? newEcho();
  state.phrases = state.phrases.filter(item => item.expires > now).slice(-11);
  state.phrases.push({ text, expires: now + 10_000 });
  speakerEcho.set(owner, state);
}

export function isSpeakerEcho(owner: object, transcript: string, now = performance.now()): boolean {
  const state = speakerEcho.get(owner);
  const text = normalize(transcript);
  if (!state || text.length < 4) return false;
  const echoed = state.phrases.some(phrase => phrase.expires > now && (phrase.text.includes(text) || overlap(phrase.text, text) > 0.6));
  if (echoed) state.useLevelGate = true;
  return echoed;
}

export function speakerMicVoice(owner: object, rms: number, playing: boolean, now = performance.now()): boolean {
  const state = speakerEcho.get(owner);
  const speaking = rms > (playing && state?.useLevelGate ? SPEAKER_ECHO_LEVEL : 0.012);
  if (state && speaking && playing) state.nearSpeechAt = now;
  return speaking;
}

export function allowSpeakerBargeIn(owner: object, playing: boolean, now = performance.now()): boolean {
  const state = speakerEcho.get(owner);
  return !playing || !state?.useLevelGate || now - state.nearSpeechAt < 250;
}

function overlap(left: string, right: string): number {
  const row = new Uint16Array(right.length + 1);
  for (const char of left) {
    let diagonal = 0;
    for (let index = 0; index < right.length; index++) {
      const above = row[index + 1];
      row[index + 1] = char === right[index] ? diagonal + 1 : Math.max(row[index], above);
      diagonal = above;
    }
  }
  return row[right.length] / Math.max(left.length, right.length);
}
