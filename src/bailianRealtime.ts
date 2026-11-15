import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { AiToolCall } from "./ai";
import type { ProviderErrorCode, RealtimeVoiceSettings } from "./types";
import { assertCredentialStorageAccepted, redactSensitiveText } from "./credentialSecurity";
import { providerDisclosureRequired, recordProviderEgress, utf8RequestBytes } from "./privacy";
import { providerIdentifier } from "./providerRun";
import { RealtimeProviderRun, realtimeProviderError, realtimeReportedModel, type RealtimeProviderContext, type RealtimeProviderRunEvent, type RealtimeProviderStage } from "./voice/realtimeProviderRun";
import { RealtimeInstructionsBoundary, type RealtimeInstructionsSnapshot } from "./voice/realtimeInstructionsBoundary";
import {RealtimeToolOutputs,disposeRealtimeToolOutput,type RealtimeToolOutput} from "./voice/realtimeToolOutput";
import { voiceVadSilenceMs, type CascadeCaptureEvent } from "./voice/continuousInput";
import { BailianStreamingAsr } from "./voice/bailianStreamingAsr";
import {
  buildOmniSessionUpdate,
  readOmniTerminalResponse, responseEventId, responseLifecycleEvent
} from "./voice/omniE2e/protocol";
import { normalizeRealtimeAsrLanguage } from "./voice/realtimeAsrOptions";
import { ProtectedOmniResponses } from "./voice/omniE2e/protectedResponses";
import { OmniResponseOutput } from "./voice/omniE2e/responseOutput";
import { OmniResponseIdentity } from "./voice/omniE2e/responseIdentity";
import { isRetryableOmniModelError, OmniModelRetry } from "./voice/omniE2e/modelRetry";
import { OmniToolCalls } from "./voice/omniE2e/toolCalls";
import { OmniInitialInstructions, RealtimeConnectionContextError } from "./voice/omniE2e/initialInstructions";
import { prepareOmniResponseContext } from "./voice/omniE2e/contextSources";

export const UNCONFIRMED_VOICE_CANCEL_MESSAGE = "语音取消未获确认，旧连接已停止；重新连接后请重说刚才一句。";

export interface BailianRealtimeCallbacks {
  onCascadeCapture?: (event: CascadeCaptureEvent) => void;
  onProviderRun?: (event: RealtimeProviderRunEvent) => void;
  onOpen?: () => void;
  onTranscriptDelta?: (text: string) => void;
  onTranscriptDone?: (text: string) => void;
  onSpeechStarted?: () => void;
  onSpeechStopped?: () => void;
  onSpeechRejected?: (event: BailianRealtimeSpeechBoundaryEvent) => void;
  onResponseCreated?: (response: BailianRealtimeResponseEvent) => void;
  onResponseTextDelta?: (text: string, response: BailianRealtimeResponseEvent) => void;
  onAudioDelta?: (
    base64Audio: string,
    sampleRate: number,
    response: BailianRealtimeResponseEvent
  ) => void;
  onResponseAudioDone?: (response: BailianRealtimeResponseEvent) => void;
  onResponseDone?: (text: string, response: BailianRealtimeResponseEvent) => void;
  onResponseFailed?: (message: string, response: BailianRealtimeResponseEvent) => void;
  onDisconnected?: (event: BailianRealtimeDisconnectEvent) => void;
  onTransportError?: (message: string) => void;
  onInitialContextError?: (message: string) => void;
  onToolCall?: (toolCall: AiToolCall) => Promise<string|RealtimeToolOutput> | string|RealtimeToolOutput;
  onToolContextError?: (message:string)=>void;
  onToolCommitted?: (text:string,response:BailianRealtimeResponseEvent)=>void;
  onToolSessionRetired?: ()=>void;
  onModelRetry?: (retry: BailianRealtimeModelRetry) => void;
  onError?: (message: string) => void;
}

export interface BailianRealtimeResponseEvent {
  eventType: string;
  responseId: string;
  status: string;
  toolContinuation?: {
    previousResponseId: string;
    callIds: string[];
  };
  retryOfResponseId?: string;
}

export interface BailianRealtimeDisconnectEvent {
  code: number;
  reason: string;
}

export interface BailianRealtimeSpeechBoundaryEvent {
  itemId: string;
  durationMs: number;
}

export interface BailianRealtimeModelRetry {
  attempt: number;
  delayMs: number;
  message: string;
}

export interface BailianRealtimeOptions {
  providerContext?: () => RealtimeProviderContext | undefined;
  mode?: "cascade" | "omni-e2e";
  instructions?: string;
  tools?: Array<Record<string, unknown>>;
  maxModelRetries?: number;
  prepareInstructions?: () => Promise<RealtimeInstructionsSnapshot>;
  initialInstructions?: RealtimeInstructionsSnapshot;
  sourceValidationRequired?: boolean;
}

export class BailianConnectionTimeoutError extends Error {
  constructor() { super("百炼 Realtime 连接超时。"); }
}

export class BailianRealtimeClient {
  private readonly streamingAsr?: BailianStreamingAsr;
  private readonly toolOutputs=new RealtimeToolOutputs();
  private readonly protectedResponses = new ProtectedOmniResponses({
    connection: () => this.socket,
    assertSourcesCurrent: () => this.assertContextSourcesCurrent(),
    assertSourcesCurrentNow: () => this.assertContextSourcesCurrentNow(),
    handle: event => this.handleEvent(event),
    handleStale: ({event, generation}, connection) => this.settleStaleProtectedResponse(event, generation, connection),
    fail: message => this.failToolContext(message)
  });
  private readonly initialInstructions: OmniInitialInstructions;
  private routedInitialReady?:{resolve():void;reject(error:unknown):void};
  private connectionRun: RealtimeProviderRun | undefined;
  private responseRun: RealtimeProviderRun | undefined;
  private readonly asrRuns = new Map<string, RealtimeProviderRun>();
  private unboundAsrRun: RealtimeProviderRun | undefined;
  private cancelConnecting: (() => void) | undefined;
  private connectionAckTimer = 0;
  private reportedModel: string | undefined;
  private responseReportedModel: string | undefined;
  private socket: WebSocket | null = null;
  private transcript = "";
  private readonly responseOutput: OmniResponseOutput;
  private intentionalClose = false;
  private readonly modelRetry = new OmniModelRetry();
  private speechStartTimestamp = 0;
  private speechStartAudioMs = 0;
  private currentSpeechItemId = "";
  private readonly responseIdentity = new OmniResponseIdentity();
  private responseRequestPending = false;
  private responseCancelPending = false;
  private queuedResponseCreate = false;
  private responseHasToolCall = false;
  private responseCancelTimer = 0;
  private responseGeneration = 0;
  private instructionsBoundary: RealtimeInstructionsBoundary | undefined;
  private responsePreparationPending = false;
  private readonly toolCalls = new OmniToolCalls();
  private requestedToolContinuation: BailianRealtimeResponseEvent["toolContinuation"] = undefined;
  private requestedRetryOfResponseId: string | undefined;
  private pendingInputAudioBytes = 0;
  private static readonly MIN_SPEECH_DURATION_MS = 300;
  private readonly ignoredInputItemIds = new Set<string>();
  private readonly retiredAsrItemIds = new Set<string>();
  private readonly auditCredentials: () => string[];

