import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import { BailianRealtimeClient } from "../bailianRealtime";
import { BailianRealtimeTtsClient } from "../bailianTtsRealtime";
import type { AiToolCall } from "../ai";
import { addDays, todayString, weekDates } from "../date";
import { mergePendingAgentActions, PENDING_ACTION_CONFLICT_NOTICE } from "../pendingAgentActions";
import { bindAgentHistoryResponse } from "../personalMemoryHistory";
import { renderWriteReceipts } from "../writeReceipts";
import { renderChatMessageContent } from "./chatInteraction";
import { armAdjacentTaskPlan, consumeAdjacentTaskDecision } from "./taskPlanApproval";
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
  VisualAnalysisResult
} from "../types";

export const LIFEOPS_VIEW_TYPE = "lifeops-assistant-view";
const AGENT_MESSAGE_TIMEOUT_MS = 30_000;
const AGENT_BUSY_TIMEOUT_MS = 45_000;
// A later submission owns the surface, even if an older request is still finishing its audit.
const activeMessageRequests = new WeakMap<object, symbol>();
const activeMessageAbortControllers = new WeakMap<object, AbortController>();

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

export interface LifeOpsViewController {
  settings: LifeOpsSettings;
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
  openTradeEditModal?(id: string): Promise<void>;
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
  undoStewardOperation?(id: string): Promise<void>;
  transcribeAgentAudio(audio: Blob): Promise<string>;
  appendQualityLog(entry: QualityLogEntry): Promise<void>;
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
  agentRealtimeClient: BailianRealtimeClient | null;
  agentAudioContext: AudioContext | null;
  agentAudioSource: MediaStreamAudioSourceNode | null;
  agentAudioProcessor: ScriptProcessorNode | null;
  agentAudioWorklet: AudioWorkletNode | null;
  agentInputEl: HTMLTextAreaElement | null;
  agentSpeechRecognition: SpeechRecognitionLike | null;
  agentTtsClient: BailianRealtimeTtsClient | null;
  agentSpeechAudioContext: AudioContext | null;
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
  voiceSession: VoiceSessionState;
  agentVoiceAutoSendTimer: number;
  agentVoiceTriggerActiveUntil: number;
  agentSpeaking: boolean;
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
  setAgentMessageBubbleContent(bubble: HTMLElement, content: string, verifiedWrite?: boolean): void;
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
  render(): Promise<void>;
  run(success: string, action: () => Promise<void>): Promise<void>;
}


export interface MessageListPanelApi {
  appendAgentMessage(...args: any[]): any;
  sendAgentMessage(...args: any[]): any;
  agentSubmissionOptions(...args: any[]): any;
  sendAgentMessageWithPipeline(...args: any[]): any;
  scrollAgentTranscriptToBottom(...args: any[]): any;
  renderAgentMessage(...args: any[]): any;
  setAgentMessageBubbleContent(...args: any[]): any;
}

