import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gateFiles } from "./osv-audit-gate.mjs";
import { acquireRangeDatabase, responseHeaders, verifyRangeDatabase } from "./osv-range-download.mjs";

export const TOOL = Object.freeze({ version: "2.7.0", url: "https://github.com/google/osv-scanner/releases/download/v2.7.0/osv-scanner_darwin_arm64", sha256: "d4926ef8da134332543be276dff157e4c170f99ad91fc48e89448a8816bdf70b" });
const INTEL_TOOL = Object.freeze({ version: "2.7.0", url: "https://github.com/google/osv-scanner/releases/download/v2.7.0/osv-scanner_darwin_amd64", sha256: "e82c5df7ab0a42dff29a1cd0660711447b56b4c0483ff66ad8634df10fd81a45" });
export const DATABASE_URL = "https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip";
export const NETWORK_PROFILE = "(version 1)\n(allow default)\n(deny network*)\n";
const script = fileURLToPath(import.meta.url);
const assert = (value, message) => { if (!value) throw new Error(message); };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = async path => JSON.parse(await readFile(path, "utf8"));
const put = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });

export function auditEnvironment(work) {
  // Allowlist instead of inheriting Actions tokens, proxies, registry config or NODE_OPTIONS.
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: join(work, "tmp"), XDG_CACHE_HOME: join(work, "cache"), OSV_SCALIBR_LOCAL_DB_CACHE_DIRECTORY: join(work, "cache"), XDG_CONFIG_HOME: join(work, "config"), LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
}
export async function fileDigests(path) {
  const sha256 = createHash("sha256"), md5 = createHash("md5");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; sha256.update(chunk); md5.update(chunk); }
  return { bytes, sha256: sha256.digest("hex"), md5: md5.digest("base64") };
}
export function databaseMetadata(headersText, digests, acquiredAt = new Date().toISOString()) {
  const { one, hashes } = responseHeaders(headersText, 200);
  const length = one("content-length"), md5 = hashes.md5;
  const etag = one("etag")?.replace(/^"|"$/g, ""), lastModified = one("last-modified");
  assert(/^\d+$/.test(length ?? "") && Number(length) === digests.bytes && digests.bytes > 0, "Database transfer length mismatch");
  assert(md5 && md5 === digests.md5, "Database transfer MD5 mismatch");
  assert(/^[a-f0-9]{32}$/i.test(etag ?? "") && Buffer.from(md5, "base64").toString("hex") === etag.toLowerCase(), "Database ETag mismatch");
  const age = Date.parse(acquiredAt) - Date.parse(lastModified);
  assert(Number.isFinite(age) && age >= -300_000 && age <= 48 * 3600_000, "Database snapshot missing/stale/future timestamp");
  return { url: DATABASE_URL, acquiredAt, lastModified, etag, ...digests, transferIntegrityVerified: true };
}

