import { activityNotePath, ACTIVITY_LABELS, type ActivityDomain } from "../activityRecords";
import { ACCOUNTABILITY_TEMPLATE } from "../accountability";
import { appendEveningEntry, journalDraftContent } from "../features/journal/entry";
import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { contextSourceHash, isContextSourcePath, recordContextSource, type ContextSourceRecorder } from "../sourceReferences";
import type { FactOperationIdentity, FactOperationOptions } from "../dataFoundation/factOperation";
import { hasInterruptedFactOperation, isGuardedOperationScope, waitForFactOperations } from "../dataFoundation/factOperation";
import type { OperationUndoDescriptor } from "../dataFoundation/operationLedger";
import { serializeJsonData, type JsonWriteOptions } from "../dataFoundation/jsonDataGuard";
import type { ProjectSliceApi } from "./projectSlice";
import type { TradingSliceApi } from "./tradingSlice";
import { decayAssociations, reinforceCoHits } from "../associations";
import { captureKindLabel } from "../classifier";
import { addDays, datesBetween, todayString, weekDates } from "../date";
import { habitRecordedAmount, isHabitRequiredOn, numericHabitPeriods } from "../features/habits/targets";
import { taskScheduleLabel } from "../taskSchedule";
export { isTaskOnDate, isTaskOverdue } from "../taskSchedule";
import { createMemoryCandidate, promoteMemory, recordMemoryRetrieved, selectActiveMemories } from "../memoryIndex";
import { serializeQualityLogEntry } from "../qualityLog";
import type { ProactiveCandidate } from "../scheduler";
import type { ProactiveFeedbackAuditRecord, ProactivePolicyState } from "../proactivePolicy";
import type { SourceManifest } from "../dataFoundation/sourceManifest";
import type { KnowledgeResult } from "../dataFoundation/knowledgeResult";
import type {
  PersonalMemoryDocument,
  PersonalMemoryInput,
  PersonalMemoryRecord,
  PersonalMemoryReview
} from "../personalMemory";
import type {
  Observation,
  ObservationDocument,
  ObservationInput,
  ObservationSource
} from "../observationStore";
import { buildSituation, situationToMarkdown } from "../situation";
import { getTimeContext } from "../timeContext";
import { findJournalFilesForDate, findLatestJournalFiles, journalDateFromPath } from "../journalResolver";
import { createVaultApi, defaultTaskBoard } from "../vaultApi";
import type { VaultFileAdapter } from "../vaultApi";
import type { AssociationEdge } from "../associations";
import type { MemoryCandidateInput, MemoryIndexEntry, MemoryTier } from "../memoryIndex";
import type {
  ClassifiedInput,
  DashboardStats,
  HabitCheckin,
  HabitCheckinStatus,
  HabitDefinition,
  HabitInput,
  HealthEntry,
  LifeOpsSettings,
  LifeOpsTask,
  LifeOpsTaskInput,
  LifeOpsTaskQuadrant,
  QualityLogEntry,
  TaskDashboardData,
  VoiceMetricEntry,
  VisualAnalysisResult
} from "../types";
import { ensureFolderHierarchy } from "../vaultFolders";
import { jsonDataContract, parseJsonData } from "../dataFoundation/jsonDataGuard";

import { taskReadSnapshot, type TaskReadSnapshot, type TaskMirrorRevision } from "../dataFoundation/taskPersistence";
import { readContextTasks } from "../contextData";
import { isVaultPathExcluded, isVisualCachePath } from "../privacy";
import { readJournalContext, type JournalContextSnapshot } from "../journalContext";

export function assertCurrentWrite(isCurrent?: () => boolean): void {
  if (!isCurrent || isCurrent()) return;
  const error = new Error("本次回复已停止，未继续保存。");
  error.name = "AbortError";
  throw error;
}

export interface TaskDatabase {
  [taskReadSnapshot]?: TaskReadSnapshot;
  taskMirror?: TaskMirrorRevision;
  [key: string]: unknown;
  tasks: LifeOpsTask[];
}

export interface HabitDatabase {
  [key: string]: unknown;
  habits: HabitDefinition[];
  checkins: HabitCheckin[];
  lastPunishmentDate?: string;
  habitPunishmentCheckedThrough?: Record<string, string>;
}

export interface VaultIndexEntry {
  path: string;
  title: string;
  category: string;
  tags: string[];
  frontmatter: Record<string, string>;
  mtime: number;
  size: number;
  summary: string;
}

export interface VaultIndex {
  generatedAt: string;
  vaultName: string;
  totalMarkdownFiles: number;
  indexedFiles: number;
  entries: VaultIndexEntry[];
}

export interface VaultStats {
  totalMarkdownFiles: number;
  dailyNotes: number;
  journalNotes: number;
  tradingReviews: number;
  healthNotes: number;
  taskFiles: number;
  habitFiles: number;
  memoryFiles: number;
}

export interface RetrievalHit {
  entry: VaultIndexEntry;
  score: number;
  reasons: string[];
}

export interface KnowledgeLink {
  topic: string;
  description: string;
  keywords: string[];
  paths: string[];
  updatedAt: string;
  summary: string;
  accessCount?: number;
  recentQueries?: string[];
}

export interface KnowledgeLinksDb {
  updatedAt: string;
  links: KnowledgeLink[];
}

export interface VectorIndexEntry {
  path: string;
  title: string;
  category: string;
  mtime: number;
  summary: string;
  embedding: number[];
}

export interface VectorIndex {
  generatedAt: string;
  model: string;
  entries: VectorIndexEntry[];
}

export interface KnowledgeChunk {
  id: string;
  path: string;
  title: string;
  category: string;
  heading: string;
  order: number;
  keywords: string[];
  summary: string;
  text: string;
  mtime: number;
}

export interface KnowledgeChunkIndex {
  generatedAt: string;
  chunks: KnowledgeChunk[];
}

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  type: "note" | "concept" | "category";
  path?: string;
  category?: string;
  weight: number;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  type: "contains" | "mentions" | "related";
  weight: number;
}

