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
  buildOmniSessionUpdate, extractResponseAudioTranscriptDelta, extractResponseAudioTranscriptDone,
  isSuccessfulResponseStatus, mergeOmniToolArguments, normalizeOmniToolCall, normalizeSampleRate,
  responseEventId, responseFailureMessage, responseLifecycleEvent
} from "./voice/omniE2e/protocol";
import { normalizeRealtimeAsrLanguage } from "./voice/realtimeAsrOptions";

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

class RealtimeConnectionContextError extends Error {
  constructor() { super("首次语音资料或权限已变化，已停止连接；请重新开始语音。"); this.name = "RealtimeConnectionContextError"; }
}

export class BailianConnectionTimeoutError extends Error {
  constructor() { super("百炼 Realtime 连接超时。"); }
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

import {createOutputSliceYield,createOutputSliceBudget} from "./voice/outputSliceYield";
const PROTECTED_RESPONSE_MAX_FRAMES = 128;
const PROTECTED_RESPONSE_BATCH_FRAMES = 32;
const PROTECTED_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
interface ProtectedResponseFrame {
  event: Record<string, unknown>; bytes: number; epoch: number;
  socket: WebSocket | null; generation: number; current: () => boolean;
}

export class BailianRealtimeClient {
  private readonly streamingAsr?: BailianStreamingAsr;
  private readonly toolOutputs=new RealtimeToolOutputs();
  private toolEventSerial:Promise<void>=Promise.resolve();
  private toolEventQueue:ProtectedResponseFrame[]=[];
  private toolEventFlight?:{epoch:number;socket:WebSocket|null;sliceYield:ReturnType<typeof createOutputSliceYield>;startBudget:ReturnType<typeof createOutputSliceBudget>};
  private toolEventEpoch=0;
  private toolEventPending=0;
  private toolEventBytes=0;
  private initialSnapshot: RealtimeInstructionsSnapshot | undefined;
  private initialSlot: InitialInstructionsSlot | undefined;
  private initialConsumed = false;
  private routedInitialReady?:{resolve():void;reject(error:unknown):void};
  private connectionRun: RealtimeProviderRun | undefined;
  private responseRun: RealtimeProviderRun | undefined;
  private readonly asrRuns = new Map<string, RealtimeProviderRun>();
  private unboundAsrRun: RealtimeProviderRun | undefined;
  private cancelConnecting: (() => void) | undefined;
  private connectionAckTimer = 0;
  private reportedModel: string | undefined;
  private responseReportedModel: string | undefined;
  private responseHasOutput = false;
  private socket: WebSocket | null = null;
  private transcript = "";
  private responseText = "";
  private responseTextSource: "" | "text" | "audio_transcript" = "";
  private intentionalClose = false;
  private modelRetries = 0;
  private speechStartTimestamp = 0;
  private speechStartAudioMs = 0;
  private currentSpeechItemId = "";
  private activeResponseId = "";
  private responseRequestPending = false;
  private responseCancelPending = false;
  private queuedResponseCreate = false;
  private responseHasToolCall = false;
  private responseCancelTimer = 0;
  private responseGeneration = 0;
  private instructionsBoundary: RealtimeInstructionsBoundary | undefined;
  private responsePreparationPending = false;
  private toolResponseContinuation: {
    responseId: string;
    callIds: Set<string>;
    pendingCallIds: Set<string>;
    responseDone: boolean;
  } | null = null;
  private requestedToolContinuation: BailianRealtimeResponseEvent["toolContinuation"] = undefined;
  private requestedRetryOfResponseId: string | undefined;
  private pendingInputAudioBytes = 0;
  private static readonly MIN_SPEECH_DURATION_MS = 300;
  private readonly toolArgumentBuffers = new Map<string, string>();
  private readonly handledToolCallIds = new Set<string>();
  private readonly ignoredInputItemIds = new Set<string>();
  private readonly retiredAsrItemIds = new Set<string>();
  private readonly ignoredResponseIds = new Set<string>();
  private readonly auditCredentials: () => string[];

