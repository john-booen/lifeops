import { extractResponseAudioTranscriptDelta, extractResponseAudioTranscriptDone } from "./protocol";

export class OmniResponseText {
  private text = "";
  private fromText = false;

  update(event: Record<string, unknown>): string | null | undefined {
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

  reset(): void {
    this.text = "";
    this.fromText = false;
  }
}
