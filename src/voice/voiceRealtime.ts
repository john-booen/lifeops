import { attachVoiceWriteReceipts, renderWriteReceipts } from "../writeReceipts";
import { randomUUID } from "node:crypto";
import type { RealtimeProviderRunEvent } from "./realtimeProviderRun";
import { realtimeVoiceReadiness } from "../capabilityReadiness";
import { canUseStreamingHotwords, safeManualHotwords } from "./sessionHotwords";
import { Notice } from "obsidian";
import { createBufferedVoicePlayback } from "./bufferedPlayback";
import {
  BailianConnectionTimeoutError,
  BailianRealtimeClient,
  UNCONFIRMED_VOICE_CANCEL_MESSAGE,
  type BailianRealtimeCallbacks,
  type BailianRealtimeResponseEvent
} from "../bailianRealtime";
import { createTtsClient } from "../breezeLocalTts";
import {
  addEchoText,
  finalizeTurn,
  isAlreadySent,
  isVoiceBackchannelOnly,
  isVoiceHoldOnlyTurn
} from "../voiceSession";
import { normalizeVoiceTriggerText, voiceTriggerEnabled, voiceTriggerLabel, voiceTriggerTimeoutSec } from "./voiceTrigger";
import type { AudioOutputEvent } from "./audioOutput";
import type { VoiceBargeInEvent } from "./voiceBargeIn";
import type { VoiceRuntimeTurnRoute, VoiceSessionController } from "./voiceRuntime";
import type { AgentActionSuggestion, AgentConversationMessage, AgentResponse, RealtimeVoiceSettings } from "../types";
import { committedTaskSpeechForResponse } from "./committedTaskSpeech";
import { mergePendingAgentActions, PENDING_ACTION_CONFLICT_NOTICE } from "../pendingAgentActions";
import { agentConversationAlreadyAppended, bindAgentHistoryResponse, retainAgentConversationAppend } from "../personalMemoryHistory";
import { markVoiceLatency, markVoiceLatencyCapture, resetVoiceLatencyCapture } from "./latency";
import { BreezeResidentTtsClient, closeSessionBreeze, sessionBreeze, VoiceSpeechParts, warmSessionBreeze } from "./breezeSpeech";
import { allowSpeakerBargeIn, isDistantPlaybackSpeech, isSpeakerEcho, recentPlaybackLevel, recordSpeakerPhrase, resetSpeakerEcho, ServerVoiceEndpoint, speakerMicVoice,
  type CascadeCaptureEvent } from "./continuousInput";
import { beginHeardSpeech, finishHeardSpeech, rememberHeardPhrase, takeInterruptedSpeech } from "./interruption";
import { isVaultPathExcluded } from "../privacy";
import { ProviderRunFailure } from "../providerRun";
import { formatDate, todayString } from "../date";
import type { StoreHost } from "../store/settingsSlice";
import { backgroundVoiceQuestion, VoiceJobManager, voiceJobSpeech, type VoiceJob } from "./jobs";
import { isExactVoiceApproval, voiceActionPrompt } from "./actionConfirmation";
import { classifyPlaybackInput, explicitPlaybackPause, offlinePlaybackDecision } from "./playbackInput";

import { executeOmniE2eTool } from "./omniE2e/tools";
import { acceptsOmniRuntimeEvent, createOmniResponseHandlers } from "./omniE2e/responses";
import { armOmniResponseTimer as armOmniTimer, clearOmniResponseTimer } from "./omniE2e/responseTimer";
import { createOmniCallbacks, omniSessionOptions } from "./omniE2e/session";
import { projectProposalFailure } from "./omniE2e/projectProposals";
import { checkActiveOmniSources, CONTEXT_CHANGED_MESSAGE, withdrawOmniContext } from "./omniE2e/contextSources";
import {
  canQueueAfterNativePlayback,
  handleOmniE2eBargeInEvent as applyOmniBargeInEvent,
  handleOmniE2eSpeechStarted as suspectOmniInterruption,
  handleOmniE2eSpeechStopped,
  observeOmniE2eBargeInTranscript as observeOmniInterruption
} from "./omniE2e/input";
import type { AiToolCall } from "../ai";
import type { RealtimeToolOutput } from "./realtimeToolOutput";

export { buildOmniE2eInstructions } from "./omniE2e/instructions";
export { handleOmniE2eSpeechStopped };

type VoiceRealtimeView = any;
const FALLBACK_TTS_FIRST_AUDIO_TIMEOUT_MS = 5_000;
const VOICE_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const systemSpeechRecorded = new WeakMap<VoiceSessionController, string>();
type SpeakerCue = { text: string; completed: boolean };
const pendingSpeakerCues = new WeakMap<object, Map<string, SpeakerCue>>();
const fallbackTtsEngines = new WeakMap<VoiceSessionController, { turnId: string; generation: number; engine: RealtimeVoiceSettings["ttsEngine"] }>();
// Retain Main's original opaque history proof until this exact turn completes.
// Completion may transfer that proof; it must never attest under a newer policy.
const ordinaryMainResponses = new WeakMap<VoiceSessionController, {
  turnId: string; generation: number; store: object; vault: object; response: AgentResponse; reply: string;
}>();
const cancelledVoiceInputs = new WeakMap<object, {text: string; client: BailianRealtimeClient}>();
const activeCascadeCapture = new WeakMap<object, ServerVoiceEndpoint>();
const freshCascadeTranscripts = new WeakMap<object, string>();
const cascadePlaybackLevels = new WeakMap<ServerVoiceEndpoint, number>();
const cascadePlaybackCaptures = new WeakSet<ServerVoiceEndpoint>();
const pendingCascadeInterruptions = new WeakMap<object, AbortController>();
const voiceConfirmations = new WeakMap<object, { turnId: string; action: AgentActionSuggestion; played: boolean }>();
const jobManagers = new WeakMap<object, { revision: string | undefined; manager: VoiceJobManager }>();
const jobPlayback = new WeakMap<object, { id: string; turnId: string; manager: VoiceJobManager; failed?: boolean }>();

export function voiceJobsForPanel(view: VoiceRealtimeView): VoiceJob[] {
  const held = jobManagers.get(view);
  return held && held.revision === view.controller.savedVoiceSettingsRevision ? held.manager.list() : [];
}

function managedVoiceJobs(view: VoiceRealtimeView): VoiceJobManager {
  const controller = view.controller;
  const revision = controller.savedVoiceSettingsRevision;
  const prior = jobManagers.get(view);
  if (prior && prior.revision === revision) return prior.manager;
  prior?.manager.stop();
  const store = controller.store;
  const current = () => !controller.unloaded && controller.store === store && controller.savedVoiceSettingsRevision === revision;
  const manager = new VoiceJobManager(async (request, signal) => {
    if (!current() || view.viewClosed) throw new Error("后台任务已停止。");
    const message = backgroundVoiceQuestion(request);
    const options = { source: "voice" as const, signal, deferConversation: true, voiceBackground: true };
    const result: AgentResponse = controller.submitAgentMessageStream
      ? await controller.submitAgentMessageStream(message, [], undefined, options)
      : await controller.submitAgentMessage(message, [], options);
    if (!current() || view.viewClosed) throw new Error("后台任务已停止。");
    return result;
  }, job => {
    if (!current()) return;
    if (!view.viewClosed) view.refreshVoiceJobs?.();
    const status = { running: "已开始", done: "已完成", cancelled: "已取消", failed: "未完成" }[job.status];
    const label = `（语音后台任务）${job.title} · ${job.id}`;
    const date = formatDate(new Date(job.status === "running" ? job.startedAt : Date.now()));
    void persistCascadeVoiceTurn(view, label, [status, job.result].filter(Boolean).join("\n\n"), undefined, { date, current });
    if (job.status === "done") maybeAnnounceVoiceJob(view);
  });
  jobManagers.set(view, { revision, manager });
  return manager;
}

function maybeAnnounceVoiceJob(view: VoiceRealtimeView): void {
  const held = jobManagers.get(view);
  const confirmation = voiceConfirmations.get(view);
  if (!held || held.revision !== view.controller.savedVoiceSettingsRevision
    || view.viewClosed || view.agentMode !== "voice" || !view.agentRecording || !view.agentVoiceReady
    || !view.controller.settings.realtimeVoice.speakReplies || view.agentBusy || view.agentVoiceSendInFlight
    || view.agentSpeaking || view.agentVoiceSystemSpeechActive || view.agentVoiceLocalSpeechActive
    || activeCascadeCapture.get(view)?.awaitingTranscript || pendingCascadeInterruptions.has(view) || view.voiceSession.inputQueue.length
    || view.currentVoiceMessageText() || hasActiveVoiceRuntimeTurn(view)
    || confirmation?.played && view.pendingAgentActions.includes(confirmation.action)
    || voiceTurnSettlements.get(view)?.current()) return;
  const runtime: VoiceSessionController | undefined = view.agentVoiceRuntime;
  if (runtime?.snapshot().sessionPhase !== "listening") return;
  const job = held.manager.takeAnnouncement();
  if (!job?.result) return;
  const turn = beginManagedVoiceTurn(view, "", "brain");
  if (!turn) { held.manager.settleAnnouncement(job.id, false); return; }
  jobPlayback.set(view, { id: job.id, turnId: turn.turnId, manager: held.manager });
  view.agentVoicePipelineGeneration = turn.generation;
  view.agentOmniE2eUserMessage = "";
  view.agentOmniE2eReply = `刚才的「${job.title}」好了。${voiceJobSpeech(job.result, job.voiceSpeech)}`;
  view.agentOmniE2eActionSuggestions = 0;
  view.beginVoiceProcessingTrace();
  view.setAgentBusy(true);
  view.transitionVoiceSession("processing", "voice background job announcement");
  runtime.updateAssistantText(view.agentOmniE2eReply);
  runtime.markModelDone();
  void startFallbackTtsForActiveTurn(view, view.agentOmniE2eReply, "background_job").catch(() => {
    if (jobPlayback.get(view)?.turnId === turn.turnId) interruptManagedVoiceTurn(view, "background_job_playback_failed");
  });
}

function settleJobPlayback(view: VoiceRealtimeView, turnId: string | undefined, completed: boolean): boolean {
  const held = jobPlayback.get(view);
  if (!held || held.turnId !== turnId) return false;
  jobPlayback.delete(view);
  held.manager.settleAnnouncement(held.id, completed && !held.failed);
  return true;
}

export function clearCancelledVoiceInput(view: VoiceRealtimeView): void {
  cancelledVoiceInputs.delete(view);
}

export function canRepeatCancelledVoiceInput(view: VoiceRealtimeView, text: string): boolean {
  const lost = cancelledVoiceInputs.get(view);
  const visible = view.voiceDisplayInput?.(text) ?? text;
  return Boolean(lost && !view.viewClosed && view.agentMode === "voice" && view.agentVoiceConversation
    && view.agentVoiceReady && view.agentRealtimeClient && view.agentRealtimeClient !== lost.client
    && normalizeVoiceTriggerText(visible).value === normalizeVoiceTriggerText(lost.text).value);
}
/** Terminal metadata uses the request's captured owner, never the current turn.
 * It may settle while presentation callbacks are already invalidated. */
export function recordVoiceProviderRun(view: VoiceRealtimeView, runtime: VoiceSessionController | undefined, event: RealtimeProviderRunEvent): void {
  const errorCode = event.errorCode ?? (event.run.status === "success" ? undefined : event.run.attempts.at(-1)?.errorCode);
  if (event.context) runtime?.eventJournal().record({
    timestamp: Date.now(), ...event.context, provider: event.run.requestedProvider,
    providerTraceId: event.traceId, eventType: `provider.${event.stage}.${event.run.status}`,
    stateBefore: "provider.pending", stateAfter: `provider.${event.run.status}`, errorCode
  });
  void Promise.resolve(view.controller.appendQualityLog?.({
    inputSource: "voice", providerTraceId: event.traceId, providerStage: event.stage,
    providerRuns: [event.run], fallbackUsed: event.run.fallbackUsed, errorCode
  })).catch(() => undefined);
}

export function guardRealtimeCallbacks(callbacks: BailianRealtimeCallbacks, isCurrent: () => boolean): BailianRealtimeCallbacks {
  return Object.fromEntries(Object.entries(callbacks).map(([name, callback]) => [name, (...args: unknown[]) => {
    if (!isCurrent()) return name === "onToolCall" ? "语音会话已停止，未执行操作。" : undefined;
    return (callback as (...values: unknown[]) => unknown)(...args);
  }])) as BailianRealtimeCallbacks;
}

