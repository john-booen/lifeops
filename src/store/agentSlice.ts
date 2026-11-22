import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { contextSourceHash, isContextSourcePath, recordContextSource, type ContextSourceRecorder } from "../sourceReferences";
import { readRecentMarkdownSnapshot, type RecentMarkdownSnapshot } from "../recentContext";
import { activityNotePath } from "../activityRecords";
import { linkedNoteName } from "../linkedNoteSettings";
import { isVaultPathExcluded, isVisualCachePath } from "../privacy";
import { randomUUID } from "node:crypto";
import { guardDerivedMethods } from "../dataFoundation/derivedOperation";
import { readFactOperation } from "../dataFoundation/factOperation";
import { createKnowledgeGraphSource, mergeKnowledgeGraphSources, type KnowledgeGraphContribution } from "../dataFoundation/knowledgeGraph";
import { getUserContext as getAgentUserContext } from "../agentContext";
import { decayAssociations, reinforceCoHits } from "../associations";
import { captureKindLabel } from "../classifier";
import { addDays, datesBetween, todayString, weekDates } from "../date";
import {
  knowledgeResultsToMarkdown,
  type KnowledgeResult
} from "../dataFoundation/knowledgeResult";
import {
  createMemoryCandidate,
  normalizeMemoryEntry,
  promoteMemory,
  recordMemoryRetrieved
} from "../memoryIndex";
import {
  createPersonalMemory,
  emptyPersonalMemoryDocument,
  findMemorySuppression,
  personalMemoriesToMarkdown,
  personalMemoryReviewToMarkdown,
  reviewPersonalMemoryRecord,
  selectPersonalMemories,
  upsertPersonalMemoryRecord,
  type PersonalMemoryDocument,
  type PersonalMemoryInput,
  type PersonalMemoryRecord,
  type PersonalMemoryReview
} from "../personalMemory";
import { createPersonalMemoryContextFilter, createPersonalMemorySourceFilter, formatPersonalMemoryExcerpt, MEMORY_CONTEXT_OMISSION } from "../personalMemoryContext";
import { readPersonalMemoryWithSources } from "../personalMemorySources";
import { serializeQualityLogEntry } from "../qualityLog";
import { serializeVoiceMetricEntry } from "../voiceMetrics";
import type { ProactiveCandidate } from "../scheduler";
import {
  emptyProactivePolicyState,
  serializeProactiveFeedbackAudit,
  type ProactiveFeedbackAuditRecord,
  type ProactivePolicyState
} from "../proactivePolicy";
import { buildSituation, situationToMarkdown } from "../situation";
import { getTimeContext } from "../timeContext";
import { readPersonalMemoryDocument, persistPersonalMemoryDocument } from "../dataFoundation/personalMemoryPersistence";
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
import type { ProviderEgressAuditRecord } from "../privacy";
import * as settingsHelpers from './settingsSlice';
import type { StoreHost, TaskDatabase, HabitDatabase, VaultIndexEntry, VaultIndex, VaultStats, RetrievalHit, KnowledgeLink, KnowledgeLinksDb, VectorIndexEntry, VectorIndex, KnowledgeChunk, KnowledgeChunkIndex, KnowledgeGraph, KnowledgeTopic } from './settingsSlice';
import { contextDataPolicy, readContextTasks, readContextHabits } from "../contextData";
import { isHealthHabitSource } from "../features/health/habitSources";

const {
  insertUnderHeading,
  parentFolder,
  dailyNote,
  dailyTemplate,
  memoryFiles,
  memoryFileNames,
  emptyVaultIndex,
  emptyVectorIndex,
  emptyKnowledgeLinks,
  emptyKnowledgeChunkIndex,
  emptyKnowledgeGraph,
  graphId,
  extractKnowledgeKeywords,
  splitKnowledgeChunks,
  extractTitle,
  extractFrontmatter,
  extractTags,
  summarizeMarkdownForIndex,
  summarizeKnowledgeFile,
  summarizeKnowledgeLink,
  sanitizeKnowledgeQuery,
  extractSearchTerms,
  inferQueryCategories,
  scoreIndexEntry,
  countMatches,
  summarizeHealth,
  tradingReviewTemplate,
  insertAfterTradingReview,
  safeFilename,
  formatTaskContextList,
  vectorDocumentText,
  cosineSimilarity,
  taskContextLine,
  truncateContext,
  sortTasks,
  isTaskOnDate,
  isTaskOverdue,
  nextRepeatedTaskDates,
  addTaskRepeatDate,
  addMonths,
  taskMarkdownLine,
  normalizeTasks,
  repeatLabel,
  priorityLabel,
  quadrantLabel,
  habitStatusLabel,
  normalizeHabitDefinitions,
  sanitizeVoiceAgentConversationContext,
  isKnownBadVoiceAgentTemplate,
  parseProactiveCandidate,
  habitPeriodProgress,
  weeklyHabitFailures,
  isPastHabitDay,
  isHabitWeekClosed,
  isHabitRequiredOn,
  habitFrequencyLabel
} = settingsHelpers;
type StoreConstructor = { prototype: object };
export interface AgentSliceApi {
  appendAgentConversation(userMessage: string, assistantReply: string, date?: string, isCurrent?: () => boolean): Promise<void>;
  appendQualityLog(entry: QualityLogEntry): Promise<void>;
  appendProviderEgressAudit(record: ProviderEgressAuditRecord): Promise<void>;
  appendVoiceMetric(entry: VoiceMetricEntry): Promise<void>;
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
  createRetrievalDebugReport(query: string, sections: { semantic: string; keyword: string; knowledge: string }): Promise<string>;
  buildContext(date?: string): Promise<string>;
  getVaultStats(): VaultStats;
  buildTradingContext(date?: string, record?: ContextSourceRecorder): Promise<string>;
  searchKnowledge(query: string, limit?: number): Promise<KnowledgeResult[]>;
  buildRetrievalContext(query: string, limit?: number, record?: ContextSourceRecorder): Promise<string>;
  buildSemanticContext(queryEmbedding: number[], limit?: number, record?: ContextSourceRecorder): Promise<string>;
  buildKnowledgeContext(query: string, record?: ContextSourceRecorder): Promise<string>;
  buildPersonalMemoryContext(query?: string, options?: { maxChars: number }): Promise<string>;
  buildMemoryContext(query?: string): Promise<string>;
  hasMemoryCoverage(query: string): Promise<boolean>;
  rebuildVaultIndex(): Promise<{ path: string; totalMarkdownFiles: number; indexedFiles: number }>;
  rebuildKnowledgeStructure(index?: VaultIndex): Promise<{ chunks: number; nodes: number; edges: number }>;
  buildKnowledgeGraphContext(query: string, record?: ContextSourceRecorder): Promise<string>;
  rebuildVectorIndex(model: string, embed: (input: string) => Promise<number[]>, assertCurrent?: () => void, onCommitted?: () => void): Promise<{ path: string; indexedFiles: number; reusedFiles: number; generatedFiles: number }>;
}

const conversationWrites = new WeakMap<App["vault"], Promise<void>>();

