import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_RECOVERY_PATHS, TEST_RECOVERY_SCOPE, TEST_RECOVERY_SCOPE_ID } from "./test-recovery-scope.mjs";
import { decodeFactRecovery } from "../src/dataFoundation/recoveryEncoding.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vaultRoot = join(root, "test-vault");
const backupRoot = join(root, ".lifeops-test-backups");
// Keep operator-facing batch IDs short and unambiguous.
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CONFIG_BYTES = 1024 * 1024;
let EngineRecoveryError;

class CliError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function refuse(code) { throw new CliError(code); }
function isMissing(error) { return error?.code === "ENOENT"; }

function argumentsFor(args) {
  const [command, ...rest] = args;
  const counts = { scope: 0, snapshot: 1, inspect: 1, restore: 2, recover: 1, unlock: 1 };
  if (!Object.hasOwn(counts, command)) refuse("invalid_arguments");
  const closedFlags = rest.filter(value => value === "--vault-closed");
  if (closedFlags.length > 1 || rest.some(value => value.startsWith("--") && value !== "--vault-closed")) refuse("invalid_arguments");
  const ids = rest.filter(value => value !== "--vault-closed");
  const writes = !["scope", "inspect"].includes(command);
  if (ids.length !== counts[command] || (!writes && closedFlags.length)) refuse("invalid_arguments");
  if (command === "unlock") {
    if (!UUID.test(ids[0])) refuse("invalid_unlock_token");
  } else if (ids.some(id => !ID.test(id))) refuse("invalid_id");
  if (command === "restore" && ids[0] === ids[1]) refuse("restore_requires_new_id");
  if (writes && !closedFlags.length) refuse("vault_closed_declaration_required");
  return { command, ids, writes };
}

async function regularFile(path, assertSafeDiskPath, optional = false) {
  await assertSafeDiskPath(path);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1) refuse("unsafe_test_vault_file");
    return stat;
  } catch (error) {
    if (optional && isMissing(error)) return null;
    throw error;
  }
}

async function configBytes(path, assertSafeDiskPath) {
  const stat = await regularFile(path, assertSafeDiskPath);
  if (stat.size > MAX_CONFIG_BYTES) refuse("invalid_test_vault_configuration");
  return readFile(path);
}

function checkSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) refuse("unsafe_test_vault_settings");
  const checks = [
    ["ai", "provider", "off"], ["ai", "fallbackProvider", "off"],
    ["ai", "apiKey", ""], ["ai", "fallbackApiKey", ""],
    ["embedding", "provider", "off"], ["embedding", "apiKey", ""],
    ["vision", "provider", "off"], ["vision", "apiKey", ""],
    ["vision", "cameraEnabled", false], ["vision", "cameraMode", "off"],
    ["vision", "screenEnabled", false],
    ["vision", "privacyNoticeAccepted", false], ["vision", "screenPrivacyNoticeAccepted", false],
    ["voice", "provider", "off"], ["voice", "apiKey", ""],
    ["voice", "aliyunAccessKeyId", ""], ["voice", "aliyunAccessKeySecret", ""], ["voice", "aliyunAppKey", ""],
    ["realtimeVoice", "provider", "off"], ["realtimeVoice", "apiKey", ""],
    ["realtimeVoice", "autoSendOnStop", false], ["realtimeVoice", "cloudFallback", false],
    ["realtimeVoice", "speakReplies", false], ["realtimeVoice", "triggerEnabled", false],
    ["gateway", "sharedSecret", ""],
    ["proactive", "enabled", false], ["proactive", "systemNotificationsEnabled", false],
    ["proactive", "highPriorityVoiceEnabled", false]
  ];
  if (checks.some(([group, field, expected]) => settings[group]?.[field] !== expected)) refuse("unsafe_test_vault_settings");
  for (const group of ["ai", "embedding", "vision", "voice", "realtimeVoice", "privacy"]) {
    for (const field of ["dataDisclosureAccepted", "remoteDataDisclosureAccepted", "plaintextCredentialStorageAccepted"]) {
      const value = settings[group]?.[field];
      if (value !== undefined && value !== false) refuse("unsafe_test_vault_settings");
    }
  }
  const defaults = { tasks: "LifeOps/Goals/Tasks", habits: "LifeOps/Goals/Habits", aiReports: "LifeOps/Output/AI" };
  if (settings.folders !== undefined) {
    if (!settings.folders || typeof settings.folders !== "object" || Array.isArray(settings.folders)) refuse("scope_settings_mismatch");
    for (const [key, expected] of Object.entries(defaults)) {
      if (settings.folders[key] !== undefined && settings.folders[key] !== expected) refuse("scope_settings_mismatch");
    }
  }
}