export async function startBailianRealtimeRecording(view: VoiceRealtimeView): Promise<void> {
  if (!view.agentVoiceReconnectAttempts) clearCancelledVoiceInput(view);
  const readiness = realtimeVoiceReadiness(view.controller.settings);
  if (!readiness.ready) {
    closeSessionBreeze(view);
    if (view.agentRealtimeClient || view.agentAudioContext || view.agentStream) {
      await stopBailianRealtimeRecording(view, true);
    }
    view.agentVoiceConversation = false;
    view.agentReply = readiness.message;
    view.refreshAgentSurfaceState();
    new Notice(readiness.message);
    return;
  }
  const realtimeVoice = view.controller.settings.realtimeVoice;
  let startGeneration: number | undefined;
  const startIsCurrent = () => !view.viewClosed && view.agentRealtimeStartGeneration === startGeneration;
  try {
    if (view.agentRealtimeClient || view.agentAudioProcessor || view.agentAudioContext) {
      const stopped = stopBailianRealtimeRecording(view, true);
      const stoppedGeneration = view.agentRealtimeStartGeneration;
      await stopped;
      if (view.viewClosed || view.agentRealtimeStartGeneration !== stoppedGeneration) return;
    } else {
      view.stopAgentRecording(true);
    }
    startGeneration = (view.agentRealtimeStartGeneration ?? 0) + 1;
    view.agentRealtimeStartGeneration = startGeneration;
    view.resetVoiceSessionForStart();
    prepareVoiceRuntimeForStart(view);
    view.beginVoiceTurnBuffer(view.agentInput);
    view.clearVoiceWarmupTimer();
    view.agentVoiceReady = false;
    warmSessionBreeze(view, realtimeVoice);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    if (!startIsCurrent()) { stream.getTracks().forEach(track => track.stop()); return; }
    view.agentStream = stream;
    resetSpeakerEcho(view, stream.getAudioTracks?.()[0]?.getSettings?.().echoCancellation !== false);

    const injectedContextBlock = isOmniE2eRealtimeMode(realtimeVoice)
      ? await (view.controller.buildVoiceSessionContextBlock?.() ?? view.controller.buildAgentInjectedContextBlock?.() ?? Promise.resolve("")).catch(() => "")
      : "";
    if (!startIsCurrent()) { stream.getTracks().forEach(track => track.stop()); return; }
    const providerRuntime: VoiceSessionController | undefined = view.agentVoiceRuntime;
    const cascadeEndpoint = isOmniE2eRealtimeMode(realtimeVoice) ? undefined : new ServerVoiceEndpoint();
    const automaticHotwords = !!cascadeEndpoint && (realtimeVoice.asrEngine ?? "realtime") === "realtime"
      && canUseStreamingHotwords(realtimeVoice.endpoint);
    const words = cascadeEndpoint && (automaticHotwords || realtimeVoice.asrEngine === "streaming-hotwords")
      ? await (view.controller.collectVoiceSessionHotwords?.(realtimeVoice.asrHotwords)
        ?? Promise.resolve(safeManualHotwords(view.controller.settings, realtimeVoice.asrHotwords)))
        .catch(() => safeManualHotwords(view.controller.settings, realtimeVoice.asrHotwords))
      : [];
    if (!startIsCurrent() || view.controller.settings.realtimeVoice !== realtimeVoice) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    const useHotwords = automaticHotwords && words.length > 0 || realtimeVoice.asrEngine === "streaming-hotwords";
    const asr = useHotwords ? { ...realtimeVoice, asrEngine: "streaming-hotwords" as const, asrHotwords: words.join("\n") } : realtimeVoice;
    const modeCallbacks: BailianRealtimeCallbacks = cascadeEndpoint ? {
      onCascadeCapture: event => handleCascadeCapture(view, cascadeEndpoint, event)
    } : createOmniCallbacks(view, omniSessionHandlers);
    const createClient = (voice: RealtimeVoiceSettings): BailianRealtimeClient => {
      const connection: BailianRealtimeClient = new BailianRealtimeClient(voice, { ...guardRealtimeCallbacks({
      onOpen: () => {
        view.agentReply = "百炼实时语音已连接，正在预热；等提示变成“语音常驻监听中”再开始说。";
        view.refreshAgentSurfaceState();
      },
      ...modeCallbacks,
      onDisconnected: ({ code, reason }) => {
        handleRealtimeDisconnect(view, code, reason);
      },
      onTransportError: (message) => {
        handleRealtimeDisconnect(view, 1006, message);
      },
      onInitialContextError: (message) => {
        view.agentVoiceConversation = false;
        const stopping = stopBailianRealtimeRecording(view, true), stoppedGeneration = view.agentRealtimeStartGeneration;
        view.agentReply = message; new Notice(message);
        void stopping.then(() => {
          if (view.viewClosed || view.agentRealtimeStartGeneration !== stoppedGeneration) return;
          view.agentReply = message; view.refreshAgentSurfaceState();
        }).catch(() => undefined);
      },
      onError: message => {
        if (!cascadeEndpoint && hasActiveVoiceRuntimeTurn(view)) {
          void fallbackOmniResponseToBrain(view, message);
        } else if (!hasActiveVoiceRuntimeTurn(view)) {
          failOmniE2eVoiceTurn(view, message);
        } else {
          new Notice(`百炼实时语音错误：${message}`);
          return;
        }
        new Notice(view.agentReply);
      }
    }, () => startIsCurrent() && view.agentRealtimeClient === connection),
      onProviderRun: event => recordVoiceProviderRun(view, providerRuntime, event)
    }, {
      mode: realtimeVoice.mode ?? "cascade",
      ...(!cascadeEndpoint ? omniSessionOptions(injectedContextBlock) : {}),
      providerContext: () => {
        const snapshot = providerRuntime?.snapshot();
        return snapshot ? { sessionId: snapshot.sessionId, generation: snapshot.generation,
          ...(snapshot.currentTurn ? { turnId: snapshot.currentTurn.turnId } : {}) } : undefined;
      }
      });
      return connection;
    };
    let client = createClient(asr);
    view.agentRealtimeClient = client;
    view.agentRecording = true;
    view.agentReply = "麦克风已接入，正在连接百炼实时语音...";
    view.refreshAgentSurfaceState();
    try {
      await client.connect();
    } catch (error) {
      if (!startIsCurrent() || view.agentRealtimeClient !== client) throw error;
      if (automaticHotwords && useHotwords) {
        client.close();
        client = createClient(realtimeVoice);
        view.agentRealtimeClient = client;
        view.agentReply = "热词识别暂时连不上，正在连接百炼实时识别…";
      } else {
        if (!(error instanceof BailianConnectionTimeoutError) || isOmniE2eRealtimeMode(realtimeVoice)
          || view.agentVoiceReconnectAttempts) throw error;
        view.agentReply = "语音连接超时，正在重试…";
      }
      view.refreshAgentSurfaceState();
      await client.connect();
    }
    if (!startIsCurrent() || view.agentRealtimeClient !== client) { client.close(); return; }
    view.agentReply = "语音正在预热，约 3 秒后可以开始说。";
    view.refreshAgentSurfaceState();
    await startPcmAudioCapture(view, client, startIsCurrent);
    if (!startIsCurrent() || view.agentRealtimeClient !== client) return;
    view.agentVoiceWarmupTimer = window.setTimeout(() => {
      void finishBailianVoiceWarmup(view, client);
    }, 3000);
  } catch (error) {
    if (startGeneration !== undefined && !startIsCurrent()) return;
    view.transitionVoiceSession("error", error instanceof Error ? error.message : "bailian realtime start failed");
    view.clearVoiceWarmupTimer();
    view.agentVoiceReady = false;
    cleanupRealtimeAudio(view);
    view.agentRealtimeClient?.close?.();
    view.agentRealtimeClient = null;
    view.agentRecording = false;
    const message = error instanceof Error ? error.message : "百炼实时语音启动失败";
    const reconnect = !(error instanceof Error && error.name === "RealtimeConnectionContextError")
      && view.agentVoiceReconnectAttempts > 0 && shouldReconnectVoice(view);
    if (reconnect) view.agentVoiceRuntime?.reconnect?.("realtime_start_failed");
    else {
      closeSessionBreeze(view);
      view.agentVoiceConversation = false;
      clearVoiceReconnectState(view);
      view.agentVoiceRuntime?.stop?.();
    }
    view.agentReply = `百炼实时语音启动失败：${message}`;
    new Notice(view.agentReply);
    await view.render();
    if (reconnect && startIsCurrent() && view.agentVoiceReconnectAttempts > 0 && shouldReconnectVoice(view)) {
      scheduleVoiceReconnect(view, message);
    }
  }
}

export function handleCascadeCapture(view: VoiceRealtimeView, endpoint: ServerVoiceEndpoint, event: CascadeCaptureEvent): void {
  if (!view.agentVoiceReady) return;
  activeCascadeCapture.set(view, endpoint);
  const capture = endpoint.accept(event);
  if (!capture) return;
  const playing = Boolean(view.agentSpeaking || view.agentVoiceSystemSpeechActive
    || view.agentAudioOutput?.snapshot?.()?.status === "playing");
  if (event.type === "started") {
    cancelCascadeInterruption(view);
    if (playing) cascadePlaybackCaptures.add(endpoint);
    else cascadePlaybackCaptures.delete(endpoint);
    cascadePlaybackLevels.set(endpoint, 0);
    freshCascadeTranscripts.delete(view);
    resetVoiceLatencyCapture(view);
    clearCascadePreview(view);
    if (view.agentVoiceSystemSpeechActive || !allowSpeakerBargeIn(view, playing)) return;
    if (!hasActiveVoiceRuntimeTurn(view)) view.handleVoiceSpeechStarted("server-vad");
  } else if (event.type === "preview") {
    if (isSpeakerEcho(view, event.text) || !allowSpeakerBargeIn(view, playing)) return;
    view.markVoiceTrace("firstTranscript");
    view.updateRealtimeTranscript(event.text, false, false, true);
  } else if (event.type === "stopped") {
    if (!cascadePlaybackLevels.get(endpoint)) cascadePlaybackLevels.set(endpoint, recentPlaybackLevel(view));
    markVoiceLatencyCapture(view, "t0");
    view.handleVoiceSpeechStopped("server-vad", false);
  } else if (event.type === "final") {
    markVoiceLatencyCapture(view, "t1");
    view.markVoiceTrace("transcriptDone");
  } else {
    clearCascadePreview(view);
    maybeAnnounceVoiceJob(view);
  }
  if (capture.ready === undefined) return;
  clearCascadePreview(view);
  const overlapsPlayback = playing || cascadePlaybackCaptures.has(endpoint);
  const playbackLevel = cascadePlaybackLevels.get(endpoint) || recentPlaybackLevel(view);
  if (!capture.ready.trim() || isSpeakerEcho(view, capture.ready)
    || overlapsPlayback && (isVoiceBackchannelOnly(capture.ready) || isDistantPlaybackSpeech(view, playbackLevel))) {
    maybeAnnounceVoiceJob(view);
    return;
  }
  if (overlapsPlayback && view.agentMode === "voice" && explicitPlaybackPause(capture.ready)) {
    view.clearVoiceNoTranscriptTimer();
    if (playing) {
      view.interruptAgentSpeech();
      view.transitionVoiceSession("listening", "user paused voice playback");
    }
    return;
  }
  if (!overlapsPlayback || voiceConfirmations.has(view)) {
    submitCascadeTranscript(view, capture.ready);
    return;
  }
  const previousQuestion = view.agentVoiceRuntime?.snapshot?.().currentTurn?.transcript ?? "";
  if (view.controller.settings.ai?.dataDisclosureAccepted === true) {
    void reviewCascadeInterruption(view, endpoint, capture.ready, previousQuestion);
  } else if (offlinePlaybackDecision(capture.ready, previousQuestion) === "accept") {
    submitCascadeTranscript(view, capture.ready);
  } else {
    maybeAnnounceVoiceJob(view);
  }
}

function cancelCascadeInterruption(view: VoiceRealtimeView): void {
  pendingCascadeInterruptions.get(view)?.abort();
  pendingCascadeInterruptions.delete(view);
}

async function reviewCascadeInterruption(view: VoiceRealtimeView, endpoint: ServerVoiceEndpoint, transcript: string, previousQuestion: string): Promise<void> {
  cancelCascadeInterruption(view);
  const check = new AbortController();
  pendingCascadeInterruptions.set(view, check);
  const { settings, savedVoiceSettingsRevision } = view.controller;
  const generation = view.agentVoicePipelineGeneration;
  const decision = await classifyPlaybackInput(settings, transcript, previousQuestion, check.signal);
  if (pendingCascadeInterruptions.get(view) !== check) return;
  pendingCascadeInterruptions.delete(view);
  if (view.viewClosed || !view.agentRecording || !view.agentVoiceReady || view.agentMode !== "voice"
    || activeCascadeCapture.get(view) !== endpoint || view.controller.savedVoiceSettingsRevision !== savedVoiceSettingsRevision
    || view.agentVoicePipelineGeneration !== generation) return;
  if (decision === "accept") submitCascadeTranscript(view, transcript);
  else maybeAnnounceVoiceJob(view);
}

function submitCascadeTranscript(view: VoiceRealtimeView, transcript: string): void {
  cancelCascadeInterruption(view);
  freshCascadeTranscripts.set(view, transcript.trim());
  view.updateRealtimeTranscript(transcript, true, true);
  void view.sendVoiceTurnIfReady();
}

