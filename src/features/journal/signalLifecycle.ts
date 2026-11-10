import { addDays, formatDate } from "../../date";
import type { LifeOpsEventBus } from "../../lifeOpsEventBus";
import type { StoreHost } from "../../store/settingsSlice";
import { extractJournalSignal, journalSourceFor, type SignalRequest } from "./signalStore";

const QUIET_MS = 120_000;

export class JournalSignalLifecycle {
  private controller?: AbortController;
  private unsubscribe?: () => void;
  private nightlyTimer?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private queue = Promise.resolve();

  constructor(
    private readonly getStore: () => StoreHost,
    private readonly events: LifeOpsEventBus,
    private readonly request: SignalRequest,
    private readonly now = () => new Date()
  ) {}

  start(): void {
    if (this.controller) return;
    const controller = this.controller = new AbortController();
    this.unsubscribe = this.events.subscribe(event => {
      if (event.type !== "vault.created" && event.type !== "vault.modified" && event.type !== "vault.renamed") return;
      const path = (event.payload as { path?: unknown } | undefined)?.path;
      const date = formatDate(this.now());
      if (typeof path === "string" && this.available() && journalSourceFor(this.getStore(), path, date.slice(0, 4))) {
        this.schedule(path, date.slice(0, 4), QUIET_MS, controller, true);
      }
    });
    const today = formatDate(this.now());
    this.scan(addDays(today, -29), today, controller);
    this.nightly(controller);
  }

  restart(): void {
    if (!this.controller) return;
    this.stop();
    this.start();
  }

  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearTimeout(this.nightlyTimer);
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.queue = Promise.resolve();
  }

  private available(store = this.getStore()): boolean {
    const { ai } = store.settings;
    return ai.provider !== "off" && ai.dataDisclosureAccepted === true && !!ai.model && !!ai.endpoint;
  }

  private nightly(controller: AbortController): void {
    const now = this.now(), next = new Date(now);
    next.setHours(23, 30, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    this.nightlyTimer = setTimeout(() => {
      if (controller.signal.aborted) return;
      const date = formatDate(next);
      this.scan(date, date, controller);
      this.nightly(controller);
    }, next.getTime() - now.getTime());
  }

  private scan(from: string, to: string, controller: AbortController): void {
    const store = this.getStore();
    if (!this.available(store)) return;
    const now = this.now().getTime(), year = to.slice(0, 4);
    for (const file of store.app.vault.getMarkdownFiles()) {
      const source = journalSourceFor(store, file.path, year);
      if (source && source.date >= from && source.date <= to) {
        this.schedule(file.path, year, Math.max(0, source.mtime + QUIET_MS - now), controller);
      }
    }
  }

  private schedule(path: string, year: string, delay: number, controller: AbortController, replace = false): void {
    const previous = this.pending.get(path);
    if (previous !== undefined && !replace) return;
    clearTimeout(previous);
    this.pending.set(path, setTimeout(() => {
      this.pending.delete(path);
      this.queue = this.queue.then(async () => {
        if (controller.signal.aborted || this.pending.has(path)) return;
        const store = this.getStore();
        const assertSession = () => {
          if (this.getStore() !== store || !this.available(store)) throw Error("日记信号处理已停止。");
        };
        if (!this.available(store)) return;
        try {
          const result = await extractJournalSignal(store, path, year, this.request, controller.signal, assertSession);
          if (result === "invalid") await this.logFailure(store, "journal_signal_invalid");
        } catch {
          if (!controller.signal.aborted) await this.logFailure(store, "journal_signal_skipped");
        }
      });
    }, delay));
  }

  private async logFailure(store: StoreHost, errorCode: string): Promise<void> {
    await store.appendQualityLog({ inputSource: "unknown", providerStage: "daily_review", errorCode }).catch(() => undefined);
  }
}