const agentSlice = {
async appendAgentConversation(this: StoreHost, userMessage: string, assistantReply: string, date: string = todayString(), isCurrent?: () => boolean): Promise<void> {
    const filePath = this.path(this.settings.folders.aiReports, "Conversations", `${date}.md`);
    const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const content = [
        `## ${stamp}`,
        "",
        "### 我",
        userMessage.trim(),
        "",
        "### LifeOps Agent",
        assistantReply.trim(),
        ""
      ].join("\n");
    const vault = this.app.vault;
    const write = (conversationWrites.get(vault) ?? Promise.resolve()).catch(() => undefined)
      .then(() => this.appendFile(filePath, content, isCurrent));
    conversationWrites.set(vault, write);
    try { await write; }
    finally { if (conversationWrites.get(vault) === write) conversationWrites.delete(vault); }
  },

async appendQualityLog(this: StoreHost, entry: QualityLogEntry): Promise<void> {
    await this.appendFile(this.qualityLogPath(), `${serializeQualityLogEntry(entry)}\n`);
  },

async appendProviderEgressAudit(this: StoreHost, record: ProviderEgressAuditRecord): Promise<void> {
    await this.appendFile(this.providerEgressAuditPath(), `${JSON.stringify(record)}\n`);
  },

async appendVoiceMetric(this: StoreHost, entry: VoiceMetricEntry): Promise<void> {
    await this.appendFile(this.voiceMetricsPath(), `${serializeVoiceMetricEntry(entry)}\n`);
  },

async readMemoryIndex(this: StoreHost): Promise<MemoryIndexEntry[]> {
    return (await this.readJson<MemoryIndexEntry[]>(this.memoryIndexPath(), [])).map(normalizeMemoryEntry);
  },

async writeMemoryIndex(this: StoreHost, entries: MemoryIndexEntry[]): Promise<void> {
    await this.writeJson(this.memoryIndexPath(), entries);
  },

async addMemoryCandidate(this: StoreHost, input: MemoryCandidateInput): Promise<MemoryIndexEntry> {
    const entry = createMemoryCandidate(input);
    const entries = (await this.readMemoryIndex()).filter((item) => item.id !== entry.id);
    await this.writeMemoryIndex([...entries, entry]);
    return entry;
  },

async promoteMemoryEntry(this: StoreHost, id: string, tier: MemoryTier = "internalized"): Promise<MemoryIndexEntry | null> {
    const entries = await this.readMemoryIndex();
    const index = entries.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const promoted = promoteMemory(entries[index], tier);
    const next = entries.slice();
    next[index] = promoted;
    await this.writeMemoryIndex(next);
    return promoted;
  },

async recordMemoryRetrieval(this: StoreHost, id: string): Promise<MemoryIndexEntry | null> {
    const entries = await this.readMemoryIndex();
    const index = entries.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const retrieved = recordMemoryRetrieved(entries[index]);
    const next = entries.slice();
    next[index] = retrieved;
    await this.writeMemoryIndex(next);
    return retrieved;
  },

async readPersonalMemories(this: StoreHost): Promise<PersonalMemoryDocument> {
    return readPersonalMemoryDocument(this);
  },

async writePersonalMemories(this: StoreHost, document: PersonalMemoryDocument, isCurrent?: () => boolean): Promise<void> {
    await persistPersonalMemoryDocument(this, document, isCurrent);
  },

async upsertPersonalMemory(this: StoreHost, input: PersonalMemoryInput, isCurrent?: () => boolean): Promise<PersonalMemoryRecord> {
    settingsHelpers.assertCurrentWrite(isCurrent);
    const document = await this.readPersonalMemories();
    settingsHelpers.assertCurrentWrite(isCurrent);
    const incoming = createPersonalMemory(input);
    const suppressed = findMemorySuppression(document.records, incoming.content);
    if (suppressed) return suppressed;
    const records = upsertPersonalMemoryRecord(document.records, incoming);
    await this.writePersonalMemories({ ...document, records }, isCurrent);
    return records.find((record) => record.kind === incoming.kind && record.content === incoming.content) ?? incoming;
  },

async reviewPersonalMemory(
    this: StoreHost,
    id: string,
    review: PersonalMemoryReview
): Promise<PersonalMemoryRecord | null> {
    const document = await this.readPersonalMemories();
    const records = reviewPersonalMemoryRecord(document.records, id, review);
    await this.writePersonalMemories({ ...document, records });
    return records.find((record) => record.id === id) ?? null;
  },

async writePersonalMemoryReview(this: StoreHost): Promise<string> {
    const document = await this.readPersonalMemories();
    return this.writeWorkflowDraft(
      "personal-memory-review",
      personalMemoryReviewToMarkdown(document.records)
    );
  },

async readMemoryAssociations(this: StoreHost): Promise<AssociationEdge[]> {
    return this.readJson<AssociationEdge[]>(this.associationsPath(), []);
  },

async writeMemoryAssociations(this: StoreHost, edges: AssociationEdge[]): Promise<void> {
    await this.writeJson(this.associationsPath(), edges);
  },

async reinforceMemoryAssociations(this: StoreHost, nodeIds: string[], example: string = ""): Promise<AssociationEdge[]> {
    const edges = await this.readMemoryAssociations();
    const next = reinforceCoHits(edges, nodeIds, example);
    await this.writeMemoryAssociations(next);
    return next;
  },

async decayMemoryAssociations(this: StoreHost): Promise<AssociationEdge[]> {
    const next = decayAssociations(await this.readMemoryAssociations());
    await this.writeMemoryAssociations(next);
    return next;
  },

async writeWorkflowDraft(this: StoreHost, fileName: string, markdown: string): Promise<string> {
    const safeName = fileName.replace(/[\\/:*?"<>|]/g, "-").replace(/\.md$/i, "");
    const filePath = this.path(this.settings.folders.aiReports, "Workflows", `${safeName}-${randomUUID()}.md`);
    const normalized = normalizePath(filePath);
    await this.ensureFolder(parentFolder(normalized));
    await this.assertFileWriteAllowed?.(normalized);
    await this.app.vault.create(normalized, `> 自动生成的工作草稿，供你检查和修改；不代表已经完成。\n\n${markdown.trimEnd()}\n`);
    return normalized;
  },

async appendProactiveCandidates(this: StoreHost, candidates: ProactiveCandidate[]): Promise<void> {
    if (candidates.length === 0) return;
    const lines = candidates.map((candidate) => JSON.stringify({
      loggedAt: new Date().toISOString(),
      ...candidate
    })).join("\n");
    await this.appendFile(this.proactiveCandidatesPath(), `${lines}\n`);
  },

async readProactiveCandidates(this: StoreHost, limit: number = 5): Promise<ProactiveCandidate[]> {
    const text = await this.readPath(this.proactiveCandidatesPath());
    if (!text.trim()) return [];
    const candidates: ProactiveCandidate[] = [];
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim();
      if (!value) continue;
      const parsed = parseProactiveCandidate(value);
      if (parsed) candidates.push(parsed);
    }
    return candidates
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit);
  },

async readProactivePolicyState(this: StoreHost): Promise<ProactivePolicyState> {
    const fallback = emptyProactivePolicyState();
    const value = await this.readJson<Partial<ProactivePolicyState>>(this.proactivePolicyPath(), fallback);
    return {
      ...value,
      version: 1,
      deliveries: Array.isArray(value.deliveries) ? value.deliveries : [],
      feedback: Array.isArray(value.feedback) ? value.feedback : [],
      mutedKinds: Array.isArray(value.mutedKinds) ? value.mutedKinds : []
    };
  },

async writeProactivePolicyState(this: StoreHost, state: ProactivePolicyState): Promise<void> {
    await this.writeJson(this.proactivePolicyPath(), state);
  },

async appendProactiveFeedbackAudit(this: StoreHost, record: ProactiveFeedbackAuditRecord): Promise<void> {
    await this.appendFile(this.proactiveFeedbackAuditPath(), serializeProactiveFeedbackAudit(record));
  },

async appendMemoryNote(this: StoreHost, fileName: string, content: string): Promise<void> {
    const safeName = memoryFileNames().includes(fileName) ? fileName : "当前状态.md";
    const stamp = new Date().toISOString();
    await this.appendFile(this.memoryFilePath(safeName), `\n## ${stamp}\n\n${content.trim()}\n`);
  },

async appendKnowledgeNote(this: StoreHost, content: string, date: string = todayString()): Promise<void> {
    const value = content.trim();
    if (!value) {
      throw new Error("知识库内容不能为空");
    }
    const stamp = new Date().toISOString();
    const name = linkedNoteName(this.settings, "knowledge");
    const notePath = this.path(this.settings.folders.ideas, name);
    await this.appendFile(notePath, `\n## ${stamp}\n\n${value}\n`);
    await this.appendActivity("ideas", date, "灵感", `- [[${notePath.slice(0, -3)}|${name.slice(0, -3)}]]`);
  },

async appendTradingModelNote(this: StoreHost, content: string, date: string = todayString()): Promise<void> {
    const value = content.trim();
    if (!value) {
      throw new Error("交易模型内容不能为空");
    }
    const stamp = new Date().toISOString();
    const name = linkedNoteName(this.settings, "trading");
    const notePath = this.path(this.settings.folders.tradingModels, name);
    await this.appendFile(notePath, `\n## ${stamp}\n\n${value}\n`);
    await this.appendActivity("tradingModels", date, "交易学习", `- [[${notePath.slice(0, -3)}|${name.slice(0, -3)}]]`);
  },

async createRetrievalDebugReport(this: StoreHost, query: string, sections: { semantic: string; keyword: string; knowledge: string }): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = this.path(this.settings.folders.aiReports, "Retrieval", `${stamp}.md`);
    const markdown = [
      `# LifeOps 检索调试 ${stamp}`,
      "",
      `- query: ${query}`,
      `- semanticChars: ${sections.semantic.length}`,
      `- keywordChars: ${sections.keyword.length}`,
      `- knowledgeChars: ${sections.knowledge.length}`,
      "",
      "## Semantic Context",
      sections.semantic || "(empty)",
      "",
      "## Keyword Context",
      sections.keyword || "(empty)",
      "",
      "## Knowledge Context",
      sections.knowledge || "(empty)",
      ""
    ].join("\n");
    await this.writeFile(reportPath, markdown);
    return reportPath;
  },

