/** Owns the optional background activity. Disabled means no timer/subscription;
 * generation also invalidates work already waiting on an asynchronous read. */
export class ProactiveLifecycle {
  private interval: ReturnType<typeof setInterval> | undefined;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private enabled = false;
  generation = 0;

  constructor(private readonly run: () => void, private readonly subscribe: (notify: () => void) => () => void) {}

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.stop();
    if (!enabled) return;
    this.enabled = true;
    this.unsubscribe = this.subscribe(() => this.schedule());
    this.interval = setInterval(() => this.run(), 5 * 60_000);
  }
  isCurrent(generation: number): boolean { return this.enabled && generation === this.generation; }
  schedule(delayMs = 2_000): void {
    if (!this.enabled) return;
    if (this.pending !== undefined) clearTimeout(this.pending);
    const generation = this.generation;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      if (this.isCurrent(generation)) this.run();
    }, delayMs);
  }
  stop(): void {
    this.enabled = false;
    this.generation += 1;
    if (this.interval !== undefined) clearInterval(this.interval);
    if (this.pending !== undefined) clearTimeout(this.pending);
    this.interval = this.pending = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
