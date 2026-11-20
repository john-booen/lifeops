import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import { BailianRealtimeClient } from "../bailianRealtime";
import { BailianRealtimeTtsClient } from "../bailianTtsRealtime";
import { createTtsClient } from "../breezeLocalTts";
import { realtimeVoiceReadiness, textAiReadiness } from "../capabilityReadiness";
import { cancelMessageListRequest } from "./messageList";
import { markVoiceLatency, resetVoiceLatencyCapture, takeVoiceLatencyCapture, type VoiceLatency } from "../voice/latency";
import { closeSessionBreeze } from "../voice/breezeSpeech";
import type { AudioOutputActor } from "../voice/audioOutput";
import type { AiToolCall } from "../ai";
import { addDays, todayString, weekDates } from "../date";
import {
  addEchoText,
  clearEchoMemories,
  decideLocalVoiceEndpoint,
  decideVoiceTurnReadiness,
  detectVoiceControlEvent,
  isEchoTranscript,
  isVoiceHoldOnlyTurn,
  mergeVoiceTurnText,
  shouldIgnoreVoiceSpeechStart,
  shouldHoldVoiceTurnForControl,
  shouldSuppressAssistantSpeech,
  shouldInterruptAssistantForTranscript,
  stripVoiceControlPhrases,
  voiceEndpointDelayMs
} from "../voiceSession";
import {
  appendTurnText,
  beginNewTurn,
  canTransition,
  createVoiceSession,
  dequeueInput,
  enqueueInput,
  finalizeTurn,
  isAlreadySent,
  transition
} from "../voiceSession";
import {
  findVoiceTrigger,
  normalizeVoiceTriggerText,
  parseVoiceTriggerPhrases,
  stripVoiceTriggers,
  voiceTranscriptFragments,
  voiceTriggerEnabled,
  voiceTriggerLabel,
  voiceTriggerTimeoutSec
} from "../voice/voiceTrigger";
import {
  base64ToPcm16,
  canRepeatCancelledVoiceInput,
  clearCancelledVoiceInput,
  interruptManagedVoiceTurn,
  hasPendingCascadeTranscript,
  isFreshCascadeTranscript,
  isOmniE2eRealtimeMode,
  sendManagedVoiceTurn,
  shouldQueueOmniPostPlaybackInput,
  sendOmniE2eVoiceTurn,
  startBailianRealtimeRecording as startBailianRealtimeRecordingFlow,
  stopBailianRealtimeRecording as stopBailianRealtimeRecordingFlow
} from "../voice/voiceRealtime";
import type { VoicePhase, VoiceSessionState } from "../voiceSession";
import type { ProactiveCandidate } from "../scheduler";
import type {
  AgentActionSuggestion,
  AgentConversationMessage,
  AgentSubmissionOptions,
  AgentResponse,
  DashboardStats,
  HabitCheckinStatus,
  HabitDefinition,
  LifeOpsSettings,
  LifeOpsTask,
  LifeOpsTaskInput,
  LifeOpsTaskQuadrant,
  QualityLogEntry,
  TaskDashboardData,
  VoiceMetricEntry,
  VisualAnalysisResult
} from "../types";

export const LIFEOPS_VIEW_TYPE = "lifeops-assistant-view";
const AGENT_MESSAGE_TIMEOUT_MS = 30_000;
const AGENT_BUSY_TIMEOUT_MS = 45_000;

type LifeOpsMode = "tasks" | "matrix" | "habits" | "calendar";
type TaskFilter =
  | "today"
  | "overdue"
  | "deadline"
  | "recurring"
  | "next-seven"
  | "tomorrow"
  | "no-date"
  | "completed"
  | "completed-all"
  | "all"
  | "by-project"
  | "by-category"
  | "by-date";

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  [index: number]: { transcript: string };
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type VoiceTraceKey =
  | "recordingStart"
  | "firstTranscript"
  | "transcriptDone"
  | "recordingStopped"
  | "modelStart"
  | "modelFirstText"
  | "modelDone"
  | "ttsStart"
  | "ttsFirstAudio"
  | "ttsDone";

type VoiceTrace = Partial<Record<VoiceTraceKey, number>> & {
  captureMode?: "audio-worklet" | "script-processor" | "fallback-recorder";
  latency?: VoiceLatency;
};

export interface LifeOpsViewController {
  settings: LifeOpsSettings;
  openStewardSettings?(): void;
  openQuickCapture(): void;
  openTaskModal(): void;
  openTaskModalWithDefaults(defaults: Partial<LifeOpsTaskInput>): void;
  openTaskEditModal(task: LifeOpsTask): void;
  openTaskActionsModal(task: LifeOpsTask): void;
  openHabitModal(): void;
  openHabitEditModal(habit: HabitDefinition): void;
  openHabitDetailModal(item: TaskDashboardData["habits"][number]): void;
  openHabitCheckinModal(habit: HabitDefinition, defaults?: { status?: HabitCheckinStatus; date?: string; note?: string }): void;
  openHealthEntryModal(): void;
  openTradeEntryModal(): void;
  openTradeScreenshotImport?(image: File): void;
  openCalendarNoteModal(date: string): void;
  recordHabit(habit: HabitDefinition): Promise<void>;
  recordHabitStatus(habitId: string, status: HabitCheckinStatus, date?: string, note?: string): Promise<void>;
  clearHabitCheckin(habitId: string, date?: string): Promise<void>;
  generateDailyReview(): Promise<void>;
  generateTradingReview(): Promise<void>;
  submitAgentMessage(message: string, history?: AgentConversationMessage[], options?: AgentSubmissionOptions): Promise<AgentResponse>;
  submitAgentMessageStream?(message: string, history?: AgentConversationMessage[], onText?: (content: string) => void, options?: AgentSubmissionOptions): Promise<AgentResponse>;
  executeAgentToolCall(toolCall: AiToolCall, userMessage?: string, assertCurrent?: () => void): Promise<AgentResponse>;
  assertAgentActionDeliverable?(action: AgentActionSuggestion, assertCurrent?: () => void): Promise<void>;
  executeAgentAction(action: AgentActionSuggestion): Promise<void | string>;
  transcribeAgentAudio(audio: Blob, signal?: AbortSignal): Promise<string>;
  appendQualityLog(entry: QualityLogEntry): Promise<void>;
  appendVoiceMetric(entry: VoiceMetricEntry): Promise<void>;
  setAgentSpeakReplies(value: boolean): Promise<void>;
  acceptPunishments(): Promise<void>;
  completeTask(taskId: string, note?: string): Promise<void>;
  completeTaskAndLog(taskId: string, note?: string): Promise<void>;
  abandonTask(taskId: string): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  postponeTask(taskId: string, days: number): Promise<void>;
  postponeTasks(taskIds: string[], days: number): Promise<void>;
  skipRepeatedTask(taskId: string): Promise<void>;
  moveTaskToDate(taskId: string, date: string): Promise<void>;
  duplicateTaskToDate(taskId: string, date: string): Promise<void>;
  moveTaskOrder(taskId: string, direction: "up" | "down"): Promise<void>;
  deleteHabit(habitId: string): Promise<void>;
  moveTaskToQuadrant(taskId: string, quadrant: LifeOpsTaskQuadrant): Promise<void>;
  refreshViews(): Promise<void>;
  getStats(): Promise<DashboardStats>;
  getTaskDashboard(): Promise<TaskDashboardData>;
  getProactiveCandidates(): Promise<ProactiveCandidate[]>;
}
type ViewConstructor = { prototype: object };
interface ViewHost {
  [key: string]: any;
  contentEl: HTMLElement;
  controller: LifeOpsViewController;
  mode: LifeOpsMode;
  taskFilter: TaskFilter;
  taskSearch: string;
  calendarMode: "month" | "week" | "day";
  calendarDate: string;
  selectedCalendarDate: string;
  expandedHabitId: string;
  agentMode: "voice" | "text";
  agentInput: string;
  agentReply: string;
  agentWorkspaceOpen: boolean;
  agentMessages: AgentConversationMessage[];
  agentBusy: boolean;
  agentBusySince: number;
  agentRecording: boolean;
  agentVoiceConversation: boolean;
  pendingAgentActions: AgentActionSuggestion[];
  proactiveCandidates: ProactiveCandidate[];
  agentRecorder: MediaRecorder | null;
  agentStream: MediaStream | null;
  agentAudioChunks: BlobPart[];
  agentTranscriptionAbortController: AbortController | null;
  agentRealtimeClient: BailianRealtimeClient | null;
  agentAudioContext: AudioContext | null;
  agentAudioSource: MediaStreamAudioSourceNode | null;
  agentAudioProcessor: ScriptProcessorNode | null;
  agentAudioWorklet: AudioWorkletNode | null;
  agentInputEl: HTMLTextAreaElement | null;
  agentSpeechRecognition: SpeechRecognitionLike | null;
  agentTtsClient: BailianRealtimeTtsClient | null;
  agentSpeechAudioContext: AudioContext | null;
  agentAudioOutput?: AudioOutputActor;
  agentSpeechAudioCursor: number;
  agentSpeechPlaybackId: number;
  agentSpeechSources: Set<AudioBufferSourceNode>;
  agentVoiceTrace: VoiceTrace;
  agentVoiceTraceLabel: string;
  agentVoiceBaseInput: string;
  agentVoiceRawInput: string;
  agentLiveFinalText: string;
  agentLiveDraftText: string;
  agentVoiceTurnText: string;
  agentVoiceActivePartial: string;
  agentVoiceTurnRevision: number;
  agentVoiceSelfSpeechIgnoreUntil: number;
  agentVoiceReady: boolean;
  agentVoiceWarmupTimer: number;
  agentVoiceLastTranscriptAt: number;
  agentVoiceQueuedAfterBusy: boolean;
  agentVoiceConsumingQueue: boolean;
  agentVoiceSendInFlight: boolean;
  agentVoiceLastSentText: string;
  agentVoiceLastSentAt: number;
  agentVoiceSentTurnTexts: string[];
  agentVoicePipelineGeneration: number;
  agentVoiceControlHoldSignature: string;
  agentVoiceControlHoldUntil: number;
  agentVoiceLastControlSignature: string;
  agentVoiceLastControlAt: number;
  agentVoiceLocalSpeechActive: boolean;
  agentVoiceLocalSpeechStartedAt: number;
  agentVoiceLocalLastSpeechAt: number;
  agentVoiceLocalEndpointTimer: number;
  agentVoiceNoTranscriptTimer: number;
  agentVoiceIgnoreSpeechStartUntil: number;
  agentVoiceSystemSpeechActive: boolean;
  voiceSession: VoiceSessionState;
  agentVoiceAutoSendTimer: number;
  agentVoiceTriggerActiveUntil: number;
  agentSpeaking: boolean;
  agentOmniE2eAssistantIndex: number;
  agentOmniE2eStreamMessageEl: HTMLElement | null;
  agentOmniE2eReply: string;
  agentOmniE2eActionSuggestions: number;
  agentOmniE2eUserMessage: string;
  agentTranscriptEl: HTMLElement | null;
  agentSurfaceEl: HTMLElement | null;
  agentVisualWrapEl: HTMLElement | null;
  agentStatusEl: HTMLElement | null;
  agentTraceEl: HTMLElement | null;
  agentReplyEl: HTMLElement | null;
  agentSuggestionsEl: HTMLElement | null;
  agentComposerContainerEl: HTMLElement | null;
  agentModeButtons: HTMLButtonElement[];
  filteredTasks(tasks: LifeOpsTask[]): LifeOpsTask[];
  tasksForFilter(board: TaskDashboardData): LifeOpsTask[];
  renderGroupedTaskView(container: HTMLElement, groups: Array<[string, LifeOpsTask[]]>, defaults: (group: string) => Partial<LifeOpsTaskInput>, emptyText: string): void;
  appendAgentMessage(message: AgentConversationMessage): HTMLElement | null;
  agentSubmissionOptions(source: "text" | "voice"): AgentSubmissionOptions;
  sendAgentMessage(source?: "text" | "voice"): Promise<void>;
  sendAgentMessageWithPipeline(message: string, history: AgentConversationMessage[], voicePipelineGeneration: number): Promise<void>;
  setAgentMessageBubbleContent(bubble: HTMLElement, content: string): void;
  scrollAgentTranscriptToBottom(): void;
  refreshAgentSuggestions(): void;
  refreshAgentSurfaceState(): void;
  setAgentBusy(value: boolean): void;
  setAgentInput(value: string): void;
  recoverTimedOutAgentBusy(): boolean;
  tryAcceptPendingActionFromVoice(message: string): Promise<boolean>;
  acceptAgentSuggestion(action: AgentActionSuggestion): Promise<void>;
  dismissAgentSuggestion(actionId: string): Promise<void>;
  rememberSentVoiceTurn(text: string): void;
  clearVoiceTurnBufferAfterSend(): void;
  beginVoiceProcessingTrace(): void;
  markVoiceTrace(key: VoiceTraceKey): void;
  transitionVoiceSession(to: VoicePhase, reason?: string): void;
  speakAgentReply(text: string): void;
  consumeQueuedVoiceInput(): Promise<boolean>;
  currentVoiceMessageText(): string;
  prepareVoiceMessageForSend(rawMessage: string): string | null;
  discardCurrentVoiceTurn(reply: string): void;
  clearVoiceAutoSendTimer(): void;
  scheduleVoiceAutoSend(): void;
  resetCurrentVoiceTurnDraft(): void;
  appendAgentQualityLog(source: "text" | "voice", actionSuggestions: number, errorCode?: string, errorMessage?: string): Promise<void>;
  appendVoiceMetric(event: VoiceMetricEntry["event"], extra?: Partial<VoiceMetricEntry>): void;
  buildVoiceMetricEntry(event: VoiceMetricEntry["event"], extra?: Partial<VoiceMetricEntry>): VoiceMetricEntry;
  render(): Promise<void>;
  run(success: string, action: () => Promise<void>): Promise<void>;
}


