import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import { BailianRealtimeClient } from "../bailianRealtime";
import { BailianRealtimeTtsClient } from "../bailianTtsRealtime";
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
import type { ProactiveFeedbackDecision } from "../proactivePolicy";
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

const renderedSuggestionState = new WeakMap<HTMLElement, string>();
const executingSuggestions = new WeakSet<AgentActionSuggestion>();
const suggestionPopupCleanup = new WeakMap<object, () => void>();
const suggestionCleanupRegistered = new WeakSet<object>();
let suggestionPopoverId = 0;
function suggestionState(host: ViewHost): string {
  return JSON.stringify([host.pendingAgentActions, host.proactiveCandidates]);
}

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
  appendAgentActionReceipt?(title: string, receipt: string): Promise<boolean>;
  dismissAgentAction?(action: AgentActionSuggestion): void;
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
  respondToProactiveCandidate(candidateId: string, decision: ProactiveFeedbackDecision): Promise<void>;
  openStewardSummary?(path: string): Promise<void>;
  openStewardLearningPlan?(): void;
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
  setAgentMessageBubbleContent(bubble: HTMLElement, content: string): void;
  scrollAgentTranscriptToBottom(): void;
  refreshAgentSuggestions(): void;
  refreshAgentSurfaceState(): void;
  setAgentBusy(value: boolean): void;
  setAgentInput(value: string): void;
  recoverTimedOutAgentBusy(): boolean;
  tryAcceptPendingActionFromVoice(message: string): Promise<boolean>;
  acceptAgentSuggestion(action: AgentActionSuggestion, voiceTurn?: () => boolean): Promise<string | undefined>;
  dismissAgentSuggestion(actionId: string, expectedAction?: AgentActionSuggestion, voiceTurn?: () => boolean): Promise<void>;
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


export interface SuggestionsPanelApi {
  renderAgentSuggestions(...args: any[]): any;
  populateAgentSuggestions(...args: any[]): any;
  refreshAgentSuggestions(...args: any[]): any;
  renderAgentSuggestionCard(...args: any[]): any;
  updatePendingAgentAction(...args: any[]): any;
  iconButton(...args: any[]): any;
  acceptAgentSuggestion(...args: any[]): any;
  tryAcceptPendingActionFromVoice(...args: any[]): any;
  dismissAgentSuggestion(...args: any[]): any;
}