  constructor(
    private readonly settings: RealtimeVoiceSettings,
    private readonly callbacks: BailianRealtimeCallbacks = {},
    private readonly options: BailianRealtimeOptions = {}
  ) {
    if (!this.isOmniE2e() && settings.asrEngine === "streaming-hotwords") {
      this.streamingAsr = new BailianStreamingAsr(settings, callbacks, options.providerContext);
    }
    this.initialSnapshot = options.initialInstructions;
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
    this.captureInitialInstructions();
    } catch (error) {
      this.releaseInitialInstructions();
      if (this.options.initialInstructions && this.socket) this.close();
      connectionRun.finish("failed", "configuration");
      throw error;
    }
    const apiKey = this.settings.apiKey.trim();

    this.connectionRun = connectionRun;

    let sessionBody: string;
    try { sessionBody = JSON.stringify(this.buildSessionUpdatePayload()); }
    catch (error) { this.releaseInitialInstructions(); connectionRun.finish("failed", "configuration"); throw error; }
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
        reject(opening && this.initialSlot ? new RealtimeConnectionContextError() : new BailianConnectionTimeoutError());
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
        const openingSlot = this.initialSlot;
        const finishOpen = () => {
          if (this.connectionRun !== connectionRun || this.socket !== socket || this.intentionalClose
            || this.initialSlot !== openingSlot || this.options.initialInstructions && this.isOmniE2e() && !openingSlot) {
            throw new RealtimeConnectionContextError();
          }
          this.assertInitialInstructions();
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
          const slot = this.initialSlot;
          this.connectionAckTimer = window.setTimeout(() => {
            if (this.socket !== socket || this.intentionalClose) return;
            if (slot && this.initialSlot === slot) this.failInitialInstructions(slot, socket, "timeout");
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
          this.assertInitialInstructions();
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
        window.clearTimeout(this.connectionAckTimer); this.releaseInitialInstructions();
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
        window.clearTimeout(this.connectionAckTimer); this.releaseInitialInstructions();
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
      if (this.connectionRun === connectionRun) this.releaseInitialInstructions();
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
    if (this.initialSlot || this.activeResponseId || this.responseRequestPending || this.responseCancelPending || this.toolResponseContinuation) {
      this.queuedResponseCreate = true;
      return;
    }
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
        this.initialSnapshot=snapshot;this.initialConsumed=false;this.routedInitialReady=ready;
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
    if(this.toolOutputs.protected){this.close();this.callbacks.onToolSessionRetired?.();return;}
    const preparing = this.responsePreparationPending;
    this.responseRun?.finish(cause && cause !== "cancelled" ? "failed" : "cancelled", cause ?? "cancelled");
    this.invalidatePendingResponseWork();
    this.queuedResponseCreate = false;
    if (preparing && !this.activeResponseId) {
      this.responseRequestPending = false;
      this.responseCancelPending = false;
      return;
    }
    if (this.activeResponseId) {
      this.rememberIgnoredResponse(this.activeResponseId);
    }
    this.responseCancelPending = Boolean(this.activeResponseId || this.responseRequestPending);
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
    this.releaseInitialInstructions();
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
      ()=>{if(socket&&socket.readyState===WebSocket.OPEN)socket.close(1000);else socket?.terminate();},
      ()=>this.toolOutputs.dispose(),()=>this.toolEventFlight?.sliceYield.dispose()
    ])try{dispose();}catch(error){if(!failed){failed=true;failure=error;}}
    this.toolEventSerial=Promise.resolve();this.toolEventQueue=[];this.toolEventFlight=undefined;
    this.toolEventEpoch++;this.toolEventPending=0;this.toolEventBytes=0;
    this.asrRuns.clear();
    this.unboundAsrRun = undefined;
    this.ignoredResponseIds.clear();
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

  private captureInitialInstructions(): void {
    if (!this.isOmniE2e()) { this.releaseInitialInstructions(); return; }
    const snapshot = this.initialSnapshot;
    if (!snapshot) { if (this.options.initialInstructions) throw new RealtimeConnectionContextError(); return; }
    if (this.initialConsumed) throw new RealtimeConnectionContextError();
    this.initialConsumed = true;
    const {instructions, baseInstructions, expiresAt} = snapshot, nonce = randomUUID();
    this.initialSlot = { snapshot, instructions, baseInstructions, expiresAt, nonce, sent: false, checkingAck: false,
      wireInstructions: `${instructions}\n\n[内部上下文版本：${nonce}；此标记只用于协议确认，不得朗读或作为用户资料。]` };
    this.assertInitialInstructions();
  }

  private assertInitialInstructions(): void {
    const slot = this.initialSlot; if (!slot) return;
    const source = slot.snapshot;
    try {
      if (typeof slot.instructions !== "string" || typeof slot.baseInstructions !== "string"
        || source.instructions !== slot.instructions || source.baseInstructions !== slot.baseInstructions || source.expiresAt !== slot.expiresAt
        || slot.expiresAt !== undefined && (!Number.isFinite(slot.expiresAt) || slot.expiresAt <= Date.now())) throw new RealtimeConnectionContextError();
      source.assertCurrent();
    } catch { throw new RealtimeConnectionContextError(); }
  }

  private releaseInitialInstructions(): void {
    const snapshot = this.initialSnapshot;
    this.initialSnapshot = undefined; this.initialSlot = undefined;
    try { snapshot?.dispose(); } catch { /* Disposal never retries or reuses a source. */ }
  }

  private failInitialInstructions(slot: InitialInstructionsSlot, socket: WebSocket, code: ProviderErrorCode): void {
    if (this.initialSlot !== slot || this.socket !== socket || this.intentionalClose) return;
    this.connectionRun?.finish("failed", code);
    if(this.failRoutedRestore())return;
    this.close();
    try { this.callbacks.onInitialContextError?.("首次语音资料未获当前确认，已停止连接；请重新开始语音。"); } catch { /* The closed session cannot retry a callback. */ }
  }

  private acceptInitialInstructionsEvent(event: Record<string, unknown>): boolean {
    const slot = this.initialSlot, socket = this.socket;
    if (!slot || !socket || this.intentionalClose) return false;
    if (event.type === "error") {
      const error = event.error as Record<string, unknown> | undefined;
      if (event.response_id || event.response || error?.event_id !== undefined && error.event_id !== slot.nonce) return true;
      this.failInitialInstructions(slot, socket, realtimeProviderError(error).code); return true;
    }
    if (event.type !== "session.updated") return false;
    const session = event.session as Record<string, unknown> | undefined;
    if (!slot.sent || session?.instructions !== slot.wireInstructions || slot.checkingAck) return true;
    slot.checkingAck = true;
    const complete = () => {
      if (this.initialSlot !== slot || this.socket !== socket || this.intentionalClose) return;
      this.assertInitialInstructions();
      window.clearTimeout(this.connectionAckTimer);
      const model = providerIdentifier(realtimeReportedModel(event)); if (model) this.reportedModel = model;
      this.connectionRun?.finish("success", undefined, model);
      this.releaseInitialInstructions(); this.flushQueuedResponseCreate();
      this.routedInitialReady?.resolve();
    };
    const fail = () => this.failInitialInstructions(slot, socket, "invalid_response");
    try {
      this.assertInitialInstructions();
      if (slot.snapshot.assertSourcesCurrent) void slot.snapshot.assertSourcesCurrent().then(complete, fail).catch(fail);
      else complete();
    } catch { fail(); }
    return true;
  }

  private sendSessionUpdate(): void {
    this.assertInitialInstructions();
    this.send(this.buildSessionUpdatePayload());
  }

  private buildSessionUpdatePayload(): Record<string, unknown> {
    const language = normalizeRealtimeAsrLanguage(this.settings.language);
    if (this.isOmniE2e()) {
      return buildOmniSessionUpdate(this.settings, this.options, this.initialSlot, language);
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
      event = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if(this.hasProtectedContextSources() && (String(event.type??"").startsWith("response.") || event.type==="error")){
      if(this.ignoredResponseIds.has(responseEventId(event))){
        // Acknowledging cancellation carries no old text/audio. Settle promptly
        // so a normal barge-in need not wait for the two-second fallback timer.
        if(event.type==="response.done"||event.type==="response.completed")this.handleIgnoredResponseDone(event);
        return;
      }
      const bytes=Buffer.byteLength(text,"utf8");
      if(this.toolEventPending>=PROTECTED_RESPONSE_MAX_FRAMES || this.toolEventBytes+bytes>PROTECTED_RESPONSE_MAX_BYTES){
        this.failToolContext("查询核对未赶上语音输出，已结束这次连接并保留文字输入；可先用文字查询，未自动重试。");return;
      }
      this.toolEventQueue.push({event,bytes,epoch:this.toolEventEpoch,socket:this.socket,
        generation:this.responseGeneration,current:this.capturePendingResponseGuard()});
      this.toolEventPending++;this.toolEventBytes+=bytes;
      if(!this.toolEventFlight){
        const flight={epoch:this.toolEventEpoch,socket:this.socket,sliceYield:createOutputSliceYield(),startBudget:createOutputSliceBudget()};this.toolEventFlight=flight;
        this.toolEventSerial=this.drainProtectedResponseEvents(flight);
      }
      return;
    }
    this.handleEvent(event);
  }

  private settleStaleProtectedResponse(frame:ProtectedResponseFrame):void{
    const {event,socket,generation}=frame;
    // A completed old read may bind its created id for cancellation only.
    if(this.socket!==socket||this.intentionalClose||event.type!=="response.created")return;
    if(this.responseGeneration===generation+1&&this.responseCancelPending&&!this.activeResponseId)this.handleResponseCreated(event);
    else {const id=responseEventId(event);if(id)this.rememberIgnoredResponse(id);}
  }

  private async drainProtectedResponseEvents(flight:{epoch:number;socket:WebSocket|null;sliceYield:ReturnType<typeof createOutputSliceYield>;startBudget:ReturnType<typeof createOutputSliceBudget>}):Promise<void>{
    let published=false;
    try{
      while(this.toolEventFlight===flight&&this.toolEventQueue.length){
        const first=this.toolEventQueue[0],members:ProtectedResponseFrame[]=[];
        // Membership is frozen before the raw read. Later arrivals wait for the next read.
        while(members.length<PROTECTED_RESPONSE_BATCH_FRAMES&&this.toolEventQueue.length){
          const next=this.toolEventQueue[0];
          if(next.epoch!==first.epoch||next.socket!==first.socket||next.generation!==first.generation)break;
          members.push(this.toolEventQueue.shift()!);
        }
        const batch=Object.freeze(members),bytes=batch.reduce((sum,item)=>sum+item.bytes,0);
        try{
          let offset=0;while(offset<batch.length){
            const slice=Object.freeze(batch.slice(offset,offset+32));
            if(published&&slice.some(item=>item.current()))await flight.sliceYield.wait();
            if(this.toolEventFlight!==flight||flight.epoch!==this.toolEventEpoch||flight.socket!==this.socket)break;
            if(slice.some(item=>item.current()))await this.assertContextSourcesCurrent();
            if(this.toolEventFlight!==flight||flight.epoch!==this.toolEventEpoch||flight.socket!==this.socket)break;
            const exhausted=flight.startBudget();
            for(const item of slice){
              if(!item.current())this.settleStaleProtectedResponse(item);
              else{
                // Callbacks can synchronously cancel or change policy between members.
                this.assertContextSourcesCurrentNow();this.handleEvent(item.event);
              }
              offset++;if(exhausted())break;
            }
            published=true;
          }
        }catch{if(batch.some(item=>item.current()))this.failToolContext();}
        finally{
          // An old read never debits a reset/reconnected queue.
          if(first.epoch===this.toolEventEpoch){this.toolEventPending-=batch.length;this.toolEventBytes-=bytes;}
        }
      }
    }finally{flight.sliceYield.dispose();if(this.toolEventFlight===flight)this.toolEventFlight=undefined;}
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
    this.close();
    if(this.callbacks.onToolContextError)this.callbacks.onToolContextError(message);
    else this.callbacks.onError?.(message);
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
    if (this.acceptInitialInstructionsEvent(event)) return;
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
      if (responseEventId(event)) this.rememberIgnoredResponse(responseEventId(event));
      if (responseEventId(event)) {
        if (this.callbacks.onResponseFailed) {
          this.callbacks.onResponseFailed(message, responseLifecycleEvent(event, this.activeResponseId));
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
        if (responseEventId(event)) this.rememberIgnoredResponse(responseEventId(event));
      }
      if (type.startsWith("response.")) {
        if (this.callbacks.onResponseFailed) {
          this.callbacks.onResponseFailed(message, responseLifecycleEvent(event, this.activeResponseId));
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
    if (type === "response.text.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        this.responseHasOutput = true;
        this.appendResponseText(delta, "text", event);
      }
      return;
    }
    const audioTranscriptDelta = extractResponseAudioTranscriptDelta(event);
    if (audioTranscriptDelta) {
      this.responseHasOutput = true;
      this.appendResponseText(audioTranscriptDelta, "audio_transcript", event);
      return;
    }
    const audioTranscriptDone = extractResponseAudioTranscriptDone(event);
    if (audioTranscriptDone) {
      this.responseHasOutput = true;
      this.setResponseText(audioTranscriptDone, "audio_transcript", event);
      return;
    }
    if (type === "response.audio.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        this.responseHasOutput = true;
        this.callbacks.onAudioDelta?.(
          delta,
          normalizeSampleRate(this.settings.ttsSampleRate),
          responseLifecycleEvent(event, this.activeResponseId)
        );
      }
      return;
    }
    if (type === "response.audio.done" || type === "response.audio.completed") {
      this.callbacks.onResponseAudioDone?.(responseLifecycleEvent(event, this.activeResponseId));
      return;
    }
    if (type === "response.function_call_arguments.delta") {
      this.accumulateToolArguments(event);
      return;
    }
    if (type === "response.function_call_arguments.done" || type === "response.output_item.done") {
      if (this.handleToolCallEvent(event)) {
        this.responseHasToolCall = true;
        return;
      }
    }
    if (type === "response.done" || type === "response.completed") {
      const terminal = isRecord(event.response) ? event.response : undefined;
      // Metadata must belong to the bound response. Never infer ownership from
      // a fallback ID, and do not bypass cancellation/old-socket guards above.
      if (typeof terminal?.id === "string" && terminal.id && terminal.id === usageOwnerId
        && terminal.id === this.responseRun?.responseId
        && (event.response_id === undefined || event.response_id === terminal.id)
        && (event.responseId === undefined || event.responseId === terminal.id)) {
        this.responseRun.observeResponseUsage(terminal.usage);
      }
      const responseEvent = responseLifecycleEvent(event, this.activeResponseId);
      if (!isSuccessfulResponseStatus(responseEvent.status)) {
        if(this.hasProtectedContextSources()){this.failToolContext();return;}
        const message = redactSensitiveText(responseFailureMessage(event, responseEvent.status), [this.settings.apiKey]);
        const failure = realtimeProviderError(message);
        const code = responseEvent.status === "cancelled" ? "cancelled" : failure.code === "network" ? "invalid_response" : failure.code;
        this.responseRun?.finish(code === "cancelled" ? "cancelled" : "failed", code, undefined, failure.httpStatus);
        if (responseEvent.responseId) this.rememberIgnoredResponse(responseEvent.responseId);
        if (this.callbacks.onResponseFailed) {
          this.callbacks.onResponseFailed(message, responseEvent);
        } else {
          this.callbacks.onError?.(message);
        }
        this.settleFailedResponse(event);
        return;
      }
      this.responseRun?.finish(this.responseHasToolCall || this.responseHasOutput ? "success" : "failed", "invalid_response", this.responseReportedModel ?? this.reportedModel);
      if (responseEvent.responseId) this.rememberIgnoredResponse(responseEvent.responseId);
      if (this.responseHasToolCall) {
        if (this.toolResponseContinuation?.responseId === responseEvent.responseId) {
          this.toolResponseContinuation.responseDone = true;
        }
        if (responseEvent.responseId) this.rememberIgnoredResponse(responseEvent.responseId);
        this.clearActiveResponse(event);
        this.responseHasToolCall = false;
        this.requestToolContinuationWhenReady();
        this.flushQueuedResponseCreate();
        return;
      }
      const doneText = this.responseText.trim();
      this.callbacks.onResponseDone?.(doneText, responseEvent);
      this.responseText = "";
      this.responseTextSource = "";
      this.modelRetries = 0;
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

  private appendResponseText(
    delta: string,
    source: "text" | "audio_transcript",
    event: Record<string, unknown>
  ): void {
    if (this.responseTextSource && this.responseTextSource !== source) {
      if (this.responseTextSource === "text") return;
      this.responseText = "";
    }
    this.responseTextSource = source;
    this.responseText += delta;
    this.callbacks.onResponseTextDelta?.(
      this.responseText,
      responseLifecycleEvent(event, this.activeResponseId)
    );
  }

  private setResponseText(
    text: string,
    source: "text" | "audio_transcript",
    event: Record<string, unknown>
  ): void {
    if (this.responseTextSource === "text" && source !== "text") return;
    this.responseTextSource = source;
    this.responseText = text;
    this.callbacks.onResponseTextDelta?.(
      this.responseText,
      responseLifecycleEvent(event, this.activeResponseId)
    );
  }

  private isOmniE2e(): boolean {
    return (this.options.mode ?? this.settings.mode ?? "cascade") === "omni-e2e";
  }

  private usesServerVad(): boolean {
    return this.isOmniE2e();
  }

  private prepareResponseTracking(): void {
    this.responseHasOutput = false;
    this.responseText = "";
    this.responseTextSource = "";
    this.modelRetries = 0;
    this.handledToolCallIds.clear();
  }

  private invalidatePendingResponseWork(): void {
    this.responsePreparationPending = false;
    this.responseGeneration += 1;
    this.toolEventFlight?.sliceYield.cancel();
    this.toolArgumentBuffers.clear();
    this.toolResponseContinuation = null;
    this.requestedToolContinuation = undefined;
    this.requestedRetryOfResponseId = undefined;
  }

  private resetConnectionState(): void {
    this.toolEventFlight?.sliceYield.dispose();
    this.toolEventSerial=Promise.resolve();this.toolEventQueue=[];this.toolEventFlight=undefined;
    this.toolEventEpoch++;this.toolEventPending=0;this.toolEventBytes=0;
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
    this.activeResponseId = "";
    this.responseRequestPending = false;
    this.responseCancelPending = false;
    this.queuedResponseCreate = false;
    this.responseHasToolCall = false;
    this.currentSpeechItemId = "";
    this.ignoredInputItemIds.clear();
    this.retiredAsrItemIds.clear();
    this.ignoredResponseIds.clear();
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
    if (this.initialSlot) { this.queuedResponseCreate = true; return; }
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
    void (async()=>{
      await this.assertContextSourcesCurrent();
      if(!current())return;
      const snapshot=await this.instructionsBoundary?.prepareForResponse(current);
      try {
        if (!current()) return;
        if(this.hasProtectedContextSources())await this.assertContextSourcesCurrent();
        if(!current())return;
        await snapshot?.assertSourcesCurrent?.();
        if(!current())return;
        snapshot?.assertCurrent();
        await this.assertContextSourcesCurrent();if(!current())return;
        snapshot?.assertCurrent();
        this.assertContextSourcesCurrentNow();
        sendResponse();
      } finally { snapshot?.dispose(); }
    })().catch(() => {
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
    const continuation = this.toolResponseContinuation;
    if (!continuation || !continuation.responseDone || continuation.pendingCallIds.size > 0
      || this.activeResponseId || this.responseRequestPending || this.responseCancelPending
      || this.intentionalClose || this.socket?.readyState !== WebSocket.OPEN) return;
    this.toolResponseContinuation = null;
    this.queuedResponseCreate = false;
    this.prepareResponseTracking();
    this.requestResponse({
      previousResponseId: continuation.responseId,
      callIds: [...continuation.callIds]
    });
  }

  private handleResponseCreated(event: Record<string, unknown>): void {
    const responseId = responseEventId(event);
    if (!responseId) return;
    if (this.ignoredResponseIds.has(responseId)) return;
    if (this.activeResponseId && !this.responseCancelPending && responseId !== this.activeResponseId) return;
    const toolContinuation = this.responseRequestPending ? this.requestedToolContinuation : undefined;
    const retryOfResponseId = this.responseRequestPending ? this.requestedRetryOfResponseId : undefined;
    this.responseRequestPending = false;
    this.requestedToolContinuation = undefined;
    this.requestedRetryOfResponseId = undefined;
    this.activeResponseId = responseId;
    if (this.responseCancelPending) {
      this.rememberIgnoredResponse(responseId);
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
    const responseId = responseEventId(event);
    if (responseId && this.ignoredResponseIds.has(responseId)) return false;
    if (this.responseCancelPending) return false;
    if (responseId && this.activeResponseId && responseId !== this.activeResponseId) return false;
    if (responseId && !this.activeResponseId) {
      this.activeResponseId = responseId;
      this.responseRequestPending = false;
    }
    return true;
  }

  private rememberIgnoredResponse(id: string): void {
    if (this.ignoredResponseIds.size >= 512) this.ignoredResponseIds.delete(this.ignoredResponseIds.values().next().value!);
    this.ignoredResponseIds.add(id);
  }

  private handleIgnoredResponseDone(event: Record<string, unknown>): void {
    const responseId = responseEventId(event);
    if (responseId) this.rememberIgnoredResponse(responseId);
    if (this.responseCancelPending && (!responseId || responseId === this.activeResponseId)) {
      this.settleCancelledResponse();
    }
  }

  private clearActiveResponse(event: Record<string, unknown>): void {
    const responseId = responseEventId(event);
    if (!responseId || !this.activeResponseId || responseId === this.activeResponseId) {
      this.activeResponseId = "";
      this.responseRequestPending = false;
    }
  }

  private settleCancelledResponse(): void {
    this.clearResponseCancelTimer();
    // Without the cancelled response's ID, the next created event could still
    // belong to that old request. A new request on this socket cannot be owned.
    if (this.responseCancelPending && this.responseRequestPending && !this.activeResponseId) {
      this.close();
      if (this.callbacks.onTransportError) this.callbacks.onTransportError(UNCONFIRMED_VOICE_CANCEL_MESSAGE);
      else if (this.callbacks.onDisconnected) this.callbacks.onDisconnected({code: 1000, reason: UNCONFIRMED_VOICE_CANCEL_MESSAGE});
      else this.callbacks.onError?.(UNCONFIRMED_VOICE_CANCEL_MESSAGE);
      return;
    }
    this.activeResponseId = "";
    this.responseRequestPending = false;
    this.responseCancelPending = false;
    this.responseHasToolCall = false;
    this.responseText = "";
    this.responseTextSource = "";
    this.modelRetries = 0;
    this.flushQueuedResponseCreate();
  }

  private settleFailedResponse(event: Record<string, unknown>): void {
    this.invalidatePendingResponseWork();
    this.clearResponseCancelTimer();
    this.clearActiveResponse(event);
    this.responseRequestPending = false;
    this.responseCancelPending = false;
    this.responseHasToolCall = false;
    this.responseText = "";
    this.responseTextSource = "";
    this.flushQueuedResponseCreate();
  }

  private flushQueuedResponseCreate(): void {
    if (!this.queuedResponseCreate || this.initialSlot || this.activeResponseId || this.responseRequestPending || this.responseCancelPending || this.toolResponseContinuation) {
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
    if (!this.isOmniE2e() || !this.responseRun || this.responseRun.settled || !/ModelServingError|model serving|internal/i.test(message)) return false;
    // Restart only an attempt that has not emitted content or executed tools.
    // Once output exists, the existing failure path owns recovery.
    if (this.responseHasOutput || this.responseHasToolCall) return false;
    const maxRetries = Math.min(MODEL_RETRY_DELAYS_MS.length, Math.max(0, this.options.maxModelRetries ?? MODEL_RETRY_DELAYS_MS.length));
    if (this.modelRetries >= maxRetries) return false;
    this.modelRetries += 1;
    const delayMs = MODEL_RETRY_DELAYS_MS[this.modelRetries - 1];
    const retryOfResponseId = this.activeResponseId || this.requestedRetryOfResponseId;
    const toolContinuation = this.requestedToolContinuation;
    if (this.activeResponseId) this.rememberIgnoredResponse(this.activeResponseId);
    this.activeResponseId = "";
    this.responseRequestPending = false;
    this.invalidatePendingResponseWork();
    const isCurrent = this.capturePendingResponseGuard();
    const run = this.responseRun;
    this.callbacks.onModelRetry?.({
      attempt: this.modelRetries,
      delayMs,
      message
    });
    window.setTimeout(() => {
      if (isCurrent() && !run.settled) {
        this.requestResponse(toolContinuation, retryOfResponseId);
      }
    }, delayMs);
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

  private accumulateToolArguments(event: Record<string, unknown>): void {
    mergeOmniToolArguments(this.toolArgumentBuffers, event);
  }

  private handleToolCallEvent(event: Record<string, unknown>): boolean {
    const toolCall = normalizeOmniToolCall(event, this.toolArgumentBuffers);
    if (!toolCall || !this.callbacks.onToolCall) return false;
    if (toolCall.id && this.handledToolCallIds.has(toolCall.id)) return true;
    if (toolCall.id) this.handledToolCallIds.add(toolCall.id);
    if (toolCall.id) this.toolArgumentBuffers.delete(toolCall.id);
    const responseId = responseEventId(event) || this.activeResponseId;
    if (responseId && toolCall.id) {
      this.toolResponseContinuation ??= {
        responseId, callIds: new Set(), pendingCallIds: new Set(), responseDone: false
      };
      this.toolResponseContinuation.callIds.add(toolCall.id);
      this.toolResponseContinuation.pendingCallIds.add(toolCall.id);
    }
    const continuation = this.toolResponseContinuation;
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
          this.close();
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
        if (this.isOmniE2e() && continuation?.responseId === responseId) {
          continuation.pendingCallIds.delete(callId);
          this.requestToolContinuationWhenReady();
        } else if (this.isOmniE2e()) this.createResponse();
        else if (!this.usesServerVad()) this.requestResponse();
      })().catch((error) => {
        if (!isCurrent()) return;
        if(this.hasProtectedContextSources() || error instanceof Error && /身份|范围/.test(error.message)){
          this.failToolContext(error instanceof Error && /范围已满/.test(error.message)?"本次语音查询范围已满，连接已结束；请重新开启语音。":undefined);return;
        }
        this.callbacks.onError?.(error instanceof Error ? error.message : "工具调用执行失败。");
      });
    return true;
  }
}

const MODEL_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

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
