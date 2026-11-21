import type { ProactiveRuntimeSettings } from "./proactivePolicy";
import type { ProjectCommand } from "./projectContinuity";
import type { TradingCommand } from "./tradingResearch";

export type CaptureKind =
  | "todo"
  | "done"
  | "diary"
  | "idea"
  | "habit"
  | "trade"
  | "health"
  | "memo";

export type HabitTarget = { kind: "boolean" } | { kind: "number"; unit: string; perDay?: number; perWeek?: number };
export type ExerciseCompensationUnit = "公里" | "分钟";
export interface HabitCompensationSettings {
  exerciseLimitMultiplier?: number;
  exerciseOverflowCny?: Partial<Record<ExerciseCompensationUnit, number>>;
}
export type PunishmentRule =
  | { kind: "save_money"; amount: number; currency: "CNY" | "USD" | "SGD"; dailyIncrease?: number }
  | { kind: "reflection"; minChars: number; dailyIncrease?: number }
  | { kind: "extra_exercise"; activity: "跑步" | "快走" | "跳绳"; amount: number; unit: ExerciseCompensationUnit;
      dailyLimit?: number; overflowCnyPerUnit?: number };
export interface HabitPunishment { enabled: boolean; rules: PunishmentRule[] }
export interface HabitPunishmentTask {
  habitId: string;
  period: "day" | "week";
  judgedDate: string;
  level: number;
  missedDates: string[];
  openEarlier: number;
  evidence: string;
  rule?: PunishmentRule;
  debt?: {
    base: PunishmentRule;
    appliedOn: string;
    policyVersion?: 2;
    overflowUnits?: number;
    overflowCny?: number;
  };
}

export interface HabitDefinition {
  id: string;
  name: string;
  frequencyUnit: "day" | "week";
  frequencyInterval: number;
  targetCount: number;
  target?: HabitTarget;
  punishment?: HabitPunishment;
  startDate: string;
  penaltyThreshold: number;
  color: string;
  createdAt: string;
  source?: string;
}

export type LifeOpsTaskStatus = "active" | "completed" | "abandoned";
export type LifeOpsTaskPriority = "high" | "medium" | "low" | "none";
export type LifeOpsTaskRepeatUnit = "none" | "day" | "week" | "month";
export type LifeOpsTaskQuadrant =
  | "important-urgent"
  | "important-not-urgent"
  | "not-important-urgent"
  | "not-important-not-urgent";

export type HabitCheckinStatus = "done" | "missed" | "leave";

export interface LifeOpsTaskCompletionEvent {
  completedAt: string;
  note: string;
}

export interface LifeOpsTask {
  id: string;
  title: string;
  status: LifeOpsTaskStatus;
  priority: LifeOpsTaskPriority;
  quadrant: LifeOpsTaskQuadrant;
  category: string;
  estimateMin?: number;
  ideaId?: string;
  learningTrackId?: import("./features/learning/model").LearningTrackId;
  habitPunishment?: HabitPunishmentTask;
  project: string;
  date: string;
  endDate: string;
  time: string;
  /** Planned interval only. `time` remains the unconverted legacy point. */
  startTime?: string;
  endTime?: string;
  dueDate: string;
  dueTime: string;
  repeatUnit: LifeOpsTaskRepeatUnit;
  repeatInterval: number;
  repeatUntil: string;
  parentTaskId: string;
  note: string;
  source: string;
  sourceNotePath: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  completionLog: LifeOpsTaskCompletionEvent[];
  sortOrder: number;
}

export interface LifeOpsTaskInput {
  title: string;
  priority?: LifeOpsTaskPriority;
  quadrant?: LifeOpsTaskQuadrant;
  category?: string;
  estimateMin?: number;
  ideaId?: string;
  learningTrackId?: import("./features/learning/model").LearningTrackId;
  habitPunishment?: HabitPunishmentTask;
  project?: string;
  date?: string;
  endDate?: string;
  time?: string;
  startTime?: string;
  endTime?: string;
  dueDate?: string;
  dueTime?: string;
  repeatUnit?: LifeOpsTaskRepeatUnit;
  repeatInterval?: number;
  repeatUntil?: string;
  parentTaskId?: string;
  note?: string;
  source?: string;
  sourceNotePath?: string;
  sortOrder?: number;
}

