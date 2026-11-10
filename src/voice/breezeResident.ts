import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { breezeLocalPaths } from "../breezeLocalConfig";
import { assertProviderActive, awaitProviderActive } from "../providerRun";
import type { RealtimeVoiceSettings } from "../types";
import { BREEZE_RESIDENT_WORKER } from "./breezeResidentWorker";

const MAX_PCM = 4 * 1024 * 1024;
const MAX_LINE = Math.ceil(MAX_PCM / 3) * 4 + 512;
const IDLE_MS = 10 * 60_000;

type Timer = ReturnType<typeof setTimeout>;
class BreezeWorkerCrash extends Error {}
interface Worker {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  startTimer: Timer;
  buffer: Buffer;
  cancellations: Map<string, Timer>;
  request?: Request;
}
interface Request {
  id: string;
  seq: number;
  bytes: number;
  emit: (pcm: string) => void;
  finish: (error?: Error) => void;
}

/** Owns at most one offline Breeze child for a voice session. */
export class BreezeResidentWorker {
  private worker?: Worker;
  private readonly closing = new Set<Promise<void>>();
  private idle?: Timer;
  private busy = false;
  private stopped = false;

  constructor(private readonly settings: RealtimeVoiceSettings, private readonly idleMs = IDLE_MS,
    private readonly previousSessionClose?: Promise<void>) {}

  async warm(): Promise<void> {
    const worker = await this.ensureWorker();
    if (!this.busy) this.armIdle();
    await worker.ready;
  }

