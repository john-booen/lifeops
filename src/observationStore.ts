export type ObservationSource = "camera" | "desktop" | "voice" | "vault" | "task" | "time";

export interface Observation {
  id: string;
  source: ObservationSource;
  kind: string;
  summary: string;
  observedAt: string;
  expiresAt: string;
  confidence: number;
  evidence: Record<string, string | number | boolean | null>;
  rawPersisted: false;
}

export interface ObservationDocument {
  version: 1;
  updatedAt: string;
  observations: Observation[];
}

export interface ObservationInput {
  id?: string;
  source: ObservationSource;
  kind: string;
  summary: string;
  observedAt?: string;
  ttlMs?: number;
  confidence?: number;
  evidence?: Record<string, string | number | boolean | null>;
}

export const DEFAULT_OBSERVATION_TTL_MS = 24 * 60 * 60_000;
export const MAX_OBSERVATIONS = 1_000;

export function emptyObservationDocument(now = new Date().toISOString()): ObservationDocument {
  return { version: 1, updatedAt: now, observations: [] };
}

export function createObservation(input: ObservationInput): Observation {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const expiresAt = new Date(
    Date.parse(observedAt) + Math.max(1_000, input.ttlMs ?? DEFAULT_OBSERVATION_TTL_MS)
  ).toISOString();
  return {
    id: input.id ?? `observation_${hashText(`${input.source}:${input.kind}:${observedAt}:${input.summary}`)}`,
    source: input.source,
    kind: input.kind,
    summary: input.summary.replace(/\s+/g, " ").trim().slice(0, 400),
    observedAt,
    expiresAt,
    confidence: clamp01(input.confidence ?? 0.5),
    evidence: input.evidence ?? {},
    rawPersisted: false
  };
}

export function appendObservation(
  document: ObservationDocument,
  observation: Observation,
  now = new Date()
): ObservationDocument {
  const observations = [
    ...document.observations.filter((item) => item.id !== observation.id),
    observation
  ]
    .filter((item) => Date.parse(item.expiresAt) > now.getTime())
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
    .slice(-MAX_OBSERVATIONS);
  return {
    version: 1,
    updatedAt: now.toISOString(),
    observations
  };
}

export function activeObservations(
  document: ObservationDocument,
  now = new Date(),
  sources?: ObservationSource[]
): Observation[] {
  return document.observations
    .filter((observation) => Date.parse(observation.expiresAt) > now.getTime())
    .filter((observation) => !sources || sources.includes(observation.source))
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt));
}

export function pruneExpiredObservations(
  document: ObservationDocument,
  now = new Date()
): ObservationDocument {
  const observations = document.observations.filter((observation) => (
    Number.isFinite(Date.parse(observation.expiresAt))
    && Date.parse(observation.expiresAt) > now.getTime()
  ));
  if (observations.length === document.observations.length) return document;
  return {
    version: 1,
    updatedAt: now.toISOString(),
    observations
  };
}

export function removeObservationSource(
  document: ObservationDocument,
  source: ObservationSource,
  now = new Date()
): ObservationDocument {
  const observations = document.observations.filter((observation) => observation.source !== source);
  if (observations.length === document.observations.length) return document;
  return {
    version: 1,
    updatedAt: now.toISOString(),
    observations
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