export interface HabitInput {
  name: string;
  frequencyUnit: "day" | "week";
  frequencyInterval: number;
  targetCount: number;
  target?: HabitTarget;
  punishment?: HabitPunishment;
  startDate?: string;
  penaltyThreshold?: number;
  color?: string;
  source?: string;
}

export interface HabitCheckin {
  habitId: string;
  date: string;
  status: HabitCheckinStatus;
  count: number;
  value?: number;
  valueUnit?: string;
  updatedAt: string;
  note: string;
}

export interface FolderSettings {
  dailyRoot: string;
  inbox: string;
  tasks: string;
  habits: string;
  ideas: string;
  tradingModels: string;
  tradingReviews: string;
  health: string;
  aiReports: string;
  goals: string;
  outputs: string;
}

export interface AiSettings {
  provider: "off" | "openai-compatible" | "deepseek" | "minimax" | "qwen" | "custom";
  endpoint: string;
  apiKey: string;
  model: string;
  fallbackProvider: "off" | "openai-compatible" | "deepseek" | "minimax" | "qwen" | "custom";
  fallbackEndpoint: string;
  fallbackApiKey: string;
  fallbackModel: string;
  confidenceThreshold: number;
  dataDisclosureAccepted?: boolean;
}

export interface VisionSettings {
  provider: "off" | "openai-compatible" | "qwen-vl" | "qwen-omni" | "minimax" | "custom";
  endpoint: string;
  apiKey: string;
  model: string;
  cameraEnabled: boolean;
  cameraMode: "off" | "local-perception" | "snapshot" | "realtime";
  snapshotIntervalMs: number;
  privacyNoticeAccepted: boolean;
  screenEnabled: boolean;
  screenPrivacyNoticeAccepted: boolean;
  screenAnalysisMinIntervalMs: number;
  remoteDataDisclosureAccepted?: boolean;
  tradeScreenshotDisclosureAccepted?: boolean;
  healthScreenshotDisclosureAccepted?: boolean;
}

export interface VisualAnalysisResult {
  presence: "present" | "absent" | "uncertain";
  lighting: "dark" | "normal" | "bright" | "unknown";
  activity:
    | "working"
    | "idle"
    | "away"
    | "moving"
    | "eating"
    | "entertainment"
    | "reading"
    | "on_phone"
    | "resting"
    | "exercising"
    | "unknown";
  focusLevel: "focused" | "distracted" | "unknown";
  fatigueIndicators: "none" | "slight" | "visible" | "unknown";
  briefDescription: string;
  confidence: "low" | "medium" | "high";
  sensitive: boolean;
  analyzedAt: string;
  /** Host-owned selected frame time. Legacy snapshots may lack this field. */
  observedAt?: string;
  provider: string;
  model: string;
  error?: string;
}

export interface EmbeddingSettings {
  provider: "off" | "openai-compatible" | "deepseek" | "qwen" | "dashscope" | "custom";
  endpoint: string;
  apiKey: string;
  model: string;
  topK: number;
  dataDisclosureAccepted?: boolean;
}

export interface VoiceSettings {
  provider: "off" | "openai-compatible" | "aliyun-tingwu";
  endpoint: string;
  apiKey: string;
  model: string;
  language: string;
  aliyunAccessKeyId: string;
  aliyunAccessKeySecret: string;
  aliyunAppKey: string;
  aliyunRegionId: string;
  aliyunEndpoint: string;
  ossRegion: string;
  ossBucket: string;
  ossPrefix: string;
  ossSignedUrlExpires: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  dataDisclosureAccepted?: boolean;
}

export interface BreezeLocalSettings {
  home: string;
  python: string;
  referenceAudio: string;
  referenceText: string;
}

