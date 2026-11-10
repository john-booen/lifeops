import {
  markMemoryStale,
  normalizeMemoryEntry,
  type MemoryIndexEntry,
  type MemoryPerspective,
  type MemoryType
} from "../memoryIndex";
import type { SourceManifestEntry } from "./sourceManifest";

export interface SourceMemoryNote {
  path: string;
  title: string;
  category: string;
  summary: string;
  mtime: number;
}

export interface SourceMemoryChunk {
  id: string;
  heading: string;
  summary: string;
  text: string;
}

export function deriveSourceMemories(
  source: SourceManifestEntry,
  note: SourceMemoryNote,
  chunks: SourceMemoryChunk[],
  now = new Date().toISOString()
): MemoryIndexEntry[] {
  if (!shouldDeriveMemory(note.category)) return [];
  const config = memoryConfig(note.category);
  const selectedChunks = chunks
    .filter((chunk) => chunk.summary.trim())
    .filter((chunk) => normalizeMemoryText(chunk.summary) !== normalizeMemoryText(note.summary))
    .slice(0, config.maxChunks);
  const candidates = [
    {
      id: `mem_source_${source.sourceId}_note`,
      content: `${note.title}：${note.summary}`,
      heading: note.title,
      excerpt: note.summary
    },
    ...selectedChunks.map((chunk) => ({
      id: `mem_source_${source.sourceId}_${shortHash(chunk.id)}`,
      content: `${note.title} / ${chunk.heading}：${chunk.summary}`,
      heading: chunk.heading,
      excerpt: chunk.text
    }))
  ].filter((candidate) => candidate.content.trim().length > 4);

  return candidates.map((candidate) => ({
    id: candidate.id,
    content: candidate.content,
    tier: config.type === "episode" || config.type === "state" ? "episodic" : "internalized",
    perspective: config.perspective,
    source: `${note.path}${candidate.heading ? `#${candidate.heading}` : ""}`,
    memoryType: config.type,
    truth: "fact",
    origin: "source",
    domain: note.category,
    evidence: [{
      sourceId: source.sourceId,
      path: note.path,
      heading: candidate.heading,
      contentHash: source.contentHash,
      excerptHash: shortHash(candidate.excerpt),
      mtime: note.mtime
    }],
    confidence: 0.9,
    importance: config.importance,
    verifiedCount: 1,
    retrieveCount: 0,
    createdAt: now,
    updatedAt: now,
    status: "active",
    tags: Array.from(new Set([note.category, config.type])),
    validFrom: now,
    supersedes: [],
    conflictsWith: [],
    history: []
  }));
}

export function mergeSourceMemories(
  entries: MemoryIndexEntry[],
  sourceId: string,
  derived: MemoryIndexEntry[],
  now = new Date().toISOString()
): MemoryIndexEntry[] {
  const normalized = entries.map(normalizeMemoryEntry);
  const existingSourceEntries = normalized.filter((entry) => (
    entry.origin === "source" && entry.evidence.some((evidence) => evidence.sourceId === sourceId)
  ));
  const derivedIds = new Set(derived.map((entry) => entry.id));
  const untouched = normalized.filter((entry) => !existingSourceEntries.some((item) => item.id === entry.id));
  const stale = existingSourceEntries
    .filter((entry) => !derivedIds.has(entry.id))
    .map((entry) => markMemoryStale(entry, "source section removed", now));
  const active = derived.map((entry) => {
    const existing = existingSourceEntries.find((item) => item.id === entry.id);
    if (!existing) return entry;
    const changed = existing.content !== entry.content
      || existing.evidence[0]?.contentHash !== entry.evidence[0]?.contentHash;
    return {
      ...entry,
      createdAt: existing.createdAt,
      retrieveCount: existing.retrieveCount,
      lastRetrievedAt: existing.lastRetrievedAt,
      validFrom: changed ? now : existing.validFrom,
      history: changed
        ? [...existing.history, {
            content: existing.content,
            evidence: existing.evidence,
            validFrom: existing.validFrom,
            validTo: now
          }]
        : existing.history
    };
  });
  return [...untouched, ...stale, ...active]
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function staleSourceMemories(
  entries: MemoryIndexEntry[],
  sourceId: string,
  reason: string,
  now = new Date().toISOString()
): MemoryIndexEntry[] {
  return entries.map((raw) => {
    const entry = normalizeMemoryEntry(raw);
    if (entry.origin !== "source" || !entry.evidence.some((evidence) => evidence.sourceId === sourceId)) {
      return entry;
    }
    return markMemoryStale(entry, reason, now);
  });
}

export function renameSourceMemoryEvidence(
  entries: MemoryIndexEntry[],
  sourceId: string,
  oldPath: string,
  newPath: string,
  now = new Date().toISOString()
): MemoryIndexEntry[] {
  return entries.map((raw) => {
    const entry = normalizeMemoryEntry(raw);
    if (!entry.evidence.some((evidence) => evidence.sourceId === sourceId)) return entry;
    return {
      ...entry,
      source: entry.source.startsWith(oldPath) ? `${newPath}${entry.source.slice(oldPath.length)}` : entry.source,
      evidence: entry.evidence.map((evidence) => (
        evidence.sourceId === sourceId ? { ...evidence, path: newPath } : evidence
      )),
      updatedAt: now
    };
  });
}

function memoryConfig(category: string): {
  type: MemoryType;
  perspective: MemoryPerspective;
  importance: number;
  maxChunks: number;
} {
  if (category === "trading-models") {
    return { type: "domain", perspective: "trading_discipline", importance: 0.88, maxChunks: 6 };
  }
  if (category === "trading-reviews") {
    return { type: "episode", perspective: "trading_discipline", importance: 0.76, maxChunks: 3 };
  }
  if (category === "goals") {
    return { type: "domain", perspective: "life_goal", importance: 0.9, maxChunks: 4 };
  }
  if (category === "daily" || category === "journal" || category === "health") {
    return {
      type: category === "health" ? "state" : "episode",
      perspective: category === "health" ? "health_pattern" : "general",
      importance: 0.68,
      maxChunks: 2
    };
  }
  if (category === "knowledge" || category === "ideas" || category === "outputs") {
    return { type: "domain", perspective: "project_context", importance: 0.72, maxChunks: 4 };
  }
  return { type: "domain", perspective: "general", importance: 0.58, maxChunks: 2 };
}

function shouldDeriveMemory(category: string): boolean {
  return [
    "daily",
    "journal",
    "health",
    "goals",
    "trading-reviews"
  ].includes(category);
}

function normalizeMemoryText(value: string): string {
  return value.replace(/\s+/g, "").replace(/[，,。.!！?？:：;；、"'“”‘’]/g, "");
}

function shortHash(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