export interface ComposerPanelApi {
  renderAgentComposer(...args: any[]): any;
  refreshAgentModeUi(...args: any[]): any;
  setAgentBusy(...args: any[]): any;
  recoverTimedOutAgentBusy(...args: any[]): any;
  ensureVoiceStandby(...args: any[]): any;
  stopVoiceStandby(...args: any[]): any;
  clearVoiceAutoSendTimer(...args: any[]): any;
  clearVoiceWarmupTimer(...args: any[]): any;
  clearVoiceLocalEndpointTimer(...args: any[]): any;
  clearVoiceNoTranscriptTimer(...args: any[]): any;
  scheduleVoiceAutoSend(...args: any[]): any;
  sendVoiceTurnIfReady(...args: any[]): any;
  sendOmniE2eVoiceTurn(...args: any[]): any;
  currentVoiceMessageText(...args: any[]): any;
  shouldHoldCurrentVoiceTurnForControl(...args: any[]): any;
  invalidateVoicePipeline(...args: any[]): any;
  voiceAutoSendDelayMs(...args: any[]): any;
  prepareVoiceMessageForSend(...args: any[]): any;
  queueCurrentVoiceInput(...args: any[]): any;
  consumeQueuedVoiceInput(...args: any[]): any;
  discardCurrentVoiceTurn(...args: any[]): any;
  beginVoiceTurnBuffer(...args: any[]): any;
  resetVoiceTurnBuffer(...args: any[]): any;
  clearVoiceTurnBufferAfterSend(...args: any[]): any;
  startVoiceTrace(...args: any[]): any;
  beginVoiceProcessingTrace(...args: any[]): any;
  markVoiceTrace(...args: any[]): any;
  setVoiceCaptureMode(...args: any[]): any;
  resetVoiceSessionForStart(...args: any[]): any;
  transitionVoiceSession(...args: any[]): any;
  appendAgentQualityLog(...args: any[]): any;
  appendVoiceMetric(...args: any[]): any;
  buildVoiceMetricEntry(...args: any[]): any;
  updateVoiceTraceLabel(...args: any[]): any;
  startAgentRecording(...args: any[]): any;
  startFallbackAgentRecording(...args: any[]): any;
  stopAgentRecording(...args: any[]): any;
  handleVoiceSpeechStarted(...args: any[]): any;
  handleVoiceSpeechStopped(...args: any[]): any;
  startBailianRealtimeRecording(...args: any[]): any;
  stopBailianRealtimeRecording(...args: any[]): any;
  finishAgentRecording(...args: any[]): any;
  cleanupAgentMedia(...args: any[]): any;
  updateRealtimeTranscript(...args: any[]): any;
  handleVoiceControlEvent(...args: any[]): any;
  voiceDisplayInput(...args: any[]): any;
  normalizeRealtimeTranscript(...args: any[]): any;
  knownVoiceTranscriptFragments(...args: any[]): any;
  rememberSentVoiceTurn(...args: any[]): any;
  resetCurrentVoiceTurnDraft(...args: any[]): any;
  startAgentLiveSpeechPreview(...args: any[]): any;
  stopAgentLiveSpeechPreview(...args: any[]): any;
  setAgentInput(...args: any[]): any;
  speakAgentReply(...args: any[]): any;
  interruptAgentSpeech(...args: any[]): any;
  speakAgentReplyWithSystem(...args: any[]): any;
  speakAgentReplyWithBailian(...args: any[]): any;
  enqueueAgentSpeechAudio(...args: any[]): any;
  ensureAgentSpeechAudioContext(...args: any[]): any;
  cleanupAgentSpeechAudio(...args: any[]): any;
  agentRecordingReply(...args: any[]): any;
}

// Existing chat stays visible, but only messages created during this listening
// session participate in cumulative-transcript filtering. Weak identities survive
// list slicing without retaining the old conversation or relying on its length.
const voiceSessionPriorMessages = new WeakMap<object, WeakSet<AgentConversationMessage>>();

