export const voiceLatencyStages = ["t0", "t1", "t2", "t3", "t4", "t5"] as const;
export type VoiceLatencyStage = typeof voiceLatencyStages[number];
export type VoiceLatency = Partial<Record<VoiceLatencyStage, number>>;

const captures = new WeakMap<object, VoiceLatency>();

export function resetVoiceLatencyCapture(owner: object): void {
  captures.delete(owner);
}

export function markVoiceLatencyCapture(owner: object, stage: "t0" | "t1"): void {
  const capture = captures.get(owner) ?? {};
  capture[stage] ??= performance.now();
  captures.set(owner, capture);
}

export function takeVoiceLatencyCapture(owner: object): VoiceLatency | undefined {
  const capture = captures.get(owner);
  captures.delete(owner);
  return capture;
}

export function markVoiceLatency(latency: VoiceLatency | undefined, stage: VoiceLatencyStage): boolean {
  if (!latency || latency[stage] !== undefined) return false;
  latency[stage] = performance.now();
  return true;
}
