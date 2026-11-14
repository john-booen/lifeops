import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import { recordSpeakerPhrase } from "./voice/continuousInput";
import { BailianRealtimeClient } from "./bailianRealtime";
import { BailianRealtimeTtsClient } from "./bailianTtsRealtime";
import type { AiToolCall } from "./ai";
import { addDays, todayString, weekDates } from "./date";
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
  stripVoiceControlPhrases,
  voiceEndpointDelayMs
} from "./voiceSession";
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
} from "./voiceSession";
import {
  findVoiceTrigger,
  normalizeVoiceTriggerText,
  parseVoiceTriggerPhrases,
  stripVoiceTriggers,
  voiceTranscriptFragments,
  voiceTriggerEnabled,
  voiceTriggerLabel,
  voiceTriggerTimeoutSec
} from "./voice/voiceTrigger";
import {
  base64ToPcm16,
  handleOmniE2eBargeInEvent,
  handleOmniE2eAudioOutputEvent,
  startBailianRealtimeRecording as startBailianRealtimeRecordingFlow,
  stopBailianRealtimeRecording as stopBailianRealtimeRecordingFlow,
  voiceJobsForPanel
} from "./voice/voiceRealtime";
import { AudioOutputActor } from "./voice/audioOutput";
import { VoiceBargeInController } from "./voice/voiceBargeIn";
import { VoiceE2eCircuitBreaker } from "./voice/voiceCircuitBreaker";
import { VoiceRuntimeJournal, VoiceSessionController } from "./voice/voiceRuntime";
import type { VoicePhase, VoiceSessionState } from "./voiceSession";
import type { ProactiveCandidate } from "./scheduler";
import type { ProactiveFeedbackDecision } from "./proactivePolicy";
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
} from "./types";
import { applyComposerPanel, type ComposerPanelApi } from "./panel/composer";
import { applyMessageListPanel, cancelMessageListRequest, type MessageListPanelApi } from "./panel/messageList";
import { applyStatusBarPanel, type StatusBarPanelApi } from "./panel/statusBar";
import type { LifeOpsAgentVisual } from "./panel/agentVisual";
import { applySuggestionsPanel, type SuggestionsPanelApi } from "./panel/suggestions";
import { mergePendingAgentActions, PENDING_ACTION_CONFLICT_NOTICE } from "./pendingAgentActions";
import { renderStewardShell, type StewardPage } from "./panel/stewardShell";
import { mountNeuralHomeView, type NeuralHomeOptions } from "./panel/neuralHomeView";
import type { JournalPlanChoice, TodayCardData } from "./features/today/model";
import type { NeuralDomain } from "./panel/neuralRecordsModel";
import { renderStewardAbout, openStewardOperations, type StewardRecordsController } from "./panel/stewardRecords";
import type { LocalRecordKind } from "./localRecordNotes";
import { mountNeuralRecordsView } from "./panel/neuralRecordsView";
import type { ReadonlyRecordLibrary } from "./readonlyRecordLibrary";


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
};

export interface LifeOpsViewController extends StewardRecordsController {
  settings: LifeOpsSettings;
  openQuickCapture(): void;
  openLocalRecordNote(kind: LocalRecordKind, date?: string): Promise<void>;
  openLocalRecordPicker(): void;
  createRecordLibrary?(): ReadonlyRecordLibrary;
  openTaskModal(): void;
  openProjectBoard?(): void;
  openTradingResearch?():void;
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
  appendAgentConversation?(userMessage: string, assistantReply: string, isCurrent?: () => boolean): Promise<void>;
  buildAgentInjectedContextBlock?(): Promise<string>;
  buildVoiceSessionContextBlock?(): Promise<string>;
  collectVoiceSessionHotwords?(configured: string | undefined): Promise<string[]>;
  executeAgentToolCall(toolCall: AiToolCall, userMessage?: string): Promise<AgentResponse>;
  executeAgentAction(action: AgentActionSuggestion): Promise<void | string>;
  appendAgentActionReceipt?(title: string, receipt: string): Promise<boolean>;
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
  getTodayCard?(board: TaskDashboardData): Promise<TodayCardData>;
  addJournalPlanTask?(plan: JournalPlanChoice): Promise<void>;
  correctYesterdayHabit?(taskId: string): Promise<void>;
  mountIdeaPanel?(container: HTMLElement): () => Promise<void>;
  mountLearningPanel?(container: HTMLElement): () => Promise<void>;
  openIdeaCandidates?(): void;
  getProactiveCandidates(): Promise<ProactiveCandidate[]>;
  respondToProactiveCandidate(candidateId: string, decision: ProactiveFeedbackDecision): Promise<void>;
}

