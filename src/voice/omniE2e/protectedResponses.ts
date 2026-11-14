import { createOutputSliceBudget, createOutputSliceYield } from "../outputSliceYield";

const MAX_FRAMES = 128;
const MAX_BYTES = 4 * 1024 * 1024;
const BATCH_FRAMES = 32;

interface Frame {
  event: Record<string, unknown>;
  generation: number;
  current: () => boolean;
}

interface OwnedFrame extends Frame {
  bytes: number;
  epoch: number;
  connection: object | null;
}

interface ResponseHost {
  connection(): object | null;
  assertSourcesCurrent(): Promise<void>;
  assertSourcesCurrentNow(): void;
  handle(event: Frame["event"]): void;
  handleStale(frame: Frame, connection: object | null): void;
  fail(message?: string): void;
}

interface Flight {
  epoch: number;
  connection: object | null;
  yield: ReturnType<typeof createOutputSliceYield>;
  startBudget: ReturnType<typeof createOutputSliceBudget>;
}

export class ProtectedOmniResponses {
  private queue: OwnedFrame[] = [];
  private flight?: Flight;
  private epoch = 0;
  pending = 0;
  bytes = 0;

  constructor(private readonly host: ResponseHost) {}

  enqueue(frame: Frame, bytes: number): void {
    if (this.pending >= MAX_FRAMES || this.bytes + bytes > MAX_BYTES) {
      this.host.fail("查询核对未赶上语音输出，已结束这次连接并保留文字输入；可先用文字查询，未自动重试。");
      return;
    }
    const owned = { ...frame, bytes, epoch: this.epoch, connection: this.host.connection() };
    this.queue.push(owned);
    this.pending++;
    this.bytes += bytes;
    if (this.flight) return;
    const flight = { epoch: this.epoch, connection: owned.connection, yield: createOutputSliceYield(), startBudget: createOutputSliceBudget() };
    this.flight = flight;
    void this.drain(flight);
  }

  cancelYield(): void { this.flight?.yield.cancel(); }

  reset(): void {
    const retired = this.flight;
    this.flight = undefined;
    this.queue = [];
    this.epoch++;
    this.pending = 0;
    this.bytes = 0;
    retired?.yield.dispose();
  }

  private async drain(flight: Flight): Promise<void> {
    const owns = () => this.flight === flight && flight.epoch === this.epoch && flight.connection === this.host.connection();
    let published = false;
    try {
      while (this.flight === flight && this.queue.length) {
        const first = this.queue[0], members: OwnedFrame[] = [];
        // Freeze membership before the raw read so new arrivals wait for the next read.
        while (members.length < BATCH_FRAMES && this.queue.length) {
          const next = this.queue[0];
          if (next.epoch !== first.epoch || next.connection !== first.connection || next.generation !== first.generation) break;
          members.push(this.queue.shift()!);
        }
        const batch = Object.freeze(members), bytes = batch.reduce((sum, item) => sum + item.bytes, 0);
        try {
          let offset = 0;
          while (offset < batch.length) {
            const slice = batch.slice(offset, offset + BATCH_FRAMES);
            if (published && slice.some(item => item.current())) await flight.yield.wait();
            if (!owns()) break;
            if (slice.some(item => item.current())) await this.host.assertSourcesCurrent();
            if (!owns()) break;
            const exhausted = flight.startBudget();
            for (const item of slice) {
              if (!item.current()) this.host.handleStale(item, item.connection);
              else {
                // A callback can cancel the response or change permissions during delivery.
                this.host.assertSourcesCurrentNow();
                this.host.handle(item.event);
              }
              offset++;
              if (exhausted()) break;
            }
            published = true;
          }
        } catch {
          if (batch.some(item => item.current())) this.host.fail();
        } finally {
          // An old read cannot debit the current connection's queue.
          if (first.epoch === this.epoch) {
            this.pending -= batch.length;
            this.bytes -= bytes;
          }
        }
      }
    } finally {
      flight.yield.dispose();
      if (this.flight === flight) this.flight = undefined;
    }
  }
}
