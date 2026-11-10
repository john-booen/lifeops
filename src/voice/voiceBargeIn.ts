export type VoiceBargeInPhase = "idle" | "suspected" | "confirmed";

export interface VoiceBargeInIdentity {
  generation: number;
  turnId: string;
  playbackId: string | null;
}

export interface VoiceBargeInSnapshot {
  phase: VoiceBargeInPhase;
  identity: VoiceBargeInIdentity | null;
  startedAt: number | null;
  confirmationReason: string | null;
}

export type VoiceBargeInEventType = "suspected" | "confirmed" | "false-alarm" | "reset";

export interface VoiceBargeInEvent {
  type: VoiceBargeInEventType;
  identity: VoiceBargeInIdentity;
  reason: string;
  elapsedMs: number;
  textLength?: number;
}

export interface VoiceBargeInOptions {
  confirmationMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timerId: number) => void;
  onEvent?: (event: VoiceBargeInEvent) => void;
}

export interface ObserveBargeInTranscriptOptions {
  controlIntent?: boolean;
  meaningful?: boolean;
}

const DEFAULT_CONFIRMATION_MS = 500;

export class VoiceBargeInController {
  private readonly confirmationMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => number;
  private readonly clearTimer: (timerId: number) => void;
  private readonly onEvent?: (event: VoiceBargeInEvent) => void;
  private state: VoiceBargeInSnapshot = {
    phase: "idle",
    identity: null,
    startedAt: null,
    confirmationReason: null
  };
  private confirmationTimer = 0;

  constructor(options: VoiceBargeInOptions = {}) {
    this.confirmationMs = Math.max(100, options.confirmationMs ?? DEFAULT_CONFIRMATION_MS);
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timerId) => window.clearTimeout(timerId));
    this.onEvent = options.onEvent;
  }

  snapshot(): VoiceBargeInSnapshot {
    return {
      ...this.state,
      identity: this.state.identity ? { ...this.state.identity } : null
    };
  }

  suspect(identity: VoiceBargeInIdentity): boolean {
    if (!identity.turnId.trim() || identity.generation < 1) return false;
    if (this.state.phase === "suspected" && sameIdentity(this.state.identity, identity)) return true;
    if (this.state.phase !== "idle") this.reset("replaced_barge_in_candidate");

    const startedAt = this.now();
    this.state = {
      phase: "suspected",
      identity: { ...identity },
      startedAt,
      confirmationReason: null
    };
    this.emit("suspected", "speech_started");
    this.confirmationTimer = this.setTimer(() => {
      this.confirmationTimer = 0;
      this.confirm("sustained_speech");
    }, this.confirmationMs);
    return true;
  }

  observeTranscript(
    text: string,
    options: ObserveBargeInTranscriptOptions = {}
  ): VoiceBargeInPhase {
    if (this.state.phase !== "suspected") return this.state.phase;
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return this.state.phase;
    if (options.controlIntent) {
      this.confirm("control_intent", normalized.length);
    } else if (options.meaningful) {
      this.confirm("meaningful_transcript", normalized.length);
    }
    return this.state.phase;
  }

  speechStopped(): VoiceBargeInPhase {
    if (this.state.phase === "suspected") {
      this.falseAlarm("speech_stopped_before_confirmation");
    }
    return this.state.phase;
  }

  confirm(reason = "barge_in_confirmed", textLength?: number): boolean {
    if (this.state.phase !== "suspected" || !this.state.identity) return false;
    this.clearConfirmationTimer();
    this.state = {
      ...this.state,
      phase: "confirmed",
      confirmationReason: reason
    };
    this.emit("confirmed", reason, textLength);
    return true;
  }

  falseAlarm(reason = "barge_in_false_alarm"): boolean {
    if (this.state.phase !== "suspected" || !this.state.identity) return false;
    this.clearConfirmationTimer();
    this.emit("false-alarm", reason);
    this.state = {
      phase: "idle",
      identity: null,
      startedAt: null,
      confirmationReason: null
    };
    return true;
  }

  reset(reason = "barge_in_reset"): void {
    const identity = this.state.identity;
    if (identity) this.emit("reset", reason);
    this.clearConfirmationTimer();
    this.state = {
      phase: "idle",
      identity: null,
      startedAt: null,
      confirmationReason: null
    };
  }

  private clearConfirmationTimer(): void {
    if (!this.confirmationTimer) return;
    this.clearTimer(this.confirmationTimer);
    this.confirmationTimer = 0;
  }

  private emit(type: VoiceBargeInEventType, reason: string, textLength?: number): void {
    const identity = this.state.identity;
    if (!identity) return;
    this.onEvent?.({
      type,
      identity: { ...identity },
      reason,
      elapsedMs: Math.max(0, this.now() - (this.state.startedAt ?? this.now())),
      ...(textLength === undefined ? {} : { textLength: Math.max(0, textLength) })
    });
  }
}

function sameIdentity(
  left: VoiceBargeInIdentity | null,
  right: VoiceBargeInIdentity
): boolean {
  return Boolean(
    left
    && left.generation === right.generation
    && left.turnId === right.turnId
    && left.playbackId === right.playbackId
  );
}