function clearCascadePreview(view: VoiceRealtimeView): void {
  if (!view.agentVoiceActivePartial) return;
  view.agentVoiceActivePartial = "";
  view.agentLiveDraftText = view.agentVoiceTurnText;
  view.agentVoiceRawInput = [view.agentVoiceBaseInput, view.agentVoiceTurnText].filter(Boolean).join("\n");
  view.setAgentInput(view.voiceDisplayInput(view.agentVoiceRawInput));
}

export async function finishBailianVoiceWarmup(view: VoiceRealtimeView, client: BailianRealtimeClient): Promise<void> {
  if (!view.agentRecording || view.agentRealtimeClient !== client) return;
  view.agentVoiceWarmupTimer = 0;
  try {
    view.resetVoiceTurnBuffer();
    client.resetTranscript();
    if (!view.agentRecording || view.agentRealtimeClient !== client) return;
    view.agentVoiceReady = true;
    clearVoiceReconnectTimer(view);
    view.agentVoiceReconnectAttempts = 0;
    markVoiceRuntimeConnected(view);
    view.transitionVoiceSession("listening", "bailian warmup done");
    const triggerHint = voiceTriggerEnabled(view.controller.settings)
      ? `先说「${voiceTriggerLabel(view.controller.settings)}」唤醒我；触发后 ${voiceTriggerTimeoutSec(view.controller.settings)} 秒内可以连续追问。`
      : "说完停顿后我会自动回应。";
    const replyHint = view.controller.settings.realtimeVoice.speakReplies
      ? "我会用语音回复。"
      : "当前是文字回复模式，我只会把回答显示在面板里。";
    view.agentReply = view.agentMode === "voice"
      ? `语音常驻监听中，${triggerHint}${replyHint}`
      : "百炼实时语音已启动，我在听；点击停止后会发送给管家。";
    view.refreshAgentSurfaceState();
  } catch (error) {
    view.agentVoiceReady = false;
    view.transitionVoiceSession("error", error instanceof Error ? error.message : "voice capture start failed");
    view.agentReply = error instanceof Error ? `语音采集启动失败：${error.message}` : "语音采集启动失败";
    new Notice(view.agentReply);
    cleanupRealtimeAudio(view);
    await view.render();
  }
}

export async function stopBailianRealtimeRecording(view: VoiceRealtimeView, silent = false): Promise<void> {
  view.agentRealtimeStartGeneration = (view.agentRealtimeStartGeneration ?? 0) + 1;
  const stoppedGeneration = view.agentRealtimeStartGeneration;
  const stopIsCurrent = () => !view.viewClosed && view.agentRealtimeStartGeneration === stoppedGeneration;
  clearVoiceReconnectState(view);
  const job = jobPlayback.get(view);
  if (job) settleJobPlayback(view, job.turnId, false);
  jobManagers.get(view)?.manager.stop();
  const realtimeClient = view.agentRealtimeClient;
  const isOmniE2e = Boolean(realtimeClient && isOmniE2eRealtimeMode(view.controller.settings.realtimeVoice));
  view.agentRecording = false;
  view.agentVoiceBargeIn?.reset?.("recording_stopped");
  view.transitionVoiceSession("stopping", "bailian recording stopped");
  view.clearVoiceWarmupTimer();
  view.agentVoiceReady = false;
  const text = view.currentVoiceMessageText();
  view.markVoiceTrace("recordingStopped");
  if (silent) {
    closeSessionBreeze(view);
    view.agentRealtimeClient = null;
    view.agentVoiceRuntime?.stop?.();
    cleanupRealtimeAudio(view);
    try { realtimeClient?.cancelResponse?.(); } finally { realtimeClient?.close(); }
    view.transitionVoiceSession("idle", "bailian recording stopped");
    return;
  }
  if (isOmniE2e) {
    cleanupRealtimeAudio(view);
    await sendOmniE2eVoiceTurn(view, "manual stop");
    if (!stopIsCurrent() || view.agentRealtimeClient !== realtimeClient) {
      realtimeClient?.close();
      return;
    }
    if (!hasActiveVoiceRuntimeTurn(view) && !view.agentBusy) {
      view.agentVoiceRuntime?.stop?.();
      realtimeClient?.close();
      if (view.agentRealtimeClient === realtimeClient) view.agentRealtimeClient = null;
      view.transitionVoiceSession("idle", "bailian recording stopped");
      view.agentReply = text ? "语音已停止，正在等待 Qwen-Omni 回复..." : "语音已停止，但还没有识别到稳定内容。";
      await view.render();
    }
    return;
  }
  try {
    realtimeClient?.commit();
    await waitForRealtimeFlush();
  } catch {
    // Commit is best effort; the transcript collected so far is still usable.
  }
  // A newer start/stop owns the view after an asynchronous flush. Only retire
  // this call's client; never clean up the replacement microphone or runtime.
  if (!stopIsCurrent() || view.agentRealtimeClient !== realtimeClient) {
    realtimeClient?.close();
    return;
  }
  const partial = Boolean(view.agentVoiceActivePartial?.trim());
  const shouldAutoSend = Boolean(text && !partial && view.agentVoiceConversation
    && view.controller.settings.realtimeVoice.autoSendOnStop);
  realtimeClient?.close();
  view.agentRealtimeClient = null;
  cleanupRealtimeAudio(view);
  view.agentReply = shouldAutoSend ? "语音已停止，正在发送给管家..."
    : partial ? "语音已停止，未完成的听写留在输入框，请核对后发送。"
    : text ? "语音已停止，文字已留在输入框。" : "语音已停止，但还没有识别到文字。";
  await view.render();
  if (!stopIsCurrent()) return;
  if (shouldAutoSend) {
    await sendManagedVoiceTurn(view, "manual cascade stop");
    if (!stopIsCurrent()) return;
    if (!hasActiveVoiceRuntimeTurn(view) && !view.agentBusy) {
      view.agentVoiceRuntime?.stop?.();
      view.transitionVoiceSession("idle", "bailian recording stopped");
    }
    return;
  }
  view.agentVoiceRuntime?.stop?.();
  view.transitionVoiceSession("idle", "bailian recording stopped");
}

export function isOmniE2eRealtimeMode(settings: RealtimeVoiceSettings): boolean {
  return settings.provider === "qwen-omni-realtime" && (settings.mode ?? "cascade") === "omni-e2e";
}

export function hasPendingCascadeTranscript(view: VoiceRealtimeView): boolean {
  const settings = view.controller.settings.realtimeVoice;
  return Boolean(view.agentRecording && settings.provider === "qwen-omni-realtime"
    && !isOmniE2eRealtimeMode(settings) && view.agentVoiceActivePartial?.trim());
}

export function isFreshCascadeTranscript(view: VoiceRealtimeView, text: string): boolean {
  return Boolean(text && freshCascadeTranscripts.get(view) === text);
}

export async function sendOmniE2eVoiceTurn(view: VoiceRealtimeView, reason = "voice endpoint"): Promise<void> {
  if (!isOmniE2eRealtimeMode(view.controller.settings.realtimeVoice)) return;
  await sendManagedVoiceTurn(view, reason);
}

export async function sendManagedVoiceTurn(view: VoiceRealtimeView, reason = "voice endpoint", queuedServerFinal = false): Promise<void> {
  const realtimeVoice = view.controller.settings.realtimeVoice as RealtimeVoiceSettings;
  if (realtimeVoice.provider !== "qwen-omni-realtime") return;
  if (hasPendingCascadeTranscript(view)) return;
  const isOmniE2e = isOmniE2eRealtimeMode(realtimeVoice);
  const activeRuntimeTurn = hasActiveVoiceRuntimeTurn(view);
  if (view.agentVoiceSendInFlight && !activeRuntimeTurn) {
    view.agentVoiceSendInFlight = false;
    if (view.agentBusy) view.setAgentBusy(false);
  }
  if (activeRuntimeTurn || view.agentBusy) {
    view.queueCurrentVoiceInput("normal", "omni-e2e-busy", queuedServerFinal);
    return;
  }
  view.agentVoiceSendInFlight = true;
  const client = view.agentRealtimeClient, runtime = view.agentVoiceRuntime;
  const startGeneration = view.agentRealtimeStartGeneration;
  const requestIsCurrent = () => !view.viewClosed
    && view.agentRealtimeStartGeneration === startGeneration
    && view.agentRealtimeClient === client && view.agentVoiceRuntime === runtime;

  let message = view.currentVoiceMessageText();
  const freshServerItem = !isOmniE2e && (queuedServerFinal || isFreshCascadeTranscript(view, message));
  const voiceConfirmation = freshServerItem && !queuedServerFinal ? takeVoiceConfirmation(view, runtime) : undefined;
  if (message) {
    if (!freshServerItem && isVoiceHoldOnlyTurn(view.voiceDisplayInput(message) || message)) {
      view.discardCurrentVoiceTurn("已忽略没有实际问题的短声音。");
      view.agentVoiceSendInFlight = false;
      return;
    }
    const gatedMessage = voiceConfirmation ? message : view.prepareVoiceMessageForSend(message, freshServerItem);
    if (!gatedMessage) {
      view.agentVoiceSendInFlight = false;
      return;
    }
    message = gatedMessage;
    view.setAgentInput(view.voiceDisplayInput(message) || message);
    if (!freshServerItem && isAlreadySent(view.voiceSession, message)) {
      view.discardCurrentVoiceTurn("已忽略重复的语音转写。");
      view.agentVoiceSendInFlight = false;
      return;
    }
    const accepted = !voiceConfirmation && await view.tryAcceptPendingActionFromVoice(message);
    if (!requestIsCurrent()) return;
    if (accepted) {
      view.agentVoiceSendInFlight = false;
      return;
    }
  } else {
    const reply = voiceTriggerEnabled(view.controller.settings)
      ? `我听到了声音，但没有稳定识别到触发词「${voiceTriggerLabel(view.controller.settings)}」。`
      : "我没有收到有效的语音文字，所以不会发送空请求。请再说一遍。";
    view.discardCurrentVoiceTurn(reply);
    view.agentVoiceSendInFlight = false;
    return;
  }

  view.agentVoiceQueuedAfterBusy = false;
  const e2eAllowed = isOmniE2e && view.agentVoiceCircuitBreaker?.allowPrimary?.() !== false;
  const selectedRoute = voiceConfirmation ? "action" : e2eAllowed ? "e2e" : "brain";
  const runtimeTurn = beginManagedVoiceTurn(view, message, selectedRoute);
  if (view.agentVoiceRuntime && !runtimeTurn) {
    view.agentVoiceSendInFlight = false;
    view.queueCurrentVoiceInput("normal", "voice-runtime-not-ready", freshServerItem);
    return;
  }
  clearCancelledVoiceInput(view);
  freshCascadeTranscripts.delete(view);
  retireModelTerminal(view);
  view.agentVoicePipelineGeneration = runtimeTurn?.generation ?? view.agentVoicePipelineGeneration + 1;
  retireOmniPlaybackDrain(view);
  view.agentOmniPlaybackReady = null;
  view.agentOmniPendingAudio = [];
  view.beginVoiceProcessingTrace();
  view.markVoiceTrace("modelStart");
  if (message) {
    view.voiceSession = finalizeTurn(view.voiceSession, message);
    view.rememberSentVoiceTurn(message);
  }
  view.clearVoiceAutoSendTimer();
  view.clearVoiceTurnBufferAfterSend();
  view.agentRealtimeClient?.resetTranscript?.();
  view.setAgentInput("");
  view.agentVoiceIgnoreSpeechStartUntil = performance.now() + 1800;
  view.setAgentBusy(true);
  view.transitionVoiceSession("processing", `${isOmniE2e ? "omni-e2e" : "cascade"} submitted: ${reason}`);

  const userMessage: AgentConversationMessage = { role: "user", content: message };
  const assistantMessage: AgentConversationMessage = { role: "assistant", content: "" };
  view.agentMessages = [...view.agentMessages, userMessage, assistantMessage];
  view.agentOmniE2eAssistantIndex = view.agentMessages.length - 1;
  view.agentOmniE2eReply = "";
  view.agentOmniE2eActionSuggestions = 0;
  view.agentOmniE2eUserMessage = userMessage.content;
  view.appendAgentMessage(userMessage);
  view.agentOmniE2eStreamMessageEl = view.appendAgentMessage(assistantMessage);
  view.scrollAgentTranscriptToBottom();
  view.agentReply = isOmniE2e && !e2eAllowed
    ? "实时语音服务连续失败，已自动使用 LifeOps 备用模式..."
    : selectedRoute === "e2e" ? "语音正在生成回复..." : "LifeOps 正在处理...";
  view.refreshAgentSurfaceState();
  if (voiceConfirmation) {
    await answerVoiceConfirmation(view, voiceConfirmation, isExactVoiceApproval(message));
    return;
  }
  if (selectedRoute === "e2e") {
    armOmniResponseTimer(view);
    view.agentRealtimeClient?.createResponse();
    return;
  }
  await sendRoutedLifeOpsVoiceTurn(view, message, selectedRoute);
}