  constructor(
    private readonly settings: RealtimeVoiceSettings,
    private readonly callbacks: BailianRealtimeCallbacks = {},
    private readonly options: BailianRealtimeOptions = {}
  ) {
    this.responseOutput = new OmniResponseOutput(callbacks);
    if (!this.isOmniE2e() && settings.asrEngine === "streaming-hotwords") {
      this.streamingAsr = new BailianStreamingAsr(settings, callbacks, options.providerContext);
    }
    this.initialInstructions = new OmniInitialInstructions(options.initialInstructions, {
      connection: () => this.intentionalClose ? null : this.socket,
      accepted: event => {
        window.clearTimeout(this.connectionAckTimer);
        const model = providerIdentifier(realtimeReportedModel(event));
        if (model) this.reportedModel = model;
        this.connectionRun?.finish("success", undefined, model);
        this.initialInstructions.release();
        this.flushQueuedResponseCreate();
        this.routedInitialReady?.resolve();
      },
      failed: code => {
        this.connectionRun?.finish("failed", code);
        if (this.failRoutedRestore()) return;
        this.close();
        try { this.callbacks.onInitialContextError?.("首次语音资料未获当前确认，已停止连接；请重新开始语音。"); }
        catch { /* The closed session cannot retry a callback. */ }
      }
    });
    const keys = new Set([settings.apiKey.trim()]);
    this.auditCredentials = () => {
      keys.add(this.settings.apiKey.trim());
      return [...keys];
    };
  }

