import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { ProviderErrorCode, ProviderRequestOptions, RealtimeVoiceSettings } from "./types";
import { assertCredentialStorageAccepted, redactSensitiveText } from "./credentialSecurity";
import { providerDisclosureRequired, recordProviderEgress, utf8RequestBytes } from "./privacy";
import { ProviderRunFailure } from "./providerRun";
import { RealtimeProviderRun, realtimeProviderError, realtimeReportedModel } from "./voice/realtimeProviderRun";
import type { RealtimeProviderContext, RealtimeProviderRunEvent } from "./voice/realtimeProviderRun";

export interface BailianRealtimeTtsCallbacks {
  onOpen?: () => void;
  onAudioDelta?: (base64Audio: string, sampleRate: number) => void;
  onSentenceAudio?: (text: string) => void;
  onSentenceDone?: (text: string) => void;
  onResponseDone?: () => void;
  onError?: (message: string) => void;
  onProviderRun?: (event: RealtimeProviderRunEvent) => void;
}

interface TtsRequest {
  run: RealtimeProviderRun;
  socket: WebSocket | null;
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  receivedAudio: boolean;
  apiKey: string;
}

export class BailianRealtimeTtsClient {
  private current: TtsRequest | null = null;

  constructor(
    private readonly settings: RealtimeVoiceSettings,
    private readonly callbacks: BailianRealtimeTtsCallbacks = {},
    private readonly context?: RealtimeProviderContext
  ) {}

  async speak(text: string, options: ProviderRequestOptions = {}): Promise<void> {
    const clean = text.trim();
    const apiKey = this.settings.apiKey.trim();
    const run = new RealtimeProviderRun("tts", this.settings.ttsModel.trim() || "qwen3-tts-flash-realtime", (event) => {
      try { this.callbacks.onProviderRun?.(event); } catch { /* Metadata must not affect speech. */ }
      try { options.onProviderRun?.(structuredClone(run.run)); } catch { /* Same boundary for shared request callbacks. */ }
    }, this.context, [apiKey]);
    if (options.signal?.aborted) {
      run.finish("cancelled", "cancelled");
      throw new ProviderRunFailure(run.run, "cancelled");
    }
    try {
      if (!clean) throw new Error("百炼实时语音回复内容为空。");
      if (this.settings.dataDisclosureAccepted !== true) throw new Error(providerDisclosureRequired("voice"));
      if (!apiKey) throw new Error("百炼 Realtime API Key 未配置。");
      assertCredentialStorageAccepted(this.settings.plaintextCredentialStorageAccepted === true, apiKey);
    } catch (error) {
      const code = clean ? "configuration" : "invalid_response";
      run.finish("failed", code);
      throw new ProviderRunFailure(run.run, code, redactSensitiveText(error instanceof Error ? error.message : "百炼实时语音回复配置无效。", [apiKey]));
    }

    this.cancel();

    const requestPayloads = [
      this.buildSessionUpdatePayload(),
      { type: "input_text_buffer.append", text: clean },
      { type: "input_text_buffer.commit" }
    ].map(payload => ({ ...payload, event_id: randomUUID() }));
    const requestBody = requestPayloads.map(payload => JSON.stringify(payload)).join("\n");
    void recordProviderEgress({
      capability: "tts",
      provider: "bailian-realtime",
      model: this.settings.ttsModel.trim() || "qwen3-tts-flash-realtime",
      purpose: "speech_synthesis",
      requestBytes: utf8RequestBytes(requestBody),
      sourceCount: 0
    }, [apiKey]);

    await new Promise<void>((resolve, reject) => {
      const request: TtsRequest = { run, socket: null, resolve, reject, receivedAudio: false, apiKey, signal: options.signal };
      this.current = request;
      request.onAbort = () => this.finish(request, "cancelled", "cancelled");
      options.signal?.addEventListener("abort", request.onAbort, { once: true });
      if (options.signal?.aborted) { request.onAbort(); return; }
      let socket: WebSocket;
      try {
        const url = this.buildUrl();
        run.beginAttempt();
        socket = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        request.socket = socket;
      } catch (error) {
        const failure = realtimeProviderError(error);
        this.finish(request, "failed", failure.code, error instanceof Error ? error.message : undefined, failure.httpStatus);
        return;
      }
      request.timer = window.setTimeout(() => {
        this.finish(request, "failed", "timeout", "百炼实时语音回复连接超时。");
      }, 12_000);

      socket.on("open", () => {
        if (!this.isCurrent(request)) return;
        window.clearTimeout(request.timer);
        request.timer = window.setTimeout(() => {
          this.finish(request, "failed", "timeout", "百炼实时语音回复生成超时。");
        }, 60_000);
        try {
          for (const payload of requestPayloads) this.send(request, payload);
        } catch (error) {
          const failure = realtimeProviderError(error);
          this.finish(request, "failed", failure.code, error instanceof Error ? error.message : undefined, failure.httpStatus);
          return;
        }
        this.callbacks.onOpen?.();
      });
      socket.on("message", (data) => this.handleMessage(request, data));
      socket.on("error", (error) => {
        if (!this.isCurrent(request)) return;
        const failure = realtimeProviderError(error);
        this.finish(request, "failed", failure.code, error instanceof Error ? error.message : undefined, failure.httpStatus);
      });
      socket.on("close", (code, reason) => {
        if (!this.isCurrent(request)) return;
        const message = reason.toString("utf8") || `连接关闭：${code}`;
        const failure = realtimeProviderError(message);
        this.finish(request, "failed", failure.code, message, failure.httpStatus);
      });
    });
  }

