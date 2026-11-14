import type { BailianRealtimeResponseEvent } from "../../bailianRealtime";
import type { RealtimeVoiceSettings } from "../../types";
import type { VoiceSessionController } from "../voiceRuntime";
import { projectProposalFailure } from "./projectProposals";
import { realtimeProviderError } from "../realtimeProviderRun";

type VoiceRealtimeView = any;

interface OmniResponseHost {
  isOmniE2eRealtimeMode(settings: RealtimeVoiceSettings): boolean;
  hasActiveVoiceRuntimeTurn(view: VoiceRealtimeView): boolean;
  armOmniResponseTimer(view: VoiceRealtimeView): void;
  failOmniE2eVoiceTurn(view: VoiceRealtimeView, message: string, response?: BailianRealtimeResponseEvent): void;
  acceptsOmniRuntimeEvent(view: VoiceRealtimeView, response?: BailianRealtimeResponseEvent): boolean;
  base64ToPcm16(audio: string): Int16Array;
  ensureOmniPlayback(view: VoiceRealtimeView, owner: "native-e2e"): Promise<unknown>;
  finishOmniPlaybackWhenReady(view: VoiceRealtimeView): void;
  captureVoicePresentationGuard(view: VoiceRealtimeView): () => boolean;
  checkOmniContextSources(view: VoiceRealtimeView): Promise<boolean>;
  clearOmniResponseTimer(view: VoiceRealtimeView): void;
  startSystemSpeechForActiveTurn(view: VoiceRealtimeView, text: string, reason: string): unknown;
  settleCompletedOmniE2eVoiceTurn(view: VoiceRealtimeView, text: string): Promise<void>;
  startFallbackTtsForActiveTurn(view: VoiceRealtimeView, text: string, reason: string): Promise<void>;
  updateManagedAssistantText(view: VoiceRealtimeView, text: string): void;
  clearVoiceReconnectState(view: VoiceRealtimeView): void;
  clearVoiceRecoveryTimers(view: VoiceRealtimeView): void;
  cleanupRealtimeAudio(view: VoiceRealtimeView): void;
  retireOmniPlaybackDrain(view: VoiceRealtimeView): void;
  sendRoutedLifeOpsVoiceTurn(view: VoiceRealtimeView, transcript: string, route: "brain"): Promise<void>;
}

type OmniModelTerminalReceipt = {
  runtime: VoiceSessionController | undefined;
  responseId: string | undefined;
  queueable: boolean;
  current: () => boolean;
  promise: Promise<void>;
};