const messageListPanel = {
  appendAgentMessage(this: ViewHost, message: AgentConversationMessage): HTMLElement | null {
      if (this.viewClosed || !this.agentTranscriptEl) return null;
      if (message.role === "user" && this.agentTranscriptEl.querySelectorAll(".lifeops-agent-message").length <= 1) {
        this.agentTranscriptEl.empty();
      }
      this.renderAgentMessage(this.agentTranscriptEl, message);
      this.scrollAgentTranscriptToBottom();
      const bubbles = this.agentTranscriptEl.querySelectorAll<HTMLElement>(".lifeops-agent-message");
      return bubbles.item(bubbles.length - 1) ?? null;
    },

  async sendAgentMessage(this: ViewHost, source: "text" | "voice" = "text"): Promise<void> {
      if (this.viewClosed) return;
      const viewGeneration = this.agentTextRequestGeneration ?? 0;
      const isCurrentView = (): boolean => !this.viewClosed && (this.agentTextRequestGeneration ?? 0) === viewGeneration;
      this.recoverTimedOutAgentBusy();
      const isVoice = source === "voice";
      let message = isVoice ? this.currentVoiceMessageText() : this.agentInput.trim();
      if (!message || this.agentBusy) return;
      if (!isVoice) {
        const decision = consumeAdjacentTaskDecision(this, message);
        if (decision) {
          const confirmation: AgentConversationMessage = { role: "user", content: message };
          this.agentMessages = [...this.agentMessages, confirmation].slice(-12);
          this.appendAgentMessage(confirmation); this.setAgentInput("");
          if (decision.approved) await this.acceptAgentSuggestion(decision.action);
          else await this.dismissAgentSuggestion(decision.action.id);
          return;
        }
      }
      if (isVoice && this.agentVoiceSendInFlight) return;
      const history = this.agentMessages.slice(-10);
      let actionSuggestions = 0;
      let errorCode = "";
      let errorMessage = "";
      if (isVoice) {
        const gatedMessage = this.prepareVoiceMessageForSend(message);
        if (!gatedMessage) return;
        if (gatedMessage !== message) {
          message = gatedMessage;
          this.setAgentInput(message);
        }
        if (isAlreadySent(this.voiceSession, message)) {
          this.discardCurrentVoiceTurn("已忽略重复的语音转写。");
          return;
        }
        this.agentVoiceSendInFlight = true;
        const preflightGeneration = this.agentVoicePipelineGeneration;
        const preflightToken = Symbol("voice-preflight");
        activeMessageRequests.set(this, preflightToken);
        try {
          const accepted = await this.tryAcceptPendingActionFromVoice(message);
          if (!isCurrentView() || activeMessageRequests.get(this) !== preflightToken) return;
          if (this.agentVoicePipelineGeneration !== preflightGeneration) {
            this.agentVoiceSendInFlight = false;
            return;
          }
          if (accepted) {
            this.agentVoiceSendInFlight = false;
            return;
          }
        } catch (error) {
          if (!isCurrentView() || activeMessageRequests.get(this) !== preflightToken) return;
          this.agentVoiceSendInFlight = false;
          throw error;
        }
      }
      if (isVoice) {
        let voiceRequestToken: symbol | undefined;
        try {
          this.agentVoiceQueuedAfterBusy = false;
          this.agentVoicePipelineGeneration += 1;
          const voicePipelineGeneration = this.agentVoicePipelineGeneration;
          this.beginVoiceProcessingTrace();
          this.voiceSession = finalizeTurn(this.voiceSession, message);
          this.transitionVoiceSession("processing", "voice turn submitted");
          this.rememberSentVoiceTurn(message);
          this.clearVoiceTurnBufferAfterSend();
          this.agentVoiceIgnoreSpeechStartUntil = performance.now() + 1800;
          this.markVoiceTrace("modelStart");
          const request = this.sendAgentMessageWithPipeline(message, history, voicePipelineGeneration);
          voiceRequestToken = activeMessageRequests.get(this);
          return await request;
        } catch (error) {
          if (!isCurrentView() || activeMessageRequests.get(this) !== voiceRequestToken) return;
          this.agentVoiceSendInFlight = false;
          throw error;
        }
      }
      const requestToken = Symbol("text-message");
      activeMessageRequests.set(this, requestToken);
      const requestController = beginMessageListRequest(this);
      this.agentVoiceSendInFlight = false;
      this.setAgentBusy(true);
      const activityGeneration = this.agentActivityGeneration ?? 0;
      const isCurrentRequest = (): boolean => isCurrentView() && activeMessageRequests.get(this) === requestToken
        && (this.agentActivityGeneration ?? 0) === activityGeneration;
      this.setAgentInput("");
      this.agentReply = "正在读取今天的上下文，并整理可以沉淀的内容...";
      this.refreshAgentSurfaceState();
      const userMessage: AgentConversationMessage = { role: "user", content: message };
      const assistantMessage: AgentConversationMessage = { role: "assistant", content: "" };
      this.agentMessages = [...this.agentMessages, userMessage, assistantMessage];
      const assistantIndex = this.agentMessages.length - 1;
      this.appendAgentMessage(userMessage);
      let streamMessageEl = this.appendAgentMessage(assistantMessage);
      let requestActive = true;
      const updateStream = (content: string): void => {
        if (!requestActive || !isCurrentRequest()) return;
        if (isVoice && content.trim() && !this.agentVoiceTrace.modelFirstText) {
          this.markVoiceTrace("modelFirstText");
        }
        const next = this.agentMessages.slice();
        next[assistantIndex] = { role: "assistant", content: content || "..." };
        this.agentMessages = next;
        this.agentReply = content || "正在生成回复...";
        if (streamMessageEl) {
          streamMessageEl.textContent = content || "...";
          this.scrollAgentTranscriptToBottom();
        }
      };
      try {
        const submissionOptions = { ...this.agentSubmissionOptions(source), signal: requestController.signal };
        const responsePromise = this.controller.submitAgentMessageStream
          ? this.controller.submitAgentMessageStream(message, history, updateStream, submissionOptions)
          : this.controller.submitAgentMessage(message, history, submissionOptions);
        const response = await withTimeout(responsePromise, AGENT_MESSAGE_TIMEOUT_MS, "AI 管家请求超时，请再说一次。", requestController);
        actionSuggestions = response.actions.length;
        if (!isCurrentRequest()) {
          errorCode = "STALE_TEXT_REPLY_SUPPRESSED";
          return;
        }
        if (isVoice) this.markVoiceTrace("modelDone");
        this.agentReply = response.reply;
        const next = this.agentMessages.slice();
        next[assistantIndex] = { role: "assistant", content: response.reply, receipts: response.receipts };
        bindAgentHistoryResponse(response, next[assistantIndex - 1], next[assistantIndex]);
        this.agentMessages = next.slice(-12);
        const pending = mergePendingAgentActions(this.pendingAgentActions, response.actions);
        this.pendingAgentActions = pending.actions;
        armAdjacentTaskPlan(this, next[assistantIndex], response.actions);
        if (pending.conflictingIds.length > 0) new Notice(PENDING_ACTION_CONFLICT_NOTICE);
        if (streamMessageEl) {
          streamMessageEl.classList.remove("is-pending");
          this.setAgentMessageBubbleContent(streamMessageEl, response.reply, !!response.receipts?.length);
          renderWriteReceipts(streamMessageEl, response.receipts, this.controller.undoStewardOperation?.bind(this.controller), this.controller.openTradeEditModal?.bind(this.controller));
        }
        this.refreshAgentSuggestions();
        if (isVoice && shouldSuppressAssistantSpeech({
          queueLength: this.voiceSession.inputQueue.length,
          interruptedWhileBusy: this.agentVoiceQueuedAfterBusy
        })) {
          this.transitionVoiceSession("listening", "queued user input after reply");
          this.agentReply = this.voiceSession.inputQueue.length > 0 ? "我先接你刚补的那句。" : "我听到你在说，先不抢答。";
        } else if (this.agentMode === "voice" && this.controller.settings.realtimeVoice.speakReplies) {
          this.transitionVoiceSession("speaking", "assistant reply ready");
          this.speakAgentReply(response.reply);
        } else if (isVoice) {
          this.transitionVoiceSession("listening", "assistant reply displayed");
        }
      } catch (error) {
        errorCode = "AGENT_MESSAGE_FAILED";
        errorMessage = error instanceof Error ? error.message : "AI 管家处理失败";
        if (!isCurrentRequest()) return;
        if (isVoice) this.markVoiceTrace("modelDone");
        this.agentReply = error instanceof Error ? error.message : "AI 管家处理失败";
        // Preserve a newer draft typed while waiting; otherwise restore the failed input.
        if (!isVoice && this.agentMode === "text" && !this.agentInput.trim()) {
          this.setAgentInput(message);
          this.agentReply += "\n原话已放回输入框，可以修改后重新发送。";
        }
        const next = this.agentMessages.slice();
        next[assistantIndex] = { role: "assistant", content: this.agentReply };
        this.agentMessages = next.slice(-12);
        if (streamMessageEl) {
          streamMessageEl.classList.remove("is-pending");
          this.setAgentMessageBubbleContent(streamMessageEl, this.agentReply);
        }
        this.refreshAgentSuggestions();
        new Notice(this.agentReply);
      } finally {
        requestActive = false;
        finishMessageListRequest(this, requestController);
        if (isCurrentRequest()) this.setAgentBusy(false);
        const voiceStartGeneration = this.agentRealtimeStartGeneration;
        await this.appendAgentQualityLog(source, actionSuggestions, errorCode, errorMessage);
        if (!isCurrentRequest()) return;
        this.refreshAgentSurfaceState();
        if (!isVoice && this.agentMode === "voice" && this.agentVoiceConversation && !this.agentRecording
          && this.agentRealtimeStartGeneration === voiceStartGeneration) {
          await this.ensureVoiceStandby();
        }
        if (isVoice) {
          if (this.voiceSession.inputQueue.length > 0) {
            await this.consumeQueuedVoiceInput();
            return;
          }
          if (this.agentVoiceQueuedAfterBusy && !this.currentVoiceMessageText()) {
            this.transitionVoiceSession("listening", "waiting for interrupted user transcript");
            this.refreshAgentSurfaceState();
            return;
          }
          if (this.currentVoiceMessageText()) {
            this.clearVoiceAutoSendTimer();
            if (this.agentMode === "voice" && this.agentVoiceConversation) {
              this.scheduleVoiceAutoSend();
            }
          } else {
            this.resetCurrentVoiceTurnDraft();
          }
        }
      }
    },

  agentSubmissionOptions(this: ViewHost, source: "text" | "voice"): AgentSubmissionOptions { return { source }; },

  async sendAgentMessageWithPipeline(this: ViewHost,
      message: string,
      history: AgentConversationMessage[],
      voicePipelineGeneration: number
    ): Promise<void> {
      let actionSuggestions = 0;
      let errorCode = "";
      let errorMessage = "";
      const viewGeneration = this.agentTextRequestGeneration ?? 0;
      const isCurrentView = (): boolean => !this.viewClosed && (this.agentTextRequestGeneration ?? 0) === viewGeneration;
      const isStaleVoicePipeline = (): boolean => voicePipelineGeneration !== this.agentVoicePipelineGeneration;
      if (!isCurrentView() || isStaleVoicePipeline()) return;
      const requestToken = Symbol("voice-message");
      activeMessageRequests.set(this, requestToken);
      const requestController = beginMessageListRequest(this);
      this.setAgentBusy(true);
      const activityGeneration = this.agentActivityGeneration ?? 0;
      const isCurrentRequest = (): boolean => isCurrentView() && activeMessageRequests.get(this) === requestToken
        && (this.agentActivityGeneration ?? 0) === activityGeneration;
      this.setAgentInput("");
      this.agentReply = "正在听你这句，并整理成自然回复...";
      this.refreshAgentSurfaceState();
      const userMessage: AgentConversationMessage = { role: "user", content: message };
      const assistantMessage: AgentConversationMessage = { role: "assistant", content: "" };
      this.agentMessages = [...this.agentMessages, userMessage, assistantMessage];
      const assistantIndex = this.agentMessages.length - 1;
      this.appendAgentMessage(userMessage);
      let streamMessageEl = this.appendAgentMessage(assistantMessage);
      const dropStaleAssistant = (): void => {
        const next = this.agentMessages.slice();
        if (next[assistantIndex]?.role === "assistant") {
          next.splice(assistantIndex, 1);
        }
        this.agentMessages = next.slice(-12);
        streamMessageEl?.remove();
        streamMessageEl = null;
      };
      let requestActive = true;
      const updateStream = (content: string): void => {
        if (!requestActive || !isCurrentRequest() || isStaleVoicePipeline()) return;
        if (content.trim() && !this.agentVoiceTrace.modelFirstText) {
          this.markVoiceTrace("modelFirstText");
        }
        const next = this.agentMessages.slice();
        next[assistantIndex] = { role: "assistant", content: content || "..." };
        this.agentMessages = next;
        this.agentReply = content || "正在生成回复...";
        if (streamMessageEl) {
          streamMessageEl.textContent = content || "...";
          this.scrollAgentTranscriptToBottom();
        }
      };
      try {
        const submissionOptions = { ...this.agentSubmissionOptions("voice"), signal: requestController.signal };
        const responsePromise = this.controller.submitAgentMessageStream
          ? this.controller.submitAgentMessageStream(message, history, updateStream, submissionOptions)
          : this.controller.submitAgentMessage(message, history, submissionOptions);
        const response = await withTimeout(responsePromise, AGENT_MESSAGE_TIMEOUT_MS, "AI 管家请求超时，我先恢复监听。你可以再说一遍。", requestController);
        actionSuggestions = response.actions.length;
        if (!isCurrentRequest()) {
          errorCode = "STALE_VOICE_REPLY_SUPPRESSED";
          return;
        }
        this.markVoiceTrace("modelDone");
        if (isStaleVoicePipeline()) {
          errorCode = "STALE_VOICE_REPLY_SUPPRESSED";
          dropStaleAssistant();
          if (this.agentMode === "voice" && this.agentVoiceConversation) {
            this.agentReply = "我先接你刚才补的那句。";
            this.transitionVoiceSession("listening", "stale voice reply suppressed");
          }
          return;
        }
        this.agentReply = response.reply;
        const next = this.agentMessages.slice();
        next[assistantIndex] = { role: "assistant", content: response.reply, receipts: response.receipts };
        bindAgentHistoryResponse(response, next[assistantIndex - 1], next[assistantIndex]);
        this.agentMessages = next.slice(-12);
        const pending = mergePendingAgentActions(this.pendingAgentActions, response.actions);
        this.pendingAgentActions = pending.actions;
        if (pending.conflictingIds.length > 0) new Notice(PENDING_ACTION_CONFLICT_NOTICE);
        if (streamMessageEl) {
          streamMessageEl.classList.remove("is-pending");
          this.setAgentMessageBubbleContent(streamMessageEl, response.reply, !!response.receipts?.length);
          renderWriteReceipts(streamMessageEl, response.receipts, this.controller.undoStewardOperation?.bind(this.controller), this.controller.openTradeEditModal?.bind(this.controller));
        }
        this.refreshAgentSuggestions();
        if (shouldSuppressAssistantSpeech({
          queueLength: this.voiceSession.inputQueue.length,
          interruptedWhileBusy: this.agentVoiceQueuedAfterBusy
        })) {
          this.transitionVoiceSession("listening", "queued user input after reply");
          this.agentReply = this.voiceSession.inputQueue.length > 0 ? "我先接你刚补的那句。" : "我听到你在说，先不抢答。";
        } else if (this.agentMode === "voice" && this.controller.settings.realtimeVoice.speakReplies) {
          this.transitionVoiceSession("speaking", "assistant reply ready");
          this.speakAgentReply(response.reply);
        } else if (this.agentMode === "voice" && this.agentVoiceConversation) {
          this.transitionVoiceSession("listening", "assistant reply displayed");
        }
      } catch (error) {
        if (!isCurrentRequest()) {
          errorCode = "AGENT_MESSAGE_FAILED";
          errorMessage = error instanceof Error ? error.message : "AI 管家处理失败";
          return;
        }
        this.markVoiceTrace("modelDone");
        if (isStaleVoicePipeline()) {
          errorCode = "STALE_VOICE_REPLY_SUPPRESSED";
          dropStaleAssistant();
          if (this.agentMode === "voice" && this.agentVoiceConversation) {
            this.agentReply = "我先接你刚才补的那句。";
            this.transitionVoiceSession("listening", "stale voice error suppressed");
          }
          return;
        }
        errorCode = "AGENT_MESSAGE_FAILED";
        errorMessage = error instanceof Error ? error.message : "AI 管家处理失败";
        this.agentReply = error instanceof Error ? error.message : "AI 管家处理失败";
        const next = this.agentMessages.slice();
        next[assistantIndex] = { role: "assistant", content: this.agentReply };
        this.agentMessages = next.slice(-12);
        if (streamMessageEl) {
          streamMessageEl.classList.remove("is-pending");
          this.setAgentMessageBubbleContent(streamMessageEl, this.agentReply);
        }
        this.refreshAgentSuggestions();
        new Notice(this.agentReply);
      } finally {
        requestActive = false;
        finishMessageListRequest(this, requestController);
        if (isCurrentRequest()) {
          this.agentVoiceSendInFlight = false;
          this.setAgentBusy(false);
        }
        await this.appendAgentQualityLog("voice", actionSuggestions, errorCode, errorMessage);
        if (!isCurrentRequest()) return;
        this.refreshAgentSurfaceState();
        if (this.agentMode !== "voice" || !this.agentVoiceConversation) return;
        if (this.voiceSession.inputQueue.length > 0) {
          await this.consumeQueuedVoiceInput();
          return;
        }
        if (this.agentVoiceQueuedAfterBusy && !this.currentVoiceMessageText()) {
          this.transitionVoiceSession("listening", "waiting for interrupted user transcript");
          this.refreshAgentSurfaceState();
          return;
        }
        if (this.currentVoiceMessageText()) {
          this.clearVoiceAutoSendTimer();
          if (this.agentMode === "voice" && this.agentVoiceConversation) {
            this.scheduleVoiceAutoSend();
          }
        } else {
          this.resetCurrentVoiceTurnDraft();
        }
      }
    },

  scrollAgentTranscriptToBottom(this: ViewHost): void {
      if (this.viewClosed || !this.agentTranscriptEl) return;
      const transcript = this.agentTranscriptEl;
      const viewGeneration = this.agentTextRequestGeneration ?? 0;
      const scroll = (): void => {
        if (this.viewClosed || (this.agentTextRequestGeneration ?? 0) !== viewGeneration || this.agentTranscriptEl !== transcript) return;
        transcript.scrollTop = transcript.scrollHeight;
      };
      scroll();
      window.requestAnimationFrame(scroll);
      window.setTimeout(scroll, 80);
    },

  renderAgentMessage(this: ViewHost, container: HTMLElement, message: AgentConversationMessage): void {
      if (message.role === "assistant" && !message.content.trim()) {
        const bubble = container.createDiv({ cls: "lifeops-agent-message assistant is-pending" });
        bubble.createSpan({ text: "LifeOps 正在思考", cls: "lifeops-agent-thinking-text" });
        const dots = bubble.createSpan({ cls: "lifeops-agent-thinking-dots", attr: { "aria-hidden": "true" } });
        dots.createSpan();
        dots.createSpan();
        dots.createSpan();
        return;
      }
      const bubble = container.createDiv({ cls: `lifeops-agent-message ${message.role}` });
      this.setAgentMessageBubbleContent(bubble, message.content, message.role === "assistant" && !!message.receipts?.length);
      renderWriteReceipts(bubble, message.receipts, this.controller.undoStewardOperation?.bind(this.controller), this.controller.openTradeEditModal?.bind(this.controller));
    },

  setAgentMessageBubbleContent(this: ViewHost, bubble: HTMLElement, content: string, verifiedWrite = false): void {
      bubble.empty();
      bubble.classList.remove("is-pending");
      renderChatMessageContent(bubble, content, verifiedWrite);
    },
};

export function applyMessageListPanel(View: ViewConstructor): void {
  Object.assign(View.prototype, messageListPanel);
}

export function cancelMessageListRequest(view: object): void {
  const controller = activeMessageAbortControllers.get(view);
  activeMessageAbortControllers.delete(view);
  controller?.abort(new Error("当前轮已结束，已取消未完成请求。"));
}

function beginMessageListRequest(view: object): AbortController {
  cancelMessageListRequest(view);
  const controller = new AbortController();
  activeMessageAbortControllers.set(view, controller);
  return controller;
}

function finishMessageListRequest(view: object, controller: AbortController): void {
  if (activeMessageAbortControllers.get(view) === controller) activeMessageAbortControllers.delete(view);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, controller: AbortController): Promise<T> {
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      const error = new Error(message);
      error.name = "TimeoutError";
      // Keep the deadline message even when cancellation rejects the producer.
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}
