import { randomUUID } from "node:crypto";
import type { ProviderErrorCode } from "../../types";
import type { RealtimeInstructionsSnapshot } from "../realtimeInstructionsBoundary";
import { realtimeProviderError } from "../realtimeProviderRun";

export class RealtimeConnectionContextError extends Error {
  constructor() {
    super("首次语音资料或权限已变化，已停止连接；请重新开始语音。");
    this.name = "RealtimeConnectionContextError";
  }
}

interface InitialInstructionsSlot {
  readonly snapshot: RealtimeInstructionsSnapshot;
  readonly instructions: string;
  readonly baseInstructions: string;
  readonly expiresAt?: number;
  readonly nonce: string;
  readonly wireInstructions: string;
  sent: boolean;
  checkingAck: boolean;
}

interface InitialInstructionsHost {
  connection(): object | null;
  accepted(event: Record<string, unknown>): void;
  failed(code: ProviderErrorCode): void;
}

export class OmniInitialInstructions {
  slot?: InitialInstructionsSlot;
  private consumed = false;

  constructor(private snapshot: RealtimeInstructionsSnapshot | undefined, private readonly host: InitialInstructionsHost) {}

  replace(snapshot: RealtimeInstructionsSnapshot): void {
    this.release();
    this.snapshot = snapshot;
    this.consumed = false;
  }

  capture(enabled: boolean, required: boolean): void {
    if (!enabled) { this.release(); return; }
    const snapshot = this.snapshot;
    if (!snapshot) {
      if (required) throw new RealtimeConnectionContextError();
      return;
    }
    if (this.consumed) throw new RealtimeConnectionContextError();
    this.consumed = true;
    const { instructions, baseInstructions, expiresAt } = snapshot;
    const nonce = randomUUID();
    this.slot = { snapshot, instructions, baseInstructions, expiresAt, nonce, sent: false, checkingAck: false,
      wireInstructions: instructions + "\n\n[内部上下文版本：" + nonce + "；此标记只用于协议确认，不得朗读或作为用户资料。]" };
    this.assertCurrent();
  }

  assertCurrent(): void {
    const slot = this.slot;
    if (!slot) return;
    const source = slot.snapshot;
    try {
      if (typeof slot.instructions !== "string" || typeof slot.baseInstructions !== "string"
        || source.instructions !== slot.instructions || source.baseInstructions !== slot.baseInstructions
        || source.expiresAt !== slot.expiresAt
        || slot.expiresAt !== undefined && (!Number.isFinite(slot.expiresAt) || slot.expiresAt <= Date.now())) {
        throw new RealtimeConnectionContextError();
      }
      source.assertCurrent();
    } catch { throw new RealtimeConnectionContextError(); }
  }

  release(): void {
    const snapshot = this.snapshot;
    this.snapshot = undefined;
    this.slot = undefined;
    try { snapshot?.dispose(); } catch { /* Disposal never retries or reuses a source. */ }
  }

  fail(slot: InitialInstructionsSlot, connection: object, code: ProviderErrorCode): void {
    if (this.slot === slot && this.host.connection() === connection) this.host.failed(code);
  }

  accept(event: Record<string, unknown>): boolean {
    const slot = this.slot, connection = this.host.connection();
    if (!slot || !connection) return false;
    if (event.type === "error") {
      const error = event.error as Record<string, unknown> | undefined;
      if (event.response_id || event.response || error?.event_id !== undefined && error.event_id !== slot.nonce) return true;
      this.fail(slot, connection, realtimeProviderError(error).code);
      return true;
    }
    if (event.type !== "session.updated") return false;
    const session = event.session as Record<string, unknown> | undefined;
    if (!slot.sent || session?.instructions !== slot.wireInstructions || slot.checkingAck) return true;
    slot.checkingAck = true;
    const complete = () => {
      if (this.slot !== slot || this.host.connection() !== connection) return;
      this.assertCurrent();
      this.host.accepted(event);
    };
    const fail = () => this.fail(slot, connection, "invalid_response");
    try {
      this.assertCurrent();
      if (slot.snapshot.assertSourcesCurrent) {
        void slot.snapshot.assertSourcesCurrent().then(complete, fail).catch(fail);
      } else complete();
    } catch { fail(); }
    return true;
  }
}