async buildContext(this: StoreHost, date: string = todayString()): Promise<string> {
    const [
      daily,
      recentDaily,
      vaultStats,
      vaultUserContext,
      taskContext,
      habitContext,
      health,
      recentHealth,
      trades,
      recentTrades,
      tradingModels,
      goals,
      recentIdeas,
      recentOutputs,
      indexSummary,
      conversations,
      memory,
      punishments
    ] = await Promise.all([
      this.readDailyPair(date),
      this.buildRecentDailyContext(date),
      this.buildVaultStatsContext(),
      getAgentUserContext({
        adapter: settingsHelpers.createStoreVaultAdapter(this, { forContext: true }),
        folders: this.settings.folders,
        date,
        recentDays: 3
      }).then((context) => context.markdown).catch(() => "资料库基础记录暂时无法核对；任务记录未提供时不能当成零项。"),
      this.buildTaskContext(date),
      this.buildHabitContext(date),
      this.readPath(this.path(this.settings.folders.health, `${date}.md`)),
      this.readRecentMarkdownContext(this.settings.folders.health, 5, 900),
      this.readPath(this.tradingReviewPath(date)),
      this.readRecentMarkdownContext(this.tradingMonthFolder(date), 5, 1200),
      this.readRecentMarkdownContext(this.settings.folders.tradingModels, 8, 1200),
      this.readRecentMarkdownContext(this.settings.folders.goals, 8, 1200),
      this.readRecentMarkdownContext(this.settings.folders.ideas, 5, 900),
      this.readRecentMarkdownContext(this.settings.folders.outputs, 5, 900),
      this.buildIndexSummaryContext(),
      this.readRecentMarkdownContext(this.path(this.settings.folders.aiReports, "Conversations"), 3, 1200),
      this.buildMemoryContext(),
      this.readPath(this.path(this.settings.folders.habits, "Punishments.md"))
    ]);

    return [
      `# LifeOps Context ${date}`,
      "## Context Policy",
      [
        "- You are reading an expanded LifeOps context bundle from the user's Obsidian vault.",
        "- This bundle is not the full vault index yet; when information is missing, say what is missing instead of claiming you cannot access Obsidian at all.",
        "- Prefer concrete actions grounded in the provided tasks, habits, daily notes, trading notes, health notes, goals, conversations, and memory files."
      ].join("\n"),
      "## Daily",
      daily || "(empty)",
      "## Recent Daily Notes",
      recentDaily || "(empty)",
      "## Vault Facts",
      vaultStats || "(empty)",
      "## Vault Data Base",
      vaultUserContext ? truncateContext(vaultUserContext, 9000) : "(empty)",
      "## Tasks",
      taskContext || "(empty)",
      "## Habits",
      habitContext || "(empty)",
      "## Health",
      health || "(empty)",
      "## Recent Health Notes",
      recentHealth || "(empty)",
      "## Trades",
      trades || "(empty)",
      "## Recent Trading Reviews",
      recentTrades || "(empty)",
      "## Trading Models",
      tradingModels || "(empty)",
      "## Goals",
      goals || "(empty)",
      "## Recent Ideas",
      recentIdeas || "(empty)",
      "## Recent Outputs",
      recentOutputs || "(empty)",
      "## Vault Index Summary",
      indexSummary || "(empty; rebuild the LifeOps vault index first)",
      "## Recent Agent Conversations",
      conversations || "(empty)",
      "## Long-term Memory",
      memory || "(empty)",
      "## Accountability Reviews",
      punishments || "(empty)"
    ].join("\n\n");
  },

getVaultStats(this: StoreHost): VaultStats {
    const markdownFiles = this.app.vault.getMarkdownFiles();
    const stats: VaultStats = {
      totalMarkdownFiles: markdownFiles.length,
      dailyNotes: 0,
      journalNotes: 0,
      tradingReviews: 0,
      healthNotes: 0,
      taskFiles: 0,
      habitFiles: 0,
      memoryFiles: 0
    };

    for (const file of markdownFiles) {
      const category = this.classifyIndexCategory(file.path);
      if (category === "daily") stats.dailyNotes += 1;
      if (category === "journal") stats.journalNotes += 1;
      if (category === "trading-reviews") stats.tradingReviews += 1;
      if (category === "health") stats.healthNotes += 1;
      if (category === "tasks") stats.taskFiles += 1;
      if (category === "habits") stats.habitFiles += 1;
      if (category === "agent-memory") stats.memoryFiles += 1;
    }

    return stats;
  },

