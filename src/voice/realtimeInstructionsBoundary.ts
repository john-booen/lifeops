import { randomUUID } from "node:crypto";

export interface RealtimeInstructionsSnapshot {
  instructions: string;
  baseInstructions: string;
  expiresAt?: number;
  visualSamples?: readonly {kind: "camera" | "desktop" | "local" | "face"; timestamp: string; basis: "observation" | "analysis-completion"}[];
  assertCurrent(): void;
  assertSourcesCurrent?(): Promise<void>;
  dispose(): void;
}

export interface RealtimeInstructionsBoundaryOptions {
  prepare: () => Promise<RealtimeInstructionsSnapshot>;
  send: (payload: Record<string, unknown>) => void;
  isCurrent: () => boolean;
  audit?: (bytes: number) => Promise<void>;
  timeoutMs?: number;
}

export class RealtimeInstructionsBoundaryError extends Error {
  constructor(readonly code: "cancelled" | "stale" | "timeout" | "failed") {
    super(`Realtime instructions ${code}.`);
    this.name = "RealtimeInstructionsBoundaryError";
  }
}

interface Operation {
  ended: boolean;
  error?: RealtimeInstructionsBoundaryError;
  assertCurrent(): void;
  abort(error: RealtimeInstructionsBoundaryError): void;
}
interface ManagedSnapshot {
  token: RealtimeInstructionsSnapshot;
  revision?: number;
  assertSource(): void;
  assertSourcesCurrent?(): Promise<void>;
}
interface Handshake {
  nonce: string;
  instructions: string;
  operation: Operation;
  snapshot: ManagedSnapshot;
  resolve(): void;
  reject(error: RealtimeInstructionsBoundaryError): void;
}

/** A session-local instruction slot. It never sends audio or response.create.
 * Every response must await its own echoed update, then assert/dispose the token
 * immediately around response.create. Earlier conversation/output is not erased. */
export class RealtimeInstructionsBoundary {
  private serial: Promise<unknown> = Promise.resolve();
  private cancelled = false;
  private epoch = 0;
  private issuedRevision = 0;
  private confirmedRevision = 0;
  private operation?: Operation;
  private handshake?: Handshake;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private readonly snapshots = new Set<RealtimeInstructionsSnapshot>();
  private readonly timeoutMs: number;
  private sourceValidationIssued = false;

  constructor(private readonly options: RealtimeInstructionsBoundaryOptions) {
    const timeout = options.timeoutMs ?? 5_000;
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 5_000;
  }

  prepareForResponse(isResponseCurrent: () => boolean): Promise<RealtimeInstructionsSnapshot> {
    return this.enqueue(() => this.update("response", isResponseCurrent));
  }

  get requiresSourceValidation(): boolean { return this.sourceValidationIssued; }

  acceptSessionEvent(event: Record<string, unknown>): boolean {
    const pending = this.handshake;
    if (!pending) return false;
    if (event.type === "session.updated") {
      const session = record(event.session);
      // A previous ACK, or an ACK without the exact nonce-bearing body, proves
      // nothing about this update. Never correlate server event_id to our ID.
      if (session?.instructions !== pending.instructions) return false;
      this.handshake = undefined;
      try {
        pending.operation.assertCurrent();
        pending.snapshot.assertSource();
        pending.resolve();
      } catch { pending.reject(new RealtimeInstructionsBoundaryError("stale")); }
      return true;
    }
    if (event.type !== "error" || event.response_id || record(event.response)?.id) return false;
    const requestId = record(event.error)?.event_id;
    if (requestId !== undefined && requestId !== pending.nonce) return false;
    this.handshake = undefined;
    // Provider error bodies can contain prompt text; expose only a fixed code.
    pending.reject(new RealtimeInstructionsBoundaryError("failed"));
    return true;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.epoch += 1;
    this.clearExpiryTimer();
    this.operation?.abort(new RealtimeInstructionsBoundaryError("cancelled"));
    const pending = this.handshake;
    this.handshake = undefined;
    pending?.reject(new RealtimeInstructionsBoundaryError("cancelled"));
    for (const snapshot of this.snapshots) snapshot.dispose();
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertConnection(epoch: number, isResponseCurrent: () => boolean): void {
    if (this.cancelled || this.epoch !== epoch) throw new RealtimeInstructionsBoundaryError("cancelled");
    let current = false;
    try { current = this.options.isCurrent() && isResponseCurrent(); } catch { /* Fail closed. */ }
    if (!current) throw new RealtimeInstructionsBoundaryError("stale");
  }

  private manage(snapshot: RealtimeInstructionsSnapshot, epoch: number, isResponseCurrent: () => boolean): ManagedSnapshot {
    let disposed = false;
    const { instructions, baseInstructions, expiresAt } = snapshot;
    const sourceRead = snapshot.assertSourcesCurrent;
    const assertSourcesCurrent = typeof sourceRead === "function" ? async () => {
      managed.assertSource();
      try { await sourceRead.call(snapshot); }
      catch { throw new RealtimeInstructionsBoundaryError("stale"); }
      managed.assertSource();
    } : undefined;
    if (assertSourcesCurrent) this.sourceValidationIssued = true;
    const managed: ManagedSnapshot = {
      ...(assertSourcesCurrent ? { assertSourcesCurrent } : {}),
      token: Object.freeze({
        ...snapshot,
        instructions, baseInstructions, expiresAt,
        assertCurrent: () => {
          managed.assertSource();
          if (managed.revision !== this.issuedRevision || managed.revision !== this.confirmedRevision) {
            throw new RealtimeInstructionsBoundaryError("stale");
          }
        },
        ...(assertSourcesCurrent ? { assertSourcesCurrent: async () => {
          managed.token.assertCurrent();
          // The update operation's timer ends at handoff. A caller's final
          // raw read has its own bound; late completion retains no send right.
          await withSourceDeadline(assertSourcesCurrent, this.timeoutMs);
          managed.token.assertCurrent();
        } } : {}),
        dispose: () => {
          if (disposed) return;
          disposed = true;
          this.snapshots.delete(managed.token);
          safeDispose(snapshot);
        }
      }),
      assertSource: () => {
        if (disposed) throw new RealtimeInstructionsBoundaryError("stale");
        this.assertConnection(epoch, isResponseCurrent);
        if (typeof instructions !== "string" || typeof baseInstructions !== "string"
          || snapshot.instructions !== instructions || snapshot.baseInstructions !== baseInstructions || snapshot.expiresAt !== expiresAt
          || (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now()))) {
          throw new RealtimeInstructionsBoundaryError("stale");
        }
        try { snapshot.assertCurrent(); } catch { throw new RealtimeInstructionsBoundaryError("stale"); }
      }
    };
    this.snapshots.add(managed.token);
    return managed;
  }