export interface RealtimeVoiceSettings {
  provider: "off" | "browser-live" | "qwen-omni-realtime";
  mode: "cascade" | "omni-e2e";
  asrEngine?: "realtime" | "streaming-hotwords" | "realtime-only";
  asrHotwords?: string;
  vadSilenceMs?: number;
  endpoint: string;
  apiKey: string;
  model: string;
  ttsModel: string;
  ttsEngine?: "bailian" | "breeze-local" | "breeze-blue";
  localTtsFallback?: "system" | "bailian";
  breeze?: BreezeLocalSettings;
  ttsVoice: string;
  omniVoice: string;
  ttsSampleRate: number;
  language: string;
  autoSendOnStop: boolean;
  cloudFallback: boolean;
  speakReplies: boolean;
  triggerEnabled: boolean;
  triggerPhrases: string;
  triggerSessionTimeoutSec: number;
  dataDisclosureAccepted?: boolean;
  plaintextCredentialStorageAccepted?: boolean;
}

export interface PrivacySettings {
  excludedVaultPrefixes: string[];
  plaintextCredentialStorageAccepted?: boolean;
}

export interface GatewaySettings {
  inboxFile: string;
  sharedSecret: string;
}

export interface LifeOpsSettings {
  habitCompensation?: HabitCompensationSettings;
  setupComplete?: boolean;
  assistantName?: string;
  homeVideoPath?: string;
  linkedNoteNames?: { knowledge: string; trading: string };
  folders: FolderSettings;
  externalVaults?: import("./features/externalVault/readOnly").ExternalVaultSettings[];
  tradingSourceFolders?: string[];
  readingSourceFolders?: string[];
  tradingContractMultipliers?: Record<string, number>;
  tradingBreakEven?: { CNY?: number; USD?: number };
  tradingCnyPerUsd?: number;
  tradingCsvTemplates?: import("./features/trading/csvImport").TradeCsvTemplate[];
  habits: HabitDefinition[];
  phoneInboxEnabled?: boolean;
  ai: AiSettings;
  embedding: EmbeddingSettings;
  vision: VisionSettings;
  voice: VoiceSettings;
  realtimeVoice: RealtimeVoiceSettings;
  gateway: GatewaySettings;
  proactive: ProactiveRuntimeSettings;
  privacy?: PrivacySettings;
}

export type AgentActionType =
  | "create_task"
  | "record_done"
  | "append_daily_note"
  | "record_idea"
  | "record_habit"
  | "record_health"
  | "record_trade"
  | "delete_trade"
  | "send_to_inbox"
  | "delete_task"
  | "delete_habit"
  | "append_knowledge_note"
  | "append_trading_model_note"
  | "update_memory"
  | "review_memory"
  | "note_understanding"
  | "weekly_review"
  | "project_change"
  | "trading_change"
  | "idea_advance"
  | "task_plan"
  | "tool_batch";

export interface AgentActionSuggestion {
  id: string;
  type: AgentActionType;
  title: string;
  description: string;
  content: string;
  date: string;
  memoryFile?: string;
  memoryId?: string;
  memoryDecision?: "confirm" | "correct" | "forget";
  correctedMemoryContent?: string;
  memorySourceDependenciesHash?: string;
  memoryReviewedContent?: string;
  noteUnderstanding?: import("./noteUnderstanding").NoteUnderstandingPayload;
  noteUnderstandingRevision?: string;
  noteUnderstandingReviewHash?: string;
  weeklyReview?: import("./weeklyReview").WeeklyReviewPayload;
  weeklyReviewPath?: string;
  weeklyReviewHash?: string;
  taskIds?: string[];
  habitIds?: string[];
  tradeId?: string;
  expectedTargetRevisions?: Record<string, string>;
  projectCommand?: ProjectCommand;
  projectRevision?: string;
  projectContextRevision?: string;
  projectReviewHash?: string;
  tradingCommand?: TradingCommand;
  tradingRevision?: string;
  tradingContextRevision?: string;
  tradingReviewHash?: string;
  taskPlanToken?: string;
  toolBatch?: import("./ai").AiToolCall[];
  batchWriteCount?: number;
}

export interface AgentConversationMessage {
  role: "user" | "assistant";
  content: string;
  receipts?: AgentWriteReceipt[];
}

export interface AgentWriteReceipt {
  operationId: string;
  tradeEdits?: Array<{ id: string; label: string; summary: string }>;
  taskEdits?: Array<{ id: string; beforeTitle: string; title: string }>;
}

