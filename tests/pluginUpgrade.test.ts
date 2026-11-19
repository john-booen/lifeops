import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OfflineRecovery, revisionHash } from "../src/dataFoundation/offlineRecovery";
import { planLedgerRevertV1, type OperationLedgerRecord } from "../src/dataFoundation/operationLedger";
import { encodeFactRecovery } from "../src/dataFoundation/recoveryEncoding";
import type { RecoveryDocument } from "../src/dataFoundation/factOperation";
// @ts-expect-error Offline operator JavaScript is checked by its behavioral tests.
import { applyPluginUpgrade, completePluginUpgrade, loadUpgradePackage, planPluginUpgrade, PLUGIN_FILES, rollbackPluginUpgrade, stagePluginUpgrade } from "../scripts/plugin-upgrade.mjs";

let root: string, source: string, staged: string, vault: string, plugin: string;
const identity = { id: "lifeops-assistant", version: "0.1.0", isDesktopOnly: true };
const original = { "main.js": "original-plugin", "manifest.json": JSON.stringify(identity), "styles.css": "original-styles" };
const next = { ...original, "main.js": "candidate-plugin", "styles.css": "candidate-styles" };
type Artifact = keyof typeof original;
const walPath = "LifeOps/Output/AI/Operations/write-recovery.json";
function compatibility(expectedHash: string | null = null, oldMain: string | Buffer = original["main.js"], newMain: string | Buffer = next["main.js"]) {
  return { vaultRoot: vault, relativePath: walPath, expectedHash, pathEvidence: "This fictional fixture uses the exact Runtime recovery path; no settings discovery",
    readers: [{ mainSha256: revisionHash(Buffer.from(oldMain)), wireVersions: [1, 2], ledgerUndoKinds: [], evidence: "Fictional legacy reader capability attestation" },
      { mainSha256: revisionHash(Buffer.from(newMain)), wireVersions: [1, 2, 3], ledgerUndoKinds: ["ledger-revert-v1"], evidence: "Fictional compatible reader capability attestation" }] };
}
function options(extra = {}) { return { vaultRoot: vault, backupRoot: join(root, "backup"), batchId: "upgrade-one", vaultClosed: true, authorization: "Synthetic rehearsal only", recoveryCompatibility: compatibility(), ...extra }; }
async function seedWal(version: 1 | 2 | 3 = 3, status: RecoveryDocument["status"] = "committed") {
  let document: RecoveryDocument = { version: 1, status, operationId: "fictional-upgrade-operation", entries: [] };
  if (version === 2) document.entries = [{ path: "纯虚构.md", before: "a".repeat(90_000), after: null, beforeHash: revisionHash(Buffer.from("a".repeat(90_000)))!, afterHash: "absent" }];
  if (version === 3) {
    const time = "2026-10-09T00:00:00.000Z", id = "fictional-saved";
    const record: OperationLedgerRecord = { operationId: id, fingerprint: "f".repeat(64), toolName: "create_idea", source: "system", status: "verified", attempts: 1,
      arguments: {}, createdAt: time, updatedAt: time, result: { success: true, output: "纯虚构", actions: [], undo: { kind: "restore_guarded_files", files: [] } } };
    const before = JSON.stringify({ version: 1, records: [record], retainedFictionalHistory: "精确保留" });
    const after = `${JSON.stringify(planLedgerRevertV1(JSON.parse(before), id, time).document)}\n`;
    document = { ...document, operationId: `undo:${id}`, auditId: id, auditStatus: "reverted", ledgerUndo: { kind: "ledger-revert-v1", path: "LifeOps/Output/AI/Operations/operation-ledger.json",
      before, beforeHash: revisionHash(Buffer.from(before))!, afterHash: revisionHash(Buffer.from(after))!, timestamp: time } };
  }
  const raw = encodeFactRecovery(document); expect(JSON.parse(raw).version).toBe(version);
  await mkdir(join(vault, "LifeOps/Output/AI/Operations"), { recursive: true }); await writeFile(join(vault, walPath), raw);
  return { raw, review: compatibility(revisionHash(Buffer.from(raw))) };
}
async function installed() { return Promise.all((PLUGIN_FILES as Artifact[]).map(name => readFile(join(plugin, name), "utf8"))); }
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "lifeops-plugin-upgrade-")));
  source = join(root, "candidate-source"); staged = join(root, "package"); vault = join(root, "synthetic-vault"); plugin = join(vault, ".obsidian/plugins/lifeops-assistant");
  await mkdir(join(source, "candidate"), { recursive: true }); await mkdir(plugin, { recursive: true });
  for (const name of PLUGIN_FILES as Artifact[]) { await writeFile(join(source, "candidate", name), next[name]); await writeFile(join(plugin, name), original[name]); }
  await writeFile(join(source, "candidate-manifest.json"), JSON.stringify({ candidate: "SYNTHETIC-01", artifacts: (PLUGIN_FILES as Artifact[]).map(path => ({ path, sha256: revisionHash(Buffer.from(next[path])) })) }));
  await writeFile(join(plugin, "data.json"), "synthetic-config-must-stay");
  await writeFile(join(vault, "diary.md"), "synthetic-user-diary-must-stay");
  await writeFile(join(vault, ".obsidian/community-plugins.json"), '["lifeops-assistant"]');
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function stagedPlan() { await stagePluginUpgrade(source, staged); return planPluginUpgrade(vault, staged); }