function takeVoiceConfirmation(view: VoiceRealtimeView, runtime?: VoiceSessionController): AgentActionSuggestion | undefined {
  const pending = voiceConfirmations.get(view);
  if (!pending) return;
  voiceConfirmations.delete(view);
  if (!pending.played || pending.turnId !== runtime?.snapshot().currentTurn?.turnId
    || !view.pendingAgentActions.includes(pending.action)) return;
  return pending.action;
}

async function answerVoiceConfirmation(view: VoiceRealtimeView, action: AgentActionSuggestion, approved: boolean): Promise<void> {
  const presentationCurrent = captureVoicePresentationGuard(view);
  const current = () => presentationCurrent() && hasActiveVoiceRuntimeTurn(view);
  let reply: string;
  if (approved) reply = await view.acceptAgentSuggestion(action, current) ?? "这项确认已失效，请重新提出。";
  else {
    await view.dismissAgentSuggestion(action.id, action, current);
    reply = "好，这项已取消。";
  }
  if (!current()) return;
  updateManagedAssistantText(view, reply);
  view.markVoiceTrace("modelDone");
  view.agentVoiceRuntime?.markModelDone?.();
  if (view.controller.settings.realtimeVoice.speakReplies) await startFallbackTtsForActiveTurn(view, reply, "confirmed_voice_action");
  else await settleManagedVoiceTurn(view, reply);
}

/**
 * Cancelling an Omni response does not reliably produce a subsequent
 * `response.done` event. Settle the local turn immediately so that a user's
 * interruption can be transcribed and submitted without waiting forever.
 */
export function interruptOmniE2eVoiceTurn(view: VoiceRealtimeView, reason = "user interrupted Omni response"): boolean {
  if (!isOmniE2eRealtimeMode(view.controller.settings.realtimeVoice)) return false;
  return interruptManagedVoiceTurn(view, reason);
}

export function interruptManagedVoiceTurn(view: VoiceRealtimeView, reason = "user interrupted voice response"): boolean {
  retireModelTerminal(view);
  if (!hasActiveVoiceRuntimeTurn(view)) return false;

  const runtime = view.agentVoiceRuntime;
  const interruptedTurn = runtime?.snapshot().currentTurn;
  const pendingConfirmation = voiceConfirmations.get(view);
  if (pendingConfirmation && pendingConfirmation.turnId === interruptedTurn?.turnId) voiceConfirmations.delete(view);
  const playbackId = interruptedTurn?.playbackId;
  settleJobPlayback(view, interruptedTurn?.turnId, false);
  const recordInterruption = view.controller.settings.realtimeVoice.provider === "qwen-omni-realtime"
    && !isOmniE2eRealtimeMode(view.controller.settings.realtimeVoice)
    && view.agentRecording && view.agentVoiceConversation;
  const spoken = recordInterruption ? takeInterruptedSpeech(view) : undefined;
  const transcript = view.agentOmniE2eUserMessage?.trim();
  if (runtime) {
    runtime.interrupt(reason);
    ordinaryMainResponses.delete(runtime);
  } else {
    view.agentRealtimeClient?.cancelResponse();
  }
  if (playbackId) view.agentAudioOutput?.cancel?.(playbackId, "voice_interruption");
  if (view.agentVoiceSystemSpeechActive) {
    view.agentVoiceSystemSpeechActive = false;
    window.speechSynthesis?.cancel();
  }
  view.agentSpeaking = false;
  view.invalidateVoicePipeline(reason);
  pendingSpeakerCues.delete(view);
  finishHeardSpeech(view);
  view.agentVoiceBargeIn?.reset?.(reason);
  clearVoiceRecoveryTimers(view);
  view.agentTtsClient?.cancel?.();
  view.agentTtsClient = null;
  view.agentOmniPendingAudio = [];
  retireOmniPlaybackDrain(view);
  view.agentOmniPlaybackReady = null;
  view.agentVoiceFallbackReason = "";

  const assistantIndex = view.agentOmniE2eAssistantIndex;
  const interruptedReply = spoken ?? (view.agentOmniE2eReply.trim() || "（已被新的语音打断）");
  if (spoken) view.agentReply = interruptedReply;
  if (assistantIndex >= 0 && view.agentMessages[assistantIndex]?.role === "assistant") {
    const next = view.agentMessages.slice();
    next[assistantIndex] = { role: "assistant", content: interruptedReply };
    view.agentMessages = next.slice(-12);
  }
  if (view.agentOmniE2eStreamMessageEl) {
    view.setAgentMessageBubbleContent(view.agentOmniE2eStreamMessageEl, interruptedReply);
  }

  view.agentOmniE2eAssistantIndex = -1;
  view.agentOmniE2eStreamMessageEl = null;
  view.agentVoiceSendInFlight = false;
  view.setAgentBusy(false);
  if (pendingConfirmation && pendingConfirmation.turnId === interruptedTurn?.turnId) {
    void Promise.resolve(view.dismissAgentSuggestion?.(pendingConfirmation.action.id, pendingConfirmation.action)).catch(() => undefined);
  }
  view.transitionVoiceSession("listening", reason);
  view.refreshAgentSurfaceState();
  if (spoken && transcript) void persistCascadeVoiceTurn(view, transcript, spoken);
  return true;
}

export async function startPcmAudioCapture(view: VoiceRealtimeView, client: BailianRealtimeClient, isCurrent: () => boolean = () => true): Promise<void> {
  const stream = view.agentStream;
  if (!stream) throw new Error("麦克风流未准备好。");
  const AudioContextConstructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) throw new Error("当前环境不支持 Web Audio。");

  let audioContext: AudioContext | undefined;
  // Cascade ASR uses the same 16k PCM input as Omni; keep their capture geometry
  // aligned so quantum-local resampling cannot shorten daily conversation audio.
  if (view.controller.settings.realtimeVoice.provider === "qwen-omni-realtime") {
    if ("setSinkId" in AudioContextConstructor.prototype) {
      try {
        const options: AudioContextOptions & { sinkId: { type: "none" } } = {
          sampleRate: 16_000, sinkId: { type: "none" }, latencyHint: 0.04
        };
        audioContext = new AudioContextConstructor(options);
      } catch {
        // The optional sink request must fall back to the established capture path.
      }
    }
    if (!audioContext) {
      try {
        audioContext = new AudioContextConstructor({ sampleRate: 16_000 });
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "NotSupportedError") throw error;
        audioContext = new AudioContextConstructor();
      }
    }
  } else {
    audioContext = new AudioContextConstructor();
  }
  if (audioContext.state === "suspended") {
    await audioContext.resume().catch(() => undefined);
  }
  if (!isCurrent()) { await audioContext.close(); return; }
  const source = audioContext.createMediaStreamSource(stream);
  view.agentAudioContext = audioContext;
  view.agentAudioSource = source;

  if (await startAudioWorkletCapture(view, audioContext, source, client, isCurrent)) {
    view.setVoiceCaptureMode("audio-worklet");
    return;
  }
  if (!isCurrent()) { source.disconnect(); await audioContext.close(); return; }

  const processor = audioContext.createScriptProcessor(1024, 1, 1);
  const sink = audioContext.createGain();
  sink.gain.value = 0;
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    if (!isCurrent() || view.agentAudioProcessor !== processor || !canSendRealtimeAudio(view, client)) return;
    observeLocalVoiceEnergy(view, input);
    const pcm = floatTo16kPcm(input, audioContext.sampleRate);
    if (pcm.byteLength > 0) {
      client.appendPcm16(pcm16ToBase64(pcm));
    }
  };
  source.connect(processor);
  processor.connect(sink);
  sink.connect(audioContext.destination);
  view.agentAudioProcessor = processor;
  view.setVoiceCaptureMode("script-processor");
}

export async function startAudioWorkletCapture(
  view: VoiceRealtimeView,
  audioContext: AudioContext,
  source: MediaStreamAudioSourceNode,
  client: BailianRealtimeClient,
  isCurrent: () => boolean = () => true
): Promise<boolean> {
  if (!audioContext.audioWorklet || typeof AudioWorkletNode === "undefined") return false;
  let moduleUrl: string | undefined;
  let node: AudioWorkletNode | undefined;
  let sink: GainNode | undefined;
  try {
    const batch40ms = view.controller.settings.realtimeVoice.provider === "qwen-omni-realtime"
      && [16_000, 44_100, 48_000].includes(audioContext.sampleRate);
    moduleUrl = URL.createObjectURL(new Blob([lifeOpsAudioWorkletSource(batch40ms)], { type: "text/javascript" }));
    await audioContext.audioWorklet.addModule(moduleUrl);
    if (!isCurrent()) return false;
    node = new AudioWorkletNode(audioContext, "lifeops-pcm-capture");
    sink = audioContext.createGain();
    sink.gain.value = 0;
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!isCurrent() || view.agentAudioWorklet !== node || !canSendRealtimeAudio(view, client)) return;
      const input = event.data;
      observeLocalVoiceEnergy(view, input);
      const pcm = floatTo16kPcm(input, audioContext.sampleRate);
      if (pcm.byteLength > 0) client.appendPcm16(pcm16ToBase64(pcm));
    };
    source.connect(node);
    node.connect(sink);
    sink.connect(audioContext.destination);
    view.agentAudioWorklet = node;
    return true;
  } catch {
    if (node) {
      node.port.onmessage = null;
      node.disconnect();
    }
    sink?.disconnect();
    return false;
  } finally {
    if (moduleUrl) URL.revokeObjectURL(moduleUrl);
  }
}

export function canSendRealtimeAudio(view: VoiceRealtimeView, client: BailianRealtimeClient): boolean {
  return view.agentVoiceReady && view.agentRecording && view.agentRealtimeClient === client;
}

export function observeLocalVoiceEnergy(view: VoiceRealtimeView, input: Float32Array): void {
  if (!view.agentVoiceReady || view.agentMode !== "voice") return;
  if (isOmniE2eRealtimeMode(view.controller.settings.realtimeVoice)) return;
  const now = performance.now();
  const rms = audioRms(input);
  const playing = Boolean(view.agentSpeaking || view.agentVoiceSystemSpeechActive
    || view.agentAudioOutput?.snapshot?.()?.status === "playing");
  const speaking = speakerMicVoice(view, rms, playing, now);
  const endpoint = activeCascadeCapture.get(view);
  if (playing && endpoint?.awaitingTranscript) {
    cascadePlaybackLevels.set(endpoint, Math.max(cascadePlaybackLevels.get(endpoint) ?? 0, rms));
  }
  if (speaking) {
    if (!view.agentVoiceLocalSpeechActive) {
      view.agentVoiceLocalSpeechActive = true;
      view.agentVoiceLocalSpeechStartedAt = now;
      view.handleVoiceSpeechStarted("local-vad");
      scheduleNoTranscriptWatchdog(view);
    }
    view.agentVoiceLocalLastSpeechAt = now;
    view.clearVoiceLocalEndpointTimer();
    return;
  }
  if (!view.agentVoiceLocalSpeechActive) return;
  const silenceMs = now - view.agentVoiceLocalLastSpeechAt;
  if (silenceMs < 1200) return;
  view.agentVoiceLocalSpeechActive = false;
  maybeAnnounceVoiceJob(view);
}

export function scheduleNoTranscriptWatchdog(view: VoiceRealtimeView): void {
  if (view.agentVoiceLastTranscriptAt && performance.now() - view.agentVoiceLastTranscriptAt < 1200) return;
  view.clearVoiceNoTranscriptTimer();
  view.agentVoiceNoTranscriptTimer = window.setTimeout(() => {
    view.agentVoiceNoTranscriptTimer = 0;
    if (!view.agentVoiceLocalSpeechActive || view.agentVoiceLastTranscriptAt > view.agentVoiceLocalSpeechStartedAt) return;
    view.agentReply = "我听到你在说话了，转写有点慢，我还在等文字出来。";
    view.refreshAgentSurfaceState();
  }, 3500);
}

export function cleanupRealtimeAudio(view: VoiceRealtimeView): void {
  voiceConfirmations.delete(view);
  cancelCascadeInterruption(view);
  activeCascadeCapture.delete(view);
  freshCascadeTranscripts.delete(view);
  retireModelTerminal(view);
  pendingSpeakerCues.delete(view);
  finishHeardSpeech(view);
  view.clearVoiceWarmupTimer();
  view.clearVoiceLocalEndpointTimer();
  view.clearVoiceNoTranscriptTimer();
  view.agentVoiceReady = false;
  view.agentVoiceLocalSpeechActive = false;
  view.agentVoiceLocalSpeechStartedAt = 0;
  view.agentVoiceLocalLastSpeechAt = 0;
  view.agentVoiceIgnoreSpeechStartUntil = 0;
  cleanupAudioWorkletCapture(view);
  if (view.agentAudioProcessor) {
    view.agentAudioProcessor.onaudioprocess = null;
    view.agentAudioProcessor.disconnect();
  }
  view.agentAudioSource?.disconnect();
  void view.agentAudioContext?.close().catch(() => undefined);
  view.agentAudioProcessor = null;
  view.agentAudioSource = null;
  view.agentAudioContext = null;
  view.cleanupAgentMedia();
}

