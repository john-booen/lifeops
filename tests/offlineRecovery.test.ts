import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OfflineRecovery, revisionHash } from "../src/dataFoundation/offlineRecovery";

const PRIVATE_TEXT = "SYNTHETIC-PRIVATE-DIARY-DO-NOT-EXPOSE";
type Step = { stage: "prepared" | "before-write" | "after-write" | "before-restore" | "after-restore"; path?: string };
type Update = { path: string; expectedHash: string | null; after: Buffer | null };
type Bytes = { hash: string; data: string } | null;
type Plan = {
  version: number;
  batchId: string;
  migrationId: string;
  vaultRoot: string;
  allowedPaths: string[];
  changes: Array<{ path: string; before: Bytes; after: Bytes }>;
  fingerprint: string;
};

let root: string;
let vaultRoot: string;
let backupRoot: string;

beforeEach(async () => {
  // macOS exposes its temporary directory through /var -> /private/var.
  // Use the canonical root so deliberate symlink tests, not the OS alias,
  // exercise the engine's no-symlink boundary.
  root = await realpath(await mkdtemp(join(tmpdir(), "lifeops-offline-recovery-")));
  vaultRoot = join(root, "vault");
  backupRoot = join(root, "backups");
  await mkdir(vaultRoot);
  await mkdir(backupRoot);
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function engine(allowedPaths: readonly string[], onStep?: (event: Step) => Promise<void> | void): OfflineRecovery {
  return new OfflineRecovery({ vaultRoot, backupRoot, allowedPaths, onStep });
}

async function put(path: string, bytes: Buffer | string): Promise<void> {
  await mkdir(dirname(join(vaultRoot, path)), { recursive: true });
  await writeFile(join(vaultRoot, path), bytes);
}

async function current(path: string): Promise<Buffer | null> {
  try { return await readFile(join(vaultRoot, path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function plan(batchId: string): Promise<Plan> {
  return JSON.parse(await readFile(join(backupRoot, batchId, "plan.json"), "utf8")) as Plan;
}

function update(path: string, before: Buffer | null, after: Buffer | null): Update {
  return { path, expectedHash: revisionHash(before), after };
}

async function rejected(operation: () => Promise<unknown> | unknown): Promise<Error> {
  let failure: unknown;
  try { await operation(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ name: "RecoveryError", code: expect.any(String) });
  expect(String(failure)).not.toContain(PRIVATE_TEXT);
  expect(JSON.stringify(failure)).not.toContain(PRIVATE_TEXT);
  return failure as Error;
}

describe("offline recovery stores byte-exact revisions", () => {
  it("distinguishes absence, empty bytes, and SHA-256 content revisions", () => {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0, 0xff]);
    expect(revisionHash(null)).toBeNull();
    expect(revisionHash(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(revisionHash(Buffer.alloc(0))).not.toBeNull();
    expect(revisionHash(Buffer.from("a\r\n"))).not.toBe(revisionHash(Buffer.from("a\n")));
  });

  it("backs up update, create, and delete together while preserving BOM, CRLF, and binary bytes", async () => {
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`# ${PRIVATE_TEXT}\r\n\r\n`)]);
    const binary = Buffer.from([0, 1, 2, 255, 254, 0, 13, 10]);
    const replacement = Buffer.from("# Updated\n");
    const created = Buffer.from([0xff, 0, 0x80, 0x0a]);
    await put("notes/original.md", original);
    await put("data/deleted.bin", binary);
    const paths = ["notes/original.md", "data/deleted.bin", "data/new.bin"];
    const tool = engine(paths);
    const result = await tool.apply("byte-batch", "synthetic-byte-migration", [
      update(paths[0], original, replacement), update(paths[1], binary, null), update(paths[2], null, created)
    ]);
    expect(result).toMatchObject({ batchId: "byte-batch", files: 3 });
    expect(await current(paths[0])).toEqual(replacement);
    expect(await current(paths[1])).toBeNull();
    expect(await current(paths[2])).toEqual(created);
    const manifest = await plan("byte-batch");
    expect(manifest).toMatchObject({ version: 1, batchId: "byte-batch", migrationId: "synthetic-byte-migration", vaultRoot });
    expect(manifest.allowedPaths.slice().sort()).toEqual(paths.slice().sort());
    for (const [path, before, after] of [
      [paths[0], original, replacement], [paths[1], binary, null], [paths[2], null, created]
    ] as Array<[string, Buffer | null, Buffer | null]>) {
      expect(manifest.changes.find((change) => change.path === path)).toEqual({
        path,
        before: before === null ? null : { hash: revisionHash(before), data: before.toString("base64") },
        after: after === null ? null : { hash: revisionHash(after), data: after.toString("base64") }
      });
    }
    expect(await tool.inspect("byte-batch")).toEqual(result);
  });

  it("snapshots existence for the entire allowlist and restores through a new backup batch", async () => {
    const original = Buffer.from(`\ufeff${PRIVATE_TEXT}\r\n`);
    const later = Buffer.from("Manually revised after snapshot\n");
    const createdLater = Buffer.from([255, 0, 128]);
    await put("a.md", original);
    const tool = engine(["a.md", "later.bin"]);
    expect(await tool.snapshot("baseline")).toMatchObject({ batchId: "baseline", files: 2 });
    const snapshot = await plan("baseline");
    expect(snapshot.changes).toHaveLength(2);
    for (const change of snapshot.changes) expect(change.before).toEqual(change.after);
    expect(snapshot.changes.find((change) => change.path === "later.bin")?.before).toBeNull();
    await put("a.md", later);
    await put("later.bin", createdLater);
    expect(await tool.restore("baseline", "restore-baseline")).toMatchObject({ batchId: "restore-baseline", files: 2 });
    expect(await current("a.md")).toEqual(original);
    expect(await current("later.bin")).toBeNull();
    const restorePlan = await plan("restore-baseline");
    expect(restorePlan.changes.find((change) => change.path === "a.md")?.before?.data).toBe(later.toString("base64"));
    expect(restorePlan.changes.find((change) => change.path === "later.bin")?.before?.data).toBe(createdLater.toString("base64"));
    expect(await plan("baseline")).toEqual(snapshot);
  });

  it("keeps a snapshot immutable when recover is mistakenly called on its id", async () => {
    const before = Buffer.from(PRIVATE_TEXT);
    const later = Buffer.from("later manual revision");
    await put("a.md", before);
    const tool = engine(["a.md"]);
    await tool.snapshot("permanent-snapshot");
    const originalPlan = await plan("permanent-snapshot");
    const originalState = await readFile(join(backupRoot, "permanent-snapshot", "state.json"));
    await put("a.md", later);
    expect((await tool.inspect("permanent-snapshot")).status).toBe("applied");
    await rejected(() => tool.recover("permanent-snapshot"));
    expect(await current("a.md")).toEqual(later);
    expect(await plan("permanent-snapshot")).toEqual(originalPlan);
    expect(await readFile(join(backupRoot, "permanent-snapshot", "state.json"))).toEqual(originalState);
    await tool.restore("permanent-snapshot", "valid-restore");
    expect(await current("a.md")).toEqual(before);
  });

  it("can restore a snapshot whose id uses the full supported 80 characters", async () => {
    const before = Buffer.from("original");
    await put("a.md", before);
    const tool = engine(["a.md"]);
    const snapshotId = "s".repeat(80);
    await tool.snapshot(snapshotId);
    await put("a.md", "later");
    await tool.restore(snapshotId, "restored-long-id");
    expect(await current("a.md")).toEqual(before);
  });
});

describe("conditional updates and repeat execution", () => {
  it("preflights every expected hash before changing the first file", async () => {
    const a = Buffer.from("a before");
    const b = Buffer.from(PRIVATE_TEXT);
    await put("a.md", a);
    await put("b.md", b);
    const written: string[] = [];
    await rejected(() => engine(["a.md", "b.md"], (event) => {
      if (event.stage === "after-write") written.push(event.path!);
    }).apply("stale-input", "synthetic", [
      update("a.md", a, Buffer.from("a after")), update("b.md", Buffer.from("stale"), Buffer.from("b after"))
    ]));
    expect(await current("a.md")).toEqual(a);
    expect(await current("b.md")).toEqual(b);
    expect(written).toEqual([]);
  });

  it("does not treat an existing empty file as an expected absence", async () => {
    await put("a.md", Buffer.alloc(0));
    await rejected(() => engine(["a.md"]).apply("empty-is-present", "synthetic", [update("a.md", null, Buffer.from("new"))]));
    expect(await current("a.md")).toEqual(Buffer.alloc(0));
  });

  it("rechecks the live hash after the before-write hook", async () => {
    const before = Buffer.from("original");
    const manual = Buffer.from(PRIVATE_TEXT);
    await put("a.md", before);
    let changed = false;
    const tool = engine(["a.md"], async (event) => {
      if (event.stage === "before-write" && !changed) {
        changed = true;
        await put("a.md", manual);
      }
    });
    await rejected(() => tool.apply("write-race", "synthetic", [update("a.md", before, Buffer.from("migration"))]));
    expect(changed).toBe(true);
    expect(await current("a.md")).toEqual(manual);
  });

  it("does not execute an identical successful batch twice and refuses a different plan with the same id", async () => {
    const before = Buffer.from("original");
    const after = Buffer.from("migrated");
    await put("a.md", before);
    let writes = 0;
    const tool = engine(["a.md"], (event) => { if (event.stage === "after-write") writes += 1; });
    const updates = [update("a.md", before, after)];
    const first = await tool.apply("idempotent", "synthetic", updates);
    const manifest = await plan("idempotent");
    expect(await tool.apply("idempotent", "synthetic", updates)).toEqual(first);
    expect(writes).toBe(1);
    await rejected(() => tool.apply("idempotent", "synthetic", [update("a.md", after, Buffer.from("different"))]));
    expect(await current("a.md")).toEqual(after);
    expect(await plan("idempotent")).toEqual(manifest);
  });

  it("does not reapply a completed plan over a later manual edit", async () => {
    const before = Buffer.from("original");
    const manual = Buffer.from(PRIVATE_TEXT);
    await put("a.md", before);
    const tool = engine(["a.md"]);
    const updates = [update("a.md", before, Buffer.from("migration"))];
    await tool.apply("completed", "synthetic", updates);
    await put("a.md", manual);
    // An idempotent no-op or a refusal are both safe; reapplying is not.
    await tool.apply("completed", "synthetic", updates).catch(() => undefined);
    expect(await current("a.md")).toEqual(manual);
  });
});

describe("interrupted batches preserve recoverable originals", () => {
  it("preflights every restore target before changing the first file", async () => {
    const originalA = Buffer.from("snapshot a");
    const originalB = Buffer.from("snapshot b");
    const laterA = Buffer.from("later a");
    const manualB = Buffer.from(PRIVATE_TEXT);
    await put("a.md", originalA);
    await put("b.md", originalB);
    await engine(["a.md", "b.md"]).snapshot("restore-preflight-source");
    await put("a.md", laterA);
    await put("b.md", "later b");
    const written: string[] = [];
    const tool = engine(["a.md", "b.md"], async (event) => {
      if (event.stage === "prepared") await put("b.md", manualB);
      if (event.stage === "after-write") written.push(event.path!);
    });
    await rejected(() => tool.restore("restore-preflight-source", "restore-preflight-conflict"));
    expect(await current("a.md")).toEqual(laterA);
    expect(await current("b.md")).toEqual(manualB);
    expect(written).toEqual([]);
  });

  it("rechecks a rollback target after the before-restore hook", async () => {
    const before = Buffer.from("original");
    const manual = Buffer.from(PRIVATE_TEXT);
    await put("a.md", before);
    let restoreHookCalled = false;
    const tool = engine(["a.md"], async (event) => {
      if (event.stage === "after-write") throw new Error("SYNTHETIC_ABORT");
      if (event.stage === "before-restore") {
        restoreHookCalled = true;
        await put("a.md", manual);
      }
    });
    await rejected(() => tool.apply("restore-recheck", "synthetic", [update("a.md", before, Buffer.from("migration"))]));
    expect(restoreHookCalled).toBe(true);
    expect(await current("a.md")).toEqual(manual);
    expect((await tool.inspect("restore-recheck")).status).toBe("recovery_required");
  });

  it("rolls back writes, deletions, and creations after an ordinary failure", async () => {
    const beforeA = Buffer.from(`\ufeff${PRIVATE_TEXT}\r\n`);
    const beforeB = Buffer.from([255, 0, 10]);
    await put("a.md", beforeA);
    await put("b.bin", beforeB);
    let writes = 0;
    let failed = false;
    const tool = engine(["a.md", "b.bin", "c.bin"], (event) => {
      if (event.stage === "after-write" && ++writes === 3 && !failed) {
        failed = true;
        throw new Error(PRIVATE_TEXT);
      }
    });
    const updates = [update("a.md", beforeA, Buffer.from("after")), update("b.bin", beforeB, null), update("c.bin", null, Buffer.from("created"))];
    await rejected(() => tool.apply("rollback", "synthetic", updates));
    expect(await current("a.md")).toEqual(beforeA);
    expect(await current("b.bin")).toEqual(beforeB);
    expect(await current("c.bin")).toBeNull();
    const state = await tool.inspect("rollback");
    expect(state.status).toBe("rolled_back");
    await tool.apply("rollback", "synthetic", updates).catch(() => undefined);
    expect(await current("a.md")).toEqual(beforeA);
    expect(await current("c.bin")).toBeNull();
    expect(writes).toBe(3);
  });

  it("preflights all rollback conflicts and leaves unrelated edits intact until explicitly repaired", async () => {
    const a = Buffer.from("a before");
    const b = Buffer.from("b before");
    const afterA = Buffer.from("a migrated");
    const afterB = Buffer.from("b migrated");
    const manual = Buffer.from(PRIVATE_TEXT);
    await put("a.md", a);
    await put("b.md", b);
    let writes = 0;
    const tool = engine(["a.md", "b.md"], async (event) => {
      if (event.stage === "after-write" && ++writes === 2) {
        await put("a.md", manual);
        throw new Error("SYNTHETIC_ABORT");
      }
    });
    await rejected(() => tool.apply("conflicted", "synthetic", [update("a.md", a, afterA), update("b.md", b, afterB)]));
    expect(await current("a.md")).toEqual(manual);
    expect(await current("b.md")).toEqual(afterB);
    await rejected(() => engine(["a.md", "b.md"]).recover("conflicted"));
    expect(await current("a.md")).toEqual(manual);
    expect(await current("b.md")).toEqual(afterB);
    await put("a.md", afterA);
    expect((await engine(["a.md", "b.md"]).recover("conflicted")).status).toBe("rolled_back");
    expect(await current("a.md")).toEqual(a);
    expect(await current("b.md")).toEqual(b);
  });
});

describe("backup integrity and scope are checked before Vault mutation", () => {
  it("recovers from a verified plan when the separate state file is absent", async () => {
    const before = Buffer.from(`\ufeff${PRIVATE_TEXT}\r\n`);
    await put("a.md", before);
    const tool = engine(["a.md"]);
    await tool.apply("missing-state", "synthetic", [update("a.md", before, Buffer.from("migrated"))]);
    await rm(join(backupRoot, "missing-state", "state.json"));
    expect((await tool.recover("missing-state")).status).toBe("rolled_back");
    expect(await current("a.md")).toEqual(before);
  });

  it.each(["invalid JSON", "unknown version"])("does not overwrite targets or a saved state containing %s during recover", async (corruption) => {
    const before = Buffer.from("original");
    const after = Buffer.from(PRIVATE_TEXT);
    await put("a.md", before);
    const tool = engine(["a.md"]);
    await tool.apply("corrupt-state", "synthetic", [update("a.md", before, after)]);
    const statePath = join(backupRoot, "corrupt-state", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const corruptState = corruption === "invalid JSON" ? `{"private":"${PRIVATE_TEXT}"` : JSON.stringify({ ...state, version: 2 });
    await writeFile(statePath, corruptState);
    const originalPlan = await plan("corrupt-state");
    await rejected(() => tool.recover("corrupt-state"));
    expect(await current("a.md")).toEqual(after);
    expect(await readFile(statePath, "utf8")).toBe(corruptState);
    expect(await plan("corrupt-state")).toEqual(originalPlan);
  });

  it.each(["snapshot-v1", "restore-forged"])("rejects the reserved migration id %s in ordinary apply", async (migrationId) => {
    await rejected(() => engine(["a.md"]).apply("reserved-id", migrationId, [update("a.md", null, Buffer.from(PRIVATE_TEXT))]));
    expect(await current("a.md")).toBeNull();
    expect(existsSync(join(backupRoot, "reserved-id", "plan.json"))).toBe(false);
  });

  it("converts filesystem failures into public errors without exposing private paths", async () => {
    await rejected(() => new OfflineRecovery({
      vaultRoot: join(root, PRIVATE_TEXT), backupRoot, allowedPaths: ["a.md"]
    }).snapshot("missing-vault"));
  });

  it.each(["invalid JSON", "unknown version", "corrupt base64", "changed hash", "changed fingerprint"])("rejects a backup with %s", async (corruption) => {
    const before = Buffer.from(PRIVATE_TEXT);
    const manual = Buffer.from("current user revision");
    await put("a.md", before);
    const tool = engine(["a.md"]);
    await tool.snapshot("protected-snapshot");
    const stored = await plan("protected-snapshot");
    if (corruption === "unknown version") stored.version = 2;
    if (corruption === "corrupt base64") stored.changes[0].before!.data = "!not-base64!";
    if (corruption === "changed hash") stored.changes[0].before!.hash = "0".repeat(64);
    if (corruption === "changed fingerprint") stored.fingerprint = "0".repeat(64);
    await writeFile(join(backupRoot, "protected-snapshot", "plan.json"), corruption === "invalid JSON"
      ? `{"private":"${PRIVATE_TEXT}"` : JSON.stringify(stored));
    await put("a.md", manual);
    await rejected(() => tool.restore("protected-snapshot", "restore-corrupt"));
    expect(await current("a.md")).toEqual(manual);
  });

  it.each(["../outside.md", "./a.md", "dir/../a.md", "/absolute.md", "dir//a.md"])("rejects a non-canonical allowed path %s", async (path) => {
    await rejected(() => engine([path]).snapshot("unsafe-path"));
    expect(existsSync(join(root, "outside.md"))).toBe(false);
  });

  it("refuses updates outside the allowlist and duplicate update paths", async () => {
    const tool = engine(["a.md"]);
    await rejected(() => tool.apply("not-allowed", "synthetic", [update("other.md", null, Buffer.from(PRIVATE_TEXT))]));
    await rejected(() => tool.apply("duplicate", "synthetic", [update("a.md", null, Buffer.from("one")), update("a.md", null, Buffer.from("two"))]));
    expect(await current("other.md")).toBeNull();
    expect(await current("a.md")).toBeNull();
  });

  it("rejects overlapping file paths and unsafe batch ids", async () => {
    await rejected(() => engine(["nested", "nested/a.md"]).snapshot("overlap"));
    await rejected(() => engine(["a.md"]).snapshot("../escaped-batch"));
    expect(existsSync(join(root, "escaped-batch"))).toBe(false);
  });

  it.each(["same root", "backup inside Vault", "Vault inside backup"])("rejects %s", async (relationship) => {
    const options = relationship === "same root" ? { vaultRoot, backupRoot: vaultRoot }
      : relationship === "backup inside Vault" ? { vaultRoot, backupRoot: join(vaultRoot, "backups") }
        : { vaultRoot, backupRoot: root };
    await rejected(() => new OfflineRecovery({ ...options, allowedPaths: ["a.md"] }).snapshot("overlap"));
    expect(await current("a.md")).toBeNull();
  });

  it.each(["file", "ancestor"])("rejects a symlink at the %s boundary", async (kind) => {
    const external = join(root, "external");
    await mkdir(external);
    await writeFile(join(external, "a.md"), PRIVATE_TEXT);
    const path = kind === "file" ? "a.md" : "linked/a.md";
    await symlink(kind === "file" ? join(external, "a.md") : external, join(vaultRoot, kind === "file" ? "a.md" : "linked"));
    await rejected(() => engine([path]).apply("symlink", "synthetic", [update(path, Buffer.from(PRIVATE_TEXT), Buffer.from("overwrite"))]));
    expect(await readFile(join(external, "a.md"), "utf8")).toBe(PRIVATE_TEXT);
  });

  it("rejects a hard-linked Vault file", async () => {
    const external = join(root, "external.md");
    await writeFile(external, PRIVATE_TEXT);
    await link(external, join(vaultRoot, "a.md"));
    await rejected(() => engine(["a.md"]).apply("hardlink", "synthetic", [update("a.md", Buffer.from(PRIVATE_TEXT), Buffer.from("overwrite"))]));
    expect(await readFile(external, "utf8")).toBe(PRIVATE_TEXT);
    expect(await current("a.md")).toEqual(Buffer.from(PRIVATE_TEXT));
  });

  it("cannot release a live tool lock or bypass its token", async () => {
    const token = "synthetic-live-lock-token";
    await writeFile(join(backupRoot, ".lock.json"), JSON.stringify({ pid: process.pid, token }));
    const tool = engine(["a.md"]);
    await rejected(() => tool.snapshot("locked"));
    await rejected(() => tool.releaseStaleLock("wrong-token"));
    await rejected(() => tool.releaseStaleLock(token));
    expect(JSON.parse(await readFile(join(backupRoot, ".lock.json"), "utf8"))).toEqual({ pid: process.pid, token });
    expect(await current("a.md")).toBeNull();
  });
});

describe("synthetic LifeOps metadata survives migration and restoration", () => {
  it("preserves task metadata, mixed legacy memory, revisions, source ids, feedback, and Ledger snapshots", async () => {
    const task = {
      id: "task-stable-id", title: "Synthetic review", status: "completed", repeatUnit: "week", repeatInterval: 2,
      parentTaskId: "task-series", sourceNotePath: "日记/2026-09-09早.md", source: "manual", priority: "high",
      note: PRIVATE_TEXT, completionLog: [{ completedAt: "2026-09-09T09:30:00Z", note: "Synthetic completed note" }],
      createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-09T09:30:00Z", sortOrder: 7
    };
    const taskBytes = Buffer.from(`\ufeff${JSON.stringify({ tasks: [task] }, null, 2)}\r\n`);
    const records: Record<string, Buffer> = {
      "任务/LifeOps任务库.json": taskBytes,
      "Memory/memory-index.json": Buffer.from(JSON.stringify([
        { id: "legacy-confirmed", content: "Synthetic long-standing preference", sourceType: "user", status: "active", evidenceRefs: ["source-123"] },
        { id: "legacy-inferred", content: "Synthetic candidate", sourceType: "inferred", status: "candidate", confidence: 0.4 }
      ])),
      "Memory/personal-memory.json": Buffer.from(JSON.stringify({ version: 1, updatedAt: "2026-09-09T00:00:00Z", records: [
        { id: "memory-old", revision: 1, status: "superseded", content: "Synthetic earlier belief", supersededBy: "memory-new" },
        { id: "memory-new", revision: 2, status: "active", content: "Synthetic corrected belief", supersedes: "memory-old", evidenceRefs: [{ sourceId: "source-123", path: "日记/2026-09-09早.md" }] }
      ] })),
      "Index/source-manifest.json": Buffer.from(JSON.stringify({ version: 1, updatedAt: "2026-09-09T00:00:00Z", entries: [
        { sourceId: "source-123", path: "日记/2026-09-09早.md", contentHash: "source-revision-4", status: "active", previousPaths: ["日记/old.md"] }
      ] })),
      "Proactive/policy-state.json": Buffer.from(JSON.stringify({ version: 1,
        deliveries: [{ candidateId: "nudge-1", deliveredAt: "2026-09-09T08:00:00Z", kind: "work" }],
        feedback: [{ candidateId: "nudge-1", value: "dismissed", note: "Synthetic too busy" }], mutedKinds: ["trading"]
      })),
      "Operations/operation-ledger.json": Buffer.from(JSON.stringify({ version: 1, records: [{
        operationId: "operation-stable-id", toolName: "create_task", source: "system", status: "verified", attempts: 1,
        arguments: { title: task.title }, result: { success: true, output: "Synthetic result", actions: [],
          undo: { kind: "restore_files", files: [
            { path: "任务/LifeOps任务库.json", existed: true, content: taskBytes.toString("utf8") },
            { path: "日记/new.md", existed: false, content: "" }
          ] }
        }
      }] }))
    };
    for (const [path, bytes] of Object.entries(records)) await put(path, bytes);
    const tool = engine(Object.keys(records));
    await tool.snapshot("lifeops-fixture-baseline");
    const updates = Object.entries(records).map(([path, bytes]) => update(path, bytes, Buffer.concat([bytes, Buffer.from("\n")])));
    await tool.apply("lifeops-fixture-migration", "synthetic-add-terminal-newline", updates);
    for (const item of updates) expect(await current(item.path)).toEqual(item.after);
    await tool.restore("lifeops-fixture-baseline", "lifeops-fixture-restored");
    for (const [path, bytes] of Object.entries(records)) {
      expect(await current(path)).toEqual(bytes);
      const saved = (await plan("lifeops-fixture-migration")).changes.find((change) => change.path === path);
      expect(saved?.before?.data).toBe(bytes.toString("base64"));
      const restoration = (await plan("lifeops-fixture-restored")).changes.find((change) => change.path === path);
      expect(restoration?.before?.data).toBe(Buffer.concat([bytes, Buffer.from("\n")]).toString("base64"));
    }
  });
});
