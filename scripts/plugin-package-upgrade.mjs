// Node-only, closed-vault maintenance. No install CLI and no vault discovery.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { OfflineRecovery, assertSafeDiskPath, revisionHash } from '../src/dataFoundation/offlineRecovery.ts';
import { PLUGIN_FILES, reviewedRecoveryCompatibility, withPluginUpgradeTargetLock } from './plugin-upgrade.mjs';
import { RESOURCE_MANIFEST } from './verify-plugin-package.mjs';

const LICENSE_PATHS = Object.freeze(["LICENSE", "mediapipe/LICENSE-2.0.txt"]);

// This historical generation must not grow when the current resource list does.
export const LEGACY_FULL_PLUGIN_FILES = Object.freeze([
  'main.js', 'manifest.json', 'styles.css', 'RESOURCE-MANIFEST.json', 'SHA256SUMS.txt',
  'mediapipe/ATTRIBUTION.md', 'mediapipe/face_landmarker.task',
  'mediapipe/wasm/vision_wasm_internal.js', 'mediapipe/wasm/vision_wasm_internal.wasm',
  'mediapipe/wasm/vision_wasm_module_internal.js', 'mediapipe/wasm/vision_wasm_module_internal.wasm',
  'mediapipe/wasm/vision_wasm_nosimd_internal.js', 'mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
  'native/lifeops-work-window'
].sort());
export const FULL_PLUGIN_FILES = Object.freeze([...LEGACY_FULL_PLUGIN_FILES, ...LICENSE_PATHS].sort());
export const LEGACY_INSTALLED_12_FILES = Object.freeze(LEGACY_FULL_PLUGIN_FILES.filter(path => !['RESOURCE-MANIFEST.json', 'native/lifeops-work-window'].includes(path)));
const INSTALLED_SNAPSHOT_KIND = 'reviewed-legacy-installed-12-v1';
const NATIVE = 'native/lifeops-work-window';
const MAX_BYTES = 16 * 1024 * 1024, TOTAL_BYTES = 128 * 1024 * 1024;
const MIGRATION = 'plugin-package-upgrade-v2', ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/, HASH = /^[a-f0-9]{64}$/;
const digest = value => revisionHash(Buffer.from(JSON.stringify(value)));
const pluginPath = vault => join(vault, '.obsidian/plugins/lifeops-assistant');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function fullPaths(paths) {
  for (const allowed of [LEGACY_FULL_PLUGIN_FILES, FULL_PLUGIN_FILES]) if (same(paths, allowed)) return allowed;
  assert.fail('Unreviewed full-package path generation');
}
function packagePaths(names) {
  const licenses = LICENSE_PATHS.filter(path => names.includes(path));
  assert.ok(licenses.length === 0 || licenses.length === LICENSE_PATHS.length, 'Incomplete package license pair');
  const paths = licenses.length ? FULL_PLUGIN_FILES : LEGACY_FULL_PLUGIN_FILES;
  assert.deepEqual([...names].sort(), paths.filter(path => path !== NATIVE || names.includes(NATIVE)), 'Unexpected reviewed package scope');
}
function journalPaths(header) {
  assert.equal(header.version, 2);
  assert.equal(header.migrationId, MIGRATION);
  return fullPaths(header.allowedPaths);
}

async function directory(path) {
  await assertSafeDiskPath(path);
  assert.ok((await lstat(path)).isDirectory(), 'Expected directory');
  assert.equal(await realpath(path), resolve(path), 'Noncanonical package root');
}
async function file(path, limit = MAX_BYTES) {
  await assertSafeDiskPath(path);
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const before = await handle.stat();
    assert.ok(before.isFile() && before.nlink === 1 && before.size <= limit && !(before.mode & 0o7000), 'Unsafe package file');
    const storage = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < storage.length) {
      const { bytesRead } = await handle.read(storage, length, storage.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const data = storage.subarray(0, length), after = await handle.stat(), named = await lstat(path);
    for (const current of [after, named]) for (const key of ['ino', 'dev', 'nlink', 'size', 'mode', 'mtimeMs', 'ctimeMs']) {
      assert.equal(current[key], before[key], 'Package file changed during read');
    }
    assert.ok(named.isFile() && data.length === before.size, 'Package readback changed');
    return { data, revision: { hash: revisionHash(data), size: data.length, mode: before.mode & 0o777 } };
  } finally { await handle.close(); }
}
function metadata(value, path) {
  if (value === null) { assert.ok(path === NATIVE || LICENSE_PATHS.includes(path), 'Required package artifact missing'); return; }
  assert.ok(value && typeof value === 'object' && Object.keys(value).sort().join(',') === 'hash,mode,size', 'Invalid artifact metadata');
  assert.match(value.hash, HASH);
  assert.ok(Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= MAX_BYTES, 'Invalid artifact size');
  assert.ok(path === NATIVE ? value.mode === 0o500 : [0o600, 0o644].includes(value.mode), 'Unreviewed artifact mode');
}
function identity(data) {
  const value = JSON.parse(data.toString('utf8'));
  assert.ok(value.id === 'lifeops-assistant' && value.isDesktopOnly === true
    && typeof value.version === 'string' && value.version.length > 0, 'Invalid plugin identity');
}