const suggestionsPanel = {
  renderAgentSuggestions(this: ViewHost, panel: HTMLElement): void {
      if (this.viewClosed) return;
      suggestionPopupCleanup.get(this)?.();
      if (!suggestionCleanupRegistered.has(this) && typeof this.register === "function") {
        suggestionCleanupRegistered.add(this);
        this.register(() => suggestionPopupCleanup.get(this)?.());
      }
      const section = panel.createDiv({ cls: "lifeops-agent-suggestions" });
      this.agentSuggestionsEl = section;
      this.populateAgentSuggestions(section);
    },

  populateAgentSuggestions(this: ViewHost, section: HTMLElement): void {
      if (this.viewClosed) return;
      const previouslyOpen = section.querySelector<HTMLButtonElement>('[data-suggestion-kind][aria-expanded="true"]')?.dataset.suggestionKind;
      const restoreFocus = section.contains(section.ownerDocument.activeElement);
      suggestionPopupCleanup.get(this)?.();
      renderedSuggestionState.set(section, suggestionState(this));
      section.empty();
      section.toggleClass("has-actions", this.pendingAgentActions.length > 0);
      section.toggleClass("has-proactive", this.proactiveCandidates.length > 0);
      section.toggleClass("is-empty", this.pendingAgentActions.length === 0);

      const dock = section.createDiv({ cls: "lifeops-agent-suggestion-dock" });
      let closeCurrent: (() => void) | undefined;
      const popover = (kind: string, label: string, accessibleLabel: string, icon: string, count: number): HTMLElement | null => {
        const trigger = dock.createDiv({ cls: `lifeops-agent-suggestion-trigger ${count > 0 ? "has-content" : "is-empty"}` });
        const button = trigger.createEl("button", {
          cls: "lifeops-agent-suggestion-chip",
          attr: { type: "button", "aria-label": accessibleLabel, "aria-expanded": "false", "data-suggestion-kind": kind }
        });
        button.disabled = count === 0;
        setIcon(button.createSpan({ cls: "lifeops-button-icon" }), icon);
        button.createSpan({ text: label });
        button.createSpan({ text: String(count), cls: "lifeops-agent-suggestion-count" });
        if (count === 0) return null;
        const id = `lifeops-suggestion-popover-${++suggestionPopoverId}`;
        button.setAttribute("aria-controls", id);
        const detail = trigger.createDiv({
          cls: "lifeops-agent-suggestion-popover",
          attr: { id, role: "region", "aria-label": label }
        });
        detail.hidden = true;
        let stopWatching: (() => void) | undefined;
        const close = (focus = false): void => {
          stopWatching?.();
          stopWatching = undefined;
          detail.hidden = true;
          button.setAttribute("aria-expanded", "false");
          if (focus) button.focus({ preventScroll: true });
        };
        const closeButton = detail.createEl("button", {
          text: "关闭", cls: "lifeops-agent-suggestion-close",
          attr: { type: "button", "aria-label": `关闭${label}` }
        });
        closeButton.onclick = () => close(true);
        const open = (focus: boolean): void => {
          closeCurrent?.();
          const viewport = section.ownerDocument.defaultView;
          const scrollHost = section.closest<HTMLElement>(".lifeops-steward-conversation")
            ?? section.closest<HTMLElement>(".lifeops-agent-panel")
            ?? section.closest<HTMLElement>(".lifeops-view");
          const anchor = trigger.getBoundingClientRect();
          const bounds = scrollHost?.getBoundingClientRect();
          const viewportHeight = viewport?.innerHeight ?? section.ownerDocument.documentElement.clientHeight;
          const top = Math.max(0, bounds ? bounds.top + scrollHost!.clientTop : 0) + 8;
          const bottom = Math.min(viewportHeight, bounds ? bounds.top + scrollHost!.clientTop + scrollHost!.clientHeight : viewportHeight) - 8;
          if (anchor.bottom <= top || anchor.top >= bottom) return;
          const above = Math.max(0, anchor.top - top - 8);
          const below = Math.max(0, bottom - anchor.bottom - 8);
          const upwards = above >= below;
          const available = Math.max(above, below);
          // An unusably short pane must not open an inaccessible confirmation surface.
          if (available < 64) return;
          detail.style.maxHeight = `${Math.floor(Math.min(360, available))}px`;
          detail.style.top = upwards ? "auto" : "calc(100% + 8px)";
          detail.style.bottom = upwards ? "calc(100% + 8px)" : "auto";
          detail.hidden = false;
          detail.scrollTop = 0;
          button.setAttribute("aria-expanded", "true");
          closeCurrent = () => close();
          const onLayoutChange = (): void => close(detail.contains(section.ownerDocument.activeElement));
          scrollHost?.addEventListener("scroll", onLayoutChange, { passive: true });
          viewport?.addEventListener("resize", onLayoutChange);
          let resizeObserver: ResizeObserver | undefined;
          if (typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(() => {
              const currentAnchor = trigger.getBoundingClientRect();
              const currentBounds = scrollHost?.getBoundingClientRect();
              if (currentAnchor.width !== anchor.width || currentAnchor.height !== anchor.height
                || currentAnchor.top !== anchor.top || currentAnchor.bottom !== anchor.bottom
                || currentBounds?.width !== bounds?.width || currentBounds?.height !== bounds?.height
                || currentBounds?.top !== bounds?.top || currentBounds?.bottom !== bounds?.bottom) onLayoutChange();
            });
            resizeObserver.observe(trigger);
            if (scrollHost) resizeObserver.observe(scrollHost);
          }
          const cleanup = (): void => close();
          stopWatching = () => {
            scrollHost?.removeEventListener("scroll", onLayoutChange);
            viewport?.removeEventListener("resize", onLayoutChange);
            resizeObserver?.disconnect();
            if (suggestionPopupCleanup.get(this) === cleanup) suggestionPopupCleanup.delete(this);
          };
          suggestionPopupCleanup.set(this, cleanup);
          if (focus) closeButton.focus({ preventScroll: true });
        };
        button.onclick = () => {
          if (!detail.hidden) { close(); return; }
          open(true);
        };
        trigger.addEventListener("keydown", event => {
          if (event.key !== "Escape" || detail.hidden) return;
          event.preventDefault();
          event.stopPropagation();
          close(true);
        });
        trigger.addEventListener("focusout", event => {
          if (event.relatedTarget && !trigger.contains(event.relatedTarget as Node)) close();
        });
        if (previouslyOpen === kind) open(restoreFocus);
        return detail;
      };
      const proactiveDetail = popover("proactive", "候选提醒", "查看 候选提醒", "sparkles", this.proactiveCandidates.length);
      if (proactiveDetail) {
        const proactive = proactiveDetail.createDiv({ cls: "lifeops-agent-proactive" });
        const proactiveHead = proactive.createDiv({ cls: "lifeops-agent-suggestions-head" });
        proactiveHead.createDiv({ text: "候选提醒", cls: "lifeops-agent-suggestions-title" });
        proactiveHead.createDiv({ text: `${this.proactiveCandidates.length} 条低打扰建议`, cls: "lifeops-agent-suggestions-hint" });
        const proactiveList = proactive.createDiv({ cls: "lifeops-agent-proactive-list" });
        for (const candidate of this.proactiveCandidates) {
          const card = proactiveList.createDiv({ cls: `lifeops-agent-proactive-card priority-${candidate.priority}` });
          card.createDiv({ text: candidate.title, cls: "lifeops-agent-proactive-title" });
          card.createDiv({ text: candidate.reason, cls: "lifeops-agent-proactive-reason" });
          if (candidate.workflowId) {
            card.createDiv({ text: "接受后生成草稿，后续步骤由你确认。", cls: "lifeops-agent-proactive-meta" });
          }
          const actions = card.createDiv({ cls: "lifeops-agent-proactive-actions" });
          if (candidate.summaryPath && this.controller.openStewardSummary) {
            const button = actions.createEl("button", { text: "查看周摘要", attr: { type: "button" } });
            button.onclick = () => { void this.controller.openStewardSummary?.(candidate.summaryPath!).catch(() => new Notice("周摘要暂时无法打开。")); };
          }
          if (candidate.steward && candidate.kind === "weekly_review" && this.controller.openStewardLearningPlan) {
            const button = actions.createEl("button", { text: "调整学习计划", attr: { type: "button" } });
            button.onclick = () => this.controller.openStewardLearningPlan?.();
          }
          const choices: Array<{ label: string; decision: ProactiveFeedbackDecision }> = [
            { label: candidate.steward ? "知道了" : "接受", decision: "accepted" },
            { label: "稍后", decision: "snoozed" },
            ...(candidate.steward ? [] : [{ label: "忽略", decision: "dismissed" as const }]),
            { label: candidate.steward ? "别再提这类" : "不再提醒", decision: "never" }
          ];
          let feedbackPending = false;
          const feedbackButtons: HTMLButtonElement[] = [];
          for (const choice of choices) {
            const button = actions.createEl("button", {
              text: choice.label,
              cls: "lifeops-agent-proactive-action",
              attr: { type: "button" }
            });
            feedbackButtons.push(button);
            button.addEventListener("click", async () => {
              if (feedbackPending) return;
              feedbackPending = true;
              feedbackButtons.forEach(item => { item.disabled = true; });
              try {
                try {
                  await this.controller.respondToProactiveCandidate(candidate.id, choice.decision);
                } catch {
                  new Notice("提醒处理未完成，请重试或查看操作记录。");
                  return;
                }
                try {
                  await this.render();
                } catch {
                  new Notice("提醒已经处理，但页面更新失败，请刷新页面。");
                }
              } finally {
                feedbackPending = false;
                feedbackButtons.forEach(item => { item.disabled = false; });
              }
            });
          }
        }
      }

      const actionDetail = popover("actions", "待确认", "查看待确认动作", "check-square", this.pendingAgentActions.length);
      if (restoreFocus && ((previouslyOpen === "actions" && !actionDetail) || (previouslyOpen === "proactive" && !proactiveDetail))) {
        this.agentInputEl?.focus({ preventScroll: true });
      }
      if (!actionDetail) return;
      const head = actionDetail.createDiv({ cls: "lifeops-agent-suggestions-head" });
      head.createDiv({ text: "待确认动作", cls: "lifeops-agent-suggestions-title" });
      head.createDiv({
        text: `共 ${this.pendingAgentActions.length} 项，确认后才会写入`,
        cls: "lifeops-agent-suggestions-hint"
      });

      const list = actionDetail.createDiv({ cls: "lifeops-agent-suggestion-list" });
      for (const action of this.pendingAgentActions) {
        this.renderAgentSuggestionCard(list, action);
      }
    },

  refreshAgentSuggestions(this: ViewHost): void {
      if (this.viewClosed) return;
      if (this.agentSuggestionsEl && renderedSuggestionState.get(this.agentSuggestionsEl) !== suggestionState(this)) {
        this.populateAgentSuggestions(this.agentSuggestionsEl);
      }
      this.refreshStewardStatus?.();
    },

  renderAgentSuggestionCard(this: ViewHost, container: HTMLElement, action: AgentActionSuggestion): void {
      if (this.viewClosed) return;
      let displayedAction = action;
      const isDisplayedActionCurrent = (): boolean => !this.viewClosed && this.pendingAgentActions.includes(displayedAction);
      const updateDisplayedAction = (patch: Partial<AgentActionSuggestion>): void => {
        if (!isDisplayedActionCurrent()) return;
        this.updatePendingAgentAction(displayedAction.id, patch);
        displayedAction = this.pendingAgentActions.find(item => item.id === displayedAction.id) ?? displayedAction;
      };
      const card = container.createDiv({ cls: `lifeops-agent-suggestion-card type-${action.type}` });
      const header = card.createDiv({ cls: "lifeops-agent-suggestion-header" });
      const icon = header.createDiv({ cls: "lifeops-agent-suggestion-icon" });
      setIcon(icon, agentActionIcon(action.type));
      const copy = header.createDiv({ cls: "lifeops-agent-suggestion-copy" });
      copy.createDiv({ text: agentActionLabel(action), cls: "lifeops-agent-suggestion-title" });
      copy.createDiv({ text: action.description, cls: "lifeops-agent-suggestion-desc" });

      const preview = card.createDiv({ cls: "lifeops-agent-suggestion-preview" });
      preview.createDiv({ text: "预览", cls: "lifeops-agent-suggestion-meta" });
      const editor = preview.createEl("textarea", {
        cls: "lifeops-agent-suggestion-editor",
        attr: { rows: ["project_change", "task_plan", "idea_advance", "trading_change", "note_understanding", "weekly_review", "review_memory"].includes(action.type) ? "8" : "4" }
      });
      editor.value = action.content;
      if (["delete_task", "delete_habit", "delete_trade", "tool_batch", "review_memory", "project_change", "task_plan", "idea_advance", "trading_change", "note_understanding", "weekly_review"].includes(action.type)) {
        editor.readOnly = true;
        editor.setAttr("aria-label", action.type === "task_plan" ? "将保存的完整任务安排"
          : action.type === "idea_advance" ? "将保存的想法任务安排和下次检查"
          : action.type === "project_change"
          ? "将保存的目标与项目变更（完整差异）"
          : action.type === "weekly_review"
          ? "将保存的周回顾支持、反例和未知信息"
          : action.type === "note_understanding"
          ? "待核对推断和固定版本原文摘录（只保存候选）"
          : action.type === "trading_change"
          ? "将保存的完整交易规则版本或案例"
          : action.type === "review_memory"
          ? "将审查的个人记忆"
          : action.type === "tool_batch" ? "确认后执行的修改"
          : action.type === "delete_trade" ? "将删除的交易"
          : action.type === "delete_task"
            ? "将删除的任务"
            : "将删除的习惯");
      }
      editor.oninput = () => {
        if (this.viewClosed) return;
        if (editor.readOnly) return;
        updateDisplayedAction({ content: editor.value });
        editor.value = displayedAction.content;
      };

      if (action.type === "task_plan") {
        card.createDiv({ text: "核对每项日期、时间和分类，点击后才保存；中断可从“可恢复安排”接续。", cls: "lifeops-agent-suggestion-meta" });
      } else if (action.type === "idea_advance") {
        card.createDiv({ text: "核对日期、用时和下次检查，点击确认后才保存。", cls: "lifeops-agent-suggestion-meta" });
      } else if (action.type === "project_change") {
        card.createDiv({ text: "核对完整变更后，点击确认才会保存。", cls: "lifeops-agent-suggestion-meta" });
      } else if (action.type === "weekly_review") {
        card.createDiv({ text: "点击只保存回顾草稿；更正另存版本，不确认记忆或完成任务。", cls: "lifeops-agent-suggestion-meta" });
      } else if (action.type === "note_understanding") {
        card.createDiv({ text: "只保存待核对理解，是否记住需另行确认；原笔记保持。", cls: "lifeops-agent-suggestion-meta" });
      } else if (action.memoryFile) {
        const memoryRow = card.createDiv({ cls: "lifeops-agent-suggestion-memory" });
        memoryRow.createSpan({ text: "记忆文件", cls: "lifeops-agent-suggestion-meta" });
        const select = memoryRow.createEl("select", { cls: "lifeops-agent-suggestion-select" });
        for (const file of agentMemoryFiles()) {
          select.createEl("option", { text: file, value: file });
        }
        select.value = action.memoryFile;
        select.onchange = () => {
          if (this.viewClosed) return;
          updateDisplayedAction({ memoryFile: select.value });
          select.value = displayedAction.memoryFile ?? "";
        };
      } else {
        card.createDiv({ text: `写入日期：${action.date}`, cls: "lifeops-agent-suggestion-meta" });
      }

      const actions = card.createDiv({ cls: "lifeops-agent-suggestion-actions" });
      this.iconButton(actions, "check", "确认", () => {
        if (isDisplayedActionCurrent()) void this.acceptAgentSuggestion(displayedAction);
      }, "primary");
      this.iconButton(actions, "x", "拒绝", () => {
        if (isDisplayedActionCurrent()) void this.dismissAgentSuggestion(displayedAction.id, displayedAction);
      });
    },

  updatePendingAgentAction(this: ViewHost, actionId: string, patch: Partial<AgentActionSuggestion>): void {
      if (this.viewClosed || this.agentBusy || this.pendingAgentActions.some(item => item.id === actionId && executingSuggestions.has(item))) return;
      this.pendingAgentActions = this.pendingAgentActions.map((item) => (
        item.id === actionId ? { ...item, ...patch } : item
      ));
      // The active editor already reflects this edit; navigation must keep its DOM and focus.
      if (this.agentSuggestionsEl) renderedSuggestionState.set(this.agentSuggestionsEl, suggestionState(this));
    },

  iconButton(this: ViewHost, container: HTMLElement, icon: string, label: string, action: () => void, tone = ""): void {
      container.createEl("button", { cls: tone ? `lifeops-agent-action-${tone}` : "" }, (button) => {
        setIcon(button.createSpan({ cls: "lifeops-button-icon" }), icon);
        button.createSpan({ text: label });
        button.onclick = action;
      });
    },

  async acceptAgentSuggestion(this: ViewHost, action: AgentActionSuggestion, voiceTurn?: () => boolean): Promise<string | undefined> {
      if (this.viewClosed) return;
      this.recoverTimedOutAgentBusy();
      if (voiceTurn ? !voiceTurn() || !this.agentBusy : this.agentBusy) return;
      const currentAction = voiceTurn || action.type === "task_plan"
        ? this.pendingAgentActions.find(item => item === action)
        : this.pendingAgentActions.find((item) => item.id === action.id);
      if (!currentAction || executingSuggestions.has(currentAction)) return;
      const receiptTitle = currentAction.title;
      const viewGeneration = this.agentTextRequestGeneration ?? 0;
      if (!voiceTurn) this.setAgentBusy(true);
      const activityGeneration = this.agentActivityGeneration ?? 0;
      const isCurrentActivity = (): boolean => !this.viewClosed && (!voiceTurn || voiceTurn())
        && (this.agentTextRequestGeneration ?? 0) === viewGeneration
        && (this.agentActivityGeneration ?? 0) === activityGeneration;
      const refreshCurrentSuggestions = (): void => {
        if (this.viewClosed) return;
        try {
          this.refreshAgentSuggestions();
        } catch {
          // A display failure cannot undo a committed fact or suppress its receipt.
          if (this.agentSuggestionsEl) renderedSuggestionState.delete(this.agentSuggestionsEl);
          console.warn("LifeOps suggestion display refresh failed; a later refresh can retry.");
        }
      };
      executingSuggestions.add(currentAction);
      this.agentReply = `正在执行：${currentAction.title}`;
      this.refreshAgentSurfaceState();
      try {
        const receipt = await this.controller.executeAgentAction(currentAction);
        const actualReceipt = typeof receipt === "string" && receipt.trim() ? receipt : undefined;
        // The write really completed, including after navigation. Remove only that exact card.
        this.pendingAgentActions = this.pendingAgentActions.filter((item) => item !== currentAction);
        refreshCurrentSuggestions();
        if (!voiceTurn && isCurrentActivity()) {
          this.agentReply = typeof receipt === "string" ? receipt : `已执行：${currentAction.title}`;
          if (actualReceipt || ["task_plan", "project_change", "note_understanding", "weekly_review", "trading_change"].includes(currentAction.type)) {
            this.agentMessages = [...this.agentMessages, { role: "assistant" as const, content: this.agentReply }].slice(-12);
            this.appendAgentMessage({ role: "assistant", content: this.agentReply });
            this.scrollAgentTranscriptToBottom();
          }
        }
        let historyFailed = false;
        if (actualReceipt && this.controller.appendAgentActionReceipt) {
          try { historyFailed = !await this.controller.appendAgentActionReceipt(receiptTitle, actualReceipt); }
          catch { historyFailed = true; }
        }
        if (historyFailed && isCurrentActivity()) {
          new Notice("操作已完成；历史记录未能核验保存，请在最近操作核对。");
        }
        await this.controller.appendQualityLog({
          inputSource: voiceTurn ? "voice" : "text",
          userAcceptedActions: 1,
          actionSuggestions: 1,
          ...(historyFailed ? { errorCode: "AGENT_ACTION_HISTORY_FAILED", errorMessage: "实际操作已完成，但回执历史未能核验保存。" } : {})
        }).catch(() => undefined);
        return actualReceipt ?? `已执行：${currentAction.title}`;
      } catch (error) {
        const failureReply = error instanceof Error ? `执行失败：${error.message}` : "执行建议失败";
        if (isCurrentActivity()) this.agentReply = failureReply;
        await this.controller.appendQualityLog({
          inputSource: voiceTurn ? "voice" : "text",
          actionSuggestions: 1,
          errorCode: "AGENT_ACTION_FAILED",
          errorMessage: error instanceof Error ? error.message : "执行建议失败"
        }).catch(() => undefined);
        if (isCurrentActivity()) new Notice(failureReply);
        return failureReply;
      } finally {
        executingSuggestions.delete(currentAction);
        if (!voiceTurn && isCurrentActivity()) {
          this.setAgentBusy(false);
          this.refreshAgentSurfaceState();
          refreshCurrentSuggestions();
        }
      }
    },

  async tryAcceptPendingActionFromVoice(this: ViewHost, message: string): Promise<boolean> {
      if (this.viewClosed || this.agentBusy) return false;
      if (this.pendingAgentActions.length !== 1) return false;
      const action = this.pendingAgentActions[0];
      if (executingSuggestions.has(action)) return false;
      if (["delete_task", "delete_habit", "delete_trade", "tool_batch", "update_memory", "review_memory", "project_change", "task_plan", "idea_advance", "trading_change", "note_understanding", "weekly_review"].includes(action.type)) {
        return false; // High-risk actions require the visible card's confirmation button.
      }
      if (!isVoiceActionConfirmation(message, action)) return false;
      this.rememberSentVoiceTurn(message);
      this.clearVoiceTurnBufferAfterSend();
      this.setAgentInput("");
      await this.acceptAgentSuggestion(action);
      return true;
    },

  async dismissAgentSuggestion(this: ViewHost, actionId: string, expectedAction?: AgentActionSuggestion, voiceTurn?: () => boolean): Promise<void> {
      if (this.viewClosed || (voiceTurn ? !voiceTurn() : this.agentBusy)) return;
      const matching = this.pendingAgentActions.filter(item => item.id === actionId);
      const currentAction = expectedAction ? matching.find(item => item === expectedAction) : matching.length === 1 ? matching[0] : undefined;
      if (!currentAction || executingSuggestions.has(currentAction)) return;
      this.controller.dismissAgentAction?.(currentAction);
      this.pendingAgentActions = this.pendingAgentActions.filter((item) => item !== currentAction);
      this.refreshAgentSuggestions();
      await this.controller.appendQualityLog({
        inputSource: voiceTurn ? "voice" : "text",
        rejectedActions: 1,
        actionSuggestions: 1
      }).catch(() => undefined);
    },
};

export function applySuggestionsPanel(View: ViewConstructor): void {
  Object.assign(View.prototype, suggestionsPanel);
}

function agentActionIcon(type: AgentActionSuggestion["type"]): string {
  switch (type) {
    case "create_task":
      return "list-plus";
    case "delete_task":
    case "delete_habit":
    case "delete_trade":
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
      return "brain";
    case "review_memory":
      return "shield-check";
    case "project_change":
      return "git-compare";
    case "task_plan":
    case "idea_advance":
      return "list-checks";
    case "send_to_inbox":
    default:
      return "inbox";
  }
}

function agentActionLabel(action: AgentActionSuggestion): string {
  if (action.type === "project_change") return "目标与项目变更确认";
  if (action.type === "update_memory" && action.memoryFile) {
    return `${action.title} · ${action.memoryFile.replace(/\.md$/i, "")}`;
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
