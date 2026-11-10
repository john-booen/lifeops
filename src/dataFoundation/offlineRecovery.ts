// Node-only offline maintenance. Deliberately not imported by the Obsidian plugin.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export type RecoveryStage = "prepared" | "before-write" | "after-write" | "before-restore" | "after-restore";
export interface RecoveryOptions {
  vaultRoot: string;
  backupRoot: string;
  allowedPaths: readonly string[];
  /** Larger bounded journals for plugin binaries; each individual file stays at 16 MiB. */
  maxPlanBytes?: number;
  /** Explicit binary-package format. Never used for user-data snapshots. */
  artifactStorage?: { maxTotalBytes: number };
  onStep?: (event: { stage: RecoveryStage; path?: string }) => Promise<void> | void;
}
export interface RecoveryUpdate { path: string; expectedHash: string | null; after: Buffer | null; expectedMode?: number | null; mode?: number }
interface Revision { hash: string; data?: string; size?: number; mode?: number }
interface Change { path: string; before: Revision | null; after: Revision | null }
interface Plan {
  version: 1 | 2; batchId: string; migrationId: string; vaultRoot: string;
  allowedPaths: string[]; changes: Change[]; fingerprint: string;
  storage?: "sha256-blob-v1";
  retained?: { path: string; revision: Revision | null }[];
}
type Status = "prepared" | "applying" | "applied" | "rolling_back" | "rolled_back" | "recovery_required";
export interface RecoveryResult { batchId: string; status: string; files: number }
const MAX_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const STATUSES: Status[] = ["prepared", "applying", "applied", "rolling_back", "rolled_back", "recovery_required"];

export class RecoveryError extends Error {
  readonly code: string;
  constructor(code: string) { super(`LifeOps offline recovery: ${code}`); this.name = "RecoveryError"; this.code = code; }
}
function fail(code: string): never { throw new RecoveryError(code); }
async function protectedIO<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (error) {
    if (error instanceof RecoveryError) throw error;
    fail("filesystem_error");
  }
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
export function revisionHash(data: Buffer | null): string | null {
  return data === null ? null : createHash("sha256").update(data).digest("hex");
}
function revision(data: Buffer | null): Revision | null {
  return data === null ? null : { hash: revisionHash(data)!, data: data.toString("base64") };
}
function bytes(value: Revision | null): Buffer | null { return value === null ? null : Buffer.from(value.data!, "base64"); }
function hash(value: Revision | null): string | null { return value?.hash ?? null; }
function pathCheck(path: string): void {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\")
    || /[\x00-\x1f\x7f:]/.test(path) || path.split("/").some(p => !p || p.startsWith(".") || p.endsWith(" "))) fail("unsafe_path");
}
function idCheck(id: string): void { if (typeof id !== "string" || !ID.test(id)) fail("invalid_id"); }
function contained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