/** `files` is an independently reviewed catalog, not a catalog inferred from
 * whatever happens to be in the source directory. Only normal/background full
 * distributions are accepted. This does not replace build/secret verification. */
export async function loadReviewedPluginPackage({ directory: packageDirectory, files }) {
  const root = resolve(packageDirectory); await directory(root);
  assert.ok(Array.isArray(files) && [13, 14, 15, 16].includes(files.length), 'Expected a reviewed full-package catalog');
  const names = files.map(f => f.path).sort(); packagePaths(names);
  const contents = new Map(), inventory = [];
  let total = 0;
  for (const path of names) {
    const review = files.find(f => f.path === path);
    assert.match(review.sha256, HASH);
    const read = await file(join(root, path)); assert.ok(read, 'Missing reviewed artifact');
    metadata(read.revision, path);
    assert.equal(read.revision.hash, review.sha256, 'Reviewed artifact changed');
    assert.equal(read.revision.mode, review.mode, 'Reviewed artifact mode changed');
    if (review.size !== undefined) assert.equal(read.revision.size, review.size, 'Reviewed artifact size changed');
    total += read.data.length; assert.ok(total <= TOTAL_BYTES, 'Oversized reviewed package');
    contents.set(path, read.data); inventory.push({ path, revision: read.revision });
  }
  // Reject extras, links and undeclared subdirectories, without following them.
  async function visit(folder, prefix = '') {
    const entries = await readdir(folder, { withFileTypes: true });
    assert.ok(entries.length <= FULL_PLUGIN_FILES.length, 'Unexpected package entries');
    for (const entry of entries) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        assert.ok(['mediapipe', 'mediapipe/wasm', ...(names.includes(NATIVE) ? ['native'] : [])].includes(path), 'Unexpected package directory');
        await directory(join(root, path)); await visit(join(root, path), `${path}/`);
      } else assert.ok(entry.isFile() && names.includes(path), 'Unexpected package file');
    }
  }
  await visit(root); identity(contents.get('manifest.json'));
  const resources = JSON.parse(contents.get(RESOURCE_MANIFEST).toString('utf8'));
  const resourceNames = FULL_PLUGIN_FILES.filter(p => !PLUGIN_FILES.includes(p) && p !== RESOURCE_MANIFEST && p !== 'SHA256SUMS.txt' && names.includes(p));
  assert.ok(resources.schemaVersion === 1 && Array.isArray(resources.files), 'Invalid resource manifest');
  assert.deepEqual(resources.files.map(f => f.path).sort(), [...resourceNames].sort(), 'Resource scope differs');
  for (const resource of resources.files) {
    const data = contents.get(resource.path);
    assert.ok(data && resource.sha256 === revisionHash(data) && resource.sizeBytes === data.length, 'Resource manifest differs');
    assert.ok(resource.path === NATIVE ? resource.mode === '0500' : resource.mode === undefined, 'Invalid resource mode');
  }
  const checksums = contents.get('SHA256SUMS.txt').toString('utf8').trimEnd().split('\n');
  const checksummed = [];
  for (const line of checksums) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line); assert.ok(match, 'Invalid package checksum');
    const [, hash, path] = match;
    assert.ok(path !== 'SHA256SUMS.txt' && contents.has(path), 'Unexpected checksum path');
    assert.equal(revisionHash(contents.get(path)), hash, 'Package checksum differs'); checksummed.push(path);
  }
  assert.deepEqual(checksummed.sort(), names.filter(p => p !== 'SHA256SUMS.txt'), 'Incomplete or duplicate checksums');
  return { inventory, contents, fingerprint: digest(inventory) };
}

