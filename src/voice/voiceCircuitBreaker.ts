export type VoiceCircuitState = "closed" | "open" | "half-open";

export interface VoiceCircuitSnapshot {
  state: VoiceCircuitState;
  consecutiveFailures: number;
  openedAt: number | null;
  nextProbeAt: number | null;
  lastErrorCode: string | null;
}

export interface VoiceCircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

export class VoiceE2eCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private state: VoiceCircuitSnapshot = {
    state: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    nextProbeAt: null,
    lastErrorCode: null
  };

  constructor(options: VoiceCircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, Math.round(
      options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
    ));
    this.cooldownMs = Math.max(1_000, Math.round(
      options.cooldownMs ?? DEFAULT_COOLDOWN_MS
    ));
    this.now = options.now ?? Date.now;
  }

  snapshot(): VoiceCircuitSnapshot {
    return { ...this.state };
  }

  allowPrimary(): boolean {
    if (this.state.state === "closed" || this.state.state === "half-open") return true;
    const nextProbeAt = this.state.nextProbeAt ?? Number.POSITIVE_INFINITY;
    if (this.now() < nextProbeAt) return false;
    this.state = {
      ...this.state,
      state: "half-open"
    };
    return true;
  }

  recordSuccess(): VoiceCircuitSnapshot {
    this.state = {
      state: "closed",
      consecutiveFailures: 0,
      openedAt: null,
      nextProbeAt: null,
      lastErrorCode: null
    };
    return this.snapshot();
  }

  recordFailure(errorCode = "e2e_response_failed"): VoiceCircuitSnapshot {
    const now = this.now();
    const consecutiveFailures = this.state.state === "half-open"
      ? this.failureThreshold
      : this.state.consecutiveFailures + 1;
    if (consecutiveFailures < this.failureThreshold) {
      this.state = {
        ...this.state,
        consecutiveFailures,
        lastErrorCode: errorCode
      };
      return this.snapshot();
    }
    this.state = {
      state: "open",
      consecutiveFailures,
      openedAt: now,
      nextProbeAt: now + this.cooldownMs,
      lastErrorCode: errorCode
    };
    return this.snapshot();
  }

  reset(): void {
    this.recordSuccess();
  }
}