  cancel(code: ProviderErrorCode = "cancelled"): void {
    if (this.current) this.finish(this.current, code === "cancelled" ? "cancelled" : "failed", code, undefined, undefined, true);
  }

  private buildUrl(): string {
    const endpoint = this.settings.endpoint.trim() || "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
    const url = new URL(endpoint);
    url.searchParams.set("model", this.settings.ttsModel.trim() || "qwen3-tts-flash-realtime");
    return url.toString();
  }

  private buildSessionUpdatePayload(): Record<string, unknown> {
    return {
      type: "session.update",
      session: {
        voice: this.settings.ttsVoice.trim() || "Cherry",
        language_type: normalizeTtsLanguage(this.settings.language),
        response_format: "pcm",
        sample_rate: normalizeSampleRate(this.settings.ttsSampleRate),
        mode: "commit"
      }
    };
  }

  private handleMessage(request: TtsRequest, data: WebSocket.RawData): void {
    if (!this.isCurrent(request)) return;
    const text = typeof data === "string" ? data : data.toString("utf8");
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(text) as Record<string, unknown>;
      if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid event");
    } catch {
      this.finish(request, "failed", "invalid_response", "百炼实时语音回复格式无效。");
      return;
    }

    const type = String(event.type ?? "");
    const response = event.response && typeof event.response === "object" ? event.response as Record<string, unknown> : undefined;
    const responseId = response?.id ?? event.response_id;
    if (typeof responseId === "string" && responseId) {
      if (request.run.responseId && request.run.responseId !== responseId) return;
      request.run.responseId = responseId;
    }
    request.run.observeModel(realtimeReportedModel(event));
    if (type === "error") {
      const error = event.error as { message?: string } | undefined;
      const failure = realtimeProviderError(error ?? event);
      this.finish(request, "failed", failure.code, error?.message, failure.httpStatus);
      return;
    }
    if (type === "response.audio.delta" || type === "response.output_audio.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        const bytes = /^[A-Za-z0-9+/]+={0,2}$/.test(delta) && delta.length % 4 !== 1 ? Buffer.from(delta, "base64").length : 0;
        if (bytes < 2 || bytes % 2 !== 0) {
          this.finish(request, "failed", "invalid_response", "百炼实时语音回复音频无效。");
          return;
        }
        request.receivedAudio = true;
        this.callbacks.onAudioDelta?.(delta, normalizeSampleRate(this.settings.ttsSampleRate));
      }
      return;
    }
    if (type === "response.done" || type === "response.completed") {
      const status = response?.status ?? event.status;
      const details = response?.status_details as { error?: { message?: string } } | undefined;
      if (status === "cancelled" || status === "canceled") {
        this.finish(request, "cancelled", "cancelled");
      } else if (details?.error) {
        const failure = realtimeProviderError(details.error);
        this.finish(request, "failed", failure.code, details.error.message, failure.httpStatus);
      } else if ((status !== undefined && status !== "completed" && status !== "success" && status !== "succeeded") || !request.receivedAudio) {
        this.finish(request, "failed", "invalid_response", "百炼实时语音回复未完整生成音频。");
      } else {
        this.finish(request, "success");
      }
    } else if (type === "session.finished") {
      this.finish(request, "failed", "invalid_response", "百炼实时语音会话结束前未确认生成完成。");
    }
  }

  private isCurrent(request: TtsRequest): boolean {
    return this.current === request && !request.run.settled;
  }

  private finish(request: TtsRequest, status: "success" | "failed" | "cancelled", code?: ProviderErrorCode, message?: string, httpStatus?: number, cancelledByCaller = false): void {
    if (!this.isCurrent(request)) return;
    this.current = null;
    window.clearTimeout(request.timer);
    if (request.onAbort) request.signal?.removeEventListener("abort", request.onAbort);
    // Detach ownership before closing: close/error handlers and consumer callbacks
    // may run synchronously and must not affect a replacement speak request.
    if (request.socket?.readyState === WebSocket.OPEN && (status === "cancelled" || cancelledByCaller)) {
      try { request.socket.send(JSON.stringify({ type: "response.cancel" })); } catch { /* Still close if sending cancellation fails. */ }
    }
    try {
      if (request.socket?.readyState === WebSocket.OPEN) {
        request.socket.close(1000);
      } else if (request.socket?.readyState === WebSocket.CONNECTING) request.socket.terminate();
    } catch {
      try { request.socket?.terminate(); } catch { /* The terminal result survives transport cleanup errors. */ }
    }
    request.run.finish(status, code, undefined, httpStatus);
    if (status === "success") {
      request.resolve();
      this.callbacks.onResponseDone?.();
    } else {
      const cleanMessage = redactSensitiveText(message || (status === "cancelled" ? "百炼实时语音回复已取消。" : "百炼实时语音回复失败。"), [request.apiKey]);
      const error = new ProviderRunFailure(request.run.run, code ?? "network", cleanMessage);
      if (cancelledByCaller) error.name = "AbortError";
      request.reject(error);
      if (status === "failed" && !cancelledByCaller) this.callbacks.onError?.(cleanMessage);
    }
  }

  private send(request: TtsRequest, payload: Record<string, unknown>): void {
    if (!this.isCurrent(request) || request.socket?.readyState !== WebSocket.OPEN) return;
    request.socket.send(JSON.stringify(payload));
  }
}

function normalizeTtsLanguage(language: string): string {
  const lower = language.trim().toLowerCase();
  if (lower.startsWith("en")) return "English";
  return "Chinese";
}

function normalizeSampleRate(sampleRate: number): number {
  return Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 24000;
}