function validatePlan(plan, vaultRoot) {
  const { fingerprint, ...payload } = plan;
  assert.equal(fingerprint, digest(payload), 'Reviewed upgrade plan changed');
  assert.equal(plan.version, 2); assert.equal(plan.vaultRoot, resolve(vaultRoot));
  assert.match(plan.oldPackageFingerprint, HASH); assert.match(plan.newPackageFingerprint, HASH);
  const paths = fullPaths(plan.files.map(f => f.path));
  for (const entry of plan.files) { metadata(entry.before, entry.path); metadata(entry.after, entry.path); }
  for (const [side, key] of [['before', 'oldPackageFingerprint'], ['after', 'newPackageFingerprint']]) {
    packagePaths(plan.files.filter(f => f[side] !== null).map(f => f.path));
    assert.equal(digest(plan.files.filter(f => f[side] !== null).map(f => ({ path: f.path, revision: f[side] }))), plan[key], 'Package inventory changed');
  }
  return paths;
}
export async function planFullPluginUpgrade(vaultRoot, oldPackage, newPackage) {
  const vault = resolve(vaultRoot); await directory(vault); await directory(pluginPath(vault));
  const old = await loadReviewedPluginPackage(oldPackage), next = await loadReviewedPluginPackage(newPackage);
  const files = [];
  for (const path of FULL_PLUGIN_FILES) {
    const before = old.inventory.find(f => f.path === path)?.revision ?? null;
    const after = next.inventory.find(f => f.path === path)?.revision ?? null;
    assert.ok(same((await file(join(pluginPath(vault), path)))?.revision ?? null, before), 'Installed artifact differs from reviewed old package');
    files.push({ path, before, after });
  }
  const payload = { version: 2, vaultRoot: vault, oldPackageFingerprint: old.fingerprint, newPackageFingerprint: next.fingerprint, files };
  return { ...payload, fingerprint: digest(payload) };
}
async function maintenance(options, onStep, allowedPaths = FULL_PLUGIN_FILES) {
  assert.equal(options.vaultClosed, true, 'Close the target vault before maintenance');
  assert.ok(typeof options.authorization === 'string' && options.authorization.trim(), 'Explicit operator authorization is required');
  assert.match(options.batchId, ID);
  const vault = resolve(options.vaultRoot), backup = resolve(options.backupRoot), rel = relative(vault, backup);
  assert.ok(rel && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)), 'Backup must be outside the entire vault');
  await directory(vault); await directory(pluginPath(vault));
  return new OfflineRecovery({ vaultRoot: pluginPath(vault), backupRoot: backup, allowedPaths,
    artifactStorage: { maxTotalBytes: TOTAL_BYTES }, onStep });
}
async function requireSettled(options) {
  const backup = resolve(options.backupRoot);
  await assertSafeDiskPath(backup); await mkdir(backup, { recursive: true, mode: 0o700 }); await directory(backup);
  for (const item of await readdir(backup, { withFileTypes: true })) {
    if (item.name === options.batchId) continue;
    assert.ok(item.isDirectory(), 'Unexpected recovery namespace entry'); assert.match(item.name, ID);
    const folder = join(backup, item.name); await directory(folder);
    if ((await readdir(folder)).length === 0) continue; // No published plan and no target writes.
    // Parse only the bounded journal to choose a strict reader, then validate the
    // full immutable plan and state (including all v2 blobs) with that reader.
    const raw = await file(join(folder, 'plan.json'), 64 * 1024 * 1024);
    assert.ok(raw, 'Missing previous recovery plan');
    const header = JSON.parse(raw.data.toString('utf8'));
    assert.ok([1, 2].includes(header.version), 'Unknown recovery plan format');
    const v2 = header.version === 2;
    assert.equal(header.migrationId, v2 ? MIGRATION : 'plugin-upgrade-v1');
    const reader = new OfflineRecovery({ vaultRoot: pluginPath(resolve(options.vaultRoot)), backupRoot: backup,
      allowedPaths: v2 ? journalPaths(header) : PLUGIN_FILES, maxPlanBytes: (v2 ? 16 : 64) * 1024 * 1024,
      ...(v2 ? { artifactStorage: { maxTotalBytes: TOTAL_BYTES } } : {}) });
    const reviewed = await reader.review(item.name);
    assert.ok(['applied', 'rolled_back'].includes(reviewed.status), 'Earlier upgrade needs recovery');
  }
}
function mainReaders(review) {
  assert.equal(review.version, 2); assert.equal(review.migrationId, MIGRATION);
  const main = review.files.find(f => f.path === 'main.js');
  assert.ok(main?.before && main?.after, 'Immutable program readers missing');
  return { before: main.before.hash, after: main.after.hash };
}
function guardedSteps(options, guard, readers) {
  return async event => {
    const restoring = ['before-restore', 'after-restore'].includes(event.stage);
    await guard(restoring ? readers.before : readers.after, restoring);
    await options.onStep?.(event);
    await guard(restoring ? readers.before : readers.after, restoring);
  };
}
export async function applyFullPluginUpgrade(inputPlan, newPackage, options) {
  const plan = structuredClone(inputPlan), paths = validatePlan(plan, options.vaultRoot);
  const pkg = await loadReviewedPluginPackage(newPackage);
  assert.equal(pkg.fingerprint, plan.newPackageFingerprint, 'New package differs from reviewed plan');
  return applyReviewedPlan(plan, paths, pkg, options);
}
async function applyReviewedPlan(plan, paths, pkg, options) {
  const readers = { before: plan.files.find(f => f.path === 'main.js').before.hash, after: plan.files.find(f => f.path === 'main.js').after.hash };
  const guard = reviewedRecoveryCompatibility(options);
  const tool = await maintenance(options, guardedSteps(options, guard, readers), paths);
  const updates = plan.files.map(f => ({ path: f.path, expectedHash: f.before?.hash ?? null, expectedMode: f.before?.mode ?? null,
    after: pkg.contents.get(f.path) ?? null, ...(f.after === null ? {} : { mode: f.after.mode }) }));
  return withPluginUpgradeTargetLock(options, async () => {
    await requireSettled(options); await guard(readers.after);
    const result = await tool.apply(options.batchId, MIGRATION, updates);
    await guard(result.status === 'rolled_back' ? readers.before : readers.after, result.status === 'rolled_back');
    return result;
  }, true);
}

