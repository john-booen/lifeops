import { constants, lstatSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { readPersonalMemoryDocument } from "./dataFoundation/personalMemoryPersistence";
import { guardedOperationOwner } from "./dataFoundation/factOperation";
import { personalMemoryReviewToMarkdown } from "./personalMemory";
import { isVaultPathExcluded } from "./privacy";
import { memoryFiles, type StoreHost } from "./store/settingsSlice";
import { LEGACY_MEMORY_PREVIEW_LIMITS as limits, legacyMemoryPreviewToMarkdown, previewLegacyMemoryMigration, type LegacyMemorySnapshot } from "./legacyMemoryMigration";

function canonical(path: string): boolean {
  return !!path && path === path.trim() && !/^[\/]|[\\\x00-\x1f\x7f]|:/.test(path)
    && path.split("/").every(part => part && part !== "." && part !== "..");
}
function stopped(): never { throw Error("旧记忆预览的资料、记忆或读取权限已变化，未保存旧预览；请重新打开审查。"); }
type Raw = { raw: string | null } | { unavailable: "too_large" | "unreadable" };

/** Desktop bounded byte reader. No cached catalog size is a read allowance;
 * symlink components are rejected and the opened file/version is checked. */
export async function readBoundedVaultFile(store: StoreHost, path: string, maximum: number, onChanged: () => never = stopped): Promise<Raw> {
  if (!canonical(path)) onChanged();
  const adapter = store.app.vault.adapter as { getBasePath?: () => string };
  if (typeof adapter?.getBasePath !== "function" || !isAbsolute(adapter.getBasePath())) return { unavailable: "unreadable" };
  const base = realpathSync(adapter.getBasePath());
  let target = base;
  try {
    for (const part of path.split("/")) { target = join(target, part); if (lstatSync(target).isSymbolicLink()) return { unavailable: "unreadable" }; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: null }; return { unavailable: "unreadable" }; }
  const actual = realpathSync(target), child = relative(base, actual);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return { unavailable: "unreadable" };
  const stamp = (stat: import("node:fs").BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
  const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true }), named = lstatSync(target, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || stamp(before) !== stamp(named) || realpathSync(target) !== actual) return { unavailable: "unreadable" };
    if (before.size > BigInt(maximum)) return { unavailable: "too_large" };
    const buffer = Buffer.alloc(Number(before.size) + 1); let length = 0;
    for (;;) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length); length += bytesRead; if (!bytesRead || length === buffer.length) break; }
    const after = await handle.stat({ bigint: true });
    if (length !== Number(before.size) || stamp(before) !== stamp(after) || stamp(before) !== stamp(lstatSync(target, { bigint: true })) || realpathSync(target) !== actual) onChanged();
    const bytes = buffer.subarray(0, length), raw = bytes.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(bytes)) return { unavailable: "unreadable" };
    return { raw };
  } finally { await handle.close(); }
}

/** Only the explicit manual command calls this. Ordinary confirmation/forget/
 * Undo keep their existing no-argument review path. The caller must pass both
 * guards to the existing Runtime fact transaction, then dispose in finally. */
export async function captureLegacyMemoryReview(store: StoreHost, ownerIsCurrent: () => boolean = () => true): Promise<{
  markdown: string; assertCurrent: () => void; assertBeforeCommit: () => Promise<void>; assertScoped: (scoped: StoreHost) => void;
}> {
  if (typeof store.runFactOperation !== "function") stopped();
  const folder = store.settings.folders.aiReports;
  if (!canonical(folder)) stopped();
  const authority = store.personalMemoryPath();
  const sources: LegacyMemorySnapshot[] = [
    { kind: "index", path: store.memoryIndexPath() },
    { kind: "conversation", path: store.path(folder, "Memory", "conversation-memory.jsonl") },
    ...memoryFiles().map(file => ({ kind: "markdown" as const, path: store.memoryFilePath(file.name), emptyTemplate: file.content }))
  ];
  if (![authority, ...sources.map(s => s.path)].every(canonical)) stopped();
  const policy = (host = store) => JSON.stringify({ folders: host.settings.folders, excluded: host.settings.privacy?.excludedVaultPrefixes ?? [],
    authority: host.personalMemoryPath(), index: host.memoryIndexPath(), markdown: memoryFiles().map(f => host.memoryFilePath(f.name)) });
  const beforePolicy = policy(), originals = new Map<string, { raw: string | null; maximum: number }>();
  const assertCurrent = () => { if (!ownerIsCurrent() || policy() !== beforePolicy) stopped(); };
  const hash = (text: string | null) => text === null ? null : createHash("sha256").update(text, "utf8").digest("hex");
  if (isVaultPathExcluded(authority, store.settings.privacy?.excludedVaultPrefixes)) stopped();
  assertCurrent();
  const personal = await readBoundedVaultFile(store, authority, 16 * 1024 * 1024); assertCurrent();
  if (!("raw" in personal)) stopped();
  originals.set(authority, { raw: personal.raw, maximum: 16 * 1024 * 1024 });
  // Reuse the canonical validator on the captured bytes, not another
  // unbounded read or a hand-written approximation of the authority schema.
  const snapshotStore = Object.assign(Object.create(store), {
    getFile: (path: string) => path === authority && personal.raw !== null ? { path } : null,
    readPath: async (path: string) => { if (path !== authority || personal.raw === null) stopped(); return personal.raw; }
  }) as StoreHost;
  const document = await readPersonalMemoryDocument(snapshotStore); assertCurrent();
  let totalBytes = 0;
  for (const source of sources) {
    assertCurrent();
    if (isVaultPathExcluded(source.path, store.settings.privacy?.excludedVaultPrefixes)) { source.unavailable = "excluded"; continue; }
    const maximum = Math.min(limits.sourceBytes, limits.totalBytes - totalBytes);
    let read: Raw;
    try { read = await readBoundedVaultFile(store, source.path, maximum); } catch { assertCurrent(); source.unavailable = "unreadable"; continue; }
    assertCurrent();
    if (!("raw" in read)) { source.unavailable = read.unavailable; continue; }
    originals.set(source.path, { raw: read.raw, maximum });
    if (read.raw === null) source.unavailable = "missing";
    else { source.text = read.raw; totalBytes += Buffer.byteLength(read.raw, "utf8"); }
  }
  const preview = previewLegacyMemoryMigration(sources, document.records, sources.map(({ kind, path }) => ({ kind, path })), store.settings.privacy?.excludedVaultPrefixes);
  const markdown = personalMemoryReviewToMarkdown(document.records) + "\n\n" + legacyMemoryPreviewToMarkdown(preview);
  const assertBeforeCommit = async () => {
    assertCurrent();
    for (const [path, before] of originals) {
      const current = await readBoundedVaultFile(store, path, before.maximum); assertCurrent();
      if (!("raw" in current) || hash(current.raw) !== hash(before.raw)) stopped();
    }
    assertCurrent();
  };
  const assertScoped = (scoped: StoreHost) => { assertCurrent(); if (guardedOperationOwner(scoped) !== store || policy(scoped) !== beforePolicy) stopped(); };
  return { markdown, assertCurrent, assertBeforeCommit, assertScoped };
}
