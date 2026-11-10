import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import * as THREE from "three";
import { BailianRealtimeClient } from "../bailianRealtime";
import { BailianRealtimeTtsClient } from "../bailianTtsRealtime";
import type { AiToolCall } from "../ai";
import { addDays, formatLocalTime, todayString, weekDates } from "../date";
import { isHabitRequiredOn as isHabitRequiredOnDate, numericHabitWindow } from "../features/habits/targets";
import { tradeHabitDayDisplay } from "../features/habits/tradeProgress";
import { compensationDueLabel, formatCompensationMoney, summarizeCompensationDebt } from "../features/habits/compensationDebt";
import { taskDayInterval, taskScheduleLabel, taskTimeGroup, taskTimelineStart, type TaskTimeGroup } from "../taskSchedule";
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
  transcribeAgentAudio(audio: Blob): Promise<string>;
  appendQualityLog(entry: QualityLogEntry): Promise<void>;
  getPluginAssetUrl(relativePath: string): string;
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


export interface StatusBarPanelApi {
  detachReusableAgentSurface(...args: any[]): any;
  refreshAgentPanel(...args: any[]): any;
  renderToolbar(...args: any[]): any;
  renderHeader(...args: any[]): any;
  renderModeNav(...args: any[]): any;
  renderTodayBrief(...args: any[]): any;
  renderTasks(...args: any[]): any;
  renderMatrix(...args: any[]): any;
  renderHabits(...args: any[]): any;
  renderCalendar(...args: any[]): any;
  renderWeekCalendar(...args: any[]): any;
  renderDayCalendar(...args: any[]): any;
  renderCalendarDayDetail(...args: any[]): any;
  renderCalendarEvent(...args: any[]): any;
  calendarTaskButton(...args: any[]): any;
  moveCalendar(...args: any[]): any;
  renderTaskList(...args: any[]): any;
  renderTodayTaskGroups(...args: any[]): any;
  renderGroupedTaskView(...args: any[]): any;
  renderTaskCard(...args: any[]): any;
  quadrantButtons(...args: any[]): any;
  tasksForFilter(...args: any[]): any;
  filteredTasks(...args: any[]): any;
  actionButton(...args: any[]): any;
  smallAddButton(...args: any[]): any;
  plainButton(...args: any[]): any;
  deleteButton(...args: any[]): any;
  habitDeleteButton(...args: any[]): any;
  toggleButton(...args: any[]): any;
  renderHabitHeatmap(...args: any[]): any;
  renderHabitDetail(...args: any[]): any;
  defaultsForFilter(...args: any[]): any;
  toolButton(...args: any[]): any;
  renderAgentBar(...args: any[]): any;
  renderAgentWorkspace(...args: any[]): any;
  agentModeButton(...args: any[]): any;
  agentUtilityButton(...args: any[]): any;
  agentReplyModeButton(...args: any[]): any;
  renderAgentWave(...args: any[]): any;
  agentVisualActivity(...args: any[]): any;
  agentSurfaceClass(...args: any[]): any;
  refreshAgentSurfaceState(...args: any[]): any;
  agentStatusLabel(...args: any[]): any;
  run(...args: any[]): any;
}

