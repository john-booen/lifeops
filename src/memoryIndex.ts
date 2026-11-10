export type MemoryTier = "episodic" | "internalized" | "growth" | "core_identity";
export type MemoryStatus = "candidate" | "active" | "stale" | "superseded" | "archived";
export type MemoryType = "profile" | "domain" | "state" | "episode" | "rule" | "inference";
export type MemoryTruth = "fact" | "inference";
export type MemoryOrigin = "source" | "conversation" | "manual";
export type MemoryPerspective =
  | "owner_trait"
  | "interaction_preference"
  | "life_goal"
  | "trading_discipline"
  | "health_pattern"
  | "project_context"
  | "steward_rule"
  | "general";

export interface MemoryEvidence {
  sourceId: string;
  path: string;
  heading?: string;
  contentHash: string;
  excerptHash?: string;
  mtime: number;
}

export interface MemoryRevision {
  content: string;
  evidence: MemoryEvidence[];
  validFrom: string;
  validTo: string;
}

export interface MemoryIndexEntry {
  id: string;
  content: string;
  tier: MemoryTier;
  perspective: MemoryPerspective;
  source: string;
  memoryType: MemoryType;
  truth: MemoryTruth;
  origin: MemoryOrigin;
  domain: string;
  evidence: MemoryEvidence[];
  confidence: number;
  importance: number;
  verifiedCount: number;
  retrieveCount: number;
  createdAt: string;
  updatedAt: string;
  lastRetrievedAt?: string;
  status: MemoryStatus;
  tags: string[];
  validFrom: string;
  validTo?: string;
  staleReason?: string;
  supersedes: string[];
  conflictsWith: string[];
  history: MemoryRevision[];
}

export interface MemoryCandidateInput {
  id?: string;
  content: string;
  perspective?: MemoryPerspective;
  source: string;
  memoryType?: MemoryType;
  truth?: MemoryTruth;
  origin?: MemoryOrigin;
  domain?: string;
  evidence?: MemoryEvidence[];
  confidence?: number;
  importance?: number;
  tags?: string[];
}

const TIER_WEIGHT: Record<MemoryTier, number> = {
  episodic: 0.38,
  internalized: 0.7,
  growth: 0.88,
  core_identity: 1
};

export function createMemoryCandidate(input: MemoryCandidateInput, now = new Date().toISOString()): MemoryIndexEntry {
  const content = input.content.trim();
  return {
    id: input.id ?? `mem_${hashText(`${input.source}:${content}`).slice(0, 10)}`,
    content,
    tier: "episodic",
    perspective: input.perspective ?? "general",
    source: input.source,
    memoryType: input.memoryType ?? "episode",
    truth: input.truth ?? "fact",
    origin: input.origin ?? "conversation",
    domain: input.domain ?? "general",
    evidence: input.evidence ?? [],
    confidence: clamp01(input.confidence ?? 0.55),
    importance: clamp01(input.importance ?? 0.5),
    verifiedCount: 0,
    retrieveCount: 0,
    createdAt: now,
    updatedAt: now,
    status: "candidate",
    tags: Array.from(new Set(input.tags ?? [])),
    validFrom: now,
    supersedes: [],
    conflictsWith: [],
    history: []
  };
}

export function promoteMemory(
  entry: MemoryIndexEntry,
  tier: MemoryTier = "internalized",
  now = new Date().toISOString()
): MemoryIndexEntry {
  return {
    ...entry,
    tier,
    status: "active",
    verifiedCount: entry.verifiedCount + 1,
    confidence: clamp01(entry.confidence + 0.08),
    importance: clamp01(entry.importance + (tier === "core_identity" ? 0.2 : 0.08)),
    updatedAt: now
  };
}

export function archiveMemory(entry: MemoryIndexEntry, now = new Date().toISOString()): MemoryIndexEntry {
  return {
    ...entry,
    status: "archived",
    updatedAt: now,
    validTo: entry.validTo ?? now
  };
}

export function markMemoryStale(
  entry: MemoryIndexEntry,
  reason: string,
  now = new Date().toISOString()
): MemoryIndexEntry {
  return {
    ...entry,
    status: "stale",
    staleReason: reason,
    validTo: now,
    updatedAt: now
  };
}

export function recordMemoryRetrieved(entry: MemoryIndexEntry, now = new Date().toISOString()): MemoryIndexEntry {
  return {
    ...entry,
    retrieveCount: entry.retrieveCount + 1,
    lastRetrievedAt: now,
    updatedAt: now
  };
}

export function shouldSuggestGrowthMemory(entry: MemoryIndexEntry): boolean {
  return entry.status === "active" &&
    entry.tier === "internalized" &&
    entry.verifiedCount >= 3 &&
    entry.confidence >= 0.72 &&
    entry.importance >= 0.72;
}