export class LifeOpsView extends ItemView {
  private mode: LifeOpsMode = "tasks";
  private taskFilter: TaskFilter = "today";
  private calendarMode: "month" | "week" | "day" = "month";
  private calendarDate = todayString();
  private selectedCalendarDate = todayString();
  private expandedHabitId = "";
  private taskSearch = "";
  private agentVisual: LifeOpsAgentVisual | null = null;
  private agentMode: "voice" | "text" = "text";
  private agentInput = "";
  private agentReply = "我会在这里陪你梳理任务、复盘和灵感。";
  private agentWorkspaceOpen = true;
  private agentMessages: AgentConversationMessage[] = [];
  private voiceJobsEl?: HTMLDetailsElement;
  private agentBusy = false;
  private agentBusySince = 0;
  private agentRecording = false;
  private agentVoiceConversation = false;
  private pendingAgentActions: AgentActionSuggestion[] = [];
  private proactiveCandidates: ProactiveCandidate[] = [];
  private agentRecorder: MediaRecorder | null = null;
  private agentStream: MediaStream | null = null;
  private agentAudioChunks: BlobPart[] = [];
  private agentTranscriptionAbortController: AbortController | null = null;
  private agentRealtimeClient: BailianRealtimeClient | null = null;
  private agentAudioContext: AudioContext | null = null;
  private agentAudioSource: MediaStreamAudioSourceNode | null = null;
  private agentAudioProcessor: ScriptProcessorNode | null = null;
  private agentAudioWorklet: AudioWorkletNode | null = null;
  private agentAudioWorkletUrl = "";
  private agentInputEl: HTMLTextAreaElement | null = null;
  private agentSpeechRecognition: SpeechRecognitionLike | null = null;
  private agentTtsClient: BailianRealtimeTtsClient | null = null;
  private agentSpeechAudioContext: AudioContext | null = null;
  private agentSpeechAudioCursor = 0;
  private agentSpeechPlaybackId = 0;
  private agentSystemSpeechTimer = 0;
  private readonly agentSpeechSources = new Set<AudioBufferSourceNode>();
  private readonly agentVoiceRuntime: VoiceSessionController;
  private readonly agentAudioOutput: AudioOutputActor;
  private readonly agentVoiceBargeIn: VoiceBargeInController;
  private readonly agentVoiceCircuitBreaker: VoiceE2eCircuitBreaker;
  private agentOmniPlaybackReady: Promise<void> | null = null;
  private agentOmniPendingAudio: Array<{ pcm: Int16Array; sampleRate: number; cue?: string }> = [];
  private agentVoiceResponseTimer = 0;
  private agentVoiceFallbackTimer = 0;
  private agentVoiceReconnectTimer = 0;
  private agentVoiceReconnectAttempts = 0;
  private agentVoiceFallbackReason = "";
  private agentVoiceSystemSpeechActive = false;
  private agentVoiceTrace: VoiceTrace = {};
  private agentVoiceTraceLabel = "";
  private agentVoiceBaseInput = "";
  private agentVoiceRawInput = "";
  private agentLiveFinalText = "";
  private agentLiveDraftText = "";
  private agentVoiceTurnText = "";
  private agentVoiceActivePartial = "";
  private agentVoiceTurnRevision = 0;
  private agentVoiceSelfSpeechIgnoreUntil = 0;
  private agentVoiceReady = false;
  private agentVoiceWarmupTimer = 0;
  private agentVoiceLastTranscriptAt = 0;
  private agentVoiceQueuedAfterBusy = false;
  private agentVoiceConsumingQueue = false;
  private agentVoiceSendInFlight = false;
  private agentVoiceLastSentText = "";
  private agentVoiceLastSentAt = 0;
  private agentVoiceSentTurnTexts: string[] = [];
  private agentVoicePipelineGeneration = 0;
  private agentVoiceControlHoldSignature = "";
  private agentVoiceControlHoldUntil = 0;
  private agentVoiceLastControlSignature = "";
  private agentVoiceLastControlAt = 0;
  private agentVoiceLocalSpeechActive = false;
  private agentVoiceLocalSpeechStartedAt = 0;
  private agentVoiceLocalLastSpeechAt = 0;
  private agentVoiceLocalEndpointTimer = 0;
  private agentVoiceNoTranscriptTimer = 0;
  private agentVoiceIgnoreSpeechStartUntil = 0;
  private voiceSession: VoiceSessionState = createVoiceSession();
  private agentVoiceAutoSendTimer = 0;
  private agentVoiceTriggerActiveUntil = 0;
  private agentSpeaking = false;
  private agentOmniE2eAssistantIndex = -1;
  private agentOmniE2eStreamMessageEl: HTMLElement | null = null;
  private agentOmniE2eReply = "";
  private agentOmniE2eActionSuggestions = 0;
  private agentOmniE2eUserMessage = "";
  private renderVersion = 0;
  private viewClosed = false;
  private agentTextRequestGeneration = 0;
  private agentRealtimeStartGeneration = 0;
  private stewardPage: StewardPage = "today";
  private stewardShell: ReturnType<typeof renderStewardShell> | null = null;
  private stewardRecordsView: ReturnType<typeof mountNeuralRecordsView> | null = null;
  private refreshIdeaPanel?: () => Promise<void>;
  private refreshLearningPanel?: () => Promise<void>;
  private stewardHomeView: ReturnType<typeof mountNeuralHomeView> | null = null;
  private stewardRecordsDomain: NeuralDomain | undefined;
  private stewardScroll = new Map<string, { top: number; left: number }>();
  private stewardRenderedKey = "";
  private stewardControlsEl: HTMLElement | null = null;
  private stewardMediaEl: HTMLElement | null = null;
  private stewardSummaryEl: HTMLElement | null = null;
  private stewardConversationNoteEl: HTMLElement | null = null;
  private stewardLastStats: DashboardStats | null = null;
  private stewardLastBoard: TaskDashboardData | null = null;
  private renderedView: { mode: LifeOpsMode; agentWorkspaceOpen: boolean } | null = null;
  private agentTranscriptEl: HTMLElement | null = null;
  private agentSurfaceEl: HTMLElement | null = null;
  private agentVisualWrapEl: HTMLElement | null = null;
  private agentStatusEl: HTMLElement | null = null;
  private agentTraceEl: HTMLElement | null = null;
  private agentSuggestionsEl: HTMLElement | null = null;
  private agentReplyEl: HTMLElement | null = null;
  private agentComposerContainerEl: HTMLElement | null = null;
  private agentModeButtons: HTMLButtonElement[] = [];