const composerPanel = {
  renderAgentComposer(this: ViewHost, container: HTMLElement): void {
      this.agentComposerContainerEl = container;
      container.empty();
      const readiness = this.agentMode === "voice"
        ? realtimeVoiceReadiness(this.controller.settings)
        : textAiReadiness(this.controller.settings);
      if (!readiness.ready && !(this.agentMode === "voice" && this.agentRecording)) {
        const hint = container.createDiv({ cls: "lifeops-muted lifeops-agent-capability-hint", attr: { role: "status" } });
        hint.createSpan({ text: readiness.message });
        if (this.controller.openStewardSettings) {
          hint.createEl("button", { text: "查看设置", attr: { type: "button" } }, button => {
            button.onclick = () => this.controller.openStewardSettings?.();
          });
        }
      }
      const body = container.createDiv({ cls: `lifeops-agent-compose mode-${this.agentMode}` });
      const input = body.createEl("textarea", {
        cls: "lifeops-agent-input",
        attr: { placeholder: this.agentMode === "voice"
          ? this.agentRecording ? "正在听，你说的话会显示在这里..."
            : !readiness.ready ? "语音尚未就绪，可切回文字继续记录..." : "语音连接就绪后，你说的话会显示在这里..."
          : "跟 LifeOps 说：今天发生了什么、接下来要做什么、哪件事需要复盘..." }
      });
      input.value = this.agentInput;
      this.agentInputEl = input;
      input.rows = this.agentWorkspaceOpen ? 2 : this.agentMode === "text" ? 2 : 1;
      input.oninput = () => {
        this.agentInput = input.value;
      };
      input.onpaste = (event) => {
        if (!this.controller.openTradeScreenshotImport) return;
        const images = [...(event.clipboardData?.items ?? [])].filter(item => item.kind === "file"
          && (item.type === "image/png" || item.type === "image/jpeg"));
        const image = images.length === 1 ? images[0].getAsFile() : null;
        if (!image) return;
        event.preventDefault();
        this.controller.openTradeScreenshotImport(image);
      };
      input.onkeydown = (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void this.sendAgentMessage();
        }
      };

      const actions = body.createDiv({ cls: "lifeops-agent-actions" });
      if (this.agentMode === "voice") {
        this.agentReplyModeButton(actions);
      } else {
        actions.createEl("button", { cls: "lifeops-agent-send" }, (button) => {
          setIcon(button.createSpan({ cls: "lifeops-button-icon" }), "send");
          button.createSpan({ text: this.agentBusy ? "处理中" : "发送" });
          button.disabled = this.agentBusy;
          button.onclick = () => void this.sendAgentMessage();
        });
      }
    },

  refreshAgentModeUi(this: ViewHost): void {
      for (const button of this.agentModeButtons) {
        button.toggleClass("is-active", button.dataset.agentMode === this.agentMode);
      }
      if (this.agentComposerContainerEl) {
        this.renderAgentComposer(this.agentComposerContainerEl);
      }
      this.refreshAgentSurfaceState();
    },

  setAgentBusy(this: ViewHost, value: boolean): void {
      if (value) this.agentActivityGeneration = (this.agentActivityGeneration ?? 0) + 1;
      this.agentBusy = value;
      this.agentBusySince = value ? Date.now() : 0;
    },

  recoverTimedOutAgentBusy(this: ViewHost): boolean {
      if (!this.agentBusy || !this.agentBusySince || Date.now() - this.agentBusySince <= AGENT_BUSY_TIMEOUT_MS) {
        return false;
      }
      cancelMessageListRequest(this);
      this.setAgentBusy(false);
      this.agentVoiceQueuedAfterBusy = false;
      this.agentReply = "上一轮回复超时，我先恢复监听。你可以再说一遍刚才那句。";
      if (this.agentMode === "voice") {
        this.transitionVoiceSession("listening", "agent busy timeout recovered");
      }
      this.refreshAgentSurfaceState();
      return true;
    },

  async ensureVoiceStandby(this: ViewHost): Promise<void> {
      this.recoverTimedOutAgentBusy();
      if (this.agentMode !== "voice" || this.agentRecording || this.agentBusy) return;
      const readiness = realtimeVoiceReadiness(this.controller.settings);
      if (!readiness.ready) {
        this.agentVoiceConversation = false;
        this.agentReply = readiness.message;
        await this.render();
        return;
      }
      this.agentVoiceConversation = true;
      const triggerHint = voiceTriggerEnabled(this.controller.settings)
        ? `先说「${voiceTriggerLabel(this.controller.settings)}」再提问；触发后 ${voiceTriggerTimeoutSec(this.controller.settings)} 秒内可以连续追问。`
        : "说完后会自动发送给管家。";
      this.agentReply = this.controller.settings.realtimeVoice.speakReplies
        ? `正在准备语音连接；${triggerHint}`
        : `正在准备语音连接；${triggerHint} AI 回复只显示文字。`;
      await this.startAgentRecording();
    },

  stopVoiceStandby(this: ViewHost): void {
      closeSessionBreeze(this);
      clearCancelledVoiceInput(this);
      this.agentVoiceConversation = false;
      this.clearVoiceAutoSendTimer();
      this.clearVoiceWarmupTimer();
      this.clearVoiceLocalEndpointTimer();
      this.clearVoiceNoTranscriptTimer();
      this.invalidateVoicePipeline("voice standby stopped");
      this.agentVoiceReady = false;
      this.agentVoiceTriggerActiveUntil = 0;
      this.agentVoiceControlHoldSignature = "";
      this.agentVoiceControlHoldUntil = 0;
      this.agentVoiceTrace = {};
      this.agentVoiceTraceLabel = "";
      clearEchoMemories();
      // Settle an active reply while its Runtime turn still owns the busy state.
      try {
        this.interruptAgentSpeech();
      } finally {
        // Startup may still be waiting for permission or context before recording becomes true.
        this.stopAgentRecording(true);
        this.agentVoiceRuntime?.stop();
        void this.agentAudioOutput?.close().catch(() => undefined);
        this.refreshAgentSurfaceState();
      }
    },

  clearVoiceAutoSendTimer(this: ViewHost): void {
      if (this.agentVoiceAutoSendTimer) {
        window.clearTimeout(this.agentVoiceAutoSendTimer);
      }
      this.agentVoiceAutoSendTimer = 0;
    },

  clearVoiceWarmupTimer(this: ViewHost): void {
      if (this.agentVoiceWarmupTimer) {
        window.clearTimeout(this.agentVoiceWarmupTimer);
      }
      this.agentVoiceWarmupTimer = 0;
    },

  clearVoiceLocalEndpointTimer(this: ViewHost): void {
      if (this.agentVoiceLocalEndpointTimer) {
        window.clearTimeout(this.agentVoiceLocalEndpointTimer);
      }
      this.agentVoiceLocalEndpointTimer = 0;
    },

  clearVoiceNoTranscriptTimer(this: ViewHost): void {
      if (this.agentVoiceNoTranscriptTimer) {
        window.clearTimeout(this.agentVoiceNoTranscriptTimer);
      }
      this.agentVoiceNoTranscriptTimer = 0;
    },

  scheduleVoiceAutoSend(this: ViewHost): void {
      this.recoverTimedOutAgentBusy();
      if (this.agentMode !== "voice" || !this.agentRecording) return;
      if (this.agentRealtimeClient && !isOmniE2eRealtimeMode(this.controller.settings.realtimeVoice)) return;
      const text = this.currentVoiceMessageText();
      if (!text) return;
      if (this.shouldHoldCurrentVoiceTurnForControl(text)) {
        this.clearVoiceAutoSendTimer();
        this.agentReply = "我在，你继续说，我先不抢。";
        this.refreshAgentSurfaceState();
        return;
      }
      const visibleText = this.voiceDisplayInput(text) || text;
      const decision = decideVoiceTurnReadiness({
        mode: this.agentMode,
        recording: this.agentRecording,
        busy: this.agentBusy,
        text,
        visibleText,
        recentDuplicate: false,
        alreadySent: false
      });
      if (decision.decision === "hold") {
        this.clearVoiceAutoSendTimer();
        this.agentReply = "我在听，你继续说。";
        this.refreshAgentSurfaceState();
        return;
      }
      const scheduledRevision = this.agentVoiceTurnRevision;
      const delayMs = this.voiceAutoSendDelayMs(text) + (this.agentVoiceReady ? 0 : 2500);
      this.clearVoiceAutoSendTimer();
      this.agentVoiceAutoSendTimer = window.setTimeout(() => {
        if (scheduledRevision !== this.agentVoiceTurnRevision) {
          this.scheduleVoiceAutoSend();
          return;
        }
        void this.sendVoiceTurnIfReady();
      }, delayMs);
    },

  async sendVoiceTurnIfReady(this: ViewHost, options: { localEndpoint?: boolean; silenceMs?: number } = {}): Promise<void> {
      if (this.agentMode !== "voice") return;
      if (hasPendingCascadeTranscript(this)) return;
      const text = this.currentVoiceMessageText();
      if (isFreshCascadeTranscript(this, text)) {
        await sendManagedVoiceTurn(this, "server-vad finalized");
        return;
      }
      if (isOmniE2eRealtimeMode(this.controller.settings.realtimeVoice) && options.localEndpoint) {
        await this.sendOmniE2eVoiceTurn(`local_endpoint:${Math.round(options.silenceMs ?? 0)}ms`);
        return;
      }
      if (this.shouldHoldCurrentVoiceTurnForControl(text)) {
        this.agentReply = "我在，你继续说，我先不抢。";
        this.refreshAgentSurfaceState();
        return;
      }
      const isRecentDuplicate = text === this.agentVoiceLastSentText && performance.now() - this.agentVoiceLastSentAt < 3000;
      const visibleText = this.voiceDisplayInput(text) || text;
      const input = {
        mode: this.agentMode,
        recording: this.agentRecording,
        busy: this.agentBusy,
        text,
        visibleText,
        recentDuplicate: isRecentDuplicate,
        alreadySent: isAlreadySent(this.voiceSession, text)
      };
      const decision = options.localEndpoint
        ? decideLocalVoiceEndpoint({ ...input, silenceMs: options.silenceMs ?? 0 })
        : decideVoiceTurnReadiness(input);
      if (decision.decision === "idle" || decision.decision === "duplicate") return;
      if (decision.decision === "hold") {
        this.agentReply = decision.reason === "local_endpoint_incomplete_turn"
          ? "我在听，这句像还没收尾，你继续。"
          : "我在，刚才是接话，我先不抢答。你继续说。";
        this.refreshAgentSurfaceState();
        return;
      }
      if (decision.decision === "queue") {
        this.queueCurrentVoiceInput("normal", decision.reason);
        return;
      }
      if (this.controller.settings.realtimeVoice.provider === "qwen-omni-realtime") {
        await sendManagedVoiceTurn(this, decision.reason);
        return;
      }
      await this.sendAgentMessage("voice");
    },

  async sendOmniE2eVoiceTurn(this: ViewHost, reason = "voice endpoint"): Promise<void> {
      await sendOmniE2eVoiceTurn(this, reason);
    },

  currentVoiceMessageText(this: ViewHost): string {
      return this.agentVoiceRawInput.trim() || this.agentInput.trim();
    },

  shouldHoldCurrentVoiceTurnForControl(this: ViewHost, text: string): boolean {
      if (!this.agentVoiceControlHoldSignature) return false;
      return shouldHoldVoiceTurnForControl({
        text,
        heldSignature: this.agentVoiceControlHoldSignature,
        nowMs: Date.now(),
        holdUntilMs: this.agentVoiceControlHoldUntil
      });
    },

  invalidateVoicePipeline(this: ViewHost, _reason: string): void {
      this.agentVoicePipelineGeneration += 1;
      this.appendVoiceMetric("voice_pipeline_invalidated", {
        reason: _reason
      });
    },

  voiceAutoSendDelayMs(this: ViewHost, text: string): number {
      if (!voiceTriggerEnabled(this.controller.settings)) return voiceEndpointDelayMs(text);
      const phrases = parseVoiceTriggerPhrases(this.controller.settings.realtimeVoice.triggerPhrases);
      if (phrases.length === 0) return voiceEndpointDelayMs(text);
      const hasTrigger = Boolean(findVoiceTrigger(text, phrases));
      const stripped = stripVoiceTriggers(text, phrases);
      const visibleText = stripped.text || text;
      if (this.agentVoiceTriggerActiveUntil <= Date.now() && !hasTrigger) {
        return Math.max(voiceEndpointDelayMs(visibleText), 3000);
      }
      if (hasTrigger && !stripped.text) return 700;
      return voiceEndpointDelayMs(visibleText);
    },

  prepareVoiceMessageForSend(this: ViewHost, rawMessage: string, freshServerItem = false): string | null {
      if (!freshServerItem && !canRepeatCancelledVoiceInput(this, rawMessage)) {
        rawMessage = stripKnownVoiceTurns(rawMessage, this.knownVoiceTranscriptFragments());
      }
      if (!rawMessage) {
        this.discardCurrentVoiceTurn("已忽略重复的语音转写。");
        return null;
      }
      if (!freshServerItem && detectVoiceControlEvent(rawMessage)) {
        rawMessage = stripVoiceControlPhrases(rawMessage);
        if (!rawMessage) {
          this.discardCurrentVoiceTurn("我在，刚才我先不抢。你继续说，我听着。");
          return null;
        }
      }
      if (!freshServerItem && this.shouldHoldCurrentVoiceTurnForControl(rawMessage)) {
        this.agentReply = "我在，你继续说，我先不抢。";
        this.refreshAgentSurfaceState();
        return null;
      }
      if (!voiceTriggerEnabled(this.controller.settings)) return rawMessage;
      const phrases = parseVoiceTriggerPhrases(this.controller.settings.realtimeVoice.triggerPhrases);
      if (phrases.length === 0) return rawMessage;

      const now = Date.now();
      const timeoutMs = voiceTriggerTimeoutSec(this.controller.settings) * 1000;
      if (this.agentVoiceTriggerActiveUntil > now) {
        const activeStrip = stripVoiceTriggers(rawMessage, phrases);
        rawMessage = activeStrip.matched ? activeStrip.text : rawMessage;
        if (!rawMessage.trim()) {
          this.discardCurrentVoiceTurn("已忽略重复的语音转写。");
          return null;
        }
        this.agentVoiceTriggerActiveUntil = now + timeoutMs;
        return rawMessage;
      }

      const match = findVoiceTrigger(rawMessage, phrases);
      const label = phrases[0] || "小管家";
      if (!match) {
        this.discardCurrentVoiceTurn(`我听到了声音，但没有听到触发词「${label}」。需要先说触发词，或在设置里关闭语音触发词。`);
        return null;
      }

      this.agentVoiceTriggerActiveUntil = now + timeoutMs;
      const message = stripVoiceTriggers(rawMessage, phrases).text;
      if (!message) {
        this.discardCurrentVoiceTurn(`已听到触发词「${label}」。接下来 ${voiceTriggerTimeoutSec(this.controller.settings)} 秒内可以直接说问题。`);
        return null;
      }
      return message;
    },

  queueCurrentVoiceInput(this: ViewHost, priority: "normal" | "interrupt", reason: string, queuedServerFinal = false): void {
      const text = this.currentVoiceMessageText();
      const serverFinal = queuedServerFinal || isFreshCascadeTranscript(this, text);
      if (!text || !serverFinal && isVoiceHoldOnlyTurn(this.voiceDisplayInput(text) || text)) return;
      const turnId = this.voiceSession.currentTurnId ?? `queued-${Date.now()}`;
      this.voiceSession = enqueueInput(this.voiceSession, {
        text,
        source: "voice",
        turnId,
        priority,
        ...(serverFinal ? { serverFinal: true } : {})
      });
      this.appendVoiceMetric("voice_input_queued", {
        reason,
        textLength: text.length
      });
      this.agentVoiceQueuedAfterBusy = true;
      this.clearVoiceAutoSendTimer();
      this.clearVoiceTurnBufferAfterSend();
      this.agentRealtimeClient?.resetTranscript();
      this.setAgentInput("");
      this.agentReply = priority === "interrupt"
        ? "我听到了，先停下，马上接你刚才这句。"
        : "我听到了，这句已排队，马上接上。";
      this.agentVoiceTraceLabel = `${this.agentVoiceTraceLabel || "语音链路"} · queued:${reason}`;
      this.refreshAgentSurfaceState();
    },

  async consumeQueuedVoiceInput(this: ViewHost): Promise<boolean> {
      if (this.agentVoiceConsumingQueue || this.agentBusy || this.voiceSession.inputQueue.length === 0) return false;
      const result = dequeueInput(this.voiceSession);
      this.voiceSession = result.session;
      const next = result.next;
      if (!next) return false;
      this.agentVoiceConsumingQueue = true;
      try {
        this.beginVoiceTurnBuffer(next.text, false);
        this.setAgentInput(this.voiceDisplayInput(next.text));
        if (this.controller.settings.realtimeVoice.provider === "qwen-omni-realtime") {
          await sendManagedVoiceTurn(this, "queued voice input", next.serverFinal === true);
        } else {
          await this.sendAgentMessage("voice");
        }
        return true;
      } finally {
        this.agentVoiceConsumingQueue = false;
        this.agentVoiceQueuedAfterBusy = this.voiceSession.inputQueue.length > 0;
      }
    },

  discardCurrentVoiceTurn(this: ViewHost, reply: string): void {
      this.clearVoiceAutoSendTimer();
      this.resetVoiceTurnBuffer();
      this.agentRealtimeClient?.resetTranscript();
      this.setAgentInput("");
      this.agentReply = reply;
      this.agentVoiceQueuedAfterBusy = false;
      this.refreshAgentSurfaceState();
    },

  beginVoiceTurnBuffer(this: ViewHost, baseInput = "", resetQueue = true): void {
      this.voiceSession = beginNewTurn(this.voiceSession, { resetQueue });
      this.agentVoiceControlHoldSignature = "";
      this.agentVoiceControlHoldUntil = 0;
      this.agentVoiceBaseInput = baseInput.trim();
      this.agentVoiceRawInput = this.agentVoiceBaseInput;
      this.agentVoiceTurnText = "";
      this.agentVoiceActivePartial = "";
      this.agentLiveFinalText = "";
      this.agentLiveDraftText = "";
      this.agentVoiceTurnRevision += 1;
    },

  resetVoiceTurnBuffer(this: ViewHost): void {
      this.voiceSession = beginNewTurn(this.voiceSession, { resetQueue: true });
      this.agentVoiceControlHoldSignature = "";
      this.agentVoiceControlHoldUntil = 0;
      this.agentVoiceBaseInput = "";
      this.agentVoiceRawInput = "";
      this.agentVoiceTurnText = "";
      this.agentVoiceActivePartial = "";
      this.agentLiveFinalText = "";
      this.agentLiveDraftText = "";
      this.agentVoiceTurnRevision += 1;
    },

  clearVoiceTurnBufferAfterSend(this: ViewHost): void {
      this.voiceSession = beginNewTurn(this.voiceSession);
      this.agentVoiceControlHoldSignature = "";
      this.agentVoiceControlHoldUntil = 0;
      this.agentVoiceBaseInput = "";
      this.agentVoiceRawInput = "";
      this.agentVoiceTurnText = "";
      this.agentVoiceActivePartial = "";
      this.agentLiveFinalText = "";
      this.agentLiveDraftText = "";
      this.agentVoiceTurnRevision += 1;
    },

  startVoiceTrace(this: ViewHost): void {
      resetVoiceLatencyCapture(this);
      this.agentVoiceTrace = {
        recordingStart: performance.now()
      };
      this.agentVoiceTraceLabel = "语音链路计时中...";
    },

  beginVoiceProcessingTrace(this: ViewHost): void {
      const captureMode = this.agentVoiceTrace.captureMode;
      const now = performance.now();
      const transcriptAt = this.agentVoiceLastTranscriptAt || now;
      this.agentVoiceTrace = {
        recordingStart: transcriptAt,
        firstTranscript: transcriptAt,
        transcriptDone: transcriptAt,
        latency: takeVoiceLatencyCapture(this),
        captureMode
      };
      this.updateVoiceTraceLabel();
    },

  markVoiceTrace(this: ViewHost, key: VoiceTraceKey): void {
      if (!this.agentVoiceTrace.recordingStart && key !== "recordingStart") return;
      if (this.agentVoiceTrace[key]) return;
      this.agentVoiceTrace[key] = performance.now();
      if (key === "modelFirstText") markVoiceLatency(this.agentVoiceTrace.latency, "t2");
      if (key === "ttsFirstAudio") {
        this.appendVoiceMetric("voice_tts_first_audio");
      } else if (key === "ttsDone") {
        this.appendVoiceMetric("voice_tts_completed");
      }
      this.updateVoiceTraceLabel();
      this.refreshAgentSurfaceState();
    },

  setVoiceCaptureMode(this: ViewHost, mode: VoiceTrace["captureMode"]): void {
      this.agentVoiceTrace.captureMode = mode;
      this.updateVoiceTraceLabel();
      this.refreshAgentSurfaceState();
    },

  resetVoiceSessionForStart(this: ViewHost): void {
      // A transport reconnect continues the same logical session, including
      // cancellation/repeat handling; an intentional start gets a fresh window.
      if (!this.agentVoiceReconnectAttempts) {
        voiceSessionPriorMessages.set(this, new WeakSet(this.agentMessages));
        this.agentVoiceSentTurnTexts = [];
        this.agentVoiceLastSentText = "";
        this.agentVoiceLastSentAt = 0;
      }
      this.voiceSession = createVoiceSession();
      this.agentVoiceControlHoldSignature = "";
      this.agentVoiceControlHoldUntil = 0;
      this.agentVoiceLastControlSignature = "";
      this.agentVoiceLastControlAt = 0;
      this.agentVoiceLocalSpeechActive = false;
      this.agentVoiceLocalSpeechStartedAt = 0;
      this.agentVoiceLocalLastSpeechAt = 0;
      this.agentVoiceIgnoreSpeechStartUntil = 0;
      this.clearVoiceLocalEndpointTimer();
      this.clearVoiceNoTranscriptTimer();
      this.transitionVoiceSession("warming", "voice recording start");
    },

  transitionVoiceSession(this: ViewHost, to: VoicePhase, reason?: string): void {
      if (!canTransition(this.voiceSession.phase, to)) return;
      this.voiceSession = transition(this.voiceSession, to, reason);
      if (to === "error") {
        this.appendVoiceMetric("voice_error", {
          reason
        });
      }
    },

  async appendAgentQualityLog(this: ViewHost,
      source: "text" | "voice",
      actionSuggestions: number,
      errorCode = "",
      errorMessage = ""
    ): Promise<void> {
      const entry: QualityLogEntry = {
        inputSource: source,
        actionSuggestions,
        errorCode,
        errorMessage
      };

      if (source === "voice") {
        entry.captureMode = this.agentVoiceTrace.captureMode;
        entry.asrFirstMs = traceDelta(this.agentVoiceTrace.recordingStart, this.agentVoiceTrace.firstTranscript);
        entry.asrDoneMs = traceDelta(this.agentVoiceTrace.recordingStart, this.agentVoiceTrace.transcriptDone);
        entry.modelFirstMs = traceDelta(this.agentVoiceTrace.modelStart, this.agentVoiceTrace.modelFirstText);
        entry.modelDoneMs = traceDelta(this.agentVoiceTrace.modelStart, this.agentVoiceTrace.modelDone);
        entry.ttsFirstMs = traceDelta(this.agentVoiceTrace.ttsStart, this.agentVoiceTrace.ttsFirstAudio);
      }

      await this.controller.appendQualityLog(entry).catch(() => undefined);
      if (source === "voice") {
        this.appendVoiceMetric("voice_turn_completed", {
          actionSuggestions,
          errorCode,
          errorMessage
        });
      }
    },

  appendVoiceMetric(this: ViewHost, event: VoiceMetricEntry["event"], extra: Partial<VoiceMetricEntry> = {}): void {
      void this.controller.appendVoiceMetric(this.buildVoiceMetricEntry(event, extra)).catch(() => undefined);
    },

  buildVoiceMetricEntry(this: ViewHost, event: VoiceMetricEntry["event"], extra: Partial<VoiceMetricEntry> = {}): VoiceMetricEntry {
      const realtimeVoice = this.controller.settings.realtimeVoice;
      return {
        event,
        provider: realtimeVoice.provider,
        model: realtimeVoice.model,
        mode: this.agentMode,
        phase: this.voiceSession.phase,
        captureMode: this.agentVoiceTrace.captureMode,
        queueLength: this.voiceSession.inputQueue.length,
        generation: this.voiceSession.generation,
        latency: this.agentVoiceTrace.latency && { ...this.agentVoiceTrace.latency },
        asrFirstMs: traceDelta(this.agentVoiceTrace.recordingStart, this.agentVoiceTrace.firstTranscript),
        asrDoneMs: traceDelta(this.agentVoiceTrace.recordingStart, this.agentVoiceTrace.transcriptDone),
        modelFirstMs: traceDelta(this.agentVoiceTrace.modelStart, this.agentVoiceTrace.modelFirstText),
        modelDoneMs: traceDelta(this.agentVoiceTrace.modelStart, this.agentVoiceTrace.modelDone),
        ttsFirstMs: traceDelta(this.agentVoiceTrace.ttsStart, this.agentVoiceTrace.ttsFirstAudio),
        ttsDoneMs: traceDelta(this.agentVoiceTrace.ttsStart, this.agentVoiceTrace.ttsDone),
        totalMs: traceDelta(this.agentVoiceTrace.recordingStart, this.agentVoiceTrace.ttsDone ?? this.agentVoiceTrace.modelDone),
        ...extra
      };
    },

  updateVoiceTraceLabel(this: ViewHost): void {
      const start = this.agentVoiceTrace.recordingStart;
      if (!start) {
        this.agentVoiceTraceLabel = "";
        return;
      }
      const parts = [
        this.agentVoiceTrace.captureMode === "audio-worklet" ? "Worklet" : this.agentVoiceTrace.captureMode === "script-processor" ? "Script" : "",
        metricLabel("ASR首字", start, this.agentVoiceTrace.firstTranscript),
        metricLabel("ASR完成", start, this.agentVoiceTrace.transcriptDone),
        metricLabel("模型首字", this.agentVoiceTrace.modelStart, this.agentVoiceTrace.modelFirstText),
        metricLabel("模型完成", this.agentVoiceTrace.modelStart, this.agentVoiceTrace.modelDone),
        metricLabel("TTS首音", this.agentVoiceTrace.ttsStart, this.agentVoiceTrace.ttsFirstAudio)
      ].filter(Boolean);
      this.agentVoiceTraceLabel = parts.join(" · ") || "语音链路计时中...";
    },

  async startAgentRecording(this: ViewHost): Promise<void> {
      const device = (this.controller as { getDeviceStatus?: () => { canProcess?: boolean } | undefined }).getDeviceStatus?.();
      if (device?.canProcess === false) {
        new Notice("这台设备请用随手记或系统听写，语音对话由常开 Mac 处理。");
        return;
      }
      const realtimeVoice = this.controller.settings.realtimeVoice;
      if (realtimeVoice.provider !== "browser-live") {
        const readiness = realtimeVoiceReadiness(this.controller.settings);
        if (!readiness.ready) {
          this.agentVoiceConversation = false;
          this.agentReply = readiness.message;
          this.refreshAgentSurfaceState();
          new Notice(readiness.message);
          return;
        }
      }
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        new Notice("当前环境不支持录音。");
        return;
      }
      this.interruptAgentSpeech();
      this.startVoiceTrace();
      this.agentReply = this.agentVoiceConversation ? "正在准备语音对话..." : "正在准备听写...";
      this.refreshAgentSurfaceState();
      if (realtimeVoice.provider === "qwen-omni-realtime" && realtimeVoice.apiKey.trim()) {
        await this.startBailianRealtimeRecording();
        return;
      }
      await this.startFallbackAgentRecording();
    },

  async startFallbackAgentRecording(this: ViewHost): Promise<void> {
      const realtimeVoice = this.controller.settings.realtimeVoice;
      let generation: number | undefined;
      const isCurrent = () => !this.viewClosed && this.agentRealtimeStartGeneration === generation;
      try {
        this.stopAgentRecording(true);
        generation = this.agentRealtimeStartGeneration = (this.agentRealtimeStartGeneration ?? 0) + 1;
        this.resetVoiceSessionForStart();
        this.agentAudioChunks = [];
        this.startVoiceTrace();
        this.setVoiceCaptureMode("fallback-recorder");
        this.beginVoiceTurnBuffer(this.agentInput);
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        if (!isCurrent()) { stream.getTracks().forEach(track => track.stop()); return; }
        this.agentStream = stream;
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
        this.agentRecorder = new MediaRecorder(this.agentStream, { mimeType });
        this.agentRecorder.ondataavailable = (event) => {
          if (!isCurrent()) return;
          if (event.data.size > 0) this.agentAudioChunks.push(event.data);
        };
        this.agentRecorder.onstop = () => {
          if (isCurrent()) void this.finishAgentRecording(mimeType, generation);
        };
        const livePreviewStarted = realtimeVoice.provider === "browser-live" ? this.startAgentLiveSpeechPreview() : false;
        this.agentRecorder.start(1000);
        this.agentRecording = true;
        this.transitionVoiceSession("listening", "fallback recorder started");
        this.agentReply = this.agentRecordingReply(realtimeVoice.provider, livePreviewStarted);
        this.refreshAgentSurfaceState();
      } catch (error) {
        if (!isCurrent()) return;
        this.transitionVoiceSession("error", error instanceof Error ? error.message : "fallback recorder start failed");
        this.cleanupAgentMedia();
        new Notice(error instanceof Error ? `录音启动失败：${error.message}` : "录音启动失败");
      }
    },

  stopAgentRecording(this: ViewHost, silent = false): void {
      if (silent) {
        this.agentRealtimeStartGeneration = (this.agentRealtimeStartGeneration ?? 0) + 1;
        if (this.agentTranscriptionAbortController) {
          this.agentTranscriptionAbortController.abort("voice recording stopped");
          this.agentTranscriptionAbortController = null;
          this.setAgentBusy(false);
        }
      }
      if (this.agentRealtimeClient || this.agentAudioProcessor || this.agentAudioContext) {
        void this.stopBailianRealtimeRecording(silent);
        return;
      }
      this.stopAgentLiveSpeechPreview();
      if (this.agentRecorder && this.agentRecorder.state !== "inactive") {
        if (silent) {
          this.agentRecorder.onstop = null;
          this.agentRecorder.ondataavailable = null;
        }
        this.agentRecorder.stop();
        if (silent) this.cleanupAgentMedia();
      } else {
        this.cleanupAgentMedia();
      }
      this.agentRecording = false;
      this.transitionVoiceSession("stopping", "recording stopped");
      this.transitionVoiceSession("idle", "recording stopped");
      if (!silent) {
        this.agentReply = "语音已停止，正在准备转写...";
        void this.render();
      }
    },

  handleVoiceSpeechStarted(this: ViewHost, _source: "server-vad" | "local-vad"): void {
      if (!this.agentVoiceReady) return;
      const now = performance.now();
      const wasSpeaking = this.agentSpeaking || Boolean(this.agentTtsClient) || this.agentSpeechSources.size > 0;
      const authoritativeOmniSpeechStart = _source === "server-vad"
        && isOmniE2eRealtimeMode(this.controller.settings.realtimeVoice);
      if (!authoritativeOmniSpeechStart && shouldIgnoreVoiceSpeechStart({
        agentBusy: this.agentBusy,
        assistantSpeaking: wasSpeaking,
        nowMs: now,
        ignoreUntilMs: wasSpeaking ? this.agentVoiceSelfSpeechIgnoreUntil : this.agentVoiceIgnoreSpeechStartUntil
      })) {
        return;
      }
      if (this.agentBusy && !wasSpeaking) {
        // A speech onset alone can be noise. Wait for the transcript before replacing the pending reply.
        this.appendVoiceMetric("voice_speech_started", {
          reason: `${_source}:pending_transcript`
        });
        this.clearVoiceAutoSendTimer();
        this.clearVoiceLocalEndpointTimer();
        return;
      }
      if (wasSpeaking) {
        this.agentVoiceQueuedAfterBusy = true;
      }
      this.appendVoiceMetric("voice_speech_started", {
        reason: _source
      });
      this.clearVoiceAutoSendTimer();
      this.clearVoiceLocalEndpointTimer();
      this.interruptAgentSpeech();
      if (wasSpeaking) {
        this.transitionVoiceSession("listening", `${_source}: user interrupted assistant playback`);
        this.agentVoiceSelfSpeechIgnoreUntil = performance.now() + 900;
        this.agentRealtimeClient?.resetTranscript();
      }
    },

  handleVoiceSpeechStopped(this: ViewHost, _source: "server-vad" | "local-vad", scheduleTurn = true): void {
      if (!this.agentVoiceReady) return;
      this.appendVoiceMetric("voice_speech_stopped", {
        reason: _source,
        textLength: this.currentVoiceMessageText().length
      });
      if (scheduleTurn) this.scheduleVoiceAutoSend();
    },

  async startBailianRealtimeRecording(this: ViewHost): Promise<void> {
      await startBailianRealtimeRecordingFlow(this);
    },

  async stopBailianRealtimeRecording(this: ViewHost, silent = false): Promise<void> {
      await stopBailianRealtimeRecordingFlow(this, silent);
    },

  async finishAgentRecording(this: ViewHost, mimeType: string, generation = this.agentRealtimeStartGeneration): Promise<void> {
      const isCurrent = () => !this.viewClosed && this.agentRealtimeStartGeneration === generation;
      if (!isCurrent()) return;
      const audio = new Blob(this.agentAudioChunks, { type: mimeType });
      this.cleanupAgentMedia();
      const realtimeVoice = this.controller.settings.realtimeVoice;
      const liveDraft = this.agentLiveDraftText.trim();
      if (liveDraft) {
        const rawInput = [this.agentVoiceBaseInput, liveDraft].filter(Boolean).join(this.agentVoiceBaseInput ? "\n" : "");
        this.agentVoiceRawInput = rawInput;
        this.setAgentInput(this.voiceDisplayInput(rawInput));
        this.agentReply = this.agentVoiceConversation && realtimeVoice.autoSendOnStop
          ? "已收到实时语音草稿，正在发送给管家..."
          : "实时语音草稿已写入输入框，可以编辑后发送。";
        await this.render();
        if (!isCurrent()) return;
        if (this.agentVoiceConversation && realtimeVoice.autoSendOnStop) {
          await this.sendAgentMessage("voice");
        }
        return;
      }

      if (audio.size === 0) {
        this.agentReply = "没有录到有效声音。";
        await this.render();
        return;
      }
      if (!realtimeVoice.cloudFallback) {
        this.agentReply = "没有拿到实时语音草稿，且云端转写 fallback 已关闭。";
        await this.render();
        return;
      }
      const transcription = new AbortController();
      this.agentTranscriptionAbortController = transcription;
      this.setAgentBusy(true);
      this.agentReply = "正在转写语音...";
      try {
        await this.render();
        if (!isCurrent()) return;
        const text = await this.controller.transcribeAgentAudio(audio, transcription.signal);
        if (!isCurrent()) return;
        this.setAgentInput([this.agentInput.trim(), text].filter(Boolean).join(this.agentInput.trim() ? "\n" : ""));
        if (this.agentVoiceConversation && realtimeVoice.autoSendOnStop) {
          this.agentReply = "转写完成，正在发送给管家...";
          await this.render();
          if (!isCurrent()) return;
          this.setAgentBusy(false);
          await this.sendAgentMessage("voice");
          return;
        }
        this.agentReply = "转写完成，可以继续补充，也可以直接发送给管家。";
      } catch (error) {
        if (!isCurrent()) return;
        this.agentReply = error instanceof Error ? `转写失败：${error.message}` : "转写失败";
        new Notice(this.agentReply);
      } finally {
        if (this.agentTranscriptionAbortController === transcription) this.agentTranscriptionAbortController = null;
        if (isCurrent()) {
          this.setAgentBusy(false);
          await this.render();
        }
      }
    },

  cleanupAgentMedia(this: ViewHost): void {
      this.agentStream?.getTracks().forEach((track) => track.stop());
      this.agentStream = null;
      this.agentRecorder = null;
      this.agentAudioChunks = [];
    },

  updateRealtimeTranscript(this: ViewHost, text: string, isFinal = false, freshServerItem = false, serverPreview = false): void {
      const fromCascade = freshServerItem || serverPreview;
      const transcript = fromCascade && !isEchoTranscript(text) ? text.trim() : this.normalizeRealtimeTranscript(text);
      if (!transcript) {
        if (this.agentMode === "voice" && !this.agentVoiceTurnText.trim() && !this.agentVoiceActivePartial.trim()) {
          this.setAgentInput("");
        }
        return;
      }
      const visibleTranscript = this.voiceDisplayInput(transcript) || transcript;
      const controlEvent = fromCascade ? null : detectVoiceControlEvent(visibleTranscript);
      if (!fromCascade) this.handleVoiceControlEvent(transcript);
      const assistantSpeaking = this.agentSpeaking || Boolean(this.agentTtsClient) || this.agentSpeechSources.size > 0;
      const pendingManagedBargeIn = this.agentVoiceBargeIn?.snapshot?.().phase === "suspected";
      if (!fromCascade && pendingManagedBargeIn && !controlEvent && isVoiceHoldOnlyTurn(visibleTranscript)) {
        this.appendVoiceMetric("voice_speech_started", {
          reason: "barge_in_backchannel_ignored",
          textLength: visibleTranscript.length
        });
        return;
      }
      if (!fromCascade && assistantSpeaking && !shouldInterruptAssistantForTranscript({
        assistantSpeaking,
        transcript: visibleTranscript,
        controlEvent: Boolean(controlEvent)
      })) {
        this.appendVoiceMetric("voice_speech_started", {
          reason: "transcript_ignored_during_assistant_speech",
          textLength: visibleTranscript.length
        });
        return;
      }
      this.agentVoiceLastTranscriptAt = performance.now();
      this.clearVoiceNoTranscriptTimer();
      const finishingDrainedReply = !controlEvent && shouldQueueOmniPostPlaybackInput(this);
      if (!serverPreview && finishingDrainedReply && this.voiceSession.inputQueue.length > 0) {
        this.agentReply = "下一句已经排队；这句暂未接收，请等回复后再说。";
        if (isFinal) new Notice(this.agentReply);
        this.refreshAgentSurfaceState();
        return;
      }
      if (!serverPreview && (this.agentBusy || assistantSpeaking) && !finishingDrainedReply) {
        this.agentVoiceQueuedAfterBusy = true;
        const reason = assistantSpeaking ? "new transcript while agent speaking" : "new transcript while agent busy";
        if (!interruptManagedVoiceTurn(this, reason)) {
          this.invalidateVoicePipeline(reason);
        }
        if (assistantSpeaking) {
          this.interruptAgentSpeech();
          this.transitionVoiceSession("listening", "user transcript interrupted assistant audio");
        }
      }
      if (isFinal) {
        this.voiceSession = appendTurnText(this.voiceSession, transcript);
        this.agentVoiceTurnText = this.voiceSession.turnText;
        this.agentVoiceActivePartial = "";
      } else {
        this.agentVoiceActivePartial = transcript;
      }
      this.agentLiveDraftText = mergeVoiceTurnText(this.agentVoiceTurnText, this.agentVoiceActivePartial);
      this.agentVoiceTurnRevision += 1;
      const rawInput = [this.agentVoiceBaseInput, this.agentLiveDraftText].filter(Boolean).join(this.agentVoiceBaseInput ? "\n" : "");
      this.agentVoiceRawInput = rawInput;
      this.setAgentInput(this.voiceDisplayInput(rawInput));
    },

  handleVoiceControlEvent(this: ViewHost, text: string): void {
      const event = detectVoiceControlEvent(this.voiceDisplayInput(text) || text);
      if (!event) return;
      const now = Date.now();
      this.agentVoiceControlHoldSignature = event.signature;
      this.agentVoiceControlHoldUntil = now + 8000;
      if (event.signature === this.agentVoiceLastControlSignature && now - this.agentVoiceLastControlAt < 1800) {
        return;
      }
      this.agentVoiceLastControlSignature = event.signature;
      this.agentVoiceLastControlAt = now;
      const hasActiveAssistantTurn = this.agentBusy || this.agentSpeaking || this.agentTtsClient || this.agentSpeechSources.size > 0;
      const interruptedManagedTurn = hasActiveAssistantTurn && interruptManagedVoiceTurn(this, "voice repair control event");
      if (hasActiveAssistantTurn) {
        this.agentVoiceQueuedAfterBusy = true;
        if (!interruptedManagedTurn) this.invalidateVoicePipeline("voice repair control event");
      }
      this.clearVoiceAutoSendTimer();
      this.interruptAgentSpeech();
      if (this.voiceSession.phase === "processing" || this.voiceSession.phase === "speaking") {
        this.transitionVoiceSession("listening", "voice repair control event");
      }
      this.agentReply = event.reply;
      this.refreshAgentSurfaceState();
    },

  voiceDisplayInput(this: ViewHost, rawInput: string): string {
      const value = rawInput.trim();
      if (!value || !voiceTriggerEnabled(this.controller.settings)) return value;
      const phrases = parseVoiceTriggerPhrases(this.controller.settings.realtimeVoice.triggerPhrases);
      if (phrases.length === 0) return value;
      return stripVoiceTriggers(value, phrases).text;
    },

  normalizeRealtimeTranscript(this: ViewHost, text: string): string {
      let transcript = text.trim();
      if (!transcript || this.agentMode !== "voice") return transcript;
      if (isEchoTranscript(transcript)) {
        return "";
      }
      if (canRepeatCancelledVoiceInput(this, transcript)) return transcript;

      for (const sent of this.agentVoiceSentTurnTexts) {
        const result = stripVoiceTurnPrefix(transcript, sent);
        if (!result.changed) continue;
        transcript = result.text;
        if (!transcript) {
          return "";
        }
      }

      transcript = stripKnownVoiceTurns(transcript, this.knownVoiceTranscriptFragments()).trim();
      if (!transcript) return "";
      if (performance.now() < this.agentVoiceSelfSpeechIgnoreUntil && looksLikeKnownVoiceEcho(transcript, this.knownVoiceTranscriptFragments())) {
        return "";
      }
      return transcript;
    },

  knownVoiceTranscriptFragments(this: ViewHost): string[] {
      const fragments = new Set<string>();
      const priorMessages = voiceSessionPriorMessages.get(this);
      for (const sent of this.agentVoiceSentTurnTexts) {
        for (const fragment of voiceTranscriptFragments(sent, 2)) fragments.add(fragment);
      }
      for (const message of this.agentMessages.slice(-12)) {
        if (priorMessages?.has(message)) continue;
        for (const fragment of voiceTranscriptFragments(message.content, message.role === "user" ? 2 : 6)) fragments.add(fragment);
      }
      for (const fragment of voiceTranscriptFragments(this.agentReply, 6)) fragments.add(fragment);
      return Array.from(fragments).slice(-80);
    },

  rememberSentVoiceTurn(this: ViewHost, text: string): void {
      const sent = text.trim();
      if (!sent) return;
      this.agentVoiceLastSentText = sent;
      this.agentVoiceLastSentAt = performance.now();
      if (this.agentVoiceSentTurnTexts[this.agentVoiceSentTurnTexts.length - 1] !== sent) {
        this.agentVoiceSentTurnTexts = [...this.agentVoiceSentTurnTexts, sent].slice(-8);
      }
    },

  resetCurrentVoiceTurnDraft(this: ViewHost): void {
      this.clearVoiceAutoSendTimer();
      this.resetVoiceTurnBuffer();
      this.agentRealtimeClient?.resetTranscript();
      this.setAgentInput("");
    },

  startAgentLiveSpeechPreview(this: ViewHost): boolean {
      const speechWindow = window as unknown as {
        SpeechRecognition?: SpeechRecognitionConstructor;
        webkitSpeechRecognition?: SpeechRecognitionConstructor;
      };
      const SpeechRecognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
      if (!SpeechRecognition) return false;

      try {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = this.controller.settings.realtimeVoice.language || "zh-CN";
        const generation = this.agentRealtimeStartGeneration;
        const isCurrent = () => !this.viewClosed && this.agentRealtimeStartGeneration === generation
          && this.agentSpeechRecognition === recognition;
        recognition.onresult = (event) => {
          if (!isCurrent()) return;
          let interim = "";
          for (let index = event.resultIndex; index < event.results.length; index += 1) {
            const result = event.results[index];
            const transcript = result[0]?.transcript ?? "";
            if (result.isFinal) {
              this.agentLiveFinalText += transcript;
            } else {
              interim += transcript;
            }
          }
          const liveText = `${this.agentLiveFinalText}${interim}`.trim();
          if (!liveText) return;
          this.agentLiveDraftText = liveText;
          const rawInput = [this.agentVoiceBaseInput, liveText].filter(Boolean).join(this.agentVoiceBaseInput ? "\n" : "");
          this.agentVoiceRawInput = rawInput;
          this.setAgentInput(this.voiceDisplayInput(rawInput));
        };
        recognition.onerror = () => {
          if (!isCurrent()) return;
          this.agentReply = "本地实时草稿暂不可用，录音停止后会尝试云端转写。";
        };
        this.agentSpeechRecognition = recognition;
        recognition.start();
        return true;
      } catch {
        this.agentSpeechRecognition = null;
        return false;
      }
    },

  stopAgentLiveSpeechPreview(this: ViewHost): void {
      const recognition = this.agentSpeechRecognition;
      this.agentSpeechRecognition = null;
      try {
        if (recognition) {
          recognition.onresult = null;
          recognition.onerror = null;
          recognition.stop();
        }
      } catch {
        // Ignore local speech preview shutdown errors.
      }
      this.agentSpeechRecognition = null;
    },

  setAgentInput(this: ViewHost, value: string): void {
      this.agentInput = value;
      if (this.agentInputEl) {
        this.agentInputEl.value = value;
      }
    },

  speakAgentReply(this: ViewHost, text: string): void {
      if (!text.trim()) {
        this.transitionVoiceSession("listening", "empty speech reply");
        return;
      }
      this.interruptAgentSpeech();
      const realtimeVoice = this.controller.settings.realtimeVoice;
      if (!realtimeVoice.speakReplies) {
        this.agentSpeaking = false;
        this.transitionVoiceSession("listening", "speech replies disabled");
        this.refreshAgentSurfaceState();
        return;
      }
      this.markVoiceTrace("ttsStart");
      const clean = cleanTextForSpeech(text);
      if (!clean) {
        this.transitionVoiceSession("listening", "empty cleaned speech reply");
        this.refreshAgentSurfaceState();
        return;
      }
      addEchoText(clean, 12_000, "tts");
      this.agentVoiceSelfSpeechIgnoreUntil = performance.now() + estimateSpeechGuardMs(clean);
      this.appendVoiceMetric("voice_reply_speaking", {
        textLength: clean.length
      });
      if (realtimeVoice.ttsEngine === "breeze-local" || realtimeVoice.ttsEngine === "breeze-blue" || (realtimeVoice.provider === "qwen-omni-realtime" && realtimeVoice.apiKey.trim())) {
        void this.speakAgentReplyWithBailian(clean);
        return;
      }
      this.speakAgentReplyWithSystem(clean);
    },

  interruptAgentSpeech(this: ViewHost): void {
      const hadActiveSpeech = this.agentSpeaking
        || Boolean(this.agentTtsClient)
        || this.agentSpeechSources.size > 0
        || ("speechSynthesis" in window && window.speechSynthesis.speaking);
      this.agentSpeechPlaybackId += 1;
      window.clearTimeout(this.agentSystemSpeechTimer);
      this.agentSystemSpeechTimer = 0;
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      this.agentVoiceSystemSpeechActive = false;
      this.agentTtsClient?.cancel();
      this.agentTtsClient = null;
      this.cleanupAgentSpeechAudio();
      if (!interruptManagedVoiceTurn(this, "assistant speech interrupted") && this.agentVoiceSendInFlight) {
        this.agentRealtimeClient?.cancelResponse();
      }
      this.agentSpeaking = false;
      if (hadActiveSpeech) {
        this.appendVoiceMetric("voice_speech_interrupted");
      }
      this.refreshAgentSurfaceState();
    },

  speakAgentReplyWithSystem(this: ViewHost, text: string): void {
      if (!this.controller.settings.realtimeVoice.speakReplies) return;
      if (!("speechSynthesis" in window) || !text.trim()) {
        this.agentSpeaking = false;
        this.transitionVoiceSession("listening", "system speech unavailable");
        this.refreshAgentSurfaceState();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      const playbackId = ++this.agentSpeechPlaybackId;
      const isCurrent = () => !this.viewClosed && playbackId === this.agentSpeechPlaybackId;
      utterance.lang = this.controller.settings.realtimeVoice.language || "zh-CN";
      utterance.rate = 1;
      utterance.pitch = 1;
      let started = false;
      const startWatchdog = window.setTimeout(() => {
        if (!isCurrent() || started) return;
        this.agentSpeaking = false;
        this.agentReply = "系统朗读没有启动，请检查 macOS/Obsidian 的音频输出。";
        this.transitionVoiceSession("listening", "system speech did not start");
        this.refreshAgentSurfaceState();
      }, 1800);
      this.agentSystemSpeechTimer = startWatchdog;
      utterance.onstart = () => {
        if (!isCurrent()) return;
        started = true;
        window.clearTimeout(startWatchdog);
        this.agentSpeaking = true;
        this.agentVoiceSelfSpeechIgnoreUntil = performance.now() + estimateSpeechGuardMs(text);
        this.markVoiceTrace("ttsFirstAudio");
        this.refreshAgentSurfaceState();
      };
      utterance.onend = () => {
        if (!isCurrent()) return;
        window.clearTimeout(startWatchdog);
        this.agentSpeaking = false;
        this.markVoiceTrace("ttsDone");
        this.transitionVoiceSession("listening", "system speech ended");
        this.refreshAgentSurfaceState();
      };
      utterance.onerror = () => {
        if (!isCurrent()) return;
        window.clearTimeout(startWatchdog);
        this.agentSpeaking = false;
        this.transitionVoiceSession("listening", "system speech error");
        this.refreshAgentSurfaceState();
      };
      window.speechSynthesis.speak(utterance);
    },

  async speakAgentReplyWithBailian(this: ViewHost, text: string): Promise<void> {
      if (!this.controller.settings.realtimeVoice.speakReplies) return;
      const ttsSettings = { ...this.controller.settings.realtimeVoice };
      const isLocal = ttsSettings.ttsEngine === "breeze-local";
      const isBreeze = isLocal || ttsSettings.ttsEngine === "breeze-blue";
      const playbackId = ++this.agentSpeechPlaybackId;
      let gotAudio = false;
      let fallbackStarted = false;
      let firstAudioTimer = 0;
      let playbackResumeTimer = 0;
      const fallbackToSystem = (reason: string): void => {
        if (playbackId !== this.agentSpeechPlaybackId || fallbackStarted || !this.controller.settings.realtimeVoice.speakReplies) return;
        fallbackStarted = true;
        if (firstAudioTimer) {
          window.clearTimeout(firstAudioTimer);
          firstAudioTimer = 0;
        }
        if (playbackResumeTimer) {
          window.clearTimeout(playbackResumeTimer);
          playbackResumeTimer = 0;
        }
        this.agentTtsClient?.cancel();
        this.agentTtsClient = null;
        this.cleanupAgentSpeechAudio();
        this.agentSpeaking = false;
        if (gotAudio && isBreeze) {
          this.transitionVoiceSession("listening", "speech interrupted");
          this.agentReply = text;
          new Notice(isLocal ? "本地语音未完整播放，完整回复仍可查看文字。" : "语音未完整播放，完整回复仍可查看文字。");
          this.refreshAgentSurfaceState();
          return;
        }
        this.agentReply = `语音回复通道没有出声，已退回系统朗读：${reason}`;
        this.refreshAgentSurfaceState();
        this.speakAgentReplyWithSystem(text);
      };
      try {
        this.cleanupAgentSpeechAudio();
        const client = createTtsClient(ttsSettings, {
          onOpen: () => {
            if (playbackId !== this.agentSpeechPlaybackId || fallbackStarted) return;
            this.agentSpeaking = true;
            firstAudioTimer = window.setTimeout(() => {
              if (!gotAudio) fallbackToSystem("等待首段音频超时");
            }, isBreeze ? 90_000 : 8000);
            this.refreshAgentSurfaceState();
          },
          onAudioDelta: (base64Audio, sampleRate) => {
            if (playbackId !== this.agentSpeechPlaybackId || fallbackStarted) return;
            if (firstAudioTimer) {
              window.clearTimeout(firstAudioTimer);
              firstAudioTimer = 0;
            }
            this.markVoiceTrace("ttsFirstAudio");
            this.agentVoiceSelfSpeechIgnoreUntil = performance.now() + 900;
            const queued = this.enqueueAgentSpeechAudio(base64Audio, sampleRate);
            if (!queued) {
              fallbackToSystem("无法创建音频播放器");
              return;
            }
            gotAudio = true;
            if (this.agentSpeechAudioContext?.state === "suspended" && !playbackResumeTimer) {
              playbackResumeTimer = window.setTimeout(() => {
                playbackResumeTimer = 0;
                if (this.agentSpeechAudioContext?.state === "suspended") {
                  fallbackToSystem("浏览器音频上下文被暂停");
                }
              }, 1800);
            }
          },
          onResponseDone: () => {
            if (playbackId !== this.agentSpeechPlaybackId || fallbackStarted) return;
            if (firstAudioTimer) {
              window.clearTimeout(firstAudioTimer);
              firstAudioTimer = 0;
            }
            if (!gotAudio) {
              fallbackToSystem("百炼没有返回音频");
              return;
            }
            if (playbackResumeTimer && this.agentSpeechAudioContext?.state !== "suspended") {
              window.clearTimeout(playbackResumeTimer);
              playbackResumeTimer = 0;
            }
            this.markVoiceTrace("ttsDone");
            this.agentTtsClient = null;
            window.setTimeout(() => {
              if (playbackId === this.agentSpeechPlaybackId && this.agentSpeechSources.size === 0) {
                this.agentSpeaking = false;
                this.transitionVoiceSession("listening", "bailian speech ended");
                this.refreshAgentSurfaceState();
              }
            }, 120);
          },
          onError: (message) => {
            if (playbackId !== this.agentSpeechPlaybackId || fallbackStarted) return;
            if (isBreeze) { fallbackToSystem(message); return; }
            if (firstAudioTimer) {
              window.clearTimeout(firstAudioTimer);
              firstAudioTimer = 0;
            }
            if (playbackResumeTimer) {
              window.clearTimeout(playbackResumeTimer);
              playbackResumeTimer = 0;
            }
            this.agentTtsClient = null;
            this.cleanupAgentSpeechAudio();
            this.agentSpeaking = false;
            this.transitionVoiceSession("listening", "bailian speech error");
            this.refreshAgentSurfaceState();
            if (this.controller.settings.realtimeVoice.speakReplies) {
              this.speakAgentReplyWithSystem(text);
              new Notice(`百炼语音回复已退回系统朗读：${message}`);
            }
          }
        });
        this.agentTtsClient = client;
        await client.speak(text);
      } catch (error) {
        if (playbackId !== this.agentSpeechPlaybackId || fallbackStarted) return;
        if (gotAudio && isBreeze) {
          fallbackToSystem("语音未完整生成");
          return;
        }
        if (firstAudioTimer) {
          window.clearTimeout(firstAudioTimer);
          firstAudioTimer = 0;
        }
        if (playbackResumeTimer) {
          window.clearTimeout(playbackResumeTimer);
          playbackResumeTimer = 0;
        }
        this.agentTtsClient = null;
        this.cleanupAgentSpeechAudio();
        this.agentSpeaking = false;
        this.transitionVoiceSession("listening", "bailian speech start failed");
        this.refreshAgentSurfaceState();
        if (this.controller.settings.realtimeVoice.speakReplies) {
          this.speakAgentReplyWithSystem(text);
          new Notice(error instanceof Error ? `语音回复启动失败，已退回系统朗读：${error.message}` : "语音回复启动失败，已退回系统朗读。");
        }
      }
    },

  enqueueAgentSpeechAudio(this: ViewHost, base64Audio: string, sampleRate: number): boolean {
      const context = this.ensureAgentSpeechAudioContext();
      if (!context) return false;
      const pcm = base64ToPcm16(base64Audio);
      if (pcm.length === 0) return false;

      const audioBuffer = context.createBuffer(1, pcm.length, sampleRate);
      const channel = audioBuffer.getChannelData(0);
      for (let index = 0; index < pcm.length; index += 1) {
        channel[index] = pcm[index] / 0x8000;
      }

      const source = context.createBufferSource();
      const playbackId = this.agentSpeechPlaybackId;
      source.buffer = audioBuffer;
      source.connect(context.destination);
      const startAt = Math.max(context.currentTime + 0.02, this.agentSpeechAudioCursor || context.currentTime);
      this.agentVoiceSelfSpeechIgnoreUntil = performance.now() + Math.max(900, audioBuffer.duration * 1000 + 250);
      source.onended = () => {
        if (this.viewClosed || playbackId !== this.agentSpeechPlaybackId) return;
        this.agentSpeechSources.delete(source);
        if (this.agentSpeechSources.size === 0 && !this.agentTtsClient) {
          this.agentSpeaking = false;
          this.transitionVoiceSession("listening", "queued speech audio ended");
          this.refreshAgentSurfaceState();
        }
      };
      this.agentSpeechSources.add(source);
      source.start(startAt);
      this.agentSpeechAudioCursor = startAt + audioBuffer.duration;
      this.agentSpeaking = true;
      this.refreshAgentSurfaceState();
      return true;
    },

  ensureAgentSpeechAudioContext(this: ViewHost): AudioContext | null {
      const AudioContextConstructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextConstructor) return null;
      if (!this.agentSpeechAudioContext || this.agentSpeechAudioContext.state === "closed") {
        this.agentSpeechAudioContext = new AudioContextConstructor();
        this.agentSpeechAudioCursor = this.agentSpeechAudioContext.currentTime;
      }
      if (this.agentSpeechAudioContext.state === "suspended") {
        void this.agentSpeechAudioContext.resume().catch(() => undefined);
      }
      return this.agentSpeechAudioContext;
    },

  cleanupAgentSpeechAudio(this: ViewHost): void {
      for (const source of this.agentSpeechSources) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // Ignore stop errors while tearing down queued speech audio.
        }
        source.disconnect();
      }
      this.agentSpeechSources.clear();
      void this.agentSpeechAudioContext?.close().catch(() => undefined);
      this.agentSpeechAudioContext = null;
      this.agentSpeechAudioCursor = 0;
    },

  agentRecordingReply(this: ViewHost, provider: LifeOpsSettings["realtimeVoice"]["provider"], livePreviewStarted: boolean): string {
      if (provider === "browser-live") {
        if (livePreviewStarted) {
          return this.controller.settings.realtimeVoice.autoSendOnStop
            ? "我在听，实验性本地实时草稿会出现在输入框；点击停止后会直接发送给管家。"
            : "我在听，实验性本地实时草稿会出现在输入框；点击停止后你可以再编辑。";
        }
        return "当前 Obsidian 环境不支持本地实时草稿。录音仍会继续，停止后会尝试云端转写 fallback。";
      }
      return "我在听。百炼 Realtime 双向流还在接入前置阶段；本次先录音，停止后会尝试云端转写 fallback。";
    },
};