export function cleanupAudioWorkletCapture(view: VoiceRealtimeView): void {
  if (view.agentAudioWorklet) {
    view.agentAudioWorklet.port.onmessage = null;
    view.agentAudioWorklet.disconnect();
  }
  view.agentAudioWorklet = null;
}

export function floatTo16kPcm(input: Float32Array, inputSampleRate: number): Int16Array {
  const outputSampleRate = 16_000;
  const ratio = inputSampleRate / outputSampleRate;
  const length = Math.floor(input.length / ratio);
  const output = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const sourceIndex = Math.floor(index * ratio);
    const sample = Math.max(-1, Math.min(1, input[sourceIndex] ?? 0));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

export function audioRms(input: Float32Array): number {
  if (input.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / input.length);
}

export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const toBase64 = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof toBase64 === "function") return toBase64.call(bytes);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return window.btoa(binary);
}

export function waitForRealtimeFlush(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 260));
}

export function lifeOpsAudioWorkletSource(omniBatch40ms = false): string {
  return `
class LifeOpsPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Standard capture rates have an integral 40ms input size. Rechunk before
    // resampling so quantum-local flooring cannot lose fractional output.
    this.batchFrames = ${omniBatch40ms} && [16000, 44100, 48000].includes(sampleRate) ? sampleRate / 25 : 0;
    this.pending = this.batchFrames ? new Float32Array(this.batchFrames) : null;
    this.pendingFrames = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      if (!this.batchFrames) {
        const copy = new Float32Array(channel.length);
        copy.set(channel);
        this.port.postMessage(copy, [copy.buffer]);
      } else {
        let offset = 0;
        while (offset < channel.length) {
          const count = Math.min(channel.length - offset, this.batchFrames - this.pendingFrames);
          this.pending.set(channel.subarray(offset, offset + count), this.pendingFrames);
          this.pendingFrames += count;
          offset += count;
          if (this.pendingFrames === this.batchFrames) {
            const full = this.pending;
            this.pending = new Float32Array(this.batchFrames);
            this.pendingFrames = 0;
            this.port.postMessage(full, [full.buffer]);
          }
        }
      }
    }
    return true;
  }
}

registerProcessor("lifeops-pcm-capture", LifeOpsPcmCaptureProcessor);
`;
}

