import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const taskPath = "LifeOps/Goals/Tasks/LifeOps任务库.json";
const configPath = ".obsidian/plugins/lifeops-assistant/data.json";
const markerPath = "TEST_VAULT_ONLY.md";
const PRIVATE = "SYNTHETIC-RECOVERY-PRIVATE-SENTINEL";
let root: string;
let vault: string;
let backups: string;

function run(...args: string[]) {
  const child = spawnSync(process.execPath, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(root, "scripts/data-recovery.mjs"), ...args
  ], { cwd: root, encoding: "utf8", timeout: 10000 });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  const text = `${child.stdout}${child.stderr}`;
  const output = JSON.parse(text.trim());
  expect(Object.keys(output).every(key => ["code", "status", "id", "files", "scope"].includes(key))).toBe(true);
  expect(text).not.toContain(PRIVATE);
  expect(text).not.toContain("\n    at ");
  return { exit: child.status, output, text };
}

async function tree(path: string): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  async function visit(folder: string, prefix = "") {
    for (const name of (await readdir(folder)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const entry = join(folder, name);
      const stat = await lstat(entry);
      if (stat.isSymbolicLink()) state[relative] = `link:${await readlink(entry)}`;
      else if (stat.isDirectory()) { state[relative] = "directory"; await visit(entry, relative); }
      else state[relative] = createHash("sha256").update(await readFile(entry)).digest("hex");
    }
  }
  await visit(path);
  return state;
}

async function rejectedWithoutWrites(args: string[], code?: string) {
  const before = await tree(root);
  const result = run(...args);
  expect(result.exit).toBe(1);
  if (code) expect(result.output.code).toBe(code);
  expect(await tree(root)).toEqual(before);
  return result;
}

beforeEach(async () => {
  // Resolve macOS /var -> /private/var before exercising the strict ancestor guard.
  root = await realpath(await mkdtemp(join(tmpdir(), "lifeops-recovery-cli-")));
  vault = join(root, "test-vault");
  backups = join(root, ".lifeops-test-backups");
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "src/dataFoundation"), { recursive: true });
  await mkdir(join(root, "fixtures"));
  for (const file of ["data-recovery.mjs", "test-recovery-scope.mjs"]) {
    await cp(join(sourceRoot, "scripts", file), join(root, "scripts", file));
  }
  await cp(join(sourceRoot, "src/dataFoundation/offlineRecovery.ts"), join(root, "src/dataFoundation/offlineRecovery.ts"));
  await cp(join(sourceRoot, "src/dataFoundation/recoveryEncoding.ts"), join(root, "src/dataFoundation/recoveryEncoding.ts"));
  await cp(join(sourceRoot, "fixtures/test-vault"), join(root, "fixtures/test-vault"), { recursive: true });
  await cp(join(root, "fixtures/test-vault"), vault, { recursive: true });
});

afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("fixed Test Vault recovery CLI", () => {
  it.each(["pending", "invalid", "future"])("refuses to mix offline recovery with a %s plugin transaction", async kind => {
    const path = join(vault, "LifeOps/Output/AI/Operations/write-recovery.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, kind === "invalid" ? "broken" : JSON.stringify({ version: kind === "future" ? 3 : 1, status: "pending", entries: [] }));
    await rejectedWithoutWrites(["snapshot", "blocked", "--vault-closed"], "plugin_recovery_required");
  });
  it.each(["committed", "rolled_back"])("accepts a settled encoded %s recovery document", async status => {
    const path = join(vault, "LifeOps/Output/AI/Operations/write-recovery.json"), bytes = Buffer.from("纯虚构保留内容");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 2, status, entries: [{ before: { encoding: "gzip-base64-v1", utf8Bytes: bytes.length, data: gzipSync(bytes).toString("base64") }, after: null }] }));
    expect(run("snapshot", "settled-v2", "--vault-closed").exit).toBe(0);
  });
  it.each(["pending", "missing-codec", "malformed-codec"])("preserves and rejects %s v2 recovery", async kind => {
    const path = join(vault, "LifeOps/Output/AI/Operations/write-recovery.json"), bytes = Buffer.from(PRIVATE);
    await mkdir(dirname(path), { recursive: true });
    const encoded = { encoding: "gzip-base64-v1", utf8Bytes: bytes.length, data: kind === "malformed-codec" ? "bad" : gzipSync(bytes).toString("base64") };
    await writeFile(path, JSON.stringify({ version: 2, status: kind === "pending" ? "pending" : "committed", entries: kind === "missing-codec" ? [] : [{ before: encoded, after: null }] }));
    await rejectedWithoutWrites(["snapshot", "bad-v2", "--vault-closed"], "plugin_recovery_required");
  });
  it.each(["pending", "committed", "rolled_back"])("leaves %s v3 ledger plans to compatible plugin recovery", async status => {
    const path = join(vault, "LifeOps/Output/AI/Operations/write-recovery.json"), bytes = Buffer.from(PRIVATE);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 3, status, entries: [], ledgerUndo: {
      kind: "ledger-revert-v1", before: { encoding: "gzip-base64-v1", utf8Bytes: bytes.length, data: gzipSync(bytes).toString("base64") }
    } }));
    await rejectedWithoutWrites(["snapshot", "ledger-v3", "--vault-closed"], "plugin_recovery_required");
  });
  it.each([
    [], ["unknown"], ["snapshot", "first"], ["restore", "first", "second"], ["recover", "first"],
    ["snapshot", "first", "--target", "other", "--vault-closed"],
    ["snapshot", "first", "--plan", "other", "--vault-closed"],
    ["snapshot", "first", "--vault-closed", "--vault-closed"],
    ["snapshot", "first", "second", "--vault-closed"],
    ["snapshot", "../escape", "--vault-closed"],
    ["snapshot", "a".repeat(61), "--vault-closed"],
    ["snapshot", "with space", "--vault-closed"],
    ["restore", "first", "first", "--vault-closed"],
    ["inspect", "first", "--vault-closed"],
    ["scope", "--vault-closed"], ["unlock", "not-a-uuid", "--vault-closed"]
  ])("rejects invalid or undeclared arguments before any write: %j", async (...args) => {
    await rejectedWithoutWrites(args);
  });

  it("lists exactly 24 fixed paths and exclusions without needing a Vault", async () => {
    await rm(vault, { recursive: true });
    const before = await tree(root);
    const result = run("scope");
    expect(result.exit).toBe(0);
    expect(result.output.files).toBe(24);
    expect(result.output.scope.paths).toHaveLength(24);
    expect(new Set(result.output.scope.paths).size).toBe(24);
    expect(result.output.scope.paths.filter((p: string) => p.endsWith(".json"))).toHaveLength(17);
    expect(result.output.scope.paths.filter((p: string) => p.endsWith(".md"))).toHaveLength(2);
    expect(result.output.scope.paths.filter((p: string) => p.endsWith(".jsonl"))).toHaveLength(5);
    expect(result.output.scope.backup).toBe(".lifeops-test-backups");
    expect(result.output.scope.excluded.join(" ")).toContain(".obsidian/");
    expect(result.output.scope.excluded.join(" ")).toContain("every path not explicitly listed");
    expect(result.output.scope.vaultClosed).toContain("Operator declaration only");
    expect(await tree(root)).toEqual(before);
  });

  it("snapshots, restores, and recovers the pre-restore edit without altering .obsidian", async () => {
    const original = await readFile(join(vault, taskPath));
    const configuration = await tree(join(vault, ".obsidian"));
    expect(run("snapshot", "baseline", "--vault-closed").exit).toBe(0);
    const edited = Buffer.from(original.toString("utf8").replace("整理测试项目 Alpha", PRIVATE));
    await writeFile(join(vault, taskPath), edited);
    // Repeat snapshot ID verifies the immutable copy, not the changed target.
    expect(run("snapshot", "baseline", "--vault-closed").output.status).toBe("applied");
    expect(run("restore", "baseline", "restore1", "--vault-closed").output.status).toBe("applied");
    expect(await readFile(join(vault, taskPath))).toEqual(original);
    expect(run("restore", "baseline", "restore1", "--vault-closed").output.status).toBe("applied");
    expect(run("recover", "restore1", "--vault-closed").output.status).toBe("rolled_back");
    expect(await readFile(join(vault, taskPath))).toEqual(edited);
    expect(run("recover", "restore1", "--vault-closed").output.status).toBe("rolled_back");
    expect(await tree(join(vault, ".obsidian"))).toEqual(configuration);
    const plan = JSON.parse(await readFile(join(backups, "baseline/plan.json"), "utf8"));
    expect(plan.allowedPaths).toHaveLength(24);
    expect(plan.changes.every((change: { path: string }) => !change.path.startsWith(".obsidian/"))).toBe(true);
  });

  it("inspects snapshot bytes without a Vault and never writes during inspection", async () => {
    expect(run("snapshot", "baseline", "--vault-closed").exit).toBe(0);
    await writeFile(join(vault, taskPath), PRIVATE);
    expect(run("inspect", "baseline").exit).toBe(0);
    await rm(vault, { recursive: true });
    const before = await tree(root);
    expect(run("inspect", "baseline").output.status).toBe("applied");
    expect(await tree(root)).toEqual(before);
  });

  it("retains corrupt or unknown-format bytes without normalizing them", async () => {
    const original = Buffer.from([0x7b, 0xff, 0x00, 0x7d, 0x0d, 0x0a]);
    await writeFile(join(vault, taskPath), original);
    expect(run("snapshot", "raw", "--vault-closed").exit).toBe(0);
    await writeFile(join(vault, taskPath), "{}");
    expect(run("restore", "raw", "restore_raw", "--vault-closed").exit).toBe(0);
    expect(await readFile(join(vault, taskPath))).toEqual(original);
  });

  it("keeps backups outside a simulated rebuild and restores only the listed data", async () => {
    const original = Buffer.from(`{ "tasks": [], "syntheticEvidence": "${PRIVATE}" }\n`);
    await writeFile(join(vault, taskPath), original);
    expect(run("snapshot", "before_rebuild", "--vault-closed").exit).toBe(0);
    await rm(vault, { recursive: true });
    await cp(join(root, "fixtures/test-vault"), vault, { recursive: true });
    const outsideScope = join(vault, "LifeOps/Knowledge/Ideas/测试知识.md");
    await writeFile(outsideScope, PRIVATE);
    const configuration = await tree(join(vault, ".obsidian"));
    expect(run("restore", "before_rebuild", "restore_rebuilt", "--vault-closed").exit).toBe(0);
    expect(await readFile(join(vault, taskPath))).toEqual(original);
    expect(await readFile(outsideScope, "utf8")).toBe(PRIVATE);
    expect(await tree(join(vault, ".obsidian"))).toEqual(configuration);
    expect((await lstat(join(backups, "before_rebuild/plan.json"))).isFile()).toBe(true);
    expect(Object.keys(await tree(vault)).some(path => path.includes(".lifeops-test-backups") || path.endsWith("/plan.json"))).toBe(false);
  });

  it("rejects a changed marker without echoing its contents", async () => {
    await writeFile(join(vault, markerPath), PRIVATE);
    await rejectedWithoutWrites(["snapshot", "bad_marker", "--vault-closed"], "invalid_test_vault_marker");
  });

  it.each([
    ["ai", "apiKey", PRIVATE], ["ai", "fallbackApiKey", PRIVATE], ["vision", "apiKey", PRIVATE],
    ["voice", "aliyunAccessKeyId", PRIVATE], ["voice", "aliyunAccessKeySecret", PRIVATE], ["voice", "aliyunAppKey", PRIVATE],
    ["gateway", "sharedSecret", PRIVATE], ["realtimeVoice", "apiKey", PRIVATE],
    ["ai", "provider", "custom"], ["ai", "fallbackProvider", "custom"], ["embedding", "provider", "custom"],
    ["vision", "cameraEnabled", true], ["vision", "screenEnabled", true], ["realtimeVoice", "triggerEnabled", true],
    ["proactive", "enabled", true], ["proactive", "systemNotificationsEnabled", true], ["proactive", "highPriorityVoiceEnabled", true]
  ])("rejects unsafe setting %s.%s without echoing values", async (group, field, value) => {
    const settings = JSON.parse(await readFile(join(vault, configPath), "utf8"));
    settings[group as string][field as string] = value;
    await writeFile(join(vault, configPath), JSON.stringify(settings));
    await rejectedWithoutWrites(["snapshot", "bad_settings", "--vault-closed"], "unsafe_test_vault_settings");
  });

  it("refuses configured paths outside the fixed default scope", async () => {
    const settings = JSON.parse(await readFile(join(vault, configPath), "utf8"));
    settings.folders = { tasks: "OtherTasks" };
    await writeFile(join(vault, configPath), JSON.stringify(settings));
    await rejectedWithoutWrites(["snapshot", "other_scope", "--vault-closed"], "scope_settings_mismatch");
  });

  it("does not echo malformed configuration parser details", async () => {
    await writeFile(join(vault, configPath), `{ ${PRIVATE}`);
    await rejectedWithoutWrites(["snapshot", "bad_json", "--vault-closed"], "invalid_test_vault_configuration");
  });

  it.each(["task-symlink", "marker-symlink", "backup-symlink", "task-hardlink"])("rejects %s before writes", async (kind) => {
    const external = join(root, "outside-scope.json");
    await writeFile(external, PRIVATE);
    if (kind === "task-hardlink") await link(join(vault, taskPath), join(root, "hardlink.json"));
    else if (kind === "backup-symlink") {
      await mkdir(join(root, "outside-backups"));
      await symlink(join(root, "outside-backups"), backups, "dir");
    } else {
      const path = join(vault, kind === "task-symlink" ? taskPath : markerPath);
      await rm(path);
      await symlink(external, path);
    }
    await rejectedWithoutWrites(["snapshot", "unsafe_path", "--vault-closed"], "unsafe_disk_path");
  });

  it("rejects a corrupt snapshot before changing the target", async () => {
    expect(run("snapshot", "baseline", "--vault-closed").exit).toBe(0);
    const path = join(backups, "baseline/plan.json");
    const plan = JSON.parse(await readFile(path, "utf8"));
    plan.changes[0].before = { hash: "0".repeat(64), data: Buffer.from(PRIVATE).toString("base64") };
    await writeFile(path, JSON.stringify(plan));
    await rejectedWithoutWrites(["restore", "baseline", "bad_restore", "--vault-closed"], "invalid_backup");
  });
});
