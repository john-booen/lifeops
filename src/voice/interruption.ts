interface NearSpeech { firstAt: number; lastAt: number; strongSince?: number }
const nearby = new WeakMap<object, NearSpeech>();

/** Confirm sustained near-end energy across capture batches, without a transcript round-trip. */
export function confirmNearbySpeech(owner: object, speakingDuringPlayback: boolean, strong = false, now = performance.now()): number | undefined {
  if (!speakingDuringPlayback) { nearby.delete(owner); return; }
  const previous = nearby.get(owner);
  if (!previous || now - previous.lastAt > 140 || now < previous.lastAt) {
    nearby.set(owner, { firstAt: now, lastAt: now, strongSince: strong ? now : undefined });
    return;
  }
  previous.lastAt = now;
  previous.strongSince = strong ? (previous.strongSince ?? now) : undefined;
  const sustainedStrong = previous.strongSince !== undefined && now - previous.strongSince >= 35;
  if (!sustainedStrong && now - previous.firstAt < 75) return;
  nearby.delete(owner);
  return previous.firstAt;
}

interface HeardSpeech { completed: string[]; current: string }
const heardByView = new WeakMap<object, HeardSpeech>();

export function beginHeardSpeech(owner: object): void {
  heardByView.set(owner, { completed: [], current: "" });
}

export function rememberHeardPhrase(owner: object, text: string, completed: boolean): void {
  const heard = heardByView.get(owner);
  if (!heard) return;
  if (!completed) { heard.current = text; return; }
  heard.completed.push(text);
  heard.current = "";
}

export function finishHeardSpeech(owner: object): void {
  heardByView.delete(owner);
}

export function takeInterruptedSpeech(owner: object): string {
  const heard = heardByView.get(owner);
  heardByView.delete(owner);
  const spoken = heard?.completed.join(" ") ?? "";
  const annotation = heard?.current ? "（被打断，末句未播完）" : "（被打断）";
  return [spoken, annotation].filter(Boolean).join("\n");
}
