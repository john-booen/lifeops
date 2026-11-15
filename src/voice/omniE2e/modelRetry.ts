const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

export const isRetryableOmniModelError = (message: string): boolean =>
  /ModelServingError|model serving|internal/i.test(message);

/** Owns the delay between attempts for one native response. */
export class OmniModelRetry {
  private attempt = 0;
  private timer?: number;

  get pending(): boolean { return this.timer !== undefined; }

  next(maximum?: number): { attempt: number; delayMs: number } | undefined {
    const max = Math.min(RETRY_DELAYS_MS.length, Math.max(0, maximum ?? RETRY_DELAYS_MS.length));
    if (this.attempt >= max) return;
    const delayMs = RETRY_DELAYS_MS[this.attempt];
    this.attempt += 1;
    return { attempt: this.attempt, delayMs };
  }

  schedule(delayMs: number, retry: () => void): void {
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      retry();
    }, delayMs);
  }

  cancel(): void {
    if (this.timer === undefined) return;
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  reset(): void {
    this.cancel();
    this.attempt = 0;
  }
}
