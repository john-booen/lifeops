// Offline operator tooling. The CLI only stages a reviewed package in this repo.
// Apply/recover exports require a separate, explicit, closed-vault operation.
import assert from 'node:assert/strict';
import { lstat, mkdir, open, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OfflineRecovery, assertSafeDiskPath, revisionHash } from '../src/dataFoundation/offlineRecovery.ts';
import { decodeFactRecovery } from '../src/dataFoundation/recoveryEncoding.ts';

export const PLUGIN_FILES = Object.freeze(['main.js', 'manifest.json', 'styles.css']);
const MAX_BYTES = 16 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
const pluginPath = vault => join(vault, '.obsidian', 'plugins', 'lifeops-assistant');
const fingerprint = value => revisionHash(Buffer.from(JSON.stringify(value)));

async function bytes(path, limit = MAX_BYTES) {
  await assertSafeDiskPath(path);
  const stat = await lstat(path);
  assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= limit, 'Unsafe or oversized upgrade file');
  return readFile(path);
}
async function json(path, limit = 1024 * 1024) {
  const raw = await bytes(path, limit);
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new Error('Invalid upgrade metadata'); }
}
async function readBytesIfPresent(path) {
  try { return await bytes(path, 64 * 1024 * 1024); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function fileList(files) {
  assert.ok(Array.isArray(files) && files.length === PLUGIN_FILES.length, 'Upgrade must contain exactly three artifacts');
  assert.deepEqual(files.map(x => x.path).sort(), [...PLUGIN_FILES].sort(), 'Unexpected upgrade artifact');
  for (const file of files) assert.match(file.sha256, HASH, 'Invalid artifact hash');
}
function pluginIdentity(raw) {
  let manifest;
  try { manifest = JSON.parse(raw.toString('utf8')); } catch { throw new Error('Invalid plugin manifest'); }
  assert.equal(manifest.id, 'lifeops-assistant', 'Unexpected plugin identity');
  assert.equal(manifest.isDesktopOnly, true, 'Unsupported plugin platform');
  assert.ok(typeof manifest.version === 'string' && manifest.version.length > 0, 'Missing plugin version');
}
async function directory(path) {
  await assertSafeDiskPath(path);
  assert.ok((await lstat(path)).isDirectory(), 'Expected directory');
  assert.equal(await realpath(path), resolve(path), 'Noncanonical upgrade root');
}

export async function stagePluginUpgrade(candidateDir, destination) {
  const source = resolve(candidateDir), target = resolve(destination);
  await directory(source);
  const manifest = await json(join(source, 'candidate-manifest.json'));
  assert.match(manifest.candidate, ID, 'Invalid candidate identity');
  fileList(manifest.artifacts);
  const artifacts = [];
  for (const file of manifest.artifacts) {
    const data = await bytes(join(source, 'candidate', file.path));
    assert.equal(revisionHash(data), file.sha256, 'Frozen candidate hash mismatch');
    artifacts.push({ file, data });
  }
  pluginIdentity(artifacts.find(x => x.file.path === 'manifest.json').data);
  await directory(dirname(target));
  await assertSafeDiskPath(target);
  await mkdir(target, { mode: 0o700 }); // Refuse reuse; never overwrite a prior package.
  const payload = { version: 1, candidate: manifest.candidate, files: manifest.artifacts };
  for (const { file, data } of artifacts) await writeFile(join(target, file.path), data, { flag: 'wx', mode: 0o600 });
  const plan = { ...payload, fingerprint: fingerprint(payload) };
  await writeFile(join(target, 'upgrade-package.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await loadUpgradePackage(target);
  return plan;
}

export async function loadUpgradePackage(folder) {
  await directory(folder);
  const plan = await json(join(folder, 'upgrade-package.json'));
  assert.equal(plan.version, 1, 'Unsupported upgrade package');
  assert.match(plan.candidate, ID);
  fileList(plan.files);
  assert.equal(plan.fingerprint, fingerprint({ version: 1, candidate: plan.candidate, files: plan.files }), 'Package metadata changed');
  const artifacts = [];
  for (const file of plan.files) {
    const data = await bytes(join(folder, file.path));
    assert.equal(revisionHash(data), file.sha256, 'Package artifact changed');
    artifacts.push({ path: file.path, data });
  }
  pluginIdentity(artifacts.find(x => x.path === 'manifest.json').data);
  return { plan, artifacts };
}

// Read-only inspection. Do this only after the target-vault scope is authorized.
// It reads plugin artifacts, never configuration, credentials, diaries or tasks.
export async function planPluginUpgrade(vaultRoot, stagedPackage) {
  const vault = resolve(vaultRoot);
  await directory(vault);
  await directory(pluginPath(vault));
  const { plan, artifacts } = await loadUpgradePackage(stagedPackage);
  const changes = [];
  for (const item of artifacts) {
    const before = await bytes(join(pluginPath(vault), item.path));
    if (item.path === 'manifest.json') pluginIdentity(before);
    changes.push({ path: item.path, before: revisionHash(before), after: revisionHash(item.data) });
  }
  return { version: 1, vaultRoot: vault, candidate: plan.candidate, packageFingerprint: plan.fingerprint, changes };
}

async function maintenance(options) {
  assert.equal(options.vaultClosed, true, 'Close the target vault before maintenance');
  assert.ok(typeof options.authorization === 'string' && options.authorization.trim().length > 0, 'Explicit operator authorization is required');
  assert.match(options.batchId, ID);
  const vault = resolve(options.vaultRoot), backup = resolve(options.backupRoot);
  const rel = relative(vault, backup);
  assert.ok(rel && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)), 'Backup must be outside the entire vault');
  await directory(vault);
  await directory(pluginPath(vault));
  return new OfflineRecovery({ vaultRoot: pluginPath(vault), backupRoot: backup, allowedPaths: PLUGIN_FILES, maxPlanBytes: 64 * 1024 * 1024, onStep: options.onStep });
}

async function withTargetLock(options, operation, bindNamespace = false) {
  // Shared by every backup root for this canonical vault. A losing operation
  // cannot undo a successful operation's identical artifact bytes.
  const vault = resolve(options.vaultRoot);
  const locks = join(dirname(vault), '.lifeops-plugin-upgrade-locks');
  await assertSafeDiskPath(locks);
  await mkdir(locks, { recursive: true, mode: 0o700 });
  await directory(locks);
  const lock = join(locks, `${fingerprint(vault)}.json`);
  const value = Buffer.from(JSON.stringify({ version: 1, pid: process.pid, token: randomUUID(), vaultRoot: vault,
    backupRoot: resolve(options.backupRoot), batchId: options.batchId }));
  const handle = await open(lock, 'wx', 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  try {
    // Permanent target-to-backup binding also survives a failed rollback.
    // Picking another backup folder must not hide this target's pending work.
    const namespace = join(locks, `${fingerprint(vault)}.namespace.json`);
    const expected = { version: 1, vaultRoot: vault, backupRoot: resolve(options.backupRoot) };
    await assertSafeDiskPath(namespace);
    if (bindNamespace) {
      try {
        const binding = await open(namespace, 'wx', 0o600);
        try { await binding.writeFile(JSON.stringify(expected)); await binding.sync(); } finally { await binding.close(); }
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    assert.deepEqual(await json(namespace), expected, 'Target is bound to a different recovery namespace');
    return await operation();
  }
  finally {
    // An interrupted process leaves the lock for explicit operator recovery;
    // a changed lock is never silently deleted.
    assert.ok((await bytes(lock, 4096)).equals(value), 'Upgrade lock changed; recovery required');
    await unlink(lock);
  }
}

async function requireSettledBatches(backupRoot, currentBatch, vaultRoot) {
  for (const item of await readdir(backupRoot, { withFileTypes: true })) {
    if (!item.isDirectory() || item.name === currentBatch) continue;
    assert.match(item.name, ID, 'Unknown recovery directory');
    const folder = join(backupRoot, item.name);
    await directory(folder);
    // prepare() can fail before publishing its journal. No target write is
    // possible in that empty-directory state; retain it as failed preparation.
    if ((await readdir(folder)).length === 0) continue;
    const state = await json(join(backupRoot, item.name, 'state.json'));
    const previous = await json(join(folder, 'plan.json'), 64 * 1024 * 1024);
    const { fingerprint: priorFingerprint, ...payload } = previous;
    assert.equal(priorFingerprint, fingerprint(payload), 'Earlier backup plan changed');
    assert.equal(previous.version, 1);
    assert.equal(previous.batchId, item.name);
    assert.equal(previous.vaultRoot, pluginPath(resolve(vaultRoot)));
    assert.deepEqual(previous.allowedPaths, [...PLUGIN_FILES].sort());
    assert.equal(state.version, 1);
    assert.match(state.fingerprint, HASH);
    assert.equal(state.fingerprint, priorFingerprint, 'Earlier recovery state changed');
    assert.ok(['applied', 'rolled_back'].includes(state.status), 'Earlier upgrade needs recovery');
  }
}

// Explicit operator attestation, NOT automatic discovery or a manifest-version
// inference. The path must be reviewed from this vault's actual Runtime path;
// readers must be reviewed against exact main.js bytes and retained evidence.
// This guard reads one authorized WAL and never rewrites/settles it. Runtime
// remains responsible for full fact/path/ledger validation when it is opened.
function recoveryCompatibility(options) {
  assert.ok(options.recoveryCompatibility, 'Reviewed recovery compatibility is required');
  const review = structuredClone(options.recoveryCompatibility), vault = resolve(options.vaultRoot);
  assert.equal(review.vaultRoot, vault, 'Recovery review belongs to another vault');
  const path = review.relativePath;
  assert.ok(typeof path === 'string' && !isAbsolute(path) && !path.includes('\\')
    && !/[\x00-\x1f\x7f:]/.test(path) && path.split('/').every(p => p && !p.startsWith('.') && !p.endsWith(' '))
    && path.endsWith('/Operations/write-recovery.json'), 'Unsafe recovery review path');
  const evidence = value => assert.ok(typeof value === 'string' && value.trim().length > 0
    && value.length <= 2000, 'Retained recovery review evidence is required');
  evidence(review.pathEvidence);
  assert.ok(review.expectedHash === null || (typeof review.expectedHash === 'string' && HASH.test(review.expectedHash)), 'Invalid reviewed WAL hash');
  assert.ok(Array.isArray(review.readers) && review.readers.length > 0 && review.readers.length <= 8, 'Reviewed program readers are required');
  const seen = new Set();
  for (const reader of review.readers) {
    assert.match(reader.mainSha256, HASH, 'Invalid reviewed reader hash');
    assert.ok(!seen.has(reader.mainSha256), 'Duplicate reviewed reader'); seen.add(reader.mainSha256);
    evidence(reader.evidence);
    assert.ok(Array.isArray(reader.wireVersions) && reader.wireVersions.length > 0
      && new Set(reader.wireVersions).size === reader.wireVersions.length
      && reader.wireVersions.every(v => [1, 2, 3].includes(v)), 'Invalid reviewed recovery versions');
    assert.ok(Array.isArray(reader.ledgerUndoKinds) && reader.ledgerUndoKinds.every(k => k === 'ledger-revert-v1')
      && new Set(reader.ledgerUndoKinds).size === reader.ledgerUndoKinds.length, 'Invalid reviewed recovery plans');
  }
  return async (mainHash, restoring = false) => {
    const reader = review.readers.find(item => item.mainSha256 === mainHash);
    assert.ok(reader, 'Exact target program has no reviewed recovery reader');
    let raw;
    try { raw = await bytes(join(vault, path)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; raw = null; }
    assert.equal(revisionHash(raw), review.expectedHash, 'Reviewed recovery WAL changed');
    if (raw === null) return;
    const text = raw.toString('utf8'); assert.ok(Buffer.from(text).equals(raw), 'Invalid recovery WAL encoding');
    let wire;
    try { wire = JSON.parse(text); } catch { throw new Error('Invalid recovery WAL envelope'); }
    assert.ok(wire && typeof wire === 'object' && !Array.isArray(wire) && [1, 2, 3].includes(wire.version)
      && ['pending', 'committed', 'rolled_back'].includes(wire.status)
      && typeof wire.operationId === 'string' && wire.operationId.length > 0 && Array.isArray(wire.entries), 'Unknown recovery WAL envelope');
    decodeFactRecovery(wire); // Bounded envelope decoding; no fact reads/writes.
    assert.ok(reader.wireVersions.includes(wire.version), 'Target program cannot read retained recovery WAL');
    if (wire.version === 3) assert.ok(reader.ledgerUndoKinds.includes(wire.ledgerUndo?.kind), 'Target program cannot read retained recovery plan');
    assert.ok(!restoring || wire.status !== 'pending', 'Settle pending fact recovery with a compatible program before rollback');
  };
}

// The full-package operator shares this exact canonical-vault lock, permanent
// backup namespace, and reviewed WAL guard. Keep the legacy CLI behavior intact.
export { withTargetLock as withPluginUpgradeTargetLock, recoveryCompatibility as reviewedRecoveryCompatibility };

async function recoveryMain(options, side) {
  // Bind rollback reader to the immutable program backup, not the installed
  // or newly staged program. OfflineRecovery additionally validates all bytes.
  const plan = await json(join(resolve(options.backupRoot), options.batchId, 'plan.json'), 64 * 1024 * 1024);
  const { fingerprint: digest, ...payload } = plan;
  assert.equal(digest, fingerprint(payload), 'Recovery backup plan changed');
  assert.equal(plan.version, 1); assert.equal(plan.batchId, options.batchId);
  assert.equal(plan.migrationId, 'plugin-upgrade-v1');
  assert.equal(plan.vaultRoot, pluginPath(resolve(options.vaultRoot)));
  assert.deepEqual(plan.allowedPaths, [...PLUGIN_FILES].sort());
  assert.deepEqual(plan.changes.map(item => item.path).sort(), [...PLUGIN_FILES].sort());
  assert.ok(['before', 'after'].includes(side));
  const revision = plan.changes.find(item => item.path === 'main.js')[side];
  assert.ok(revision && typeof revision.data === 'string', 'Program backup is required');
  assert.match(revision.hash, HASH);
  const raw = Buffer.from(revision.data, 'base64');
  assert.ok(raw.length <= MAX_BYTES && raw.toString('base64') === revision.data && revisionHash(raw) === revision.hash, 'Program backup changed');
  return revision.hash;
}

export async function applyPluginUpgrade(plan, stagedPackage, options) {
  assert.equal(plan.version, 1, 'Unsupported upgrade plan');
  assert.equal(plan.vaultRoot, resolve(options.vaultRoot), 'Target differs from reviewed plan');
  let guard, installedMain, originalMain;
  const tool = await maintenance({ ...options, onStep: async event => {
    if (event.stage === 'prepared') await requireSettledBatches(resolve(options.backupRoot), options.batchId, options.vaultRoot);
    const restoring = ['before-restore', 'after-restore'].includes(event.stage);
    await guard(restoring ? originalMain : installedMain, restoring);
    await options.onStep?.(event);
    await guard(restoring ? originalMain : installedMain, restoring);
  } });
  const pkg = await loadUpgradePackage(stagedPackage);
  assert.equal(pkg.plan.fingerprint, plan.packageFingerprint, 'Package differs from reviewed plan');
  assert.equal(pkg.plan.candidate, plan.candidate);
  assert.ok(Array.isArray(plan.changes) && plan.changes.length === PLUGIN_FILES.length);
  assert.deepEqual(plan.changes.map(x => x.path).sort(), [...PLUGIN_FILES].sort(), 'Plan scope changed');
  const updates = plan.changes.map(change => {
    assert.match(change.before, HASH, 'Upgrade requires existing reviewed artifacts');
    const after = pkg.artifacts.find(x => x.path === change.path).data;
    assert.equal(change.after, revisionHash(after), 'Planned artifact changed');
    return { path: change.path, expectedHash: change.before, after };
  });
  installedMain = plan.changes.find(item => item.path === 'main.js').after;
  originalMain = plan.changes.find(item => item.path === 'main.js').before;
  guard = recoveryCompatibility(options);
  return withTargetLock(options, async () => {
    // Repeated apply may bypass the prepared hook. It must still refuse a
    // different unfinished/unknown-format batch in this shared namespace.
    if (await readBytesIfPresent(join(resolve(options.backupRoot), options.batchId, 'plan.json')))
      await requireSettledBatches(resolve(options.backupRoot), options.batchId, options.vaultRoot);
    await guard(installedMain); // Compatible forward repair remains possible.
    const result = await tool.apply(options.batchId, 'plugin-upgrade-v1', updates);
    await guard(result.status === 'rolled_back' ? originalMain : installedMain, result.status === 'rolled_back');
    return result;
  }, true);
}

export async function rollbackPluginUpgrade(options) {
  // Recovery checks original and installed hashes; newer edits are a conflict,
  // not permission to overwrite them. No whole-vault snapshot restore occurs.
  let guard, originalMain;
  const tool = await maintenance({ ...options, onStep: async event => {
    await guard(originalMain, true);
    await options.onStep?.(event);
    await guard(originalMain, true);
  } });
  guard = recoveryCompatibility(options);
  return withTargetLock(options, async () => {
    await requireSettledBatches(resolve(options.backupRoot), options.batchId, options.vaultRoot);
    originalMain = await recoveryMain(options, 'before');
    await guard(originalMain, true);
    const result = await tool.recover(options.batchId);
    await guard(originalMain, true);
    return result;
  });
}

export async function completePluginUpgrade(options) {
  // Explicit repair after a compatible upgrade was interrupted. Only the
  // immutable batch after-images are used; no new package or namespace can
  // substitute another program, and the online WAL is retained exactly.
  let guard, installedMain;
  const tool = await maintenance({ ...options, onStep: async event => {
    await guard(installedMain);
    await options.onStep?.(event);
    await guard(installedMain);
  } });
  guard = recoveryCompatibility(options);
  return withTargetLock(options, async () => {
    await requireSettledBatches(resolve(options.backupRoot), options.batchId, options.vaultRoot);
    installedMain = await recoveryMain(options, 'after');
    await guard(installedMain);
    const result = await tool.complete(options.batchId, 'plugin-upgrade-v1');
    await guard(installedMain);
    return result;
  });
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.deepEqual(process.argv.slice(2), ['stage-reviewed'], 'Only stage-reviewed is exposed; no live-vault install command');
    const plan = await stagePluginUpgrade(join(root, 'dist', 'daily-quality', 'daily-quality-20260922-03'), join(root, 'dist', 'daily-upgrade-20260922-01'));
    console.log(JSON.stringify({ status: 'staged_only', candidate: plan.candidate, artifacts: plan.files.length, fingerprint: plan.fingerprint, vaultsAccessed: 0 }));
  } catch {
    console.error('Upgrade preparation stopped. Existing packages and vaults were not overwritten.');
    process.exitCode = 1;
  }
}
