import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const RANGE_URL = "https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip";
export const RANGE_POLICY = Object.freeze({ concurrency: 4, chunkBytes: 4 * 1024 * 1024, maximumBytes: 512 * 1024 * 1024, maximumChunks: 128, requestSeconds: 60, metadataSeconds: 30, totalSeconds: 900, headerBytes: 65536, stderrBytes: 65536 });
const check = (ok, message) => { if (!ok) throw Error(message); };
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const active = signal => { if (signal?.aborted) throw signal.reason ?? Error("Range acquisition cancelled"); };

// GCS repeats x-goog-hash. Preserve every value; singleton ambiguity is rejected.
export function responseHeaders(raw, expectedStatus) {
  check(Buffer.byteLength(raw) <= RANGE_POLICY.headerBytes, "Response headers exceed budget");
  const blocks = raw.trim().split(/\r?\n\r?\n/).filter(b => /^HTTP\//.test(b));
  const lines = blocks.at(-1)?.split(/\r?\n/);
  check(lines && new RegExp(`^HTTP/\\S+ ${expectedStatus}\\b`).test(lines[0]), "Unexpected HTTP status");
  const fields = new Map();
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":"); check(i > 0, "Malformed response header");
    const key = line.slice(0, i).toLowerCase(), value = line.slice(i + 1).trim();
    if (!fields.has(key)) fields.set(key, []);
    fields.get(key).push(value);
  }
  const one = key => { const values = fields.get(key); check(!values || values.length === 1, `Ambiguous ${key} header`); return values?.[0]; };
  const hashes = {};
  for (const line of fields.get("x-goog-hash") ?? []) for (const item of line.split(",")) {
    const match = item.trim().match(/^(md5|crc32c)=(\S+)$/);
    if (!match) continue;
    check(!hashes[match[1]] || hashes[match[1]] === match[2], "Conflicting object hashes");
    hashes[match[1]] = match[2];
  }
  return { one, hashes };
}
function canonicalHash(value, bytes) {
  check(typeof value === "string" && Buffer.from(value, "base64").length === bytes && Buffer.from(value, "base64").toString("base64") === value, "Missing/invalid whole-object checksum");
  return value;
}
export function rangeSnapshot(raw, acquiredAt = new Date().toISOString()) {
  const { one, hashes } = responseHeaders(raw, 200), length = one("content-length"), generation = one("x-goog-generation"), metageneration = one("x-goog-metageneration");
  const total = Number(length), etag = one("etag"), lastModified = one("last-modified");
  check(/^\d+$/.test(length ?? "") && Number.isSafeInteger(total) && total > 0 && total <= RANGE_POLICY.maximumBytes, "Object size outside range policy");
  check(/^[1-9]\d*$/.test(generation ?? "") && /^[1-9]\d*$/.test(metageneration ?? ""), "Missing immutable object version");
  const md5 = canonicalHash(hashes.md5, 16), crc32c = canonicalHash(hashes.crc32c, 4);
  check(/^"[a-f0-9]{32}"$/i.test(etag ?? "") && Buffer.from(md5, "base64").toString("hex") === etag.slice(1, -1).toLowerCase(), "Object ETag mismatch");
  check([undefined, "identity"].includes(one("content-encoding")) && one("x-goog-stored-content-encoding") === "identity" && one("x-goog-stored-content-length") === length, "Unsupported encoded object representation");
  const age = Date.parse(acquiredAt) - Date.parse(lastModified);
  check(Number.isFinite(age) && age >= -300000 && age <= 48 * 3600000, "Database snapshot missing/stale/future timestamp");
  check(!one("content-range"), "Metadata must describe the complete object");
  return { url: RANGE_URL, acquiredAt, bytes: total, generation, metageneration, etag, lastModified, md5, crc32c };
}
export function rangePlan(total, chunkBytes = RANGE_POLICY.chunkBytes) {
  check(Number.isSafeInteger(total) && total > 0 && total <= RANGE_POLICY.maximumBytes && Number.isSafeInteger(chunkBytes) && chunkBytes > 0 && chunkBytes <= RANGE_POLICY.chunkBytes, "Invalid range plan budget");
  const count = Math.ceil(total / chunkBytes); check(count <= RANGE_POLICY.maximumChunks, "Too many ranges");
  return Array.from({ length: count }, (_, index) => ({ index, start: index * chunkBytes, end: Math.min(total, (index + 1) * chunkBytes) - 1 }));
}
export function validateCoverage(rows, total) {
  const expected = rangePlan(total);
  check(rows.length === expected.length, "Incomplete range coverage");
  for (let i = 0; i < expected.length; i++) for (const key of ["index", "start", "end"]) check(rows[i]?.[key] === expected[i][key], "Range coverage gap/overlap/order mismatch");
}
export function validateRange(raw, digests, snapshot, range) {
  const { one, hashes } = responseHeaders(raw, 206);
  check(one("content-range") === `bytes ${range.start}-${range.end}/${snapshot.bytes}`, "Wrong Content-Range");
  check(one("content-length") === String(range.end - range.start + 1) && digests.bytes === range.end - range.start + 1, "Range transfer length mismatch");
  for (const [header, value] of [["etag", snapshot.etag], ["x-goog-generation", snapshot.generation], ["x-goog-metageneration", snapshot.metageneration], ["last-modified", snapshot.lastModified], ["x-goog-stored-content-length", String(snapshot.bytes)], ["x-goog-stored-content-encoding", "identity"]]) check(one(header) === value, "Range object identity/representation mismatch");
  check([undefined, "identity"].includes(one("content-encoding")) && hashes.md5 === snapshot.md5 && hashes.crc32c === snapshot.crc32c, "Range encoding/whole-object hashes mismatch");
}

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => { let crc = i; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0); return crc >>> 0; });
function updateCrc(crc, bytes) { for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8); return crc; }
export function crc32cBytes(bytes) {
  const crc = updateCrc(0xffffffff, bytes);
  const result = Buffer.alloc(4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return result.toString("base64");
}
export async function rangeDigests(path, signal) {
  const sha256 = createHash("sha256"), md5 = createHash("md5"); let bytes = 0, crc = 0xffffffff;
  for await (const chunk of createReadStream(path)) { active(signal); bytes += chunk.length; sha256.update(chunk); md5.update(chunk); crc = updateCrc(crc, chunk); }
  const encoded = Buffer.alloc(4); encoded.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return { bytes, sha256: sha256.digest("hex"), md5: md5.digest("base64"), crc32c: encoded.toString("base64") };
}

// stdout body and fd3 headers are bounded as bytes arrive, never a disk-only cap.
// Every call resolves/rejects only after its own child closes (or fails bounded settlement).
export function createRangeTransport(work, env, launch = spawn) {
  return async (spec, signal) => {
    active(signal);
    const args = ["-q", "--fail", "--proto", "=https", "--request", spec.method, "--header", "Accept-Encoding: identity", "--header", "Cache-Control: no-cache", "--connect-timeout", "20", "--max-time", String(spec.seconds), "--max-filesize", String(spec.maximumBodyBytes), "--silent", "--show-error", "--dump-header", "/dev/fd/3", "--output", spec.method === "HEAD" ? "/dev/null" : "-"];
    if (spec.method === "HEAD") args.push("--head");
    else args.push("--range", `${spec.range.start}-${spec.range.end}`, "--header", `If-Match: ${spec.snapshot.etag}`, "--header", `x-goog-if-generation-match: ${spec.snapshot.generation}`);
    args.push(spec.url);
    const child = launch("/usr/bin/curl", args, { cwd: work, env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    let failure = null, headers = Buffer.alloc(0), stderr = Buffer.alloc(0), receivedBytes = 0, killTimer, rejectSettlement;
    const settlement = new Promise((_, reject) => { rejectSettlement = reject; });
    const cancel = reason => {
      failure ??= reason; child.kill("SIGKILL");
      killTimer ??= setTimeout(() => rejectSettlement(Error("Range child termination not observed within five seconds")), 5000);
    };
    const abort = () => cancel(signal.reason ?? Error("Range request cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const terminal = new Promise(done => { child.once("error", error => { failure ??= error; }); child.once("close", (code, childSignal) => done({ code, signal: childSignal, terminalObserved: true })); });
    const collect = (stream, limit, update) => stream.on("data", chunk => { if (chunk.length + update().length > limit) cancel(Error("Response metadata exceeds byte budget")); else update(chunk); });
    collect(child.stdio[3], RANGE_POLICY.headerBytes, chunk => chunk ? (headers = Buffer.concat([headers, chunk])) : headers);
    collect(child.stderr, RANGE_POLICY.stderrBytes, chunk => chunk ? (stderr = Buffer.concat([stderr, chunk])) : stderr);
    const bound = new Transform({ transform(chunk, _, done) { receivedBytes += chunk.length; if (receivedBytes > spec.maximumBodyBytes) { cancel(Error("Response body exceeds byte budget")); done(failure); } else done(null, chunk); } });
    const body = pipeline(child.stdout, bound, createWriteStream(spec.output, { flags: "wx", mode: 0o600 })).catch(error => { cancel(error); });
    const settleTimer = setTimeout(() => cancel(Error("Range child settlement deadline")), (spec.seconds + 5) * 1000);
    let result;
    try { result = await Promise.race([terminal, settlement]); await body; }
    catch (error) { failure ??= error; result = { code: null, signal: null, terminalObserved: false }; child.stdout.destroy(); child.stderr.destroy(); child.stdio[3].destroy(); }
    finally { clearTimeout(settleTimer); clearTimeout(killTimer); signal.removeEventListener("abort", abort); await writeFile(`${spec.output}.headers`, headers, { flag: "wx", mode: 0o600 }); await writeFile(`${spec.output}.stderr`, stderr, { flag: "wx", mode: 0o600 }); }
    await save(`${spec.output}.terminal.json`, { ...result, pid: child.pid ?? null, receivedBytes, error: failure?.message ?? null });
    if (failure) throw failure;
    check(result.code === 0 && !result.signal, "Public range request failed; no retry allowed");
    return headers.toString("utf8");
  };
}

export async function runRangeTasks(tasks, run, concurrency, controller) {
  check(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= RANGE_POLICY.concurrency, "Invalid range concurrency");
  let cursor = 0; const results = new Array(tasks.length); let firstError;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (!controller.signal.aborted && cursor < tasks.length) {
      const index = cursor++;
      try { results[index] = await run(tasks[index], controller.signal); }
      catch (error) { firstError ??= error; controller.abort(error); break; }
    }
  });
  await Promise.allSettled(workers); // Do not leave this batch's other requests running.
  if (firstError) throw firstError;
  active(controller.signal); return results;
}

export async function verifyRangeDatabase(database, acquiredAt, signal) {
  const directory = `${database}.ranges`, manifestRaw = await readFile(join(directory, "manifest.json")), manifest = JSON.parse(manifestRaw);
  check(manifest.schemaVersion === 1 && manifest.mode === "ranges" && JSON.stringify(manifest.policy) === JSON.stringify(RANGE_POLICY) && manifest.snapshot.acquiredAt === acquiredAt, "Invalid range manifest/policy");
  const snapshot = rangeSnapshot(await readFile(join(directory, "metadata.headers"), "utf8"), acquiredAt);
  check(JSON.stringify(snapshot) === JSON.stringify(manifest.snapshot), "Snapshot manifest changed");
  validateCoverage(manifest.ranges, snapshot.bytes);
  for (const row of manifest.ranges) {
    active(signal);
    const path = join(directory, `part-${row.index}`), digest = await rangeDigests(path, signal);
    check(JSON.stringify(digest) === JSON.stringify(row.digests), "Prepared range was modified");
    const terminal = JSON.parse(await readFile(`${path}.terminal.json`));
    check(terminal.terminalObserved === true && terminal.code === 0 && !terminal.signal && !terminal.error && terminal.receivedBytes === digest.bytes, "Range terminal not successful");
    validateRange(await readFile(`${path}.headers`, "utf8"), digest, snapshot, row);
  }
  const terminal = JSON.parse(await readFile(join(directory, "metadata.terminal.json")));
  check(terminal.terminalObserved === true && terminal.code === 0 && !terminal.signal && !terminal.error && terminal.receivedBytes === 0, "Metadata terminal not successful");
  const digest = await rangeDigests(database, signal);
  check(digest.bytes === snapshot.bytes && digest.md5 === snapshot.md5 && digest.crc32c === snapshot.crc32c && JSON.stringify(digest) === JSON.stringify(manifest.assembled), "Full database checksum mismatch");
  active(signal);
  return { url: RANGE_URL, acquiredAt, lastModified: snapshot.lastModified, etag: snapshot.etag.slice(1, -1), ...digest, generation: snapshot.generation, metageneration: snapshot.metageneration, transferMode: "ranges", rangeManifestSha256: sha(manifestRaw), transferIntegrityVerified: true };
}
export async function acquireRangeDatabase(work, database, env, request = createRangeTransport(work, env)) {
  const directory = `${database}.ranges`; await mkdir(directory, { mode: 0o700 });
  const controller = new AbortController(), deadline = setTimeout(() => controller.abort(Error("Database stage total deadline")), RANGE_POLICY.totalSeconds * 1000);
  const interrupted = () => controller.abort(Error("Public preparation interrupted"));
  process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted);
  try {
    const raw = await request({ method: "HEAD", url: RANGE_URL, seconds: RANGE_POLICY.metadataSeconds, maximumBodyBytes: 0, output: join(directory, "metadata") }, controller.signal);
    const acquiredAt = new Date().toISOString(), snapshot = rangeSnapshot(raw, acquiredAt), ranges = rangePlan(snapshot.bytes);
    const rows = await runRangeTasks(ranges, async (range, signal) => {
      const output = join(directory, `part-${range.index}`);
      const headers = await request({ method: "GET", url: `${RANGE_URL}?generation=${snapshot.generation}`, snapshot, range, seconds: RANGE_POLICY.requestSeconds, maximumBodyBytes: range.end - range.start + 1, output }, signal);
      const digests = await rangeDigests(output, signal); validateRange(headers, digests, snapshot, range); return { ...range, digests };
    }, RANGE_POLICY.concurrency, controller);
    validateCoverage(rows, snapshot.bytes); active(controller.signal);
    async function* ordered() { for (const row of rows) for await (const chunk of createReadStream(join(directory, `part-${row.index}`))) { active(controller.signal); yield chunk; } }
    await pipeline(ordered(), createWriteStream(database, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
    const assembled = await rangeDigests(database, controller.signal);
    check(assembled.bytes === snapshot.bytes && assembled.md5 === snapshot.md5 && assembled.crc32c === snapshot.crc32c, "Full database checksum mismatch");
    await save(join(directory, "manifest.json"), { schemaVersion: 1, mode: "ranges", policy: RANGE_POLICY, snapshot, ranges: rows, assembled });
    return await verifyRangeDatabase(database, acquiredAt, controller.signal);
  } finally { clearTimeout(deadline); process.removeListener("SIGINT", interrupted); process.removeListener("SIGTERM", interrupted); }
}