// Check every existing ancestor before traversing it. Callers must keep the Vault quiescent;
// a Node hash check + rename cannot provide CAS against non-cooperating external editors.
export async function assertSafeDiskPath(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) { if (isMissing(error)) return; throw error; }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) fail("unsafe_disk_path");
    if (current !== absolute && !stat.isDirectory()) fail("unsafe_disk_path");
  }
}
async function readBytes(path: string, maxBytes = MAX_BYTES): Promise<Buffer | null> {
  await assertSafeDiskPath(path);
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.size > maxBytes) fail("invalid_file");
    return await fs.readFile(path);
  } catch (error) { if (isMissing(error)) return null; throw error; }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await fs.open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function atomicWrite(path: string, value: Buffer, stagingFolder = dirname(path), mode = 0o600): Promise<void> {
  await assertSafeDiskPath(path);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertSafeDiskPath(path);
  await assertSafeDiskPath(stagingFolder);
  const temporary = join(stagingFolder, `.lifeops-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(value); await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
  try {
    await assertSafeDiskPath(path);
    await fs.rename(temporary, path);
    await syncDirectory(dirname(path));
    if (stagingFolder !== dirname(path)) await syncDirectory(stagingFolder);
  } finally { await fs.unlink(temporary).catch(error => { if (!isMissing(error)) throw error; }); }
}
function requestFingerprint(migrationId: string, changes: unknown[]): string {
  return revisionHash(Buffer.from(JSON.stringify({ migrationId, changes })))!;
}
function planFingerprint(plan: Omit<Plan, "fingerprint">): string { return revisionHash(Buffer.from(JSON.stringify(plan)))!; }
function checkRevision(value: unknown): asserts value is Revision | null {
  if (value === null) return;
  if (typeof value !== "object" || !value) fail("invalid_backup");
  const v = value as Revision;
  if (typeof v.hash !== "string" || !HASH.test(v.hash) || typeof v.data !== "string"
    || v.mode !== undefined || v.size !== undefined) fail("invalid_backup");
  const data = Buffer.from(v.data, "base64");
  if (data.length > MAX_BYTES || data.toString("base64") !== v.data || revisionHash(data) !== v.hash) fail("invalid_backup");
}

export class OfflineRecovery {
  private readonly vault: string;
  private readonly backup: string;
  private readonly allowed: string[];
  private readonly maxPlanBytes: number;
  private readonly artifactLimit?: number;
  constructor(privateOptions: RecoveryOptions) {
    this.options = privateOptions;
    this.vault = resolve(privateOptions.vaultRoot);
    this.backup = resolve(privateOptions.backupRoot);
    this.allowed = [...privateOptions.allowedPaths].sort();
    this.maxPlanBytes = privateOptions.maxPlanBytes ?? MAX_BYTES;
    if (privateOptions.artifactStorage !== undefined) {
      this.artifactLimit = privateOptions.artifactStorage.maxTotalBytes;
      if (!Number.isSafeInteger(this.artifactLimit) || this.artifactLimit! < 1 || this.artifactLimit! > 128 * 1024 * 1024) fail("invalid_artifact_limit");
    }
    if (!Number.isSafeInteger(this.maxPlanBytes) || this.maxPlanBytes < MAX_BYTES || this.maxPlanBytes > 64 * 1024 * 1024) fail("invalid_plan_limit");
    if (!this.allowed.length || this.allowed.length > 200) fail("invalid_scope");
    this.allowed.forEach(pathCheck);
    const folded = this.allowed.map(path => path.normalize("NFC").toLowerCase());
    if (new Set(folded).size !== folded.length || folded.some((p, i) => folded.some((q, j) => i !== j && q.startsWith(`${p}/`)))) fail("duplicate_path");
    if (contained(this.vault, this.backup) || contained(this.backup, this.vault)) fail("overlapping_roots");
  }
  private readonly options: RecoveryOptions;
  private async initialize(): Promise<void> {
    await assertSafeDiskPath(this.vault);
    if (!(await fs.lstat(this.vault)).isDirectory()) fail("invalid_vault");
    if (await fs.realpath(this.vault) !== this.vault) fail("noncanonical_root");
    await assertSafeDiskPath(this.backup);
    let ancestor = this.backup;
    while (!(await fs.lstat(ancestor).catch(error => { if (isMissing(error)) return null; throw error; }))) ancestor = dirname(ancestor);
    if (await fs.realpath(ancestor) !== ancestor) fail("noncanonical_root");
    await fs.mkdir(this.backup, { recursive: true, mode: 0o700 });
    await assertSafeDiskPath(this.backup);
    if ((await fs.stat(this.vault)).dev !== (await fs.stat(this.backup)).dev) fail("different_filesystems");
  }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    return protectedIO(() => this.withLock(fn));
  }
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.initialize();
    const lockPath = join(this.backup, ".lock.json");
    // Publish a complete, fsynced lock with an exclusive hard link. A crash cannot
    // expose a half-written owner/token. Lock metadata is the ONLY hard-link exception.
    const token = randomUUID();
    const temporary = join(this.backup, `.lock-payload-${token}.json`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.link(temporary, lockPath); }
    catch (error) {
      await fs.unlink(temporary);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("locked");
      throw error;
    }
    try {
      await fs.unlink(temporary); await syncDirectory(this.backup);
      return await fn();
    } finally { await fs.unlink(lockPath); await syncDirectory(this.backup); }
  }
  private async readLock(): Promise<Buffer> {
    await assertSafeDiskPath(this.backup);
    const path = join(this.backup, ".lock.json");
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) fail("invalid_lock");
    return fs.readFile(path);
  }
  // Explicit operator action only, after a process crash. Never break a live lock.
  async releaseStaleLock(token: string): Promise<void> {
    return protectedIO(() => this.unlock(token));
  }
  private async unlock(token: string): Promise<void> {
    await this.initialize();
    const path = join(this.backup, ".lock.json");
    const content = await this.readLock();
    let lock;
    try { lock = JSON.parse(content?.toString("utf8") ?? ""); } catch { fail("invalid_lock"); }
    if (typeof token !== "string" || lock.token !== token || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) fail("invalid_lock");
    try { process.kill(lock.pid, 0); fail("lock_owner_alive"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    if (!(await this.readLock()).equals(content)) fail("lock_changed");
    await fs.unlink(path); await syncDirectory(this.backup);
  }
  private async target(path: string): Promise<Buffer | null> {
    pathCheck(path);
    if (!this.allowed.includes(path)) fail("outside_scope");
    return readBytes(join(this.vault, path));
  }
  /** Read one stable regular file, without following links or masking special mode bits. */
  private async artifactFile(path: string): Promise<{ revision: Revision; data: Buffer } | null> {
    await assertSafeDiskPath(path);
    let handle;
    try { handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (isMissing(error)) return null; throw error; }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES || (before.mode & 0o7000) || !(before.mode & 0o400)) fail("invalid_file");
      const storage = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < storage.length) {
        const chunk = await handle.read(storage, length, storage.length - length, null);
        if (!chunk.bytesRead) break;
        length += chunk.bytesRead;
      }
      const data = storage.subarray(0, length);
      const after = await handle.stat(), named = await fs.lstat(path);
      for (const current of [after, named]) {
        if (!current.isFile() || current.nlink !== 1 || current.ino !== before.ino || current.dev !== before.dev
          || current.size !== before.size || current.mode !== before.mode || current.mtimeMs !== before.mtimeMs
          || current.ctimeMs !== before.ctimeMs || data.length !== before.size) fail("target_conflict");
      }
      return { revision: { hash: revisionHash(data)!, size: data.length, mode: before.mode & 0o777 }, data };
    } finally { await handle.close(); }
  }
  private async targetRevision(path: string): Promise<Revision | null> {
    if (!this.allowed.includes(path)) fail("outside_scope");
    return this.artifactLimit === undefined ? revision(await this.target(path))
      : (await this.artifactFile(join(this.vault, path)))?.revision ?? null;
  }
  private equal(a: Revision | null, b: Revision | null): boolean {
    return hash(a) === hash(b) && (this.artifactLimit === undefined || (a?.mode === b?.mode && a?.size === b?.size));
  }
  private async image(plan: Plan, value: Revision | null): Promise<Buffer | null> {
    if (value === null || plan.version === 1) return bytes(value);
    const blob = await this.artifactFile(join(this.backup, plan.batchId, "blobs", `${value.hash}.bin`));
    if (!blob || blob.revision.hash !== value.hash || blob.revision.size !== value.size || blob.revision.mode !== 0o600) fail("invalid_backup");
    return blob.data;
  }
  private async put(plan: Plan, path: string, expected: Revision | null, value: Revision | null): Promise<void> {
    if (!this.equal(await this.targetRevision(path), expected)) fail("target_conflict");
    if (this.equal(value, expected)) return;
    const data = await this.image(plan, value);
    const full = join(this.vault, path);
    if (data === null) { await fs.unlink(full); await syncDirectory(dirname(full)); }
    else await atomicWrite(full, data, this.backup, plan.version === 2 ? value!.mode : 0o600);
    if (!this.equal(await this.targetRevision(path), value)) fail("readback_failed");
  }
  private async load(batchId: string): Promise<Plan> {
    idCheck(batchId);
    const raw = await readBytes(join(this.backup, batchId, "plan.json"), this.maxPlanBytes);
    let plan: Plan;
    try { plan = JSON.parse(raw?.toString("utf8") ?? ""); } catch { fail("invalid_backup"); }
    if (!plan || plan.version !== (this.artifactLimit === undefined ? 1 : 2) || plan.batchId !== batchId || plan.vaultRoot !== this.vault
      || JSON.stringify(plan.allowedPaths) !== JSON.stringify(this.allowed) || !Array.isArray(plan.changes)
      || (plan.version === 1 && (!plan.changes.length || plan.storage !== undefined || plan.retained !== undefined))) fail("invalid_backup");
    idCheck(plan.migrationId);
    const seen = new Set<string>();
    for (const change of plan.changes) {
      if (!change || typeof change !== "object") fail("invalid_backup");
      pathCheck(change.path);
      if (!this.allowed.includes(change.path) || seen.has(change.path)) fail("invalid_backup");
      seen.add(change.path);
      if (plan.version === 1) { checkRevision(change.before); checkRevision(change.after); }
      else { this.checkArtifactRevision(change.before); this.checkArtifactRevision(change.after); }
    }
    if (plan.version === 2) {
      if (plan.storage !== "sha256-blob-v1" || !Array.isArray(plan.retained) || plan.migrationId === "snapshot-v1"
        || plan.migrationId.startsWith("restore-")) fail("invalid_backup");
      for (const item of plan.retained) {
        if (!item || typeof item !== "object" || !this.allowed.includes(item.path) || seen.has(item.path)) fail("invalid_backup");
        seen.add(item.path); this.checkArtifactRevision(item.revision);
      }
      if (seen.size !== this.allowed.length || plan.changes.some(c => this.equal(c.before, c.after))) fail("invalid_backup");
      await this.checkBlobs(plan);
    }
    if (plan.migrationId === "snapshot-v1" && (plan.changes.length !== this.allowed.length
      || plan.changes.some(c => hash(c.before) !== hash(c.after)))) fail("invalid_backup");
    const { fingerprint, ...payload } = plan;
    if (fingerprint !== planFingerprint(payload)) fail("invalid_backup");
    return plan;
  }
  private checkArtifactRevision(value: unknown): asserts value is Revision | null {
    if (value === null) return;
    if (!value || typeof value !== "object") fail("invalid_backup");
    const v = value as Revision;
    if (Object.keys(v).sort().join(",") !== "hash,mode,size" || typeof v.hash !== "string" || !HASH.test(v.hash)
      || !Number.isSafeInteger(v.size) || v.size! < 0 || v.size! > MAX_BYTES
      || !Number.isSafeInteger(v.mode) || v.mode! < 0 || v.mode! > 0o777 || !(v.mode! & 0o400)) fail("invalid_backup");
  }
  private async checkBlobs(plan: Plan): Promise<void> {
    const blobs = new Map<string, number>();
    for (const c of plan.changes) for (const r of [c.before, c.after]) if (r) {
      if (blobs.has(r.hash) && blobs.get(r.hash) !== r.size) fail("invalid_backup");
      blobs.set(r.hash, r.size!);
    }
    if ([...blobs.values()].reduce((a, b) => a + b, 0) > this.artifactLimit!) fail("artifact_limit_exceeded");
    const directory = join(this.backup, plan.batchId, "blobs");
    await assertSafeDiskPath(directory);
    const names: string[] = [];
    for await (const item of await fs.opendir(directory)) {
      if (names.length >= 400 || !item.isFile()) fail("invalid_backup");
      names.push(item.name);
    }
    names.sort();
    if (JSON.stringify(names) !== JSON.stringify([...blobs.keys()].map(h => `${h}.bin`).sort())) fail("invalid_backup");
    for (const [h, size] of blobs) await this.image(plan, { hash: h, size, mode: 0o600 });
  }
  private async state(plan: Plan): Promise<Status> {
    const data = await readBytes(join(this.backup, plan.batchId, "state.json"));
    if (data === null) return "recovery_required";
    let value;
    try { value = JSON.parse(data.toString("utf8")); } catch { fail("invalid_state"); }
    if (!value || typeof value !== "object" || value.version !== 1 || value.fingerprint !== plan.fingerprint || !STATUSES.includes(value.status)) fail("invalid_state");
    return value.status;
  }
  private async setState(plan: Plan, status: Status, intent?: string): Promise<void> {
    await atomicWrite(join(this.backup, plan.batchId, "state.json"), Buffer.from(JSON.stringify({ version: 1, fingerprint: plan.fingerprint, status, intent: intent ?? null })));
  }
  private async markRecoveryRequired(plan: Plan): Promise<void> {
    try { await this.state(plan); await this.setState(plan, "recovery_required"); } catch { /* preserve invalid journal */ }
  }
  private result(plan: Plan, status: Status): RecoveryResult { return { batchId: plan.batchId, status, files: plan.changes.length }; }
  private async event(stage: RecoveryStage, path?: string): Promise<void> { await this.options.onStep?.({ stage, path }); }
  private async requireHashes(plan: Plan, side: "before" | "after"): Promise<void> {
    await this.requireRetained(plan);
    for (const change of plan.changes) if (!this.equal(await this.targetRevision(change.path), change[side])) fail("target_conflict");
  }
  private async requireRetained(plan: Plan): Promise<void> {
    for (const item of plan.retained ?? []) if (!this.equal(await this.targetRevision(item.path), item.revision)) fail("target_conflict");
  }
  private async revalidate(plan: Plan): Promise<void> {
    if ((await this.load(plan.batchId)).fingerprint !== plan.fingerprint) fail("invalid_backup");
  }
  /** Read validated immutable metadata without asserting that an older settled batch
   * is still installed. Payload bytes stay private to the recovery engine. */
  async review(batchId: string): Promise<{
    version: number; migrationId: string; fingerprint: string; status: Status;
    files: { path: string; before: { hash: string; size?: number; mode?: number } | null;
      after: { hash: string; size?: number; mode?: number } | null }[];
  }> {
    return protectedIO(async () => {
      const plan = await this.load(batchId);
      const metadata = (r: Revision | null) => r === null ? null
        : { hash: r.hash, ...(plan.version === 2 ? { size: r.size, mode: r.mode } : {}) };
      return { version: plan.version, migrationId: plan.migrationId, fingerprint: plan.fingerprint, status: await this.state(plan),
        files: [...plan.changes, ...(plan.retained ?? []).map(r => ({ path: r.path, before: r.revision, after: r.revision }))]
          .map(c => ({ path: c.path, before: metadata(c.before), after: metadata(c.after) })).sort((a, b) => a.path.localeCompare(b.path)) };
    });
  }
  async inspect(batchId: string): Promise<RecoveryResult> {
    return protectedIO(() => this.inspectBatch(batchId));
  }
  private async inspectBatch(batchId: string): Promise<RecoveryResult> {
    await assertSafeDiskPath(this.backup);
    const plan = await this.load(batchId);
    const status = await this.state(plan);
    if (plan.migrationId !== "snapshot-v1" && (status === "applied" || status === "rolled_back")) await this.requireHashes(plan, status === "applied" ? "after" : "before");
    return this.result(plan, status);
  }
  async snapshot(batchId: string): Promise<RecoveryResult> {
    if (this.artifactLimit !== undefined) fail("unsupported_artifact_operation");
    return this.locked(async () => {
      idCheck(batchId);
      if (await readBytes(join(this.backup, batchId, "plan.json"), this.maxPlanBytes)) {
        const old = await this.load(batchId);
        if (old.migrationId !== "snapshot-v1") fail("batch_id_reused");
        // A crash while preparing never changes the Vault. Complete only if the
        // frozen originals still match; existing malformed state is never overwritten.
        const status = await this.state(old);
        if (status === "prepared" || status === "recovery_required") {
          await this.requireHashes(old, "before");
          await this.setState(old, "applied");
          return this.result(old, "applied");
        }
        return this.result(old, status);
      }
      const updates: RecoveryUpdate[] = [];
      for (const path of this.allowed) { const data = await this.target(path); updates.push({ path, expectedHash: revisionHash(data), after: data }); }
      const plan = await this.prepare(batchId, "snapshot-v1", updates);
      await this.requireHashes(plan, "before");
      await this.setState(plan, "applied");
      return this.result(plan, "applied");
    });
  }
  private async prepare(batchId: string, migrationId: string, updates: RecoveryUpdate[]): Promise<Plan> {
    idCheck(batchId); idCheck(migrationId);
    if (!Array.isArray(updates) || !updates.length || updates.length > this.allowed.length) fail("invalid_plan");
    const paths = new Set<string>();
    for (const update of updates) {
      if (!update || typeof update !== "object") fail("invalid_plan");
      pathCheck(update.path);
      if (!this.allowed.includes(update.path) || paths.has(update.path)) fail("invalid_plan");
      paths.add(update.path);
      if (update.expectedHash !== null && (typeof update.expectedHash !== "string" || !HASH.test(update.expectedHash))) fail("invalid_plan");
      if (update.after !== null && (!Buffer.isBuffer(update.after) || update.after.length > MAX_BYTES)) fail("invalid_plan");
      this.validateMode(update);
    }
    if (this.artifactLimit !== undefined && paths.size !== this.allowed.length) fail("invalid_plan");
    const folder = join(this.backup, batchId);
    await assertSafeDiskPath(folder);
    // Never replace a batch (including an incomplete backup preparation).
    try { await fs.mkdir(folder, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("batch_id_reused"); throw error; }
    if (this.artifactLimit !== undefined) return this.prepareArtifacts(batchId, migrationId, updates);
    const changes: Change[] = [];
    for (const update of [...updates].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
      const before = await this.target(update.path);
      if (revisionHash(before) !== update.expectedHash) fail("target_conflict");
      changes.push({ path: update.path, before: revision(before), after: revision(update.after) });
    }
    const payload = { version: 1 as const, batchId, migrationId, vaultRoot: this.vault, allowedPaths: this.allowed, changes };
    const plan = { ...payload, fingerprint: planFingerprint(payload) };
    const content = Buffer.from(JSON.stringify(plan));
    if (content.length > this.maxPlanBytes) fail("plan_too_large");
    await atomicWrite(join(folder, "plan.json"), content);
    await syncDirectory(this.backup);
    const verified = await this.load(batchId); // Verify every original byte before the first target change.
    await this.setState(verified, "prepared");
    return verified;
  }
  private validateMode(update: RecoveryUpdate): void {
    if (this.artifactLimit === undefined) {
      if (update.mode !== undefined || update.expectedMode !== undefined) fail("invalid_plan");
      return;
    }
    const valid = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 0o777 && !!((n as number) & 0o400);
    if ((update.expectedHash === null ? update.expectedMode !== null : !valid(update.expectedMode))
      || (update.after === null ? update.mode !== undefined : !valid(update.mode))) fail("invalid_plan");
  }
  private async prepareArtifacts(batchId: string, migrationId: string, updates: RecoveryUpdate[]): Promise<Plan> {
    const changes: Change[] = [], retained: NonNullable<Plan["retained"]> = [];
    const blobs = new Map<string, Buffer>();
    let total = 0;
    for (const u of [...updates].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
      const original = await this.artifactFile(join(this.vault, u.path));
      const before = original?.revision ?? null;
      if (hash(before) !== u.expectedHash || (before?.mode ?? null) !== u.expectedMode) fail("target_conflict");
      const after = u.after === null ? null : { hash: revisionHash(u.after)!, size: u.after.length, mode: u.mode! };
      if (this.equal(before, after)) { retained.push({ path: u.path, revision: before }); continue; }
      changes.push({ path: u.path, before, after });
      for (const data of [original?.data, u.after]) if (data) {
        const h = revisionHash(data)!;
        if (!blobs.has(h)) {
          total += data.length;
          if (total > this.artifactLimit!) fail("artifact_limit_exceeded");
          blobs.set(h, data);
        }
      }
    }
    const folder = join(this.backup, batchId), blobFolder = join(folder, "blobs");
    await fs.mkdir(blobFolder, { mode: 0o700 });
    for (const [h, data] of blobs) await atomicWrite(join(blobFolder, `${h}.bin`), data);
    await syncDirectory(folder);
    const payload = { version: 2 as const, storage: "sha256-blob-v1" as const, batchId, migrationId,
      vaultRoot: this.vault, allowedPaths: this.allowed, changes, retained };
    const plan = { ...payload, fingerprint: planFingerprint(payload) };
    const content = Buffer.from(JSON.stringify(plan));
    if (content.length > this.maxPlanBytes) fail("plan_too_large");
    await this.checkBlobs(plan);
    await atomicWrite(join(folder, "plan.json"), content);
    await syncDirectory(this.backup);
    const verified = await this.load(batchId);
    await this.requireHashes(verified, "before");
    await this.setState(verified, "prepared");
    return verified;
  }
  async apply(batchId: string, migrationId: string, updates: RecoveryUpdate[]): Promise<RecoveryResult> {
    return this.locked(async () => {
      idCheck(batchId); idCheck(migrationId);
      if (migrationId === "snapshot-v1" || migrationId.startsWith("restore-")) fail("reserved_migration_id");
      const existing = await readBytes(join(this.backup, batchId, "plan.json"), this.maxPlanBytes);
      if (existing) {
        const old = await this.load(batchId);
        let requested;
        try {
          if (new Set(updates.map(u => u.path)).size !== updates.length) fail("invalid_plan");
          updates.forEach(u => this.validateMode(u));
          requested = requestFingerprint(migrationId, updates.map(u => ({ path: u.path, before: u.expectedHash, after: revisionHash(u.after),
            ...(old.version === 2 ? { beforeMode: u.expectedMode, afterMode: u.after === null ? null : u.mode } : {})
          })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        } catch { fail("invalid_plan"); }
        const frozen = [...old.changes, ...(old.retained ?? []).map(r => ({ path: r.path, before: r.revision, after: r.revision }))]
          .map(c => ({ path: c.path, before: hash(c.before), after: hash(c.after),
            ...(old.version === 2 ? { beforeMode: c.before?.mode ?? null, afterMode: c.after?.mode ?? null } : {})
          })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        if (requested !== requestFingerprint(old.migrationId, frozen)) fail("batch_id_reused");
        const status = await this.state(old);
        if (status === "applied" || status === "rolled_back") {
          await this.requireHashes(old, status === "applied" ? "after" : "before");
          return this.result(old, status);
        }
        fail("recovery_required");
      }
      const plan = await this.prepare(batchId, migrationId, updates);
      return this.execute(plan);
    });
  }
  private async execute(plan: Plan): Promise<RecoveryResult> {
    try {
      await this.event("prepared");
      await this.revalidate(plan);
      await this.requireHashes(plan, "before");
      for (const change of plan.changes) {
        await this.setState(plan, "applying", change.path); // Write-ahead intent, including writes that later crash.
        await this.event("before-write", change.path);
        if (plan.version === 2) await this.revalidate(plan);
        await this.requireRetained(plan);
        await this.put(plan, change.path, change.before, change.after);
        await this.event("after-write", change.path);
      }
      if (plan.version === 2) await this.revalidate(plan);
      await this.requireHashes(plan, "after");
      await this.setState(plan, "applied");
      return this.result(plan, "applied");
    } catch {
      try { await this.rollback(plan); } catch { await this.markRecoveryRequired(plan); fail("recovery_required"); }
      fail("apply_failed_rolled_back");
    }
  }
  private async rollback(plan: Plan): Promise<RecoveryResult> {
    // Read immutable backup again: do not trust stale in-memory snapshots after a fault.
    const loaded = await this.load(plan.batchId);
    if (loaded.fingerprint !== plan.fingerprint) fail("invalid_backup");
    plan = loaded;
    await this.state(plan);
    await this.requireRetained(plan);
    for (const change of plan.changes) {
      const current = await this.targetRevision(change.path);
      if (!this.equal(current, change.before) && !this.equal(current, change.after)) fail("target_conflict");
    }
    for (const change of [...plan.changes].reverse()) {
      await this.setState(plan, "rolling_back", change.path);
      await this.event("before-restore", change.path);
      if (plan.version === 2) await this.revalidate(plan);
      await this.requireRetained(plan);
      const current = await this.targetRevision(change.path);
      if (this.equal(current, change.before)) continue;
      if (!this.equal(current, change.after)) fail("target_conflict");
      await this.put(plan, change.path, current, change.before);
      await this.event("after-restore", change.path);
    }
    if (plan.version === 2) await this.revalidate(plan);
    await this.requireHashes(plan, "before");
    await this.setState(plan, "rolled_back");
    return this.result(plan, "rolled_back");
  }
  async recover(batchId: string): Promise<RecoveryResult> {
    return this.locked(async () => {
      const plan = await this.load(batchId);
      if (plan.migrationId === "snapshot-v1") fail("snapshot_is_not_migration");
      await this.state(plan); // Missing state is a crash window; malformed/unknown state must remain untouched.
      try { return await this.rollback(plan); }
      catch { await this.markRecoveryRequired(plan); fail("recovery_required"); }
    });
  }
  /** Explicit operator completion of the exact immutable after-images. Does
   * not create a new plan, hide unfinished work, or roll back on failure. */
  async complete(batchId: string, expectedMigrationId: string): Promise<RecoveryResult> {
    return this.locked(async () => {
      idCheck(expectedMigrationId);
      const plan = await this.load(batchId);
      if (plan.migrationId !== expectedMigrationId || plan.migrationId === "snapshot-v1"
        || plan.migrationId.startsWith("restore-")) fail("invalid_backup");
      const status = await this.state(plan);
      if (status === "applied") {
        await this.requireHashes(plan, "after");
        return this.result(plan, "applied");
      }
      if (status === "rolled_back") {
        await this.requireHashes(plan, "before");
        fail("batch_already_rolled_back"); // A deliberate rollback is settled.
      }
      try {
        // Check ALL files before any replacement. A later operator/user edit
        // must not be erased even if a different file is still unfinished.
        await this.requireRetained(plan);
        for (const change of plan.changes) {
          const current = await this.targetRevision(change.path);
          if (!this.equal(current, change.before) && !this.equal(current, change.after)) fail("target_conflict");
        }
        for (const change of plan.changes) {
          await this.setState(plan, "applying", change.path);
          await this.event("before-write", change.path);
          if ((await this.load(batchId)).fingerprint !== plan.fingerprint) fail("invalid_backup");
          await this.requireRetained(plan);
          const current = await this.targetRevision(change.path);
          if (!this.equal(current, change.before) && !this.equal(current, change.after)) fail("target_conflict");
          await this.put(plan, change.path, current, change.after);
          await this.event("after-write", change.path);
        }
        if ((await this.load(batchId)).fingerprint !== plan.fingerprint) fail("invalid_backup");
        await this.requireHashes(plan, "after");
        await this.setState(plan, "applied");
        return this.result(plan, "applied");
      } catch {
        await this.markRecoveryRequired(plan); fail("recovery_required");
      }
    });
  }
  async restore(snapshotId: string, newBatchId: string): Promise<RecoveryResult> {
    if (this.artifactLimit !== undefined) fail("unsupported_artifact_operation");
    return this.locked(async () => {
      const snapshot = await this.load(snapshotId);
      if (snapshot.migrationId !== "snapshot-v1" || await this.state(snapshot) !== "applied") fail("invalid_snapshot");
      idCheck(newBatchId);
      const migrationId = `restore-${revisionHash(Buffer.from(snapshotId))!.slice(0,40)}`;
      // Freeze and back up the current target in a NEW batch before restoring a snapshot.
      if (await readBytes(join(this.backup, newBatchId, "plan.json"), this.maxPlanBytes)) {
        const previous = await this.load(newBatchId);
        if (previous.migrationId !== migrationId
          || JSON.stringify(previous.changes.map(c => [c.path, c.after])) !== JSON.stringify(snapshot.changes.map(c => [c.path, c.before]))) fail("batch_id_reused");
        const status = await this.state(previous);
        if (status !== "applied" && status !== "rolled_back") fail("recovery_required");
        await this.requireHashes(previous, status === "applied" ? "after" : "before");
        return this.result(previous, status);
      }
      const updates: RecoveryUpdate[] = [];
      for (const change of snapshot.changes) updates.push({ path: change.path, expectedHash: revisionHash(await this.target(change.path)), after: bytes(change.before) });
      const plan = await this.prepare(newBatchId, migrationId, updates);
      return this.execute(plan);
    });
  }
}