  constructor(leaf: WorkspaceLeaf, private readonly controller: LifeOpsViewController) {
    super(leaf);
    this.agentVoiceRuntime = new VoiceSessionController({
      provider: "qwen-omni-realtime",
      journal: new VoiceRuntimeJournal(500)
    });
    this.agentAudioOutput = new AudioOutputActor({
      onEvent: (event) => handleOmniE2eAudioOutputEvent(this, event)
    });
    this.agentVoiceBargeIn = new VoiceBargeInController({
      onEvent: (event) => handleOmniE2eBargeInEvent(this, event)
    });
    this.agentVoiceCircuitBreaker = new VoiceE2eCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 60_000
    });
  }

  speakStewardReminder(message: string): void {
    const state = this.agentVoiceRuntime.snapshot();
    const activeTurn = state.currentTurn && !["completed", "interrupted", "failed"].includes(state.currentTurn.phase);
    if (this.viewClosed || state.sessionPhase !== "listening" || activeTurn || state.inputQueue.length || this.agentSpeaking
      || this.agentVoiceLocalSpeechActive || typeof window.speechSynthesis === "undefined"
      || typeof SpeechSynthesisUtterance === "undefined" || window.speechSynthesis.speaking || window.speechSynthesis.pending) return;
    const text = message.slice(0, 140);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = this.controller.settings.realtimeVoice.language || "zh-CN";
    addEchoText(text, 12_000, "tts");
    recordSpeakerPhrase(this, text);
    window.speechSynthesis.speak(utterance);
  }

  getViewType(): string {
    return LIFEOPS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "LifeOps";
  }

  getIcon(): string {
    return "layout-dashboard";
  }

  async onOpen(): Promise<void> {
    this.viewClosed = false;
    await this.render();
  }

  async onClose(): Promise<void> {
    this.viewClosed = true;
    this.stewardHomeView?.destroy();
    this.stewardHomeView = null;
    this.stewardRecordsView?.destroy();
    this.stewardRecordsView = null;
    this.renderVersion += 1;
    cancelMessageListRequest(this);
    this.agentTextRequestGeneration += 1;
    this.setAgentBusy(false);
    window.clearTimeout(this.agentVoiceResponseTimer);
    window.clearTimeout(this.agentVoiceFallbackTimer);
    window.clearTimeout(this.agentVoiceReconnectTimer);
    this.agentVisual?.dispose();
    this.stopAgentRecording(true);
    this.interruptAgentSpeech();
    this.agentVoiceBargeIn.reset("view_closed");
    await this.agentAudioOutput.close();
  }

  invalidateVoiceSettings(): void {
    this.refreshVoiceJobs();
    const active = this.agentMode === "voice" || this.agentRecording || this.agentSpeaking
      || this.agentRealtimeClient || this.agentStream || this.agentVoiceReconnectTimer
      || (this.agentVoiceRuntime && this.agentVoiceRuntime.snapshot().sessionPhase !== "stopped");
    if (!active) return;
    cancelMessageListRequest(this);
    this.agentTextRequestGeneration += 1;
    this.agentRealtimeStartGeneration += 1;
    this.agentVoiceConversation = false;
    this.agentVoiceRuntime?.stop();
    window.clearTimeout(this.agentVoiceResponseTimer);
    window.clearTimeout(this.agentVoiceFallbackTimer);
    window.clearTimeout(this.agentVoiceReconnectTimer);
    this.agentVoiceResponseTimer = this.agentVoiceFallbackTimer = this.agentVoiceReconnectTimer = 0;
    this.agentVoiceReconnectAttempts = 0;
    this.stopVoiceStandby();
    this.stopAgentRecording(true);
    this.agentVoiceSendInFlight = false;
    this.agentVoiceQueuedAfterBusy = false;
    this.agentOmniPlaybackReady = null;
    this.agentOmniPendingAudio = [];
    this.voiceSession = createVoiceSession();
    this.setAgentBusy(false);
    this.agentMode = "text";
    this.agentReply = "语音配置或发送授权已变更，本次语音已停止。需要时请重新点击语音开始；已保存的记录保持不变。";
    this.refreshAgentModeUi();
  }

  async render(): Promise<void> {
    if (this.viewClosed) return;
    const renderVersion = ++this.renderVersion;
    this.ensureStewardShell();
    let stats: DashboardStats;
    let board: TaskDashboardData;
    let todayCard: TodayCardData | undefined;
    try {
      const result = await Promise.all([
        this.controller.getStats(), this.controller.getTaskDashboard(),
        this.controller.getProactiveCandidates()
      ]);
      if (this.viewClosed || renderVersion !== this.renderVersion) return;
      [stats, board] = result;
      if (this.stewardPage === "today" && this.controller.getTodayCard) {
        todayCard = await this.controller.getTodayCard(board).catch(() => undefined);
        if (this.viewClosed || renderVersion !== this.renderVersion) return;
      }
      this.proactiveCandidates = result[2].slice(0, 3);
    } catch {
      if (this.viewClosed || renderVersion !== this.renderVersion) return;
      const shell = this.stewardShell!;
      shell.utilityHost.querySelector(".lifeops-steward-load-error")?.remove();
      const failure = shell.utilityHost.createDiv({ cls: "lifeops-steward-load-error", attr: { role: "alert" } });
      failure.createSpan({ text: "资料暂时没有读好，已有内容已保留。" });
      this.toolButton(failure, "refresh-cw", "重新读取", () => this.render());
      if (this.stewardPage === "chat" && !this.agentSurfaceEl) this.renderStewardConversation(shell.conversationHost);
      new Notice("LifeOps 资料读取未完成，请重试或检查恢复状态。");
      return;
    }
    this.stewardShell!.utilityHost.querySelector(".lifeops-steward-load-error")?.remove();
    this.stewardLastStats = stats;
    this.stewardLastBoard = board;
    const shell = this.stewardShell!;
    shell.setPage(this.stewardPage);
    const key = this.stewardPage === "affairs" ? `affairs:${this.mode}` : this.stewardPage;
    const main = shell.main;
    if (this.stewardRenderedKey && this.stewardPage !== "chat") {
      this.stewardScroll.set(this.stewardRenderedKey, { top: main.scrollTop, left: main.scrollLeft });
    }
    const focusedFilter = main.ownerDocument.activeElement instanceof HTMLElement
      ? main.ownerDocument.activeElement.dataset.lifeopsTaskFilter : undefined;
    const activeElement = main.ownerDocument.activeElement;
    const focusedAffairsMode = activeElement && main.contains(activeElement)
      ? activeElement.getAttribute("data-lifeops-affairs-mode") : null;
    const focusedSearch = main.querySelector<HTMLInputElement>(".lifeops-task-search");
    const restoreSearchFocus = focusedSearch === main.ownerDocument.activeElement;
    const searchSelection = focusedSearch ? [focusedSearch.selectionStart, focusedSearch.selectionEnd] : null;
    this.contentEl.toggleClass("is-calendar-mode", this.stewardPage === "affairs" && this.mode === "calendar");
    if (this.stewardPage !== "chat") {
      // Keep the records surface on ordinary refresh so selection, focus and
      // scrolling survive. The live assistant/media host is a separate sibling.
      const keepRecords = this.stewardPage === "records" && !!this.stewardRecordsView;
      const keepHome = this.stewardPage === "today" && !!this.stewardHomeView;
      if (!keepRecords && !keepHome) {
        this.stewardRecordsView?.destroy();
        this.stewardRecordsView = null;
        this.stewardHomeView?.destroy();
        this.stewardHomeView = null;
        main.empty();
      }
      if (this.stewardPage === "today") {
        const homeOptions: NeuralHomeOptions = {
          stats, board, todayCard, onAddJournalPlan: this.controller.addJournalPlanTask?.bind(this.controller),
          onCorrectYesterdayHabit: this.controller.correctYesterdayHabit?.bind(this.controller),
          onReviewIdeas: this.controller.openIdeaCandidates?.bind(this.controller),
          onOpenTasks: filter => {
            this.mode = "tasks"; this.taskFilter = filter as TaskFilter;
            void this.navigateSteward("affairs");
          }, onOpenHabits: () => { this.mode = "habits"; void this.navigateSteward("affairs"); },
          onQuickCapture: () => this.controller.openQuickCapture(), onChat: () => void this.navigateSteward("chat"),
          onOpenRecord: kind => { void this.controller.openLocalRecordNote(kind).catch(() => undefined); },
          onRecordPicker: () => this.controller.openLocalRecordPicker(),
          onNewTask: () => this.controller.openTaskModal(),
          onOpenLibrary: domain => { void this.navigateSteward("records", domain); }
        };
        if (this.stewardHomeView) this.stewardHomeView.update(homeOptions);
        else this.stewardHomeView = mountNeuralHomeView(main, homeOptions);
        this.stewardHomeView.setActive(true);
      } else if (this.stewardPage === "affairs") {
        this.renderStewardAffairs(main, stats, board);
      } else if (this.stewardPage === "records") {
        if (!keepRecords) this.renderRecordLibrary(main);
        else {
          void this.refreshIdeaPanel?.();
          void this.refreshLearningPanel?.();
        }
      } else {
        const about = main.createDiv({ cls: "lifeops-steward-about" });
        const reviewGeneration = this.agentTextRequestGeneration;
        void renderStewardAbout(about, this.controller, actions => {
          if (this.viewClosed || this.agentTextRequestGeneration !== reviewGeneration) return;
          const merged = mergePendingAgentActions(this.pendingAgentActions, actions);
          this.pendingAgentActions = merged.actions;
          if (merged.conflictingIds.length) new Notice(PENDING_ACTION_CONFLICT_NOTICE);
          void this.openStewardPending();
        });
      }
      this.stewardRenderedKey = key;
      const scroll = this.stewardScroll.get(key);
      main.scrollTop = scroll?.top ?? 0;
      main.scrollLeft = scroll?.left ?? 0;
      if (focusedAffairsMode && this.stewardPage === "affairs") {
        Array.from(main.querySelectorAll<HTMLButtonElement>("[data-lifeops-affairs-mode]"))
          .find(button => button.dataset.lifeopsAffairsMode === focusedAffairsMode)?.focus({ preventScroll: true });
      }
      if (focusedFilter && key === "affairs:tasks") {
        main.querySelector<HTMLButtonElement>(`[data-lifeops-task-filter="${focusedFilter}"]`)?.focus({ preventScroll: true });
      }
      if (restoreSearchFocus) {
        const next = main.querySelector<HTMLInputElement>(".lifeops-task-search");
        next?.focus({ preventScroll: true });
        if (next && searchSelection && searchSelection[0] !== null && searchSelection[1] !== null) {
          try { next.setSelectionRange(searchSelection[0], searchSelection[1]); } catch { /* search inputs vary by host */ }
        }
      }
    } else if (!this.agentSurfaceEl) {
      this.renderStewardConversation(shell.conversationHost);
    }
    this.refreshAgentSurfaceState();
    this.refreshAgentSuggestions();
  }

  private ensureStewardShell(): void {
    if (this.stewardShell) return;
    this.contentEl.empty();
    this.contentEl.addClass("lifeops-view");
    this.contentEl.removeClass("has-agent-workspace");
    this.stewardShell = renderStewardShell(this.contentEl, {
      page: this.stewardPage, pendingCount: this.pendingAgentActions.length,
      onNavigate: page => void this.navigateSteward(page), onPending: () => void this.openStewardPending(),
      onOperations: () => openStewardOperations(this.app, this.controller),
      onSettings: () => this.controller.openStewardSettings()
    });
    this.stewardMediaEl = this.stewardShell.utilityHost.createDiv({ cls: "lifeops-steward-media-status", attr: { "aria-live": "polite" } });
  }

  private async navigateSteward(page: StewardPage, recordsDomain?: NeuralDomain): Promise<void> {
    if (this.viewClosed) return;
    if (this.stewardShell && this.stewardRenderedKey && this.stewardPage !== "chat") {
      this.stewardScroll.set(this.stewardRenderedKey, { top: this.stewardShell.main.scrollTop, left: this.stewardShell.main.scrollLeft });
    }
    this.stewardPage = page;
    this.stewardRecordsDomain = page === "records" ? recordsDomain : undefined;
    if (page === "records" && recordsDomain && this.stewardRecordsView) {
      // Apply now, before awaiting the dashboard. A later reader selection wins.
      void this.stewardRecordsView.model.setDomain(recordsDomain);
    }
    if (page !== "today") {
      this.stewardHomeView?.destroy();
      this.stewardHomeView = null;
    }
    if (page !== "records") {
      this.stewardRecordsView?.destroy();
      this.stewardRecordsView = null;
      this.refreshIdeaPanel = undefined;
      this.refreshLearningPanel = undefined;
    }
    this.stewardShell?.setPage(page);
    await this.render();
  }

  private renderRecordLibrary(container: HTMLElement): void {
    this.refreshIdeaPanel = this.controller.mountIdeaPanel?.(container);
    this.refreshLearningPanel = this.controller.mountLearningPanel?.(container);
    if (!this.controller.createRecordLibrary) {
      container.createEl("p", { text: "记录库暂时无法读取，请使用事务中的原记录入口。", cls: "lifeops-muted" });
      return;
    }
    const adapter = this.controller.createRecordLibrary();
    this.stewardRecordsView = mountNeuralRecordsView(container, adapter, {
      embedded: true,
      initialDomain: this.stewardRecordsDomain,
      onReturn: () => { void this.navigateSteward("affairs"); },
      onOpenRelation: (relation, context) => adapter.openRelation(context.recordId, relation.id, {
        signal: context.signal,
        assertCurrent: () => {
          if (this.viewClosed || this.stewardPage !== "records"
            || this.stewardRecordsView?.model.getState().detail?.id !== context.recordId) throw Error("记录选择已变化。");
        }
      })
    });
  }

  async openConversationDraft(message: string, assertCurrent: () => void): Promise<void> {
    if (this.viewClosed || this.agentBusy) throw new Error("对话正在处理或已经关闭，请稍后再试。");
    assertCurrent(); await this.navigateSteward("chat"); assertCurrent();
    if (this.viewClosed || this.agentBusy || this.agentInput.trim()) throw new Error("对话中已有未发送文字，请先保留或发送，再准备这条请求。");
    this.setAgentInput(message); this.agentInputEl?.focus();
  }

  private renderStewardAffairs(container: HTMLElement, stats: DashboardStats, board: TaskDashboardData): void {
    const page = container.createDiv({ cls: "lifeops-neural-affairs", attr: { "data-affairs-mode": this.mode } });
    const heading = page.createDiv({ cls: "la-heading" });
    const copy = heading.createDiv({ cls: "la-heading-copy" });
    copy.createEl("p", { text: board.date, cls: "la-eyebrow" });
    copy.createEl("h1", { text: "把事情安排清楚", cls: "lifeops-steward-page-title" });
    copy.createEl("p", { text: "任务、习惯和日历共用同一份资料。", cls: "lifeops-muted" });
    const actions = heading.createDiv({ cls: "lifeops-toolbar-actions lifeops-affairs-actions" });
    if (this.controller.openProjectBoard) this.toolButton(actions, "folder-kanban", "目标与项目", () => this.controller.openProjectBoard!());
    if (this.mode === "habits") {
      this.toolButton(actions, "badge-plus", "新建习惯", () => this.controller.openHabitModal(), true);
    } else {
      this.toolButton(actions, "plus", "新建任务", () => this.mode === "tasks"
        ? this.controller.openTaskModalWithDefaults(this.defaultsForFilter(board))
        : this.controller.openTaskModal(), true);
    }
    const records = actions.createEl("details", { cls: "lifeops-affairs-record-menu" });
    records.createEl("summary", { text: "日记与其他记录" });
    const recordActions = records.createDiv({ cls: "lifeops-affairs-record-actions" });
    this.toolButton(recordActions, "sunrise", "晨间日记", () => this.controller.openLocalRecordNote("morning"));
    this.toolButton(recordActions, "moon", "晚间日记", () => this.controller.openLocalRecordNote("evening"));
    this.toolButton(recordActions, "notebook-pen", "写交易复盘", () => this.controller.openLocalRecordNote("trading-review"));
    if(this.controller.openTradingResearch)this.toolButton(recordActions,"book-open","模型版本与案例",()=>this.controller.openTradingResearch!());
    this.toolButton(recordActions, "calendar-days", "按日期打开记录", () => this.controller.openLocalRecordPicker());
    this.toolButton(recordActions, "inbox", "快速记录", () => this.controller.openQuickCapture());
    this.toolButton(recordActions, "heart-pulse", "健康记录", () => this.controller.openHealthEntryModal());
    this.toolButton(recordActions, "notebook-pen", "记录交易", () => this.controller.openTradeEntryModal());
    this.toolButton(actions, "refresh-cw", "刷新", () => this.render());
    this.renderModeNav(page);
    const body = page.createDiv({ cls: "la-body" });
    if (this.mode === "tasks") this.renderTasks(body, board);
    if (this.mode === "matrix") this.renderMatrix(body, board);
    if (this.mode === "habits") this.renderHabits(body, board, stats);
    if (this.mode === "calendar") this.renderCalendar(body, board);
    const details = page.createEl("details", { cls: "lifeops-steward-records" });
    details.createEl("summary", { text: "记录、资料与复盘" });
    this.toolButton(details, "file-text", "AI 生成日报", () => this.controller.generateDailyReview());
    this.toolButton(details, "candlestick-chart", "AI 生成交易复盘", () => this.controller.generateTradingReview());
    const sources = [
      ...(stats.morningNoteExists ? [stats.morningNotePath] : []), ...(stats.eveningNoteExists ? [stats.eveningNotePath] : []),
      ...stats.recentThinkingNotes, ...stats.recentTradingReviews, ...stats.recentOutputs
    ];
    for (const path of [...new Set(sources)].slice(0, 12)) {
      this.toolButton(details, "file", path.split("/").pop() ?? path, async () => {
        try { await this.controller.openStewardSource(path); }
        catch { new Notice("这份来源暂时无法打开，请在仓库中核对原文。"); }
      });
    }
    if (sources.length === 0) details.createEl("p", { text: "还没有可展示的最近记录。你可以从“快速记录”开始。", cls: "lifeops-muted" });
  }

  private renderStewardConversation(container: HTMLElement): void {
    this.agentWorkspaceOpen = true;
    const surface = container.createDiv({ cls: "lifeops-agent-workspace lifeops-steward-conversation-surface lifeops-neural-chat" });
    this.agentSurfaceEl = surface;
    const head = surface.createDiv({ cls: "lifeops-steward-conversation-header" });
    head.createEl("p", { text: "对话", cls: "lc-eyebrow" });
    head.createEl("h1", { text: "我们接着聊。" });
    this.stewardSummaryEl = head.createDiv({ cls: "lifeops-muted" });
    this.stewardControlsEl = head.createDiv({ cls: "lifeops-steward-conversation-controls" });
    const visual = surface.createDiv({ cls: "lifeops-steward-camera" });
    this.agentVisualWrapEl = visual;
    this.agentStatusEl = visual.createDiv({ cls: "lifeops-agent-kicker", attr: { role: "status" } });
    this.agentTraceEl = visual.createDiv({ cls: "lifeops-agent-context" });
    const thread = surface.createDiv({ cls: "lc-thread" });
    this.agentTranscriptEl = thread.createDiv({ cls: "lifeops-agent-transcript", attr: { role: "log", "aria-label": "与管家的对话" } });
    if (this.agentMessages.length === 0) this.renderAgentMessage(this.agentTranscriptEl, { role: "assistant", content: this.agentReply });
    else for (const message of this.agentMessages) this.renderAgentMessage(this.agentTranscriptEl, message);
    this.voiceJobsEl = thread.createEl("details", { cls: "lifeops-voice-jobs" });
    this.refreshVoiceJobs();
    this.renderAgentSuggestions(thread);
    this.renderAgentComposer(thread.createDiv({ cls: "lifeops-agent-workspace-composer" }));
    this.stewardConversationNoteEl = thread.createDiv({ cls: "lifeops-muted lifeops-steward-conversation-note" });
    this.refreshStewardControls();
  }

  private refreshVoiceJobs(): void {
    const panel = this.voiceJobsEl;
    if (!panel) return;
    const jobs = voiceJobsForPanel(this);
    if (panel.hidden && jobs.length) panel.open = true;
    panel.hidden = jobs.length === 0;
    panel.empty();
    panel.createEl("summary", { text: `语音后台任务（${jobs.length}）` });
    for (const job of jobs.reverse()) {
      const status = { running: "处理中", done: "已完成", cancelled: "已取消", failed: "未完成" }[job.status];
      const entry = panel.createEl("section");
      entry.createEl("h4", { text: `${job.title} · ${status}` });
      if (job.result) this.renderAgentMessage(entry, { role: "assistant", content: job.result });
    }
  }

  private refreshStewardControls(): void {
    const controls = this.stewardControlsEl;
    if (!controls) return;
    if (controls.childElementCount > 0) {
      for (const button of this.agentModeButtons) button.toggleClass("is-active", button.dataset.agentMode === this.agentMode);
      return;
    }
    this.agentModeButtons = [];
    this.agentModeButton(controls, "keyboard", "文字", "text");
    this.agentModeButton(controls, "mic", "语音", "voice");
    const fresh = controls.createEl("button", { text: "换一次聊天", cls: "lifeops-steward-new-chat" });
    fresh.disabled = this.agentBusy || this.agentRecording || this.agentSpeaking;
    fresh.onclick = () => {
      if (this.agentBusy || this.agentRecording || this.agentSpeaking) return;
      cancelMessageListRequest(this);
      this.agentTextRequestGeneration += 1;
      this.agentMessages = [];
      this.agentReply = "这次从哪里开始？已保存的记录和个人记忆仍会按问题读取。";
      this.agentTranscriptEl?.empty();
      if (this.agentTranscriptEl) this.renderAgentMessage(this.agentTranscriptEl, { role: "assistant", content: this.agentReply });
      this.refreshStewardStatus();
    };
  }

  refreshStewardStatus(): void {
    if (!this.stewardShell || this.viewClosed) return;
    this.stewardShell.updatePendingCount(this.pendingAgentActions.length);
    const active = this.agentRecording || this.agentSpeaking;
    if (this.stewardMediaEl) {
      this.stewardMediaEl.hidden = !active;
      if (active && this.stewardMediaEl.childElementCount === 0) {
        this.stewardMediaEl.createSpan();
        const stop = this.stewardMediaEl.createEl("button", { text: "停止语音和画面" });
        stop.onclick = () => {
          this.stopVoiceStandby();
          this.agentMode = "text"; this.refreshAgentModeUi(); this.refreshStewardStatus();
        };
      }
      const label = this.stewardMediaEl.querySelector("span");
      if (label) label.textContent = `${this.agentRecording ? "语音正在运行" : this.agentSpeaking ? "正在播放回复" : ""}`;
    }
    if (this.stewardSummaryEl && this.stewardLastBoard && this.stewardLastStats) {
      this.stewardSummaryEl.setText(`${this.stewardLastBoard.today.length} 项今日待办 · ${this.stewardLastStats.habitDone}/${this.stewardLastStats.habitTotal} 习惯打卡`);
    }
    if (this.stewardConversationNoteEl) this.stewardConversationNoteEl.setText(this.agentBusy ? "正在处理，可以切页查看其他事情。" : "⌘ / Ctrl + Enter 发送。资料修改需按适用确认执行。" );
    this.refreshStewardControls();
    this.stewardControlsEl?.querySelector<HTMLButtonElement>(".lifeops-steward-new-chat")?.toggleAttribute("disabled", this.agentBusy || this.agentRecording || this.agentSpeaking);
    const send = this.agentSurfaceEl?.querySelector<HTMLButtonElement>(".lifeops-agent-send");
    if (send) send.disabled = this.agentBusy;
  }

  async refreshStewardConversation(): Promise<void> {
    await this.render();
  }

  private async openStewardPending(): Promise<void> {
    await this.navigateSteward("chat");
    const section = this.agentSuggestionsEl;
    if (!section) return;
    const button = section.querySelector<HTMLButtonElement>('button[aria-label="查看待确认动作"]');
    if (!button || button.disabled) return;
    section.scrollIntoView({ block: "nearest" });
    if (button.getAttribute("aria-expanded") !== "true") button.click();
  }
}