export function applyComposerPanel(View: ViewConstructor): void {
  Object.assign(View.prototype, composerPanel);
}

function cleanTextForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_\-|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
}

function estimateSpeechGuardMs(text: string): number {
  const chars = Array.from(text.replace(/\s+/g, "")).length;
  return Math.min(18_000, Math.max(1400, chars * 90));
}

function stripVoiceTurnPrefix(text: string, sentTurn: string): { text: string; changed: boolean } {
  const sent = sentTurn.trim();
  const value = text.trim();
  if (!sent || !value) return { text: value, changed: false };

  const candidates = Array.from(new Set([
    sent,
    sent.replace(/[。.!！?？,，;；:：、\s]+$/g, "").trim()
  ])).filter(Boolean);

  for (const candidate of candidates) {
    if (!value.startsWith(candidate)) continue;
    const rest = value
      .slice(candidate.length)
      .replace(/^[。.!！?？,，;；:：、\s]+/g, "")
      .trim();
    return { text: rest, changed: true };
  }

  return { text: value, changed: false };
}

function stripKnownVoiceTurns(text: string, sentTurns: string[]): string {
  let value = text.trim();
  for (const sent of sentTurns) {
    const normalizedSent = normalizeVoiceTriggerText(sent).value;
    if (!normalizedSent) continue;

    let guard = 0;
    while (guard < 4) {
      guard += 1;
      const normalizedValue = normalizeVoiceTriggerText(value);
      const index = normalizedValue.value.indexOf(normalizedSent);
      if (index < 0) break;
      const endIndex = index + normalizedSent.length - 1;
      const start = normalizedValue.map[index]?.start ?? 0;
      const end = normalizedValue.map[endIndex]?.end ?? value.length;
      value = `${value.slice(0, start)} ${value.slice(end)}`
        .replace(/^[\s,，。.!！?？:：;；\-—、]+/u, "")
        .replace(/[\s,，。.!！?？:：;；\-—、]+$/u, "")
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  return value;
}

function looksLikeKnownVoiceEcho(text: string, fragments: string[]): boolean {
  const normalized = normalizeVoiceTriggerText(text).value;
  if (!normalized) return false;
  return fragments.some((fragment) => {
    const known = normalizeVoiceTriggerText(fragment).value;
    if (known.length < 6) return false;
    return known.includes(normalized) || normalized.includes(known.slice(0, Math.min(known.length, 24)));
  });
}

function metricLabel(label: string, start: number | undefined, end: number | undefined): string {
  if (!start || !end) return "";
  return `${label} ${Math.max(0, Math.round(end - start))}ms`;
}

function traceDelta(start: number | undefined, end: number | undefined): number | undefined {
  if (!start || !end) return undefined;
  return Math.max(0, Math.round(end - start));
}