// Real fsync, large snapshots and subprocess recovery can exceed five seconds on hosted Intel disks.
describe("reviewed plugin upgrade rehearsal", { timeout: 30_000 }, () => {
  it("stages exactly three frozen artifacts and does not include user settings", async () => {
    const result = await stagePluginUpgrade(source, staged);
    expect(result.candidate).toBe("SYNTHETIC-01");
    expect((await readdir(staged)).sort()).toEqual([...PLUGIN_FILES, "upgrade-package.json"].sort());
    expect(await installed()).toEqual(Object.values(original));
    await expect(stagePluginUpgrade(source, staged)).rejects.toThrow();
  });
  it("upgrades and recovers realistic 10 MiB plugin binaries without weakening file limits", async () => {
    const oldMain = Buffer.alloc(10 * 1024 * 1024, 65), newMain = Buffer.alloc(10 * 1024 * 1024, 66);
    await writeFile(join(plugin, "main.js"), oldMain);
    await writeFile(join(source, "candidate/main.js"), newMain);
    const file = join(source, "candidate-manifest.json"), manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.artifacts.find((item: { path: string }) => item.path === "main.js").sha256 = revisionHash(newMain);
    await writeFile(file, JSON.stringify(manifest));
    const defaultRecovery = new OfflineRecovery({ vaultRoot: plugin, backupRoot: join(root, "default-limit-backup"), allowedPaths: PLUGIN_FILES });
    await expect(defaultRecovery.apply("default-limit", "synthetic-large-plugin", [{ path: "main.js", expectedHash: revisionHash(oldMain), after: newMain }]))
      .rejects.toMatchObject({ code: "plan_too_large" });
    expect(revisionHash(await readFile(join(plugin, "main.js")))).toBe(revisionHash(oldMain));
    const plan = await stagedPlan();
    const largeReview = compatibility(null, oldMain, newMain), largeOptions = options({ recoveryCompatibility: largeReview });
    expect(await applyPluginUpgrade(plan, staged, largeOptions)).toMatchObject({ status: "applied" });
    expect(revisionHash(await readFile(join(plugin, "main.js")))).toBe(revisionHash(newMain));
    expect(await applyPluginUpgrade(plan, staged, largeOptions)).toMatchObject({ status: "applied" });
    expect(await rollbackPluginUpgrade(largeOptions)).toMatchObject({ status: "rolled_back" });
    expect(revisionHash(await readFile(join(plugin, "main.js")))).toBe(revisionHash(oldMain));
    const nextOptions = options({ batchId: "after-large-rollback", recoveryCompatibility: largeReview });
    expect(await applyPluginUpgrade(plan, staged, nextOptions)).toMatchObject({ status: "applied" });
    expect(await rollbackPluginUpgrade(nextOptions)).toMatchObject({ status: "rolled_back" });
  });
  it.each([0, 65 * 1024 * 1024, NaN, 16 * 1024 * 1024 + 0.5])("rejects an unsafe recovery journal bound %s", maxPlanBytes => {
    expect(() => new OfflineRecovery({ vaultRoot: plugin, backupRoot: join(root, "backup"), allowedPaths: PLUGIN_FILES, maxPlanBytes }))
      .toThrow("invalid_plan_limit");
  });
  it("retains an empty failed preparation directory while allowing a new reviewed batch", async () => {
    const plan = await stagedPlan(); await mkdir(join(root, "backup/empty-failed-prepare"), { recursive: true });
    expect(await applyPluginUpgrade(plan, staged, options())).toMatchObject({ status: "applied" });
    expect(await readdir(join(root, "backup/empty-failed-prepare"))).toEqual([]);
  });
  it.each(["missing-plan", "mismatched-plan"])("rejects damaged nonempty recovery evidence: %s", async kind => {
    const plan = await stagedPlan();
    const previous = join(root, "backup/previous"); await mkdir(previous, { recursive: true });
    await writeFile(join(previous, "state.json"), JSON.stringify({ version: 1, status: "applied", fingerprint: "a".repeat(64) }));
    if (kind === "mismatched-plan") await writeFile(join(previous, "plan.json"), JSON.stringify({ version: 1, fingerprint: "b".repeat(64) }));
    await expect(applyPluginUpgrade(plan, staged, options())).rejects.toMatchObject({ code: "apply_failed_rolled_back" });
    expect(await installed()).toEqual(Object.values(original));
  });
  it("upgrades, repeats safely and restores only the reviewed plugin artifacts", async () => {
    const plan = await stagedPlan();
    expect(await applyPluginUpgrade(plan, staged, options())).toMatchObject({ status: "applied", files: 3 });
    expect(await installed()).toEqual(Object.values(next));
    expect(await applyPluginUpgrade(plan, staged, options())).toMatchObject({ status: "applied" });
    // Simulate a later diary edit: plugin rollback must never rewind personal data.
    await writeFile(join(vault, "diary.md"), "later-user-edit");
    expect(await rollbackPluginUpgrade(options())).toMatchObject({ status: "rolled_back" });
    expect(await installed()).toEqual(Object.values(original));
    expect(await readFile(join(vault, "diary.md"), "utf8")).toBe("later-user-edit");
    expect(await readFile(join(plugin, "data.json"), "utf8")).toBe("synthetic-config-must-stay");
    expect(await readFile(join(vault, ".obsidian/community-plugins.json"), "utf8")).toBe('["lifeops-assistant"]');
  });
  it.each([1, 2, 3])("automatically restores after failure at replacement %i", async failAt => {
    const plan = await stagedPlan();
    let writes = 0;
    await expect(applyPluginUpgrade(plan, staged, options({ onStep: ({ stage }: { stage: string }) => { if (stage === "after-write" && ++writes === failAt) throw new Error("synthetic failure"); } }))).rejects.toMatchObject({ code: "apply_failed_rolled_back" });
    expect(await installed()).toEqual(Object.values(original));
  });
  it("shares the target lock even when concurrent requests choose different backup roots", async () => {
    const plan = await stagedPlan();
    let release!: () => void, prepared!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { prepared = resolve; });
    const first = applyPluginUpgrade(plan, staged, options({ onStep: async ({ stage }: { stage: string }) => {
      if (stage === "prepared") { prepared(); await hold; }
    } }));
    await ready;
    try { await expect(applyPluginUpgrade(plan, staged, options({ backupRoot: join(root, "other-backup") }))).rejects.toMatchObject({ code: "EEXIST" }); }
    finally { release(); }
    expect(await first).toMatchObject({ status: "applied" });
    expect(await installed()).toEqual(Object.values(next));
  });
  it("blocks a fresh upgrade while an earlier batch needs recovery", async () => {
    const plan = await stagedPlan(); await applyPluginUpgrade(plan, staged, options());
    const statePath = join(root, "backup/upgrade-one/state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")); state.status = "recovery_required";
    await writeFile(statePath, JSON.stringify(state));
    const freshPlan = await planPluginUpgrade(vault, staged);
    await expect(applyPluginUpgrade(freshPlan, staged, options({ batchId: "upgrade-two" }))).rejects.toMatchObject({ code: "apply_failed_rolled_back" });
    expect(await installed()).toEqual(Object.values(next));
  });
  it("cannot hide interrupted recovery by choosing another backup directory", async () => {
    const plan = await stagedPlan();
    await expect(applyPluginUpgrade(plan, staged, options({ onStep: ({ stage }: { stage: string }) => {
      if (stage === "after-write" || stage === "before-restore") throw new Error("synthetic interrupted recovery");
    } }))).rejects.toMatchObject({ code: "recovery_required" });
    const partial = await installed();
    const freshPlan = await planPluginUpgrade(vault, staged);
    await expect(applyPluginUpgrade(freshPlan, staged, options({ backupRoot: join(root, "other-backup"), batchId: "new-upgrade" })))
      .rejects.toThrow("different recovery namespace");
    expect(await installed()).toEqual(partial);
    expect(await rollbackPluginUpgrade(options())).toMatchObject({ status: "rolled_back" });
    expect(await installed()).toEqual(Object.values(original));
  });
  it("refuses to overwrite plugin edits made after the plan was reviewed", async () => {
    const plan = await stagedPlan(); await writeFile(join(plugin, "main.js"), "external-newer-version");
    await expect(applyPluginUpgrade(plan, staged, options())).rejects.toThrow();
    expect(await readFile(join(plugin, "main.js"), "utf8")).toBe("external-newer-version");
  });
  it("refuses rollback across a newer plugin edit while retaining recovery evidence", async () => {
    const plan = await stagedPlan(); await applyPluginUpgrade(plan, staged, options());
    await writeFile(join(plugin, "main.js"), "external-newer-version");
    await expect(rollbackPluginUpgrade(options())).rejects.toMatchObject({ code: "recovery_required" });
    expect(await readFile(join(plugin, "main.js"), "utf8")).toBe("external-newer-version");
    const recovery = JSON.parse(await readFile(join(root, "backup/upgrade-one/plan.json"), "utf8"));
    expect(recovery.changes.find((item: { path: string }) => item.path === "main.js").before.hash)
      .toBe(revisionHash(Buffer.from(original["main.js"])));
  });
  it.each([{ vaultClosed: false }, { authorization: "" }, { batchId: "../outside" }])("rejects missing operation requirements %j", async extra => {
    const plan = await stagedPlan(); await expect(applyPluginUpgrade(plan, staged, options(extra))).rejects.toThrow();
    expect(await installed()).toEqual(Object.values(original));
  });
  it("rejects a backup directory anywhere inside the vault", async () => {
    const plan = await stagedPlan();
    await expect(applyPluginUpgrade(plan, staged, options({ backupRoot: join(vault, "notes/backups") }))).rejects.toThrow("outside");
  });
  it("rejects frozen-candidate corruption before staging any package", async () => {
    await writeFile(join(source, "candidate/main.js"), "changed");
    await expect(stagePluginUpgrade(source, staged)).rejects.toThrow("hash mismatch");
    await expect(readdir(staged)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects package corruption after plan creation", async () => {
    const plan = await stagedPlan(); await writeFile(join(staged, "styles.css"), "changed");
    await expect(applyPluginUpgrade(plan, staged, options())).rejects.toThrow("artifact changed");
    expect(await installed()).toEqual(Object.values(original));
  });
  it.each(["data.json", "../outside", "main.js"])("rejects changed file scope %s", async replacement => {
    await stagePluginUpgrade(source, staged); const path = join(staged, "upgrade-package.json");
    const metadata = JSON.parse(await readFile(path, "utf8")); metadata.files[2].path = replacement;
    await writeFile(path, JSON.stringify(metadata)); await expect(loadUpgradePackage(staged)).rejects.toThrow();
  });
  it("refuses a changed target vault", async () => {
    const plan = await stagedPlan(); await expect(applyPluginUpgrade(plan, staged, options({ vaultRoot: join(root, "another-vault") }))).rejects.toThrow("Target differs");
  });
  it("refuses linked source artifacts and linked target plugin paths", async () => {
    await rm(join(source, "candidate/main.js")); await symlink(join(plugin, "main.js"), join(source, "candidate/main.js"));
    await expect(stagePluginUpgrade(source, staged)).rejects.toThrow();
    await rm(join(source, "candidate/main.js")); await writeFile(join(source, "candidate/main.js"), next["main.js"]);
    await stagePluginUpgrade(source, staged); await rm(join(plugin, "styles.css")); await symlink(join(source, "candidate/styles.css"), join(plugin, "styles.css"));
    await expect(planPluginUpgrade(vault, staged)).rejects.toThrow();
  });

  it.each(["committed", "rolled_back", "pending"] as const)("refuses legacy rollback with retained v3 %s without touching programs or WAL", async status => {
    const plan = await stagedPlan(); await applyPluginUpgrade(plan, staged, options());
    const { raw, review } = await seedWal(3, status), programs = await installed(), backup = await readFile(join(root, "backup/upgrade-one/state.json"));
    await expect(rollbackPluginUpgrade(options({ recoveryCompatibility: review }))).rejects.toThrow("cannot read retained recovery WAL");
    expect(await installed()).toEqual(programs); expect(await readFile(join(vault, walPath), "utf8")).toBe(raw);
    expect(await readFile(join(root, "backup/upgrade-one/state.json"))).toEqual(backup);
  });
  it.each([1, 2] as const)("allows a settled legacy-compatible v%s WAL rollback, preserving facts and the raw WAL", async version => {
    const plan = await stagedPlan(); await applyPluginUpgrade(plan, staged, options()); const { raw, review } = await seedWal(version);
    expect(await rollbackPluginUpgrade(options({ recoveryCompatibility: review }))).toMatchObject({ status: "rolled_back" });
    expect(await installed()).toEqual(Object.values(original)); expect(await readFile(join(vault, walPath), "utf8")).toBe(raw);
    expect(await readFile(join(vault, "diary.md"), "utf8")).toBe("synthetic-user-diary-must-stay");
  });
  it("allows settled v3 rollback to an exact reviewed compatible original reader", async () => {
    const plan = await stagedPlan(); await applyPluginUpgrade(plan, staged, options()); const { raw, review } = await seedWal();
    review.readers[0].wireVersions = [1, 2, 3]; review.readers[0].ledgerUndoKinds = ["ledger-revert-v1"];
    expect(await rollbackPluginUpgrade(options({ recoveryCompatibility: review }))).toMatchObject({ status: "rolled_back" });
    expect(await installed()).toEqual(Object.values(original)); expect(await readFile(join(vault, walPath), "utf8")).toBe(raw);
  });
  it("requires settling pending fact recovery before any rollback even with a compatible original", async () => {
    const plan = await stagedPlan(); await applyPluginUpgrade(plan, staged, options()); const { raw, review } = await seedWal(1, "pending");
    await expect(rollbackPluginUpgrade(options({ recoveryCompatibility: review }))).rejects.toThrow("Settle pending");
    expect(await installed()).toEqual(Object.values(next)); expect(await readFile(join(vault, walPath), "utf8")).toBe(raw);
  });
  it("allows upgrading to a reviewed v3 reader while v3 recovery is pending", async () => {
    const plan = await stagedPlan(), { raw, review } = await seedWal(3, "pending");
    expect(await applyPluginUpgrade(plan, staged, options({ recoveryCompatibility: review }))).toMatchObject({ status: "applied" });
    expect(await installed()).toEqual(Object.values(next)); expect(await readFile(join(vault, walPath), "utf8")).toBe(raw);
  });
  it("rejects applying an older package across a retained v3 journal before replacement", async () => {
    const plan = await stagedPlan(), { raw, review } = await seedWal(); review.readers[1].wireVersions = [1, 2]; review.readers[1].ledgerUndoKinds = [];
    await expect(applyPluginUpgrade(plan, staged, options({ recoveryCompatibility: review }))).rejects.toThrow("cannot read retained recovery WAL");
    expect(await installed()).toEqual(Object.values(original)); expect(await readFile(join(vault, walPath), "utf8")).toBe(raw);
  });
  it("refuses incompatible automatic recovery after a compatible forward replacement fails", async () => {
    const plan = await stagedPlan(), { raw, review } = await seedWal();
    await expect(applyPluginUpgrade(plan, staged, options({ recoveryCompatibility: review, onStep: ({ stage }: { stage: string }) => {
      if (stage === "after-write") throw new Error("fictional forward failure");
    } }))).rejects.toMatchObject({ code: "recovery_required" });
    expect(await readFile(join(plugin, "main.js"), "utf8")).toBe(next["main.js"]);
    expect(await readFile(join(vault, walPath), "utf8")).toBe(raw);
    expect(JSON.parse(await readFile(join(root, "backup/upgrade-one/state.json"), "utf8")).status).toBe("recovery_required");
  });
  it.each(["missing-review", "wrong-vault", "wrong-main", "no-path-evidence", "no-reader-evidence", "unsupported-plan", "stale-hash"])("refuses incomplete or mismatched compatibility preconditions: %s", async kind => {
    const plan = await stagedPlan(); await applyPluginUpgrade(plan, staged, options()); const { raw, review } = await seedWal();
    review.readers[0].wireVersions = [1, 2, 3]; review.readers[0].ledgerUndoKinds = ["ledger-revert-v1"];
    if (kind === "wrong-vault") review.vaultRoot = root;
    if (kind === "wrong-main") review.readers[0].mainSha256 = "a".repeat(64);
    if (kind === "no-path-evidence") review.pathEvidence = "";
    if (kind === "no-reader-evidence") review.readers[0].evidence = "";
    if (kind === "unsupported-plan") review.readers[0].ledgerUndoKinds = [];
    if (kind === "stale-hash") review.expectedHash = "b".repeat(64);
    await expect(rollbackPluginUpgrade(options({ recoveryCompatibility: kind === "missing-review" ? undefined : review }))).rejects.toThrow();
    expect(await installed()).toEqual(Object.values(next)); expect(await readFile(join(vault, walPath), "utf8")).toBe(raw);
  });
  it.each(["../Operations/write-recovery.json", "/Operations/write-recovery.json", ".obsidian/plugins/lifeops-assistant/data.json", "输出//Operations/write-recovery.json", "输出/./Operations/write-recovery.json", "输出\\Operations\\write-recovery.json"])("rejects a recovery path outside the authorized path shape: %s", async relativePath => {
    const plan = await stagedPlan(), review = compatibility(); review.relativePath = relativePath;
    await expect(applyPluginUpgrade(plan, staged, options({ recoveryCompatibility: review }))).rejects.toThrow("Unsafe recovery review path");
    expect(await installed()).toEqual(Object.values(original)); expect(await readFile(join(plugin, "data.json"), "utf8")).toBe("synthetic-config-must-stay");
  });
  it.each(["symlink", "hardlink"])("refuses a %s WAL without reading its contents or replacing programs", async kind => {
    const plan = await stagedPlan(), { raw, review } = await seedWal();
    const saved = join(root, "linked-original"); await writeFile(saved, raw); await rm(join(vault, walPath));
    if (kind === "symlink") await symlink(saved, join(vault, walPath)); else await link(saved, join(vault, walPath));
    await expect(applyPluginUpgrade(plan, staged, options({ recoveryCompatibility: review }))).rejects.toThrow();
    expect(await installed()).toEqual(Object.values(original)); expect(await readFile(saved, "utf8")).toBe(raw);
  });
  it.each(["before-restore", "after-restore"])("detects a WAL edit inside operator %s and never overwrites that edit", async boundary => {
    const plan = await stagedPlan(); await applyPluginUpgrade(plan, staged, options()); const { review } = await seedWal(1);
    let edited = false;
    await expect(rollbackPluginUpgrade(options({ recoveryCompatibility: review, onStep: async ({ stage }: { stage: string }) => {
      if (!edited && stage === boundary) { edited = true; await writeFile(join(vault, walPath), "later-WAL-edit"); }
    } }))).rejects.toMatchObject({ code: "recovery_required" });
    expect(edited).toBe(true); expect(await readFile(join(vault, walPath), "utf8")).toBe("later-WAL-edit");
    if (boundary === "before-restore") expect(await installed()).toEqual(Object.values(next));
    expect(await readFile(join(plugin, "main.js"), "utf8")).toBe(next["main.js"]);
  });
  it("freezes caller review metadata so callback edits cannot approve a later WAL", async () => {
    const plan = await stagedPlan(), { review } = await seedWal(1); let edited = false;
    await expect(applyPluginUpgrade(plan, staged, options({ recoveryCompatibility: review, onStep: async ({ stage }: { stage: string }) => {
      if (!edited && stage === "before-write") { edited = true; const raw = '{"version":1,"status":"committed","operationId":"fictional-later","entries":[]}';
        await writeFile(join(vault, walPath), raw); review.expectedHash = revisionHash(Buffer.from(raw)); }
    } }))).rejects.toMatchObject({ code: "recovery_required" });
    expect(edited).toBe(true); expect(await installed()).toEqual(Object.values(original));
    expect(JSON.parse(await readFile(join(vault, walPath), "utf8")).operationId).toBe("fictional-later");
  });
  it.each(["unknown-version", "unknown-status", "malformed-json", "missing-entries", "invalid-utf8", "oversized", "unknown-v3-plan"])("rejects an unsafe WAL envelope before a compatible upgrade: %s", async kind => {
    const plan = await stagedPlan(), fixture = await seedWal(); const wire = JSON.parse(fixture.raw);
    if (kind === "unknown-version") wire.version = 4;
    if (kind === "unknown-status") wire.status = "complete";
    if (kind === "missing-entries") delete wire.entries;
    if (kind === "unknown-v3-plan") wire.ledgerUndo.kind = "ledger-revert-v2";
    const raw = kind === "malformed-json" ? Buffer.from("{") : kind === "invalid-utf8" ? Buffer.from([0xff])
      : kind === "oversized" ? Buffer.alloc(16 * 1024 * 1024 + 1, 65) : Buffer.from(JSON.stringify(wire));
    await writeFile(join(vault, walPath), raw); const review = compatibility(revisionHash(raw));
    await expect(applyPluginUpgrade(plan, staged, options({ recoveryCompatibility: review }))).rejects.toThrow();
    expect(await installed()).toEqual(Object.values(original)); expect((await readFile(join(vault, walPath))).equals(raw)).toBe(true);
    expect(await readFile(join(plugin, "data.json"), "utf8")).toBe("synthetic-config-must-stay");
  });
  it("refuses upgrade without a reviewed actual WAL path rather than guessing configuration", async () => {
    const plan = await stagedPlan();
    await expect(applyPluginUpgrade(plan, staged, options({ recoveryCompatibility: undefined }))).rejects.toThrow("Reviewed recovery compatibility is required");
    expect(await installed()).toEqual(Object.values(original));
    expect(await readFile(join(plugin, "data.json"), "utf8")).toBe("synthetic-config-must-stay");
  });
  it.each(["prepared", "before-write", "after-write"])("can complete the exact compatible upgrade after failure at %s without deleting or rewriting the WAL", async boundary => {
    const plan = await stagedPlan(), { raw, review } = await seedWal();
    await expect(applyPluginUpgrade(plan, staged, options({ recoveryCompatibility: review, onStep: ({ stage }: { stage: string }) => {
      if (stage === boundary) throw new Error("fictional compatible upgrade interruption");
    } }))).rejects.toMatchObject({ code: "recovery_required" });
    const backup = await readFile(join(root, "backup/upgrade-one/plan.json"));
    expect(await completePluginUpgrade(options({ recoveryCompatibility: review }))).toMatchObject({ status: "applied", files: 3 });
    expect(await installed()).toEqual(Object.values(next)); expect(await readFile(join(vault, walPath), "utf8")).toBe(raw);
    expect(await readFile(join(root, "backup/upgrade-one/plan.json"))).toEqual(backup);
    expect(await completePluginUpgrade(options({ recoveryCompatibility: review }))).toMatchObject({ status: "applied" });
    const nextPlan = await planPluginUpgrade(vault, staged);
    expect(await applyPluginUpgrade(nextPlan, staged, options({ batchId: "after-compatible-completion", recoveryCompatibility: review }))).toMatchObject({ status: "applied" });
    expect(await readFile(join(vault, "diary.md"), "utf8")).toBe("synthetic-user-diary-must-stay");
    expect(await readFile(join(plugin, "data.json"), "utf8")).toBe("synthetic-config-must-stay");
  });
  it("can complete a compatible upgrade with pending fact recovery while rollback remains blocked", async () => {
    const plan = await stagedPlan(), { raw, review } = await seedWal(3, "pending");
    await expect(applyPluginUpgrade(plan, staged, options({ recoveryCompatibility: review, onStep: ({ stage }: { stage: string }) => {
      if (stage === "before-write") throw new Error("fictional interrupted preparation");
    } }))).rejects.toMatchObject({ code: "recovery_required" });
    expect(await completePluginUpgrade(options({ recoveryCompatibility: review }))).toMatchObject({ status: "applied" });
    expect(await installed()).toEqual(Object.values(next)); expect(await readFile(join(vault, walPath), "utf8")).toBe(raw);
    await expect(rollbackPluginUpgrade(options({ recoveryCompatibility: review }))).rejects.toThrow();
    expect(await installed()).toEqual(Object.values(next));
  });
  it("refuses compatibility completion if any program has a later edit, before changing another file", async () => {
    const plan = await stagedPlan(), { raw, review } = await seedWal();
    await expect(applyPluginUpgrade(plan, staged, options({ recoveryCompatibility: review, onStep: ({ stage }: { stage: string }) => {
      if (stage === "before-write") throw new Error("fictional interrupted preparation");
    } }))).rejects.toMatchObject({ code: "recovery_required" });
    await writeFile(join(plugin, "styles.css"), "later-operator-style"); const files = await installed();
    await expect(completePluginUpgrade(options({ recoveryCompatibility: review }))).rejects.toMatchObject({ code: "recovery_required" });
    expect(await installed()).toEqual(files); expect(await readFile(join(vault, walPath), "utf8")).toBe(raw);
  });
  it("checks WAL changes within the forward completion boundary without restoring incompatible programs", async () => {
    const plan = await stagedPlan(), { review } = await seedWal();
    await expect(applyPluginUpgrade(plan, staged, options({ recoveryCompatibility: review, onStep: ({ stage }: { stage: string }) => {
      if (stage === "before-write") throw new Error("fictional interrupted preparation");
    } }))).rejects.toMatchObject({ code: "recovery_required" });
    let changed = false;
    await expect(completePluginUpgrade(options({ recoveryCompatibility: review, onStep: async ({ stage }: { stage: string }) => {
      if (!changed && stage === "before-write") { changed = true; await writeFile(join(vault, walPath), "later-WAL-edit"); }
    } }))).rejects.toMatchObject({ code: "recovery_required" });
    expect(changed).toBe(true); expect(await installed()).toEqual(Object.values(original));
    expect(await readFile(join(vault, walPath), "utf8")).toBe("later-WAL-edit");
  });
  it("binds completion to the exact after program backed up in this batch", async () => {
    const plan = await stagedPlan(); await applyPluginUpgrade(plan, staged, options()); const { raw, review } = await seedWal();
    review.readers[1].mainSha256 = "a".repeat(64);
    await expect(completePluginUpgrade(options({ recoveryCompatibility: review }))).rejects.toThrow("Exact target program");
    expect(await installed()).toEqual(Object.values(next)); expect(await readFile(join(vault, walPath), "utf8")).toBe(raw);
  });
  it("refuses to complete an already applied batch across a later program edit even when it equals before", async () => {
    const plan = await stagedPlan(); await applyPluginUpgrade(plan, staged, options());
    await writeFile(join(plugin, "main.js"), original["main.js"]); const files = await installed(), state = await readFile(join(root, "backup/upgrade-one/state.json"));
    await expect(completePluginUpgrade(options())).rejects.toMatchObject({ code: "target_conflict" });
    expect(await installed()).toEqual(files); expect(await readFile(join(root, "backup/upgrade-one/state.json"))).toEqual(state);
  });
  it("does not undo an intentional settled rollback by completing the old batch", async () => {
    const plan = await stagedPlan(); await applyPluginUpgrade(plan, staged, options()); await rollbackPluginUpgrade(options());
    const state = await readFile(join(root, "backup/upgrade-one/state.json"));
    await expect(completePluginUpgrade(options())).rejects.toMatchObject({ code: "batch_already_rolled_back" });
    expect(await installed()).toEqual(Object.values(original)); expect(await readFile(join(root, "backup/upgrade-one/state.json"))).toEqual(state);
  });
});