export interface KnowledgeGraph {
  generatedAt: string;
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

export interface KnowledgeTopic {
  topic: string;
  description: string;
  folder: string;
  keywords: string[];
  maxFiles: number;
  maxCharsPerFile: number;
}

export interface StoreHost extends ProjectSliceApi, TradingSliceApi {
  canWriteFacts?(): boolean;
  assertFactWritesAllowed?(): Promise<void>;
  assertFileWriteAllowed?(path: string, kind?: "file" | "folder"): Promise<void>;
  runFactOperation?<T>(identity: FactOperationIdentity, execute: (store: StoreHost) => Promise<T>, finalize: (result: T, undo?: OperationUndoDescriptor) => Promise<void>, options?: FactOperationOptions): Promise<T>;
  readonly app: App;
  readonly settings: LifeOpsSettings;
  initializeVault(): Promise<void>;
  ensureDailyNote(date?: string, period?: "早" | "晚"): Promise<TFile>;
  recordClassifiedInput(input: ClassifiedInput): Promise<void>;
  recordHabit(habitName: string, date?: string): Promise<void>;
  appendHealthEntry(entry: HealthEntry): Promise<void>;
  appendGatewayMessage(raw: string, source?: string): Promise<void>;
  readGatewayMessages(): Promise<Array<{ source: string; content: string }>>;
  resetGatewayInbox(): Promise<void>;
  createTask(input: LifeOpsTaskInput): Promise<LifeOpsTask>;
  completeTask(taskId: string, note?: string, completionDate?: string): Promise<void>;
  completeTaskAndLog(taskId: string, date?: string, note?: string, completionDate?: string): Promise<void>;
  abandonTask(taskId: string): Promise<void>;
  moveTaskToQuadrant(taskId: string, quadrant: LifeOpsTaskQuadrant): Promise<void>;
  postponeTask(taskId: string, days: number): Promise<void>;
  postponeTasks(taskIds: string[], days: number): Promise<void>;
  skipRepeatedTask(taskId: string): Promise<void>;
  moveTaskToDate(taskId: string, date: string): Promise<void>;
  duplicateTaskToDate(taskId: string, date: string): Promise<void>;
  updateTaskDetails(taskId: string, input: LifeOpsTaskInput): Promise<void>;
  moveTaskOrder(taskId: string, direction: "up" | "down"): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  createHabit(input: HabitInput): Promise<HabitDefinition>;
  updateHabitDetails(habitId: string, input: HabitInput): Promise<void>;
  deleteHabit(habitId: string): Promise<void>;
  clearHabitCheckin(habitId: string, date?: string): Promise<void>;
  recordHabitStatus(habitId: string, status: HabitCheckinStatus, date?: string, note?: string, value?: number, unit?: string): Promise<void>;
  createDailyReview(markdown: string, date?: string): Promise<void>;
  appendCalendarNote(date: string, note: string): Promise<void>;
  createTradingReview(markdown: string, date?: string): Promise<void>;
  appendAgentConversation(userMessage: string, assistantReply: string, date?: string, isCurrent?: () => boolean): Promise<void>;
  appendQualityLog(entry: QualityLogEntry): Promise<void>;
  appendVoiceMetric(entry: VoiceMetricEntry): Promise<void>;
  writeVoiceRuntimeSelfTestReport(report: unknown): Promise<string>;
  writeVoiceAgentSelfTestReport(report: unknown): Promise<string>;
  readMemoryIndex(): Promise<MemoryIndexEntry[]>;
  writeMemoryIndex(entries: MemoryIndexEntry[]): Promise<void>;
  addMemoryCandidate(input: MemoryCandidateInput): Promise<MemoryIndexEntry>;
  promoteMemoryEntry(id: string, tier?: MemoryTier): Promise<MemoryIndexEntry | null>;
  recordMemoryRetrieval(id: string): Promise<MemoryIndexEntry | null>;
  readPersonalMemories(): Promise<PersonalMemoryDocument>;
  writePersonalMemories(document: PersonalMemoryDocument, isCurrent?: () => boolean): Promise<void>;
  upsertPersonalMemory(input: PersonalMemoryInput, isCurrent?: () => boolean): Promise<PersonalMemoryRecord>;
  reviewPersonalMemory(id: string, review: PersonalMemoryReview): Promise<PersonalMemoryRecord | null>;
  writePersonalMemoryReview(): Promise<string>;
  readMemoryAssociations(): Promise<AssociationEdge[]>;
  writeMemoryAssociations(edges: AssociationEdge[]): Promise<void>;
  reinforceMemoryAssociations(nodeIds: string[], example?: string): Promise<AssociationEdge[]>;
  decayMemoryAssociations(): Promise<AssociationEdge[]>;
  writeWorkflowDraft(fileName: string, markdown: string): Promise<string>;
  appendProactiveCandidates(candidates: ProactiveCandidate[]): Promise<void>;
  readProactiveCandidates(limit?: number): Promise<ProactiveCandidate[]>;
  readProactivePolicyState(): Promise<ProactivePolicyState>;
  writeProactivePolicyState(state: ProactivePolicyState): Promise<void>;
  appendProactiveFeedbackAudit(record: ProactiveFeedbackAuditRecord): Promise<void>;
  appendMemoryNote(fileName: string, content: string): Promise<void>;
  appendKnowledgeNote(content: string, date?: string): Promise<void>;
  appendTradingModelNote(content: string, date?: string): Promise<void>;
  readObservations(): Promise<ObservationDocument>;
  appendObservation(input: ObservationInput): Promise<Observation>;
  clearObservations(source: ObservationSource): Promise<void>;
  createRetrievalDebugReport(query: string, sections: { semantic: string; keyword: string; knowledge: string }): Promise<string>;
  buildContext(date?: string): Promise<string>;
  getVaultStats(): VaultStats;
  buildTradingContext(date?: string, record?: ContextSourceRecorder): Promise<string>;
  searchKnowledge(query: string, limit?: number): Promise<KnowledgeResult[]>;
  buildRetrievalContext(query: string, limit?: number, record?: ContextSourceRecorder): Promise<string>;
  buildSemanticContext(queryEmbedding: number[], limit?: number, record?: ContextSourceRecorder): Promise<string>;
  buildKnowledgeContext(query: string, record?: ContextSourceRecorder): Promise<string>;
  rebuildVaultIndex(): Promise<{ path: string; totalMarkdownFiles: number; indexedFiles: number }>;
  rebuildKnowledgeStructure(index?: VaultIndex): Promise<{ chunks: number; nodes: number; edges: number }>;
  buildKnowledgeGraphContext(query: string, record?: ContextSourceRecorder): Promise<string>;
  rebuildVectorIndex(model: string, embed: (input: string) => Promise<number[]>, assertCurrent?: () => void, onCommitted?: () => void): Promise<{ path: string; indexedFiles: number; reusedFiles: number; generatedFiles: number }>;
  getDashboardStats(date?: string, board?: Promise<TaskDashboardData>): Promise<DashboardStats>;
  getTaskDashboard(date?: string, options?: { forContext?: boolean }): Promise<TaskDashboardData>;
  checkPunishments(now?: Date, acknowledgeLegacy?: boolean): Promise<void>;
  acceptPunishments(): Promise<void>;
  getWeeklyFailures(date: string, database?: HabitDatabase): Promise<Record<string, number>>;
  hasOpenPunishment(): Promise<boolean>;
  updateTask(taskId: string, updater: (task: LifeOpsTask) => LifeOpsTask): Promise<void>;
  getTask(taskId: string): Promise<LifeOpsTask>;
  createNextRepeatedTask(task: LifeOpsTask, completedAt: string): Promise<void>;
  buildHabitDashboard(checkins: HabitCheckin[], date: string, database?: HabitDatabase, tradeUnavailable?: boolean): Promise<TaskDashboardData["habits"]>;
  countHabitStreak(checkins: HabitCheckin[], habitId: string, date: string): number;
  readTaskDb(options?: { readOnly?: boolean }): Promise<TaskDatabase>;
  writeTaskDb(db: TaskDatabase): Promise<void>;
  readHabitDb(): Promise<HabitDatabase>;
  writeHabitDb(db: HabitDatabase): Promise<void>;
  getHabitDefinitions(): Promise<HabitDefinition[]>;
  readJson<T>(filePath: string, fallback: T): Promise<T>;
  writeJson(filePath: string, value: unknown, options?: JsonWriteOptions): Promise<void>;
  writeFile(filePath: string, content: string): Promise<void>;
  writeTaskMirror(tasks: LifeOpsTask[]): Promise<void>;
  writeHabitMirror(habits: HabitDefinition[], checkins: HabitCheckin[]): Promise<void>;
  appendDaily(date: string, heading: string, line: string, period?: "早" | "晚", original?: string): Promise<void>;
  appendActivity(domain: ActivityDomain, date: string, heading: string, line: string): Promise<void>;
  appendInbox(input: ClassifiedInput): Promise<void>;
  appendMonthlyIdea(input: ClassifiedInput): Promise<void>;
  appendTrade(input: ClassifiedInput): Promise<void>;
  appendHealthText(content: string, date: string): Promise<void>;
  appendFile(filePath: string, content: string, isCurrent?: () => boolean, options?: { preserveExistingText?: boolean }): Promise<void>;
  ensureFile(filePath: string, initialContent: string): Promise<TFile>;
  ensureFolder(folderPath: string): Promise<void>;
  getFile(filePath: string): TFile | null;
  readPath(filePath: string): Promise<string>;
  deleteFile(filePath: string): Promise<void>;
  readFolder(folderPath: string, record?: ContextSourceRecorder): Promise<string>;
  collectFolders(): string[];
  path(...parts: string[]): string;
  dailyNotePath(date: string, period: "早" | "晚"): string;
  tradingReviewPath(date: string): string;
  taskDbPath(): string;
  habitDbPath(): string;
  taskMirrorPath(): string;
  habitMirrorPath(): string;
  vaultIndexPath(): string;
  vectorIndexPath(): string;
  chunkIndexPath(): string;
  knowledgeGraphPath(): string;
  knowledgeLinksPath(): string;
  visionStatePath(): string;
  visionAnalysisPath(): string;
  desktopAnalysisPath(): string;
  observationsPath(): string;
  qualityLogPath(): string;
  providerEgressAuditPath(): string;
  voiceMetricsPath(): string;
  proactiveCandidatesPath(): string;
  proactivePolicyPath(): string;
  proactiveFeedbackAuditPath(): string;
  memoryIndexPath(): string;
  personalMemoryPath(): string;
  associationsPath(): string;
  sourceManifestPath(): string;
  readSourceManifest(): Promise<SourceManifest>;
  writeSourceManifest(manifest: SourceManifest): Promise<void>;
  isManagedSourcePath(path: string): boolean;
  upsertVaultSource(path: string): Promise<{ changed: boolean; sourceId?: string; chunks: number }>;
  removeVaultSource(path: string): Promise<boolean>;
  renameVaultSource(oldPath: string, newPath: string): Promise<boolean>;
  syncVaultSources(): Promise<{ addedOrChanged: number; deleted: number; unchanged: number }>;
  classifyIndexCategory(filePath: string): string;
  tradingMonthFolder(date: string): string;
  matchKnowledgeTopics(query: string): KnowledgeTopic[];
  buildKnowledgeTopicContext(topic: KnowledgeTopic, query?: string, record?: ContextSourceRecorder): Promise<string>;
  upsertKnowledgeLink(link: KnowledgeLink, query?: string): Promise<void>;
  readDailyPair(date: string, onRead?: (snapshot: JournalContextSnapshot) => void): Promise<string>;
  buildLatestJournalContext(maxChars?: number): Promise<string>;
  ensureMemoryFiles(): Promise<void>;
  ensureAgentPersonaRules(): Promise<void>;
  buildPersonalMemoryContext(query?: string, options?: { maxChars: number }): Promise<string>;
  buildMemoryContext(query?: string): Promise<string>;
  hasMemoryCoverage(query: string): Promise<boolean>;