export function reviewedTool(platform = process.platform, arch = process.arch) {
  assert(platform === "darwin" && ["arm64", "x64"].includes(arch), "Only the reviewed macOS arm64/x64 tools/platforms are supported");
  return arch === "arm64" ? TOOL : INTEL_TOOL;
}
export function verifyToolHeader(bytes, arch = process.arch) {
  reviewedTool("darwin", arch);
  assert(bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === (arch === "arm64" ? 0x0100000c : 0x01000007), `Tool executable is not Mach-O ${arch}`);
}
function requirePlatform() {
  return reviewedTool();
}
function downloadBudget(seconds) {
  assert(Number.isInteger(seconds) && seconds >= 30 && seconds <= 3600, "Invalid public download timeout; expected an integer from 30 to 3600 seconds");
  return { perDownloadSeconds: seconds, connectSeconds: 20, parentTimeoutMilliseconds: (seconds + 10) * 1000 };
}
export function parseAuditArguments(argv) {
  const usage = "Usage: offline-osv-audit.mjs --prepare WORK [--download-timeout-seconds SECONDS] [--database-ranges] | --scan WORK LOCK";
  assert(Array.isArray(argv) && argv.every(value => typeof value === "string"), usage);
  const [mode, directory, ...extra] = argv;
  assert(directory && ["--prepare", "--scan", "--isolated"].includes(mode), usage);
  if (mode === "--prepare") {
    let seconds = 300, databaseRanges = false, budgetSeen = false;
    for (let i = 0; i < extra.length; i++) {
      if (extra[i] === "--database-ranges") { assert(!databaseRanges, usage); databaseRanges = true; }
      else {
        assert(extra[i] === "--download-timeout-seconds" && !budgetSeen && /^\d+$/.test(extra[i + 1] ?? ""), usage);
        seconds = Number(extra[++i]); budgetSeen = true;
      }
    }
    downloadBudget(seconds);
    return { mode, directory, downloadTimeoutSeconds: seconds, ...(databaseRanges ? { databaseRanges: true } : {}) };
  }
  assert(extra.length === 1 && extra[0] && !extra[0].startsWith("--"), usage);
  return { mode, directory, lock: extra[0] };
}
export async function prepareAudit(work, downloadTimeoutSeconds = 300, execute = spawnSync, options = {}) {
  const budget = downloadBudget(downloadTimeoutSeconds); // Validate before any preparation side effect.
  assert(options && typeof options === "object" && Object.keys(options).every(key => ["databaseRanges", "rangeRequest"].includes(key)) && [undefined, false, true].includes(options.databaseRanges) && ["undefined", "function"].includes(typeof options.rangeRequest) && (!options.rangeRequest || options.databaseRanges === true), "Invalid preparation range options");
  const tool = requirePlatform();
  await mkdir(work, { mode: 0o700 }); // Existing directories/cache/results are never reused.
  for (const name of ["tmp", "cache/osv-scalibr/npm", "config"]) await mkdir(join(work, name), { recursive: true, mode: 0o700 });
  const env = auditEnvironment(work);
  const download = async (url, output) => {
    const headers = `${output}.headers`;
    const result = execute("/usr/bin/curl", ["-q", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https", "--request", "GET", "--header", "Cache-Control: no-cache", "--connect-timeout", "20", "--max-time", String(budget.perDownloadSeconds), "--silent", "--show-error", "--dump-header", headers, "--output", output, url], { cwd: work, env, encoding: "utf8", timeout: budget.parentTimeoutMilliseconds, maxBuffer: 1024 * 1024 });
    await writeFile(`${output}.download-stderr`, result.stderr ?? "", { flag: "wx", mode: 0o600 });
    assert(result.status === 0 && !result.signal && !result.error, "Public GET download failed; no cached fallback allowed");
    return readFile(headers, "utf8");
  };
  const binary = join(work, "osv-scanner"), database = join(work, "cache/osv-scalibr/npm/all.zip");
  await download(tool.url, binary);
  const binaryDigest = await fileDigests(binary);
  assert(binaryDigest.sha256 === tool.sha256, "Official tool SHA mismatch");
  const binaryHeader = (await readFile(binary)).subarray(0, 8);
  verifyToolHeader(binaryHeader);
  await chmod(binary, 0o700);
  let databaseProof;
  if (options.databaseRanges) databaseProof = await acquireRangeDatabase(work, database, env, options.rangeRequest);
  else { const headers = await download(DATABASE_URL, database); databaseProof = databaseMetadata(headers, await fileDigests(database)); }
  await writeFile(join(work, "empty-config.toml"), "# No ignores, overrides, or filters.\n", { flag: "wx", mode: 0o600 });
  await writeFile(join(work, "deny-network.sb"), NETWORK_PROFILE, { flag: "wx", mode: 0o600 });
  const proof = { schemaVersion: 1, preparedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, tool: { ...tool, ...binaryDigest }, database: databaseProof, downloadBudget: budget, preparationRequests: options.databaseRanges ? "fixed public HEAD and generation-pinned range GET only" : "fixed public GET only", privateInventoryRead: false, scanExecuted: false };
  await put(join(work, "preparation.json"), proof);
  return proof;
}

export const CANARY = "const net=require('node:net');const s=net.connect({host:'1.1.1.1',port:443});s.on('connect',()=>{s.destroy();process.exit(9)});s.on('error',e=>{console.log(JSON.stringify({code:e.code}));process.exit(e.code==='EPERM'?0:9)});setTimeout(()=>{s.destroy();process.exit(9)},3000);";
export function scanArguments(work, lock) {
  return ["scan", "source", "--lockfile", lock, "--offline", "--no-resolve", "--all-packages", "--all-vulns", "--no-call-analysis=go", "--no-call-analysis=rust", "--config", join(work, "empty-config.toml"), "--format=json", "--output-file", join(work, "scan-result.json")];
}
export async function verifyPreparation(work, now = Date.now()) {
  const proof = await json(join(work, "preparation.json"));
  const tool = requirePlatform();
  assert(proof.platform === process.platform && proof.arch === process.arch && proof.tool?.version === tool.version && proof.tool.url === tool.url && proof.tool.sha256 === tool.sha256 && proof.database?.url === DATABASE_URL, "Invalid preparation identity");
  const age = now - Date.parse(proof.database.acquiredAt);
  assert(Number.isFinite(age) && age >= -300_000 && age <= 3600_000, "Preparation is stale; obtain a new public snapshot");
  await verifyDatabasePreparation(work, proof.database, proof.preparationRequests);
  const toolDigest = await fileDigests(join(work, "osv-scanner"));
  assert(toolDigest.sha256 === tool.sha256 && toolDigest.bytes === proof.tool.bytes, "Prepared tool was modified");
  assert(await readFile(join(work, "deny-network.sb"), "utf8") === NETWORK_PROFILE && await readFile(join(work, "empty-config.toml"), "utf8") === "# No ignores, overrides, or filters.\n", "Isolation/configuration was modified");
  return proof;
}
export async function verifyDatabasePreparation(work, databaseProof, preparationRequests) {
  assert([undefined, "ranges"].includes(databaseProof.transferMode), "Unknown database transfer mode");
  assert(preparationRequests === (databaseProof.transferMode === "ranges" ? "fixed public HEAD and generation-pinned range GET only" : "fixed public GET only"), "Preparation request description mismatch");
  const proof = { database: databaseProof };
  const database = join(work, "cache/osv-scalibr/npm/all.zip");
  if (!proof.database.transferMode) {
    try { await lstat(`${database}.ranges`); throw Error("Range proof cannot be downgraded to single-stream"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const databaseDigest = await fileDigests(join(work, "cache/osv-scalibr/npm/all.zip"));
  assert(databaseDigest.sha256 === proof.database.sha256 && databaseDigest.bytes === proof.database.bytes && databaseDigest.md5 === proof.database.md5, "Prepared database was modified");
  const checked = proof.database.transferMode === "ranges" ? await verifyRangeDatabase(database, proof.database.acquiredAt) : databaseMetadata(await readFile(`${database}.headers`, "utf8"), databaseDigest, proof.database.acquiredAt);
  assert(checked.lastModified === proof.database.lastModified && checked.etag === proof.database.etag, "Database metadata mismatch");
  if (proof.database.transferMode === "ranges") assert(["crc32c", "generation", "metageneration", "rangeManifestSha256"].every(key => checked[key] === proof.database[key]), "Range preparation proof mismatch");
  return checked;
}

export async function runIsolatedAudit(work, lock, execute = spawnSync) {
  requirePlatform();
  const env = auditEnvironment(work);
  const options = { cwd: work, env, encoding: "utf8", timeout: 600_000, maxBuffer: 10 * 1024 * 1024 };
  // Probe precedes any lock/inventory read; all descendants inherit this OS sandbox.
  const canary = execute(process.execPath, ["-e", CANARY], { ...options, timeout: 5000 });
  await put(join(work, "network-canary.json"), { status: canary.status, signal: canary.signal ?? null, stdout: canary.stdout, stderr: canary.stderr });
  assert(canary.status === 0 && !canary.error && !canary.signal && JSON.parse(canary.stdout).code === "EPERM", "OS network denial was not proven; scan stopped");
  await verifyPreparation(work);
  assert((await stat(lock)).isFile() && lock.endsWith("/package-lock.json"), "Explicit npm package-lock.json required");
  const before = sha(await readFile(lock));
  const result = execute(join(work, "osv-scanner"), scanArguments(work, lock), options);
  await writeFile(join(work, "scan-stdout.log"), result.stdout ?? "", { flag: "wx", mode: 0o600 });
  await writeFile(join(work, "scan-stderr.log"), result.stderr ?? "", { flag: "wx", mode: 0o600 });
  const status = { scannerExitCode: result.status, scannerSignal: result.signal ?? null, scannerError: result.error?.message ?? null, scannerStderr: result.stderr ?? "" };
  await put(join(work, "scan-status.json"), status);
  assert(before === sha(await readFile(lock)), "Lockfile changed during scan");
  assert([0, 1].includes(result.status) && !result.signal && !result.error, "Scanner error/signal/timeout");
  assert(status.scannerStderr.includes(`Loaded npm local db from ${join(work, "cache/osv-scalibr/npm/all.zip")}`), "Complete npm database was not loaded");
  const gate = await gateFiles({ lockPath: lock, reportPath: join(work, "scan-result.json"), statusPath: join(work, "scan-status.json"), outputPath: join(work, "gate-result.json") });
  await verifyPreparation(work); // No tool/db/config mutation during matching.
  await put(join(work, "audit-result.json"), { ...gate, lockSha256: before, reportSha256: sha(await readFile(join(work, "scan-result.json"))), networkDenied: true, privateInventoryPostExecuted: false, officialToolVersion: TOOL.version });
  return gate;
}

export async function scanAudit(work, lock) {
  requirePlatform();
  const profile = join(work, "deny-network.sb");
  assert(await readFile(profile, "utf8") === NETWORK_PROFILE, "Isolation profile mismatch");
  const result = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, process.execPath, script, "--isolated", work, lock], { cwd: work, env: auditEnvironment(work), encoding: "utf8", timeout: 720_000, maxBuffer: 1024 * 1024 });
  await put(join(work, "isolated-terminal.json"), { exitCode: result.status, signal: result.signal ?? null, error: result.error?.message ?? null, stdout: result.stdout, stderr: result.stderr });
  assert(result.status === 0 && !result.signal && !result.error, `Isolated dependency gate rejected (exit ${result.status ?? "unknown"}); evidence retained in audit directory`);
  return json(join(work, "audit-result.json"));
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    const { mode, directory, lock, downloadTimeoutSeconds, databaseRanges } = parseAuditArguments(process.argv.slice(2));
    const work = resolve(directory);
    const result = mode === "--prepare" ? await prepareAudit(work, downloadTimeoutSeconds, spawnSync, { databaseRanges }) : mode === "--scan" ? await scanAudit(work, resolve(lock)) : await runIsolatedAudit(work, resolve(lock));
    console.log(JSON.stringify(mode === "--prepare" ? { prepared: true, toolVersion: TOOL.version, databaseDate: result.database.lastModified } : { gate: result.gate, packageVersions: result.observedPackageVersions, highCritical: result.highCritical, lowerSeverity: result.lowerSeverityFindings.length, scannerExitCode: result.scannerExitCode }));
    if (result.gate === "fail") process.exitCode = 1;
  } catch (error) { console.error(`Offline OSV audit stopped: ${error.message}`); process.exitCode = 2; }
}
