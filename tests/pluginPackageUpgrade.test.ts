import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OfflineRecovery, revisionHash } from "../src/dataFoundation/offlineRecovery";
// @ts-expect-error Node-only JavaScript operator is validated by behavioral tests.
import { applyFullPluginUpgrade, completeFullPluginUpgrade, FULL_PLUGIN_FILES, LEGACY_FULL_PLUGIN_FILES, LEGACY_INSTALLED_12_FILES, loadReviewedPluginPackage, planFullPluginUpgrade, rollbackFullPluginUpgrade, planLegacyInstalledSnapshotUpgrade, applyLegacyInstalledSnapshotUpgrade } from "../scripts/plugin-package-upgrade.mjs";
// @ts-expect-error Node-only legacy operator.
import { completePluginUpgrade, PLUGIN_FILES, rollbackPluginUpgrade, withPluginUpgradeTargetLock } from "../scripts/plugin-upgrade.mjs";

type Catalog = { directory: string; files: { path: string; sha256: string; mode: number; size: number }[] };
type Entry = { path: string; before: { hash: string; mode: number; size: number } | null; after: { hash: string; mode: number; size: number } | null };
let root: string, vault: string, plugin: string, old: Catalog, next: Catalog;
const NATIVE = "native/lifeops-work-window", paths: string[] = FULL_PLUGIN_FILES;
const LICENSES = ["LICENSE", "mediapipe/LICENSE-2.0.txt"];
async function makePackage(name: string, native: boolean, label: string, mode = 0o644, licensed = true): Promise<Catalog> {
  const directory = join(root, name); await mkdir(directory);
  const contents = new Map<string, Buffer>();
  contents.set("main.js", Buffer.from(`${label}: fictional program`));
  contents.set("manifest.json", Buffer.from(JSON.stringify({ id: "lifeops-assistant", version: "0.1.0", isDesktopOnly: true })));
  contents.set("styles.css", Buffer.from(`${label}: fictional styles`));
  if (licensed) contents.set("LICENSE", Buffer.from("fictional project license"));
  for (const path of paths.filter(p => (p.startsWith("mediapipe/") && (licensed || !LICENSES.includes(p))) || (native && p === NATIVE))) contents.set(path, Buffer.from(`fictional resource: ${path}`));
  contents.set("RESOURCE-MANIFEST.json", Buffer.from(JSON.stringify({ schemaVersion: 1,
    files: [...contents].filter(([p]) => p === "LICENSE" || p.startsWith("mediapipe/") || p === NATIVE)
      .map(([path, data]) => ({ path, sha256: revisionHash(data), sizeBytes: data.length, ...(path === NATIVE ? { mode: "0500" } : {}) })) })));
  contents.set("SHA256SUMS.txt", Buffer.from([...contents.keys()].sort().map(path => `${revisionHash(contents.get(path)!)}  ${path}\n`).join("")));
  const files = [];
  for (const [path, data] of contents) {
    const target = join(directory, path), wanted = path === NATIVE ? 0o500 : mode;
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, data); await chmod(target, wanted);
    files.push({ path, sha256: revisionHash(data)!, mode: wanted, size: data.length });
  }
  return { directory, files };
}
async function seed(pkg: Catalog) {
  for (const f of pkg.files) {
    await mkdir(dirname(join(plugin, f.path)), { recursive: true });
    await cp(join(pkg.directory, f.path), join(plugin, f.path)); await chmod(join(plugin, f.path), f.mode);
  }
}
async function reseed(pkg: Catalog) {
  for (const path of paths) await rm(join(plugin, path), { force: true });
  await seed(pkg);
}
// Historical fixtures use the fixed 14-path generation, never today's list.
async function historicalJournal(batchId: string) {
  const before = await loadReviewedPluginPackage(old), after = await loadReviewedPluginPackage(next);
  const tool = new OfflineRecovery({ vaultRoot: plugin, backupRoot: join(root, "backups"), allowedPaths: LEGACY_FULL_PLUGIN_FILES, artifactStorage: { maxTotalBytes: 128 * 1024 * 1024 } });
  const updates = (LEGACY_FULL_PLUGIN_FILES as string[]).map(path => {
    const a = before.inventory.find((x: { path: string }) => x.path === path)?.revision, b = after.inventory.find((x: { path: string }) => x.path === path)?.revision;
    return { path, expectedHash: a?.hash ?? null, expectedMode: a?.mode ?? null, after: after.contents.get(path) ?? null, ...(b ? { mode: b.mode } : {}) };
  });
  const opts = options({ batchId });
  await withPluginUpgradeTargetLock(opts, () => tool.apply(batchId, "plugin-package-upgrade-v2", updates), true);
  return { tool, opts };
}
const mainHash = (pkg: Catalog) => pkg.files.find(f => f.path === "main.js")!.sha256;
function options(extra = {}) {
  return { vaultRoot: vault, backupRoot: join(root, "backups"), batchId: "full-upgrade", vaultClosed: true, authorization: "Fictional full-package rehearsal",
    recoveryCompatibility: { vaultRoot: vault, relativePath: "fictional/Operations/write-recovery.json", expectedHash: null as string | null,
      pathEvidence: "Explicit fictional WAL path, no settings discovery",
      readers: [...new Set([mainHash(old), mainHash(next)])].map(mainSha256 => ({ mainSha256, wireVersions: [1, 2, 3], ledgerUndoKinds: ["ledger-revert-v1"], evidence: "Fictional exact reader review" })) }, ...extra };
}
async function installed() {
  const files = [];
  for (const path of paths) {
    try { files.push({ path, sha256: revisionHash(await readFile(join(plugin, path))), mode: (await stat(join(plugin, path))).mode & 0o7777 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return files;
}
const expected = (pkg: Catalog) => pkg.files.map(({ path, sha256, mode }) => ({ path, sha256, mode })).sort((a, b) => a.path.localeCompare(b.path));
const compare = async (pkg: Catalog) => expect((await installed()).sort((a, b) => a.path.localeCompare(b.path))).toEqual(expected(pkg));
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "lifeops-full-package-")));
  vault = join(root, "vault"); plugin = join(vault, ".obsidian/plugins/lifeops-assistant"); await mkdir(plugin, { recursive: true });
  old = await makePackage("old", true, "old"); next = await makePackage("next", false, "new", 0o600); await seed(old);
  await writeFile(join(plugin, "data.json"), "fictional settings"); await writeFile(join(vault, "diary.md"), "fictional diary");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function legacyInstalledSnapshot() {
  const pkg = await makePackage("installed-legacy", false, "historical", 0o644, false);
  await rm(join(pkg.directory, "RESOURCE-MANIFEST.json"));
  const sums = (await readFile(join(pkg.directory, "SHA256SUMS.txt"), "utf8"))
    .split("\n").filter(line => !line.endsWith("  RESOURCE-MANIFEST.json")).join("\n");
  await writeFile(join(pkg.directory, "SHA256SUMS.txt"), sums);
  // An early installation updated these programs without rewriting its sums.
  await writeFile(join(pkg.directory, "main.js"), "historical installed hotfix");
  await writeFile(join(pkg.directory, "styles.css"), "historical installed styles");
  old = { directory: pkg.directory, files: await Promise.all((LEGACY_INSTALLED_12_FILES as string[]).map(async path => {
    const bytes = await readFile(join(pkg.directory, path));
    return { path, sha256: revisionHash(bytes)!, size: bytes.length, mode: 0o644 };
  })) };
  await reseed(old);
  return { ...old, sourceKind: "reviewed-legacy-installed-12-v1", reviewEvidence: "Independently reviewed fictional early installation, including stale checksum bytes" };
}

// Real fsync, large snapshots and subprocess recovery can exceed five seconds on hosted Intel disks.
describe("explicit early installed-snapshot adoption", { timeout: 30_000 }, () => {
  it("adopts 12 to 15 files and restores the exact old checksum, modes and absences without losing later records", async () => {
    const snapshot = await legacyInstalledSnapshot(), originalSums = await readFile(join(plugin, "SHA256SUMS.txt"));
    const plan = await planLegacyInstalledSnapshotUpgrade(vault, snapshot, next);
    await applyLegacyInstalledSnapshotUpgrade(plan, next, options()); await compare(next);
    await writeFile(join(plugin, "data.json"), "later private settings"); await writeFile(join(vault, "diary.md"), "later diary");
    await writeFile(join(plugin, "unknown.txt"), "later unknown file");
    await rollbackFullPluginUpgrade(options()); await compare(old);
    expect(await readFile(join(plugin, "SHA256SUMS.txt"))).toEqual(originalSums);
    expect(await readFile(join(plugin, "data.json"), "utf8")).toBe("later private settings");
    expect(await readFile(join(vault, "diary.md"), "utf8")).toBe("later diary");
    expect(await readFile(join(plugin, "unknown.txt"), "utf8")).toBe("later unknown file");
    for (const path of ["RESOURCE-MANIFEST.json", ...LICENSES, NATIVE]) await expect(stat(join(plugin, path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the strict package route closed and requires the explicit installed discriminator", async () => {
    const snapshot = await legacyInstalledSnapshot();
    await expect(loadReviewedPluginPackage(snapshot)).rejects.toThrow();
    await expect(planFullPluginUpgrade(vault, snapshot, next)).rejects.toThrow();
    await expect(planLegacyInstalledSnapshotUpgrade(vault, { ...snapshot, sourceKind: "unreviewed" }, next)).rejects.toThrow();
    await expect(planLegacyInstalledSnapshotUpgrade(vault, snapshot, snapshot)).rejects.toThrow();
    const plan = await planLegacyInstalledSnapshotUpgrade(vault, snapshot, next);
    await expect(applyFullPluginUpgrade(plan, next, options())).rejects.toThrow();
    await expect(applyLegacyInstalledSnapshotUpgrade({ ...plan, sourceKind: "unreviewed" }, next, options())).rejects.toThrow();
    await compare(old);
  });

  it.each(["snapshot", "installed", "new-path"])("refuses changed %s bytes before target replacement", async kind => {
    const snapshot = await legacyInstalledSnapshot();
    const changed = kind === "snapshot" ? join(snapshot.directory, "main.js") : kind === "installed" ? join(plugin, "main.js") : join(plugin, "LICENSE");
    await writeFile(changed, "later unreviewed bytes"); const before = await installed();
    await expect(planLegacyInstalledSnapshotUpgrade(vault, snapshot, next)).rejects.toThrow();
    expect(await installed()).toEqual(before);
  });

  it("refuses a later installed change at apply time without overwriting it", async () => {
    const snapshot = await legacyInstalledSnapshot(), plan = await planLegacyInstalledSnapshotUpgrade(vault, snapshot, next);
    await writeFile(join(plugin, "main.js"), "later program edit"); const before = await installed();
    await expect(applyLegacyInstalledSnapshotUpgrade(plan, next, options())).rejects.toThrow();
    expect(await installed()).toEqual(before);
  });

  it("automatically restores all twelve originals after a partial replacement fails", async () => {
    const snapshot = await legacyInstalledSnapshot(), plan = await planLegacyInstalledSnapshotUpgrade(vault, snapshot, next); let writes = 0;
    await expect(applyLegacyInstalledSnapshotUpgrade(plan, next, options({ onStep: ({ stage }: { stage: string }) => {
      if (stage === "after-write" && ++writes === 2) throw Error("fictional interrupted adoption");
    } }))).rejects.toMatchObject({ code: "apply_failed_rolled_back" });
    await compare(old);
  });

  it("uses the existing immutable journal to complete and roll back without either source directory", async () => {
    const snapshot = await legacyInstalledSnapshot(), plan = await planLegacyInstalledSnapshotUpgrade(vault, snapshot, next);
    await applyLegacyInstalledSnapshotUpgrade(plan, next, options());
    const folder = join(root, "backups/full-upgrade"), saved = JSON.parse(await readFile(join(folder, "plan.json"), "utf8"));
    await writeFile(join(folder, "state.json"), JSON.stringify({ version: 1, fingerprint: saved.fingerprint, status: "applying" }));
    await rm(snapshot.directory, { recursive: true }); await rm(next.directory, { recursive: true });
    await completeFullPluginUpgrade(options()); await compare(next);
    await rollbackFullPluginUpgrade(options()); await compare(old);
  });

  it("keeps the same pending-history and fixed-namespace protections", async () => {
    const snapshot = await legacyInstalledSnapshot(), plan = await planLegacyInstalledSnapshotUpgrade(vault, snapshot, next);
    await applyLegacyInstalledSnapshotUpgrade(plan, next, options());
    await expect(applyLegacyInstalledSnapshotUpgrade(plan, next, options({ backupRoot: join(root, "different") }))).rejects.toThrow("different recovery namespace");
    const folder = join(root, "backups/full-upgrade"), saved = JSON.parse(await readFile(join(folder, "plan.json"), "utf8"));
    await writeFile(join(folder, "state.json"), JSON.stringify({ version: 1, fingerprint: saved.fingerprint, status: "applying" }));
    await expect(applyLegacyInstalledSnapshotUpgrade(plan, next, options({ batchId: "another" }))).rejects.toThrow("Earlier upgrade needs recovery");
    await compare(next); await completeFullPluginUpgrade(options()); await rollbackFullPluginUpgrade(options()); await compare(old);
  });

  it("rejects a changed recovery WAL and a missing exact reader", async () => {
    const snapshot = await legacyInstalledSnapshot(), plan = await planLegacyInstalledSnapshotUpgrade(vault, snapshot, next);
    const opts = options(); opts.recoveryCompatibility.readers = [];
    await expect(applyLegacyInstalledSnapshotUpgrade(plan, next, opts)).rejects.toThrow(); await compare(old);
    await mkdir(join(vault, "fictional/Operations"), { recursive: true });
    await writeFile(join(vault, "fictional/Operations/write-recovery.json"), JSON.stringify({ version: 1, status: "committed", operationId: "fictional", entries: [] }));
    await expect(applyLegacyInstalledSnapshotUpgrade(plan, next, options())).rejects.toThrow("Reviewed recovery WAL changed"); await compare(old);
  });
});

describe("reviewed full-package upgrade and rollback", { timeout: 30_000 }, () => {
  it("upgrades 16 to 15 exact files/modes, removes the declared helper and restores it at 0500", async () => {
    const plan = await planFullPluginUpgrade(vault, old, next);
    await applyFullPluginUpgrade(plan, next, options()); await compare(next);
    expect(await applyFullPluginUpgrade(plan, next, options())).toMatchObject({ status: "applied" });
    await writeFile(join(plugin, "data.json"), "later settings"); await writeFile(join(vault, "diary.md"), "later diary");
    await writeFile(join(plugin, "unknown.txt"), "later extra file");
    await rollbackFullPluginUpgrade(options()); await compare(old);
    expect(await rollbackFullPluginUpgrade(options())).toMatchObject({ status: "rolled_back" });
    expect(await applyFullPluginUpgrade(plan, next, options())).toMatchObject({ status: "rolled_back" });
    expect(await readFile(join(plugin, "data.json"), "utf8")).toBe("later settings");
    expect(await readFile(join(vault, "diary.md"), "utf8")).toBe("later diary");
    expect(await readFile(join(plugin, "unknown.txt"), "utf8")).toBe("later extra file");
  });

  it.each([false, true])("adds both licenses to a legacy package and removes them on rollback (old native=%s)", async native => {
    old = await makePackage("unlicensed-old", native, "legacy", 0o644, false);
    next = await makePackage("licensed-next", !native, "licensed", 0o600);
    await reseed(old); const plan = await planFullPluginUpgrade(vault, old, next);
    await applyFullPluginUpgrade(plan, next, options()); await compare(next);
    await rollbackFullPluginUpgrade(options()); await compare(old);
    for (const path of LICENSES) await expect(stat(join(plugin, path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(LICENSES)("refuses a half-present license generation missing %s", async missing => {
    const partial = { ...next, files: next.files.filter(f => f.path !== missing) };
    await expect(loadReviewedPluginPackage(partial)).rejects.toThrow(/license pair/); await compare(old);
  });

  it("refuses an unknown file at a newly managed license path before writes", async () => {
    old = await makePackage("legacy-license-conflict", true, "legacy", 0o644, false); await reseed(old);
    await writeFile(join(plugin, "LICENSE"), "later user-owned license file");
    const before = await installed();
    await expect(planFullPluginUpgrade(vault, old, next)).rejects.toThrow(/Installed artifact differs/);
    expect(await installed()).toEqual(before);
  });

  it("guards a later license edit before restoring any package artifact", async () => {
    const plan = await planFullPluginUpgrade(vault, old, next); await applyFullPluginUpgrade(plan, next, options());
    await writeFile(join(plugin, "mediapipe/LICENSE-2.0.txt"), "later edited license"); const before = await installed();
    await expect(rollbackFullPluginUpgrade(options())).rejects.toMatchObject({ code: "recovery_required" });
    expect(await installed()).toEqual(before);
  });

  it("completes and rolls back an exact old 14-path journal without the source packages", async () => {
    old = await makePackage("historical-old", true, "legacy-old", 0o644, false);
    next = await makePackage("historical-next", false, "legacy-next", 0o600, false); await reseed(old);
    const { opts } = await historicalJournal("historical");
    const path = join(root, "backups/historical"), saved = JSON.parse(await readFile(join(path, "plan.json"), "utf8"));
    expect(saved.allowedPaths).toEqual([...LEGACY_FULL_PLUGIN_FILES]);
    await writeFile(join(path, "state.json"), JSON.stringify({ version: 1, fingerprint: saved.fingerprint, status: "applying" }));
    await rm(old.directory, { recursive: true }); await rm(next.directory, { recursive: true });
    await completeFullPluginUpgrade(opts); await compare(next);
    await rollbackFullPluginUpgrade(opts); await compare(old);
    expect(JSON.parse(await readFile(join(path, "plan.json"), "utf8"))).toEqual(saved);
  });

  it("still applies an already reviewed logical plan with the fixed old 14 paths", async () => {
    old = await makePackage("old-plan-before", true, "old-plan-before", 0o644, false);
    next = await makePackage("old-plan-after", false, "old-plan-after", 0o600, false); await reseed(old);
    const before = await loadReviewedPluginPackage(old), after = await loadReviewedPluginPackage(next);
    const files = (LEGACY_FULL_PLUGIN_FILES as string[]).map(path => ({ path,
      before: before.inventory.find((x: { path: string }) => x.path === path)?.revision ?? null,
      after: after.inventory.find((x: { path: string }) => x.path === path)?.revision ?? null }));
    const payload = { version: 2, vaultRoot: vault, oldPackageFingerprint: before.fingerprint, newPackageFingerprint: after.fingerprint, files };
    const plan = { ...payload, fingerprint: revisionHash(Buffer.from(JSON.stringify(payload))) };
    await applyFullPluginUpgrade(plan, next, options()); await compare(next);
    const journal = JSON.parse(await readFile(join(root, "backups/full-upgrade/plan.json"), "utf8"));
    expect(journal.allowedPaths).toEqual([...LEGACY_FULL_PLUGIN_FILES]);
    await rollbackFullPluginUpgrade(options()); await compare(old);
  });

  // Settled history performs two full apply/rollback cycles with per-file durable
  // journals and readback; allow CI I/O contention within this fixture's 10s cap.
  it.each([{ legacy: true, pending: false }, { legacy: true, pending: true }, { legacy: false, pending: false }, { legacy: false, pending: true }])("checks settled and unfinished history for both fixed generations (%o)", async ({ legacy, pending }) => {
    old = await makePackage("history-old", true, "history-old", 0o644, !legacy);
    next = await makePackage("history-next", false, "history-next", 0o600, !legacy); await reseed(old);
    if (legacy) { const { tool, opts } = await historicalJournal("earlier"); await withPluginUpgradeTargetLock(opts, () => tool.recover("earlier")); }
    else { const plan = await planFullPluginUpgrade(vault, old, next), opts = options({ batchId: "earlier" }); await applyFullPluginUpgrade(plan, next, opts); await rollbackFullPluginUpgrade(opts); }
    const statePath = join(root, "backups/earlier/state.json");
    if (pending) { const state = JSON.parse(await readFile(statePath, "utf8")); state.status = "applying"; await writeFile(statePath, JSON.stringify(state)); }
    next = await makePackage("new-after-history", false, "new-after-history", 0o600);
    const plan = await planFullPluginUpgrade(vault, old, next);
    if (pending) { await expect(applyFullPluginUpgrade(plan, next, options())).rejects.toThrow(/Earlier upgrade needs recovery/); await compare(old); }
    else { await applyFullPluginUpgrade(plan, next, options()); await rollbackFullPluginUpgrade(options()); await compare(old); }
  }, 60_000);

  it("rejects an unknown journal path generation instead of adopting its allowedPaths", async () => {
    old = await makePackage("unknown-scope-old", true, "unknown-old", 0o644, false);
    next = await makePackage("unknown-scope-next", false, "unknown-next", 0o600, false); await reseed(old);
    const { tool, opts } = await historicalJournal("unknown-scope"); await withPluginUpgradeTargetLock(opts, () => tool.recover("unknown-scope"));
    const path = join(root, "backups/unknown-scope/plan.json"), saved = JSON.parse(await readFile(path, "utf8"));
    saved.allowedPaths = [...saved.allowedPaths, "data.json"].sort(); await writeFile(path, JSON.stringify(saved));
    next = await makePackage("after-unknown-scope", false, "after-unknown", 0o600);
    const plan = await planFullPluginUpgrade(vault, old, next), before = await installed();
    await expect(applyFullPluginUpgrade(plan, next, options())).rejects.toThrow(/Unreviewed full-package path generation/);
    expect(await installed()).toEqual(before);
  });

  it("adds a new 0500 helper and refuses a later mode-only change before any rollback", async () => {
    await rm(join(plugin, NATIVE)); [old, next] = [next, old];
    for (const f of old.files) { await cp(join(old.directory, f.path), join(plugin, f.path)); await chmod(join(plugin, f.path), f.mode); }
    const plan = await planFullPluginUpgrade(vault, old, next);
    await applyFullPluginUpgrade(plan, next, options()); await compare(next);
    await chmod(join(plugin, NATIVE), 0o600); const before = await installed();
    await expect(rollbackFullPluginUpgrade(options())).rejects.toMatchObject({ code: "recovery_required" });
    expect(await installed()).toEqual(before);
  });

  it("does not take over an unknown file at a newly managed path", async () => {
    [old, next] = [next, old];
    // The old package is normal, but an unrelated helper already occupies the path.
    for (const f of old.files) { await cp(join(old.directory, f.path), join(plugin, f.path)); await chmod(join(plugin, f.path), f.mode); }
    await chmod(join(plugin, NATIVE), 0o600); await writeFile(join(plugin, NATIVE), "unknown user-owned bytes");
    await expect(planFullPluginUpgrade(vault, old, next)).rejects.toThrow("Installed artifact differs");
    expect(await readFile(join(plugin, NATIVE), "utf8")).toBe("unknown user-owned bytes");
  });

  it("keeps an unchanged resource out of blobs but guards its later edit", async () => {
    next = await makePackage("same-modes", false, "new", 0o644);
    const plan = await planFullPluginUpgrade(vault, old, next);
    await applyFullPluginUpgrade(plan, next, options());
    const backup = JSON.parse(await readFile(join(root, "backups/full-upgrade/plan.json"), "utf8"));
    const retained = "mediapipe/face_landmarker.task";
    expect(backup.retained.some((f: { path: string }) => f.path === retained)).toBe(true);
    expect(await readdir(join(root, "backups/full-upgrade/blobs"))).not.toContain(`${old.files.find(f => f.path === retained)!.sha256}.bin`);
    await writeFile(join(plugin, retained), "later resource edit"); const snapshot = await installed();
    await expect(rollbackFullPluginUpgrade(options())).rejects.toMatchObject({ code: "recovery_required" });
    expect(await installed()).toEqual(snapshot);
  });

  it("still validates the reviewed main reader when main is retained", async () => {
    next = await makePackage("unchanged-main", false, "old");
    const plan = await planFullPluginUpgrade(vault, old, next);
    expect(plan.files.find((f: Entry) => f.path === "main.js").before).toEqual(plan.files.find((f: Entry) => f.path === "main.js").after);
    const opts = options(); opts.recoveryCompatibility.readers[0].mainSha256 = "f".repeat(64);
    await expect(applyFullPluginUpgrade(plan, next, opts)).rejects.toThrow("Exact target program");
    await compare(old);
  });

  it("requires the old reader when repeat apply returns an already rolled-back batch", async () => {
    const plan = await planFullPluginUpgrade(vault, old, next);
    await applyFullPluginUpgrade(plan, next, options()); await rollbackFullPluginUpgrade(options());
    const opts = options(); opts.recoveryCompatibility.readers = opts.recoveryCompatibility.readers.filter(r => r.mainSha256 === mainHash(next));
    await expect(applyFullPluginUpgrade(plan, next, opts)).rejects.toThrow("Exact target program"); await compare(old);
  });

  it("rechecks the exact WAL after each hook and never rewrites it", async () => {
    const plan = await planFullPluginUpgrade(vault, old, next), raw = JSON.stringify({ version: 1, status: "committed", operationId: "fictional", entries: [] });
    let injected = false;
    await expect(applyFullPluginUpgrade(plan, next, options({ onStep: async ({ stage }: { stage: string }) => {
      if (stage !== "before-write" || injected) return; injected = true;
      await mkdir(join(vault, "fictional/Operations"), { recursive: true });
      await writeFile(join(vault, "fictional/Operations/write-recovery.json"), raw);
    } }))).rejects.toMatchObject({ code: "recovery_required" });
    await compare(old); expect(await readFile(join(vault, "fictional/Operations/write-recovery.json"), "utf8")).toBe(raw);
    const opts = options(); opts.recoveryCompatibility.expectedHash = revisionHash(Buffer.from(raw));
    await rollbackFullPluginUpgrade(opts); await compare(old);
  });

  it("automatically rolls back an injected partial replacement including metadata and modes", async () => {
    const plan = await planFullPluginUpgrade(vault, old, next); let count = 0;
    await expect(applyFullPluginUpgrade(plan, next, options({ onStep: ({ stage }: { stage: string }) => {
      if (stage === "after-write" && ++count === 2) throw new Error("fictional failure");
    } }))).rejects.toMatchObject({ code: "apply_failed_rolled_back" });
    await compare(old);
  });

  it("resumes from immutable blobs after source packages are unavailable", async () => {
    const plan = await planFullPluginUpgrade(vault, old, next);
    await applyFullPluginUpgrade(plan, next, options());
    const path = join(root, "backups/full-upgrade"), saved = JSON.parse(await readFile(join(path, "plan.json"), "utf8"));
    // Simulate the program rename surviving while its applied state did not.
    await writeFile(join(path, "state.json"), JSON.stringify({ version: 1, fingerprint: saved.fingerprint, status: "applying" }));
    await rm(old.directory, { recursive: true }); await rm(next.directory, { recursive: true });
    expect(await completeFullPluginUpgrade(options())).toMatchObject({ status: "applied" });
    await compare(next); await rollbackFullPluginUpgrade(options()); await compare(old);
  });

  it.each(["catalog", "checksum", "resource", "extra", "mode"])("rejects %s package damage before target writes", async kind => {
    const path = kind === "checksum" ? "SHA256SUMS.txt" : kind === "resource" ? "RESOURCE-MANIFEST.json" : "main.js";
    if (kind === "catalog") next.files[0].sha256 = "f".repeat(64);
    else if (kind === "extra") await writeFile(join(next.directory, "data.json"), "extra settings");
    else if (kind === "mode") await chmod(join(next.directory, path), 0o500);
    else {
      await writeFile(join(next.directory, path), "corrupt");
      const entry = next.files.find(f => f.path === path)!; const bytes = await readFile(join(next.directory, path));
      entry.sha256 = revisionHash(bytes)!; entry.size = bytes.length;
    }
    await expect(loadReviewedPluginPackage(next)).rejects.toThrow(); await compare(old);
  });

  it("rejects unsettled v1 history and rejects a different backup namespace", async () => {
    const legacy = new OfflineRecovery({ vaultRoot: plugin, backupRoot: join(root, "backups"), allowedPaths: PLUGIN_FILES });
    await legacy.apply("legacy", "plugin-upgrade-v1", await Promise.all((PLUGIN_FILES as string[]).map(async path => {
      const data = await readFile(join(plugin, path)); return { path, expectedHash: revisionHash(data), after: data };
    })));
    const legacyPlan = JSON.parse(await readFile(join(root, "backups/legacy/plan.json"), "utf8"));
    const legacyState = join(root, "backups/legacy/state.json");
    await writeFile(legacyState, JSON.stringify({ version: 1, fingerprint: legacyPlan.fingerprint, status: "applying" }));
    const plan = await planFullPluginUpgrade(vault, old, next);
    await expect(applyFullPluginUpgrade(plan, next, options())).rejects.toThrow("Earlier upgrade needs recovery"); await compare(old);
    await writeFile(legacyState, JSON.stringify({ version: 1, fingerprint: legacyPlan.fingerprint, status: "applied" }));
    await expect(applyFullPluginUpgrade(plan, next, options({ backupRoot: join(root, "different") }))).rejects.toThrow("different recovery namespace");
    await applyFullPluginUpgrade(plan, next, options()); await rollbackFullPluginUpgrade(options());
  });

  it("legacy rollback and complete refuse another unfinished full-package batch", async () => {
    const legacy = new OfflineRecovery({ vaultRoot: plugin, backupRoot: join(root, "backups"), allowedPaths: PLUGIN_FILES });
    await legacy.apply("legacy", "plugin-upgrade-v1", await Promise.all((PLUGIN_FILES as string[]).map(async path => {
      const data = await readFile(join(plugin, path)); return { path, expectedHash: revisionHash(data), after: data };
    })));
    const plan = await planFullPluginUpgrade(vault, old, next);
    await expect(applyFullPluginUpgrade(plan, next, options({ onStep: ({ stage, path }: { stage: string; path?: string }) => {
      if ((stage === "after-write" && path === "RESOURCE-MANIFEST.json") || stage === "before-restore") throw new Error("fictional process interruption");
    } }))).rejects.toMatchObject({ code: "recovery_required" });
    // main is still the legacy batch's exact before/after image: without the
    // cross-format gate both old APIs would accept this otherwise mixed package.
    expect(revisionHash(await readFile(join(plugin, "main.js")))).toBe(mainHash(old));
    const snapshot = await installed();
    await expect(rollbackPluginUpgrade(options({ batchId: "legacy" }))).rejects.toThrow();
    await expect(completePluginUpgrade(options({ batchId: "legacy" }))).rejects.toThrow();
    expect(await installed()).toEqual(snapshot);
    await completeFullPluginUpgrade(options());
    await rollbackFullPluginUpgrade(options()); await compare(old);
  });
});