async buildTradingContext(this: StoreHost, date: string = todayString(), record?: ContextSourceRecorder): Promise<string> {
    const models = await this.readFolder(this.settings.folders.tradingModels,
      (path, fragment, sourceHash) => recordContextSource(record, path, fragment, sourceHash));
    const reviewPath = this.tradingReviewPath(date);
    const readProtectedSource = await protectedSourceReader(this);
    const review = await readProtectedSource(reviewPath);
    const trades = review?.text ?? "";
    if (trades.trim()) recordContextSource(record, reviewPath, `## Trades\n\n${trades}`, review!.sourceHash);
    const {tradingDocumentPath}=await import("../dataFoundation/tradingPersistence");
    const structured=this.getFile(tradingDocumentPath(this))&&!isVaultPathExcluded(tradingDocumentPath(this),this.settings.privacy?.excludedVaultPrefixes)
      ?await (await import("../tradingTools")).buildTradingResearchContext(this):"";
    return [`# Trading Context ${date}`, "## Models", models || "(empty)", "## Trades", trades || "(empty)",structured].filter(Boolean).join("\n\n");
  },

async searchKnowledge(this: StoreHost, query: string, limit: number = 8): Promise<KnowledgeResult[]> {
    for(let attempt=0;attempt<2;attempt++){
    const read=await readFactOperation(this,async()=>{
    const index=await this.readJson<VaultIndex>(this.vaultIndexPath(),emptyVaultIndex());
    if(!isVaultIndexFresh(this,index))return {results:undefined};
    if (index.indexedFiles === 0) return {results:[] as KnowledgeResult[]};

    const terms = extractSearchTerms(query);
    const wantedCategories = inferQueryCategories(query);
    const hits = index.entries
      .filter((entry) => this.isManagedSourcePath(entry.path))
      .filter((entry) => !entry.path.startsWith(`${this.settings.folders.aiReports}/`))
      .map((entry) => scoreIndexEntry(entry, terms, wantedCategories))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.mtime - a.entry.mtime)
      .slice(0, limit);

    const manifest = await this.readSourceManifest();
    const chunkIndex = await this.readJson<KnowledgeChunkIndex>(this.chunkIndexPath(), emptyKnowledgeChunkIndex());
    const chunkHits = chunkIndex.chunks
      .filter((chunk) => this.isManagedSourcePath(chunk.path))
      .filter((chunk) => !chunk.path.startsWith(`${this.settings.folders.aiReports}/`))
      .map((chunk) => ({ chunk, score: scoreKnowledgeChunk(chunk, terms, wantedCategories) }))
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score || right.chunk.mtime - left.chunk.mtime)
      .slice(0, limit);

    if (chunkHits.length > 0) {
      return {results:chunkHits.map(({ chunk, score }) => {
        const source = manifest.entries.find((entry) => entry.path === chunk.path && entry.status === "active");
        return {
          sourceId: source?.sourceId ?? `vault:${chunk.path}`,
          path: chunk.path,
          title: chunk.title,
          category: chunk.category,
          excerpt: [`# ${chunk.heading}`, "", truncateContext(chunk.text, 1800)].join("\n"),
          mtime: chunk.mtime,
          score,
          reasons: [`chunk:${chunk.heading}`],
          contentHash: source?.contentHash
        };
      })};
    }

    if (hits.length === 0) return {results:[] as KnowledgeResult[]};
    const results: KnowledgeResult[] = [];
    for (const hit of hits) {
      const file = this.getFile(hit.entry.path);
      if (!file) continue;
      const text = await this.app.vault.cachedRead(file);
      const source = manifest.entries.find((entry) => entry.path === hit.entry.path && entry.status === "active");
      results.push({
        sourceId: source?.sourceId ?? `vault:${hit.entry.path}`,
        path: hit.entry.path,
        title: hit.entry.title,
        category: hit.entry.category,
        excerpt: truncateContext(text, 1800),
        mtime: hit.entry.mtime,
        score: hit.score,
        reasons: hit.reasons,
        contentHash: source?.contentHash
      });
    }

    return {results};
    });
    if(read.results!==undefined)return read.results;
    if(attempt===0)await this.syncVaultSources();
    }
    throw Error("知识来源在读取期间继续变化，请重新查询。");
  },

async buildRetrievalContext(this: StoreHost, query: string, limit: number = 8, record?: ContextSourceRecorder): Promise<string> {
    const results = await this.searchKnowledge(query, limit);
    if (results.length === 0) return "";
    const readProtectedSource = await protectedSourceReader(this);
    const available = new Map<string, string>();
    // Search results can already contain a clipped chunk. If suppression changes
    // its source, rebuild its display from protected raw text, never that fragment.
    const protectedResults = await Promise.all(results.map(async result => {
      const source = await readProtectedSource(result.path);
      if (!source) return { ...result, title: "来源不可用", excerpt: MEMORY_CONTEXT_OMISSION, reasons: ["source-unavailable"] };
      available.set(result.path, source.sourceHash);
      if (!source.changed && source.mtime === result.mtime) return result;
      return { ...result, title: source.title, excerpt: truncateContext(source.text, 1800),
        reasons: ["protected-current-source"] };
    }));
    for (const result of protectedResults) {
      if (available.has(result.path)) recordContextSource(record, result.path, knowledgeResultsToMarkdown([result]), available.get(result.path));
    }
    return knowledgeResultsToMarkdown(protectedResults);
  },

async buildSemanticContext(this: StoreHost, queryEmbedding: number[], limit: number = 5, record?: ContextSourceRecorder): Promise<string> {
    if (queryEmbedding.length === 0) return "";
    const index = await this.readJson<VectorIndex>(this.vectorIndexPath(), emptyVectorIndex());
    if (index.entries.length === 0) return "";

    const hits = index.entries
      .filter((entry) => this.isManagedSourcePath(entry.path))
      .map((entry) => ({ entry, score: cosineSimilarity(queryEmbedding, entry.embedding) }))
      .filter((hit) => Number.isFinite(hit.score) && hit.score > 0.2)
      .sort((a, b) => b.score - a.score || b.entry.mtime - a.entry.mtime)
      .slice(0, limit);
    if (hits.length === 0) return "";

    const chunks: string[] = [];
    const readProtectedSource = await protectedSourceReader(this);
    for (const hit of hits) {
      const source = await readProtectedSource(hit.entry.path);
      if (!source) continue;
      const fragment = [
        `### ${hit.entry.path}`,
        `- title: ${source.title}`,
        `- category: ${hit.entry.category}`,
        `- semanticScore: ${hit.score.toFixed(3)}`,
        "",
        truncateContext(source.text, 1800)
      ].join("\n");
      chunks.push(fragment);
      recordContextSource(record, hit.entry.path, fragment, source.sourceHash);
    }

    return chunks.length > 0 ? ["## Semantic Vault Notes", chunks.join("\n\n")].join("\n\n") : "";
  },