export function memoryPriorityScore(entry: MemoryIndexEntry, now = new Date()): number {
  if (entry.status === "archived" || entry.status === "stale" || entry.status === "superseded") return 0;
  const recency = recencyScore(entry.lastRetrievedAt ?? entry.updatedAt, now);
  const statusBoost = entry.status === "active" ? 0.16 : -0.08;
  const retrievalBoost = Math.min(0.12, entry.retrieveCount * 0.015);
  return clamp01(
    TIER_WEIGHT[entry.tier] * 0.34 +
      entry.importance * 0.26 +
      entry.confidence * 0.2 +
      recency * 0.1 +
      statusBoost +
      retrievalBoost
  );
}

export function selectActiveMemories(entries: MemoryIndexEntry[], maxCount = 8, now = new Date()): MemoryIndexEntry[] {
  return entries
    .filter((entry) => entry.status === "active")
    .sort((a, b) => memoryPriorityScore(b, now) - memoryPriorityScore(a, now))
    .slice(0, maxCount);
}

export function selectRelevantMemories(
  entries: MemoryIndexEntry[],
  query: string,
  maxCount = 8,
  now = new Date()
): MemoryIndexEntry[] {
  const terms = memorySearchTerms(query);
  const wantedDomains = inferMemoryDomains(query);
  return entries
    .filter((entry) => entry.status === "active")
    .map((entry) => {
      const searchable = `${entry.content} ${entry.domain} ${entry.tags.join(" ")} ${entry.source}`.toLowerCase();
      const termScore = terms.reduce((score, term) => score + (searchable.includes(term) ? 0.18 : 0), 0);
      const domainScore = wantedDomains.has(entry.domain) ? 0.42 : 0;
      const directEvidence = entry.truth === "fact" && entry.evidence.length > 0 ? 0.08 : 0;
      return {
        entry,
        score: memoryPriorityScore(entry, now) + termScore + domainScore + directEvidence
      };
    })
    .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
    .slice(0, maxCount)
    .map((item) => item.entry);
}

export function hasSufficientMemoryCoverage(entries: MemoryIndexEntry[], query: string): boolean {
  if (/原文|读取|读一下|打开|具体|详细|逐条|全文|核对|出处|来源|依据|哪篇|最后一篇/.test(query)) {
    return false;
  }
  const wantedDomains = inferMemoryDomains(query);
  if (wantedDomains.size === 0) return false;
  const relevant = selectRelevantMemories(entries, query, 12)
    .filter((entry) => entry.truth === "fact" && entry.evidence.length > 0);
  const matching = relevant.filter((entry) => wantedDomains.has(entry.domain));
  return matching.length >= 2
    || matching.some((entry) => entry.memoryType === "domain" && entry.importance >= 0.8);
}

export function normalizeMemoryEntry(entry: MemoryIndexEntry): MemoryIndexEntry {
  return {
    ...entry,
    memoryType: entry.memoryType ?? "episode",
    truth: entry.truth ?? "inference",
    origin: entry.origin ?? "conversation",
    domain: entry.domain ?? "general",
    evidence: Array.isArray(entry.evidence) ? entry.evidence : [],
    validFrom: entry.validFrom ?? entry.createdAt,
    supersedes: Array.isArray(entry.supersedes) ? entry.supersedes : [],
    conflictsWith: Array.isArray(entry.conflictsWith) ? entry.conflictsWith : [],
    history: Array.isArray(entry.history) ? entry.history : []
  };
}

function recencyScore(iso: string, now: Date): number {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return 0;
  const ageDays = Math.max(0, (now.getTime() - time) / 86_400_000);
  return Math.max(0, 1 - ageDays / 30);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function memorySearchTerms(query: string): string[] {
  return Array.from(new Set(query
    .toLowerCase()
    .split(/[\s,，。；;:：、！？!?]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)));
}

function inferMemoryDomains(query: string): Set<string> {
  const domains = new Set<string>();
  const rules: Array<[RegExp, string[]]> = [
    [/交易|模型|入场|出场|止损|止盈|复盘|盈亏/, ["trading-models", "trading-reviews"]],
    [/日记|最近|状态|心情|发生|今天|昨天/, ["journal", "daily", "state"]],
    [/目标|规划|长期|方向/, ["goals"]],
    [/健康|睡眠|体重|疲劳|运动/, ["health"]],
    [/知识|笔记|资料|思考|灵感/, ["knowledge", "ideas"]],
    [/我是谁|了解我|偏好|习惯|性格/, ["profile", "general"]]
  ];
  for (const [pattern, values] of rules) {
    if (pattern.test(query)) values.forEach((value) => domains.add(value));
  }
  return domains;
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