const statusBarPanel = {
  detachReusableAgentSurface(this: ViewHost): HTMLElement | null {
      if (!this.agentSurfaceEl) return null;
      const wantsWorkspace = this.agentWorkspaceOpen && this.agentSurfaceEl.hasClass("lifeops-agent-workspace");
      const wantsDock = !this.agentWorkspaceOpen && this.agentSurfaceEl.hasClass("lifeops-agent-dock");
      if (!wantsWorkspace && !wantsDock) return null;
      const surface = this.agentSurfaceEl;
      surface.remove();
      return surface;
    },

  async refreshAgentPanel(this: ViewHost): Promise<void> {
      if (typeof this.refreshStewardConversation === "function") {
        await this.refreshStewardConversation();
        return;
      }
      const [stats, board, proactiveCandidates] = await Promise.all([
        this.controller.getStats(),
        this.controller.getTaskDashboard(),
        this.controller.getProactiveCandidates()
      ]);
      this.proactiveCandidates = proactiveCandidates.slice(0, 3);
      this.agentVisual?.dispose();
      this.agentSurfaceEl?.remove();
      this.agentSurfaceEl = null;
      this.agentVisualWrapEl = null;
      this.agentStatusEl = null;
      this.agentTraceEl = null;
      this.agentTranscriptEl = null;
      this.agentInputEl = null;
      this.agentSuggestionsEl = null;
      this.agentReplyEl = null;
      this.agentComposerContainerEl = null;
      this.agentModeButtons = [];

      if (this.agentWorkspaceOpen) {
        const shell = this.contentEl.querySelector<HTMLElement>(".lifeops-layout");
        if (!shell) {
          await this.render();
          return;
        }
        this.renderAgentWorkspace(shell, stats, board);
        return;
      }

      this.renderAgentBar(this.contentEl, stats, board);
    },

  renderToolbar(this: ViewHost, container: HTMLElement, board: TaskDashboardData): void {
      const toolbar = container.createDiv({ cls: "lifeops-toolbar" });
      const title = toolbar.createDiv({ cls: "lifeops-toolbar-title" });
      title.createDiv({ text: "LifeOps 任务管理", cls: "lifeops-title-main" });
      title.createDiv({ text: `${board.date} · 仿思源任务面板`, cls: "lifeops-title-sub" });

      const actions = toolbar.createDiv({ cls: "lifeops-toolbar-actions" });
      this.toolButton(actions, "plus", "新建任务", () => this.controller.openTaskModal(), true);
      this.toolButton(actions, "badge-plus", "新建习惯", () => this.controller.openHabitModal());
      this.toolButton(actions, "inbox", "快速记录", () => this.controller.openQuickCapture());
      this.toolButton(actions, "heart-pulse", "健康记录", () => this.controller.openHealthEntryModal());
      this.toolButton(actions, "notebook-pen", "记录交易", () => this.controller.openTradeEntryModal());
      this.toolButton(actions, "file-text", "生成日报", () => this.controller.generateDailyReview());
      this.toolButton(actions, "candlestick-chart", "交易复盘", () => this.controller.generateTradingReview());
      this.toolButton(actions, "refresh-cw", "刷新", () => this.render());
    },

  renderHeader(this: ViewHost, container: HTMLElement, stats: DashboardStats, board: TaskDashboardData): void {
      const header = container.createDiv({ cls: "lifeops-command-header" });
      const hero = header.createDiv({ cls: "lifeops-command-hero" });
      const heroTop = hero.createDiv({ cls: "lifeops-command-hero-top" });
      const heroCopy = heroTop.createDiv();
      heroCopy.createDiv({ cls: "lifeops-command-title", text: "今日状态" });
      heroCopy.createDiv({ cls: "lifeops-command-subtitle", text: `${board.today.length} 待办 · ${board.overdue.length} 过期 · ${stats.habitDone}/${stats.habitTotal} 打卡` });
      heroTop.createDiv({ text: board.date, cls: "lifeops-date-badge" });
      const progress = board.today.length + board.completedToday.length === 0 ? 0 : Math.round((board.completedToday.length / (board.today.length + board.completedToday.length)) * 100);
      const progressWrap = hero.createDiv({ cls: "lifeops-command-progress" });
      progressWrap.createDiv({ text: `今日完成度 ${progress}%`, cls: "lifeops-command-progress-label" });
      progressWrap.createDiv({ cls: "lifeops-command-progress-track" }).createDiv({
        cls: "lifeops-command-progress-bar",
        attr: { style: `width: ${progress}%` }
      });
      const grid = header.createDiv({ cls: "lifeops-grid lifeops-summary-grid" });
      stat(grid, "今日任务", String(board.today.length), "calendar-check", "blue");
      stat(grid, "过期任务", String(board.overdue.length), "alert-triangle", board.overdue.length > 0 ? "red" : "gray");
      stat(grid, "未来七天", String(board.nextSevenDays.length), "calendar-days", "green");
      stat(grid, "今日完成", String(board.completedToday.length), "check-circle-2", "teal");
      stat(grid, "习惯打卡", `${stats.habitDone}/${stats.habitTotal}`, "badge-check", "violet");
      stat(grid, "复盘状态", stats.punishmentOpen ? "待接受" : "正常", "shield-alert", stats.punishmentOpen ? "red" : "gray");
    },

  renderModeNav(this: ViewHost, container: HTMLElement): void {
      const nav = container.createDiv({ cls: "lifeops-mode-nav", attr: { role: "group", "aria-label": "事务视图" } });
      const items: Array<[LifeOpsMode, string, string]> = [
        ["tasks", "任务中心", "list-checks"],
        ["matrix", "四象限", "layout-grid"],
        ["habits", "习惯打卡", "badge-check"],
        ["calendar", "日历", "calendar-days"]
      ];

      for (const [mode, label, icon] of items) {
        nav.createEl("button", {
          cls: mode === this.mode ? "is-active" : "",
          attr: { type: "button", "aria-pressed": String(mode === this.mode), "data-lifeops-affairs-mode": mode }
        }, (button) => {
          setIcon(button.createSpan({ cls: "lifeops-button-icon" }), icon);
          button.createSpan({ text: label });
          button.onclick = async () => {
            this.mode = mode;
            await this.render();
          };
        });
      }
    },

  renderTodayBrief(this: ViewHost, container: HTMLElement, board: TaskDashboardData): void {
      const section = container.createDiv({ cls: "lifeops-today-brief" });
      const panels = [
        {
          title: "今日行动",
          tone: "blue",
          empty: "今天还没有安排任务。",
          rows: board.today.slice(0, 5).map((task) => ({
            title: task.title,
            meta: task.time ? `${task.time} · ${priorityLabel(task.priority)}` : priorityLabel(task.priority),
            action: () => this.controller.openTaskActionsModal(task)
          }))
        },
        {
          title: "需要处理",
          tone: board.overdue.length > 0 ? "red" : "gray",
          empty: "没有过期任务。",
          rows: board.overdue.slice(0, 5).map((task) => ({
            title: task.title,
            meta: task.dueDate ? `截止 ${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ""}` : task.date || "无日期",
            action: () => this.controller.openTaskActionsModal(task)
          }))
        },
        {
          title: "待打习惯",
          tone: "green",
          empty: "当前没有待处理习惯。",
          rows: board.habits.filter((item) => item.requiredToday && item.status === "pending").slice(0, 5).map((item) => ({
            title: item.habit.name,
            meta: `${habitFrequencyLabel(item.habit)} · ${item.periodLabel} ${item.periodDone}/${item.periodTarget}${item.periodUnit ? ` ${item.periodUnit}` : ""}`,
            action: () => item.habit.source === "trades" ? this.controller.openHabitDetailModal(item) : this.controller.openHabitCheckinModal(item.habit, { status: "done" })
          }))
        },
        {
          title: "今日完成",
          tone: "teal",
          empty: "还没有完成记录。",
          rows: board.completedToday.slice(0, 5).map((task) => {
            const completedTime = formatLocalTime(task.completedAt);
            return {
              title: task.title,
              meta: completedTime ? `完成于 ${completedTime}` : "已完成",
              action: () => this.controller.openTaskActionsModal(task)
            };
          })
        }
      ];

      for (const panel of panels) {
        const box = section.createDiv({ cls: `lifeops-brief-panel tone-${panel.tone}` });
        const title = box.createDiv({ cls: "lifeops-brief-title" });
        title.createSpan({ text: panel.title });
        title.createSpan({ text: String(panel.rows.length), cls: "lifeops-brief-count" });
        const list = box.createDiv({ cls: "lifeops-brief-list" });
        if (panel.rows.length === 0) {
          list.createDiv({ text: panel.empty, cls: "lifeops-muted" });
          continue;
        }
        for (const row of panel.rows) {
          const item = list.createDiv({ cls: "lifeops-brief-row" });
          item.createDiv({ text: row.title, cls: "lifeops-brief-row-title" });
          item.createDiv({ text: row.meta, cls: "lifeops-brief-row-meta" });
          item.onclick = row.action;
        }
      }
    },

  renderTasks(this: ViewHost, container: HTMLElement, board: TaskDashboardData): void {
      const shell = container.createDiv({ cls: "lifeops-task-shell" });
      const sidebar = shell.createDiv({ cls: "lifeops-filter-list lifeops-task-filters" });
      const sideTitle = sidebar.createDiv({ cls: "lifeops-panel-title" });
      setIcon(sideTitle.createSpan({ cls: "lifeops-panel-icon" }), "list-filter");
      sideTitle.createSpan({ text: "任务面板" });
      const filters: Array<[TaskFilter, string, number, string]> = [
        ["today", "今日任务", board.today.length, "sun"],
        ["overdue", "过期任务", board.overdue.length, "alert-circle"],
        ["deadline", "截止任务", board.allActive.filter((task) => task.dueDate).length, "alarm-clock"],
        ["recurring", "重复任务", board.allActive.filter((task) => task.repeatUnit !== "none").length, "repeat-2"],
        ["tomorrow", "明日任务", board.tomorrow.length, "calendar-plus"],
        ["next-seven", "未来七天", board.nextSevenDays.length, "calendar-days"],
        ["no-date", "无日期任务", board.noDate.length, "circle-dashed"],
        ["completed", "今日已完成", board.completedToday.length, "check-check"],
        ["completed-all", "完成历史", board.tasks.filter((task) => task.status === "completed").length, "history"],
        ["all", "所有未完成", board.allActive.length, "list-todo"],
        ["by-project", "项目视图", uniqueCount(board.allActive, (task) => task.project || "默认"), "folder-kanban"],
        ["by-category", "分类视图", uniqueCount(board.allActive, (task) => task.category || "待分类"), "tags"],
        ["by-date", "日期视图", uniqueCount(board.allActive, (task) => task.date || "无日期"), "calendar-range"]
      ];

      const commonFilters = new Set<TaskFilter>(["today", "overdue", "tomorrow", "next-seven", "all"]);
      const common = sidebar.createDiv({ cls: "lifeops-task-filters-common" });
      const more = sidebar.createEl("details", { cls: "lifeops-task-filters-more" });
      more.open = !commonFilters.has(this.taskFilter);
      more.createEl("summary", { text: commonFilters.has(this.taskFilter) ? "更多筛选" : `更多筛选 · ${filterLabel(this.taskFilter)}` });
      const extra = more.createDiv({ cls: "lifeops-task-filters-extra" });
      for (const [filter, label, count, icon] of filters) {
        const row = (commonFilters.has(filter) ? common : extra).createEl("button", {
          cls: `lifeops-filter-row ${filter === this.taskFilter ? "is-active" : ""}`,
          attr: { type: "button", "data-lifeops-task-filter": filter, "aria-pressed": String(filter === this.taskFilter) }
        });
        setIcon(row.createSpan({ cls: "lifeops-filter-icon" }), icon);
        row.createSpan({ text: label, cls: "lifeops-filter-label" });
        row.createSpan({ text: String(count), cls: "lifeops-filter-count" });
        row.onclick = async () => {
          this.taskFilter = filter;
          await this.render();
        };
      }

      const main = shell.createDiv({ cls: "lifeops-task-main" });
      const taskHeader = main.createDiv({ cls: "lifeops-content-header" });
      taskHeader.createEl("h3", { text: filterLabel(this.taskFilter) });
      const headerActions = taskHeader.createDiv({ cls: "lifeops-inline-actions" });
      const tasks = this.filteredTasks(this.tasksForFilter(board));
      headerActions.createEl("input", {
        cls: "lifeops-task-search",
        attr: { type: "search", placeholder: "搜索任务", value: this.taskSearch }
      }, (input) => {
        let composing = false;
        const search = async () => {
          if (input.value === this.taskSearch) return;
          this.taskSearch = input.value;
          await this.render();
        };
        input.addEventListener("compositionstart", () => { composing = true; });
        input.addEventListener("compositionend", () => { composing = false; void search(); });
        input.oninput = async (event) => {
          if (composing || (event as InputEvent).isComposing) return;
          await search();
        };
      });
      headerActions.createDiv({ text: `${tasks.length} 项`, cls: "lifeops-content-count" });
      const activeTasks = tasks.filter((task) => task.status === "active");
      if (activeTasks.length > 0 && this.taskFilter !== "completed" && this.taskFilter !== "completed-all") {
        this.smallAddButton(headerActions, "批量明天", () => {
          if (!window.confirm(`将当前筛选下 ${activeTasks.length} 个进行中任务全部延后一天？`)) return;
          void this.run("任务已批量延后", () => this.controller.postponeTasks(activeTasks.map((task) => task.id), 1));
        });
      }
      if (this.taskFilter === "today") {
        this.renderTodayTaskGroups(main, tasks, board);
        return;
      }
      if (this.taskFilter === "by-project") {
        this.renderGroupedTaskView(
          main,
          groupTasks(this.filteredTasks(board.allActive), (task) => task.project || "默认"),
          (project) => ({ project, date: board.date }),
          "当前没有项目任务。"
        );
        return;
      }
      if (this.taskFilter === "by-category") {
        this.renderGroupedTaskView(
          main,
          groupTasks(this.filteredTasks(board.allActive), (task) => task.category || "待分类"),
          (category) => ({ category, date: board.date }),
          "当前没有分类任务。"
        );
        return;
      }
      if (this.taskFilter === "by-date") {
        this.renderGroupedTaskView(
          main,
          groupTasks(this.filteredTasks(board.allActive), (task) => task.date || "无日期"),
          (date) => ({ date: date === "无日期" ? "" : date }),
          "当前没有日期任务。"
        );
        return;
      }
      this.renderTaskList(main, tasks, "当前没有任务。");
    },

  renderMatrix(this: ViewHost, container: HTMLElement, board: TaskDashboardData): void {
      const matrix = container.createDiv({ cls: "lifeops-matrix" });
      const quadrants: Array<[LifeOpsTaskQuadrant, string, string]> = [
        ["important-urgent", "重要且紧急", "lifeops-q1"],
        ["important-not-urgent", "重要不紧急", "lifeops-q2"],
        ["not-important-urgent", "不重要但紧急", "lifeops-q3"],
        ["not-important-not-urgent", "不重要不紧急", "lifeops-q4"]
      ];

      for (const [quadrant, label, cls] of quadrants) {
        const panel = matrix.createDiv({ cls: `lifeops-quadrant ${cls}` });
        const title = panel.createDiv({ cls: "lifeops-quadrant-title" });
        title.createSpan({ text: label, cls: "lifeops-quadrant-label" });
        const titleRight = title.createSpan({ cls: "lifeops-inline-actions" });
        titleRight.createSpan({ text: String(board.quadrants[quadrant].length), cls: "lifeops-filter-count" });
        this.smallAddButton(titleRight, "添加", () => this.controller.openTaskModalWithDefaults({ quadrant, date: todayString() }));
        this.renderTaskList(panel, board.quadrants[quadrant], "暂无任务。", true);
        const list = panel.querySelector<HTMLElement>(".lifeops-task-list");
        if (list) { list.tabIndex = 0; list.setAttribute("role", "region"); list.setAttribute("aria-label", `${label}任务，可滚动查看全部`); }
      }
    },

  renderHabits(this: ViewHost, container: HTMLElement, board: TaskDashboardData, stats: DashboardStats): void {
      const header = container.createDiv({ cls: "lifeops-content-header" });
      header.createEl("h3", { text: "习惯打卡" });
      const overview = container.createDiv({ cls: "lifeops-habit-overview" });
      const dailyRequired = board.habits.filter(item => item.periodLabel === "今日" && item.requiredToday).length;
      const weeklyCounts = board.habits.filter(item => item.periodLabel === "本周" && !item.periodUnit);
      const weeklyTarget = weeklyCounts.reduce((sum, item) => sum + item.periodTarget, 0);
      const weeklyDone = weeklyCounts.reduce((sum, item) => sum + Math.min(item.periodDone, item.periodTarget), 0);
      overview.createDiv({ text: `今日 ${stats.habitDone}/${stats.habitTotal}`, cls: "lifeops-habit-overview-item tone-green" });
      overview.createDiv({ text: weeklyTarget > 0 ? `今日应打 ${dailyRequired} · 本周 ${weeklyDone}/${weeklyTarget}` : `今日应打 ${dailyRequired}`, cls: "lifeops-habit-overview-item tone-blue" });
      overview.createDiv({ text: `总习惯 ${board.habits.length}`, cls: "lifeops-habit-overview-item tone-blue" });
      overview.createDiv({
        text: `本周未完成 ${Object.values(stats.weeklyFailures).reduce((sum, count) => sum + count, 0)}`,
        cls: "lifeops-habit-overview-item tone-red"
      });
      overview.createDiv({ text: stats.punishmentOpen ? "有待确认的复盘提醒" : "暂无复盘提醒", cls: `lifeops-habit-overview-item ${stats.punishmentOpen ? "tone-red" : "tone-violet"}` });
      const section = container.createDiv({ cls: "lifeops-habit-grid" });
      if (board.habits.length === 0) {
        const empty = section.createDiv({ cls: "lifeops-habit-empty" });
        empty.createDiv({ text: "还没有习惯。点击“添加习惯”后，它会固定出现在这里并开始统计。", cls: "lifeops-muted" });
      }
      for (const item of board.habits) {
        const row = section.createDiv({ cls: `lifeops-habit-card status-${item.status}` });
        const top = row.createDiv({ cls: "lifeops-habit-top" });
        const left = top.createDiv();
        left.createDiv({ text: item.habit.name, cls: "lifeops-habit-name" });
        const auto = item.habit.source === "trades";
        const periodProgress = item.periodUnavailable ? "进度未知" : `${item.periodDone}/${item.periodTarget}${item.periodUnit ? ` ${item.periodUnit}` : ""}`;
        left.createDiv({
          text: item.periodUnavailable ? "交易记录暂不可用，进度未知。"
            : `${habitRequirementLabel(item)} · ${habitFrequencyLabel(item.habit)} · ${item.periodLabel} ${periodProgress} · 连续 ${item.streak} 天 · 总计 ${item.totalDone} ${auto ? "笔" : "次"}`,
          cls: item.weeklyFailures > 0 ? "lifeops-warning-text" : "lifeops-muted"
        });
        const status = top.createDiv({ cls: `lifeops-habit-status status-${item.status}` });
        status.createSpan({ text: item.periodUnavailable ? "交易记录暂不可用"
          : auto && item.status !== "leave" ? item.status === "done" ? "已达标" : "未达标" : habitStatusLabel(item.status) });
        const progress = row.createDiv({ cls: "lifeops-habit-progress" });
        const progressWidth = Math.max(8, Math.min(100, Math.round(item.periodDone / item.periodTarget * 100)));
        progress.createDiv({
          cls: `lifeops-habit-progress-bar status-${item.status}`,
          attr: { style: `width: ${item.status === "missed" ? 18 : item.status === "leave" ? 55 : progressWidth}%` }
        });
        const actions = row.createDiv({ cls: "lifeops-card-actions lifeops-habit-actions" });
        if (auto) {
          actions.createSpan({ text: "按交易记录计算", cls: "lifeops-muted" });
        } else if (item.habit.target?.kind === "number") {
          this.plainButton(actions, "记录数值", () => this.controller.openHabitCheckinModal(item.habit, { status: "done" }));
        } else {
          this.actionButton(actions, item.habit.targetCount > 1 ? "完成 +1" : "完成", () => this.controller.recordHabitStatus(item.habit.id, "done"));
        }
        if (!auto) this.actionButton(actions, "未完成", () => this.controller.recordHabitStatus(item.habit.id, "missed"));
        this.actionButton(actions, "请假", () => this.controller.recordHabitStatus(item.habit.id, "leave"));
        if (!auto) this.plainButton(actions, "记录", () => this.controller.openHabitCheckinModal(item.habit, { status: item.status === "pending" ? "done" : item.status }));
        if (!auto) this.plainButton(actions, "补昨天", () => {
          const date = addDays(todayString(), -1);
          if (item.habit.target?.kind === "number") this.controller.openHabitCheckinModal(item.habit, { status: "done", date });
          else void this.run("已补记昨天", () => this.controller.recordHabitStatus(item.habit.id, "done", date));
        });
        if (item.checkin && (!auto || item.checkin.status === "leave")) {
          this.plainButton(actions, "撤销", () => {
            void this.run("已撤销今日打卡", () => this.controller.clearHabitCheckin(item.habit.id));
          });
        }
        this.plainButton(actions, "档案", () => this.controller.openHabitDetailModal(item));
        this.plainButton(actions, "编辑", () => this.controller.openHabitEditModal(item.habit));
        this.toggleButton(actions, this.expandedHabitId === item.habit.id ? "收起" : "详情", async () => {
          this.expandedHabitId = this.expandedHabitId === item.habit.id ? "" : item.habit.id;
          await this.render();
        });
        this.habitDeleteButton(actions, item.habit);
        this.renderHabitHeatmap(row, item);
        if (this.expandedHabitId === item.habit.id) {
          this.renderHabitDetail(row, item);
        }
      }

      const active = board.tasks.filter(task => task.category === "punishment" && task.status === "active" && task.habitPunishment);
      const punishment = container.createDiv({ cls: `lifeops-section ${active.length || stats.punishmentOpen ? "lifeops-warning" : ""}` });
      punishment.createEl("h3", { text: "补偿待办" });
      const saved = formatCompensationMoney(summarizeCompensationDebt(board.tasks, todayString()).saved);
      if (saved) punishment.createDiv({ text: `存钱账 · 已记 ${saved}`, cls: "lifeops-muted" });
      if (active.length === 0) punishment.createDiv({ text: "当前没有补偿待办。", cls: "lifeops-muted" });
      else {
        const list = punishment.createDiv({ cls: "lifeops-punishment-list" });
        for (const task of active) {
          const row = list.createDiv({ cls: "lifeops-punishment-row" });
          row.createDiv({ text: task.title });
          const due = compensationDueLabel(task.habitPunishment!);
          if (due) row.createDiv({ text: `当前应完成：${due}` });
          row.createDiv({ text: `${task.habitPunishment?.evidence ?? task.note} 到期 ${task.dueDate}`, cls: "lifeops-muted" });
          this.actionButton(row, "标为完成", () => this.controller.completeTask(task.id));
        }
      }
      if (stats.punishmentOpen) {
        punishment.createEl("button", { text: "确认旧复盘提醒" }, (button) => {
          button.onclick = () => this.run("复盘提醒已确认", () => this.controller.acceptPunishments());
        });
      }
    },

  renderCalendar(this: ViewHost, container: HTMLElement, board: TaskDashboardData): void {
      const toolbar = container.createDiv({ cls: "lifeops-calendar-toolbar" });
      toolbar.createEl("h3", { text: this.calendarMode === "month" ? `${monthTitle(this.calendarDate)} 任务日历` : `${this.selectedCalendarDate} 任务日历` });
      const toolbarActions = toolbar.createDiv({ cls: "lifeops-calendar-toolbar-actions" });
      const nav = toolbarActions.createDiv({ cls: "lifeops-calendar-nav" });
      const [previousLabel, nextLabel] = calendarNavLabels(this.calendarMode);
      nav.createEl("button", { text: previousLabel }, (button) => {
        button.onclick = async () => {
          this.moveCalendar(-1);
          await this.render();
        };
      });
      nav.createEl("button", { text: "今天" }, (button) => {
        button.onclick = async () => {
          this.calendarDate = todayString();
          this.selectedCalendarDate = todayString();
          await this.render();
        };
      });
      nav.createEl("button", { text: nextLabel }, (button) => {
        button.onclick = async () => {
          this.moveCalendar(1);
          await this.render();
        };
      });
      const modes = toolbarActions.createDiv({ cls: "lifeops-segmented" });
      for (const mode of ["month", "week", "day"] as const) {
        modes.createEl("button", { text: calendarModeLabel(mode), cls: this.calendarMode === mode ? "is-active" : "" }, (button) => {
          button.onclick = async () => {
            this.calendarMode = mode;
            await this.render();
          };
        });
      }

      const selectedDate = this.selectedCalendarDate;
      if (this.calendarMode === "day") {
        this.renderDayCalendar(container, board, selectedDate);
        return;
      }
      if (this.calendarMode === "week") {
        this.renderWeekCalendar(container, board, selectedDate);
        return;
      }

      const shell = container.createDiv({ cls: "lifeops-calendar-workspace" });
      const month = shell.createDiv({ cls: "lifeops-month-calendar" });
      const weekdays = month.createDiv({ cls: "lifeops-month-weekdays" });
      for (const day of ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]) {
        weekdays.createDiv({ text: day, cls: day === "周日" || day === "周六" ? "lifeops-weekday is-weekend" : "lifeops-weekday" });
      }

      const calendar = month.createDiv({ cls: "lifeops-month-grid" });
      for (const cell of monthCells(this.calendarDate)) {
        const { date, inMonth, dayOfWeek } = cell;
        const tasks = calendarTasksForDate(board, date);
        const cls = [
          "lifeops-day-panel",
          "lifeops-month-cell",
          inMonth ? "" : "is-outside",
          dayOfWeek === 0 || dayOfWeek === 6 ? "is-weekend" : "",
          date === selectedDate ? "is-selected" : "",
          date === todayString() ? "is-today" : ""
        ].filter(Boolean).join(" ");
        const panel = calendar.createDiv({ cls });
        if (inMonth) {
          panel.onclick = async () => {
            this.selectedCalendarDate = date;
            await this.render();
          };
        }
        const title = panel.createDiv({ cls: "lifeops-day-title" });
        title.createSpan({ text: dayNumber(date), cls: "lifeops-month-day-number", attr: { title: date } });
        const right = title.createSpan({ cls: "lifeops-inline-actions" });
        if (inMonth) {
          if (tasks.length > 0) right.createSpan({ text: `${tasks.length}`, cls: "lifeops-day-count" });
          this.smallAddButton(right, "记", () => this.controller.openCalendarNoteModal(date));
          this.smallAddButton(right, "+", () => this.controller.openTaskModalWithDefaults({ date }));
        }
        if (!inMonth) {
          panel.createDiv({ text: "", cls: "lifeops-empty-day" });
        } else if (tasks.length === 0) {
          panel.createDiv({ text: "空", cls: "lifeops-muted lifeops-empty-day" });
        } else {
          for (const task of tasks.slice(0, 3)) {
            this.renderCalendarEvent(panel, task, date);
          }
          if (tasks.length > 3) {
            panel.createDiv({ text: `还有 ${tasks.length - 3} 项`, cls: "lifeops-more-events" });
          }
        }
      }
      this.renderCalendarDayDetail(shell, selectedDate, calendarTasksForDate(board, selectedDate));
    },

  renderWeekCalendar(this: ViewHost, container: HTMLElement, board: TaskDashboardData, selectedDate: string): void {
      const calendar = container.createDiv({ cls: "lifeops-calendar lifeops-calendar-week" });
      const weekStart = startOfDisplayedWeek(selectedDate);
      for (let index = 0; index < 7; index += 1) {
        const date = addDays(weekStart, index);
        const tasks = calendarTasksForDate(board, date);
        const panel = calendar.createDiv({ cls: [date === todayString() ? "lifeops-day-panel lifeops-week-panel is-today" : "lifeops-day-panel lifeops-week-panel", date === selectedDate ? "is-selected" : ""].filter(Boolean).join(" ") });
        panel.onclick = async () => {
          this.selectedCalendarDate = date;
          await this.render();
        };
        const title = panel.createDiv({ cls: "lifeops-day-title" });
        title.createSpan({ text: `${weekDayLabel(date)} ${compactDate(date)}`, attr: { title: date } });
        const titleRight = title.createSpan({ cls: "lifeops-inline-actions" });
        this.smallAddButton(titleRight, "备注", () => this.controller.openCalendarNoteModal(date));
        this.smallAddButton(titleRight, "添加", () => this.controller.openTaskModalWithDefaults({ date }));
        for (const task of tasks) {
          this.renderCalendarEvent(panel, task, date);
        }
        if (tasks.length === 0) panel.createDiv({ text: "暂无任务", cls: "lifeops-muted lifeops-empty-day" });
      }
    },

  renderDayCalendar(this: ViewHost, container: HTMLElement, board: TaskDashboardData, selectedDate: string): void {
      const selectedTasks = calendarTasksForDate(board, selectedDate);
      const day = container.createDiv({ cls: "lifeops-day-timeline" });
      const summary = day.createDiv({ cls: "lifeops-day-agenda-summary" });
      summary.createDiv({ text: `${selectedDate} · ${weekDayLabel(selectedDate)}`, cls: "lifeops-day-agenda-title" });
      const summaryActions = summary.createDiv({ cls: "lifeops-inline-actions" });
      summaryActions.createSpan({ text: `${selectedTasks.length} 项`, cls: "lifeops-day-count" });
      this.smallAddButton(summaryActions, "备注", () => this.controller.openCalendarNoteModal(selectedDate));
      this.smallAddButton(summaryActions, "添加任务", () => this.controller.openTaskModalWithDefaults({ date: selectedDate }));
      const planned = selectedTasks.filter(task => taskTimelineStart(task, selectedDate) !== undefined)
        .sort((a, b) => taskTimelineStart(a, selectedDate)! - taskTimelineStart(b, selectedDate)!);
      const plan = day.createDiv({ cls: "lifeops-time-arrangements" });
      plan.createEl("h4", { text: "时间安排" });
      const shortcuts = plan.createDiv({ cls: "lifeops-inline-actions" });
      for (const [startTime, endTime] of [["09:00", "12:00"], ["14:00", "16:00"], ["16:00", "18:00"]]) {
        this.smallAddButton(shortcuts, `安排 ${startTime}–${endTime}`, () => this.controller.openTaskModalWithDefaults({ date: selectedDate, startTime, endTime }));
      }
      if (!planned.length) plan.createDiv({ text: "还没有具体区间。可以点击上方时段，或下方小时添加；时间重叠时会并列保留，不自动改动任务。", cls: "lifeops-muted" });
      for (const task of planned) {
        const slot = plan.createDiv({ cls: "lifeops-time-slot" });
        slot.createSpan({ text: taskScheduleLabel(task), cls: "lifeops-time-slot-label" });
        const track = slot.createDiv({ cls: "lifeops-time-slot-track" });
        const interval = taskDayInterval(task, selectedDate);
        const start = taskTimelineStart(task, selectedDate)!;
        const bar = track.createEl("button", { text: task.title, cls: "lifeops-time-slot-bar", attr: { type: "button", "aria-label": `编辑 ${task.title}，${taskScheduleLabel(task)}` } });
        bar.style.marginLeft = `${start / 1440 * 100}%`;
        bar.style.width = `${interval ? (interval.end - start) / 1440 * 100 : 2}%`;
        bar.title = `${task.title} · ${taskScheduleLabel(task)}`;
        bar.onclick = () => this.controller.openTaskEditModal(task);
      }
      const boundaryTasks = selectedTasks.filter(task => taskTimeGroup(task, selectedDate) === "boundary");
      if (boundaryTasks.length) {
        const row = day.createDiv({ cls: "lifeops-hour-row" });
        row.createDiv({ text: "跨天结束 · 今日无占用", cls: "lifeops-hour-label" });
        const lane = row.createDiv({ cls: "lifeops-hour-lane" });
        for (const task of boundaryTasks) this.renderCalendarEvent(lane, task, selectedDate);
      }
      const unscheduled = selectedTasks.filter(task => taskTimelineStart(task, selectedDate) === undefined && taskTimeGroup(task, selectedDate) !== "boundary");
      if (unscheduled.length > 0) {
        const row = day.createDiv({ cls: "lifeops-hour-row lifeops-unscheduled-row" });
        row.createDiv({ text: "未排区间／仅目标", cls: "lifeops-hour-label" });
        const lane = row.createDiv({ cls: "lifeops-hour-lane" });
        for (const task of unscheduled) {
          this.renderCalendarEvent(lane, task, selectedDate);
        }
      }
      for (let hour = 0; hour <= 23; hour += 1) {
        const row = day.createDiv({ cls: "lifeops-hour-row" });
        row.createDiv({ text: `${String(hour).padStart(2, "0")}:00`, cls: "lifeops-hour-label" });
        const lane = row.createDiv({ cls: "lifeops-hour-lane" });
        const hourText = String(hour).padStart(2, "0");
        const tasks = planned.filter(task => Math.floor(taskTimelineStart(task, selectedDate)! / 60) === hour);
        this.smallAddButton(lane, "添加任务", () => this.controller.openTaskModalWithDefaults({ date: selectedDate, startTime: `${hourText}:00` }));
        for (const task of tasks) {
          this.renderCalendarEvent(lane, task, selectedDate);
        }
      }
    },

  renderCalendarDayDetail(this: ViewHost, container: HTMLElement, date: string, tasks: LifeOpsTask[]): void {
      const detail = container.createDiv({ cls: "lifeops-calendar-detail" });
      const header = detail.createDiv({ cls: "lifeops-calendar-detail-header" });
      const title = header.createDiv({ cls: "lifeops-calendar-detail-title" });
      title.createDiv({ text: dayNumber(date), cls: "lifeops-calendar-detail-number" });
      const copy = title.createDiv();
      copy.createDiv({ text: `${date} · ${weekDayLabel(date)}`, cls: "lifeops-calendar-detail-date" });
      copy.createDiv({ text: `${tasks.length} 个待办安排`, cls: "lifeops-calendar-detail-subtitle" });
      const actions = detail.createDiv({ cls: "lifeops-calendar-detail-actions" });
      this.smallAddButton(actions, "写备注", () => this.controller.openCalendarNoteModal(date));
      this.smallAddButton(actions, "添加任务", () => this.controller.openTaskModalWithDefaults({ date }));

      const summary = detail.createDiv({ cls: "lifeops-calendar-detail-stats" });
      summary.createDiv({ text: `高优先级 ${tasks.filter((task) => task.priority === "high").length}` });
      summary.createDiv({ text: `有时间 ${tasks.filter((task) => task.time).length}` });
      summary.createDiv({ text: `截止 ${tasks.filter((task) => task.dueDate === date).length}` });
      summary.createDiv({ text: `重复 ${tasks.filter((task) => task.repeatUnit !== "none").length}` });
      summary.createDiv({ text: `完成 ${tasks.filter((task) => task.status === "completed").length}` });

      const list = detail.createDiv({ cls: "lifeops-calendar-detail-list" });
      if (tasks.length === 0) {
        list.createDiv({ text: "这一天暂时没有任务。可以先留空，也可以直接添加一个安排。", cls: "lifeops-calendar-detail-empty" });
        return;
      }
      for (const task of tasks) {
        const row = list.createDiv({ cls: calendarDetailTaskClass(task, date) });
        row.createDiv({ text: calendarTaskTimeLabel(task, date), cls: "lifeops-calendar-detail-time" });
        const body = row.createDiv({ cls: "lifeops-calendar-detail-task-body" });
        body.createDiv({ text: task.title, cls: "lifeops-calendar-detail-task-title" });
        body.createDiv({ text: calendarEventMeta(task, date), cls: "lifeops-calendar-detail-task-meta" });
        const rowActions = row.createDiv({ cls: "lifeops-calendar-task-actions" });
        this.calendarTaskButton(rowActions, "详情", () => this.controller.openTaskActionsModal(task));
        if (task.status === "active") {
          this.calendarTaskButton(rowActions, "完成", () => this.run("任务已完成", () => this.controller.completeTask(task.id)));
          this.calendarTaskButton(rowActions, "明天", () => this.run("任务已延后", () => this.controller.postponeTask(task.id, 1)));
          if (task.repeatUnit !== "none") {
            this.calendarTaskButton(rowActions, "跳过", () => this.run("已跳过本次", () => this.controller.skipRepeatedTask(task.id)));
          }
        }
      }
    },

  renderCalendarEvent(this: ViewHost, container: HTMLElement, task: LifeOpsTask, date: string, prefix = ""): void {
      const event = container.createDiv({ cls: calendarEventClass(task, date) });
      event.createDiv({ text: prefix ? `${prefix} ${task.title}` : task.title, cls: "lifeops-calendar-event-title" });
      event.createDiv({ text: calendarEventMeta(task, date), cls: "lifeops-calendar-event-meta" });
      event.onclick = (mouseEvent) => {
        mouseEvent.stopPropagation();
        this.controller.openTaskActionsModal(task);
      };
    },

  calendarTaskButton(this: ViewHost, container: HTMLElement, label: string, action: () => Promise<void> | void): void {
      container.createEl("button", { text: label }, (button) => {
        button.onclick = (event) => {
          event.stopPropagation();
          void action();
        };
      });
    },

  moveCalendar(this: ViewHost, direction: -1 | 1): void {
      if (this.calendarMode === "month") {
        this.calendarDate = addMonths(this.calendarDate, direction);
        this.selectedCalendarDate = this.calendarDate;
        return;
      }
      const days = this.calendarMode === "week" ? direction * 7 : direction;
      this.selectedCalendarDate = addDays(this.selectedCalendarDate, days);
      this.calendarDate = this.selectedCalendarDate;
    },

  renderTaskList(this: ViewHost, container: HTMLElement, tasks: LifeOpsTask[], emptyText: string, compact = false): void {
      const list = container.createDiv({ cls: compact ? "lifeops-task-list compact" : "lifeops-task-list" });
      if (tasks.length === 0) {
        list.createDiv({ text: emptyText, cls: "lifeops-muted lifeops-empty-list" });
        return;
      }

      for (const task of tasks) {
        this.renderTaskCard(list, task, compact);
      }
    },

  renderTodayTaskGroups(this: ViewHost, container: HTMLElement, tasks: LifeOpsTask[], board: TaskDashboardData): void {
      const groups: Array<[string, TaskTimeGroup, Partial<LifeOpsTaskInput>]> = [
        ["上午", "morning", { date: board.date, startTime: "09:00" }],
        ["下午", "afternoon", { date: board.date, startTime: "14:00" }],
        ["晚上", "evening", { date: board.date, startTime: "20:00" }],
        ["跨时段", "spanning", { date: board.date }],
        ["跨天结束（今日无占用）", "boundary", { date: board.date }],
        ["未排区间／仅完成目标", "unscheduled", { date: board.date }]
      ];

      const shell = container.createDiv({ cls: "lifeops-today-groups" });
      for (const [label, group, defaults] of groups) {
        const groupTasks = tasks.filter(task => taskTimeGroup(task, board.date) === group);
        const section = shell.createDiv({ cls: `lifeops-task-group time-${group}` });
        const title = section.createDiv({ cls: "lifeops-task-group-title" });
        title.createSpan({ text: label });
        const right = title.createSpan({ cls: "lifeops-inline-actions" });
        right.createSpan({ text: `${groupTasks.length} 项`, cls: "lifeops-filter-count" });
        this.smallAddButton(right, "添加", () => this.controller.openTaskModalWithDefaults(defaults));
        this.renderTaskList(section, groupTasks, "暂无任务。");
      }
    },

  renderGroupedTaskView(this: ViewHost,
      container: HTMLElement,
      groups: Array<[string, LifeOpsTask[]]>,
      defaultsForGroup: (key: string) => Partial<LifeOpsTaskInput>,
      emptyText: string
    ): void {
      if (groups.length === 0) {
        container.createDiv({ text: emptyText, cls: "lifeops-muted" });
        return;
      }

      const shell = container.createDiv({ cls: "lifeops-today-groups lifeops-grouped-view" });
      for (const [label, tasks] of groups) {
        const section = shell.createDiv({ cls: "lifeops-task-group" });
        const title = section.createDiv({ cls: "lifeops-task-group-title" });
        title.createSpan({ text: label, cls: "lifeops-task-group-label" });
        const right = title.createSpan({ cls: "lifeops-inline-actions" });
        right.createSpan({ text: `${tasks.length} 项`, cls: "lifeops-filter-count" });
        this.smallAddButton(right, "添加", () => this.controller.openTaskModalWithDefaults(defaultsForGroup(label)));
        this.renderTaskList(section, tasks, "暂无任务。");
      }
    },

  renderTaskCard(this: ViewHost, container: HTMLElement, task: LifeOpsTask, compact: boolean): void {
      const card = container.createDiv({
        cls: [
          "lifeops-task-card",
          `priority-${task.priority}`,
          `status-${task.status}`,
          compact ? "is-compact" : "",
          task.status === "active" && isTaskOverdue(task) ? "is-overdue" : ""
        ].filter(Boolean).join(" ")
      });
      const check = card.createEl("input", { cls: "lifeops-task-checkbox", attr: { type: "checkbox" } });
      check.checked = task.status === "completed";
      check.onchange = () => {
        if (check.checked) {
          void this.run("任务已完成", () => this.controller.completeTask(task.id));
        }
      };
      const body = card.createDiv({ cls: "lifeops-task-body" });
      const title = body.createDiv({ cls: "lifeops-task-title-row" });
      title.createDiv({ text: task.title, cls: "lifeops-task-title" });
      title.createDiv({ text: priorityLabel(task.priority), cls: `lifeops-priority-badge priority-${task.priority}` });
      const meta = body.createDiv({ cls: "lifeops-task-meta" });
      chip(meta, "calendar", task.date ? (task.endDate ? `${task.date} -> ${task.endDate}` : task.date) : "无日期");
      if (taskScheduleLabel(task)) chip(meta, "clock", taskScheduleLabel(task));
      if (task.dueDate) chip(meta, "alarm-clock", task.dueTime ? `截止 ${task.dueDate} ${task.dueTime}` : `截止 ${task.dueDate}`);
      if (task.repeatUnit !== "none") chip(meta, "repeat-2", repeatLabel(task));
      chip(meta, "folder", task.project);
      chip(meta, "tag", task.category);
      if (task.note && !compact) {
        body.createDiv({ text: task.note, cls: "lifeops-task-note" });
      }

      const actions = card.createDiv({ cls: "lifeops-card-actions" });
      if (task.status === "active") {
        this.actionButton(actions, "完成", () => this.controller.completeTask(task.id));
        this.plainButton(actions, "编辑", () => this.controller.openTaskEditModal(task));
        this.plainButton(actions, "更多", () => this.controller.openTaskActionsModal(task));
        if (!compact) {
          this.quadrantButtons(actions, task);
        }
      }
    },

  quadrantButtons(this: ViewHost, container: HTMLElement, task: LifeOpsTask): void {
      const row = container.createDiv({ cls: "lifeops-quadrant-buttons" });
      const items: Array<[LifeOpsTaskQuadrant, string]> = [
        ["important-urgent", "重急"],
        ["important-not-urgent", "重不急"],
        ["not-important-urgent", "不重急"],
        ["not-important-not-urgent", "不重不急"]
      ];
      for (const [quadrant, label] of items) {
        row.createEl("button", { text: label, cls: quadrant === task.quadrant ? "is-active" : "" }, (button) => {
          button.onclick = () => this.run("任务象限已更新", () => this.controller.moveTaskToQuadrant(task.id, quadrant));
        });
      }
    },

  tasksForFilter(this: ViewHost, board: TaskDashboardData): LifeOpsTask[] {
      switch (this.taskFilter) {
        case "today":
          return board.today;
        case "overdue":
          return board.overdue;
        case "deadline":
          return board.allActive.filter((task) => task.dueDate);
        case "recurring":
          return board.allActive.filter((task) => task.repeatUnit !== "none");
        case "tomorrow":
          return board.tomorrow;
        case "next-seven":
          return board.nextSevenDays;
        case "no-date":
          return board.noDate;
        case "completed":
          return board.completedToday;
        case "completed-all":
          return board.tasks.filter((task) => task.status === "completed");
        case "all":
          return board.allActive;
        case "by-project":
        case "by-category":
        case "by-date":
          return board.allActive;
      }
      return [];
    },

  filteredTasks(this: ViewHost, tasks: LifeOpsTask[]): LifeOpsTask[] {
      const query = this.taskSearch.trim().toLowerCase();
      if (!query) return tasks;
      return tasks.filter((task) =>
        [task.title, task.project, task.category, task.note, task.date, task.time]
          .join(" ")
          .toLowerCase()
          .includes(query)
      );
    },

  actionButton(this: ViewHost, container: HTMLElement, label: string, action: () => Promise<void>, tone = ""): void {
      container.createEl("button", { text: label, cls: tone ? `lifeops-action-${tone}` : "" }, (button) => {
        button.onclick = () => this.run(`${label}成功`, action);
      });
    },

  smallAddButton(this: ViewHost, container: HTMLElement, label: string, action: () => void): void {
      container.createEl("button", { text: label, cls: "lifeops-small-add" }, (button) => {
        button.onclick = (event) => {
          event.stopPropagation();
          action();
        };
      });
    },

  plainButton(this: ViewHost, container: HTMLElement, label: string, action: () => void): void {
      container.createEl("button", { text: label }, (button) => {
        button.onclick = action;
      });
    },

  deleteButton(this: ViewHost, container: HTMLElement, task: LifeOpsTask): void {
      container.createEl("button", { text: "删除", cls: "lifeops-action-danger" }, (button) => {
        button.onclick = () => {
          if (!window.confirm(`删除任务：${task.title}？`)) return;
          void this.run("删除成功", () => this.controller.deleteTask(task.id));
        };
      });
    },

  habitDeleteButton(this: ViewHost, container: HTMLElement, habit: HabitDefinition): void {
      container.createEl("button", { text: "删除", cls: "lifeops-action-danger" }, (button) => {
        button.onclick = () => {
          if (!window.confirm(`删除习惯及打卡记录：${habit.name}？`)) return;
          void this.run("删除成功", () => this.controller.deleteHabit(habit.id));
        };
      });
    },

  toggleButton(this: ViewHost, container: HTMLElement, label: string, action: () => Promise<void>): void {
      container.createEl("button", { text: label }, (button) => {
        button.onclick = () => {
          void action();
        };
      });
    },

  renderHabitHeatmap(this: ViewHost, container: HTMLElement, item: TaskDashboardData["habits"][number]): void {
      if (item.periodUnavailable) return;
      const history = new Map(item.history.map((checkin) => [checkin.date, checkin]));
      const heatmap = container.createDiv({ cls: "lifeops-heatmap" });
      const start = addDays(todayString(), -83);
      for (let index = 0; index < 84; index += 1) {
        const date = addDays(start, index);
        const checkin = history.get(date);
        const trade = tradeHabitDayDisplay(item.habit, checkin);
        const cell = heatmap.createDiv({
          cls: `lifeops-heat-cell ${checkin ? `status-${trade?.status ?? checkin.status}` : ""}`,
          attr: { title: `${date} ${trade?.label ?? (checkin ? habitStatusLabel(checkin.status) : "未打卡")}` }
        });
        cell.style.setProperty("--habit-color", item.habit.color);
      }
    },

  renderHabitDetail(this: ViewHost, container: HTMLElement, item: TaskDashboardData["habits"][number]): void {
      const detail = container.createDiv({ cls: "lifeops-habit-detail" });
      if (item.periodUnavailable) {
        detail.createDiv({ text: "交易记录暂不可用，进度未知。", cls: "lifeops-muted" });
        return;
      }
      const done = item.history.filter((checkin) => checkin.status === "done");
      const missed = item.history.filter((checkin) => checkin.status === "missed");
      const leave = item.history.filter((checkin) => checkin.status === "leave");
      const sevenDays = habitWindowStats(item, 7);
      const thirtyDays = habitWindowStats(item, 30);
      const stats = detail.createDiv({ cls: "lifeops-habit-detail-stats" });
      stats.createDiv({ text: `完成 ${done.reduce((sum, checkin) => sum + Math.max(1, checkin.count || 1), 0)} ${item.habit.source === "trades" ? "笔" : "次"}` });
      stats.createDiv({ text: `未完成 ${missed.length} 次` });
      stats.createDiv({ text: `请假 ${leave.length} 次` });
      stats.createDiv({ text: `${item.periodLabel} ${item.periodDone}/${item.periodTarget} ${item.periodUnit ?? "次"}` });
      stats.createDiv({ text: `7天 ${sevenDays.done}/${sevenDays.required}` });
      stats.createDiv({ text: `30天 ${thirtyDays.done}/${thirtyDays.required}` });
      stats.createDiv({ text: `完成率 ${thirtyDays.rate}%` });
      if (item.habit.target?.kind === "number") {
        detail.createDiv({ text: "数值习惯按已达标的日或周统计。", cls: "lifeops-muted" });
      } else if (item.habit.frequencyUnit === "week") {
        detail.createDiv({ text: "周习惯的 7 / 30 天统计按覆盖的完整自然周计算。", cls: "lifeops-muted" });
      } else if (item.habit.targetCount > 1) {
        detail.createDiv({ text: "完成率按有完成记录的日期统计；每天是否达到次数目标，请看当期进度。", cls: "lifeops-muted" });
      }

      detail.createDiv({ text: `本周未达标 ${item.weeklyFailures} 次。`, cls: "lifeops-muted" });

      const trend = detail.createDiv({ cls: "lifeops-habit-trend" });
      for (const date of lastDates(14)) {
        const checkin = item.history.find((entry) => entry.date === date);
        const required = isHabitRequiredOnDate(item.habit, date);
        const trade = tradeHabitDayDisplay(item.habit, checkin);
        trend.createDiv({
          text: dayNumber(date),
          cls: [
            "lifeops-habit-trend-cell",
            checkin ? `status-${trade?.status ?? checkin.status}` : "",
            required ? "is-required" : "is-optional"
          ].filter(Boolean).join(" "),
          attr: { title: `${date} ${trade?.label ?? (checkin ? habitStatusLabel(checkin.status) : required ? "未打卡" : "非必需")}` }
        });
      }

      const dates = detail.createDiv({ cls: "lifeops-habit-date-list" });
      const failures = missed.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
      if (failures.length > 0) {
        dates.createDiv({ text: "最近失败", cls: "lifeops-habit-date-title" });
        for (const checkin of failures) {
          dates.createSpan({
            text: `${checkin.date} 未完成`,
            cls: "lifeops-habit-date-pill status-missed"
          });
        }
      }
      const recent = item.history.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 18);
      if (recent.length === 0) {
        dates.createDiv({ text: "还没有打卡日期。", cls: "lifeops-muted" });
        return;
      }
      dates.createDiv({ text: "最近记录", cls: "lifeops-habit-date-title" });
      for (const checkin of recent) {
        dates.createSpan({
          text: `${checkin.date} ${habitStatusLabel(checkin.status)}${checkin.count > 1 ? ` x${checkin.count}` : ""}`,
          cls: `lifeops-habit-date-pill status-${checkin.status}`
        });
      }
    },

  defaultsForFilter(this: ViewHost, board: TaskDashboardData): Partial<LifeOpsTaskInput> {
      switch (this.taskFilter) {
        case "today":
          return { date: board.date };
        case "tomorrow":
          return { date: addDays(board.date, 1) };
        case "next-seven":
          return { date: addDays(board.date, 7) };
        case "deadline":
          return { date: board.date, dueDate: board.date };
        case "recurring":
          return { date: board.date, repeatUnit: "day", repeatInterval: 1 };
        case "no-date":
          return { date: "" };
        default:
          return { date: board.date };
      }
    },

  toolButton(this: ViewHost,
      container: HTMLElement,
      icon: string,
      label: string,
      action: () => Promise<void> | void,
      primary = false
    ): void {
      container.createEl("button", { cls: primary ? "lifeops-tool-button is-primary" : "lifeops-tool-button" }, (button) => {
        setIcon(button.createSpan({ cls: "lifeops-button-icon" }), icon);
        button.createSpan({ text: label });
        button.onclick = () => {
          const result = action();
          if (result instanceof Promise) {
            void this.run(`${label}成功`, () => result);
          }
        };
      });
    },

  renderAgentBar(this: ViewHost, container: HTMLElement, stats: DashboardStats, board: TaskDashboardData): void {
      const dock = container.createDiv({ cls: this.agentSurfaceClass("lifeops-agent-dock") });
      this.agentSurfaceEl = dock;
      const visualWrap = dock.createDiv({ cls: "lifeops-agent-visual" });
      this.agentVisualWrapEl = visualWrap;
      const canvas = visualWrap.createEl("canvas", { cls: "lifeops-agent-canvas" });
      this.agentVisual = new LifeOpsAgentVisual(canvas, this.agentVisualActivity());
      this.agentVisual.start();
      this.renderAgentWave(visualWrap);

      const signal = visualWrap.createDiv({ cls: "lifeops-agent-signal" });
      this.agentStatusEl = signal.createDiv({ text: this.agentStatusLabel(), cls: "lifeops-agent-kicker" });
      this.agentTraceEl = signal.createDiv({
        text: this.agentVoiceTraceLabel || `${board.today.length} 今日待办 · ${stats.habitDone}/${stats.habitTotal} 打卡`,
        cls: "lifeops-agent-context"
      });

      const panel = dock.createDiv({ cls: "lifeops-agent-panel" });
      const head = panel.createDiv({ cls: "lifeops-agent-head" });
      const title = head.createDiv();
      title.createDiv({ text: "AI 管家", cls: "lifeops-agent-title" });
      this.agentReplyEl = title.createDiv({ text: this.agentReply, cls: "lifeops-agent-reply" });

      const modeSwitch = head.createDiv({ cls: "lifeops-agent-switch" });
      this.agentUtilityButton(modeSwitch, "panel-right-open", "展开", async () => {
        this.agentWorkspaceOpen = true;
        await this.render();
      });
      this.agentModeButton(modeSwitch, "mic", "语音", "voice");
      this.agentModeButton(modeSwitch, "keyboard", "文字", "text");

      const composerWrap = panel.createDiv({ cls: "lifeops-agent-composer-wrap" });
      this.renderAgentComposer(composerWrap);

      this.renderAgentSuggestions(panel);
    },

  renderAgentWorkspace(this: ViewHost, container: HTMLElement, stats: DashboardStats, board: TaskDashboardData): void {
      const workspace = container.createDiv({ cls: this.agentSurfaceClass("lifeops-agent-workspace") });
      this.agentSurfaceEl = workspace;
      const head = workspace.createDiv({ cls: "lifeops-agent-workspace-head" });
      const title = head.createDiv({ cls: "lifeops-agent-workspace-title" });
      title.createDiv({ text: "AI 管家", cls: "lifeops-agent-title" });
      title.createDiv({
        text: `${board.today.length} 今日待办 · ${stats.habitDone}/${stats.habitTotal} 打卡 · ${stats.tradeEntries} 交易记录`,
        cls: "lifeops-agent-workspace-subtitle"
      });
      const progress = title.createDiv({
        cls: "lifeops-agent-workspace-progress",
        attr: {
          role: "status",
          "aria-live": "polite"
        }
      });
      progress.createSpan({ cls: "lifeops-agent-workspace-progress-dot", attr: { "aria-hidden": "true" } });
      progress.createSpan({ text: "LifeOps 正在思考" });
      const progressDots = progress.createSpan({
        cls: "lifeops-agent-thinking-dots",
        attr: { "aria-hidden": "true" }
      });
      progressDots.createSpan();
      progressDots.createSpan();
      progressDots.createSpan();
      const visualWrap = workspace.createDiv({ cls: "lifeops-agent-workspace-visual" });
      this.agentVisualWrapEl = visualWrap;
      const controls = visualWrap.createDiv({ cls: "lifeops-agent-switch lifeops-agent-switch-rail" });
      this.agentUtilityButton(controls, "panel-right-close", "收起", async () => {
        this.agentWorkspaceOpen = false;
        await this.render();
      });
      this.agentModeButton(controls, "mic", "语音", "voice");
      this.agentModeButton(controls, "keyboard", "文字", "text");

      const canvas = visualWrap.createEl("canvas", { cls: "lifeops-agent-canvas" });
      this.agentVisual = new LifeOpsAgentVisual(canvas, this.agentVisualActivity());
      this.agentVisual.start();
      this.renderAgentWave(visualWrap);
      const signal = visualWrap.createDiv({ cls: "lifeops-agent-signal" });
      const signalMain = signal.createDiv({ cls: "lifeops-agent-signal-main" });
      this.agentStatusEl = signalMain.createDiv({ text: this.agentStatusLabel(), cls: "lifeops-agent-kicker" });
      const signalMeta = signal.createDiv({ cls: "lifeops-agent-context-stack" });
      this.agentTraceEl = signalMeta.createDiv({ text: this.agentVoiceTraceLabel || (this.agentVoiceConversation ? "语音对话模式" : "听写输入模式"), cls: "lifeops-agent-context" });

      const transcript = workspace.createDiv({ cls: "lifeops-agent-transcript" });
      this.agentTranscriptEl = transcript;
      if (this.agentMessages.length === 0) {
        this.renderAgentMessage(transcript, { role: "assistant", content: this.agentReply });
      } else {
        for (const message of this.agentMessages.slice(-8)) {
          this.renderAgentMessage(transcript, message);
        }
      }
      this.scrollAgentTranscriptToBottom();

      this.renderAgentSuggestions(workspace);

      const composerWrap = workspace.createDiv({ cls: "lifeops-agent-workspace-composer" });
      this.renderAgentComposer(composerWrap);
    },

  agentModeButton(this: ViewHost, container: HTMLElement, icon: string, label: string, mode: "voice" | "text"): void {
      container.createEl("button", { cls: this.agentMode === mode ? "is-active" : "", attr: { "data-agent-mode": mode } }, (button) => {
        button.title = label;
        button.setAttr("aria-label", label);
        this.agentModeButtons.push(button);
        setIcon(button.createSpan({ cls: "lifeops-button-icon" }), icon);
        button.createSpan({ text: label });
        button.onclick = async () => {
          if (this.agentMode === mode && (mode !== "voice" || this.agentRecording
            || this.agentBusy || this.agentVoiceConversation)) return;
          this.agentMode = mode;
          this.refreshAgentModeUi();
          if (mode === "voice") {
            this.agentVoiceConversation = true;
            void this.ensureVoiceStandby();
            return;
          }
          this.stopVoiceStandby();
        };
      });
    },

  agentUtilityButton(this: ViewHost, container: HTMLElement, icon: string, label: string, action: () => Promise<void>): void {
      container.createEl("button", {}, (button) => {
        button.title = label;
        button.setAttr("aria-label", label);
        setIcon(button.createSpan({ cls: "lifeops-button-icon" }), icon);
        button.createSpan({ text: label });
        button.onclick = () => {
          void action();
        };
      });
    },

  agentReplyModeButton(this: ViewHost, container: HTMLElement): void {
      const speakReplies = this.controller.settings.realtimeVoice.speakReplies;
      container.createEl("button", { cls: speakReplies ? "lifeops-agent-record is-active" : "lifeops-agent-record" }, (button) => {
        setIcon(button.createSpan({ cls: "lifeops-button-icon" }), speakReplies ? "volume-2" : "captions");
        button.createSpan({ text: speakReplies ? "语音回复" : "文字回复" });
        button.onclick = async () => {
          const next = !this.controller.settings.realtimeVoice.speakReplies;
          await this.controller.setAgentSpeakReplies(next);
          if (!next) this.interruptAgentSpeech();
          this.agentReply = next ? "语音回复已开启。" : "已切到文字回复，AI 不会朗读。";
          await this.render();
          if (this.agentMode === "voice") void this.ensureVoiceStandby();
        };
      });
    },

  renderAgentWave(this: ViewHost, container: HTMLElement): void {
      const wave = container.createDiv({ cls: "lifeops-agent-wave", attr: { "aria-hidden": "true" } });
      for (let index = 0; index < 17; index += 1) {
        wave.createSpan({ attr: { style: `--i:${index}` } });
      }
    },

  agentVisualActivity(this: ViewHost): AgentVisualActivity {
      const runtime = voiceRuntimePresentation(this);
      if (runtime.activity) return runtime.activity;
      if (this.agentSpeaking) return "speaking";
      if (this.agentBusy) return "thinking";
      if (this.agentRecording) return "listening";
      return "idle";
    },

  agentSurfaceClass(this: ViewHost, base: string): string {
      return [
        base,
        this.agentBusy ? "is-thinking" : "",
        this.agentRecording ? "is-listening" : "",
        this.agentSpeaking ? "is-speaking" : ""
      ].filter(Boolean).join(" ");
    },

  refreshAgentSurfaceState(this: ViewHost): void {
      if (this.agentSurfaceEl) {
        this.agentSurfaceEl.toggleClass("is-thinking", this.agentBusy);
        this.agentSurfaceEl.toggleClass("is-listening", this.agentRecording);
        this.agentSurfaceEl.toggleClass("is-speaking", this.agentSpeaking);
      }
      if (this.agentStatusEl) {
        this.agentStatusEl.textContent = this.agentStatusLabel();
      }
      if (this.agentTraceEl) {
        this.agentTraceEl.textContent = agentTraceLabel(this);
      }
      if (this.agentReplyEl) {
        this.agentReplyEl.textContent = this.agentReply;
      }
      this.refreshStewardStatus?.();
    },

  agentStatusLabel(this: ViewHost): string {
      const runtime = voiceRuntimePresentation(this);
      if (runtime.status) return runtime.status;
      if (this.agentMode === "voice" && this.agentRecording && !this.agentVoiceReady) return "语音连接预热中";
      if (this.agentMode === "voice" && this.agentRecording) {
        return `语音常驻监听中 · ${this.controller.settings.realtimeVoice.speakReplies ? "语音回复" : "文字回复"}`;
      }
      if (this.agentMode === "voice") return "语音待机";
      if (this.agentSpeaking) return "正在播放回复";
      if (this.agentBusy) return "正在思考";
      return "LifeOps Agent";
    },

  async run(this: ViewHost, success: string, action: () => Promise<void>): Promise<void> {
      try {
        await action();
        await this.controller.refreshViews();
        new Notice(success);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "LifeOps 操作失败");
      }
    },
};