async buildKnowledgeContext(this: StoreHost, query: string, record?: ContextSourceRecorder): Promise<string> {
    const topics = this.matchKnowledgeTopics(query);
    const graphContext = await this.buildKnowledgeGraphContext(query, record);
    if (topics.length === 0) return graphContext;

    const chunks: string[] = [];
    if (graphContext) chunks.push(graphContext);
    for (const topic of topics) {
      const context = await this.buildKnowledgeTopicContext(topic, query, record);
      if (context) chunks.push(context);
    }
    return chunks.join("\n\n");
  },

async rebuildVaultIndex(this: StoreHost): Promise<{ path: string; totalMarkdownFiles: number; indexedFiles: number }> {
    const indexPath = this.vaultIndexPath();
    const vectorPath = this.vectorIndexPath();
    const markdownFiles = this.app.vault.getMarkdownFiles()
      .filter((file) => this.isManagedSourcePath(file.path))
      .filter((file) => file.path !== indexPath)
      .filter((file) => file.path !== vectorPath)
      // AI reports contain past model output, audit logs and transient context.
      // Indexing them as user facts makes the assistant cite itself.
      .filter((file) => !file.path.startsWith(`${this.settings.folders.aiReports}/`))
      .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
    const entries: VaultIndexEntry[] = [];

    for (const file of markdownFiles) {
      const text = await this.app.vault.cachedRead(file);
      entries.push({
        path: file.path,
        title: extractTitle(text, file.basename),
        category: this.classifyIndexCategory(file.path),
        tags: extractTags(text),
        frontmatter: extractFrontmatter(text),
        mtime: file.stat.mtime,
        size: file.stat.size,
        summary: summarizeMarkdownForIndex(text)
      });
    }

    const index: VaultIndex = {
      generatedAt: new Date().toISOString(),
      vaultName: this.app.vault.getName(),
      totalMarkdownFiles: markdownFiles.length,
      indexedFiles: entries.length,
      entries
    };

    await this.writeJson(indexPath, index);
    await this.rebuildKnowledgeStructure(index);
    return {
      path: indexPath,
      totalMarkdownFiles: markdownFiles.length,
      indexedFiles: entries.length
    };
  },

async rebuildKnowledgeStructure(this: StoreHost, index?: VaultIndex): Promise<{ chunks: number; nodes: number; edges: number }> {
    const vaultIndex = index ?? await this.readJson<VaultIndex>(this.vaultIndexPath(), emptyVaultIndex());
    const chunks: KnowledgeChunk[] = [];
    const sources: KnowledgeGraphContribution[] = [];
    for (const entry of vaultIndex.entries) {
      if (!this.isManagedSourcePath(entry.path)) continue;
      const file = this.getFile(entry.path);
      if (!file) continue;
      const text = await this.app.vault.cachedRead(file);
      const sourceChunks = splitKnowledgeChunks(entry, text);
      chunks.push(...sourceChunks);
      sources.push(createKnowledgeGraphSource(entry, text, sourceChunks));
    }
    const graph = mergeKnowledgeGraphSources(sources);
    await this.writeJson(this.chunkIndexPath(), {
      generatedAt: new Date().toISOString(),
      chunks
    });
    await this.writeJson(this.knowledgeGraphPath(), graph);
    return { chunks: chunks.length, nodes: graph.nodes.length, edges: graph.edges.length };
  },