  buildSituationContext(): Promise<string>;


  buildIndexSummaryContext(): Promise<string>;
  buildVaultStatsContext(): string;
  memoryFilePath(name: string): string;
  buildRecentDailyContext(date: string): Promise<string>;
  buildTaskContext(date: string): Promise<string>;
  buildHabitContext(date: string): Promise<string>;
  readRecentMarkdownContext(folderPath: string, limit: number, maxCharsPerFile: number, onRead?: (snapshot: import("../recentContext").RecentMarkdownSnapshot) => void): Promise<string>;
  collectMarkdownFiles(folder: TFolder, depth: number): TFile[];
  countMarkdownFiles(folderPath: string): Promise<number>;
  countMonthlyTradingReviews(date: string): Promise<number>;
  recentMarkdownFiles(folderPath: string, limit: number): Promise<string[]>;
}

type StoreConstructor = { prototype: object };

export interface SettingsSliceApi {
  initializeVault(): Promise<void>;
  ensureDailyNote(date?: string, period?: "早" | "晚"): Promise<TFile>;
  recordClassifiedInput(input: ClassifiedInput): Promise<void>;
  recordHabit(habitName: string, date?: string): Promise<void>;
  appendHealthEntry(entry: HealthEntry): Promise<void>;
  appendGatewayMessage(raw: string, source?: string): Promise<void>;
  readGatewayMessages(): Promise<Array<{ source: string; content: string }>>;
  resetGatewayInbox(): Promise<void>;
  createDailyReview(markdown: string, date?: string): Promise<void>;
  appendCalendarNote(date: string, note: string): Promise<void>;
  createTradingReview(markdown: string, date?: string): Promise<void>;
  getDashboardStats(date?: string, board?: Promise<TaskDashboardData>): Promise<DashboardStats>;
  buildLatestJournalContext(maxChars?: number): Promise<string>;
}

const settingsSlice = {
async initializeVault(this: StoreHost): Promise<void> {
    if (this.runFactOperation && !isGuardedOperationScope(this)) {
      // A live save may still have a pending WAL; wait for its final guard before checking interruption.
      await waitForFactOperations(this);
      if (await hasInterruptedFactOperation(this)) {
        throw new Error("上次保存尚未恢复，已暂停初始化。请先运行“检查并恢复未完成操作”。");
      }
    }
    const folders = this.collectFolders();
    for (const folder of folders) {
      await this.ensureFolder(folder);
    }

    await this.ensureFile(
      this.path(this.settings.folders.inbox, "待确认.md"),
      "# 待确认\n\n这里存放 AI 低置信度或需要人工确认的外部输入。\n"
    );
    await this.ensureFile(
      this.settings.gateway.inboxFile,
      "# 外部输入\n\n聊天工具、微信网关或其他外部入口可以先写入这里。\n"
    );
    await this.ensureFile(
      this.path(this.settings.folders.habits, "Punishments.md"),
      ACCOUNTABILITY_TEMPLATE
    );
    await this.ensureFile(
      this.path(this.settings.folders.tasks, "未完成.md"),
      "# 未完成\n\n跨天未完成事项会沉淀在这里，供复盘和周报使用。\n"
    );
    // Do not shadow a legacy board with a new empty canonical database at startup.
    const existingTaskBoard = await this.readPath(this.taskMirrorPath());
    if (this.getFile(this.taskDbPath()) || !/^\s*-\s+\[[ xX]\]/m.test(existingTaskBoard)) {
      await this.ensureFile(this.taskDbPath(), JSON.stringify({ tasks: [] }, null, 2));
    }
    await this.ensureFile(this.habitDbPath(), JSON.stringify({ habits: [], checkins: [] }, null, 2));
    await this.ensureFile(
      this.taskMirrorPath(),
      defaultTaskBoard()
    );
    await this.ensureFile(
      this.habitMirrorPath(),
      "# LifeOps 习惯打卡\n\n这个文件由 LifeOps 插件维护，用于在 Obsidian 中保留可读的打卡快照。\n"
    );
    await this.ensureFile(
      this.path("Templates", "Daily LifeOps.md"),
      dailyTemplate()
    );
    await this.ensureFile(this.vaultIndexPath(), JSON.stringify(emptyVaultIndex(), null, 2));
    await this.ensureFile(this.vectorIndexPath(), JSON.stringify(emptyVectorIndex(), null, 2));
    await this.ensureFile(this.chunkIndexPath(), JSON.stringify(emptyKnowledgeChunkIndex(), null, 2));
    await this.ensureFile(this.knowledgeGraphPath(), JSON.stringify(emptyKnowledgeGraph(), null, 2));
    await this.ensureFile(this.knowledgeLinksPath(), JSON.stringify(emptyKnowledgeLinks(), null, 2));
    await this.ensureMemoryFiles();
  },

async ensureDailyNote(this: StoreHost, date: string = todayString(), period: "早" | "晚" = "早"): Promise<TFile> {
    const filePath = this.dailyNotePath(date, period);
    return this.ensureFile(filePath, dailyNote(date, period));
  },

async recordClassifiedInput(this: StoreHost, input: ClassifiedInput): Promise<void> {
    if (input.confidence < this.settings.ai.confidenceThreshold) {
      await this.appendInbox(input);
      return;
    }

    switch (input.kind) {
      case "todo":
        await this.createTask({
          title: input.content,
          date: input.date,
          category: "待分类",
          source: input.source ?? "capture",
          sourceNotePath: activityNotePath(this, "tasks", input.date)
        });
        await this.appendActivity("tasks", input.date, "待办", `- [ ] ${input.content}`);
        break;
      case "done":
        await this.appendActivity("tasks", input.date, "口述完成（未关联任务）", `- [x] ${input.content}`);
        break;
      case "diary":
        await this.appendDaily(input.date, "日记", input.content);
        break;
      case "idea":
        await this.appendMonthlyIdea(input);
        break;
      case "habit":
        await this.recordHabit(input.content, input.date);
        break;
      case "trade":
        await this.appendTrade(input);
        break;
      case "health":
        await this.appendHealthText(input.content, input.date);
        break;
      case "memo":
        await this.appendInbox(input);
        break;
    }
  },

async recordHabit(this: StoreHost, habitName: string, date: string = todayString()): Promise<void> {
    const habits = (await this.getHabitDefinitions()).filter((item) => item.id === habitName || item.name === habitName);
    if (habits.length !== 1) throw new Error(habits.length ? "找到多个同名习惯，请选择具体习惯。" : "没有找到这项习惯，请先创建或选择具体习惯。");
    const habit = habits[0];
    await this.recordHabitStatus(habit.id, "done", date);
  },

async appendHealthEntry(this: StoreHost, entry: HealthEntry): Promise<void> {
    const continuation = (value: string) => value.replace(/\r\n|\r|\n/gu, "\n  ");
    const lines = [
      `## ${entry.date}`,
      entry.sleepHours !== undefined ? `- 睡眠小时：${entry.sleepHours}` : "",
      entry.weightKg !== undefined ? `- 体重：${entry.weightKg} kg` : "",
      entry.steps !== undefined ? `- 步数：${entry.steps}` : "",
      entry.runningKm !== undefined ? `- 跑步距离：${entry.runningKm} 公里` : "",
      entry.restingHeartRate !== undefined ? `- 静息心率：${entry.restingHeartRate} 次/分` : "",
      entry.exercise ? `- 运动：${continuation(entry.exercise)}` : "",
      entry.fatigue !== undefined ? `- 疲劳：${entry.fatigue}` : "",
      entry.energy !== undefined ? `- 精力：${entry.energy}` : "",
      entry.note ? `- 备注：${continuation(entry.note)}` : ""
    ].filter(Boolean);
    await this.appendFile(this.path(this.settings.folders.health, `${entry.date}.md`), `${lines.join("\n")}\n`, undefined,
      { preserveExistingText: true });
  },

async appendGatewayMessage(this: StoreHost, raw: string, source: string = "gateway"): Promise<void> {
    const stamp = new Date().toISOString();
    await this.appendFile(this.settings.gateway.inboxFile, `\n## ${stamp}\n\n- 来源：${source}\n- 内容：${raw}\n`);
  },

async readGatewayMessages(this: StoreHost): Promise<Array<{ source: string; content: string }>> {
    const text = await this.readPath(this.settings.gateway.inboxFile);
    return text
      .split(/\n## /)
      .map((block) => {
        const source = block.match(/- 来源：(.+)/)?.[1]?.trim() ?? "gateway";
        const content = block.match(/- 内容：([\s\S]+)/)?.[1]?.trim() ?? "";
        return { source, content };
      })
      .filter((message) => message.content.length > 0);
  },

async resetGatewayInbox(this: StoreHost): Promise<void> {
    const file = await this.ensureFile(this.settings.gateway.inboxFile, "# 外部输入\n");
    await this.assertFileWriteAllowed?.(file.path);
    await this.app.vault.modify(file, "# 外部输入\n\n已处理的外部输入会被清空。新的聊天消息可以继续写入这里。\n");
  },

async createDailyReview(this: StoreHost, markdown: string, date: string = todayString()): Promise<void> {
    const draft = `> LifeOps 生成的复盘草稿，请核对；不代表已经确认的个人事实。\n\n${markdown.trim()}`;
    await this.appendDaily(date, "晚间复盘", journalDraftContent(draft), "晚");
    await this.appendFile(this.path(this.settings.folders.aiReports, `${date}-日报.md`), `# ${date} 日报\n\n${draft}\n`);
  },

async appendCalendarNote(this: StoreHost, date: string, note: string): Promise<void> {
    const value = note.trim();
    if (!value) {
      throw new Error("备注不能为空");
    }
    await this.appendDaily(date, "日记", value);
  },

async createTradingReview(this: StoreHost, markdown: string, date: string = todayString()): Promise<void> {
    await this.appendFile(this.tradingReviewPath(date), `\n## AI 交易复盘\n\n> LifeOps 生成的复盘草稿，请核对；不代表已经确认的交易事实。\n\n${markdown.trim()}\n`);
  },

async getDashboardStats(this: StoreHost, date: string = todayString(), board?: Promise<TaskDashboardData>): Promise<DashboardStats> {
    const dashboard = board ? await board : await this.getTaskDashboard(date);
    if (board) date = dashboard.date;
    const morningNotePath = this.dailyNotePath(date, "早");
    const eveningNotePath = this.dailyNotePath(date, "晚");
    const health = await this.readPath(this.path(this.settings.folders.health, `${date}.md`));
    const todayTrade = await this.readPath(this.tradingReviewPath(date));
    const habits = dashboard.habits;
    return {
      date,
      morningNotePath,
      eveningNotePath,
      morningNoteExists: Boolean(this.getFile(morningNotePath)),
      eveningNoteExists: Boolean(this.getFile(eveningNotePath)),
      todoOpen: dashboard.today.length,
      doneCount: dashboard.completedToday.length,
      habitDone: habits.filter(item => item.periodDone >= item.periodTarget).length,
      habitTotal: habits.length,
      weeklyFailures: Object.fromEntries(habits.filter(item => !item.periodUnavailable)
        .map(item => [item.habit.name, item.weeklyFailures])),
      punishmentOpen: await this.hasOpenPunishment(),
      healthEntries: countMatches(health, /^## (?:\d{4}-\d{2}-\d{2}|手动记录)/gm),
      tradeEntries: countMatches(todayTrade, /交易：<\/span>|^\d+\./gm),
      monthlyTradeEntries: await this.countMonthlyTradingReviews(date),
      thinkingNotes: await this.countMarkdownFiles(this.settings.folders.ideas),
      knowledgeNotes: await this.countMarkdownFiles(this.settings.folders.tradingModels),
      outputNotes: await this.countMarkdownFiles(this.settings.folders.outputs),
      // Recent-note text uses extensionless links; source buttons require exact file paths.
      recentTradingReviews: (await this.recentMarkdownFiles(this.tradingMonthFolder(date), 3)).map(path => `${path}.md`),
      recentThinkingNotes: (await this.recentMarkdownFiles(this.settings.folders.ideas, 3)).map(path => `${path}.md`),
      recentOutputs: (await this.recentMarkdownFiles(this.settings.folders.outputs, 3)).map(path => `${path}.md`)
    };
  },

async readJson<T>(this: StoreHost, filePath: string, fallback: T): Promise<T> {
    const normalized = normalizePath(filePath);
    const file = this.getFile(normalized);
    if (!file) return fallback;
    const text = await this.app.vault.read(file);
    return parseJsonData(text, normalized, jsonDataContract(normalized, this.settings.folders)) as T;
  },

async writeJson(this: StoreHost, filePath: string, value: unknown, options?: JsonWriteOptions): Promise<void> {
    const normalized = normalizePath(filePath);
    await this.assertFileWriteAllowed?.(normalized);
    const text = serializeJsonData(value, options);
    await writeProtectedJsonText(this, normalized, text);
  },

async writeFile(this: StoreHost, filePath: string, content: string): Promise<void> {
    const normalized = normalizePath(filePath);
    await this.assertFileWriteAllowed?.(normalized);
    if (jsonDataContract(normalized, this.settings.folders)) {
      await writeProtectedJsonText(this, normalized, content);
      return;
    }
    await checkDatabaseBeforeMirrorWrite(this, normalized);
    await this.ensureFolder(parentFolder(normalized));
    const file = this.getFile(normalized);
    if (!file) {
      await this.app.vault.create(normalized, content);
      return;
    }
    await this.app.vault.modify(file, content);
  },

async appendDaily(this: StoreHost, date: string, heading: string, line: string, period: "早" | "晚" = "早", original?: string): Promise<void> {
    const file = await this.ensureDailyNote(date, period);
    await this.assertFileWriteAllowed?.(file.path);
    if (period === "晚") {
      await this.app.vault.process(file, text => appendEveningEntry(text, heading, line, original));
      return;
    }
    await this.app.vault.process(file, (text) => heading === "日记" && !/^## 日记\s*$/m.test(text)
      ? `${text.trimEnd()}\n\n${line.trim()}\n`
      : insertUnderHeading(text, heading, line));
  },

async appendActivity(this: StoreHost, domain: ActivityDomain, date: string, heading: string, line: string): Promise<void> {
    const file = await this.ensureFile(activityNotePath(this, domain, date), `# ${date} ${ACTIVITY_LABELS[domain]}\n`);
    await this.assertFileWriteAllowed?.(file.path);
    await this.app.vault.process(file, text => insertUnderHeading(text, heading, line));
  },

async appendInbox(this: StoreHost, input: ClassifiedInput): Promise<void> {
    const line = [
      `## ${new Date().toISOString()}`,
      "",
      `- 类型：${captureKindLabel(input.kind)}`,
      `- 置信度：${input.confidence.toFixed(2)}`,
      `- 来源：${input.source ?? "unknown"}`,
      `- 原因：${input.reason}`,
      "",
      input.raw
    ].join("\n");
    await this.appendFile(this.path(this.settings.folders.inbox, "待确认.md"), `\n${line}\n`);
  },

async appendMonthlyIdea(this: StoreHost, input: ClassifiedInput): Promise<void> {
    const title = safeFilename(input.title || input.content.slice(0, 24) || "新思考");
    const notePath = this.path(this.settings.folders.ideas, `${title}.md`);
    const note = [`# ${title}`, "", `> ${input.date} 由 LifeOps 快速记录生成。`, "", input.content, ""].join("\n");
    await this.appendFile(notePath, `${note}\n`);
    await this.appendActivity("ideas", input.date, "灵感", `- [[${notePath.replace(/\.md$/, "")}|${title}]]`);
  },

async appendTrade(this: StoreHost, input: ClassifiedInput): Promise<void> {
    await this.appendInbox(input);
  },

async appendHealthText(this: StoreHost, content: string, date: string): Promise<void> {
    await this.appendFile(this.path(this.settings.folders.health, `${date}.md`), `\n## 手动记录\n\n${content}\n`, undefined,
      { preserveExistingText: true });
  },

async appendFile(this: StoreHost, filePath: string, content: string, isCurrent?: () => boolean,
  options?: { preserveExistingText?: boolean }): Promise<void> {
    assertCurrentWrite(isCurrent);
    const normalized = normalizePath(filePath);
    await this.assertFileWriteAllowed?.(normalized);
    await this.ensureFolder(parentFolder(normalized));
    assertCurrentWrite(isCurrent);
    const file = this.getFile(normalized);
    if (!file) {
      await this.app.vault.create(normalized, content.trimStart());
      return;
    }
    await this.app.vault.process(file, (text) => {
      assertCurrentWrite(isCurrent);
      if (options?.preserveExistingText) return text + (text && !/[\r\n]$/u.test(text) ? "\n" : "") + content;
      return `${text.trimEnd()}\n${content}`;
    });
  },

async ensureFile(this: StoreHost, filePath: string, initialContent: string): Promise<TFile> {
    const normalized = normalizePath(filePath);
    await this.ensureFolder(parentFolder(normalized));
    const existing = this.getFile(normalized);
    if (existing) return existing;
    await this.assertFileWriteAllowed?.(normalized);
    return this.app.vault.create(normalized, initialContent);
  },

async ensureFolder(this: StoreHost, folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    await ensureFolderHierarchy(normalized, {
      exists: (path) => Boolean(this.app.vault.getAbstractFileByPath(path)),
      create: async (path) => {
        await this.assertFileWriteAllowed?.(path, "folder");
        await this.app.vault.createFolder(path);
      }
    });
  },

getFile(this: StoreHost, filePath: string): TFile | null {
    const abstractFile = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
    return abstractFile instanceof TFile ? abstractFile : null;
  },

async readPath(this: StoreHost, filePath: string): Promise<string> {
    const file = this.getFile(filePath);
    return file ? this.app.vault.read(file) : "";
  },

async deleteFile(this: StoreHost, filePath: string): Promise<void> {
    const file = this.getFile(filePath);
    if (file) {
      await this.assertFileWriteAllowed?.(file.path);
      await this.app.vault.delete(file, true);
    }
  },

async readFolder(this: StoreHost, folderPath: string, record?: ContextSourceRecorder): Promise<string> {
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(folderPath));
    if (!(folder instanceof TFolder)) return "";
    const chunks: string[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") {
        if (record && (!isContextSourcePath(child.path) || !this.isManagedSourcePath(child.path))) continue;
        const raw = await this.app.vault.read(child);
        const fragment = `## ${child.path}\n\n${raw}`;
        chunks.push(fragment);
        recordContextSource(record, child.path, fragment, contextSourceHash(raw));
      }
    }
    return chunks.join("\n\n");
  },

collectFolders(this: StoreHost): string[] {
    const values = Object.values(this.settings.folders);
    return Array.from(new Set([...values, parentFolder(this.settings.gateway.inboxFile), "Templates"]));
  },

path(this: StoreHost, ...parts: string[]): string {
    return normalizePath(parts.filter(Boolean).join("/"));
  },

dailyNotePath(this: StoreHost, date: string, period: "早" | "晚"): string {
    return this.path(this.settings.folders.dailyRoot, date.slice(0, 4), date.slice(5, 7), `${date}${period}.md`);
  },

tradingReviewPath(this: StoreHost, date: string): string {
    return this.path(this.tradingMonthFolder(date), `${date}.md`);
  },

taskDbPath(this: StoreHost): string {
    return this.path(this.settings.folders.tasks, "LifeOps任务库.json");
  },

habitDbPath(this: StoreHost): string {
    return this.path(this.settings.folders.habits, "LifeOps打卡库.json");
  },

taskMirrorPath(this: StoreHost): string {
    return this.path(this.settings.folders.tasks, "任务看板.md");
  },

habitMirrorPath(this: StoreHost): string {
    return this.path(this.settings.folders.habits, "打卡看板.md");
  },

vaultIndexPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Index", "lifeops-index.json");
  },

vectorIndexPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Index", "lifeops-vectors.json");
  },

chunkIndexPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Knowledge", "lifeops-chunks.json");
  },

knowledgeGraphPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Knowledge", "lifeops-knowledge-graph.json");
  },

knowledgeLinksPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Knowledge", "knowledge-links.json");
  },

visionStatePath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Vision", "current-state.md");
  },

visionAnalysisPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Vision", "visual-state.json");
  },

desktopAnalysisPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Desktop", "desktop-state.json");
  },

observationsPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Situation", "observations.json");
  },

qualityLogPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Quality", "quality-log.jsonl");
  },

providerEgressAuditPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Quality", "provider-egress.jsonl");
  },

voiceMetricsPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Quality", "voice-metrics.jsonl");
  },

proactiveCandidatesPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Proactive", "candidates.jsonl");
  },

proactivePolicyPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Proactive", "policy-state.json");
  },

proactiveFeedbackAuditPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Proactive", "feedback-audit.jsonl");
  },

memoryIndexPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Memory", "memory-index.json");
  },

personalMemoryPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Memory", "personal-memory.json");
  },

associationsPath(this: StoreHost): string {
    return this.path(this.settings.folders.aiReports, "Knowledge", "associations.json");
  },

tradingMonthFolder(this: StoreHost, date: string): string {
    const month = Number(date.slice(5, 7));
    return this.path(this.settings.folders.tradingReviews, date.slice(0, 4), `${month}月`);
  },

