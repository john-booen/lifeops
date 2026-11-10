import { execFile } from "node:child_process";
import { request } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { BailianRealtimeTtsClient, type BailianRealtimeTtsCallbacks } from "./bailianTtsRealtime";
import { recordProviderEgress, utf8RequestBytes } from "./privacy";
import type { ProviderErrorCode, ProviderRequestOptions, RealtimeVoiceSettings } from "./types";
import { RealtimeProviderRun, type RealtimeProviderContext } from "./voice/realtimeProviderRun";

const MODEL = "breeze-tts-2";
const RATE = 24_000;
const AUDIO_TYPES = new Set(["application/octet-stream", "audio/pcm", "audio/raw", "audio/x-pcm"]);
type Binding = { key: string; voiceId: string };
let sessionBinding: Binding | undefined;

class BreezeFailure extends Error {
  constructor(readonly code: ProviderErrorCode, message: string, readonly httpStatus?: number) {
    super(message);
    if (code === "cancelled") this.name = "AbortError";
  }
}

function readBinding(signal: AbortSignal): Promise<Binding> {
  if (sessionBinding) return Promise.resolve(sessionBinding);
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/security", ["find-generic-password", "-s", "com.lifeops.breezeblue.tts",
      "-a", "lifeops-voice", "-w", join(homedir(), "Library/Keychains/login.keychain-db")],
    { signal, timeout: 15_000, maxBuffer: 2048, killSignal: "SIGKILL" }, (error, value) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const match = !error && /^(brz_[A-Za-z0-9_-]{24,256}):([A-Za-z0-9_-]{1,120})$/.exec(value.trim());
      if (!match) { reject(new BreezeFailure("configuration", "BreezeBlue 钥匙串未就绪。")); return; }
      sessionBinding = { key: match[1], voiceId: match[2] };
      resolve(sessionBinding);
    });
  });
}

function streamPcm(binding: Binding, body: string, signal: AbortSignal, onPcm: (pcm: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const url = new URL(`https://api.breeze.blue/v1/text-to-speech/${binding.voiceId}/stream?output_format=pcm&enable_logging=false`);
    const req = request(url, {
      method: "POST", signal, agent: false, headers: { "xi-api-key": binding.key, "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body), Accept: "audio/pcm" }
    }, response => {
      const status = response.statusCode ?? 0;
      const audioType = response.headers["content-type"]?.split(";")[0].trim().toLowerCase() ?? "";
      if (status !== 200 || !AUDIO_TYPES.has(audioType)) {
        reject(status === 200
          ? new BreezeFailure("invalid_response", "BreezeBlue 返回了未知音频格式。")
          : new BreezeFailure(status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limit" : "http",
            "BreezeBlue 没有返回音频。", status));
        response.destroy();
        return;
      }
      void (async () => {
        let carry: Buffer | undefined, total = 0;
        for await (const chunk of response) {
          signal.throwIfAborted();
          const bytes = carry ? Buffer.concat([carry, chunk]) : Buffer.from(chunk);
          const aligned = bytes.length - bytes.length % 2;
          carry = aligned === bytes.length ? undefined : bytes.subarray(aligned);
          total += aligned;
          if (total > RATE * 2 * 60) throw new BreezeFailure("invalid_response", "BreezeBlue 音频超过长度限制。");
          if (aligned) onPcm(bytes.subarray(0, aligned));
        }
        signal.throwIfAborted();
        if (!total || carry || !response.complete) throw new BreezeFailure("invalid_response", "BreezeBlue 音频未完整收到。");
      })().then(resolve, reject);
    });
    req.once("error", reject);
    req.end(body);
  });
}

/** Cloud failures before PCM fall back once, without resending speech to another provider. */
export class BreezeBlueTtsClient extends BailianRealtimeTtsClient {
  private active?: AbortController;

  constructor(settings: RealtimeVoiceSettings, private readonly callbacksBlue: BailianRealtimeTtsCallbacks,
    private readonly contextBlue: RealtimeProviderContext | undefined, private readonly local: BailianRealtimeTtsClient) {
    super(settings, callbacksBlue, contextBlue);
  }

  override async speak(text: string, options: ProviderRequestOptions = {}): Promise<void> {
    const clean = text.trim();
    if (!clean || Array.from(clean).length > 120) throw new BreezeFailure("configuration", "Breeze 语音每次最多 120 个字，请使用系统朗读。");
    this.cancel();
    const controller = new AbortController();
    this.active = controller;
    const cancel = () => controller.abort(new BreezeFailure("cancelled", "语音已取消。"));
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    let timer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    const requestControl = new AbortController();
    const cancelRequest = () => requestControl.abort(controller.signal.reason);
    controller.signal.addEventListener("abort", cancelRequest, { once: true });
    if (controller.signal.aborted) cancelRequest();
    const onTimeout = () => requestControl.abort(new BreezeFailure("timeout", "BreezeBlue 等待音频超时。"));
    const timeout = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(onTimeout, ms);
    };
    let received = false;
    const run = new RealtimeProviderRun("tts", MODEL, event => {
      try { this.callbacksBlue.onProviderRun?.(event); } catch { /* Metadata must not affect speech. */ }
      try { options.onProviderRun?.(event.run); } catch { /* Same boundary for shared request callbacks. */ }
    }, this.contextBlue, [], { provider: "breeze-blue", transport: "stream" });
    try {
      try {
        requestControl.signal.throwIfAborted();
        timeout(15_000);
        const binding = await readBinding(requestControl.signal);
        requestControl.signal.throwIfAborted();
        timeout(8_000);
        deadline = setTimeout(onTimeout, 60_000);
        const body = JSON.stringify({ text: clean, model_id: MODEL, language_code: "zh",
          instructions: "自然的普通话，温柔、亲切，像日常聊天。情绪细腻，语气自然。", voice_settings: { guidance_scale: 4 } });
        run.beginAttempt();
        void recordProviderEgress({ capability: "tts", provider: "breeze-blue", model: MODEL,
          purpose: "speech_synthesis", requestBytes: utf8RequestBytes(body), sourceCount: 0 }).catch(() => {});
        requestControl.signal.throwIfAborted();
        await streamPcm(binding, body, requestControl.signal, pcm => {
          if (!received) {
            received = true;
            this.callbacksBlue.onOpen?.();
          }
          requestControl.signal.throwIfAborted();
          timeout(8_000);
          this.callbacksBlue.onAudioDelta?.(pcm.toString("base64"), RATE);
        });
        controller.signal.throwIfAborted();
      } catch (error) {
        const reason = requestControl.signal.aborted ? requestControl.signal.reason : error;
        const failure = reason instanceof BreezeFailure ? reason : new BreezeFailure("network", "BreezeBlue 音频连接中断。");
        run.finish(failure.code === "cancelled" ? "cancelled" : "failed", failure.code, undefined, failure.httpStatus);
        controller.signal.throwIfAborted();
        if (received) throw failure;
        clearTimeout(timer);
        clearTimeout(deadline);
        await this.local.speak(clean, { ...options, signal: controller.signal });
        return;
      }
      run.finish("success");
      controller.signal.throwIfAborted();
      this.callbacksBlue.onResponseDone?.();
    } finally {
      clearTimeout(timer);
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", cancelRequest);
      if (this.active === controller) this.active = undefined;
    }
  }

  override cancel(code: ProviderErrorCode = "cancelled"): void {
    this.active?.abort(new BreezeFailure(code, "BreezeBlue 语音已停止。"));
  }
}