export interface LifeOpsView extends StatusBarPanelApi, ComposerPanelApi, MessageListPanelApi, SuggestionsPanelApi {}

applyStatusBarPanel(LifeOpsView);
applyComposerPanel(LifeOpsView);
applyMessageListPanel(LifeOpsView);
applySuggestionsPanel(LifeOpsView);

function stat(container: HTMLElement, label: string, value: string, icon: string, tone: string): void {
  const box = container.createDiv({ cls: `lifeops-stat tone-${tone}` });
  setIcon(box.createSpan({ cls: "lifeops-stat-icon" }), icon);
  const labelEl = box.createDiv({ cls: "lifeops-stat-label" });
  const labelChars = Array.from(label);
  if (labelChars.length === 4) {
    labelEl.addClass("is-two-line");
    labelEl.createSpan({ text: labelChars.slice(0, 2).join("") });
    labelEl.createSpan({ text: labelChars.slice(2).join("") });
  } else {
    labelEl.setText(label);
  }
  box.createDiv({ text: value, cls: "lifeops-stat-value" });
}

function chip(container: HTMLElement, icon: string, text: string): void {
  const item = container.createSpan({ cls: "lifeops-chip" });
  setIcon(item.createSpan({ cls: "lifeops-chip-icon" }), icon);
  item.createSpan({ text });
}