async function preflightWrite(assertSafeDiskPath) {
  for (const path of [root, vaultRoot, backupRoot]) await assertSafeDiskPath(path);
  for (const path of [root, vaultRoot]) if (!(await lstat(path)).isDirectory()) refuse("invalid_test_vault");
  try {
    if (!(await lstat(backupRoot)).isDirectory()) refuse("invalid_backup_root");
  } catch (error) { if (!isMissing(error)) throw error; }
  const marker = await configBytes(join(vaultRoot, "TEST_VAULT_ONLY.md"), assertSafeDiskPath);
  const reference = await configBytes(join(root, "fixtures", "test-vault", "TEST_VAULT_ONLY.md"), assertSafeDiskPath);
  if (!marker.equals(reference)) refuse("invalid_test_vault_marker");
  const settingsData = await configBytes(join(vaultRoot, ".obsidian", "plugins", "lifeops-assistant", "data.json"), assertSafeDiskPath);
  let settings;
  try { settings = JSON.parse(settingsData.toString("utf8")); }
  catch { refuse("invalid_test_vault_configuration"); }
  checkSettings(settings);
  // The fixed DATA-02 snapshot is not a backup of an in-flight plugin transaction.
  // Resolve that transaction first; never mix two independent recovery plans.
  const journalPath = join(vaultRoot, "LifeOps/Output/AI/Operations/write-recovery.json");
  const journalStat = await regularFile(journalPath, assertSafeDiskPath, true);
  if (journalStat) {
    if (journalStat.size > 16 * 1024 * 1024) refuse("plugin_recovery_required");
    let journal;
    try {
      const wire = JSON.parse(await readFile(journalPath, "utf8"));
      // DATA-02 does not validate deterministic Ledger undo plans. Keep the
      // new representation inside the compatible plugin's recovery boundary.
      if (wire?.version === 3) refuse("plugin_recovery_required");
      journal = decodeFactRecovery(wire);
    } catch { refuse("plugin_recovery_required"); }
    if (journal?.version !== 1 || Object.hasOwn(journal, "schemaVersion")
      || !["committed", "rolled_back"].includes(journal.status) || !Array.isArray(journal.entries)) refuse("plugin_recovery_required");
  }
  // Reject bad target paths before the engine creates a backup directory or lock.
  for (const path of TEST_RECOVERY_PATHS) await regularFile(join(vaultRoot, path), assertSafeDiskPath, true);
}

function output(result) {
  console.log(JSON.stringify({ code: "ok", status: result.status, id: result.batchId, files: result.files, scope: TEST_RECOVERY_SCOPE_ID }));
}

async function main() {
  // Parse before dynamic imports or filesystem reads; invalid arguments cannot write.
  const request = argumentsFor(process.argv.slice(2));
  if (request.command === "scope") {
    console.log(JSON.stringify({ code: "ok", status: "scope_only", files: TEST_RECOVERY_PATHS.length, scope: TEST_RECOVERY_SCOPE }));
    return;
  }
  const { OfflineRecovery, RecoveryError, assertSafeDiskPath } = await import("../src/dataFoundation/offlineRecovery.ts");
  EngineRecoveryError = RecoveryError;
  if (request.writes) await preflightWrite(assertSafeDiskPath);
  else {
    // Snapshot inspection verifies only its backup. For other batch types, the
    // engine can also verify current target hashes; neither inspection writes.
    await assertSafeDiskPath(root);
    await assertSafeDiskPath(backupRoot);
  }
  const recovery = new OfflineRecovery({ vaultRoot, backupRoot, allowedPaths: TEST_RECOVERY_PATHS });
  const [id, newId] = request.ids;
  if (request.command === "snapshot") output(await recovery.snapshot(id));
  else if (request.command === "inspect") output(await recovery.inspect(id));
  else if (request.command === "restore") output(await recovery.restore(id, newId));
  else if (request.command === "recover") output(await recovery.recover(id));
  else {
    await recovery.releaseStaleLock(id);
    // Do not repeat the operator's lock token in output.
    console.log(JSON.stringify({ code: "ok", status: "unlocked", files: 0, scope: TEST_RECOVERY_SCOPE_ID }));
  }
}

try { await main(); }
catch (error) {
  const trusted = error instanceof CliError || (EngineRecoveryError && error instanceof EngineRecoveryError);
  const code = trusted && typeof error.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? error.code : "recovery_cli_failed";
  console.error(JSON.stringify({ code, status: "stopped; see docs/DATA_RECOVERY_GUIDE.md", files: 0, scope: TEST_RECOVERY_SCOPE_ID }));
  process.exitCode = 1;
}