export function applyStatusBarPanel(View: ViewConstructor): void {
  Object.assign(View.prototype, statusBarPanel);
}

type AgentVisualActivity = "idle" | "listening" | "thinking" | "speaking";

class LifeOpsAgentVisual {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private points: THREE.Points | null = null;
  private frame = 0;
  private animation = 0;
  private readonly onResize = () => this.resize();

  constructor(private readonly canvas: HTMLCanvasElement, private readonly activity: AgentVisualActivity) {}

  start(): void {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
    this.camera.position.set(0, 0, 7.2);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const geometry = new THREE.BufferGeometry();
    const count = 720;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      const t = index / count;
      const ring = Math.floor(index / 90);
      const angle = t * Math.PI * 12;
      const radius = 1.05 + ring * 0.14 + Math.sin(angle * 0.7) * 0.22;
      positions[index * 3] = Math.cos(angle) * radius;
      positions[index * 3 + 1] = Math.sin(angle) * radius * 0.54;
      positions[index * 3 + 2] = (t - 0.5) * 4.6;
      colors[index * 3] = this.activity === "speaking" ? 0.42 + t * 0.32 : 0.18 + t * 0.34;
      colors[index * 3 + 1] = this.activity === "listening" ? 0.78 - t * 0.18 : 0.72 - t * 0.2;
      colors[index * 3 + 2] = this.activity === "thinking" ? 0.9 : 0.96;
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      size: this.activity === "idle" ? 0.04 : 0.052,
      vertexColors: true,
      transparent: true,
      opacity: this.activity === "idle" ? 0.72 : 0.92,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.points = new THREE.Points(geometry, material);
    this.scene.add(this.points);
    window.addEventListener("resize", this.onResize);
    this.resize();
    this.animate();
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    window.cancelAnimationFrame(this.animation);
    this.points?.geometry.dispose();
    (this.points?.material as THREE.Material | undefined)?.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.points = null;
  }
  private resize(): void {
    if (!this.renderer || !this.camera) return;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
  private animate(): void {
    if (!this.renderer || !this.scene || !this.camera || !this.points) return;
    const tempo = this.activity === "listening" ? 0.024 : this.activity === "speaking" ? 0.02 : this.activity === "thinking" ? 0.016 : 0.01;
    const amplitude = this.activity === "listening" ? 0.12 : this.activity === "speaking" ? 0.09 : this.activity === "thinking" ? 0.065 : 0.035;
    this.frame += tempo;
    const breath = 1 + Math.sin(this.frame * 3.2) * amplitude;
    this.points.rotation.x = Math.sin(this.frame * 0.8) * (this.activity === "idle" ? 0.12 : 0.22);
    this.points.rotation.y += this.activity === "idle" ? 0.004 : 0.009;
    this.points.scale.setScalar(breath);
    const positions = this.points.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let index = 0; index < positions.count; index += 9) {
      const z = positions.getZ(index);
      positions.setZ(index, z + Math.sin(this.frame * 9 + index * 0.025) * (this.activity === "idle" ? 0.002 : 0.006));
    }
    positions.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
    this.animation = window.requestAnimationFrame(() => this.animate());
  }
}