export function createOmniResponseHandlers(host: OmniResponseHost) {
  const omniModelTerminals = new WeakMap<object, OmniModelTerminalReceipt>();

  function handleOmniE2eResponseText(view: VoiceRealtimeView, text: string, response?: BailianRealtimeResponseEvent): void {
    if (!host.hasActiveVoiceRuntimeTurn(view) || view.agentOmniE2eAssistantIndex < 0
      || response && !host.acceptsOmniRuntimeEvent(view, response)) return;
    const reply = projectProposalFailure(view) || text;
    if (!reply.trim()) return;
    host.armOmniResponseTimer(view);
    host.updateManagedAssistantText(view, reply);
  }

  function handleOmniE2eResponseCreated(
    view: VoiceRealtimeView,
    response: BailianRealtimeResponseEvent
  ): void {
    if (!host.isOmniE2eRealtimeMode(view.controller.settings.realtimeVoice)) return;
    if (!host.hasActiveVoiceRuntimeTurn(view) || !response.responseId) return;
    const runtime = view.agentVoiceRuntime;
    if (!runtime) return;
    const current = runtime.snapshot().currentTurn;
    if (current?.route !== "e2e" || current.phase === "completed" || current.phase === "interrupted" || current.phase === "failed") return;
    try {
      if (response.retryOfResponseId) {
        runtime.retryResponse(response.retryOfResponseId, response.responseId);
      } else if (response.toolContinuation) {
        runtime.continueToolResponse(
          response.toolContinuation.previousResponseId,
          response.responseId,
          response.toolContinuation.callIds
        );
      } else {
        runtime.bindResponse(response.responseId);
      }
      host.armOmniResponseTimer(view);
    } catch {
      host.failOmniE2eVoiceTurn(view, "收到与当前回合不一致的响应标识。");
    }
  }

  function handleOmniE2eAudioDelta(
    view: VoiceRealtimeView,
    base64Audio: string,
    sampleRate: number,
    response?: BailianRealtimeResponseEvent
  ): void {
    if (!host.isOmniE2eRealtimeMode(view.controller.settings.realtimeVoice)) return;
    if (!host.hasActiveVoiceRuntimeTurn(view)) return;
    if (!host.acceptsOmniRuntimeEvent(view, response)) return;
    if (projectProposalFailure(view)) return;
    if (!view.controller.settings.realtimeVoice.speakReplies) return;
    // With a separate TTS engine, wait for the model's final text and retain one playback owner.
    if (view.controller.settings.realtimeVoice.ttsEngine === "breeze-blue" && !view.agentRealtimeClient?.hasProtectedContextSources?.()
        && !view.agentVoiceRuntime?.snapshot().currentTurn?.nativeAudioStarted) return;
    if (!view.agentVoiceTrace.ttsStart) {
      view.markVoiceTrace("ttsStart");
    }
    const pcm = host.base64ToPcm16(base64Audio);
    if (pcm.length === 0) return;
    host.armOmniResponseTimer(view);
    const runtime = view.agentVoiceRuntime;
    if (!runtime || !view.agentAudioOutput) {
      if (!view.enqueueAgentSpeechAudio(base64Audio, sampleRate)) {
        view.agentReply = "Qwen-Omni 返回了音频，但本地播放器没有成功启动。";
        view.refreshAgentSurfaceState();
      }
      return;
    }
    const current = runtime.snapshot().currentTurn;
    if (!current) return;
    if (!current.nativeAudioStarted) {
      runtime.markNativeAudioStarted();
      runtime.selectOutputOwner("native-e2e");
      if (current.phase === "generating") {
        runtime.transitionTurn("synthesizing", "turn.native_audio.received");
      }
    }
    view.agentOmniPendingAudio.push({ pcm, sampleRate });
    void host.ensureOmniPlayback(view, "native-e2e");
  }

  function handleOmniE2eAudioDone(
    view: VoiceRealtimeView,
    response: BailianRealtimeResponseEvent
  ): void {
    if (!host.acceptsOmniRuntimeEvent(view, response)) return;
    const runtime = view.agentVoiceRuntime;
    if (!runtime) return;
    if (view.controller.settings.realtimeVoice.ttsEngine === "breeze-blue" && !view.agentRealtimeClient?.hasProtectedContextSources?.() && !runtime.snapshot().currentTurn?.nativeAudioStarted) return;
    runtime.markNativeAudioDone();
    host.finishOmniPlaybackWhenReady(view);
  }

  function currentOmniModelTerminal(view: VoiceRealtimeView): OmniModelTerminalReceipt | undefined {
    const held=omniModelTerminals.get(view);
    if(held&&!held.current()){omniModelTerminals.delete(view);return undefined;}
    return held;
  }

  async function finishOmniE2eVoiceTurn(
    view: VoiceRealtimeView,
    text: string,
    response?: BailianRealtimeResponseEvent
  ): Promise<void> {
    if (!host.isOmniE2eRealtimeMode(view.controller.settings.realtimeVoice)) return;
    if (!host.hasActiveVoiceRuntimeTurn(view) || view.agentOmniE2eAssistantIndex < 0) return;
    if (!host.acceptsOmniRuntimeEvent(view, response)) return;
    const runtime:VoiceSessionController|undefined=view.agentVoiceRuntime;
    const turn=runtime?.snapshot().currentTurn,client=view.agentRealtimeClient;
    const responseId=turn?.responseId,startGeneration=view.agentRealtimeStartGeneration;
    const exactTerminal=!!runtime&&!!responseId&&response?.responseId===responseId&&response.status==="completed"
      &&(response.eventType==="response.done"||response.eventType==="response.completed");
    // Legacy fallback calls keep their original path and cannot occupy the real
    // model-terminal slot while a completed response is still arriving.
    if(!exactTerminal){await finishOwnedOmniE2eVoiceTurn(view,text,response);return;}
    const prior=currentOmniModelTerminal(view);
    if(prior){if(prior.responseId===response?.responseId)await prior.promise;return;}
    const presentationCurrent=host.captureVoicePresentationGuard(view);
    let resolve!:()=>void,reject!:(error:unknown)=>void;
    const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
    const held:OmniModelTerminalReceipt={runtime,responseId:response?.responseId,queueable:true,
      current:()=>omniModelTerminals.get(view)===held&&presentationCurrent()
        &&view.agentRealtimeClient===client&&view.agentRealtimeStartGeneration===startGeneration
        &&(!runtime||runtime.snapshot().currentTurn?.responseId===responseId),promise};
    // Reserve before invoking source checks, which can synchronously re-enter.
    // This receipt only permits a bounded next-input handoff after actual drain;
    // modelDone, publication and persistence still require the original fresh check.
    omniModelTerminals.set(view,held);
    void finishOwnedOmniE2eVoiceTurn(view,text,response,held).then(resolve,reject);
    let succeeded=false;
    try{await promise;succeeded=true;}finally{
      // A validated terminal can await real playback after this promise resolves.
      // Keep its completed flight until this exact turn retires, so late duplicates
      // cannot repeat modelDone or start another source-validation flight.
      if(omniModelTerminals.get(view)===held&&(!succeeded||!held.current()))omniModelTerminals.delete(view);
    }
  }

  async function finishOwnedOmniE2eVoiceTurn(
    view:VoiceRealtimeView,text:string,response:BailianRealtimeResponseEvent|undefined,held?:OmniModelTerminalReceipt
  ):Promise<void>{
    if(held&&!held.current())return;
    if(view.agentRealtimeClient?.hasProtectedContextSources?.() && !await host.checkOmniContextSources(view))return;
    if((held&&!held.current()) || !host.hasActiveVoiceRuntimeTurn(view) || !host.acceptsOmniRuntimeEvent(view,response))return;
    host.clearOmniResponseTimer(view);
    const reply = (projectProposalFailure(view) || text || view.agentOmniE2eReply || "我听到了，但这次没有生成稳定的文字回复。").trim();
    view.agentVoiceCircuitBreaker?.recordSuccess?.();
    view.markVoiceTrace("modelDone");
    const runtime = view.agentVoiceRuntime;
    if (runtime) {
      runtime.updateAssistantText(reply);
      runtime.markModelDone();
      if(projectProposalFailure(view)) {
        if(view.controller.settings.realtimeVoice.speakReplies && view.agentMode === "voice") {
          host.startSystemSpeechForActiveTurn(view,reply,"project_proposal_failed");
        } else {
          view.markVoiceTrace("ttsDone");await host.settleCompletedOmniE2eVoiceTurn(view,reply);
        }
        return;
      }
      const current = runtime.snapshot().currentTurn;
      if (current?.nativeAudioStarted) {
        if (!current.nativeAudioDone) runtime.markNativeAudioDone();
        if (view.agentVoiceFallbackReason) {
          await host.startFallbackTtsForActiveTurn(view, reply, view.agentVoiceFallbackReason);
          return;
        }
        host.finishOmniPlaybackWhenReady(view);
        if (!runtime.snapshot().currentTurn?.playbackDrained) {
          handleOmniE2eResponseText(view, reply, response);
          return;
        }
      }
    }
    if (
      runtime
      && !runtime.snapshot().currentTurn?.nativeAudioStarted
      && view.controller.settings.realtimeVoice.speakReplies
      && view.agentMode === "voice"
    ) {
      await host.startFallbackTtsForActiveTurn(view, reply, "native_audio_missing");
      return;
    }
    view.markVoiceTrace("ttsDone");
    await host.settleCompletedOmniE2eVoiceTurn(view, reply);
  }

  async function fallbackOmniResponseToBrain(
    view: VoiceRealtimeView,
    message: string,
    response?: BailianRealtimeResponseEvent
  ): Promise<void> {
    const isCurrent = host.captureVoicePresentationGuard(view);
    if (!isCurrent()) return;
    const runtime = view.agentVoiceRuntime;
    const current = runtime?.snapshot().currentTurn;
    if (
      !runtime
      || !current
      || current.route !== "e2e"
      || !host.hasActiveVoiceRuntimeTurn(view)
      || (response && !host.acceptsOmniRuntimeEvent(view, response))
    ) {
      return;
    }
    const failedProposal = projectProposalFailure(view);
    if (failedProposal) {
      view.agentRealtimeClient?.cancelResponse?.("invalid_response");
      await finishOmniE2eVoiceTurn(view, failedProposal, response);
      return;
    }
    const transcript = current.transcript.trim();
    if (!transcript) {
      host.failOmniE2eVoiceTurn(view, message, response);
      return;
    }

    host.clearVoiceRecoveryTimers(view);
    const circuit = view.agentVoiceCircuitBreaker?.recordFailure?.(
      message.includes("timeout") ? "e2e_response_timeout" : "e2e_response_failed"
    );
    runtime.setRoute("brain");
    view.agentRealtimeClient?.cancelResponse?.(realtimeProviderError(message).code);
    if (current.playbackId) {
      runtime.selectOutputOwner("none");
      view.agentAudioOutput?.cancel?.(current.playbackId, "provider_response_fallback");
    }
    view.agentTtsClient?.cancel?.();
    view.agentTtsClient = null;
    view.agentOmniPendingAudio = [];
    host.retireOmniPlaybackDrain(view);
    view.agentOmniPlaybackReady = null;
    view.agentVoiceFallbackReason = "";
    view.agentSpeaking = false;
    view.agentReply = circuit?.state === "open"
      ? "实时语音连续失败，已打开备用模式；LifeOps 文字主脑正在接管本轮..."
      : "实时模型本轮没有正常结束，LifeOps 文字主脑正在接管...";
    view.refreshAgentSurfaceState();
    await view.controller.appendQualityLog?.({
      inputSource: "voice",
      errorCode: "omni_response_fallback"
    }).catch(() => undefined);
    if (!isCurrent()) return;
    await host.sendRoutedLifeOpsVoiceTurn(view, transcript, "brain");
  }

  /** A private Runtime receipt ends this connection without another model/TTS request. */
  async function settleCommittedOmniTool(view:VoiceRealtimeView,text:string,response:BailianRealtimeResponseEvent):Promise<void>{
    if(view.viewClosed || !host.hasActiveVoiceRuntimeTurn(view) || !host.acceptsOmniRuntimeEvent(view,response))return;
    const runtime=view.agentVoiceRuntime,current=runtime?.snapshot().currentTurn;
    const sessionId=runtime?.snapshot().sessionId,viewGeneration=view.agentTextRequestGeneration,pipelineGeneration=view.agentVoicePipelineGeneration,startGeneration=view.agentRealtimeStartGeneration;
    const ownsReceipt=()=>!view.viewClosed && view.agentVoiceRuntime===runtime
      && view.agentTextRequestGeneration===viewGeneration && view.agentVoicePipelineGeneration===pipelineGeneration
      && view.agentRealtimeStartGeneration===startGeneration && (!runtime || runtime.snapshot().sessionId===sessionId && runtime.snapshot().currentTurn?.turnId===current?.turnId);
    view.agentRecording=false;view.agentVoiceReady=false;view.agentVoiceConversation=false;
    host.clearVoiceReconnectState(view);host.clearVoiceRecoveryTimers(view);
    host.cleanupRealtimeAudio(view);
    if(current?.playbackId)view.agentAudioOutput?.cancel?.(current.playbackId,"runtime_commit_receipt");
    runtime?.selectOutputOwner?.("none");
    view.agentTtsClient?.cancel?.();view.agentTtsClient=null;
    view.agentOmniPendingAudio=[];view.agentOmniPlaybackReady=null;view.agentRealtimeClient=null;
    handleOmniE2eResponseText(view, text, response);
    runtime?.updateAssistantText?.(text);runtime?.markModelDone?.();runtime?.markPlaybackDrained?.();
    try{await host.settleCompletedOmniE2eVoiceTurn(view,text);}
    catch{
      if(!ownsReceipt())return;
      // Saving an auxiliary conversation log cannot undo the committed operation.
      view.agentReply=text;view.agentOmniE2eReply=text;view.agentVoiceSendInFlight=false;
      view.setAgentBusy?.(false);view.refreshAgentSurfaceState?.();
    }
  }

  return {
    handleOmniE2eResponseCreated, handleOmniE2eResponseText, handleOmniE2eAudioDelta, handleOmniE2eAudioDone, finishOmniE2eVoiceTurn,
    settleCommittedOmniTool, fallbackOmniResponseToBrain, currentOmniModelTerminal,
    retireModelTerminal: (view: VoiceRealtimeView) => omniModelTerminals.delete(view)
  };
}