export function base64ToPcm16(base64Audio: string): Int16Array {
  if (!base64Audio) return new Int16Array();
  const binary = window.atob(base64Audio);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

function prepareVoiceRuntimeForStart(view: VoiceRealtimeView): void {
  const runtime = view.agentVoiceRuntime;
  if (!runtime) return;
  view.agentVoiceBargeIn?.reset?.("voice_runtime_restarted");
  if (runtime.snapshot().sessionPhase !== "stopped") runtime.stop();
  runtime.connect();
}

function markVoiceRuntimeConnected(view: VoiceRealtimeView): void {
  const runtime = view.agentVoiceRuntime;
  if (!runtime) return;
  const phase = runtime.snapshot().sessionPhase;
  if (phase === "connecting") runtime.connected();
  else if (phase === "recovering") runtime.recovered();
}

export function handleOmniE2eSpeechStarted(view: VoiceRealtimeView): void {
  if (!view.agentVoiceSystemSpeechActive) suspectOmniInterruption(view, shouldQueueOmniPostPlaybackInput(view));
}

export function observeOmniE2eBargeInTranscript(view: VoiceRealtimeView, text: string): void {
  observeOmniInterruption(view, text, shouldQueueOmniPostPlaybackInput(view));
}

export function handleOmniE2eBargeInEvent(view: VoiceRealtimeView, event: VoiceBargeInEvent): void {
  applyOmniBargeInEvent(view, event, reason => interruptManagedVoiceTurn(view, reason));
}

function beginManagedVoiceTurn(
  view: VoiceRealtimeView,
  transcript: string,
  route: VoiceRuntimeTurnRoute
): {
  generation: number;
  turnId: string;
} | null {
  const runtime = view.agentVoiceRuntime;
  if (!runtime) return null;
  if (runtime.snapshot().sessionPhase !== "listening") return null;
  try {
    const turn = runtime.beginTurn({
      route,
      transcript
    });
    runtime.transitionTurn("endpointing", "turn.endpoint.confirmed");
    runtime.transitionTurn("routing", `turn.route.${route}`);
    runtime.transitionTurn("generating", "turn.response.requested");
    turn.abortController.signal.addEventListener("abort", () => {
      const settled = runtime.snapshot().currentTurn;
      if (!settled || settled.turnId !== turn.turnId || settled.generation !== turn.generation) return;
      if (settled.phase === "interrupted" && settled.route === "e2e") {
        view.agentRealtimeClient?.cancelResponse();
      }
      if (settled.phase === "interrupted" || settled.phase === "failed") {
        if (settled.playbackId) {
          view.agentAudioOutput?.cancel?.(settled.playbackId, settled.terminalReason || settled.phase);
        }
        view.agentOmniPendingAudio = [];
        retireOmniPlaybackDrain(view);
        view.agentOmniPlaybackReady = null;
      }
    }, { once: true });
    return {
      generation: turn.generation,
      turnId: turn.turnId
    };
  } catch {
    return null;
  }
}

function checkOmniContextSources(view: VoiceRealtimeView): Promise<boolean> {
  return checkActiveOmniSources(view, () => captureVoicePresentationGuard(view),
    () => failOmniToolContext(view, CONTEXT_CHANGED_MESSAGE));
}

const {
  ensureBufferedPlayback: ensureOmniPlayback,
  finishBufferedPlaybackWhenReady: finishOmniPlaybackWhenReady,
  retirePlaybackDrain: retireOmniPlaybackDrain
} = createBufferedVoicePlayback({
  capturePresentation: captureVoicePresentationGuard,
  checkSources: checkOmniContextSources,
  nativePlaybackBlocked: view => Boolean(projectProposalFailure(view)),
  sourceChanged: view => failOmniToolContext(view, CONTEXT_CHANGED_MESSAGE)
});

async function settleOmniAfterPlaybackEvent(view: VoiceRealtimeView): Promise<void> {
  const current = view.agentVoiceRuntime?.snapshot().currentTurn;
  if (!current?.modelDone || !current.playbackDrained) return;
  const reply = (
    current.assistantText
    || view.agentOmniE2eReply
    || "我听到了，但这次没有生成稳定的文字回复。"
  ).trim();
  await settleManagedVoiceTurn(view, reply);
}

async function sendRoutedLifeOpsVoiceTurn(
  view: VoiceRealtimeView,
  message: string,
  route: Extract<VoiceRuntimeTurnRoute, "brain" | "action">
): Promise<void> {
  const isCurrent = captureVoicePresentationGuard(view);
  if (!isCurrent()) return;
  const history = view.agentMessages.slice(0, -2).slice(-6);
  const runtime: VoiceSessionController | undefined = view.agentVoiceRuntime;
  const snapshot = runtime?.snapshot();
  const turn = snapshot?.currentTurn;
  const voiceSettings = view.controller.settings.realtimeVoice as RealtimeVoiceSettings;
  const cascade = !isOmniE2eRealtimeMode(voiceSettings);
  const speechParts = turn && voiceSettings.speakReplies && voiceSettings.ttsEngine === "breeze-local"
    && cascade && sessionBreeze(view) ? new VoiceSpeechParts() : undefined;
  let earlyPlayback: Promise<void> | undefined;
  const providerTraceId = randomUUID();
  if (turn && snapshot) runtime?.eventJournal().record({ timestamp: Date.now(), sessionId: snapshot.sessionId,
    generation: turn.generation, turnId: turn.turnId, providerTraceId, route,
    eventType: "provider.voice_response.requested", stateBefore: "provider.pending", stateAfter: "provider.pending" });
  const options = {
    source: "voice" as const,
    signal: turn?.abortController.signal,
    providerTraceId,
    ...(cascade ? { deferConversation: true, voiceJobs: view.agentRecording && view.agentVoiceConversation ? managedVoiceJobs(view) : undefined } : {}),
    ...(speechParts ? { onVoiceText: (delta: string) => {
      if (!isCurrent() || view.voiceSession.inputQueue.length || view.agentMode !== "voice") return;
      speechParts.push(delta);
      earlyPlayback ??= startFallbackTtsForActiveTurn(view, "", `${route}_streaming_output`, { stream: speechParts });
      void earlyPlayback.catch(() => undefined);
    } } : {})
  };
  try {
    const response = view.controller.submitAgentMessageStream
      ? await view.controller.submitAgentMessageStream(
        message,
        history,
        (content: string) => {
          if (isCurrent() && content.trim()) updateManagedAssistantText(view, content);
        },
        options
      )
      : await view.controller.submitAgentMessage(message, history, options);
    if (!isCurrent()) return;
    let reply = (
      response.reply
      || view.agentOmniE2eReply
      || (route === "action" ? "这项操作没有生成可执行结果。" : "这次没有生成稳定的分析结果。")
    ).trim();
    if (response.actions.length > 0) {
      const merged = mergePendingAgentActions(view.pendingAgentActions, response.actions);
      view.pendingAgentActions = merged.actions;
      if (merged.conflictingIds.length) new Notice(PENDING_ACTION_CONFLICT_NOTICE);
      view.agentOmniE2eActionSuggestions = response.actions.length;
      view.refreshAgentSuggestions();
      if (cascade && turn && view.agentRecording && view.agentVoiceConversation && voiceSettings.speakReplies
        && response.actions.length === 1 && view.pendingAgentActions.includes(response.actions[0])) {
        const action = response.actions[0], prompt = voiceActionPrompt(action);
        if (prompt) {
          reply = prompt;
          voiceConfirmations.set(view, { turnId: turn.turnId, action, played: false });
        }
      }
    }
    updateManagedAssistantText(view, reply);
    attachVoiceWriteReceipts(view, response.receipts);
    retainOrdinaryMainResponse(view,response,reply);
    if (isOmniE2eRealtimeMode(view.controller.settings.realtimeVoice)) {
      view.agentRealtimeClient?.appendAssistantMessage?.(reply);
    }
    view.markVoiceTrace("modelDone");
    view.agentVoiceRuntime?.markModelDone?.();
    if (earlyPlayback) {
      speechParts?.finish(reply);
      await earlyPlayback;
      return;
    }
    const shouldSpeak = Boolean(
      view.controller.settings.realtimeVoice.speakReplies
      && view.voiceSession.inputQueue.length === 0
    );
    if (shouldSpeak && view.agentMode === "voice") {
      await startFallbackTtsForActiveTurn(view, reply, `${route}_route_output`);
      return;
    }
    await settleManagedVoiceTurn(view, reply, {
      persistConversation: cascade
    });
  } catch (error) {
    if (!isCurrent() || turn?.abortController.signal.aborted) return;
    if (cascade && error instanceof ProviderRunFailure && error.code === "network") {
      const reply = "已收到这句语音，文字模型暂时连不上。可以稍后再问。";
      const playbackId = runtime?.snapshot().currentTurn?.playbackId;
      updateManagedAssistantText(view, reply);
      failOmniE2eVoiceTurn(view, reply, undefined, "text_model_network");
      if (playbackId) view.agentAudioOutput?.cancel?.(playbackId, "text_model_network");
      view.agentTtsClient?.cancel?.();
      view.agentTtsClient = null;
      return;
    }
    failOmniE2eVoiceTurn(
      view,
      error instanceof Error ? error.message : "LifeOps 文本主脑处理失败。"
    );
  } finally {
    speechParts?.finish("");
  }
}

function failOmniE2eVoiceTurn(
  view: VoiceRealtimeView,
  message: string,
  response?: BailianRealtimeResponseEvent,
  errorCode = "realtime_response_failed"
): void {
  const isOmni = isOmniE2eRealtimeMode(view.controller.settings.realtimeVoice);
  if (isOmni && response && !acceptsOmniRuntimeEvent(view.agentVoiceRuntime, response)) return;
  retireModelTerminal(view);
  clearVoiceRecoveryTimers(view);
  const runtime = view.agentVoiceRuntime;
  const current = runtime?.snapshot().currentTurn;
  if (current && current.phase !== "completed" && current.phase !== "interrupted" && current.phase !== "failed") {
    settleJobPlayback(view, current.turnId, false);
    runtime.fail(errorCode);
  }
  view.agentVoiceBargeIn?.reset?.("turn_failed");
  view.agentVoiceSendInFlight = false;
  view.agentOmniPendingAudio = [];
  retireOmniPlaybackDrain(view);
  view.agentOmniPlaybackReady = null;
  view.setAgentBusy?.(false);
  view.agentSpeaking = false;
  view.agentReply = errorCode === "text_model_network" ? message : `百炼实时语音错误：${message}`;
  if (view.agentRecording) {
    view.transitionVoiceSession?.("listening", "realtime response failed");
  } else {
    view.transitionVoiceSession?.("error", "realtime response failed");
  }
  view.refreshAgentSurfaceState?.();
}

function failOmniToolContext(view: VoiceRealtimeView, message: string): void {
  withdrawOmniContext(view, message, () => updateManagedAssistantText(view, message),
    () => failOmniE2eVoiceTurn(view, message), stopBailianRealtimeRecording);
}

export function handleRealtimeDisconnect(view: VoiceRealtimeView, code: number, reason: string): void {
  if (!shouldReconnectVoice(view)) return;
  if (view.agentVoiceReconnectTimer) return;
  if (reason === UNCONFIRMED_VOICE_CANCEL_MESSAGE) {
    const text = view.agentVoiceRuntime?.snapshot().currentTurn?.transcript || view.agentOmniE2eUserMessage;
    clearCancelledVoiceInput(view);
    if (text?.trim() && view.agentRealtimeClient) cancelledVoiceInputs.set(view, {text, client: view.agentRealtimeClient});
    // Reconnect status replaces agentReply. Keep the lost-turn explanation in
    // the visible conversation without persisting it as a successful answer.
    const index = view.agentOmniE2eAssistantIndex;
    if (index >= 0 && view.agentMessages[index]?.role === "assistant") {
      const messages = view.agentMessages.slice();
      messages[index] = {role: "assistant", content: reason};
      view.agentMessages = messages.slice(-12);
      if (view.agentOmniE2eStreamMessageEl) view.setAgentMessageBubbleContent(view.agentOmniE2eStreamMessageEl, reason);
    } else {
      view.agentMessages = [...view.agentMessages, {role: "assistant", content: reason}].slice(-12);
      view.appendAgentMessage?.({role: "assistant", content: reason});
    }
    new Notice(reason, 10_000);
  }
  const runtime = view.agentVoiceRuntime;
  const disconnectedTurn = runtime?.snapshot().currentTurn;
  settleJobPlayback(view, disconnectedTurn?.turnId, false);
  if (
    disconnectedTurn?.route === "e2e"
    && !["completed", "interrupted", "failed"].includes(disconnectedTurn.phase)
  ) {
    view.agentVoiceCircuitBreaker?.recordFailure?.(`socket_closed_${code}`);
  }
  const phase = runtime?.snapshot().sessionPhase;
  if (runtime && (phase === "connecting" || phase === "listening")) {
    runtime.reconnect(`socket_closed_${code}`);
  }
  view.agentVoiceBargeIn?.reset?.("socket_disconnected");
  const playbackId = runtime?.snapshot().currentTurn?.playbackId;
  if (playbackId) view.agentAudioOutput?.cancel?.(playbackId, "socket_disconnected");
  view.agentVoiceSendInFlight = false;
  clearVoiceRecoveryTimers(view);
  view.agentTtsClient?.cancel?.();
  view.agentTtsClient = null;
  view.agentOmniPendingAudio = [];
  retireOmniPlaybackDrain(view);
  view.agentOmniPlaybackReady = null;
  view.agentVoiceFallbackReason = "";
  view.agentRealtimeClient = null;
  cleanupRealtimeAudio(view);
  view.setAgentBusy?.(false);
  view.agentSpeaking = false;
  view.transitionVoiceSession?.("error", `realtime socket closed: ${code}`);
  view.agentReply = `语音连接中断，正在准备重连：${reason}`;
  view.refreshAgentSurfaceState?.();
  scheduleVoiceReconnect(view, `socket_closed_${code}`);
}

function updateManagedAssistantText(view: VoiceRealtimeView, text: string): void {
  if (!hasActiveVoiceRuntimeTurn(view) || view.agentOmniE2eAssistantIndex < 0) return;
  if (!text.trim()) return;
  view.agentVoiceRuntime?.updateAssistantText?.(text);
  if (!view.agentVoiceTrace.modelFirstText) {
    view.markVoiceTrace("modelFirstText");
  }
  view.agentOmniE2eReply = text;
  view.agentReply = text;
  const assistantIndex = view.agentOmniE2eAssistantIndex;
  if (assistantIndex >= 0 && view.agentMessages[assistantIndex]?.role === "assistant") {
    const next = view.agentMessages.slice();
    next[assistantIndex] = { ...next[assistantIndex], role: "assistant", content: text };
    view.agentMessages = next;
  }
  const bubble = view.agentOmniE2eStreamMessageEl;
  if (bubble) {
    view.setAgentMessageBubbleContent(bubble, text);
    renderWriteReceipts(bubble, view.agentMessages[assistantIndex]?.receipts, view.controller.undoStewardOperation?.bind(view.controller), view.controller.openTradeEditModal?.bind(view.controller));
    view.scrollAgentTranscriptToBottom();
  }
  view.refreshAgentSurfaceState();
}

type ManagedVoiceSettlement = {
  runtime: VoiceSessionController | undefined;
  turnId: string | undefined;
  current: () => boolean;
  promise: Promise<void>;
};
const voiceTurnSettlements = new WeakMap<object, ManagedVoiceSettlement>();

export function shouldQueueOmniPostPlaybackInput(view: VoiceRealtimeView): boolean {
  const settings = view.controller.settings.realtimeVoice;
  if (!settings || !isOmniE2eRealtimeMode(settings)) return false;
  const settlement = voiceTurnSettlements.get(view), terminal = currentOmniModelTerminal(view);
  const held = settlement?.current() ? settlement : terminal?.queueable ? terminal : undefined;
  return canQueueAfterNativePlayback(view, terminal?.queueable === true, held?.runtime);
}

async function settleManagedVoiceTurn(
  view: VoiceRealtimeView,
  reply: string,
  options: { persistConversation?: boolean } = {}
): Promise<void> {
  if (view.viewClosed) return;
  const prior = voiceTurnSettlements.get(view);
  if (prior?.current()) return prior.promise;
  const runtime: VoiceSessionController | undefined = view.agentVoiceRuntime;
  const snapshot = runtime?.snapshot();
  const turnId = snapshot?.currentTurn?.turnId;
  const turnGeneration = snapshot?.currentTurn?.generation;
  const sessionId = snapshot?.sessionId;
  const viewGeneration = view.agentTextRequestGeneration ?? 0;
  const pipelineGeneration = view.agentVoicePipelineGeneration ?? 0;
  const startGeneration = view.agentRealtimeStartGeneration ?? 0;
  const current = () => !view.viewClosed && view.agentVoiceRuntime === runtime
    && (view.agentTextRequestGeneration ?? 0) === viewGeneration
    && (view.agentVoicePipelineGeneration ?? 0) === pipelineGeneration
    && (view.agentRealtimeStartGeneration ?? 0) === startGeneration
    && (!runtime || runtime.snapshot().sessionId === sessionId
      && runtime.snapshot().currentTurn?.turnId === turnId
      && runtime.snapshot().currentTurn?.generation === turnGeneration
      && runtime.snapshot().currentTurn?.phase !== "interrupted"
      && runtime.snapshot().currentTurn?.phase !== "failed");
  const held: ManagedVoiceSettlement = { runtime, turnId, current, promise: Promise.resolve() };
  voiceTurnSettlements.set(view, held);
  held.promise = Promise.resolve().then(() => settleOwnedVoiceTurn(view, reply, options, held));
  try { await held.promise; }
  finally {
    if (voiceTurnSettlements.get(view) === held) voiceTurnSettlements.delete(view);
    if (held.current()) maybeAnnounceVoiceJob(view);
  }
}

async function settleOwnedVoiceTurn(
  view: VoiceRealtimeView,
  reply: string,
  options: { persistConversation?: boolean },
  held: ManagedVoiceSettlement
): Promise<void> {
  if (!held.current()) return;
  const mainResponse = ordinaryMainResponseForActiveTurn(view,reply);
  if(mainResponse && agentConversationAlreadyAppended(mainResponse,view.controller.store,view.agentOmniE2eUserMessage||"（语音输入）",reply)){
    options={persistConversation:false};
  }
  const runtime = held.runtime;
  // Completion aborts the transport signal, so retain the captured owner rather
  // than requiring an active turn while persistence and presentation finish.
  const isCurrent = held.current;
  const historyResponse = ordinaryMainResponseForActiveTurn(view, reply);
  const announcement = jobPlayback.get(view)?.turnId === held.turnId && Boolean(held.turnId);
  const playback = runtime?.snapshot().currentTurn;
  const pending = voiceConfirmations.get(view);
  if (pending && pending.turnId === held.turnId && !pending.played) voiceConfirmations.delete(view);
  if (runtime && !runtime.complete("model_and_playback_done")) return;
  if (announcement) settleJobPlayback(view, held.turnId, Boolean(playback?.playbackDrained && playback.outputOwner !== "none"));
  if (runtime) ordinaryMainResponses.delete(runtime);
  view.agentVoiceBargeIn?.reset?.("turn_completed");
  clearVoiceRecoveryTimers(view);
  view.agentTtsClient?.cancel?.();
  view.agentTtsClient = null;
  view.agentVoiceFallbackReason = "";
  const assistantIndex = view.agentOmniE2eAssistantIndex;
  if (assistantIndex >= 0 && view.agentMessages[assistantIndex]?.role === "assistant") {
    const next = view.agentMessages.slice();
    next[assistantIndex] = { ...next[assistantIndex], content: reply };
    if (historyResponse) bindAgentHistoryResponse(historyResponse, next[assistantIndex - 1], next[assistantIndex]);
    view.agentMessages = next.slice(-12);
  }
  if (view.agentOmniE2eStreamMessageEl) {
    view.setAgentMessageBubbleContent(view.agentOmniE2eStreamMessageEl, reply);
  }
  view.agentReply = reply;
  view.agentOmniE2eReply = reply;
  view.agentOmniE2eAssistantIndex = -1;
  view.agentOmniE2eStreamMessageEl = null;
  view.agentVoiceSendInFlight = false;
  view.agentOmniPendingAudio = [];
  retireOmniPlaybackDrain(view);
  view.agentOmniPlaybackReady = null;
  view.setAgentBusy(false);
  if (!view.agentRecording) {
    runtime?.stop();
    view.agentRealtimeClient?.close();
    view.agentRealtimeClient = null;
  }
  if (view.pendingAgentActions.length > 0) {
    view.refreshAgentSuggestions();
  }
  if (!announcement && options.persistConversation !== false) {
    const user = view.agentOmniE2eUserMessage || "（语音输入）";
    if (!isOmniE2eRealtimeMode(view.controller.settings.realtimeVoice)) await persistCascadeVoiceTurn(view, user, reply, historyResponse);
    else await view.controller.appendAgentConversation?.(user, reply, isCurrent).catch(() => undefined);
  }
  if (!isCurrent()) return;
  await view.appendAgentQualityLog("voice", view.agentOmniE2eActionSuggestions || 0);
  if (!isCurrent()) return;
  view.refreshAgentSurfaceState();
  if (view.voiceSession.inputQueue.length > 0) {
    await view.consumeQueuedVoiceInput();
    return;
  }
  if (view.currentVoiceMessageText()) {
    view.clearVoiceAutoSendTimer();
    if (view.agentMode === "voice" && view.agentVoiceConversation) {
      view.scheduleVoiceAutoSend();
    }
  } else {
    view.resetCurrentVoiceTurnDraft();
  }
  if (!view.agentRecording) {
    view.transitionVoiceSession("idle", "omni-e2e response done after manual stop");
  } else {
    view.transitionVoiceSession("listening", "omni-e2e response done");
  }
}

async function persistCascadeVoiceTurn(view: VoiceRealtimeView, user: string, reply: string, response?: AgentResponse,
  event?: { date: string; current: () => boolean }): Promise<void> {
  const controller = view.controller;
  const store: StoreHost | undefined = controller.store;
  const revision = controller.savedVoiceSettingsRevision;
  const date = event?.date ?? todayString();
  const path = store?.path(store.settings.folders.aiReports, "Conversations", `${date}.md`);
  const current = () => (event?.current() ?? !view.viewClosed) && !controller.unloaded && controller.store === store
    && controller.savedVoiceSettingsRevision === revision
    && (!path || !isVaultPathExcluded(path, store?.settings.privacy?.excludedVaultPrefixes));
  if (!current()) return;
  try {
    if (!store) { await controller.appendAgentConversation?.(user, reply, current); return; }
    await store.appendAgentConversation(user, reply, date, current);
    if (response && current()) retainAgentConversationAppend(store, response, user);
  } catch { if (current()) new Notice("语音对话记录暂未保存。"); }
}

export function handleOmniE2eAudioOutputEvent(
  view: VoiceRealtimeView,
  event: AudioOutputEvent
): void {
  const runtime = view.agentVoiceRuntime;
  if (!runtime) return;
  const current = runtime.snapshot().currentTurn;
  if (!current || !runtime.accepts({
    generation: current.generation,
    turnId: current.turnId,
    playbackId: event.playbackId
  })) {
    return;
  }
  if (event.owner !== current.outputOwner) return;
  const engine = fallbackTtsEngines.get(runtime);
  const isBreezeFallback = (engine?.engine === "breeze-local" || engine?.engine === "breeze-blue") && engine.turnId === current.turnId && engine.generation === current.generation;

  if (event.type === "cue") {
    const cues = pendingSpeakerCues.get(view);
    const phrase = event.cue ? cues?.get(event.cue) : undefined;
    if (phrase && event.cue) {
      cues?.delete(event.cue);
      if (!phrase.completed) recordSpeakerPhrase(view, phrase.text);
      rememberHeardPhrase(view, phrase.text, phrase.completed);
    }
    return;
  }
  if (event.type === "started") {
    if (!view.agentVoiceTrace.ttsFirstAudio) view.markVoiceTrace("ttsFirstAudio");
    const latency = view.agentVoiceTrace.latency;
    if (latency?.t4 !== undefined && markVoiceLatency(latency, "t5")) view.appendVoiceMetric?.("voice_latency_sample");
    const phase = runtime.snapshot().currentTurn?.phase;
    if (phase === "generating" || phase === "synthesizing") {
      runtime.transitionTurn("playing", "turn.playback.started");
    }
    view.agentSpeaking = true;
    view.transitionVoiceSession("speaking", "omni-e2e playback started");
    view.refreshAgentSurfaceState();
    return;
  }

  if (
    event.type === "first-audio-timeout"
    || event.type === "drain-timeout"
    || event.type === "context-suspended"
    || event.type === "failed"
  ) {
    const terminal=currentOmniModelTerminal(view);if(terminal)terminal.queueable=false;
    if (event.owner === "fallback-tts" && isBreezeFallback && current.phase === "playing") {
      view.agentTtsClient?.cancel?.();
      view.agentTtsClient = null;
      runtime.selectOutputOwner("none");
      view.agentAudioOutput.cancel(event.playbackId, "local_tts_partial_failure");
      retireOmniPlaybackDrain(view);
      view.agentOmniPendingAudio = [];
      view.agentOmniPlaybackReady = null;
      view.agentSpeaking = false;
      runtime.markPlaybackDrained();
      new Notice(engine?.engine === "breeze-local" ? "本地语音未完整播放，完整回复仍可查看文字。" : "语音未完整播放，完整回复仍可查看文字。");
      const reply = (current.assistantText || view.agentOmniE2eReply).trim();
      if (current.modelDone && reply) void settleManagedVoiceTurn(view, reply);
      return;
    }
    retireOmniPlaybackDrain(view);
    view.agentVoiceFallbackReason = event.errorCode || event.type;
    if (event.owner === "fallback-tts") {
      runtime.selectOutputOwner("system");
    }
    view.agentAudioOutput.cancel(event.playbackId, event.errorCode || event.type);
    view.agentSpeaking = false;
    view.agentReply = event.owner === "native-e2e"
      ? "原生语音输出没有成功，正在切换备用语音通道..."
      : "备用语音输出没有成功，正在切换系统朗读...";
    view.refreshAgentSurfaceState();
    const reply = (current.assistantText || view.agentOmniE2eReply).trim();
    if (current.modelDone && reply) {
      if (event.owner === "native-e2e") {
        void startFallbackTtsForActiveTurn(view, reply, view.agentVoiceFallbackReason);
      } else {
        startSystemSpeechForActiveTurn(view, reply, view.agentVoiceFallbackReason);
      }
    }
    return;
  }

  if (event.type === "drained") {
    const pending = voiceConfirmations.get(view);
    if (pending && pending.turnId === current.turnId && !activeCascadeCapture.get(view)?.awaitingTranscript) pending.played = true;
    pendingSpeakerCues.delete(view);
    finishHeardSpeech(view);
    retireOmniPlaybackDrain(view);
    runtime.markPlaybackDrained();
    view.markVoiceTrace("ttsDone");
    view.agentSpeaking = false;
    view.refreshAgentSurfaceState();
    void settleOmniAfterPlaybackEvent(view);
    return;
  }

  if (event.type === "cancelled") {
    if (event.owner === "fallback-tts" && isBreezeFallback && current.phase === "playing") {
      view.agentTtsClient?.cancel?.();
      view.agentTtsClient = null;
      runtime.selectOutputOwner("none");
      retireOmniPlaybackDrain(view);
      view.agentOmniPendingAudio = [];
      view.agentOmniPlaybackReady = null;
      view.agentSpeaking = false;
      runtime.markPlaybackDrained();
      new Notice(engine?.engine === "breeze-local" ? "本地语音未完整播放，完整回复仍可查看文字。" : "语音未完整播放，完整回复仍可查看文字。");
      const reply = (current.assistantText || view.agentOmniE2eReply).trim();
      if (current.modelDone && reply) void settleManagedVoiceTurn(view, reply);
      return;
    }
    retireOmniPlaybackDrain(view);
    view.agentSpeaking = false;
    view.refreshAgentSurfaceState();
    if (current.modelDone) {
      const reply = (current.assistantText || view.agentOmniE2eReply).trim();
      if (reply && event.owner === "native-e2e") {
        void startFallbackTtsForActiveTurn(view, reply, event.errorCode || "native_playback_cancelled");
      } else if (reply && event.owner === "fallback-tts") {
        startSystemSpeechForActiveTurn(view, reply, event.errorCode || "fallback_playback_cancelled");
      }
    }
  }
}

function retainOrdinaryMainResponse(view: VoiceRealtimeView, response: AgentResponse, reply: string): void {
  const runtime = view.agentVoiceRuntime, current = runtime?.snapshot().currentTurn;
  if (!runtime) return;
  ordinaryMainResponses.delete(runtime);
  const store = view.controller.store, vault = store?.app?.vault;
  if (!current || !hasActiveVoiceRuntimeTurn(view)
    || !store || !vault || response.reply !== reply) return;
  ordinaryMainResponses.set(runtime,{turnId:current.turnId,generation:current.generation,
    store,vault,response,reply});
}

function ordinaryMainResponseForActiveTurn(view: VoiceRealtimeView, text: string): AgentResponse | undefined {
  const runtime = view.agentVoiceRuntime, current = runtime?.snapshot().currentTurn;
  const held = runtime && ordinaryMainResponses.get(runtime);
  if (!held || !current || !hasActiveVoiceRuntimeTurn(view) || current.turnId !== held.turnId
    || current.generation !== held.generation || current.assistantText !== held.reply
    || view.controller.store !== held.store || view.controller.store?.app?.vault !== held.vault
    || text !== held.reply || held.response.reply !== held.reply) return;
  return held.response;
}

function speechForActiveTurn(view: VoiceRealtimeView, text: string): string {
  const response = ordinaryMainResponseForActiveTurn(view,text);
  return response ? response.voiceSpeech || committedTaskSpeechForResponse(view.controller.store,response,text) : text;
}

async function startFallbackTtsForActiveTurn(
  view: VoiceRealtimeView,
  text: string,
  reason: string,
  delivery: { stream?: VoiceSpeechParts; useCloud?: true; prefix?: string } = {}
): Promise<void> {
  const { stream } = delivery;
  const runtime = view.agentVoiceRuntime;
  const current = runtime?.snapshot().currentTurn;
  const reply = (delivery.prefix ?? "") + cleanVoiceReplyForSpeech(speechForActiveTurn(view, text));
  if (!runtime || !current || (!reply && !stream) || !hasActiveVoiceRuntimeTurn(view)) return;
  if(view.agentRealtimeClient?.hasProtectedContextSources?.()){
    if(await checkOmniContextSources(view))await settleManagedVoiceTurn(view,text);
    return;
  }
  if (current.outputOwner === "fallback-tts" || current.outputOwner === "system") return;
  if (!view.controller.settings.realtimeVoice.speakReplies) {
    await settleManagedVoiceTurn(view, text);
    return;
  }

  const ttsSettings = { ...view.controller.settings.realtimeVoice };
  if (delivery.useCloud) ttsSettings.ttsEngine = "bailian";
  if (ttsSettings.ttsEngine === "breeze-blue" && view.agentRealtimeClient?.hasProtectedContextSources?.()) {
    ttsSettings.ttsEngine = "breeze-local";
  }
  const isLocal = ttsSettings.ttsEngine === "breeze-local";
  const isBreeze = isLocal || ttsSettings.ttsEngine === "breeze-blue";
  fallbackTtsEngines.set(runtime, { turnId: current.turnId, generation: current.generation, engine: ttsSettings.ttsEngine });
  runtime.selectOutputOwner("fallback-tts");
  const playbackId = runtime.snapshot().currentTurn?.playbackId
    || `${current.turnId}-output-${current.generation}`;
  if (!runtime.snapshot().currentTurn?.playbackId) runtime.bindPlayback(playbackId);
  view.agentVoiceFallbackReason = reason;
  view.agentAudioOutput?.cancel?.(playbackId, "switch_to_fallback_tts");
  retireOmniPlaybackDrain(view);
  view.agentOmniPlaybackReady = null;
  view.agentOmniPendingAudio = [];
  const cues = new Map<string, SpeakerCue>();
  pendingSpeakerCues.set(view, cues);
  beginHeardSpeech(view);
  view.agentTtsClient?.cancel?.();
  clearVoiceFallbackTimer(view);
  let gotAudio = false;
  let fallbackPending = false;
  let pendingPhrase = reply;

  const isCurrentFallback = (): boolean => {
    const latest = runtime.snapshot().currentTurn;
    return Boolean(
      latest
      && latest.turnId === current.turnId
      && latest.generation === current.generation
      && latest.outputOwner === "fallback-tts"
      && hasActiveVoiceRuntimeTurn(view)
    );
  };
  const playFallback = (finalText: string, fallbackReason: string): void => {
    if (!isCurrentFallback() || !finalText.trim()) return;
    if (gotAudio && isBreeze) {
      view.agentTtsClient?.cancel?.();
      view.agentTtsClient = null;
      runtime.selectOutputOwner("none");
      view.agentAudioOutput?.cancel?.(playbackId, "local_tts_partial_failure");
      retireOmniPlaybackDrain(view);
      view.agentOmniPendingAudio = [];
      view.agentOmniPlaybackReady = null;
      view.agentSpeaking = false;
      runtime.markPlaybackDrained();
      new Notice(isLocal ? "本地语音未完整播放，完整回复仍可查看文字。" : "语音未完整播放，完整回复仍可查看文字。");
      void settleManagedVoiceTurn(view, finalText);
      return;
    }
    view.agentTtsClient?.cancel?.(fallbackReason === "fallback_tts_first_audio_timeout" ? "timeout" : undefined);
    view.agentTtsClient = null;
    const prefix = isLocal ? "本地声音出问题了，先用备用声音。" : delivery.prefix;
    const cloud = isLocal && ttsSettings.localTtsFallback === "bailian" && ttsSettings.dataDisclosureAccepted === true;
    runtime.selectOutputOwner(cloud ? "none" : "system");
    view.agentAudioOutput?.cancel?.(playbackId, fallbackReason);
    if (cloud) {
      void startFallbackTtsForActiveTurn(view, finalText, fallbackReason, { useCloud: true, prefix });
      return;
    }
    startSystemSpeechForActiveTurn(view, finalText, fallbackReason, prefix);
  };
  const fallbackToSystem = (fallbackReason: string): void => {
    if (!isCurrentFallback() || fallbackPending) return;
    fallbackPending = true;
    clearVoiceFallbackTimer(view);
    if (stream) void stream.finalText.then(finalText => playFallback(finalText, fallbackReason)).catch(() => undefined);
    else playFallback(text, fallbackReason);
  };

  try {
    const client = createTtsClient(ttsSettings, {
      onOpen: () => {
        if (!isCurrentFallback()) return;
        if (isLocal) markVoiceLatency(view.agentVoiceTrace?.latency, "t3");
        clearVoiceFallbackTimer(view);
        view.agentVoiceFallbackTimer = window.setTimeout(() => {
          if (!gotAudio) fallbackToSystem("fallback_tts_first_audio_timeout");
        }, isBreeze ? 90_000 : FALLBACK_TTS_FIRST_AUDIO_TIMEOUT_MS);
        view.agentReply = "正在通过备用语音通道朗读...";
        view.refreshAgentSurfaceState();
      },
      onSentenceAudio: sentence => { pendingPhrase = sentence; },
      onAudioDelta: (base64Audio, sampleRate) => {
        if (!isCurrentFallback()) return;
        const pcm = base64ToPcm16(base64Audio);
        if (pcm.length === 0) return;
        if (isLocal) markVoiceLatency(view.agentVoiceTrace?.latency, "t4");
        gotAudio = true;
        clearVoiceFallbackTimer(view);
        const cue = queueSpeakerCue(cues, pendingPhrase, false);
        pendingPhrase = "";
        view.agentOmniPendingAudio.push({ pcm, sampleRate, ...(cue ? { cue } : {}) });
        void ensureOmniPlayback(view, "fallback-tts");
      },
      onSentenceDone: sentence => {
        if (!isCurrentFallback()) return;
        const cue = queueSpeakerCue(cues, sentence, true);
        if (!cue) return;
        view.agentOmniPendingAudio.push({ pcm: new Int16Array(), sampleRate: 24_000, cue });
        void ensureOmniPlayback(view, "fallback-tts");
      },
      onResponseDone: () => {
        if (!isCurrentFallback()) return;
        clearVoiceFallbackTimer(view);
        view.agentTtsClient = null;
        if (!gotAudio) {
          fallbackToSystem("fallback_tts_empty_audio");
          return;
        }
        finishOmniPlaybackWhenReady(view);
      },
      onError: () => {
        if (!isCurrentFallback()) return;
        fallbackToSystem("fallback_tts_error");
      },
      onProviderRun: event => recordVoiceProviderRun(view, runtime, event)
    }, { sessionId: runtime.snapshot().sessionId, generation: current.generation, turnId: current.turnId }, sessionBreeze(view));
    view.agentTtsClient = client;
    if (stream && client instanceof BreezeResidentTtsClient) await client.speakStream(stream, { signal: current.abortController.signal });
    else await client.speak(reply, { signal: current.abortController.signal });
  } catch (error) {
    fallbackToSystem(error instanceof Error ? error.message : "fallback_tts_start_failed");
  }
}

function queueSpeakerCue(cues: Map<string, SpeakerCue>, text: string, completed: boolean): string | undefined {
  if (!text || cues.size >= 128) return;
  const id = randomUUID();
  cues.set(id, { text, completed });
  return id;
}

export function startSystemSpeechForActiveTurn(
  view: VoiceRealtimeView,
  text: string,
  reason: string,
  prefix = ""
): void {
  const runtime = view.agentVoiceRuntime;
  const current = runtime?.snapshot().currentTurn;
  const reply = cleanVoiceReplyForSpeech(speechForActiveTurn(view, text));
  if (!runtime || !current || !reply || !hasActiveVoiceRuntimeTurn(view)) return;
  if(view.agentRealtimeClient?.hasProtectedContextSources?.()){
    void checkOmniContextSources(view).then(allowed=>allowed?settleManagedVoiceTurn(view,text):undefined);
    return;
  }
  const ownerKey = `${current.generation}:${current.turnId}`;
  if (systemSpeechRecorded.get(runtime) !== ownerKey) {
    systemSpeechRecorded.set(runtime, ownerKey);
    const traceId = randomUUID();
    runtime.eventJournal().record({ timestamp: Date.now(), sessionId: runtime.snapshot().sessionId,
      generation: current.generation, turnId: current.turnId, providerTraceId: traceId,
      eventType: "provider.system_speech.local_fallback", stateBefore: "output.fallback", stateAfter: "output.local" });
    void Promise.resolve(view.controller.appendQualityLog?.({ inputSource: "voice", providerTraceId: traceId,
      providerStage: "system_speech", localFallbackUsed: true, fallbackUsed: true
    })).catch(() => undefined);
  }
  runtime.selectOutputOwner("system");
  clearVoiceFallbackTimer(view);
  view.agentTtsClient?.cancel?.();
  view.agentTtsClient = null;
  retireOmniPlaybackDrain(view);
  view.agentOmniPlaybackReady = null;
  view.agentOmniPendingAudio = [];
  addEchoText(reply, Math.max(12_000, Math.min(90_000, reply.length * 220)), "tts");
  view.agentVoiceSystemSpeechActive = true;
  const presentationIsCurrent = captureVoicePresentationGuard(view);
  const isCurrent = () => presentationIsCurrent() && hasActiveVoiceRuntimeTurn(view);

  const settleSystemSpeech = (completed = false): void => {
    if (!isCurrent()) return;
    const latest = runtime.snapshot().currentTurn;
    if (
      !latest
      || latest.turnId !== current.turnId
      || latest.generation !== current.generation
      || latest.outputOwner !== "system"
    ) return;
    view.agentVoiceSystemSpeechActive = false;
    if (completed) rememberHeardPhrase(view, prefix + reply, true);
    else {
      const job = jobPlayback.get(view);
      if (job && job.turnId === latest.turnId) job.failed = true;
    }
    const pending = voiceConfirmations.get(view);
    if (completed && pending && pending.turnId === latest.turnId && !activeCascadeCapture.get(view)?.awaitingTranscript) pending.played = true;
    runtime.markPlaybackDrained();
    view.agentSpeaking = false;
    view.markVoiceTrace("ttsDone");
    view.refreshAgentSurfaceState();
    void settleOmniAfterPlaybackEvent(view);
  };

  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
    view.agentVoiceSystemSpeechActive = false;
    view.agentReply = `语音输出不可用，已保留文字回复（${reason}）。`;
    settleSystemSpeech();
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(prefix + reply);
  utterance.lang = view.controller.settings.realtimeVoice.language || "zh-CN";
  utterance.rate = 1;
  utterance.pitch = 1;
  view.agentVoiceFallbackTimer = window.setTimeout(() => {
    if (!isCurrent()) return;
    view.agentVoiceSystemSpeechActive = false;
    view.agentReply = "系统朗读没有启动，已保留文字回复。";
    window.speechSynthesis.cancel();
    settleSystemSpeech();
  }, 2_000);
  utterance.onstart = () => {
    if (!isCurrent()) return;
    clearVoiceFallbackTimer(view);
    view.agentSpeaking = true;
    recordSpeakerPhrase(view, prefix + reply);
    beginHeardSpeech(view);
    rememberHeardPhrase(view, prefix + reply, false);
    const latest = runtime.snapshot().currentTurn;
    if (latest?.phase === "generating" || latest?.phase === "synthesizing") {
      runtime.transitionTurn("playing", "turn.system_playback.started");
    }
    view.markVoiceTrace("ttsFirstAudio");
    view.transitionVoiceSession("speaking", "system fallback playback started");
    view.refreshAgentSurfaceState();
  };
  utterance.onend = () => settleSystemSpeech(true);
  utterance.onerror = () => settleSystemSpeech();
  window.speechSynthesis.speak(utterance);
}

export function cleanVoiceReplyForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .trim()
    .slice(0, 900);
}