function filterLabel(filter: TaskFilter): string {
  switch (filter) {
    case "today":
      return "今日任务";
    case "overdue":
      return "过期任务";
    case "deadline":
      return "截止任务";
    case "recurring":
      return "重复任务";
    case "tomorrow":
      return "明日任务";
    case "next-seven":
      return "未来七天";
    case "no-date":
      return "无日期任务";
    case "completed":
      return "今日已完成";
    case "completed-all":
      return "完成历史";
    case "all":
      return "所有未完成";
    case "by-project":
      return "项目视图";
    case "by-category":
      return "分类视图";
    case "by-date":
      return "日期视图";
  }
}

function priorityLabel(priority: string): string {
  switch (priority) {
    case "high":
      return "高优先级";
    case "medium":
      return "中优先级";
    case "low":
      return "低优先级";
    default:
      return "无优先级";
  }
}

function timeHour(task: LifeOpsTask): number {
  if (!task.time) return -1;
  const hour = Number(task.time.slice(0, 2));
  return Number.isFinite(hour) ? hour : -1;
}

function timeGroupClass(label: string): string {
  if (label === "上午") return "morning";
  if (label === "下午") return "afternoon";
  if (label === "晚上") return "evening";
  return "unscheduled";
}

function isTaskOverdue(task: LifeOpsTask): boolean {
  const deadline = task.dueDate || task.date;
  return Boolean(deadline && deadline < todayString());
}

