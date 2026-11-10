import { BailianRealtimeTtsClient, type BailianRealtimeTtsCallbacks } from "../bailianTtsRealtime";
import { assertProviderActive, awaitProviderActive } from "../providerRun";
import type { ProviderErrorCode, ProviderRequestOptions, RealtimeVoiceSettings } from "../types";
import type { RealtimeProviderContext } from "./realtimeProviderRun";
import { BreezeResidentWorker } from "./breezeResident";

const SENTENCE_END = /[。！？!?\n]/u;
const SENTENCE_LIMIT = 120;

export class BreezeSentenceBuffer {
  private pending = "";

  push(text: string, final = false): string[] {
    this.pending += text;
    const sentences: string[] = [];
    let characters = Array.from(this.pending);
    while (characters.length) {
      const end = characters.findIndex(character => SENTENCE_END.test(character));
      const span = end < 0 ? characters.length : end + 1;
      const slice = span > 40 ? characters.slice(0, Math.min(span, SENTENCE_LIMIT)) : [];
      const comma = Math.max(slice.lastIndexOf("，"), slice.lastIndexOf(","));
      const cut = comma >= 0 ? comma + 1 : Math.min(SENTENCE_LIMIT, span);
      if (end < 0 && comma < 0 && span < SENTENCE_LIMIT && !final) break;
      const sentence = characters.slice(0, cut).join("").trim();
      if (sentence) sentences.push(sentence);
      characters = characters.slice(cut);
    }
    this.pending = characters.join("");
    return sentences;
  }
}

export class VoiceSpeechParts implements AsyncIterable<string> {
  private readonly parts: string[] = [];
  private length = 0;
  private closed = false;
  private wake?: () => void;
  private completeText!: (text: string) => void;
  readonly finalText = new Promise<string>(resolve => { this.completeText = resolve; });

  push(delta: string): void {
    if (this.closed || this.length >= 900) return;
    const chunk = delta.slice(0, 900 - this.length);
    if (!chunk) return;
    this.length += chunk.length;
    this.parts.push(chunk);
    this.wake?.();
  }

  finish(text: string): void {
    if (this.closed) return;
    this.closed = true;
    this.completeText(text);
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (this.parts.length || !this.closed) {
      const part = this.parts.shift();
      if (part !== undefined) yield part;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
    this.wake = undefined;
  }
}

export class BreezeResidentTtsClient extends BailianRealtimeTtsClient {
  private speech?: AbortController;

  constructor(settings: RealtimeVoiceSettings, private readonly local: BailianRealtimeTtsCallbacks,
    private readonly resident: BreezeResidentWorker, context?: RealtimeProviderContext) {
    super(settings, local, context);
  }

  override speak(text: string, options: ProviderRequestOptions = {}): Promise<void> {
    return this.speakStream((async function* () { yield text; })(), options);
  }

  async speakStream(parts: AsyncIterable<string>, options: ProviderRequestOptions = {}): Promise<void> {
    this.cancel();
    const speech = new AbortController();
    this.speech = speech;
    const cancel = () => speech.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const iterator = parts[Symbol.asyncIterator](), buffer = new BreezeSentenceBuffer();
    let started = false;
    try {
      while (true) {
        const part = await awaitProviderActive(() => iterator.next(), speech.signal);
        for (const sentence of buffer.push(part.done ? "" : part.value, part.done)) {
          assertProviderActive(speech.signal);
          if (!started) { this.local.onOpen?.(); started = true; }
          let first = true;
          await this.resident.speak(sentence, pcm => {
            if (first) { first = false; this.local.onSentenceAudio?.(sentence); }
            this.local.onAudioDelta?.(pcm, 24_000);
          }, speech.signal);
          this.local.onSentenceDone?.(sentence);
        }
        if (part.done) break;
      }
      if (!started) throw Error("本地语音没有收到可朗读文字。");
      this.local.onResponseDone?.();
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      if (this.speech === speech) this.speech = undefined;
    }
  }

  override cancel(_code?: ProviderErrorCode): void { this.speech?.abort(); }
}

const sessionWorkers = new WeakMap<object, BreezeResidentWorker>();
const closingSessions = new WeakMap<object, Promise<void>>();

export function warmSessionBreeze(owner: object, settings: RealtimeVoiceSettings): void {
  if (!settings.speakReplies || settings.ttsEngine !== "breeze-local") return;
  let worker = sessionWorkers.get(owner);
  if (!worker) {
    worker = new BreezeResidentWorker(settings, undefined, closingSessions.get(owner));
    sessionWorkers.set(owner, worker);
  }
  void worker.warm().catch(() => undefined);
}

export function sessionBreeze(owner: object): BreezeResidentWorker | undefined { return sessionWorkers.get(owner); }

export function closeSessionBreeze(owner: object): void {
  const worker = sessionWorkers.get(owner);
  if (!worker) return;
  sessionWorkers.delete(owner);
  const closing = worker.close().catch(() => undefined);
  closingSessions.set(owner, closing);
  void closing.then(() => { if (closingSessions.get(owner) === closing) closingSessions.delete(owner); });
}