async buildKnowledgeGraphContext(this: StoreHost, query: string, record?: ContextSourceRecorder): Promise<string> {
    const terms = extractKnowledgeKeywords(query);
    if (terms.length === 0) return "";
    const [chunkIndex, graph] = await Promise.all([
      this.readJson<KnowledgeChunkIndex>(this.chunkIndexPath(), emptyKnowledgeChunkIndex()),
      this.readJson<KnowledgeGraph>(this.knowledgeGraphPath(), emptyKnowledgeGraph())
    ]);
    if (chunkIndex.chunks.length === 0 && graph.nodes.length === 0) return "";

    const conceptTerms = new Set(terms);
    const conceptNodes = graph.nodes
      .filter((node) => node.type === "concept" && conceptTerms.has(node.label))
      .slice(0, 12);
    const linkedNoteIds = new Set(
      graph.edges
        .filter((edge) => conceptNodes.some((node) => node.id === edge.target || node.id === edge.source))
        .map((edge) => edge.source.startsWith("note:") ? edge.source : edge.target)
        .filter((id) => id.startsWith("note:"))
    );
    const chunkHits = chunkIndex.chunks
      .filter((chunk) => this.isManagedSourcePath(chunk.path))
      .map((chunk) => ({
        chunk,
        score: chunk.keywords.filter((keyword) => conceptTerms.has(keyword)).length + (linkedNoteIds.has(graphId("note", chunk.path)) ? 1 : 0)
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || b.chunk.mtime - a.chunk.mtime)
      .slice(0, 6);
    if (chunkHits.length === 0 && conceptNodes.length === 0) return "";
    const readProtectedSource = await protectedSourceReader(this);
    const protectedHits = await Promise.all(chunkHits.map(async hit => {
      const source = await readProtectedSource(hit.chunk.path);
      if (!source) return null;
      if (!source.changed && source.mtime === hit.chunk.mtime) return { ...hit, sourceHash: source.sourceHash };
      // summary/heading/keywords are derived from old text and may contain only
      // a prefix of a forgotten sentence. Regenerate together from the safe source.
      return { ...hit, sourceHash: source.sourceHash, chunk: { ...hit.chunk, title: source.title, heading: source.title,
        text: source.text, summary: truncateContext(source.text.replace(/\s+/g, " "), 260),
        keywords: extractKnowledgeKeywords(source.text), mtime: source.mtime } };
    }));
    const currentHits = protectedHits.filter((hit): hit is NonNullable<typeof hit> => hit !== null);

    return [
      "## Knowledge Graph Context",
      conceptNodes.length > 0 ? `- matchedConcepts: ${conceptNodes.map((node) => node.label).join(", ")}` : "",
      currentHits.length > 0 ? "### Related Chunks" : "",
      currentHits.map((hit) => {
        const fragment = [
        `#### ${hit.chunk.path}${hit.chunk.heading ? ` / ${hit.chunk.heading}` : ""}`,
        `- category: ${hit.chunk.category}`,
        `- keywords: ${hit.chunk.keywords.slice(0, 8).join(", ")}`,
        `- summary: ${hit.chunk.summary}`,
        "",
        truncateContext(hit.chunk.text, 900)
        ].join("\n");
        recordContextSource(record, hit.chunk.path, fragment, hit.sourceHash);
        return fragment;
      }).join("\n\n")
    ].filter(Boolean).join("\n");
  },

async rebuildVectorIndex(this: StoreHost,
    model: string,
    embed: (input: string) => Promise<number[]>,
    assertCurrent: () => void = () => undefined
  ): Promise<{ path: string; indexedFiles: number; reusedFiles: number; generatedFiles: number }> {
    assertCurrent();
    const vaultIndex = await this.readJson<VaultIndex>(this.vaultIndexPath(), emptyVaultIndex());
    const previous = await this.readJson<VectorIndex>(this.vectorIndexPath(), emptyVectorIndex());
    const canReuse = previous.model === model;
    const previousByPath = new Map(previous.entries.map((entry) => [entry.path, entry]));
    const entries: VectorIndexEntry[] = [];
    let reusedFiles = 0;
    let generatedFiles = 0;

    for (const entry of vaultIndex.entries) {
      assertCurrent();
      if (!this.isManagedSourcePath(entry.path)) continue;
      const cached = previousByPath.get(entry.path);
      if (canReuse && cached && cached.mtime === entry.mtime && cached.embedding.length > 0) {
        entries.push(cached);
        reusedFiles += 1;
        continue;
      }

      const file = this.getFile(entry.path);
      if (!file) continue;
      const text = await this.app.vault.cachedRead(file);
      const embedding = await embed(vectorDocumentText(entry, text));
      assertCurrent();
      if (embedding.length === 0) continue;
      entries.push({
        path: entry.path,
        title: entry.title,
        category: entry.category,
        mtime: entry.mtime,
        summary: entry.summary,
        embedding
      });
      generatedFiles += 1;
    }

    assertCurrent();
    await this.writeJson(this.vectorIndexPath(), {
      generatedAt: new Date().toISOString(),
      model,
      entries
    });

    // Throw inside the existing derived transaction so a cancelled in-flight
    // write rolls back before a newer same-Vault rebuild can commit.
    assertCurrent();
    return {
      path: this.vectorIndexPath(),
      indexedFiles: entries.length,
      reusedFiles,
      generatedFiles
    };
  },

classifyIndexCategory(this: StoreHost, filePath: string): string {
    const path = normalizePath(filePath);
    const mappings: Array<[string, string]> = [
      [this.settings.folders.dailyRoot, "daily"],
      [this.settings.folders.inbox, "inbox"],
      [this.settings.gateway.inboxFile, "gateway-inbox"],
      [this.settings.folders.tasks, "tasks"],
      [this.settings.folders.habits, "habits"],
      [this.settings.folders.tradingModels, "trading-models"],
      [this.settings.folders.tradingReviews, "trading-reviews"],
      [this.settings.folders.health, "health"],
      [this.path(this.settings.folders.aiReports, "Memory"), "agent-memory"],
      [this.path(this.settings.folders.aiReports, "Conversations"), "agent-conversations"],
      [this.settings.folders.aiReports, "ai-reports"],
      [this.settings.folders.goals, "goals"],
      [this.settings.folders.outputs, "outputs"],
      [this.settings.folders.ideas, "ideas"]
    ];

    for (const [prefix, category] of mappings) {
      const normalizedPrefix = normalizePath(prefix);
      if (path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`)) return category;
    }
    if (path.startsWith("LifeOps/Knowledge/")) return "knowledge";
    if (path.startsWith("日记/")) return "journal";
    return "other";
  },

matchKnowledgeTopics(this: StoreHost, query: string): KnowledgeTopic[] {
    const topics: KnowledgeTopic[] = [
      {
        topic: "交易复盘",
        description: "用户历史交易复盘记录，包括交易次数、盈亏、收益、进场错误和反思。",
        folder: this.settings.folders.tradingReviews,
        keywords: ["交易复盘", "交易记录", "交易问题", "交易错误", "盈亏", "止损", "止盈", "入场", "出场", "实盘"],
        maxFiles: 20,
        maxCharsPerFile: 3200
      },
      {
        topic: "交易模型",
        description: "用户储备的交易模型、策略和交易学习资料。",
        folder: this.settings.folders.tradingModels,
        keywords: ["交易模型", "交易策略", "模型", "pinbar", "流动性", "假突破", "诱导", "EPC"],
        maxFiles: 12,
        maxCharsPerFile: 2600
      },
      {
        topic: "目标规划",
        description: "用户的年度目标、阶段目标和规划资料。",
        folder: this.settings.folders.goals,
        keywords: ["目标", "规划", "年度目标", "长期目标", "今年", "计划"],
        maxFiles: 12,
        maxCharsPerFile: 2200
      },
      {
        topic: "剧本创作",
        description: "用户的剧本创作资料和故事设定。",
        folder: "LifeOps/Knowledge/Writing",
        keywords: ["剧本", "创作", "人物", "剧情", "故事", "章节"],
        maxFiles: 14,
        maxCharsPerFile: 2200
      },
      {
        topic: "个人知识库",
        description: "用户个人知识库里的长期知识笔记。",
        folder: this.settings.folders.ideas.split("/").slice(0, -1).join("/") || this.settings.folders.ideas,
        keywords: ["知识库", "笔记", "资料", "知识点", "学习资料", "储备"],
        maxFiles: 12,
        maxCharsPerFile: 2200
      }
    ];

    return topics.filter((topic) => topic.keywords.some((keyword) => query.includes(keyword))).slice(0, 2);
  },

async buildKnowledgeTopicContext(this: StoreHost, topic: KnowledgeTopic, query = "", record?: ContextSourceRecorder): Promise<string> {
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(topic.folder));
    if (!(folder instanceof TFolder)) return "";
    const files = this.collectMarkdownFiles(folder, 6)
      .filter((file) => this.isManagedSourcePath(file.path))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, topic.maxFiles);
    if (files.length === 0) return "";

    const entries: Array<{ path: string; text: string; summary: string; sourceHash: string }> = [];
    const readProtectedSource = await protectedSourceReader(this);
    for (const file of files) {
      const source = await readProtectedSource(file.path);
      if (!source) continue;
      const text = source.text;
      if (!text.trim()) continue;
      entries.push({
        path: file.path,
        text,
        sourceHash: source.sourceHash,
        summary: summarizeKnowledgeFile(text, file.basename)
      });
    }
    if (entries.length === 0) return "";

    await this.upsertKnowledgeLink({
      topic: topic.topic,
      description: topic.description,
      keywords: topic.keywords,
      paths: entries.map((entry) => entry.path),
      updatedAt: new Date().toISOString(),
      summary: summarizeKnowledgeLink(topic, entries)
    }, query);

    return [
      `## ${topic.topic}`,
      `- description: ${topic.description}`,
      `- sourceFolder: ${topic.folder}`,
      `- filesRead: ${entries.length}`,
      "",
      "### Knowledge Link Summary",
      summarizeKnowledgeLink(topic, entries),
      "",
      "### Source Notes",
      entries.map((entry) => {
        const fragment = [
        `#### ${entry.path}`,
        `- summary: ${entry.summary}`,
        "",
        truncateContext(entry.text, topic.maxCharsPerFile)
        ].join("\n");
        recordContextSource(record, entry.path, fragment, entry.sourceHash);
        return fragment;
      }).join("\n\n")
    ].join("\n");
  },

async upsertKnowledgeLink(this: StoreHost, link: KnowledgeLink, query = ""): Promise<void> {
    const db = await this.readJson<KnowledgeLinksDb>(this.knowledgeLinksPath(), emptyKnowledgeLinks());
    const existing = db.links.find((item) => item.topic === link.topic);
    const queries = [
      [sanitizeKnowledgeQuery(query)],
      link.recentQueries ?? [],
      existing?.recentQueries ?? []
    ].flat().filter(Boolean);
    const links = db.links.filter((item) => item.topic !== link.topic);
    links.push({
      ...link,
      accessCount: (existing?.accessCount ?? 0) + 1,
      recentQueries: Array.from(new Set(queries)).slice(0, 12)
    });
    links.sort((a, b) => a.topic.localeCompare(b.topic, "zh-CN"));
    await this.writeJson(this.knowledgeLinksPath(), {
      updatedAt: new Date().toISOString(),
      links
    });
  },

async ensureMemoryFiles(this: StoreHost): Promise<void> {
    await this.ensureFile(
      this.personalMemoryPath(),
      JSON.stringify(emptyPersonalMemoryDocument(), null, 2)
    );
    for (const file of memoryFiles()) {
      await this.ensureFile(this.memoryFilePath(file.name), file.content);
    }
    await this.ensureAgentPersonaRules();
  },

async ensureAgentPersonaRules(this: StoreHost): Promise<void> {
    const template = memoryFiles().find(file => file.name === "管家规则.md")!;
    // Compatibility entry point: startup creates missing structure, never edits user rules.
    await this.ensureFile(this.memoryFilePath(template.name), template.content);
  },

async buildPersonalMemoryContext(this: StoreHost, query: string = "", options?: { maxChars: number }): Promise<string> {
    const records = (await readPersonalMemoryWithSources(this)).records;
    if (options) return formatPersonalMemoryExcerpt(records, query, options.maxChars);
    const personal = selectPersonalMemories(records, query, 12);
    return personalMemoriesToMarkdown(personal, "verified");
  },

async buildMemoryContext(this: StoreHost, query: string = ""): Promise<string> {
    // Compatibility callers (voice, Companion, expanded context) use the same authority.
    return this.buildPersonalMemoryContext(query);
  },

async hasMemoryCoverage(this: StoreHost, _query: string): Promise<boolean> {
    // Personal memory cannot establish coverage of a user's original sources.
    return false;
  },

async buildIndexSummaryContext(this: StoreHost): Promise<string> {
    const index = await this.readJson<VaultIndex>(this.vaultIndexPath(), emptyVaultIndex());
    if (index.indexedFiles === 0) return "";
    const categories = index.entries.reduce<Record<string, number>>((counts, entry) => {
      counts[entry.category] = (counts[entry.category] ?? 0) + 1;
      return counts;
    }, {});
    const categoryLines = Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => `- ${category}: ${count}`)
      .join("\n");
    const recent = index.entries
      .slice()
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 12)
      .map((entry) => `- ${entry.path}（${entry.category}；${new Date(entry.mtime).toISOString()}）`)
      .join("\n");

    return [
      `- generatedAt: ${index.generatedAt}`,
      `- totalMarkdownFiles: ${index.totalMarkdownFiles}`,
      `- indexedFiles: ${index.indexedFiles}`,
      "",
      "### Categories",
      categoryLines || "- (empty)",
      "",
      "### Recently Updated",
      recent || "- (empty)"
    ].join("\n");
  },

buildVaultStatsContext(this: StoreHost): string {
    const stats = this.getVaultStats();
    return [
      `- totalMarkdownFiles: ${stats.totalMarkdownFiles}`,
      `- dailyNotes: ${stats.dailyNotes}`,
      `- journalNotes: ${stats.journalNotes}`,
      `- tradingReviews: ${stats.tradingReviews}`,
      `- healthNotes: ${stats.healthNotes}`,
      `- taskFiles: ${stats.taskFiles}`,
      `- habitFiles: ${stats.habitFiles}`,
      `- memoryFiles: ${stats.memoryFiles}`
    ].join("\n");
  },

memoryFilePath(this: StoreHost, name: string): string {
    return this.path(this.settings.folders.aiReports, "Memory", name);
  },

async buildRecentDailyContext(this: StoreHost, date: string): Promise<string> {
    const days = Array.from({ length: 6 }, (_, index) => addDays(date, index - 6));
    const chunks: string[] = [];
    const protectContext = createPersonalMemoryContextFilter((await readPersonalMemoryWithSources(this)).records);
    for (const day of days) {
      const daily = protectContext(await this.readDailyPair(day));
      if (daily.trim()) {
        chunks.push(`### ${day}\n\n${truncateContext(daily, 1200)}`);
      }
    }
    return chunks.join("\n\n");
  },

async buildTaskContext(this: StoreHost, date: string): Promise<string> {
    return (await readTaskContextWithEvidence(this,date)).text;
  },

async buildHabitContext(this: StoreHost, date: string): Promise<string> {
    return (await readHabitContextWithEvidence(this,date)).text;
  },

async readRecentMarkdownContext(this: StoreHost, folderPath: string, limit: number, maxCharsPerFile: number,
  onRead?: (snapshot: RecentMarkdownSnapshot) => void): Promise<string> {
    const snapshot = await readRecentMarkdownSnapshot(this, folderPath, limit, maxCharsPerFile);
    try { onRead?.(snapshot); } catch { /* In-memory diagnostics never retry a read. */ }
    return snapshot.text;
  },

collectMarkdownFiles(this: StoreHost, folder: TFolder, depth: number): TFile[] {
    const files: TFile[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") {
        files.push(child);
      }
      if (child instanceof TFolder && depth > 0) {
        files.push(...this.collectMarkdownFiles(child, depth - 1));
      }
    }
    return files;
  },