function repeatLabel(task: LifeOpsTask): string {
  const unit = task.repeatUnit === "day" ? "天" : task.repeatUnit === "week" ? "周" : "月";
  const base = task.repeatInterval > 1 ? `每 ${task.repeatInterval} ${unit}` : `每${unit}`;
  return task.repeatUntil ? `${base}至 ${task.repeatUntil}` : base;
}

function calendarTasksForDate(board: TaskDashboardData, date: string): LifeOpsTask[] {
  const tasks = new Map<string, LifeOpsTask>();
  for (const task of board.tasks) {
    const isActiveMatch = task.status === "active" && (isTaskOnDateLocal(task, date) || task.dueDate === date);
    const isCompletedMatch = task.status === "completed" && (formatDate(new Date(task.completedAt)) === date || isTaskOnDateLocal(task, date));
    if (isActiveMatch || isCompletedMatch) {
      tasks.set(task.id, task);
    }
  }
  return Array.from(tasks.values()).sort(calendarTaskSort(date));
}

function calendarTaskSort(date: string): (a: LifeOpsTask, b: LifeOpsTask) => number {
  const priorityWeight: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 };
  return (a, b) => {
    const statusCompare = taskCalendarStatusWeight(a, date) - taskCalendarStatusWeight(b, date);
    if (statusCompare !== 0) return statusCompare;
    const timeCompare = (a.time || "99:99").localeCompare(b.time || "99:99");
    if (timeCompare !== 0) return timeCompare;
    return (priorityWeight[a.priority] ?? 3) - (priorityWeight[b.priority] ?? 3);
  };
}