/** Explicit adoption of an independently reviewed early installation. Its old
 * checksum file is an opaque before-image, never an authenticity authority. */
export async function planLegacyInstalledSnapshotUpgrade(vaultRoot, snapshot, newPackage) {
  assert.equal(snapshot.sourceKind, INSTALLED_SNAPSHOT_KIND, 'Explicit installed-snapshot review required');
  assert.ok(typeof snapshot.reviewEvidence === 'string' && snapshot.reviewEvidence.trim().length > 0
    && snapshot.reviewEvidence.length <= 2000, 'Installed-snapshot review evidence required');
  assert.ok(Array.isArray(snapshot.files), 'Reviewed installed catalog required');
  assert.deepEqual(snapshot.files.map(f => f.path).sort(), [...LEGACY_INSTALLED_12_FILES], 'Expected exact legacy installed 12 paths');
  const source = resolve(snapshot.directory), vault = resolve(vaultRoot);
  await directory(source); await directory(vault); await directory(pluginPath(vault));
  const before = []; let total = 0;
  for (const path of LEGACY_INSTALLED_12_FILES) {
    const review = snapshot.files.find(f => f.path === path);
    const item = await file(join(source, review.path)); assert.ok(item, 'Missing reviewed installed artifact');
    metadata(item.revision, review.path);
    assert.equal(item.revision.hash, review.sha256, 'Installed snapshot hash changed');
    assert.equal(item.revision.mode, review.mode, 'Installed snapshot mode changed');
    assert.equal(item.revision.size, review.size, 'Installed snapshot size changed');
    total += item.revision.size; assert.ok(total <= TOTAL_BYTES, 'Oversized installed snapshot');
    if (review.path === 'manifest.json') identity(item.data);
    before.push({ path: review.path, revision: item.revision });
  }
  async function visit(folder, prefix = '') {
    const entries = await readdir(folder, { withFileTypes: true });
    assert.ok(entries.length <= LEGACY_INSTALLED_12_FILES.length, 'Unexpected installed snapshot entries');
    for (const entry of entries) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        assert.ok(['mediapipe', 'mediapipe/wasm'].includes(name), 'Unexpected installed snapshot directory');
        await directory(join(source, name)); await visit(join(source, name), name + '/');
      } else assert.ok(entry.isFile() && LEGACY_INSTALLED_12_FILES.includes(name), 'Unexpected installed snapshot file');
    }
  }
  await visit(source);
  const after = await loadReviewedPluginPackage(newPackage);
  assert.deepEqual(after.inventory.map(f => f.path).sort(), FULL_PLUGIN_FILES.filter(p => p !== NATIVE), 'Legacy adoption requires a reviewed ordinary 15-file package');
  const files = [];
  for (const path of FULL_PLUGIN_FILES) {
    const prior = before.find(f => f.path === path)?.revision ?? null;
    assert.ok(same((await file(join(pluginPath(vault), path)))?.revision ?? null, prior), 'Installed artifact differs from reviewed snapshot');
    files.push({ path, before: prior, after: after.inventory.find(f => f.path === path)?.revision ?? null });
  }
  const payload = { version: 2, sourceKind: INSTALLED_SNAPSHOT_KIND, reviewEvidence: snapshot.reviewEvidence,
    vaultRoot: vault, oldPackageFingerprint: digest(before), newPackageFingerprint: after.fingerprint, files };
  return { ...payload, fingerprint: digest(payload) };
}
export async function applyLegacyInstalledSnapshotUpgrade(inputPlan, newPackage, options) {
  const plan = structuredClone(inputPlan), { fingerprint, ...payload } = plan;
  assert.equal(plan.sourceKind, INSTALLED_SNAPSHOT_KIND, 'Explicit installed-snapshot plan required');
  assert.equal(fingerprint, digest(payload), 'Reviewed installed-snapshot plan changed');
  assert.equal(plan.version, 2); assert.equal(plan.vaultRoot, resolve(options.vaultRoot));
  assert.ok(typeof plan.reviewEvidence === 'string' && plan.reviewEvidence.trim().length > 0 && plan.reviewEvidence.length <= 2000);
  const paths = fullPaths(plan.files.map(f => f.path));
  assert.deepEqual(paths, FULL_PLUGIN_FILES, 'Installed adoption requires current complete scope');
  assert.deepEqual(plan.files.filter(f => f.before !== null).map(f => f.path), [...LEGACY_INSTALLED_12_FILES]);
  for (const entry of plan.files) {
    if (entry.before !== null) metadata(entry.before, entry.path);
    metadata(entry.after, entry.path);
  }
  assert.equal(digest(plan.files.filter(f => f.before !== null).map(f => ({ path: f.path, revision: f.before }))), plan.oldPackageFingerprint);
  const pkg = await loadReviewedPluginPackage(newPackage);
  assert.deepEqual(pkg.inventory.map(f => f.path).sort(), FULL_PLUGIN_FILES.filter(p => p !== NATIVE), 'Legacy adoption requires a reviewed ordinary 15-file package');
  assert.equal(pkg.fingerprint, plan.newPackageFingerprint, 'New package differs from reviewed installed-adoption plan');
  assert.equal(digest(plan.files.filter(f => f.after !== null).map(f => ({ path: f.path, revision: f.after }))), pkg.fingerprint);
  return applyReviewedPlan(plan, paths, pkg, options);
}
async function resume(options, complete) {
  const guard = reviewedRecoveryCompatibility(options);
  let readers;
  // Validate closure, authorization and target paths before taking the lock.
  const onStep = async event => guardedSteps(options, guard, readers)(event);
  const currentTool = await maintenance(options, onStep);
  return withPluginUpgradeTargetLock(options, async () => {
    await requireSettled(options);
    const raw = await file(join(resolve(options.backupRoot), options.batchId, 'plan.json'), 64 * 1024 * 1024);
    assert.ok(raw, 'Missing recovery plan');
    const paths = journalPaths(JSON.parse(raw.data.toString('utf8')));
    const tool = paths === FULL_PLUGIN_FILES ? currentTool : await maintenance(options, onStep, paths);
    readers = mainReaders(await tool.review(options.batchId));
    const side = complete ? 'after' : 'before'; await guard(readers[side], !complete);
    const result = complete ? await tool.complete(options.batchId, MIGRATION) : await tool.recover(options.batchId);
    await guard(readers[side], !complete); return result;
  });
}
export const rollbackFullPluginUpgrade = options => resume(options, false);
export const completeFullPluginUpgrade = options => resume(options, true);
