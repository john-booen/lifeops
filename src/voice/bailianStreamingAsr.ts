import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { BailianRealtimeCallbacks } from "../bailianRealtime";
import { assertCredentialStorageAccepted } from "../credentialSecurity";
import { providerDisclosureRequired, recordProviderEgress } from "../privacy";
import type { ProviderErrorCode, RealtimeVoiceSettings } from "../types";
import { voiceVadSilenceMs } from "./continuousInput";
import { asrHotwords, normalizeRealtimeAsrLanguage, STREAMING_ASR_MODEL, streamingAsrEndpoint } from "./realtimeAsrOptions";
import { realtimeProviderError, RealtimeProviderRun, type RealtimeProviderContext, type RealtimeProviderStage } from "./realtimeProviderRun";

interface StreamingSentence {
  text?: unknown;
  end_time?: unknown;
  sentence_end?: unknown;
  heartbeat?: unknown;
}

interface StreamingEvent {
  header?: { task_id?: unknown; event?: unknown; error_code?: unknown };
  payload?: { output?: { sentence?: StreamingSentence } };
}

interface StreamingConnection {
  socket: WebSocket;
  taskId: string;
  connected: boolean;
  finishing: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(error: Error): void;
  run: RealtimeProviderRun;
  capture?: { id: string; run: RealtimeProviderRun };
  lastEnd: number;
  audioBytes: number;
}

export class BailianStreamingAsr {
  private connection?: StreamingConnection;

  constructor(private readonly settings: RealtimeVoiceSettings, private readonly callbacks: BailianRealtimeCallbacks,
    private readonly context?: () => RealtimeProviderContext | undefined) {}