async readDailyPair(this: StoreHost, date: string, onRead?: (snapshot: JournalContextSnapshot) => void): Promise<string> {
    const snapshot = await readJournalContext(this, date);
    // Observation must not turn a successful read into a retry or write.
    try { onRead?.(snapshot); } catch { /* Optional in-memory metadata only. */ }
    return snapshot.text;
  },

async buildLatestJournalContext(this: StoreHost, maxChars = 18_000): Promise<string> {
    const matches = findLatestJournalFiles(
      this.app.vault.getMarkdownFiles()
        .filter((file) => this.isManagedSourcePath(file.path))
        .map((file) => ({
        path: file.path,
        mtime: file.stat.mtime,
        file
      })),
      this.settings.folders.dailyRoot
    );
    for (const match of matches) {
      const content = (await this.app.vault.cachedRead(match.file)).trim();
      if (!content) continue;
      const date = journalDateFromPath(match.path, this.settings.folders.dailyRoot) ?? "unknown";
      const limit = Math.max(1_000, Math.min(30_000, maxChars));
      const clipped = content.length <= limit
        ? content
        : `${content.slice(0, limit).trimEnd()}\n\n...[truncated ${content.length - limit} chars]`;
      return [
        "## Latest Journal Source",
        `- date: ${date}`,
        `- file: ${match.file.name}`,
        `- path: ${match.path}`,
        "- selection: latest journal by date and period",
        `### ${match.path}`,
        clipped
      ].join("\n\n");
    }
    return "";
  }
};