function taskCalendarStatusWeight(task: LifeOpsTask, date: string): number {
  if (task.status === "active" && task.dueDate === date) return 0;
  if (task.status === "active") return 1;
  if (task.status === "completed") return 2;
  return 3;
}

function calendarEventClass(task: LifeOpsTask, date: string): string {
  return [
    "lifeops-calendar-event",
    `priority-${task.priority}`,
    `status-${task.status}`,
    task.dueDate === date ? "is-due" : "",
    task.repeatUnit !== "none" ? "is-recurring" : ""
  ].filter(Boolean).join(" ");
}

function calendarDetailTaskClass(task: LifeOpsTask, date: string): string {
  return [
    "lifeops-calendar-detail-task",
    `priority-${task.priority}`,
    `status-${task.status}`,
    task.dueDate === date ? "is-due" : "",
    task.repeatUnit !== "none" ? "is-recurring" : ""
  ].filter(Boolean).join(" ");
}

function calendarEventMeta(task: LifeOpsTask, date: string): string {
  const parts = [
    task.status === "completed" ? "已完成" : task.dueDate === date ? "截止" : priorityLabel(task.priority),
    task.repeatUnit !== "none" ? "重复" : "",
    task.project,
    task.category
  ].filter(Boolean);
  return parts.join(" · ");
}

function agentActionIcon(type: AgentActionSuggestion["type"]): string {
  switch (type) {
    case "create_task":
      return "list-plus";
    case "delete_task":
    case "delete_habit":
      return "trash-2";
    case "record_done":
      return "check-circle";
    case "append_daily_note":
      return "book-open";
    case "record_idea":
      return "lightbulb";
    case "record_habit":
      return "repeat";
    case "record_health":
      return "heart-pulse";
    case "record_trade":
      return "candlestick-chart";
    case "append_trading_model_note":
      return "candlestick-chart";
    case "append_knowledge_note":
      return "library";
    case "update_memory":
    case "note_understanding":
      return "brain";
    case "weekly_review":
      return "calendar-days";
    case "send_to_inbox":
    default:
      return "inbox";
  }
}

function agentActionLabel(action: AgentActionSuggestion): string {
  if (action.type === "update_memory" && action.memoryFile) {
    return `${action.title} · ${action.memoryFile.replace(/\.md$/i, "")}`;
  }
  if (action.type === "review_memory") {
    return `${action.title} · ${action.memoryId ?? "unknown"}`;
  }
  return action.title;
}

function agentMemoryFiles(): string[] {
  return ["个人画像.md", "当前状态.md", "长期目标.md", "管家规则.md", "交易纪律.md"];
}