  async connect(): Promise<void> {
    if (this.settings.dataDisclosureAccepted !== true) throw new Error(providerDisclosureRequired("voice"));
    const key = this.settings.apiKey.trim();
    if (!key) throw new Error("请先配置百炼语音密钥。");
    assertCredentialStorageAccepted(this.settings.plaintextCredentialStorageAccepted === true, key);
    const endpoint = streamingAsrEndpoint(this.settings.endpoint);
    this.close();
    const taskId = randomUUID().replaceAll("-", "");
    const words = asrHotwords(this.settings.asrHotwords);
    const language = normalizeRealtimeAsrLanguage(this.settings.language);
    const parameters = { format: "pcm", sample_rate: 16000, heartbeat: true,
      max_sentence_silence: voiceVadSilenceMs(this.settings.vadSilenceMs),
      ...(language && /^[a-z]{2,3}$/.test(language) ? { language_hints: [language] } : {}),
      ...(words.length ? { vocabulary: Object.fromEntries(words.map(word => [word, 5])) } : {}) };
    const request = JSON.stringify({ header: { action: "run-task", task_id: taskId, streaming: "duplex" },
      payload: { task_group: "audio", task: "asr", function: "recognition", model: STREAMING_ASR_MODEL, parameters, input: {} } });
    const run = this.newRun("voice_connection");
    run.beginAttempt();
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${key}` }, maxPayload: 256 * 1024 });
      const timer = setTimeout(() => this.fail(connection, "timeout"), 12_000);
      const connection: StreamingConnection = { socket, taskId, connected: false, finishing: false,
        timer, resolve, reject, run, lastEnd: -1, audioBytes: 0 };
      this.connection = connection;
      socket.on("open", () => {
        if (this.connection !== connection) return;
        this.audit("realtime_connection", Buffer.byteLength(request));
        socket.send(request, error => { if (error) this.fail(connection, "network"); });
      });
      socket.on("message", data => this.receive(connection, data));
      socket.on("unexpected-response", (_request, response) => {
        response.resume();
        const failure = realtimeProviderError({ status: response.statusCode });
        this.fail(connection, failure.code, failure.httpStatus);
      });
      socket.on("error", error => this.fail(connection, realtimeProviderError(error).code));
      socket.on("close", () => this.fail(connection, "network"));
    });
  }

  appendPcm16(base64Audio: string): void {
    const connection = this.connection;
    if (!connection?.connected || connection.finishing || connection.socket.readyState !== WebSocket.OPEN) return;
    if (connection.socket.bufferedAmount > 256 * 1024) { this.fail(connection, "network"); return; }
    const audio = Buffer.from(base64Audio, "base64");
    if (!audio.length) return;
    connection.audioBytes += audio.length;
    connection.socket.send(audio, { binary: true }, error => { if (error) this.fail(connection, "network"); });
  }

  commit(): void {
    const connection = this.connection;
    if (!connection?.connected || connection.finishing || connection.socket.readyState !== WebSocket.OPEN) return;
    connection.finishing = true;
    connection.socket.send(JSON.stringify({ header: { action: "finish-task", task_id: connection.taskId, streaming: "duplex" },
      payload: { input: {} } }), error => { if (error) this.fail(connection, "network"); });
  }

  close(): void {
    if (this.connection) this.retire(this.connection, "cancelled");
  }

  private receive(connection: StreamingConnection, data: WebSocket.RawData): void {
    if (this.connection !== connection) return;
    let event: StreamingEvent;
    try { event = JSON.parse(data.toString()); } catch { return; }
    if (event?.header?.task_id !== connection.taskId) return;
    switch (event.header.event) {
      case "task-started":
        if (connection.connected) return;
        connection.connected = true;
        clearTimeout(connection.timer);
        connection.run.finish("success");
        connection.resolve();
        this.callbacks.onOpen?.();
        return;
      case "result-generated":
        if (connection.connected && event.payload?.output?.sentence) this.capture(connection, event.payload.output.sentence);
        return;
      case "task-failed":
        this.fail(connection, realtimeProviderError({ code: event.header.error_code }).code);
        return;
      case "task-finished":
        if (connection.finishing) this.retire(connection, "cancelled");
        else this.fail(connection, "network");
    }
  }

  private capture(connection: StreamingConnection, sentence: StreamingSentence): void {
    if (sentence.heartbeat === true) return;
    const text = typeof sentence.text === "string" ? sentence.text.trim() : "";
    const final = sentence.sentence_end === true;
    const end = typeof sentence.end_time === "number" && Number.isFinite(sentence.end_time) ? sentence.end_time : undefined;
    if (final && (end === undefined || end <= connection.lastEnd)) return;
    if (!connection.capture) {
      if (!text) return;
      const run = this.newRun("voice_asr");
      run.beginAttempt();
      connection.capture = { id: randomUUID(), run };
      this.callbacks.onCascadeCapture?.({ type: "started", itemId: connection.capture.id });
      if (this.connection !== connection) return;
    }
    const { id: itemId, run } = connection.capture;
    if (!final) {
      if (text) this.callbacks.onCascadeCapture?.({ type: "preview", itemId, text });
      return;
    }
    if (end !== undefined) connection.lastEnd = end;
    connection.capture = undefined;
    this.auditAudio(connection);
    if (!text) {
      run.finish("failed", "invalid_response");
      this.callbacks.onCascadeCapture?.({ type: "rejected", itemId });
      return;
    }
    run.finish("success");
    this.callbacks.onCascadeCapture?.({ type: "stopped", itemId });
    if (this.connection === connection) this.callbacks.onCascadeCapture?.({ type: "final", itemId, text });
  }

  private fail(connection: StreamingConnection, code: ProviderErrorCode, status?: number): void {
    if (this.connection !== connection) return;
    this.retire(connection, code, status);
    if (connection.connected && !connection.finishing) {
      const reason = "百炼热词识别连接已中断。";
      if (this.callbacks.onDisconnected) this.callbacks.onDisconnected({ code: 1006, reason });
      else this.callbacks.onError?.(reason);
    }
  }

  private retire(connection: StreamingConnection, code: ProviderErrorCode, status?: number): void {
    this.connection = undefined;
    clearTimeout(connection.timer);
    const outcome = code === "cancelled" ? "cancelled" : "failed";
    connection.run.finish(outcome, code, undefined, status);
    connection.capture?.run.finish(outcome, code, undefined, status);
    this.auditAudio(connection);
    if (!connection.connected) connection.reject(new Error(code === "timeout" ? "百炼热词识别连接超时。" : "百炼热词识别未连接。"));
    const socket = connection.socket;
    if (socket.readyState === WebSocket.OPEN) {
      try { socket.close(1000); return; }
      catch { /* Fall back to terminating this retired socket. */ }
    } else if (socket.readyState !== WebSocket.CONNECTING) return;
    try { socket.terminate(); }
    catch { /* Keep the disconnect notification and new connection available. */ }
  }

  private newRun(stage: RealtimeProviderStage): RealtimeProviderRun {
    let owner: RealtimeProviderContext | undefined;
    try { owner = this.context?.(); } catch { /* Metrics are optional. */ }
    return new RealtimeProviderRun(stage, STREAMING_ASR_MODEL, this.callbacks.onProviderRun,
      owner ? { sessionId: owner.sessionId, generation: owner.generation } : undefined, [this.settings.apiKey]);
  }

  private auditAudio(connection: StreamingConnection): void {
    if (!connection.audioBytes) return;
    this.audit("realtime_audio_turn", connection.audioBytes);
    connection.audioBytes = 0;
  }

  private audit(purpose: string, requestBytes: number): void {
    void recordProviderEgress({ capability: "voice", provider: "bailian-realtime", model: STREAMING_ASR_MODEL,
      purpose, requestBytes, sourceCount: 0 }, [this.settings.apiKey]).catch(() => undefined);
  }
}