async countMarkdownFiles(this: StoreHost, folderPath: string): Promise<number> {
    return (await this.recentMarkdownFiles(folderPath, Number.MAX_SAFE_INTEGER)).length;
  },

async countMonthlyTradingReviews(this: StoreHost, date: string): Promise<number> {
    return this.countMarkdownFiles(this.tradingMonthFolder(date));
  },

async recentMarkdownFiles(this: StoreHost, folderPath: string, limit: number): Promise<string[]> {
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(folderPath));
    if (!(folder instanceof TFolder)) return [];
    return folder.children
      .filter((child): child is TFile => child instanceof TFile && child.extension === "md")
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, limit)
      .map((file) => file.path.replace(/\.md$/, ""));
  }
};

/** One authority snapshot and one full-source read/filter per path in a build. */
async function protectedSourceReader(store: StoreHost): Promise<(path: string) => Promise<{ text: string; title: string; changed: boolean; mtime: number; sourceHash: string } | null>> {
  const protectContext = createPersonalMemorySourceFilter((await readPersonalMemoryWithSources(store)).records, store);
  const cache = new Map<string, Promise<{ text: string; title: string; changed: boolean; mtime: number; sourceHash: string } | null>>();
  return path => {
    let pending = cache.get(path);
    if (!pending) {
      pending = (async () => {
        if (!isContextSourcePath(path) || !store.isManagedSourcePath(path)) return null;
        const file = store.getFile(path);
        if (!file || file.path !== path) return null;
        const raw = await store.app.vault.cachedRead(file);
        const text = protectContext(path, raw);
        return { text, title: extractTitle(text, file.basename), changed: text !== raw, mtime: file.stat.mtime, sourceHash: contextSourceHash(raw) };
      })();
      cache.set(path, pending);
    }
    return pending;
  };
}