  connect(): Promise<void> {
    if (this.streamingAsr) return this.streamingAsr.connect();
    const connectionRun = this.newProviderRun("voice_connection");
    try {
    if (this.settings.dataDisclosureAccepted !== true) {
      throw new Error(providerDisclosureRequired("voice"));
    }
    const apiKey = this.settings.apiKey.trim();
    if (!apiKey) {
      throw new Error("百炼 Realtime API Key 未配置。");
    }
    assertCredentialStorageAccepted(this.settings.plaintextCredentialStorageAccepted === true, apiKey);
    if (this.socket) this.close();
    this.resetConnectionState();
    this.initialInstructions.capture(this.isOmniE2e(), Boolean(this.options.initialInstructions));
    } catch (error) {
      this.initialInstructions.release();
      if (this.options.initialInstructions && this.socket) this.close();
      connectionRun.finish("failed", "configuration");
      throw error;
    }
    const apiKey = this.settings.apiKey.trim();

    this.connectionRun = connectionRun;

    let sessionBody: string;
    try { sessionBody = JSON.stringify(this.buildSessionUpdatePayload()); }
    catch (error) { this.initialInstructions.release(); connectionRun.finish("failed", "configuration"); throw error; }
    void recordProviderEgress({
      capability: "voice",
      provider: "bailian-realtime",
      model: this.settings.model.trim() || "qwen3.5-omni-plus-realtime-2026-03-15",
      purpose: "realtime_connection",
      requestBytes: utf8RequestBytes(sessionBody),
      sourceCount: 0
    }, this.auditCredentials());

    return new Promise<void>((resolve, reject) => {
      const url = this.buildUrl();
      this.intentionalClose = false;
      connectionRun.beginAttempt();
      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`
        }
      });
      this.socket = socket;

      const timeout = window.setTimeout(() => {
        connectionRun.finish("failed", "timeout");
        reject(opening && this.initialInstructions.slot ? new RealtimeConnectionContextError() : new BailianConnectionTimeoutError());
        if (this.socket === socket) this.close();
      }, 12_000);
      this.cancelConnecting = () => {
        window.clearTimeout(timeout);
        const error = new Error("百炼 Realtime 连接已取消。"); error.name = "AbortError";
        reject(error);
      };

      let opening = false;
      socket.on("open", () => {
        if (opening) return; opening = true;
        if (this.socket !== socket || this.intentionalClose) {
          reject(new Error("百炼 Realtime 连接已关闭。"));
          return;
        }
        const openingSlot = this.initialInstructions.slot;
        const finishOpen = () => {
          if (this.connectionRun !== connectionRun || this.socket !== socket || this.intentionalClose
            || this.initialInstructions.slot !== openingSlot || this.options.initialInstructions && this.isOmniE2e() && !openingSlot) {
            throw new RealtimeConnectionContextError();
          }
          this.initialInstructions.assertCurrent();
          window.clearTimeout(timeout);
          this.cancelConnecting = undefined;
          if (this.isOmniE2e() && this.options.prepareInstructions) {
            this.instructionsBoundary = new RealtimeInstructionsBoundary({
              prepare: this.options.prepareInstructions,
              send: payload => this.send(payload),
              isCurrent: () => this.socket === socket && socket.readyState === WebSocket.OPEN && !this.intentionalClose,
              audit: async bytes => { await recordProviderEgress({capability: "voice", provider: "bailian-realtime", model: this.settings.model,
                purpose: "realtime_context_update", requestBytes: bytes, sourceCount: 0}, this.auditCredentials()); }
            });
          }
          const slot = this.initialInstructions.slot;
          this.connectionAckTimer = window.setTimeout(() => {
            if (this.socket !== socket || this.intentionalClose) return;
            if (slot && this.initialInstructions.slot === slot) this.initialInstructions.fail(slot, socket, "timeout");
            else {
              connectionRun.finish("failed", "timeout");
              if (!this.isOmniE2e()) {
                this.close();
                this.callbacks.onInitialContextError?.("百炼未确认语音会话，已停止。请重新开始语音。");
              }
            }
          }, 12_000);
          if (slot) slot.sent = true;
          this.sendSessionUpdate();
          if (this.socket !== socket || this.intentionalClose) throw new RealtimeConnectionContextError();
          this.callbacks.onOpen?.();
          resolve();
        };
        const failOpen = (error: unknown) => {
          window.clearTimeout(timeout);
          reject(this.options.initialInstructions ? new RealtimeConnectionContextError() : error);
          if (this.connectionRun === connectionRun && this.socket === socket) this.close();
        };
        try {
          this.initialInstructions.assertCurrent();
          if (openingSlot?.snapshot.assertSourcesCurrent) void openingSlot.snapshot.assertSourcesCurrent().then(finishOpen, failOpen).catch(failOpen);
          else finishOpen();
        } catch (error) { failOpen(error); }
      });
      socket.on("message", (data) => {
        if (this.socket === socket && !this.intentionalClose) this.handleMessage(data);
      });
      socket.on("error", (error) => {
        window.clearTimeout(timeout);
        if (this.socket !== socket || this.intentionalClose) {
          reject(new Error("百炼 Realtime 连接已关闭。"));
          return;
        }
        if(this.failRoutedRestore()){reject(new Error("保存后的语音连接恢复失败。"));return;}
        if(this.hasProtectedContextSources()){this.failToolContext();reject(new Error("语音查询连接已停止。"));return;}
        this.finishProviderFailures(error);
        window.clearTimeout(this.connectionAckTimer); this.initialInstructions.release();
        this.instructionsBoundary?.cancel();
        this.invalidatePendingResponseWork();
        const message = redactSensitiveText(error instanceof Error ? error.message : "百炼 Realtime WebSocket 错误。", [apiKey]);
        this.callbacks.onTransportError?.(message);
        reject(new Error(message));
      });
      socket.on("close", (code, reason) => {
        window.clearTimeout(timeout);
        if (this.socket !== socket || this.intentionalClose) {
          reject(new Error("百炼 Realtime 连接已关闭。"));
          return;
        }
        if(this.failRoutedRestore()){reject(new Error("保存后的语音连接恢复失败。"));return;}
        if(this.hasProtectedContextSources()){this.failToolContext();reject(new Error("语音查询连接已停止。"));return;}
        this.finishProviderFailures(reason.toString("utf8") || `连接关闭：${code}`);
        window.clearTimeout(this.connectionAckTimer); this.initialInstructions.release();
        this.instructionsBoundary?.cancel();
        this.invalidatePendingResponseWork();
        this.clearResponseCancelTimer();
        this.socket = null;
        const text = redactSensitiveText(reason.toString("utf8") || `连接关闭：${code}`, [apiKey]);
        reject(new Error(text));
        if (this.callbacks.onDisconnected) {
          this.callbacks.onDisconnected({
            code,
            reason: text
          });
        } else {
          this.callbacks.onError?.(text);
        }
      });
    }).catch(error => {
      if (this.connectionRun === connectionRun) this.initialInstructions.release();
      const failure = realtimeProviderError(error);
      connectionRun.finish("failed", failure.code, undefined, failure.httpStatus);
      throw error;
    });
  }

  appendPcm16(base64Audio: string): void {
    if (this.streamingAsr) return this.streamingAsr.appendPcm16(base64Audio);
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.pendingInputAudioBytes += decodedBase64Bytes(base64Audio);
    this.send({
      type: "input_audio_buffer.append",
      audio: base64Audio
    });
  }

  commit(): void {
    if (this.streamingAsr) return this.streamingAsr.commit();
    if (this.usesServerVad()) return;
    if (this.pendingInputAudioBytes > 0 && (!this.unboundAsrRun || this.unboundAsrRun.settled)) {
      this.unboundAsrRun = this.newProviderRun("voice_asr");
      this.unboundAsrRun.beginAttempt();
    }
    this.recordPendingAudioTurn();
    this.send({ type: "input_audio_buffer.commit" });
    if (this.isOmniE2e()) {
      this.createResponse();
    }
  }

  createResponse(): void {
    if (!this.isOmniE2e()) return;
    if (this.initialInstructions.slot || this.responseIdentity.active || this.responseRequestPending || this.responseCancelPending || this.toolCalls.hasContinuation) {
      this.queuedResponseCreate = true;
      return;
    }
    if (this.modelRetry.pending) this.responseRun?.finish("cancelled", "cancelled");
    this.prepareResponseTracking();
    this.requestResponse();
  }

  appendAssistantMessage(text: string): void {
    const content = text.replace(/\s+/g, " ").trim();
    if (!this.isOmniE2e() || !content) return;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "assistant",
        content: [{
          type: "text",
          text: content
        }]
      }
    });
  }

  /** Retire all server history before Main writes. A new connection must read
   * new original sources and receive its own exact initial ACK; no old fact
   * watcher, Ledger/WAL certificate or server conversation is rebased. */
  async suspendForRoutedWrite(current:()=>boolean):Promise<()=>Promise<void>> {
    if(!current()||!this.options.prepareInstructions||!this.hasProtectedContextSources())throw Error("语音保存交接尚未就绪。");
    await this.assertContextSourcesCurrent();
    if(!current())throw Error("这轮语音已经结束，未派发保存。");
    this.assertContextSourcesCurrentNow();
    this.close();
    const generation=this.responseGeneration;
    let used=false;
    return async()=>{
      if(used)throw Error("语音保存交接不能重复使用。");used=true;
      let live=true,ownedSocket:WebSocket|null=null,timer:ReturnType<typeof setTimeout>|undefined;
      const suspended=()=>live&&current()&&this.intentionalClose&&this.socket===null&&this.responseGeneration===generation;
      const ready={resolve:()=>{},reject:(_error:unknown)=>{}};
      const accepted=new Promise<void>((resolve,reject)=>{ready.resolve=resolve;ready.reject=reject;});
      // Attach rejection immediately: a cancellation may happen during prepare.
      void accepted.catch(()=>undefined);
      const work=async()=>{
        if(!suspended())throw Error("语音保存交接已经结束。");
        const snapshot=await this.options.prepareInstructions!();
        if(!suspended()){snapshot.dispose?.();throw Error("语音保存交接已经结束。");}
        this.initialInstructions.replace(snapshot);this.routedInitialReady=ready;
        const connecting=this.connect();ownedSocket=this.socket;
        await connecting;await accepted;
        if(!live||!current()||this.socket!==ownedSocket||this.intentionalClose)throw Error("新的语音资料连接已经结束。");
      };
      try{await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("语音保存后的重新连接超时，请重新开始语音。")),12_000);})]);}
      catch(error){live=false;if(ownedSocket&&this.socket===ownedSocket)this.close();throw error;}
      finally{live=false;if(timer!==undefined)clearTimeout(timer);if(this.routedInitialReady===ready)this.routedInitialReady=undefined;}
    };
  }

  resetTranscript(): void {
    this.transcript = "";
  }

  cancelResponse(cause?: ProviderErrorCode): void {
    if (this.intentionalClose || !this.socket) return;
    // Tool-derived history retires as before. Ordinary interruption keeps its
    // source owners; a cancelled response never erases those sources.
    if (this.toolOutputs.protected) {
      this.retireForLocalNotification();
      this.callbacks.onToolSessionRetired?.();
      return;
    }
    const preparing = this.responsePreparationPending;
    this.responseRun?.finish(cause && cause !== "cancelled" ? "failed" : "cancelled", cause ?? "cancelled");
    this.invalidatePendingResponseWork();
    this.queuedResponseCreate = false;
    if (preparing && !this.responseIdentity.active) {
      this.responseRequestPending = false;
      this.responseCancelPending = false;
      return;
    }
    if (this.responseIdentity.active) {
      this.responseIdentity.retire(this.responseIdentity.active);
    }
    this.responseCancelPending = Boolean(this.responseIdentity.active || this.responseRequestPending);
    this.send({ type: "response.cancel" });
    if (this.responseCancelPending) {
      this.clearResponseCancelTimer();
      this.responseCancelTimer = window.setTimeout(() => {
        this.settleCancelledResponse();
      }, 2_000);
    }
  }

  close(): void {
    if (this.streamingAsr) return this.streamingAsr.close();
    this.routedInitialReady?.reject(Error("语音资料连接已经结束。"));
    this.initialInstructions.release();
    this.instructionsBoundary?.cancel();
    this.instructionsBoundary = undefined;
    window.clearTimeout(this.connectionAckTimer);
    this.connectionAckTimer = 0;
    this.connectionRun?.finish("cancelled", "cancelled");
    this.responseRun?.finish("cancelled", "cancelled");
    this.unboundAsrRun?.finish("cancelled", "cancelled");
    for (const run of this.asrRuns.values()) run.finish("cancelled", "cancelled");
    this.cancelConnecting?.();
    this.cancelConnecting = undefined;
    this.recordPendingAudioTurn();
    this.intentionalClose = true;
    this.invalidatePendingResponseWork();
    this.queuedResponseCreate = false;
    this.clearResponseCancelTimer();
    const socket=this.socket;this.socket=null;
    let failed=false,failure:unknown;
    for(const dispose of[
      () => {
        if (!socket) return;
        if (socket.readyState === WebSocket.OPEN) {
          try { socket.close(1000); return; }
          catch { /* Force-close this retired socket when graceful close fails. */ }
        }
        socket.terminate();
      },
      ()=>this.toolOutputs.dispose(),()=>this.protectedResponses.reset()
    ])try{dispose();}catch(error){if(!failed){failed=true;failure=error;}}
    this.asrRuns.clear();
    this.unboundAsrRun = undefined;
    this.responseIdentity.clearRetired();
    this.ignoredInputItemIds.clear();
    this.retiredAsrItemIds.clear();
    if(failed)throw failure;
  }

  private buildUrl(): string {
    const endpoint = this.settings.endpoint.trim() || "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
    const url = new URL(endpoint);
    url.searchParams.set("model", this.settings.model.trim() || "qwen3.5-omni-plus-realtime-2026-03-15");
    return url.toString();
  }

  private sendSessionUpdate(): void {
    this.initialInstructions.assertCurrent();
    this.send(this.buildSessionUpdatePayload());
  }

  private buildSessionUpdatePayload(): Record<string, unknown> {
    const language = normalizeRealtimeAsrLanguage(this.settings.language);
    if (this.isOmniE2e()) {
      return buildOmniSessionUpdate(this.settings, this.options, this.initialInstructions.slot, language);
    }
    return {
      type: "session.update",
      session: {
        modalities: ["text"],
        input_audio_format: "pcm16",
        input_audio_transcription: {
          model: "qwen3-asr-flash-realtime",
          ...(language ? { language } : {})
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.35,
          prefix_padding_ms: 400,
          silence_duration_ms: voiceVadSilenceMs(this.settings.vadSilenceMs),
          create_response: false
        }
      }
    };
  }

  private recordPendingAudioTurn(): void {
    if (this.pendingInputAudioBytes <= 0) return;
    const requestBytes = this.pendingInputAudioBytes;
    this.pendingInputAudioBytes = 0;
    void recordProviderEgress({
      capability: "voice",
      provider: "bailian-realtime",
      model: this.settings.model.trim() || "qwen3.5-omni-plus-realtime-2026-03-15",
      purpose: "realtime_audio_turn",
      requestBytes,
      sourceCount: 0
    }, this.auditCredentials());
  }

  private handleMessage(data: WebSocket.RawData): void {
    const text = typeof data === "string" ? data : data.toString("utf8");
    let event: Record<string, unknown>;
    try {
      const decoded: unknown = JSON.parse(text);
      if (!isRecord(decoded) || typeof decoded.type !== "string" || !decoded.type) return;
      event = decoded;
    } catch {
      return;
    }

    if(this.hasProtectedContextSources() && (String(event.type??"").startsWith("response.") || event.type==="error")){
      if(this.responseIdentity.isRetired(responseEventId(event))){
        // Acknowledging cancellation carries no old text/audio. Settle promptly
        // so a normal barge-in need not wait for the two-second fallback timer.
        if(event.type==="response.done"||event.type==="response.completed")this.handleIgnoredResponseDone(event);
        return;
      }
      this.protectedResponses.enqueue({ event, generation: this.responseGeneration, current: this.capturePendingResponseGuard() },
        Buffer.byteLength(text, "utf8"));
      return;
    }
    this.handleEvent(event);
  }

  private settleStaleProtectedResponse(event: Record<string, unknown>, generation: number, connection: object | null): void {
    // A stale response identity can still permit cancellation to finish.
    if (this.socket !== connection || this.intentionalClose || event.type !== "response.created") return;
    if (this.responseGeneration === generation + 1 && this.responseCancelPending && !this.responseIdentity.active) {
      this.handleResponseCreated(event);
    } else {
      const id = responseEventId(event);
      if (id) this.responseIdentity.retire(id);
    }
  }

  hasProtectedToolOutputs():boolean{return this.toolOutputs.protected;}
  hasProtectedContextSources():boolean{return !this.intentionalClose&&this.toolOutputs.protected;}
  allowsContextCandidateObservation():boolean{return this.toolOutputs.allowsCandidateObservation;}
  async duringContextCandidateObservation(operation:()=>Promise<void>):Promise<void>{
    await this.toolOutputs.duringCandidateObservation(operation);
  }
  assertContextSourcesCurrentNow():void{this.assertToolOutputsCurrentNow();}
  async assertContextSourcesCurrent():Promise<void>{await this.assertToolOutputsCurrent();this.assertContextSourcesCurrentNow();}
  allowsToolCandidateObservation():boolean{return this.toolOutputs.allowsCandidateObservation;}
  async duringToolCandidateObservation(operation:()=>Promise<void>):Promise<void>{await this.toolOutputs.duringCandidateObservation(operation);}
  assertToolOutputsCurrentNow():void{this.toolOutputs.assertCurrent();}
  async assertToolOutputsCurrent():Promise<void>{this.toolOutputs.assertCurrent();}
  private failToolContext(message="本次语音查询的资料或权限已变化或暂时无法核对，已停止使用旧结果；请重新开始语音。已保存的操作保留，请勿重复保存。"):void{
    this.responseRun?.finish("failed","invalid_response");
    if(this.failRoutedRestore())return;
    this.retireForLocalNotification();
    if(this.callbacks.onToolContextError)this.callbacks.onToolContextError(message);
    else this.callbacks.onError?.(message);
  }

  private retireForLocalNotification(): void {
    try { this.close(); }
    catch (error) {
      if (!this.intentionalClose || this.socket) throw error;
      // The old connection has lost ownership. Its cleanup cannot block the local result.
    }
  }

  /** Main still owns a possible committed receipt during restore. A general
   * View stop/reconnect callback would abort that producer before it can return
   * the receipt. Reject only this handoff and let its existing owner settle. */
  private failRoutedRestore():boolean{
    if(!this.routedInitialReady)return false;
    this.routedInitialReady.reject(new Error("保存后的语音连接恢复失败，请核对实际执行回执。"));
    this.close();return true;
  }

  private handleEvent(event:Record<string,unknown>):void{

    const type = String(event.type ?? "");
    if (this.initialInstructions.accept(event)) return;
    if (this.instructionsBoundary?.acceptSessionEvent(event)) return;
    const asrItemId = inputItemId(event) || (type === "input_audio_buffer.speech_started"
      || (this.unboundAsrRun && !this.unboundAsrRun.settled) ? "" : this.currentSpeechItemId);
    if ((type.startsWith("conversation.item.input_audio_transcription.")
      || type === "input_audio_buffer.speech_started" || type === "input_audio_buffer.speech_stopped")
      && asrItemId && (this.retiredAsrItemIds.has(asrItemId) || this.ignoredInputItemIds.has(asrItemId))) return;
    if (type.startsWith("conversation.item.input_audio_transcription.")
      && asrItemId && this.asrRuns.get(asrItemId)?.settled) return;
    const reportedModel = providerIdentifier(realtimeReportedModel(event));
    if (reportedModel && type.startsWith("session.")) this.reportedModel = reportedModel;
    if (type === "session.updated") {
      window.clearTimeout(this.connectionAckTimer);
      this.connectionRun?.finish("success", undefined, reportedModel);
    }
    // Cascade listens only for ASR. It has no owner for unsolicited model responses.
    if (!this.isOmniE2e() && (type.startsWith("response.") || type === "error" && responseEventId(event))) return;
    if ((type === "error" || type.endsWith(".failed")) && responseEventId(event)
      && !this.shouldAcceptResponseEvent(event)) return;
    if(this.hasProtectedContextSources() && (type.endsWith(".failed") || type==="error")){
      // Never fall back with the preceding tool text after a failed transport.
      this.failToolContext();return;
    }
    if (type === "error") {
      const error = event.error as { message?: string } | undefined;
      const message = redactSensitiveText(error?.message || "百炼 Realtime 返回错误。", [this.settings.apiKey]);
      const failure = realtimeProviderError(error);
      window.clearTimeout(this.connectionAckTimer);
      this.connectionRun?.finish("failed", failure.code, undefined, failure.httpStatus);
      if (!responseEventId(event) && this.responseRun?.settled) return;
      this.responseRun?.failAttempt(failure.code, failure.httpStatus);
      if (!responseEventId(event) && this.maybeRetryModelError(message)) return;
      this.responseRun?.finish("failed", failure.code, undefined, failure.httpStatus);
      if (responseEventId(event)) this.responseIdentity.retire(responseEventId(event));
      if (responseEventId(event)) {
        if (this.callbacks.onResponseFailed) {
          this.callbacks.onResponseFailed(message, responseLifecycleEvent(event, this.responseIdentity.active));
        } else {
          this.callbacks.onError?.(message);
        }
        this.settleFailedResponse(event);
      } else {
        this.callbacks.onError?.(message);
      }
      return;
    }
    if (type === "conversation.item.input_audio_transcription.failed" || type.endsWith(".failed")) {
      const error = event.error as { message?: string } | undefined;
      const message = redactSensitiveText(error?.message || "百炼 Realtime 转写失败。", [this.settings.apiKey]);
      const failure = realtimeProviderError(error);
      if (type === "conversation.item.input_audio_transcription.failed") this.asrRunForEvent(event, true)?.finish("failed", failure.code, undefined, failure.httpStatus);
      else this.responseRun?.failAttempt(failure.code, failure.httpStatus);
      if (!type.startsWith("response.") && this.maybeRetryModelError(message)) return;
      if (type.startsWith("response.")) {
        this.responseRun?.finish("failed", failure.code, undefined, failure.httpStatus);
        if (responseEventId(event)) this.responseIdentity.retire(responseEventId(event));
      }
      if (type.startsWith("response.")) {
        if (this.callbacks.onResponseFailed) {
          this.callbacks.onResponseFailed(message, responseLifecycleEvent(event, this.responseIdentity.active));
        } else {
          this.callbacks.onError?.(message);
        }
        this.settleFailedResponse(event);
      } else {
        this.callbacks.onError?.(message);
      }
      return;
    }
    if (type === "response.created") {
      this.handleResponseCreated(event);
      return;
    }
    const usageOwnerId = this.responseRun?.responseId;
    if (type.startsWith("response.") && !this.shouldAcceptResponseEvent(event)) {
      if (type === "response.done" || type === "response.completed") {
        this.handleIgnoredResponseDone(event);
      }
      return;
    }
    if (type.startsWith("response.") && this.responseRun && !this.responseRun.settled) {
      this.responseRun.responseId ||= responseEventId(event);
      this.responseReportedModel = providerIdentifier(realtimeReportedModel(event)) ?? this.responseReportedModel;
    }
    if (type.startsWith("response.") && this.responseOutput.accept(event, this.responseIdentity.active, this.settings.ttsSampleRate)) return;
    if (type === "response.function_call_arguments.delta") {
      this.toolCalls.accumulate(event);
      return;
    }
    if (type === "response.function_call_arguments.done" || type === "response.output_item.done") {
      if (this.handleToolCallEvent(event)) {
        this.responseHasToolCall = true;
        return;
      }
    }
    if (type === "response.done" || type === "response.completed") {
      const terminal = readOmniTerminalResponse(event, this.responseIdentity.active,
        usageOwnerId === this.responseRun?.responseId ? usageOwnerId : undefined);
      const responseEvent = terminal.response;
      if ("usage" in terminal) this.responseRun?.observeResponseUsage(terminal.usage);
      if (terminal.failureMessage !== undefined) {
        if(this.hasProtectedContextSources()){this.failToolContext();return;}
        const message = redactSensitiveText(terminal.failureMessage, [this.settings.apiKey]);
        const failure = realtimeProviderError(message);
        const code = responseEvent.status === "cancelled" ? "cancelled" : failure.code === "network" ? "invalid_response" : failure.code;
        this.responseRun?.finish(code === "cancelled" ? "cancelled" : "failed", code, undefined, failure.httpStatus);
        if (responseEvent.responseId) this.responseIdentity.retire(responseEvent.responseId);
        if (this.callbacks.onResponseFailed) {
          this.callbacks.onResponseFailed(message, responseEvent);
        } else {
          this.callbacks.onError?.(message);
        }
        this.settleFailedResponse(event);
        return;
      }
      this.responseRun?.finish(this.responseHasToolCall || this.responseOutput.hasOutput ? "success" : "failed", "invalid_response", this.responseReportedModel ?? this.reportedModel);
      if (responseEvent.responseId) this.responseIdentity.retire(responseEvent.responseId);
      if (this.responseHasToolCall) {
        this.toolCalls.markResponseDone(responseEvent.responseId);
        this.clearActiveResponse(event);
        this.responseHasToolCall = false;
        this.requestToolContinuationWhenReady();
        this.flushQueuedResponseCreate();
        return;
      }
      const doneText = this.responseOutput.completed();
      this.callbacks.onResponseDone?.(doneText, responseEvent);
      this.responseOutput.clearText();
      this.modelRetry.reset();
      this.clearActiveResponse(event);
      this.flushQueuedResponseCreate();
      return;
    }
    if (type.startsWith("response.") || type.startsWith("session.")) {
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      this.currentSpeechItemId = inputItemId(event);
      this.asrRunForEvent(event, true);
      this.speechStartTimestamp = Date.now();
      this.speechStartAudioMs = numberValue(event.audio_start_ms);
      this.currentSpeechItemId = inputItemId(event);
      this.transcript = "";
      this.callbacks.onSpeechStarted?.();
      this.callbacks.onCascadeCapture?.({ type: "started", itemId: this.currentSpeechItemId });
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      const itemId = inputItemId(event) || this.currentSpeechItemId;
      const audioEndMs = numberValue(event.audio_end_ms);
      const speechDuration = audioEndMs > this.speechStartAudioMs
        ? audioEndMs - this.speechStartAudioMs
        : Date.now() - this.speechStartTimestamp;
      if (speechDuration < BailianRealtimeClient.MIN_SPEECH_DURATION_MS) {
        this.asrRunForEvent(event)?.finish("cancelled", "cancelled");
        if (itemId) this.rememberInputId(this.ignoredInputItemIds, itemId);
        this.callbacks.onSpeechRejected?.({
          itemId,
          durationMs: Math.max(0, speechDuration)
        });
        this.callbacks.onCascadeCapture?.({ type: "rejected", itemId });
        return;
      }
      this.callbacks.onSpeechStopped?.();
      this.callbacks.onCascadeCapture?.({ type: "stopped", itemId });
      return;
    }

    if (this.ignoredInputItemIds.has(inputItemId(event))) {
      return;
    }

    const preview = this.extractTranscriptPreview(event);
    if (preview) {
      this.transcript = preview;
      this.callbacks.onTranscriptDelta?.(preview);
      this.callbacks.onCascadeCapture?.({ type: "preview", itemId: asrItemId, text: preview });
      return;
    }

    const delta = this.extractTranscriptDelta(event);
    if (delta) {
      this.transcript = `${this.transcript}${delta}`;
      this.callbacks.onTranscriptDelta?.(this.transcript);
      this.callbacks.onCascadeCapture?.({ type: "preview", itemId: asrItemId, text: this.transcript });
    }

    const done = this.extractTranscriptDone(event);
    const asrCompleted = type === "conversation.item.input_audio_transcription.completed";
    if (asrCompleted) {
      this.asrRunForEvent(event, true)?.finish(done.trim() ? "success" : "failed", done.trim() ? undefined : "invalid_response", realtimeReportedModel(event));
    }
    if (done && (!asrCompleted || done.trim())) {
      if (!asrCompleted) this.asrRunForEvent(event)?.finish("success", undefined, realtimeReportedModel(event));
      this.transcript = done;
      this.callbacks.onTranscriptDone?.(done);
      this.callbacks.onCascadeCapture?.({ type: "final", itemId: asrItemId, text: done });
    }
  }

  private extractTranscriptDelta(event: Record<string, unknown>): string {
    const direct = event.delta ?? event.transcript_delta;
    if (typeof direct === "string") return direct;

    const item = event.item as Record<string, unknown> | undefined;
    const content = item?.content as Array<Record<string, unknown>> | undefined;
    const transcript = content?.map((entry) => entry.transcript).filter((value): value is string => typeof value === "string").join("");
    return transcript || "";
  }

  private extractTranscriptPreview(event: Record<string, unknown>): string {
    if (
      event.type !== "conversation.item.input_audio_transcription.delta"
      && event.type !== "conversation.item.input_audio_transcription.text"
    ) {
      return "";
    }
    const text = typeof event.text === "string" ? event.text : "";
    const stash = typeof event.stash === "string" ? event.stash : "";
    const delta = typeof event.delta === "string" ? event.delta : "";
    return `${text}${stash || delta}`.trim();
  }

  private extractTranscriptDone(event: Record<string, unknown>): string {
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = event.transcript ?? event.text;
      return typeof transcript === "string" ? transcript : "";
    }
    const direct = event.transcript ?? event.text;
    if (typeof direct === "string") return direct;

    const item = event.item as Record<string, unknown> | undefined;
    const content = item?.content as Array<Record<string, unknown>> | undefined;
    const transcript = content?.map((entry) => entry.transcript).filter((value): value is string => typeof value === "string").join("");
    return transcript || "";
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.settings.model.trim() === "qwen3.8-omni-flash-realtime" && !payload.event_id) {
      payload = { ...payload, event_id: `event_${randomUUID()}` };
    }
    this.socket.send(JSON.stringify(payload));
  }

  private isOmniE2e(): boolean {
    return (this.options.mode ?? this.settings.mode ?? "cascade") === "omni-e2e";
  }

  private usesServerVad(): boolean {
    return this.isOmniE2e();
  }

  private prepareResponseTracking(): void {
    this.responseOutput.reset();
    this.modelRetry.reset();
    this.toolCalls.clearHandledCalls();
  }

  private invalidatePendingResponseWork(): void {
    this.modelRetry.cancel();
    this.responsePreparationPending = false;
    this.responseGeneration += 1;
    this.protectedResponses.cancelYield();
    this.toolCalls.invalidate();
    this.requestedToolContinuation = undefined;
    this.requestedRetryOfResponseId = undefined;
  }

  private resetConnectionState(): void {
    this.protectedResponses.reset();
    this.instructionsBoundary?.cancel();
    this.instructionsBoundary = undefined;
    this.reportedModel = undefined;
    this.responseReportedModel = undefined;
    this.responseRun = undefined;
    this.asrRuns.clear();
    this.unboundAsrRun = undefined;
    this.invalidatePendingResponseWork();
    this.clearResponseCancelTimer();
    this.transcript = "";
    this.responseIdentity.clear();
    this.responseRequestPending = false;
    this.responseCancelPending = false;
    this.queuedResponseCreate = false;
    this.responseHasToolCall = false;
    this.currentSpeechItemId = "";
    this.ignoredInputItemIds.clear();
    this.retiredAsrItemIds.clear();
    this.responseIdentity.clearRetired();
    this.prepareResponseTracking();
  }

  private capturePendingResponseGuard(): () => boolean {
    // A tool may finish after response.done; only cancellation/failure or a new connection retires it.
    const generation = this.responseGeneration;
    const socket = this.socket;
    return () => generation === this.responseGeneration
      && this.socket === socket
      && socket?.readyState === WebSocket.OPEN
      && !this.intentionalClose;
  }

  private requestResponse(toolContinuation?: BailianRealtimeResponseEvent["toolContinuation"], retryOfResponseId?: string): void {
    if (this.intentionalClose || this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.initialInstructions.slot) { this.queuedResponseCreate = true; return; }
    if (!this.responseRun || this.responseRun.settled) this.responseRun = this.newProviderRun("voice_response");
    // Response model identity belongs to this attempt. A failed attempt's model
    // and later model-less events must not overwrite the successful response.
    this.responseReportedModel = undefined;
    this.responseRequestPending = true;
    this.requestedToolContinuation = toolContinuation;
    this.requestedRetryOfResponseId = retryOfResponseId;
    const current = this.capturePendingResponseGuard();
    const sendResponse = () => {
      this.assertContextSourcesCurrentNow();
      this.responsePreparationPending = false;
      this.responseRun!.beginAttempt();
      this.send({ type: "response.create" });
    };
    if (!this.instructionsBoundary && !this.hasProtectedContextSources()) { sendResponse(); return; }
    this.responsePreparationPending = true;
    void prepareOmniResponseContext({
      hasProtectedSources: () => this.hasProtectedContextSources(),
      assertSourcesCurrent: () => this.assertContextSourcesCurrent(),
      assertSourcesCurrentNow: () => this.assertContextSourcesCurrentNow()
    }, this.instructionsBoundary, current, sendResponse).catch(() => {
      if (!current()) return;
      if(this.hasProtectedContextSources()){this.failToolContext();return;}
      if(this.options.sourceValidationRequired || this.instructionsBoundary?.requiresSourceValidation){
        // The service may already hold the acknowledged old instructions.
        // Retire that socket rather than retry/fallback with its context.
        this.failToolContext("本轮语音基础资料或权限已变化或暂时无法核对，已结束连接并保留听到的文字；请重新开始语音。");return;
      }
      this.responsePreparationPending = false;
      this.responseRequestPending = false;
      this.responseRun?.finish("failed", "invalid_response");
      this.callbacks.onError?.("本轮上下文刷新未完成，已保留听到的文字，交由管家重新核对后回答。");
    });
  }

  private requestToolContinuationWhenReady(): void {
    if (this.responseIdentity.active || this.responseRequestPending || this.responseCancelPending
      || this.intentionalClose || this.socket?.readyState !== WebSocket.OPEN) return;
    const continuation = this.toolCalls.takeReadyContinuation();
    if (!continuation) return;
    this.queuedResponseCreate = false;
    this.prepareResponseTracking();
    this.requestResponse(continuation);
  }

  private handleResponseCreated(event: Record<string, unknown>): void {
    const responseId = responseEventId(event);
    if (!this.responseIdentity.bindCreated(responseId, this.responseCancelPending)) return;
    const toolContinuation = this.responseRequestPending ? this.requestedToolContinuation : undefined;
    const retryOfResponseId = this.responseRequestPending ? this.requestedRetryOfResponseId : undefined;
    this.responseRequestPending = false;
    this.requestedToolContinuation = undefined;
    this.requestedRetryOfResponseId = undefined;
    if (this.responseCancelPending) {
      this.responseIdentity.retire(responseId);
      return;
    }
    if (!this.responseRun || this.responseRun.settled) {
      this.responseRun = this.newProviderRun("voice_response");
      this.responseRun.beginAttempt();
    }
    this.responseRun.responseId = responseId;
    this.responseReportedModel = providerIdentifier(realtimeReportedModel(event)) ?? this.responseReportedModel;
    this.callbacks.onResponseCreated?.({
      ...responseLifecycleEvent(event, responseId),
      ...(toolContinuation ? { toolContinuation } : {}),
      ...(retryOfResponseId ? { retryOfResponseId } : {})
    });
  }

  private shouldAcceptResponseEvent(event: Record<string, unknown>): boolean {
    const accepted = this.responseIdentity.acceptOutput(responseEventId(event), this.responseCancelPending);
    if (accepted === "bound") this.responseRequestPending = false;
    return accepted !== undefined;
  }

  private handleIgnoredResponseDone(event: Record<string, unknown>): void {
    const responseId = responseEventId(event);
    if (responseId) this.responseIdentity.retire(responseId);
    if (this.responseCancelPending && (!responseId || responseId === this.responseIdentity.active)) {
      this.settleCancelledResponse();
    }
  }

  private clearActiveResponse(event: Record<string, unknown>): void {
    if (this.responseIdentity.clear(responseEventId(event))) this.responseRequestPending = false;
  }

  private settleCancelledResponse(): void {
    this.clearResponseCancelTimer();
    // Without the cancelled response's ID, the next created event could still
    // belong to that old request. A new request on this socket cannot be owned.
    if (this.responseCancelPending && this.responseRequestPending && !this.responseIdentity.active) {
      this.retireForLocalNotification();
      if (this.callbacks.onTransportError) this.callbacks.onTransportError(UNCONFIRMED_VOICE_CANCEL_MESSAGE);
      else if (this.callbacks.onDisconnected) this.callbacks.onDisconnected({code: 1000, reason: UNCONFIRMED_VOICE_CANCEL_MESSAGE});
      else this.callbacks.onError?.(UNCONFIRMED_VOICE_CANCEL_MESSAGE);
      return;
    }
    this.responseIdentity.clear();
    this.responseRequestPending = false;
    this.responseCancelPending = false;
    this.responseHasToolCall = false;
    this.responseOutput.clearText();
    this.modelRetry.reset();
    this.flushQueuedResponseCreate();
  }

  private settleFailedResponse(event: Record<string, unknown>): void {
    this.invalidatePendingResponseWork();
    this.clearResponseCancelTimer();
    this.clearActiveResponse(event);
    this.responseRequestPending = false;
    this.responseCancelPending = false;
    this.responseHasToolCall = false;
    this.responseOutput.clearText();
    this.flushQueuedResponseCreate();
  }

  private flushQueuedResponseCreate(): void {
    if (!this.queuedResponseCreate || this.initialInstructions.slot || this.responseIdentity.active || this.responseRequestPending || this.responseCancelPending || this.toolCalls.hasContinuation) {
      return;
    }
    this.queuedResponseCreate = false;
    this.prepareResponseTracking();
    this.requestResponse();
  }

  private clearResponseCancelTimer(): void {
    if (!this.responseCancelTimer) return;
    window.clearTimeout(this.responseCancelTimer);
    this.responseCancelTimer = 0;
  }

  private maybeRetryModelError(message: string): boolean {
    const run = this.responseRun;
    if (!this.isOmniE2e() || !run || run.settled || !isRetryableOmniModelError(message)) return false;
    // Restart only an attempt that has not emitted content or executed tools.
    // Once output exists, the existing failure path owns recovery.
    if (this.responseOutput.hasOutput || this.responseHasToolCall) return false;
    if (this.modelRetry.pending) return true;
    const delay = this.modelRetry.next(this.options.maxModelRetries);
    if (!delay) return false;
    const retryOfResponseId = this.responseIdentity.active || this.requestedRetryOfResponseId;
    const toolContinuation = this.requestedToolContinuation;
    if (this.responseIdentity.active) this.responseIdentity.retire(this.responseIdentity.active);
    this.responseIdentity.clear();
    this.responseRequestPending = false;
    this.invalidatePendingResponseWork();
    const isCurrent = this.capturePendingResponseGuard();
    this.modelRetry.schedule(delay.delayMs, () => {
      if (isCurrent() && this.responseRun === run && !run.settled && !this.responseIdentity.active && !this.responseRequestPending) {
        this.requestResponse(toolContinuation, retryOfResponseId);
      }
    });
    this.callbacks.onModelRetry?.({ ...delay, message });
    return true;
  }

  private newProviderRun(stage: RealtimeProviderStage): RealtimeProviderRun {
    let context: RealtimeProviderContext | undefined;
    try { context = this.options.providerContext?.(); } catch { /* Telemetry cannot block a request. */ }
    // ASR is session input; it must not inherit the preceding playback turn.
    const owner = context && stage !== "voice_response" ? { sessionId: context.sessionId, generation: context.generation } : context;
    return new RealtimeProviderRun(stage, stage === "voice_asr" ? "qwen3-asr-flash-realtime" : this.settings.model.trim() || "qwen3.5-omni-plus-realtime-2026-03-15", this.callbacks.onProviderRun, owner, this.auditCredentials());
  }

  private asrRunForEvent(event: Record<string, unknown>, start = false): RealtimeProviderRun | undefined {
    const id = inputItemId(event) || (this.unboundAsrRun && !this.unboundAsrRun.settled ? "" : this.currentSpeechItemId);
    if (id && (this.retiredAsrItemIds.has(id) || this.ignoredInputItemIds.has(id))) return undefined;
    let run = id ? this.asrRuns.get(id) : this.unboundAsrRun;
    if (!run && !start && !this.unboundAsrRun) return undefined;
    if (!run) {
      run = this.unboundAsrRun && !this.unboundAsrRun.settled ? this.unboundAsrRun : this.newProviderRun("voice_asr");
      run.beginAttempt();
      if (id) {
        if (this.asrRuns.size >= 128) {
          const oldest = this.asrRuns.keys().next().value!;
          this.asrRuns.get(oldest)?.finish("failed", "invalid_response");
          this.asrRuns.delete(oldest);
          this.rememberInputId(this.retiredAsrItemIds, oldest);
        }
        this.asrRuns.set(id, run); this.unboundAsrRun = undefined;
      }
      else this.unboundAsrRun = run;
    }
    run.observeModel(realtimeReportedModel(event));
    return run;
  }

  private rememberInputId(ids: Set<string>, id: string): void {
    if (ids.has(id)) return;
    if (ids.size >= 512) ids.delete(ids.values().next().value!);
    ids.add(id);
  }

  private finishProviderFailures(error: unknown): void {
    window.clearTimeout(this.connectionAckTimer);
    const failure = realtimeProviderError(error);
    for (const run of [this.connectionRun, this.responseRun, this.unboundAsrRun, ...this.asrRuns.values()]) {
      run?.finish("failed", failure.code, undefined, failure.httpStatus);
    }
  }

  private handleToolCallEvent(event: Record<string, unknown>): boolean {
    if (!this.callbacks.onToolCall) return false;
    const accepted = this.toolCalls.accept(event, this.responseIdentity.active);
    if (!accepted) return false;
    if (accepted.duplicate) return true;
    const { toolCall, responseId } = accepted;
    const isCurrent = this.capturePendingResponseGuard();
    void (async()=>{
        if(this.hasProtectedContextSources())await this.assertContextSourcesCurrent();
        if(!isCurrent())return;
        this.assertContextSourcesCurrentNow();
        const output = toolCall.arguments === undefined
          ? "工具参数未完整读取，请重新给出完整参数。未执行操作。"
          : await this.callbacks.onToolCall!({ ...toolCall, arguments: toolCall.arguments });
        const callId = toolCall.id;
        if (!callId || !isCurrent()){disposeRealtimeToolOutput(output);return;}
        const retained=typeof output==="string"?{text:output,committed:false}:this.toolOutputs.claim(output);
        if(retained.committed){
          // Runtime's private commit evidence wins over the now-outdated read.
          // Retire server history; never ask another model to reinterpret a write.
          this.retireForLocalNotification();
          const response=responseLifecycleEvent(event,responseId);
          if(this.callbacks.onToolCommitted)this.callbacks.onToolCommitted(retained.text,response);
          else this.callbacks.onResponseDone?.(retained.text,response);
          return;
        }
        if(this.hasProtectedContextSources())await this.assertContextSourcesCurrent();
        if(!isCurrent())return;
        this.assertContextSourcesCurrentNow();
        this.send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: retained.text || "工具已执行，但没有额外输出。"
          }
        });
        if (this.isOmniE2e() && this.toolCalls.markCallSent(accepted)) {
          this.requestToolContinuationWhenReady();
        } else if (this.isOmniE2e()) this.createResponse();
        else if (!this.usesServerVad()) this.requestResponse();
      })().catch((error) => {
        if (!isCurrent()) return;
        if(this.hasProtectedContextSources() || error instanceof Error && /身份|范围/.test(error.message)){
          this.failToolContext(error instanceof Error && /范围已满/.test(error.message)?"本次语音查询范围已满，连接已结束；请重新开启语音。":undefined);return;
        }
        const message = error instanceof Error ? error.message : "工具调用执行失败。";
        this.callbacks.onError?.(redactSensitiveText(message, this.auditCredentials()));
      });
    return true;
  }
}

function decodedBase64Bytes(value: string): number {
  const clean = value.replace(/\s/g, "");
  if (!clean) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function inputItemId(event: Record<string, unknown>): string {
  return stringValue(event.item_id) || stringValue(event.itemId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