export function createStoreVaultApi(store: StoreHost) {
  return createVaultApi(createStoreVaultAdapter(store), {
    folders: store.settings.folders,
    idFactory: () => `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  });
}

export function createStoreVaultAdapter(store: StoreHost, options: { forContext?: boolean } = {}): VaultFileAdapter {
  const readable = (path: string) => isContextSourcePath(path) && !isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)
    && !isVisualCachePath(path, store.settings.folders.aiReports) && store.getFile(path)?.path === path;
  return {
    taskAuthority: {
      readTasks: async () => {
        if (!options.forContext) return (await store.readTaskDb({ readOnly: true })).tasks;
        const data = await readContextTasks(store);
        if (!data.available) throw new Error("任务记录未提供，不能当成零项。");
        return data.tasks;
      },
      createTask: input => { if (options.forContext) throw new Error("上下文读取入口不能保存任务。"); return store.createTask(input); },
      completeTask: async (reference, note = "") => {
        if (options.forContext) throw new Error("上下文读取入口不能保存任务。");
        const tasks = (await store.readTaskDb({ readOnly: true })).tasks;
        const exactId = tasks.find(task => task.id === reference);
        const matches = exactId ? [exactId] : tasks.filter(task => task.title === reference);
        if (matches.length !== 1) throw new Error("请指定唯一的任务，未修改记录");
        await store.completeTask(matches[0].id, note);
        return store.getTask(matches[0].id);
      }
    },
    read: async (path: string) => {
      if (options.forContext && !readable(path)) return "";
      const value = await store.readPath(path);
      return options.forContext && !readable(path) ? "" : value;
    },
    write: (path: string, content: string) => { if (options.forContext) throw new Error("上下文读取入口不能写入记录。"); return store.writeFile(path, content); },
    process: async (path: string, updater: (content: string) => string) => {
      if (options.forContext) throw new Error("上下文读取入口不能修改记录。");
      await checkDatabaseBeforeMirrorWrite(store, normalizePath(path));
      const file = store.getFile(path);
      if (!file) {
        const next = updater("");
        await store.writeFile(path, next);
        return next;
      }
      let next = "";
      await store.assertFileWriteAllowed?.(file.path);
      await store.app.vault.process(file, (content) => {
        next = updater(content);
        return next;
      });
      return next;
    },
    exists: async (path: string) => options.forContext ? readable(path) : Boolean(store.getFile(path)),
    listMarkdownFiles: async () => store.app.vault.getMarkdownFiles().filter(file => !options.forContext || readable(file.path)).map((file) => ({
      path: file.path,
      mtime: file.stat.mtime
    }))
  };
}

async function writeProtectedJsonText(store: StoreHost, path: string, text: string): Promise<void> {
  const contract = jsonDataContract(path, store.settings.folders);
  parseJsonData(text, path, contract);
  const file = store.getFile(path);
  if (file) {
    parseJsonData(await store.app.vault.read(file), path, contract);
    await store.app.vault.process(file, (current) => {
      // Recheck the actual bytes at update time, even when an earlier read succeeded.
      parseJsonData(current, path, contract);
      return text;
    });
    return;
  }
  await store.ensureFolder(parentFolder(path));
  // Vault.create refuses an existing file; do not turn a create race into overwrite.
  await store.app.vault.create(path, text);
}

async function checkDatabaseBeforeMirrorWrite(store: StoreHost, path: string): Promise<void> {
  if (path === normalizePath(store.taskMirrorPath())) {
    await store.readJson<TaskDatabase>(store.taskDbPath(), { tasks: [] });
  } else if (path === normalizePath(store.habitMirrorPath())) {
    await store.readJson<HabitDatabase>(store.habitDbPath(), { habits: [], checkins: [] });
  }
}

export function applySettingsSlice(Store: StoreConstructor): void {
  Object.assign(Store.prototype, settingsSlice);
}

export function insertUnderHeading(text: string, heading: string, line: string): string {
  const marker = `## ${heading}`;
  const trimmedLine = line.trimEnd();
  if (!text.includes(marker)) {
    return `${text.trimEnd()}\n\n${marker}\n\n${trimmedLine}\n`;
  }
  const start = text.indexOf(marker);
  const afterHeading = text.indexOf("\n", start);
  const nextHeading = text.indexOf("\n## ", afterHeading + 1);
  const insertAt = nextHeading === -1 ? text.length : nextHeading;
  const before = text.slice(0, insertAt).trimEnd();
  const after = text.slice(insertAt);
  return `${before}\n${trimmedLine}${after}`;
}

export function parentFolder(path: string): string {
  const index = normalizePath(path).lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

export function dailyNote(date: string, period: "早" | "晚"): string {
  return `# ${date}${period}\n\n`;
}

export function dailyTemplate(): string {
  return dailyNote("<% tp.date.now('YYYY-MM-DD') %>", "早");
}

export function memoryFiles(): Array<{ name: string; content: string }> {
  return ["个人画像", "当前状态", "长期目标", "管家规则", "交易纪律"].map(title => ({
    name: `${title}.md`,
    content: `# ${title}\n\n> 历史资料保留页。当前生效的个人记忆由 LifeOps 的个人记忆审查统一管理。\n> 这里的文字不会自动当作已确认事实。\n\n暂无用户记录。\n`
  }));
}

export function memoryFileNames(): string[] {
  return memoryFiles().map((file) => file.name);
}

export function emptyVaultIndex(): VaultIndex {
  return {
    generatedAt: new Date().toISOString(),
    vaultName: "",
    totalMarkdownFiles: 0,
    indexedFiles: 0,
    entries: []
  };
}

export function emptyVectorIndex(): VectorIndex {
  return {
    generatedAt: new Date().toISOString(),
    model: "",
    entries: []
  };
}

export function emptyKnowledgeLinks(): KnowledgeLinksDb {
  return {
    updatedAt: new Date().toISOString(),
    links: []
  };
}

export function emptyKnowledgeChunkIndex(): KnowledgeChunkIndex {
  return {
    generatedAt: new Date().toISOString(),
    chunks: []
  };
}

export function emptyKnowledgeGraph(): KnowledgeGraph {
  return {
    generatedAt: new Date().toISOString(),
    nodes: [],
    edges: []
  };
}

export function graphId(kind: KnowledgeGraphNode["type"], value: string): string {
  const normalized = value.trim().toLowerCase();
  return `${kind}:${encodeURIComponent(normalized || "unknown")}`;
}

export function extractKnowledgeKeywords(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[，。！？、；：“”‘’（）()[\]{}<>《》.,!?;:"'`~·|/\\]/g, " ");
  const terms = new Set<string>();
  for (const token of normalized.split(/\s+/)) {
    const value = token.trim();
    if (value.length >= 2 && !STOP_TERMS.has(value)) terms.add(value);
  }
  for (const match of normalized.matchAll(/[\p{L}\p{N}\p{Script=Han}]{2,}/gu)) {
    const value = match[0].trim();
    if (value.length >= 2 && !STOP_TERMS.has(value)) terms.add(value);
  }
  return Array.from(terms).slice(0, 24);
}

export function splitKnowledgeChunks(entry: VaultIndexEntry, markdown: string): KnowledgeChunk[] {
  const withoutFrontmatter = markdown.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  if (!withoutFrontmatter) return [];

  const sections: Array<{ heading: string; text: string }> = [];
  const lines = withoutFrontmatter.split("\n");
  let currentHeading = entry.title;
  let buffer: string[] = [];

  const flush = (): void => {
    const raw = buffer.join("\n").trim();
    if (raw) {
      sections.push({ heading: currentHeading, text: raw });
    }
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[2].trim() || entry.title;
      continue;
    }
    buffer.push(line);
  }
  flush();

  if (sections.length === 0) {
    sections.push({ heading: entry.title, text: withoutFrontmatter });
  }

  const chunks: KnowledgeChunk[] = [];
  for (const [sectionIndex, section] of sections.entries()) {
    const paragraphs = section.text
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean);
    const pieces = paragraphs.length > 0 ? paragraphs : [section.text.trim()];
    let current = "";
    let partIndex = 0;
    const pushChunk = (textPart: string): void => {
      const trimmed = textPart.trim();
      if (!trimmed) return;
      const heading = section.heading || entry.title;
      const keywords = extractKnowledgeKeywords(`${entry.title}\n${heading}\n${trimmed}`).slice(0, 12);
      chunks.push({
        id: graphId("note", `${entry.path}#${sectionIndex}-${partIndex}`),
        path: entry.path,
        title: entry.title,
        category: entry.category,
        heading,
        order: chunks.length,
        keywords,
        summary: truncateContext(trimmed.replace(/\s+/g, " "), 260),
        text: trimmed,
        mtime: entry.mtime
      });
      partIndex += 1;
    };

    for (const paragraph of pieces) {
      if (!current) {
        current = paragraph;
        continue;
      }
      if ((current.length + paragraph.length) < 1200) {
        current = `${current}\n\n${paragraph}`;
        continue;
      }
      pushChunk(current);
      current = paragraph;
    }
    if (current) {
      pushChunk(current);
    }
  }

  return chunks;
}

export function extractTitle(markdown: string, fallback: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || fallback;
}

export function extractFrontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const item = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (item) {
      frontmatter[item[1]] = item[2].trim();
    }
  }
  return frontmatter;
}