  private async update(kind: "response" | "expiry", isResponseCurrent: () => boolean): Promise<RealtimeInstructionsSnapshot> {
    const epoch = this.epoch;
    this.assertConnection(epoch, isResponseCurrent);
    let interrupt!: (error: RealtimeInstructionsBoundaryError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject; });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const operation: Operation = {
      ended: false,
      assertCurrent: () => {
        if (operation.error) throw operation.error;
        if (operation.ended) throw new RealtimeInstructionsBoundaryError("cancelled");
        this.assertConnection(epoch, isResponseCurrent);
      },
      abort: error => {
        if (operation.ended || operation.error) return;
        operation.error = error;
        if (timeout !== undefined) clearTimeout(timeout);
        interrupt(error);
      }
    };
    this.operation = operation;
    timeout = setTimeout(() => operation.abort(new RealtimeInstructionsBoundaryError("timeout")), this.timeoutMs);
    let managed: ManagedSnapshot | undefined;
    let transferred = false;
    const work = (async () => {
      const snapshot = await this.options.prepare();
      if (operation.ended || operation.error) {
        safeDispose(snapshot);
        operation.assertCurrent();
      }
      managed = this.manage(snapshot, epoch, isResponseCurrent);
      operation.assertCurrent();
      if (managed.assertSourcesCurrent) await managed.assertSourcesCurrent();
      operation.assertCurrent();
      managed.assertSource();
      const nonce = randomUUID();
      const body = kind === "response" ? managed.token.instructions : managed.token.baseInstructions;
      const instructions = `${body}\n\n[内部上下文版本：${nonce}；此标记只用于协议确认，不得朗读或作为用户资料。]`;
      const payload = { type: "session.update", event_id: nonce, session: { instructions } };
      if (this.options.audit) await this.options.audit(Buffer.byteLength(JSON.stringify(payload), "utf8"));
      operation.assertCurrent();
      if (managed.assertSourcesCurrent) await managed.assertSourcesCurrent();
      operation.assertCurrent();
      managed.assertSource();
      const ack = new Promise<void>((resolve, reject) => {
        this.handshake = { nonce, instructions, operation, snapshot: managed!, resolve, reject };
      });
      // Reserve before send: a synchronous FakeSocket ACK is valid too.
      managed.revision = ++this.issuedRevision;
      try { this.options.send(payload); }
      catch {
        const error = new RealtimeInstructionsBoundaryError("failed");
        operation.abort(error);
        this.handshake?.reject(error);
      }
      await ack;
      operation.assertCurrent();
      if (managed.assertSourcesCurrent) await managed.assertSourcesCurrent();
      operation.assertCurrent();
      managed.assertSource();
      this.confirmedRevision = managed.revision;
      // The server now holds this slot even if a last-microtask permission/TTL
      // change prevents handing a response token to the caller.
      if (kind === "response") this.scheduleExpiry(managed.token.expiresAt, this.confirmedRevision, epoch);
      return managed.token;
    })();
    try {
      const token = await Promise.race([work, interrupted]);
      token.assertCurrent();
      if (kind === "response") {
        transferred = true;
      }
      return token;
    } catch (error) {
      throw error instanceof RealtimeInstructionsBoundaryError ? error : new RealtimeInstructionsBoundaryError("failed");
    } finally {
      operation.ended = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (this.operation === operation) this.operation = undefined;
      if (this.handshake?.operation === operation) {
        this.handshake.reject(new RealtimeInstructionsBoundaryError("cancelled"));
        this.handshake = undefined;
      }
      if (!transferred) managed?.token.dispose();
    }
  }

  private scheduleExpiry(expiresAt: number | undefined, revision: number, epoch: number): void {
    this.clearExpiryTimer();
    if (expiresAt === undefined) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      void this.enqueue(async () => {
        if (this.cancelled || this.epoch !== epoch || this.confirmedRevision !== revision) return;
        await this.update("expiry", () => true);
      }).catch(() => {
        // No audio interruption or unhandled rejection. The next response must
        // prepare/confirm anew, and can fail or recover through its own owner.
      });
    }, Math.max(0, expiresAt - Date.now()));
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function safeDispose(snapshot: RealtimeInstructionsSnapshot): void {
  try { snapshot.dispose(); } catch { /* Cleanup cannot expose source text or interrupt audio. */ }
}

async function withSourceDeadline(read: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([read(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RealtimeInstructionsBoundaryError("timeout")), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