  async speak(text: string, emit: (pcm: string) => void, signal?: AbortSignal): Promise<void> {
    const clean = text.trim();
    if (!clean || Array.from(clean).length > 120) throw Error("每句本地朗读须为 1 至 120 字。");
    if (this.busy) throw Error("本地朗读正在生成上一句。");
    assertProviderActive(signal);
    this.busy = true;
    clearTimeout(this.idle);
    let emitted = false;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const worker = await awaitProviderActive(() => this.ensureWorker(), signal);
          await awaitProviderActive(() => worker.ready, signal);
          assertProviderActive(signal);
          if (this.worker !== worker) throw new BreezeWorkerCrash("本地语音进程已退出。");
          return await this.request(worker, clean, pcm => { emitted = true; emit(pcm); }, signal);
        } catch (error) {
          if (error instanceof BreezeWorkerCrash && emitted && !attempt && !this.stopped && !signal?.aborted) {
            void this.warm().catch(() => undefined);
          }
          if (!(error instanceof BreezeWorkerCrash) || emitted || attempt || this.stopped || signal?.aborted) throw error;
        }
      }
    } finally {
      this.busy = false;
      this.armIdle();
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.idle);
    if (this.worker) this.retire(this.worker, new BreezeWorkerCrash("本地语音已关闭。"));
    await Promise.all([...this.closing]);
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.previousSessionClose) await this.previousSessionClose;
    if (!this.worker && this.closing.size) await Promise.all([...this.closing]);
    return this.getWorker();
  }

  private getWorker(): Worker {
    if (this.stopped) throw Error("本地语音已关闭。");
    if (this.worker) return this.worker;
    const breeze = breezeLocalPaths(this.settings);
    const child = spawn(breeze.python, ["-I", "-B", "-u", "-c", BREEZE_RESIDENT_WORKER], { shell: false, stdio: ["pipe", "pipe", "pipe"], env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", TRANSFORMERS_OFFLINE: "1", TOKENIZERS_PARALLELISM: "false"
    } });
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const worker: Worker = { child, ready, resolveReady, rejectReady, buffer: Buffer.alloc(0), cancellations: new Map(),
      startTimer: setTimeout(() => this.retire(worker, new BreezeWorkerCrash("本地语音预热超时。")), 90_000) };
    this.worker = worker;
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    this.closing.add(closed);
    void closed.then(() => this.closing.delete(closed));
    child.stderr.resume();
    child.stdout.on("data", (bytes: Buffer) => this.receive(worker, bytes));
    child.on("close", () => this.retire(worker, new BreezeWorkerCrash("本地语音进程已退出。"), false));
    child.on("error", () => this.retire(worker, new BreezeWorkerCrash("本地语音无法启动。")));
    child.stdin.on("error", () => this.retire(worker, new BreezeWorkerCrash("本地语音输入已断开。")));
    this.send(worker, { breeze });
    return worker;
  }

  private request(worker: Worker, text: string, emit: Request["emit"], signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const request: Request = { id: randomUUID(), seq: 0, bytes: 0, emit, finish: error => {
        if (worker.request !== request) return;
        delete worker.request;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", cancel);
        if (error) reject(error); else resolve();
      } };
      const cancel = () => {
        request.finish(new DOMException("本地语音已取消。", "AbortError"));
        if (this.worker !== worker) return;
        const timer = setTimeout(() => this.retire(worker, new BreezeWorkerCrash("本地语音取消超时。")), 300);
        worker.cancellations.set(request.id, timer);
        this.send(worker, { cancel: request.id });
      };
      const deadline = setTimeout(() => this.retire(worker, new BreezeWorkerCrash("本地语音生成超时。")), 120_000);
      worker.request = request;
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      this.send(worker, { id: request.id, text });
    });
  }

  private send(worker: Worker, value: object): void {
    try { worker.child.stdin.write(JSON.stringify(value) + "\n"); }
    catch { this.retire(worker, new BreezeWorkerCrash("本地语音输入已断开。")); }
  }

  private receive(worker: Worker, bytes: Buffer): void {
    if (this.worker !== worker) return;
    worker.buffer = Buffer.concat([worker.buffer, bytes]);
    try {
      for (let end = worker.buffer.indexOf(10); end >= 0; end = worker.buffer.indexOf(10)) {
        if (end > MAX_LINE) throw Error();
        const value = JSON.parse(worker.buffer.subarray(0, end).toString("utf8")) as Record<string, unknown>;
        worker.buffer = worker.buffer.subarray(end + 1);
        this.receiveFrame(worker, value);
        if (this.worker !== worker) return;
      }
      if (worker.buffer.length > MAX_LINE) throw Error();
    } catch { this.retire(worker, new BreezeWorkerCrash("本地语音数据无效。")); }
  }

  private receiveFrame(worker: Worker, value: Record<string, unknown>): void {
    if (value.ready === true) {
      clearTimeout(worker.startTimer);
      worker.resolveReady();
      return;
    }
    if (typeof value.id !== "string") throw Error();
    const cancelling = worker.cancellations.get(value.id);
    if (value.cancelled === true && cancelling) {
      clearTimeout(cancelling);
      worker.cancellations.delete(value.id);
    }
    const request = worker.request;
    if (!request || request.id !== value.id) return;
    if (value.done === true) { request.finish(request.seq ? undefined : Error("本地语音没有返回音频。")); return; }
    if (typeof value.error === "string") { request.finish(Error("本地语音生成失败。")); return; }
    if (value.seq !== request.seq || typeof value.pcm !== "string" || !value.pcm.length
      || value.pcm.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.pcm)) throw Error();
    const size = Buffer.from(value.pcm, "base64").length;
    request.bytes += size;
    if (!size || size % 2 || size > MAX_PCM || request.bytes > 12 * 1024 * 1024) throw Error();
    request.seq++;
    try { request.emit(value.pcm); }
    catch { request.finish(Error("本地语音播放失败。")); this.retire(worker, new BreezeWorkerCrash("本地语音播放已停止。")); }
  }

  private retire(worker: Worker, error: Error, kill = true): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    clearTimeout(this.idle);
    clearTimeout(worker.startTimer);
    for (const timer of worker.cancellations.values()) clearTimeout(timer);
    worker.cancellations.clear();
    worker.rejectReady(error);
    worker.request?.finish(error);
    if (kill) { try { worker.child.kill("SIGKILL"); } catch { /* Child already closed. */ } }
  }

  private armIdle(): void {
    clearTimeout(this.idle);
    const worker = this.worker;
    if (worker && !this.stopped) this.idle = setTimeout(() => this.retire(worker, new BreezeWorkerCrash("本地语音已休眠。")), this.idleMs);
  }
}