export interface AgentResponse {
  reply: string;
  voiceSpeech?: string;
  toolCalls?: { name: string; ok: boolean }[];
  actions: AgentActionSuggestion[];
  receipts?: AgentWriteReceipt[];
}

export interface AgentSubmissionOptions {
  /** Local voice-turn correlation; no server response identifier or content. */
  providerTraceId?: string;
  source?: "text" | "voice";
  fast?: boolean;
  phoneInbox?: import("./features/phoneInbox/model").PhoneInboxTurn;
  selfTest?: boolean;
  signal?: AbortSignal;
  onVoiceText?: (delta: string) => void;
  deferConversation?: boolean;
  voiceBackground?: boolean;
  voiceJobs?: import("./voice/jobs").VoiceJobManager;
}

export type ProviderErrorCode = "timeout" | "auth" | "rate_limit" | "cancelled" | "network" | "http" | "invalid_response" | "configuration" | "response_incomplete";
export type ProviderIncompleteReason = "length" | "content_filter" | "unknown" | "missing";

export type ProviderTransport = "stream" | "request_url" | "node_https" | "fetch" | "websocket" | "unknown";
export type ProviderStage = "classification" | "daily_review" | "trading_review" | "idea_advance" | "learning_plan" | "learning_quiz" | "reading_index" | "transcription" | "vision" | "screen" | "embedding" | "voice_connection" | "voice_asr" | "voice_response" | "tts" | "system_speech";

export interface ProviderRequestOptions {
  signal?: AbortSignal;
  /** Text-only authority checks. Failures stop retries and must not be swallowed as metrics. */
  beforeTextRequest?: () => void | Promise<void>;
  assertTextRequestCurrent?: () => void;
  onProviderRun?: (run: ProviderRunResult) => void;
  onRequestAudit?: (audit: ProviderRequestAudit) => void;
  onLocalFallback?: (reason: ProviderErrorCode | "unavailable" | "local_error") => void;
}

/** Final text body prepared for a transport attempt, not proof of delivery
 * or token consumption. messageChars sums content's UTF-16 code units,
 * excluding roles, tool-call arguments and JSON escaping; toolSchemaChars
 * counts the tools array only, excluding tool_choice. requestBytes is the
 * complete serialized body's UTF-8 size. maxOutputTokens is not usage. */
export interface ProviderRequestAudit {
  stage: "prepared";
  requestedProvider: string;
  requestedModel: string;
  transport: "request_url" | "stream" | "node_https";
  requestBytes: number;
  messageCount: number;
  messageChars: number;
  toolSchemaChars: number;
  maxOutputTokens?: number;
}

export interface ProviderAttempt {
  provider: string;
  model: string;
  transport: ProviderTransport;
  status: "success" | "failed" | "cancelled";
  errorCode?: ProviderErrorCode;
  networkFailure?: "dns";
  httpStatus?: number;
  incompleteReason?: ProviderIncompleteReason;
}

export interface ProviderTokenDetails {
  textTokens?: number;
  audioTokens?: number;
}

/** Counts reported for one accepted response terminal. Not a bill, ASR/session
 * total, retry aggregate, or cost ceiling. Missing modality counts stay absent. */
export type ProviderResponseUsage = { status: "missing" | "invalid" } | {
  status: "reported";
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputDetails?: ProviderTokenDetails;
  outputDetails?: ProviderTokenDetails;
};

/** Per-request facts only: no endpoint, credentials, prompt, response or raw error. */
export interface ProviderRunResult {
  requestedProvider: string;
  requestedModel: string;
  actualProvider?: string;
  actualModel?: string;
  modelIdentitySource?: "response" | "configured";
  status: "success" | "failed" | "cancelled" | "unavailable";
  fallbackUsed: boolean;
  attempts: ProviderAttempt[];
  responseUsage?: ProviderResponseUsage;
}

