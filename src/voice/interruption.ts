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