function clearVoiceFallbackTimer(view: VoiceRealtimeView): void {
  if (view.agentVoiceFallbackTimer) window.clearTimeout(view.agentVoiceFallbackTimer);
  view.agentVoiceFallbackTimer = 0;
}

function clearVoiceRecoveryTimers(view: VoiceRealtimeView): void {
  retireOmniPlaybackDrain(view);
  clearOmniResponseTimer(view);
  clearVoiceFallbackTimer(view);
}

function armOmniResponseTimer(view: VoiceRealtimeView): void {
  armOmniTimer(view, message => { void fallbackOmniResponseToBrain(view, message); });
}

function shouldReconnectVoice(view: VoiceRealtimeView): boolean {
  return Boolean(
    view.agentMode === "voice"
    && view.agentVoiceConversation
    && view.controller.settings.realtimeVoice.provider === "qwen-omni-realtime"
  );
}

function scheduleVoiceReconnect(view: VoiceRealtimeView, reason: string): void {
  if (!shouldReconnectVoice(view) || view.agentVoiceReconnectTimer) return;
  const attempt = view.agentVoiceReconnectAttempts + 1;
  if (attempt > VOICE_RECONNECT_DELAYS_MS.length) {
    clearCancelledVoiceInput(view);
    view.agentRecording = false;
    view.agentVoiceReady = false;
    view.agentVoiceConversation = false;
    clearVoiceReconnectState(view);
    view.agentVoiceRuntime?.stop?.();
    view.transitionVoiceSession?.("error", "realtime reconnect exhausted");
    view.agentReply = "语音连接已断开，自动重连未成功；请点一次麦克风重新连接。";
    view.refreshAgentSurfaceState?.();
    new Notice(view.agentReply);
    return;
  }
  view.agentVoiceReconnectAttempts = attempt;
  const delayMs = VOICE_RECONNECT_DELAYS_MS[attempt - 1];
  view.agentRecording = true;
  view.agentReply = `语音连接中断，正在重连（${attempt}/${VOICE_RECONNECT_DELAYS_MS.length}）…`;
  view.refreshAgentSurfaceState?.();
  void view.controller.appendQualityLog?.({
    inputSource: "voice",
    errorCode: "realtime_reconnect_scheduled",
    errorMessage: `${reason}; attempt=${attempt}; delay=${delayMs}`
  }).catch(() => undefined);
  view.agentVoiceReconnectTimer = window.setTimeout(() => {
    view.agentVoiceReconnectTimer = 0;
    if (!shouldReconnectVoice(view)) return;
    void startBailianRealtimeRecording(view);
  }, delayMs);
}