export function extractTags(markdown: string): string[] {
  const tags = new Set<string>();
  const frontmatter = extractFrontmatter(markdown);
  const frontmatterTags = frontmatter.tags;
  if (frontmatterTags) {
    frontmatterTags
      .replace(/^\[|\]$/g, "")
      .split(/[, ]+/)
      .map((tag) => tag.replace(/^#/, "").trim())
      .filter(Boolean)
      .forEach((tag) => tags.add(tag));
  }
  for (const match of markdown.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
    tags.add(match[1]);
  }
  return Array.from(tags).slice(0, 20);
}

export function summarizeMarkdownForIndex(markdown: string): string {
  const withoutFrontmatter = markdown.replace(/^---\n[\s\S]*?\n---/, "");
  const plain = withoutFrontmatter
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, "$2$1")
    .replace(/[#>*_`~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateContext(plain, 520);
}

export function summarizeKnowledgeFile(markdown: string, fallback: string): string {
  const withoutFrontmatter = markdown.replace(/^---\n[\s\S]*?\n---/, "");
  const title = extractTitle(withoutFrontmatter, fallback);
  const plain = withoutFrontmatter
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, "$2$1")
    .replace(/[#>*_`~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateContext(`${title}: ${plain}`, 420);
}

export function summarizeKnowledgeLink(
  topic: KnowledgeTopic,
  entries: Array<{ path: string; text: string; summary: string }>
): string {
  const lines = entries
    .slice(0, 12)
    .map((entry) => `- ${entry.path}: ${entry.summary}`);
  return [
    `${topic.topic}：已按需读取 ${entries.length} 篇笔记，后续遇到相关问题可优先参考这些知识链接。`,
    ...lines
  ].join("\n");
}

export function sanitizeKnowledgeQuery(query: string): string {
  return query
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function extractSearchTerms(query: string): string[] {
  const normalized = query
    .toLowerCase()
    .replace(/[，。！？、；：“”‘’（）()[\]{}<>《》.,!?;:"']/g, " ");
  const terms = new Set<string>();
  for (const token of normalized.split(/\s+/)) {
    const value = token.trim();
    if (value.length >= 2 && !STOP_TERMS.has(value)) terms.add(value);
  }
  for (const match of normalized.matchAll(/[\p{L}\p{N}]{2,}/gu)) {
    const value = match[0].trim();
    if (value.length >= 2 && !STOP_TERMS.has(value)) terms.add(value);
  }
  return Array.from(terms).slice(0, 24);
}

export function inferQueryCategories(query: string): Set<string> {
  const categories = new Set<string>();
  const rules: Array<[RegExp, string[]]> = [
    [/交易|入场|出场|止损|止盈|盈亏|做多|做空|模型|复盘|纪律/, ["trading-reviews", "trading-models"]],
    [/任务|待办|今天|明天|过期|延期|完成|工作|项目|优先级/, ["tasks", "daily", "goals"]],
    [/习惯|打卡|跑步|早睡|学习|惩罚|未完成/, ["habits", "daily"]],
    [/健康|睡眠|体重|步数|运动|疲劳|精力|身体/, ["health", "daily"]],
    [/日记|今天发生|记录|状态|心情|复盘/, ["daily", "journal"]],
    [/目标|长期|今年|计划|规划|方向/, ["goals"]],
    [/灵感|想法|思考|知识|资料|笔记/, ["ideas", "knowledge", "outputs"]],
    [/你记得|我是谁|偏好|规则|画像|当前状态/, []]
  ];
  for (const [pattern, values] of rules) {
    if (pattern.test(query)) values.forEach((value) => categories.add(value));
  }
  return categories;
}

export function scoreIndexEntry(entry: VaultIndexEntry, terms: string[], wantedCategories: Set<string>): RetrievalHit {
  let score = 0;
  const reasons: string[] = [];
  const title = entry.title.toLowerCase();
  const path = entry.path.toLowerCase();
  const summary = entry.summary.toLowerCase();
  const tagText = entry.tags.join(" ").toLowerCase();

  if (wantedCategories.has(entry.category)) {
    score += 5;
    reasons.push(`category:${entry.category}`);
  }
  for (const term of terms) {
    const value = term.toLowerCase();
    if (title.includes(value)) {
      score += 6;
      reasons.push(`title:${term}`);
    }
    if (path.includes(value)) {
      score += 4;
      reasons.push(`path:${term}`);
    }
    if (tagText.includes(value)) {
      score += 3;
      reasons.push(`tag:${term}`);
    }
    if (summary.includes(value)) {
      score += 2;
      reasons.push(`summary:${term}`);
    }
  }

  const ageDays = Math.max(0, (Date.now() - entry.mtime) / (24 * 60 * 60 * 1000));
  // Recency orders actual matches; it cannot make an unrelated file relevant.
  if (score > 0) {
    if (ageDays < 7) score += 1.2;
    else if (ageDays < 30) score += 0.6;
  }

  return {
    entry,
    score,
    reasons: Array.from(new Set(reasons)).slice(0, 10)
  };
}

export const STOP_TERMS = new Set([
  "一下",
  "一个",
  "一些",
  "什么",
  "怎么",
  "如何",
  "帮我",
  "看看",
  "这个",
  "那个",
  "现在",
  "后面",
  "可以",
  "需要",
  "应该",
  "进行",
  "以及",
  "的话",
  "里面"
]);

export function countMatches(text: string, pattern: RegExp): number {
  return Array.from(text.matchAll(pattern)).length;
}

export function summarizeHealth(entry: HealthEntry): string {
  return [
    entry.sleepHours !== undefined ? `睡眠 ${entry.sleepHours}h` : "",
    entry.weightKg !== undefined ? `体重 ${entry.weightKg}kg` : "",
    entry.steps !== undefined ? `步数 ${entry.steps}` : "",
    entry.exercise || "",
    entry.note || ""
  ]
    .filter(Boolean)
    .join("，");
}

export function tradingReviewTemplate(date: string): string {
  return `# ${date}\n\n<span data-type="text" style="background-color: var(--b3-card-error-background); color: var(--b3-card-error-color);">交易：</span>\n\n<span data-type="text" style="background-color: var(--b3-card-success-background); color: var(--b3-card-success-color);">盈亏：</span>\n\n<span data-type="text" style="background-color: var(--b3-card-info-background); color: var(--b3-card-info-color);">收益：</span>\n\n<span data-type="text" style="background-color: var(--b3-card-warning-background); color: var(--b3-card-warning-color);">复盘：</span>\n`;
}

export function insertAfterTradingReview(text: string, content: string): string {
  const marker = "复盘：</span>";
  const index = text.indexOf(marker);
  if (index === -1) return `${text.trimEnd()}\n\n${content.trim()}\n`;
  const insertAt = text.indexOf("\n", index);
  if (insertAt === -1) return `${text}\n\n${content.trim()}\n`;
  return `${text.slice(0, insertAt).trimEnd()}\n\n${content.trim()}\n${text.slice(insertAt).trimStart()}`;
}

export function safeFilename(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|#^\[\]]/g, "").trim();
  return (cleaned || "未命名思考").slice(0, 60);
}

export function formatTaskContextList(tasks: LifeOpsTask[]): string {
  if (tasks.length === 0) return "- (empty)";
  return tasks.map(taskContextLine).join("\n");
}

export function vectorDocumentText(entry: VaultIndexEntry, markdown: string): string {
  return truncateContext([
    `Title: ${entry.title}`,
    `Path: ${entry.path}`,
    `Category: ${entry.category}`,
    `Tags: ${entry.tags.join(", ")}`,
    `Summary: ${entry.summary}`,
    "",
    markdown
  ].join("\n"), 5200);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

export function taskContextLine(task: LifeOpsTask): string {
  const status = task.status === "completed" ? "done" : task.status;
  const date = task.endDate ? `${task.date} -> ${task.endDate}` : task.date || "无日期";
  const due = task.dueDate ? `；截止=${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ""}` : "";
  const repeat = task.repeatUnit !== "none" ? `；重复=${repeatLabel(task)}` : "";
  const note = task.note ? `；备注=${truncateContext(task.note, 120)}` : "";
  return `- ${task.title}（${status}；优先级=${priorityLabel(task.priority)}；象限=${quadrantLabel(task.quadrant)}；日期=${date}${taskScheduleLabel(task) ? `；${taskScheduleLabel(task)}` : ""}；项目=${task.project}；分类=${task.category}${due}${repeat}${note}）`;
}

export function truncateContext(value: string, maxChars: number): string {
  const normalized = value.replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}\n\n...[truncated ${normalized.length - maxChars} chars]`;
}

export function sortTasks(a: LifeOpsTask, b: LifeOpsTask): number {
  const dateCompare = (a.date || "9999-12-31").localeCompare(b.date || "9999-12-31");
  if (dateCompare !== 0) return dateCompare;
  const timeCompare = (a.time || "99:99").localeCompare(b.time || "99:99");
  if (timeCompare !== 0) return timeCompare;
  const orderCompare = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  if (orderCompare !== 0) return orderCompare;
  const priorityWeight: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 };
  return (priorityWeight[a.priority] ?? 3) - (priorityWeight[b.priority] ?? 3);
}

export function nextRepeatedTaskDates(task: LifeOpsTask): { date: string; endDate: string; dueDate: string } {
  const baseDate = task.date || todayString();
  return {
    date: addTaskRepeatDate(baseDate, task.repeatUnit, task.repeatInterval),
    endDate: task.endDate ? addTaskRepeatDate(task.endDate, task.repeatUnit, task.repeatInterval) : "",
    dueDate: task.dueDate ? addTaskRepeatDate(task.dueDate, task.repeatUnit, task.repeatInterval) : ""
  };
}

export function addTaskRepeatDate(date: string, unit: LifeOpsTask["repeatUnit"], interval: number): string {
  if (unit === "month") return addMonths(date, interval);
  return addDays(date, unit === "week" ? interval * 7 : interval);
}

export function addMonths(dateString: string, months: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1 + months, 1);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function taskMarkdownLine(task: LifeOpsTask): string {
  const checkbox = task.status === "completed" ? "[x]" : "[ ]";
  const date = task.endDate ? `${task.date} -> ${task.endDate}` : task.date || "无日期";
  const meta = [
    `状态=${task.status}`,
    `优先级=${priorityLabel(task.priority)}`,
    `象限=${quadrantLabel(task.quadrant)}`,
    `分类=${task.category}`,
    `项目=${task.project}`,
    `日期=${date}`,
    task.time ? `时间=${task.time}` : "",
    task.startTime !== undefined ? `计划开始=${task.startTime}` : "",
    task.endTime !== undefined ? `计划结束=${task.endTime}` : "",
    task.dueDate ? `截止=${task.dueTime ? `${task.dueDate} ${task.dueTime}` : task.dueDate}` : "",
    task.repeatUnit && task.repeatUnit !== "none" ? `重复=${repeatLabel(task)}` : "",
    task.completedAt ? `完成=${task.completedAt}` : ""
  ].filter(Boolean).join(" · ");
  return `- ${checkbox} ${task.title}\n  - ${meta}${task.note ? `\n  - 备注：${task.note}` : ""}`;
}

export function normalizeTasks(tasks: LifeOpsTask[]): LifeOpsTask[] {
  return tasks.map((task, index) => ({
    ...task,
    time: task.time ?? "",
    dueDate: task.dueDate ?? "",
    dueTime: task.dueTime ?? "",
    repeatUnit: task.repeatUnit ?? "none",
    repeatInterval: Math.max(1, task.repeatInterval ?? 1),
    repeatUntil: task.repeatUntil ?? "",
    parentTaskId: task.parentTaskId ?? "",
    completionLog: task.completionLog ?? (task.completedAt ? [{ completedAt: task.completedAt, note: "" }] : []),
    sortOrder: task.sortOrder ?? (Number.isFinite(Date.parse(task.createdAt)) ? Date.parse(task.createdAt) + index : index)
  }));
}

export function repeatLabel(task: LifeOpsTask): string {
  const unit = task.repeatUnit === "day" ? "天" : task.repeatUnit === "week" ? "周" : "月";
  const base = task.repeatInterval > 1 ? `每 ${task.repeatInterval} ${unit}` : `每${unit}`;
  return task.repeatUntil ? `${base}，至 ${task.repeatUntil}` : base;
}

export function priorityLabel(priority: string): string {
  switch (priority) {
    case "high":
      return "高";
    case "medium":
      return "中";
    case "low":
      return "低";
    default:
      return "无";
  }
}

export function quadrantLabel(quadrant: string): string {
  switch (quadrant) {
    case "important-urgent":
      return "重要且紧急";
    case "important-not-urgent":
      return "重要不紧急";
    case "not-important-urgent":
      return "不重要但紧急";
    default:
      return "不重要不紧急";
  }
}

export function habitStatusLabel(status: HabitCheckinStatus): string {
  switch (status) {
    case "done":
      return "完成";
    case "missed":
      return "未完成";
    case "leave":
      return "请假";
  }
}

export function normalizeHabitDefinitions(habits: HabitDefinition[]): HabitDefinition[] {
  const ids = new Set<string>();
  for (const habit of habits) {
    if (!habit || typeof habit.id !== "string" || !habit.id.trim() || ids.has(habit.id)
      || typeof habit.name !== "string" || !habit.name.trim()) throw new Error("习惯记录缺少稳定身份或存在重复，已停止覆盖，请先核对原记录。");
    ids.add(habit.id);
  }
  return habits.map(habit => ({
    ...habit,
    id: habit.id,
    name: habit.name,
    frequencyUnit: habit.frequencyUnit ?? "day",
    frequencyInterval: Math.max(1, habit.frequencyInterval ?? 1),
    targetCount: Math.max(1, habit.targetCount ?? 1),
    startDate: habit.startDate || "",
    penaltyThreshold: habit.penaltyThreshold ?? 3,
    color: habit.color || "#27ae60",
    createdAt: habit.createdAt || "",
    source: habit.source
  }));
}

export function sanitizeVoiceAgentConversationContext(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isKnownBadVoiceAgentTemplate(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isKnownBadVoiceAgentTemplate(line: string): boolean {
  const value = line.trim();
  return /可以创建任务，但我需要更具体的信息/.test(value)
    || /可以，我需要知道要记录的具体内容/.test(value);
}

export function parseProactiveCandidate(line: string): ProactiveCandidate | null {
  try {
    const value = JSON.parse(line) as Partial<ProactiveCandidate>;
    if (!value.id || !value.kind || !value.title || !value.reason || !value.priority || !value.createdAt) return null;
    if (!["low", "normal", "high", "critical"].includes(value.priority)) return null;
    const createdAt = String(value.createdAt);
    return {
      id: String(value.id),
      kind: value.kind as ProactiveCandidate["kind"],
      title: String(value.title),
      reason: String(value.reason),
      priority: value.priority,
      workflowId: value.workflowId,
      createdAt,
      expiresAt: value.expiresAt
        ? String(value.expiresAt)
        : new Date(Date.parse(createdAt) + 24 * 60 * 60_000).toISOString(),
      dedupeKey: value.dedupeKey
        ? String(value.dedupeKey)
        : `${String(value.kind)}:${createdAt.slice(0, 10)}`,
      evidenceRefs: Array.isArray(value.evidenceRefs) ? value.evidenceRefs.map(String) : [],
      confidence: typeof value.confidence === "number" ? value.confidence : 0.5,
      voiceEligible: value.voiceEligible === true,
      channel: value.channel,
      ...(value.steward === true ? { steward: true } : {}),
      ...(typeof value.ideaId === "string" ? { ideaId: value.ideaId } : {}),
      ...(typeof value.summaryPath === "string" ? { summaryPath: value.summaryPath } : {})
    };
  } catch {
    return null;
  }
}

export function habitPeriodProgress(habit: HabitDefinition, checkins: HabitCheckin[], date: string): { done: number; target: number; label: string; unit?: string } {
  if (habit.target?.kind === "number") {
    const periods = numericHabitPeriods(habit);
    const primary = periods.find(goal => goal.period === habit.frequencyUnit) ?? periods[0];
    if (primary) {
      const weekly = primary.period === "week";
      const days = new Set((weekly ? weekDates(date) : [date]).filter(day => day >= habit.startDate && day <= date));
      if (![...days].some(day => isHabitRequiredOn(habit, day))) return { done: 0, target: primary.goal, label: weekly ? "本周" : "今日", unit: habit.target.unit };
      const done = checkins.filter(item => item.habitId === habit.id && days.has(item.date))
        .reduce((sum, item) => sum + habitRecordedAmount(habit, item), 0);
      return { done, target: primary.goal, label: weekly ? "本周" : "今日", unit: habit.target.unit };
    }
  }
  if (habit.frequencyUnit === "week") {
    const days = weekDates(date).filter((day) => day >= habit.startDate && isHabitRequiredOn(habit, day));
    const done = checkins
      .filter((item) => item.habitId === habit.id && days.includes(item.date) && item.status === "done")
      .reduce((sum, item) => sum + Math.max(1, item.count || 1), 0);
    return { done, target: habit.targetCount, label: "本周" };
  }

  const checkin = checkins.find((item) => item.habitId === habit.id && item.date === date && item.status === "done");
  return { done: checkin?.count ?? 0, target: habit.targetCount, label: "今日" };
}

export function weeklyHabitFailures(habit: HabitDefinition, checkins: HabitCheckin[], date: string, requireCoverage = false): number {
  const days = weekDates(date).filter((day) => day >= habit.startDate && isHabitRequiredOn(habit, day));
  if (days.length === 0) return 0;

  const records = checkins.filter(item => item.habitId === habit.id && days.includes(item.date));
  const manualMisses = records.filter(item => item.status === "missed").length;
  if (!isHabitWeekClosed(date) || requireCoverage && days.some(day => !records.some(item => item.date === day))) return manualMisses;

  const done = records
    .filter(item => item.status === "done")
    .reduce((sum, item) => sum + Math.max(1, item.count || 1), 0);
  return Math.max(manualMisses, Math.max(0, habit.targetCount - done));
}

export function isPastHabitDay(date: string): boolean {
  return date < todayString();
}

export function isHabitWeekClosed(date: string): boolean {
  const days = weekDates(date);
  const weekEnd = days[days.length - 1];
  const today = todayString();
  if (weekEnd < today) return true;
  if (weekEnd > today) return false;
  const now = new Date();
  return now.getHours() >= 21;
}

export { isHabitRequiredOn };

export function habitFrequencyLabel(habit: HabitDefinition): string {
  if (habit.frequencyUnit === "week") {
    return habit.frequencyInterval === 1 ? "每周" : `每 ${habit.frequencyInterval} 周`;
  }
  return habit.frequencyInterval === 1 ? "每天" : `每 ${habit.frequencyInterval} 天`;
}
