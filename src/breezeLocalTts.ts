import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { BailianRealtimeTtsClient, type BailianRealtimeTtsCallbacks } from "./bailianTtsRealtime";
import { BreezeBlueTtsClient } from "./breezeBlueTts";
import type { ProviderErrorCode, ProviderRequestOptions, RealtimeVoiceSettings } from "./types";
import type { RealtimeProviderContext } from "./voice/realtimeProviderRun";
import { BREEZE_LOCAL_WORKER_SOURCE } from "./breezeLocalTtsWorker";
import { breezeLocalPaths } from "./breezeLocalConfig";
import { BreezeResidentTtsClient } from "./voice/breezeSpeech";
import type { BreezeResidentWorker } from "./voice/breezeResident";

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_TOTAL = 12 * 1024 * 1024;

type Active = { child: ChildProcessWithoutNullStreams; cancel: () => void };

/** Offline and process-isolated: stopping a turn terminates inference immediately. */
export class BreezeLocalTtsClient extends BailianRealtimeTtsClient {
  private active: Active | null = null;
  private readonly closing = new Set<Promise<void>>();
  constructor(private readonly localSettings: RealtimeVoiceSettings, private readonly localCallbacks: BailianRealtimeTtsCallbacks = {}, context?: RealtimeProviderContext) {
    super(localSettings, localCallbacks, context);
  }
  override async speak(text: string, options: ProviderRequestOptions = {}): Promise<void> {
    const clean = text.trim();
    if (!clean || Array.from(clean).length > 120) throw new Error("本地语音支持每次最多 120 个字，请使用系统朗读。");
    if (options.signal?.aborted) throw abortError();
    const breeze = breezeLocalPaths(this.localSettings);
    this.cancel();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(breeze.python, ["-I", "-B", "-u", "-c", BREEZE_LOCAL_WORKER_SOURCE], { shell: false, stdio: ["pipe", "pipe", "pipe"], env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", TRANSFORMERS_OFFLINE: "1", TOKENIZERS_PARALLELISM: "false"
      }});
      let observeClose!: () => void;
      const closed = new Promise<void>(resolveClosed => { observeClose = resolveClosed; });
      this.closing.add(closed);
      child.once("close", () => { this.closing.delete(closed); observeClose(); });
      let settled = false, buffer = Buffer.alloc(0), total = 0, gotAudio = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error, kill = false): void => {
        if (settled) return;
        settled = true;
        if (this.active?.child === child) this.active = null;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (kill) { try { child.kill("SIGKILL"); } catch { /* already closed */ } }
        if (error) reject(error);
        else {
          try { this.localCallbacks.onResponseDone?.(); resolve(); }
          catch { reject(new Error("本地语音播放收尾失败。")); }
        }
      };
      const abort = (): void => finish(abortError(), true);
      this.active = { child, cancel: abort };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      timer = setTimeout(() => finish(new Error("本地语音生成超时。"), true), 120_000);
      child.stderr.resume(); // Never log model stderr: it could contain private reply text.
      child.on("error", () => finish(new Error("本地语音服务无法启动。"), true));
      child.stdout.on("data", (data: Buffer) => {
        if (settled || this.active?.child !== child) return;
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 4) {
          // A callback may synchronously cancel this turn or start its successor.
          if (settled || this.active?.child !== child) return;
          const size = buffer.readUInt32BE(0);
          if (size === 0 || size > MAX_FRAME || size % 2) { finish(new Error("本地语音数据无效。"), true); return; }
          if (buffer.length < size + 4) break;
          total += size;
          if (total > MAX_TOTAL) { finish(new Error("本地语音结果过长。"), true); return; }
          const pcm = buffer.subarray(4, size + 4); buffer = buffer.subarray(size + 4);
          gotAudio = true;
          try { this.localCallbacks.onAudioDelta?.(pcm.toString("base64"), 24000); }
          catch { finish(new Error("本地语音播放失败。"), true); return; }
        }
      });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0 || buffer.length || !gotAudio) finish(new Error("本地语音生成未完成。"));
        else finish();
      });
      child.stdin.on("error", () => finish(new Error("本地语音输入失败。"), true));
      child.stdin.end(JSON.stringify({ text: clean, breeze }) + "\n");
      try { this.localCallbacks.onOpen?.(); }
      catch { finish(new Error("本地语音播放器无法启动。"), true); }
    });
  }
  override cancel(_code?: ProviderErrorCode): void { this.active?.cancel(); }
  /** Cancellation settles promptly; this separately observes owned process closure. */
  async waitForIdle(): Promise<void> { await Promise.all([...this.closing]); }
}
function abortError(): Error { const err = new Error("本地语音已取消。"); err.name = "AbortError"; return err; }

export function createTtsClient(settings: RealtimeVoiceSettings, callbacks: BailianRealtimeTtsCallbacks, context?: RealtimeProviderContext,
  resident?: BreezeResidentWorker): BailianRealtimeTtsClient {
  if (settings.ttsEngine === "breeze-blue") {
    return new BreezeBlueTtsClient(settings, callbacks, context, new BreezeLocalTtsClient(settings, callbacks, context));
  }
  if (settings.ttsEngine === "breeze-local") {
    return resident ? new BreezeResidentTtsClient(settings, callbacks, resident, context) : new BreezeLocalTtsClient(settings, callbacks, context);
  }
  return new BailianRealtimeTtsClient(settings, callbacks, context);
}
