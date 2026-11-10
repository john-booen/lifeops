import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { decayAssociations, reinforceCoHits } from "../associations";
import { captureKindLabel } from "../classifier";
import { addDays, datesBetween, todayString, weekDates } from "../date";
import { createMemoryCandidate, promoteMemory, recordMemoryRetrieved, selectActiveMemories } from "../memoryIndex";
import { serializeQualityLogEntry } from "../qualityLog";
import type { ProactiveCandidate } from "../scheduler";
import { buildSituation, situationToMarkdown } from "../situation";
import { getTimeContext } from "../timeContext";
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
  VisualAnalysisResult
} from "../types";
import { jsonDataContract, parseJsonData, serializeJsonData } from "../dataFoundation/jsonDataGuard";
import {
  appendObservation as appendObservationToDocument,
  createObservation,
  emptyObservationDocument,
  pruneExpiredObservations,
  removeObservationSource,
  type Observation,
  type ObservationDocument,
  type ObservationInput,
  type ObservationSource
} from "../observationStore";
import * as settingsHelpers from './settingsSlice';
import type { StoreHost, TaskDatabase, HabitDatabase, VaultIndexEntry, VaultIndex, VaultStats, RetrievalHit, KnowledgeLink, KnowledgeLinksDb, VectorIndexEntry, VectorIndex, KnowledgeChunk, KnowledgeChunkIndex, KnowledgeGraphNode, KnowledgeGraphEdge, KnowledgeGraph, KnowledgeTopic } from './settingsSlice';

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
export interface ObservationSliceApi {
  buildSituationContext(): Promise<string>;




  readObservations(): Promise<ObservationDocument>;
  appendObservation(input: ObservationInput): Promise<Observation>;
  clearObservations(source: ObservationSource): Promise<void>;
}

const observationUpdates = new WeakMap<object, Map<string, Promise<void>>>();

function normalizedObservations(document: ObservationDocument): ObservationDocument {
  return { version: 1, updatedAt: document.updatedAt || new Date().toISOString(), observations: Array.isArray(document.observations) ? document.observations : [] };
}

function updateObservations(store: StoreHost, update: (document: ObservationDocument) => ObservationDocument): Promise<ObservationDocument> {
  const vault = store.app.vault, path = normalizePath(store.observationsPath());
  let pending = observationUpdates.get(vault);
  if (!pending) { pending = new Map(); observationUpdates.set(vault, pending); }
  const queue = pending, previous = queue.get(path) ?? Promise.resolve();
  const result = previous.then(async () => {
    const contract = jsonDataContract(path, store.settings.folders), file = store.getFile(path);
    if (!file) {
      const document = update(emptyObservationDocument()), text = serializeJsonData(document);
      parseJsonData(text, path, contract);
      await store.ensureFolder(parentFolder(path));
      // Keep exclusive creation: a foreign create must never become an overwrite.
      await vault.create(path, text);
      return document;
    }
    let document!: ObservationDocument;
    await vault.process(file, current => {
      const latest = normalizedObservations(parseJsonData(current, path, contract) as ObservationDocument);
      document = update(latest);
      if (document === latest) return current;
      const text = serializeJsonData(document);
      parseJsonData(text, path, contract);
      return text;
    });
    return document;
  });
  const settled = result.then(() => undefined, () => undefined);
  queue.set(path, settled);
  void settled.then(() => {
    if (queue.get(path) === settled) queue.delete(path);
    if (!queue.size) observationUpdates.delete(vault);
  });
  return result;
}

const observationSlice = {
async readObservations(this: StoreHost): Promise<ObservationDocument> {
    const document = await this.readJson<ObservationDocument>(
      this.observationsPath(),
      emptyObservationDocument()
    );
    const normalized = normalizedObservations(document);
    const pruned = pruneExpiredObservations(normalized);
    if (pruned === normalized) return normalized;
    return updateObservations(this, current => pruneExpiredObservations(current));
  },

async appendObservation(this: StoreHost, input: ObservationInput): Promise<Observation> {
    const observation = createObservation(input);
    await updateObservations(this, current => appendObservationToDocument(pruneExpiredObservations(current), observation));
    return observation;
  },

async clearObservations(this: StoreHost, source: ObservationSource): Promise<void> {
    await updateObservations(this, current => removeObservationSource(pruneExpiredObservations(current), source));
  },

async buildSituationContext(this: StoreHost): Promise<string> {
    return situationToMarkdown(buildSituation({ time: getTimeContext() }));
  }
};
export function applyObservationSlice(Store: StoreConstructor): void {
  Object.assign(Store.prototype, observationSlice);
}