function agentTraceLabel(view: ViewHost): string {
  const runtime = voiceRuntimePresentation(view);
  if (runtime.trace) return runtime.trace;
  if (view.agentMode === "voice" || view.agentRecording || view.agentBusy || view.agentSpeaking) {
    return view.agentVoiceTraceLabel || (view.agentVoiceConversation ? "语音对话模式" : "听写输入模式");
  }
  return "听写输入模式";
}

function voiceRuntimePresentation(view: ViewHost): {
  status?: string;
  trace?: string;
  activity?: AgentVisualActivity;
} {
  if (view.agentMode !== "voice" || !view.agentVoiceRuntime?.snapshot) return {};
  const snapshot = view.agentVoiceRuntime.snapshot();
  const turn = snapshot.currentTurn;
  if (snapshot.sessionPhase === "recovering" || view.agentVoiceReconnectAttempts > 0) {
    const attempt = Number(view.agentVoiceReconnectAttempts || 0);
    return {
      status: attempt > 0 ? `语音连接恢复中 · 第 ${attempt} 次` : "语音连接恢复中",
      trace: "连接已中断，LifeOps 正在自动恢复",
      activity: "thinking"
    };
  }
  if (snapshot.sessionPhase === "connecting") {
    return {
      status: "语音连接中",
      trace: "正在建立实时语音会话",
      activity: "thinking"
    };
  }
  if (turn && !["completed", "interrupted", "failed"].includes(turn.phase)) {
    if (turn.phase === "playing" || view.agentSpeaking) {
      const output = turn.outputOwner === "native-e2e"
        ? "原生语音"
        : turn.outputOwner === "fallback-tts"
          ? "备用语音"
          : turn.outputOwner === "system"
            ? "系统朗读"
            : "语音";
      return {
        status: `正在播放回复 · ${output}`,
        trace: `${turn.route.toUpperCase()} 路由 · ${output}通道`,
        activity: "speaking"
      };
    }
    if (turn.phase === "synthesizing") {
      return {
        status: "正在生成语音",
        trace: `${turn.route.toUpperCase()} 路由 · 等待音频`,
        activity: "thinking"
      };
    }
    if (turn.phase === "capturing" || turn.phase === "endpointing") {
      return {
        status: "正在确认本轮语音",
        trace: "正在等待稳定转写",
        activity: "listening"
      };
    }
    return {
      status: turn.route === "brain" ? "LifeOps 正在分析" : turn.route === "action" ? "LifeOps 正在执行" : "实时模型正在回复",
      trace: `${turn.route.toUpperCase()} 路由 · ${turn.phase}`,
      activity: "thinking"
    };
  }
  if (snapshot.sessionPhase === "listening" && view.agentRecording) {
    return {
      status: `语音常驻监听中 · ${view.controller.settings.realtimeVoice.speakReplies ? "语音回复" : "文字回复"}`,
      activity: "listening"
    };
  }
  return {};
}

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
    taskScheduleLabel(task),
    task.status === "completed" ? "已完成" : task.dueDate === date ? "截止" : priorityLabel(task.priority),
    task.repeatUnit !== "none" ? "重复" : "",
    task.project,
    task.category
  ].filter(Boolean);
  return parts.join(" · ");
}

function calendarTaskTimeLabel(task: LifeOpsTask, date: string): string {
  if (task.status === "completed") return "完成";
  if (task.dueDate === date && !isTaskOnDateLocal(task, date)) return task.dueTime || "截止";
  if (taskTimeGroup(task, date) === "boundary") return "今日00:00结束 · 今日无占用";
  if (taskScheduleLabel(task)) return taskScheduleLabel(task);
  if (task.dueDate === date && task.dueTime) return task.dueTime;
  return "未排具体时段";
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
  if (item.periodLabel === "本周") {
    return item.periodDone >= item.periodTarget ? "本周已达标" : "本周待完成";
  }
  return item.requiredToday ? "今日应打卡" : "今日非必需";
}

function habitWindowStats(item: TaskDashboardData["habits"][number], days: number): { required: number; done: number; rate: number } {
  const dates = lastDates(days);
  if (item.habit.target?.kind === "number") {
    return numericHabitWindow(item.habit, item.history, dates.filter(date => isHabitRequiredOnDate(item.habit, date)), dates);
  }
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