function clearVoiceReconnectTimer(view: VoiceRealtimeView): void {
  if (view.agentVoiceReconnectTimer) window.clearTimeout(view.agentVoiceReconnectTimer);
  view.agentVoiceReconnectTimer = 0;
}

function clearVoiceReconnectState(view: VoiceRealtimeView): void {
  clearVoiceReconnectTimer(view);
  view.agentVoiceReconnectAttempts = 0;
}

export function hasActiveVoiceRuntimeTurn(view: VoiceRealtimeView): boolean {
  const runtime = view.agentVoiceRuntime;
  if (runtime?.snapshot) {
    const current = runtime.snapshot().currentTurn;
    return Boolean(current && !["completed", "interrupted", "failed"].includes(current.phase));
  }
  return Boolean(view.agentVoiceSendInFlight);
}

function captureVoicePresentationGuard(view: VoiceRealtimeView): () => boolean {
  const viewGeneration = view.agentTextRequestGeneration ?? 0;
  const pipelineGeneration = view.agentVoicePipelineGeneration ?? 0;
  const runtime = view.agentVoiceRuntime;
  const snapshot = runtime?.snapshot?.();
  const turn = snapshot?.currentTurn;
  return () => {
    if (view.viewClosed || (view.agentTextRequestGeneration ?? 0) !== viewGeneration
      || (view.agentVoicePipelineGeneration ?? 0) !== pipelineGeneration
      || view.agentVoiceRuntime !== runtime) return false;
    if (!runtime) return true;
    if (!turn || turn.abortController?.signal.aborted) return false;
    const current = runtime.snapshot();
    return current.sessionId === snapshot.sessionId
      && runtime.accepts({ generation: turn.generation, turnId: turn.turnId });
  };
}

const {
  handleOmniE2eResponseCreated, handleOmniE2eResponseText, handleOmniE2eAudioDelta, handleOmniE2eAudioDone, finishOmniE2eVoiceTurn,
  settleCommittedOmniTool, fallbackOmniResponseToBrain, currentOmniModelTerminal, retireModelTerminal
} = createOmniResponseHandlers({
  isOmniE2eRealtimeMode, hasActiveVoiceRuntimeTurn, armOmniResponseTimer, failOmniE2eVoiceTurn,
  base64ToPcm16, ensureOmniPlayback, finishOmniPlaybackWhenReady, captureVoicePresentationGuard, checkOmniContextSources,
  clearOmniResponseTimer, startSystemSpeechForActiveTurn, settleCompletedOmniE2eVoiceTurn: settleManagedVoiceTurn,
  startFallbackTtsForActiveTurn, updateManagedAssistantText, clearVoiceReconnectState, clearVoiceRecoveryTimers,
  cleanupRealtimeAudio, retireOmniPlaybackDrain, sendRoutedLifeOpsVoiceTurn
});
export {
  handleOmniE2eResponseCreated, handleOmniE2eAudioDelta, handleOmniE2eAudioDone, finishOmniE2eVoiceTurn,
  settleCommittedOmniTool, fallbackOmniResponseToBrain
};

export function executeOmniE2eToolCall(view: VoiceRealtimeView, toolCall: AiToolCall): Promise<string>;
export function executeOmniE2eToolCall(view: VoiceRealtimeView, toolCall: AiToolCall, retainOutput: true): Promise<string | RealtimeToolOutput>;
export function executeOmniE2eToolCall(view: VoiceRealtimeView, toolCall: AiToolCall, retainOutput = false): Promise<string | RealtimeToolOutput> {
  return executeOmniE2eTool(view, toolCall, retainOutput, {
    captureVoicePresentationGuard, retireOmniPlaybackDrain,
    updateManagedAssistantText: handleOmniE2eResponseText, failOmniToolContext
  });
}

const omniSessionHandlers = {
  observeTranscript: observeOmniE2eBargeInTranscript,
  sendVoiceTurn: sendOmniE2eVoiceTurn,
  speechStarted: handleOmniE2eSpeechStarted,
  speechStopped: handleOmniE2eSpeechStopped,
  responseCreated: handleOmniE2eResponseCreated,
  responseText: handleOmniE2eResponseText,
  audioDelta: handleOmniE2eAudioDelta,
  audioDone: handleOmniE2eAudioDone,
  responseDone: finishOmniE2eVoiceTurn,
  responseFailed: fallbackOmniResponseToBrain,
  executeTool: (view: VoiceRealtimeView, call: AiToolCall) => executeOmniE2eToolCall(view, call, true),
  toolContextError: failOmniToolContext,
  toolCommitted: settleCommittedOmniTool,
  stopRecording: stopBailianRealtimeRecording
};