function isVoiceActionConfirmation(message: string, action: AgentActionSuggestion): boolean {
  const value = message.replace(/\s+/g, "").replace(/[，,。.!！?？:：;；、"'“”‘’]/g, "").trim();
  if (!value) return false;
  if (action.type === "delete_task" || action.type === "delete_habit") {
    return /^(确|确认|确认删除|确认删掉|确认清掉|确认直接删除|确认直接删掉|直接删除|直接删|直接删掉|删除|删掉|可以删|可以删除|对删掉|对删除)$/u.test(value);
  }
  return /^(确认|可以|执行|确认执行|就这样|对)$/u.test(value);
}

function calendarTaskTimeLabel(task: LifeOpsTask, date: string): string {
  if (task.status === "completed") return "完成";
  if (task.dueDate === date && !isTaskOnDateLocal(task, date)) return task.dueTime || "截止";
  if (task.time) return task.time;
  if (task.dueDate === date && task.dueTime) return task.dueTime;
  return "全天";
}

function uniqueCount(tasks: LifeOpsTask[], selector: (task: LifeOpsTask) => string): number {
  return new Set(tasks.map(selector)).size;
}

function groupTasks(tasks: LifeOpsTask[], selector: (task: LifeOpsTask) => string): Array<[string, LifeOpsTask[]]> {
  const groups = new Map<string, LifeOpsTask[]>();
  for (const task of tasks) {
    const key = selector(task);
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => {
    if (a === "无日期") return 1;
    if (b === "无日期") return -1;
    return a.localeCompare(b, "zh-Hans-CN");
  });
}

function habitStatusLabel(status: HabitCheckinStatus | "pending"): string {
  switch (status) {
    case "done":
      return "完成";
    case "missed":
      return "未完成";
    case "leave":
      return "请假";
    case "pending":
      return "待打卡";
  }
}

function habitFrequencyLabel(habit: HabitDefinition): string {
  const unit = habit.frequencyUnit === "week" ? "周" : "天";
  const base = habit.frequencyInterval === 1 ? (habit.frequencyUnit === "week" ? "每周" : "每天") : `每 ${habit.frequencyInterval} ${unit}`;
  return `${base} ${habit.targetCount} 次`;
}

function habitRequirementLabel(item: TaskDashboardData["habits"][number]): string {
  if (item.habit.frequencyUnit === "week") {
    return item.periodDone >= item.periodTarget ? "本周已达标" : "本周待完成";
  }
  return item.requiredToday ? "今日应打卡" : "今日非必需";
}

function habitWindowStats(item: TaskDashboardData["habits"][number], days: number): { required: number; done: number; rate: number } {
  const dates = lastDates(days);
  if (item.habit.frequencyUnit === "week") {
    const weeks = new Map<string, string[]>();
    for (const date of dates) {
      const weekKey = weekDates(date).join(",");
      if (!weeks.has(weekKey)) {
        weeks.set(weekKey, weekDates(date));
      }
    }
    const activeWeeks = Array.from(weeks.values()).filter((week) => week.some((date) => isHabitRequiredOnDate(item.habit, date)));
    const required = activeWeeks.length * item.habit.targetCount;
    const done = activeWeeks.reduce((sum, week) => {
      const weekDone = item.history
        .filter((entry) => week.includes(entry.date) && entry.status === "done")
        .reduce((count, entry) => count + Math.max(1, entry.count || 1), 0);
      return sum + Math.min(item.habit.targetCount, weekDone);
    }, 0);
    return {
      required,
      done,
      rate: required === 0 ? 100 : Math.round((done / required) * 100)
    };
  }
  const requiredDates = dates.filter((date) => isHabitRequiredOnDate(item.habit, date));
  const done = requiredDates.filter((date) => {
    const checkin = item.history.find((entry) => entry.date === date);
    return checkin?.status === "done";
  }).length;
  return {
    required: requiredDates.length,
    done,
    rate: requiredDates.length === 0 ? 100 : Math.round((done / requiredDates.length) * 100)
  };
}

function lastDates(days: number): string[] {
  const start = addDays(todayString(), -(days - 1));
  return Array.from({ length: days }, (_, index) => addDays(start, index));
}

function isHabitRequiredOnDate(habit: HabitDefinition, date: string): boolean {
  if (date < habit.startDate) return false;
  if (habit.frequencyUnit === "week") {
    const start = new Date(`${habit.startDate}T00:00:00`);
    const current = new Date(`${date}T00:00:00`);
    const weeks = Math.floor((current.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000));
    return weeks % habit.frequencyInterval === 0;
  }
  const days = Math.floor((new Date(`${date}T00:00:00`).getTime() - new Date(`${habit.startDate}T00:00:00`).getTime()) / (24 * 60 * 60 * 1000));
  return days % habit.frequencyInterval === 0;
}

function calendarModeLabel(mode: "month" | "week" | "day"): string {
  if (mode === "month") return "月";
  if (mode === "week") return "周";
  return "日";
}

function calendarNavLabels(mode: "month" | "week" | "day"): [string, string] {
  if (mode === "month") return ["上个月", "下个月"];
  if (mode === "week") return ["上一周", "下一周"];
  return ["前一天", "后一天"];
}

function compactDate(dateString: string): string {
  return `${Number(dateString.slice(5, 7))}/${Number(dateString.slice(8, 10))}`;
}

function weekDayLabel(dateString: string): string {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][parseDate(dateString).getDay()];
}

function monthTitle(dateString: string): string {
  return `${Number(dateString.slice(0, 4))}年${Number(dateString.slice(5, 7))}月`;
}

function dayNumber(dateString: string): string {
  return String(Number(dateString.slice(8, 10)));
}

function monthCells(dateString: string): Array<{ date: string; inMonth: boolean; dayOfWeek: number }> {
  const year = Number(dateString.slice(0, 4));
  const month = Number(dateString.slice(5, 7));
  const first = new Date(year, month - 1, 1);
  const start = new Date(year, month - 1, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const value = formatDate(date);
    return {
      date: value,
      inMonth: date.getMonth() === month - 1,
      dayOfWeek: date.getDay()
    };
  });
}

function addMonths(dateString: string, months: number): string {
  const date = parseDate(dateString);
  return formatDate(new Date(date.getFullYear(), date.getMonth() + months, 1));
}

function startOfDisplayedWeek(dateString: string): string {
  const date = parseDate(dateString);
  date.setDate(date.getDate() - date.getDay());
  return formatDate(date);
}

function parseDate(dateString: string): Date {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isTaskOnDateLocal(task: LifeOpsTask, date: string): boolean {
  if (!task.date) return false;
  if (task.endDate) return task.date <= date && date <= task.endDate;
  return task.date === date;
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


function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

function metricLabel(label: string, start: number | undefined, end: number | undefined): string {
  if (!start || !end) return "";
  return `${label} ${Math.max(0, Math.round(end - start))}ms`;
}

function traceDelta(start: number | undefined, end: number | undefined): number | undefined {
  if (!start || !end) return undefined;
  return Math.max(0, Math.round(end - start));
}