function scoreKnowledgeChunk(chunk: KnowledgeChunk, terms: string[], wantedCategories: Set<string>): number {
  const searchable = `${chunk.title} ${chunk.heading} ${chunk.keywords.join(" ")} ${chunk.text}`.toLowerCase();
  let score = wantedCategories.has(chunk.category) ? 5 : 0;
  for (const term of terms) {
    const value = term.toLowerCase();
    if (chunk.heading.toLowerCase().includes(value)) score += 7;
    if (chunk.title.toLowerCase().includes(value)) score += 5;
    if (searchable.includes(value)) score += 2;
  }
  return score;
}

function isVaultIndexFresh(store: StoreHost, index: VaultIndex): boolean {
  const ignoredRoot = normalizePath(store.settings.folders.aiReports);
  const isRelevant = (path: string): boolean => {
    const normalized = normalizePath(path);
    return normalized !== ignoredRoot
      && !normalized.startsWith(`${ignoredRoot}/`)
      && store.isManagedSourcePath(normalized);
  };
  const currentFiles = store.app.vault.getMarkdownFiles().filter((file) => isRelevant(file.path));
  const indexedEntries = index.entries.filter((entry) => isRelevant(entry.path));
  if (currentFiles.length !== indexedEntries.length) return false;
  const entriesByPath = new Map(indexedEntries.map((entry) => [normalizePath(entry.path), entry]));
  return currentFiles.every((file) => {
    const entry = entriesByPath.get(normalizePath(file.path));
    return Boolean(entry && entry.mtime === file.stat.mtime && entry.size === file.stat.size);
  });
}
export function applyAgentSlice(Store: StoreConstructor): void {
  Object.assign(Store.prototype, agentSlice);
  guardDerivedMethods(Store.prototype, ["buildSemanticContext", "buildKnowledgeContext", "buildKnowledgeGraphContext",
    "buildKnowledgeTopicContext", "buildIndexSummaryContext", "rebuildVaultIndex", "rebuildKnowledgeStructure", "rebuildVectorIndex",
    "upsertKnowledgeLink", "readMemoryIndex", "readMemoryAssociations"]);
}

export async function readTaskContextWithEvidence(store: StoreHost, date: string) {
    const policy = contextDataPolicy(store);
    const db = await readContextTasks(store);
    const tasks = db.tasks.slice().sort(sortTasks);
    const active = tasks.filter((task) => task.status === "active");
    const tomorrow = addDays(date, 1);
    const nextSeven = addDays(date, 7);
    const completedRecent = tasks
      .filter((task) => task.status === "completed")
      .sort((a, b) => (b.completedAt || b.updatedAt).localeCompare(a.completedAt || a.updatedAt))
      .slice(0, 8);

    const sections = [
      ["Today", active.filter((task) => isTaskOnDate(task, date)).slice(0, 12)],
      ["Overdue", active.filter((task) => isTaskOverdue(task, date)).slice(0, 12)],
      ["Tomorrow", active.filter((task) => isTaskOnDate(task, tomorrow)).slice(0, 10)],
      ["Next 7 Days", active.filter((task) => task.date && task.date > date && task.date <= nextSeven).slice(0, 15)],
      ["No Date", active.filter((task) => !task.date).slice(0, 10)],
      ["Recently Completed", completedRecent]
    ] as Array<[string, LifeOpsTask[]]>;

    const summary = !db.available ? "任务记录未提供，当前数量与完成状态未知；不能当成零项。" : [
      `- active: ${active.length}`,
      `- completed: ${tasks.filter((task) => task.status === "completed").length}`,
      `- abandoned: ${tasks.filter((task) => task.status === "abandoned").length}`
    ].join("\n");

    const recentRecords: string[] = [];
    const activityReads: Array<{path:string;hash:string;fragment:string}> = [];
    const protectContext = createPersonalMemoryContextFilter((await readPersonalMemoryWithSources(store)).records);
    for (const day of [date, addDays(date, -1)]) {
      const path = activityNotePath(store, "tasks", day);
      if (!isContextSourcePath(path) || isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)) continue;
      const file = store.getFile(path);
      if (file && file.path !== path) throw new Error("任务记录身份无法核对。");
      const raw = file ? await store.readPath(path) : "";
      if (store.getFile(path)?.path !== file?.path) throw new Error("任务记录身份在读取期间变化。");
      if (isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)) throw new Error("任务记录权限在读取期间变化。");
      const text = protectContext(raw);
      const fragment = text.trim() ? `#### ${day} · ${path}\n${truncateContext(text, 1600)}` : "";
      activityReads.push({path,hash:file ? contextSourceHash(raw) : "absent",fragment});
      if (fragment) recentRecords.push(fragment);
    }
    if (contextDataPolicy(store) !== policy) throw new Error("任务记录权限在读取期间变化。");
    const databaseText = [
      "### Summary",
      db.filtered ? "本轮仅统计允许提供的任务记录，不代表被排除的事项或完整总数。" : "",
      summary,
      "",
      ...(db.available ? sections.map(([title, items]) => [`### ${title}`, formatTaskContextList(items)].join("\n")) : [])
    ].join("\n");
    const text = [databaseText,
      ...(recentRecords.length ? ["### 近期任务记录（口述与操作日志）", "口述完成未关联任务时，不代表任务数据库已完成；当前任务状态以以上数据库列表为准。", ...recentRecords] : [])
    ].join("\n");
    return {text,data:db,databaseText,activityReads};
}

export async function readHabitContextWithEvidence(store: StoreHost, date: string) {
    const policy = contextDataPolicy(store);
    const data = await readContextHabits(store);
    if (!data.available) return {text:"习惯记录未提供，当前数量与打卡状态未知；不能当成零项。",data};
    const habitDb = data.database;
    const dashboard = await store.buildHabitDashboard(habitDb.checkins, date, habitDb, data.tradeUnavailable);
    if (contextDataPolicy(store) !== policy) throw new Error("习惯记录权限在读取期间变化。");
    if (dashboard.length === 0) return {text:"(empty)",data};
    const text = dashboard
      .map((item) => {
        if (item.periodUnavailable) return `- ${item.habit.name}：交易记录暂不可用，进度未知。`;
        if (item.habit.source === "trades") return `- ${item.habit.name}：${item.periodLabel} ${item.periodDone}/${item.periodTarget} 笔。`;
        if (isHealthHabitSource(item.habit.source)) {
          const progress = item.healthUnrecorded ? `${item.periodLabel}还没有健康记录`
            : `${item.periodLabel} ${item.periodDone}/${item.periodTarget}${item.periodUnit ? " " + item.periodUnit : " 次"}`;
          const scope = data.healthPartial ? "，只统计可读的健康记录" : "";
          return `- ${item.habit.name}：${progress}${scope}。`;
        }
        const status = item.status === "pending" ? "pending" : habitStatusLabel(item.status);
        const note = item.checkin?.note ? `；备注：${item.checkin.note}` : "";
        return `- ${item.habit.name}：${status}；今日必需=${item.requiredToday ? "是" : "否"}；今日次数=${item.checkin?.count ?? 0}/${item.habit.targetCount}；连续=${item.streak}；本周失败=${item.weeklyFailures}${note}`;
      })
      .join("\n");
    return {text,data};
}