export interface QualityLogEntry {
  /** Locally generated correlation only; never a provider response ID. */
  providerTraceId?: string;
  providerStage?: ProviderStage;
  inputSource?: "text" | "voice" | "gateway" | "unknown";
  asrFirstMs?: number;
  asrDoneMs?: number;
  modelFirstMs?: number;
  modelDoneMs?: number;
  ttsFirstMs?: number;
  captureMode?: string;
  retrievalHits?: number;
  actionSuggestions?: number;
  userAcceptedActions?: number;
  rejectedActions?: number;
  agentRoute?: "local_direct" | "realtime_voice" | "conversation" | "deep_reasoning" | "action";
  agentRunMs?: number;
  contextSources?: string[];
  contextFailures?: string[];
  delegationStatus?: "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
  fallbackUsed?: boolean;
  localFallbackUsed?: boolean;
  providerRuns?: ProviderRunResult[];
  requestAudits?: ProviderRequestAudit[];
  requestAuditDropped?: number;
  contextChars?: number;
  toolCalls?: { name: string; ok: boolean }[];
  errorCode?: string;
  errorMessage?: string;
}

export type VoiceMetricEvent =
  | "voice_turn_completed"
  | "voice_input_queued"
  | "voice_pipeline_invalidated"
  | "voice_speech_started"
  | "voice_speech_stopped"
  | "voice_reply_speaking"
  | "voice_latency_sample"
  | "voice_tts_first_audio"
  | "voice_tts_completed"
  | "voice_speech_interrupted"
  | "voice_error";

export interface VoiceMetricEntry {
  event: VoiceMetricEvent;
  provider?: string;
  model?: string;
  mode?: "voice" | "text";
  phase?: string;
  captureMode?: string;
  queueLength?: number;
  generation?: number;
  latency?: import("./voice/latency").VoiceLatency;
  textLength?: number;
  reason?: string;
  asrFirstMs?: number;
  asrDoneMs?: number;
  modelFirstMs?: number;
  modelDoneMs?: number;
  ttsFirstMs?: number;
  ttsDoneMs?: number;
  totalMs?: number;
  bargeInCommandMs?: number;
  actionSuggestions?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface ClassifiedInput {
  kind: CaptureKind;
  confidence: number;
  title: string;
  content: string;
  date: string;
  raw: string;
  reason: string;
  source?: string;
  fields?: Record<string, string | number | boolean>;
}

export interface DashboardStats {
  date: string;
  morningNotePath: string;
  eveningNotePath: string;
  morningNoteExists: boolean;
  eveningNoteExists: boolean;
  todoOpen: number;
  doneCount: number;
  habitDone: number;
  habitTotal: number;
  weeklyFailures: Record<string, number>;
  punishmentOpen: boolean;
  healthEntries: number;
  tradeEntries: number;
  monthlyTradeEntries: number;
  thinkingNotes: number;
  knowledgeNotes: number;
  outputNotes: number;
  recentTradingReviews: string[];
  recentThinkingNotes: string[];
  recentOutputs: string[];
}

export interface HabitDashboardItem {
  habit: HabitDefinition;
  checkin?: HabitCheckin;
  status: HabitCheckinStatus | "pending";
  streak: number;
  weeklyFailures: number;
  totalDone: number;
  requiredToday: boolean;
  periodDone: number;
  periodTarget: number;
  periodLabel: string;
  periodUnit?: string;
  periodUnavailable?: boolean;
  healthCoveragePartial?: boolean;
  healthUnrecorded?: boolean;
  checkinFromHealth?: boolean;
  history: HabitCheckin[];
}

export interface TaskDashboardData {
  date: string;
  tasks: LifeOpsTask[];
  today: LifeOpsTask[];
  tomorrow: LifeOpsTask[];
  nextSevenDays: LifeOpsTask[];
  overdue: LifeOpsTask[];
  completedToday: LifeOpsTask[];
  noDate: LifeOpsTask[];
  allActive: LifeOpsTask[];
  quadrants: Record<LifeOpsTaskQuadrant, LifeOpsTask[]>;
  calendar: Array<{ date: string; tasks: LifeOpsTask[] }>;
  habits: HabitDashboardItem[];
}

export interface HealthEntry {
  date: string;
  sleepHours?: number;
  weightKg?: number;
  steps?: number;
  runningKm?: number;
  restingHeartRate?: number;
  exercise?: string;
  fatigue?: number;
  energy?: number;
  note?: string;
}
