import type { BailianRealtimeCallbacks } from "../../bailianRealtime";
import { extractResponseAudioTranscriptDelta, extractResponseAudioTranscriptDone,
  normalizeSampleRate, responseLifecycleEvent } from "./protocol";

type OutputCallbacks = Pick<BailianRealtimeCallbacks, "onResponseTextDelta" | "onAudioDelta" | "onResponseAudioDone">;

export class OmniResponseOutput {
  private text = "";
  private fromText = false;
  private observedOutput = false;

  constructor(private readonly callbacks: OutputCallbacks) {}

  get hasOutput(): boolean { return this.observedOutput; }

  /** The caller verifies that the packet belongs to the current response. */
  accept(event: Record<string, unknown>, activeResponseId: string, sampleRate: number): boolean {
    const text = this.updateText(event);
    if (text !== undefined) {
      this.observedOutput = true;
      if (text !== null) this.callbacks.onResponseTextDelta?.(text, responseLifecycleEvent(event, activeResponseId));
      return true;
    }
    if (event.type === "response.text.delta") return true;
    if (event.type === "response.audio.delta") {
      if (typeof event.delta === "string" && event.delta) {
        this.observedOutput = true;
        this.callbacks.onAudioDelta?.(event.delta, normalizeSampleRate(sampleRate), responseLifecycleEvent(event, activeResponseId));
      }
      return true;
    }
    if (event.type === "response.audio.done" || event.type === "response.audio.completed") {
      this.callbacks.onResponseAudioDone?.(responseLifecycleEvent(event, activeResponseId));
      return true;
    }
    return false;
  }

  private updateText(event: Record<string, unknown>): string | null | undefined {
    if (event.type === "response.text.delta" && typeof event.delta === "string" && event.delta) {
      if (!this.fromText) this.text = "";
      this.fromText = true;
      this.text += event.delta;
      return this.text;
    }
    const delta = extractResponseAudioTranscriptDelta(event);
    const completed = delta ? "" : extractResponseAudioTranscriptDone(event);
    if (!delta && !completed) return;
    // Text output owns the displayed reply once it starts.
    if (this.fromText) return null;
    this.text = completed || this.text + delta;
    return this.text;
  }

  completed(): string { return this.text.trim(); }

  clearText(): void {
    this.text = "";
    this.fromText = false;
  }

  reset(): void {
    this.clearText();
    this.observedOutput = false;
  }
}
