export type SourceStatus = "active" | "deleted" | "error";
export type DerivedStatus = "current" | "stale" | "missing";

export interface SourceManifestEntry {
  sourceId: string;
  path: string;
  previousPaths: string[];
  category: string;
  contentHash: string;
  mtime: number;
  size: number;
  status: SourceStatus;
  chunkIds: string[];
  memoryIds: string[];
  vectorStatus: DerivedStatus;
  firstSeenAt: string;
  lastProcessedAt: string;
  deletedAt?: string;
  error?: string;
}

export interface SourceManifest {
  version: 1;
  updatedAt: string;
  entries: SourceManifestEntry[];
}

export interface SourceUpsertInput {
  path: string;
  category: string;
  content: string;
  mtime: number;
  size: number;
  chunkIds?: string[];
  memoryIds?: string[];
}

export function emptySourceManifest(now = new Date().toISOString()): SourceManifest {
  return {
    version: 1,
    updatedAt: now,
    entries: []
  };
}

export function upsertSource(
  manifest: SourceManifest,
  input: SourceUpsertInput,
  now = new Date().toISOString()
): { manifest: SourceManifest; entry: SourceManifestEntry; changed: boolean } {
  const contentHash = hashSourceContent(input.content);
  const existing = manifest.entries.find((entry) => entry.path === input.path);
  const changed = !existing
    || existing.status !== "active"
    || existing.contentHash !== contentHash
    || existing.category !== input.category;
  const entry: SourceManifestEntry = {
    sourceId: existing?.sourceId ?? `source_${hashText(input.path).slice(0, 12)}`,
    path: input.path,
    previousPaths: existing?.previousPaths ?? [],
    category: input.category,
    contentHash,
    mtime: input.mtime,
    size: input.size,
    status: "active",
    chunkIds: input.chunkIds ?? existing?.chunkIds ?? [],
    memoryIds: input.memoryIds ?? existing?.memoryIds ?? [],
    vectorStatus: changed ? "stale" : existing?.vectorStatus ?? "missing",
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastProcessedAt: now
  };
  return {
    manifest: replaceEntry(manifest, entry, now),
    entry,
    changed
  };
}

export function markSourceDeleted(
  manifest: SourceManifest,
  path: string,
  now = new Date().toISOString()
): { manifest: SourceManifest; entry: SourceManifestEntry | null } {
  const existing = manifest.entries.find((entry) => entry.path === path);
  if (!existing) return { manifest, entry: null };
  const entry: SourceManifestEntry = {
    ...existing,
    status: "deleted",
    vectorStatus: "stale",
    lastProcessedAt: now,
    deletedAt: now
  };
  return {
    manifest: replaceEntry(manifest, entry, now),
    entry
  };
}

export function renameSource(
  manifest: SourceManifest,
  oldPath: string,
  newPath: string,
  now = new Date().toISOString()
): { manifest: SourceManifest; entry: SourceManifestEntry | null } {
  const existing = manifest.entries.find((entry) => entry.path === oldPath);
  if (!existing) return { manifest, entry: null };
  const entry: SourceManifestEntry = {
    ...existing,
    path: newPath,
    previousPaths: Array.from(new Set([...existing.previousPaths, oldPath])),
    contentHash: "",
    vectorStatus: "stale",
    lastProcessedAt: now
  };
  return {
    manifest: {
      version: 1,
      updatedAt: now,
      entries: [...manifest.entries.filter((item) => item.sourceId !== entry.sourceId), entry]
    },
    entry
  };
}

export function sourceNeedsProcessing(
  entry: SourceManifestEntry | undefined,
  file: { mtime: number; size: number }
): boolean {
  return !entry
    || entry.status !== "active"
    || entry.mtime !== file.mtime
    || entry.size !== file.size;
}

export function hashSourceContent(content: string): string {
  return hashText(content.replace(/\r\n/g, "\n"));
}

function replaceEntry(manifest: SourceManifest, entry: SourceManifestEntry, now: string): SourceManifest {
  return {
    version: 1,
    updatedAt: now,
    entries: [...manifest.entries.filter((item) => item.sourceId !== entry.sourceId), entry]
      .sort((left, right) => left.path.localeCompare(right.path, "zh-CN"))
  };
}

function hashText(text: string): string {
  let first = 2166136261;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 16777619);
    second ^= code + index;
    second = Math.imul(second, 2246822519);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}
