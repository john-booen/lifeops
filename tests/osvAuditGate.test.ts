import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error Pure operator-script contracts use recorded/synthetic JSON, not a scanner.
import { evaluateOsvReport, npmLockPackages } from "../scripts/osv-audit-gate.mjs";
// @ts-expect-error No downloads or scanner calls occur in this test.
import { auditEnvironment, databaseMetadata, parseAuditArguments, prepareAudit, runIsolatedAudit, scanArguments, TOOL, verifyDatabasePreparation, verifyPreparation } from "../scripts/offline-osv-audit.mjs";
// @ts-expect-error Pure operator-script tests use synthetic transports only.
import { acquireRangeDatabase, crc32cBytes, createRangeTransport, rangeDigests, rangePlan, rangeSnapshot, RANGE_POLICY, runRangeTasks, validateCoverage, validateRange, verifyRangeDatabase } from "../scripts/osv-range-download.mjs";

const networkGuard = vi.hoisted(() => ({ curlCalls: 0 }));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawnSync: (command: string, ...args: any[]) => {
    if (command === "/usr/bin/curl") {
      networkGuard.curlCalls++;
      throw Error("Real curl is forbidden in offline audit unit tests");
    }
    return (original.spawnSync as any)(command, ...args);
  }, spawn: (command: string, ...args: any[]) => {
    if (command === "/usr/bin/curl") { networkGuard.curlCalls++; throw Error("Real curl is forbidden in offline audit unit tests"); }
    return (original.spawn as any)(command, ...args);
  } };
});

describe("fresh bounded range acquisition", () => {
  const bytes = Buffer.from("123456789"), md5 = createHash("md5").update(bytes).digest("base64"), etag = `"${createHash("md5").update(bytes).digest("hex")}"`;
  function headers(body = bytes, status = 200, start = 0, end = body.length - 1) {
    const fullMd5 = createHash("md5").update(body).digest("base64"), fullETag = createHash("md5").update(body).digest("hex");
    return `HTTP/2 ${status}\r\ncontent-length: ${status === 200 ? body.length : end - start + 1}\r\nx-goog-hash: md5=${fullMd5}\r\nx-goog-hash: crc32c=${crc32cBytes(body)}\r\netag: "${fullETag}"\r\nx-goog-generation: 1792003692241371\r\nx-goog-metageneration: 1\r\nx-goog-stored-content-encoding: identity\r\nx-goog-stored-content-length: ${body.length}\r\nlast-modified: ${new Date(Date.now() - 1000).toUTCString()}\r\ndate: ${new Date().toUTCString()}\r\n${status === 206 ? `content-range: bytes ${start}-${end}/${body.length}\r\n` : ""}\r\n`;
  }
  it("matches independent Castagnoli known vectors", () => {
    expect(crc32cBytes(bytes)).toBe("4waSgw=="); expect(crc32cBytes(Buffer.alloc(0))).toBe("AAAAAA==");
  });
  it("preserves both repeated hash fields in either order for single and range modes", () => {
    const raw = headers(), snapshot = rangeSnapshot(raw), digest = { bytes: bytes.length, md5, sha256: "fixture" };
    expect(snapshot).toMatchObject({ generation: "1792003692241371", md5, crc32c: "4waSgw==" });
    expect(databaseMetadata(raw, digest).md5).toBe(md5);
    const reversed = raw.replace(/x-goog-hash: md5=([^\r]+)\r\nx-goog-hash: crc32c=([^\r]+)/, "x-goog-hash: crc32c=$2\r\nx-goog-hash: md5=$1");
    expect(rangeSnapshot(reversed)).toMatchObject({ md5, crc32c: "4waSgw==" }); expect(databaseMetadata(reversed, digest).md5).toBe(md5);
  });
  it.each(["etag", "generation", "metageneration", "modified", "status", "range", "short", "long", "encoded", "md5", "crc", "duplicate", "missing-hash"])("rejects the %s range defect", defect => {
    const raw = headers(), snapshot = rangeSnapshot(raw), range = { index: 0, start: 0, end: 8 }, digest = { bytes: 9 };
    let response = headers(bytes, 206).replace(/last-modified: [^\r]+/, `last-modified: ${snapshot.lastModified}`);
    if (defect === "etag") response = response.replace(etag, `"${"0".repeat(32)}"`);
    if (defect === "generation") response = response.replace("1792003692241371", "1792003692241372");
    if (defect === "metageneration") response = response.replace("metageneration: 1", "metageneration: 2");
    if (defect === "modified") response = response.replace(snapshot.lastModified, "Wed, 01 Oct 2025 00:00:00 GMT");
    if (defect === "status") response = response.replace("HTTP/2 206", "HTTP/2 200");
    if (defect === "range") response = response.replace("bytes 0-8/9", "bytes 1-9/9");
    if (defect === "short") digest.bytes--;
    if (defect === "long") digest.bytes++;
    if (defect === "encoded") response = response.replace("HTTP/2 206\r\n", "HTTP/2 206\r\ncontent-encoding: gzip\r\n");
    if (defect === "md5") response = response.replace(md5, "AAAAAAAAAAAAAAAAAAAAAA==");
    if (defect === "crc") response = response.replace("4waSgw==", "AAAAAA==");
    if (defect === "duplicate") response = response.replace("HTTP/2 206\r\n", "HTTP/2 206\r\netag: conflicting\r\n");
    if (defect === "missing-hash") response = response.replace(/x-goog-hash: crc32c=[^\r]+\r\n/, "");
    expect(() => validateRange(response, digest, snapshot, range)).toThrow();
  });
  it("allows response Date to change and rejects conflicting repeated hashes and HEAD errors", () => {
    const raw = headers(), snapshot = rangeSnapshot(raw);
    const response = headers(bytes, 206).replace(/last-modified: [^\r]+/, `last-modified: ${snapshot.lastModified}`).replace(/date: [^\r]+/, "date: Thu, 15 Oct 2026 00:00:00 GMT");
    expect(() => validateRange(response, { bytes: 9 }, snapshot, { start: 0, end: 8 })).not.toThrow();
    for (const bad of [raw.replace("200", "412"), raw.replace("200", "416"), raw.replace(/content-length: 9/, `content-length: ${RANGE_POLICY.maximumBytes + 1}`), raw.replace("1792003692241371", "NaN"), raw.replace(/x-goog-hash: crc32c=/, "x-goog-hash: md5=AAAAAAAAAAAAAAAAAAAAAA==\r\nx-goog-hash: crc32c=")]) expect(() => rangeSnapshot(bad)).toThrow();
  });
  it("requires exact bounded coverage and the final remainder", () => {
    const size = RANGE_POLICY.chunkBytes, exact = rangePlan(size * 2), remainder = rangePlan(size + 3);
    expect(exact).toEqual([{ index: 0, start: 0, end: size - 1 }, { index: 1, start: size, end: 2 * size - 1 }]);
    expect(remainder[1]).toEqual({ index: 1, start: size, end: size + 2 }); expect(rangePlan(218395491)).toHaveLength(53);
    for (const rows of [exact.slice(1), [...exact].reverse(), [exact[0], exact[0]], [exact[0], { ...exact[1], start: size + 1 }]]) expect(() => validateCoverage(rows, size * 2)).toThrow();
    for (const size of [0, -1, NaN, Infinity, RANGE_POLICY.maximumBytes + 1]) expect(() => rangePlan(size)).toThrow();
    expect(() => rangePlan(129, 1)).toThrow("Too many");
  });
  it("makes range mode explicit and preparation-only without changing defaults", async () => {
    expect(parseAuditArguments(["--prepare", "fake", "--database-ranges"])).toMatchObject({ databaseRanges: true, downloadTimeoutSeconds: 300 });
    expect(parseAuditArguments(["--prepare", "fake", "--database-ranges", "--download-timeout-seconds", "900"])).toMatchObject({ databaseRanges: true, downloadTimeoutSeconds: 900 });
    for (const args of [["--prepare", "fake", "--database-ranges", "--database-ranges"], ["--scan", "fake", "--database-ranges"], ["--isolated", "fake", "lock", "--database-ranges"], ["--prepare", "fake", "--database-ranges", "4"]]) expect(() => parseAuditArguments(args)).toThrow();
    const root = await mkdtemp(join(tmpdir(), "lifeops-range-options-")), work = join(root, "work");
    try { await expect(prepareAudit(work, 300, () => { throw Error("must not execute"); }, { databaseRanges: 4 })).rejects.toThrow("range options"); await expect(lstat(work)).rejects.toMatchObject({ code: "ENOENT" }); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  it("caps workers, stops dispatch on failure and awaits all already active requests", async () => {
    const controller = new AbortController(); let active = 0, maximum = 0, settled = 0; const started: number[] = [];
    const run = async (index: number, signal: AbortSignal) => {
      started.push(index); active++; maximum = Math.max(maximum, active);
      try { if (index === 0) { await Promise.resolve(); throw Error("synthetic failure"); } await new Promise<void>(done => { signal.addEventListener("abort", () => queueMicrotask(done), { once: true }); }); }
      finally { active--; settled++; }
    };
    await expect(runRangeTasks(Array.from({ length: 20 }, (_, i) => i), run, 4, controller)).rejects.toThrow("synthetic failure");
    expect(maximum).toBe(4); expect(started).toEqual([0, 1, 2, 3]); expect(settled).toBe(4); expect(active).toBe(0);
    const deadline = new AbortController(); deadline.abort(Error("synthetic total deadline"));
    await expect(runRangeTasks([0], () => { throw Error("should not start"); }, 4, deadline)).rejects.toThrow("total deadline");
    await expect(runRangeTasks([0], run, 5, new AbortController())).rejects.toThrow("concurrency");
  });
  it("acquires only fresh files, keeps genuine HEAD/206 and rechecks parts plus full object", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifeops-range-complete-")), database = join(root, "all.zip"), full = Buffer.alloc(RANGE_POLICY.chunkBytes + 3, 37);
    const raw = headers(full), calls: any[] = [], snapshot = rangeSnapshot(raw);
    const request = async (spec: any, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false); calls.push(spec);
      const body = spec.method === "HEAD" ? Buffer.alloc(0) : full.subarray(spec.range.start, spec.range.end + 1);
      const response = spec.method === "HEAD" ? raw : headers(full, 206, spec.range.start, spec.range.end).replace(/last-modified: [^\r]+/, `last-modified: ${snapshot.lastModified}`);
      await writeFile(spec.output, body, { flag: "wx" }); await writeFile(`${spec.output}.headers`, response, { flag: "wx" });
      await writeFile(`${spec.output}.terminal.json`, JSON.stringify({ code: 0, signal: null, error: null, terminalObserved: true, receivedBytes: body.length }), { flag: "wx" }); return response;
    };
    try {
      const proof = await acquireRangeDatabase(root, database, {}, request);
      expect(proof).toMatchObject({ transferMode: "ranges", transferIntegrityVerified: true, bytes: full.length });
      expect(await readFile(database)).toEqual(full); expect(calls).toHaveLength(3);
      expect(calls[1].url).toBe(`https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip?generation=${snapshot.generation}`);
      expect((await readFile(`${database}.ranges/part-0.headers`, "utf8")).startsWith("HTTP/2 206")).toBe(true);
      expect(await verifyRangeDatabase(database, proof.acquiredAt)).toEqual(proof);
      const modified = Buffer.from(full); modified[0] ^= 1; await writeFile(database, modified);
      await expect(verifyRangeDatabase(database, proof.acquiredAt)).rejects.toThrow("checksum"); await writeFile(database, full);
      await writeFile(`${database}.ranges/part-1`, "bad"); await expect(verifyRangeDatabase(database, proof.acquiredAt)).rejects.toThrow("modified");
      await expect(acquireRangeDatabase(root, database, {}, request)).rejects.toMatchObject({ code: "EEXIST" }); expect(calls).toHaveLength(3);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000); // Two fresh chunks and repeated disk/full-checksum corruption checks under coverage.
  it.each(["md5", "crc32c"])("rejects an assembled %s mismatch without a successful manifest", async algorithm => {
    const root = await mkdtemp(join(tmpdir(), "lifeops-range-bad-full-")), database = join(root, "all.zip");
    let raw = headers(), calls = 0;
    if (algorithm === "md5") raw = raw.replace(md5, "AAAAAAAAAAAAAAAAAAAAAA==").replace(etag, `"${"0".repeat(32)}"`);
    else raw = raw.replace("4waSgw==", "AAAAAA==");
    const request = async (spec: any) => {
      calls++; const body = spec.method === "HEAD" ? Buffer.alloc(0) : bytes;
      const response = spec.method === "HEAD" ? raw : raw.replace("HTTP/2 200", "HTTP/2 206").replace("\r\n\r\n", "\r\ncontent-range: bytes 0-8/9\r\n\r\n");
      await writeFile(spec.output, body, { flag: "wx" }); await writeFile(`${spec.output}.headers`, response, { flag: "wx" });
      await writeFile(`${spec.output}.terminal.json`, JSON.stringify({ code: 0, signal: null, error: null, terminalObserved: true, receivedBytes: body.length }), { flag: "wx" }); return response;
    };
    try { await expect(acquireRangeDatabase(root, database, {}, request)).rejects.toThrow("checksum"); expect(calls).toBe(2); await expect(lstat(`${database}.ranges/manifest.json`)).rejects.toMatchObject({ code: "ENOENT" }); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  it("applies the total deadline and removes its original signal handlers", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifeops-range-deadline-")), before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    let entered: () => void = () => {}; const started = new Promise<void>(done => { entered = done; });
    vi.useFakeTimers();
    try {
      const request = async (_: any, signal: AbortSignal) => new Promise<string>((_, reject) => { entered(); signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
      const pending = acquireRangeDatabase(root, join(root, "all.zip"), {}, request).catch((error: Error) => error);
      await started; await vi.advanceTimersByTimeAsync(RANGE_POLICY.totalSeconds * 1000);
      expect((await pending).message).toContain("total deadline"); expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
      await expect(lstat(join(root, "all.zip.ranges/manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); }
  });
  it("binds preparation mode, actual HEAD description and all range-proof fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifeops-range-preparation-binding-")), database = join(root, "cache/osv-scalibr/npm/all.zip"), raw = headers();
    await mkdir(join(root, "cache/osv-scalibr/npm"), { recursive: true });
    const request = async (spec: any) => {
      const body = spec.method === "HEAD" ? Buffer.alloc(0) : bytes;
      const response = spec.method === "HEAD" ? raw : raw.replace("HTTP/2 200", "HTTP/2 206").replace("\r\n\r\n", "\r\ncontent-range: bytes 0-8/9\r\n\r\n");
      await writeFile(spec.output, body, { flag: "wx" }); await writeFile(`${spec.output}.headers`, response, { flag: "wx" });
      await writeFile(`${spec.output}.terminal.json`, JSON.stringify({ code: 0, signal: null, error: null, terminalObserved: true, receivedBytes: body.length }), { flag: "wx" }); return response;
    };
    try {
      const databaseProof = await acquireRangeDatabase(root, database, {}, request), description = "fixed public HEAD and generation-pinned range GET only";
      expect(await verifyDatabasePreparation(root, databaseProof, description)).toEqual(databaseProof);
      const proof = { platform: "darwin", arch: "arm64", tool: { ...TOOL }, database: databaseProof, preparationRequests: description };
      for (const key of ["rangeManifestSha256", "crc32c", "generation", "metageneration"]) {
        await writeFile(join(root, "preparation.json"), JSON.stringify({ ...proof, database: { ...databaseProof, [key]: "changed" } }));
        await expect(verifyPreparation(root)).rejects.toThrow("Range preparation proof mismatch");
      }
      await writeFile(join(root, "preparation.json"), JSON.stringify({ ...proof, database: { ...databaseProof, transferMode: "unknown" } }));
      await expect(verifyPreparation(root)).rejects.toThrow("Unknown database transfer mode");
      const singleProof = { ...databaseProof }; delete singleProof.transferMode;
      await writeFile(`${database}.headers`, raw); // A forged full-200 header must not enable downgrade.
      await writeFile(join(root, "preparation.json"), JSON.stringify({ ...proof, database: singleProof, preparationRequests: "fixed public GET only" }));
      await expect(verifyPreparation(root)).rejects.toThrow("downgraded");
      await expect(verifyDatabasePreparation(root, databaseProof, "fixed public GET only")).rejects.toThrow("description mismatch");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("bounds external cancellation when the child never closes and preserves unknown termination", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifeops-range-no-close-")), controller = new AbortController(); let child: any, kills = 0;
    const launch = () => { child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdio = [null, child.stdout, child.stderr, new PassThrough()]; child.kill = () => { kills++; return true; }; return child; };
    vi.useFakeTimers();
    try {
      const output = join(root, "cancelled"), pending = createRangeTransport(root, {}, launch)({ method: "HEAD", url: "https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip", seconds: 30, maximumBodyBytes: 0, output }, controller.signal).catch((error: Error) => error);
      controller.abort(Error("synthetic external abort")); await vi.advanceTimersByTimeAsync(5000);
      expect((await pending).message).toContain("synthetic external abort"); expect(kills).toBeGreaterThan(0);
      expect(JSON.parse(await readFile(`${output}.terminal.json`, "utf8"))).toMatchObject({ terminalObserved: false, code: null, signal: null, error: "synthetic external abort" });
      expect(controller.signal.aborted).toBe(true); expect(child.stdout.destroyed).toBe(true);
    } finally { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(["head", "oversize-headers"])("keeps the %s native transfer bounded and observes closure", async mode => {
    const root = await mkdtemp(join(tmpdir(), "lifeops-range-header-")); let argsUsed: string[] = [];
    const launch = (_: string, args: string[]) => {
      argsUsed = args; const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdio = [null, child.stdout, child.stderr, new PassThrough()];
      let closed = false; const finish = (code: number | null, signal: string | null) => { if (closed) return; closed = true; child.stdout.end(); child.stderr.end(); child.stdio[3].end(); child.emit("close", code, signal); };
      child.kill = (signal: string) => { queueMicrotask(() => finish(null, signal)); return true; };
      queueMicrotask(() => { child.stdio[3].write(mode === "head" ? headers() : "x".repeat(RANGE_POLICY.headerBytes + 1)); if (mode === "head") finish(0, null); }); return child;
    };
    try {
      const output = join(root, mode), pending = createRangeTransport(root, {}, launch)({ method: "HEAD", url: "https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip", seconds: 30, maximumBodyBytes: 0, output }, new AbortController().signal);
      if (mode === "head") { expect(await pending).toContain("HTTP/2 200"); expect(argsUsed).toEqual(expect.arrayContaining(["--head", "--output", "/dev/null"])); }
      else await expect(pending).rejects.toThrow("metadata exceeds");
      const terminal = JSON.parse(await readFile(`${output}.terminal.json`, "utf8")); expect(terminal.terminalObserved).toBe(true); expect(terminal.receivedBytes).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("records child closure and enforces streamed body/header bounds with original curl arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifeops-range-stream-")); const calls: any[] = [];
    const launch = (command: string, args: string[], options: any) => {
      calls.push({ command, args, options }); const child: any = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdio = [null, child.stdout, child.stderr, new PassThrough()];
      child.kill = (signal: string) => { queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.stdio[3].end(); child.emit("close", null, signal); }); return true; };
      queueMicrotask(() => { child.stdio[3].write("HTTP/2 206\r\n\r\n"); child.stdout.write(Buffer.alloc(10)); }); return child;
    };
    try {
      const request = createRangeTransport(root, { SAFE: "only" }, launch), output = join(root, "oversize");
      await expect(request({ method: "GET", url: "https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip?generation=1", snapshot: { etag, generation: "1" }, range: { start: 0, end: 8 }, seconds: 60, maximumBodyBytes: 9, output }, new AbortController().signal)).rejects.toThrow("body exceeds");
      const terminal = JSON.parse(await readFile(`${output}.terminal.json`, "utf8")); expect(terminal.signal).toBe("SIGKILL"); expect(terminal.receivedBytes).toBe(10);
      expect(calls[0].args).toEqual(expect.arrayContaining(["--range", "0-8", "If-Match: " + etag, "x-goog-if-generation-match: 1", "--max-time", "60"])); expect(calls[0].options.env).toEqual({ SAFE: "only" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
afterAll(() => expect(networkGuard.curlCalls).toBe(0));

async function sample(name = "01_complete_low_moderate") {
  return JSON.parse(await readFile(new URL(`./fixtures/osv-audit/${name}.json`, import.meta.url), "utf8"));
}
const fixtures = ["01_complete_low_moderate", "02_complete_high", "03_missing_package", "04_tool_error", "05_unknown_severity"];

describe("official OSV report gate", () => {
  it.each(fixtures)("enforces the prepared %s contract", async name => {
    const fixture = await sample(name);
    if (["03_missing_package", "04_tool_error", "05_unknown_severity"].includes(name)) expect(() => evaluateOsvReport(fixture.input)).toThrow();
    else {
      const result = evaluateOsvReport(fixture.input);
      expect(result.gate).toBe(fixture.expected.gate);
      expect(result.observedPackageVersions).toBe(fixture.expected.observedPackageVersions);
      expect(result.scannerExitCode).toBe(1);
      expect(result.lowerSeverityFindings.length + result.blockingFindings.length).toBe(fixture.expected.retainedFindings);
      expect(result.allVulnerabilitiesZero).toBe(false);
    }
  });
  it.each(["wrong-version", "duplicate", "wrong-source", "wrong-ecosystem", "missing-group", "severity-conflict", "exit-conflict", "signal", "tool-error", "reported-error", "null-findings", "null-groups", "malformed-errors"])("rejects %s without weakening the finding boundary", async defect => {
    const { input } = await sample();
    const result = input.scannerResult.results[0], first = result.packages[0];
    if (defect === "wrong-version") first.package.version = "0.0.0";
    if (defect === "duplicate") result.packages.push(structuredClone(first));
    if (defect === "wrong-source") result.source.path = "/synthetic/other/package-lock.json";
    if (defect === "wrong-ecosystem") first.package.ecosystem = "Go";
    if (defect === "missing-group") first.groups = [];
    if (defect === "severity-conflict") first.groups[0].max_severity = "8.7";
    if (defect === "exit-conflict") input.scannerExitCode = 0;
    if (defect === "signal") input.scannerSignal = "SIGTERM";
    if (defect === "tool-error") input.scannerError = "ETIMEDOUT";
    if (defect === "reported-error") input.scannerStderr = "Unable to load database";
    if (defect === "null-findings") first.vulnerabilities = null;
    if (defect === "null-groups") first.groups = null;
    if (defect === "malformed-errors") input.scannerResult.errors = { message: "fictional error" };
    expect(() => evaluateOsvReport(input)).toThrow();
  });
  it("uses maximum group severity without falsely rejecting lower advisories in a mixed group", async () => {
    const { input } = await sample();
    const first = input.scannerResult.results[0].packages[0];
    first.vulnerabilities.push({ ...structuredClone(first.vulnerabilities[0]), id: "FICTIONAL-HIGH", database_specific: { severity: "HIGH" } });
    first.groups[0].ids.push("FICTIONAL-HIGH"); first.groups[0].max_severity = "8.7";
    const result = evaluateOsvReport(input); expect(result.gate).toBe("fail");
    expect(result.blockingFindings.some((row: any) => row.id === "FICTIONAL-HIGH")).toBe(true);
  });
  it.each(["no-version", "git", "local", "link", "alias", "tarball-version"])("fails explicitly on unsupported %s inventory instead of skipping it", async defect => {
    const { input } = await sample(), entry = input.packageLock.packages["node_modules/esbuild"];
    if (defect === "no-version") delete entry.version;
    if (defect === "git") entry.resolved = "git+https://github.com/fictional/project.git";
    if (defect === "local") entry.resolved = "file:../fictional";
    if (defect === "link") entry.link = true;
    if (defect === "alias") entry.name = "another-package";
    if (defect === "tarball-version") entry.resolved = "https://registry.npmjs.org/esbuild/-/esbuild-0.27.0.tgz";
    expect(() => npmLockPackages(input.packageLock)).toThrow();
  });
  it("does not confuse an error word in a normal database path with an actual tool error", async () => {
    const { input } = await sample(); input.scannerStderr = "Loaded npm local db from /tmp/error/fixture/npm/all.zip\n";
    expect(evaluateOsvReport(input).gate).toBe("pass");
  });
  it("deduplicates nested installs of the same version while preserving distinct versions", async () => {
    const { input } = await sample();
    input.packageLock.packages["node_modules/moment/node_modules/esbuild"] = structuredClone(input.packageLock.packages["node_modules/esbuild"]);
    expect(evaluateOsvReport(input).observedPackageVersions).toBe(2);
    input.packageLock.packages["node_modules/moment/node_modules/esbuild"].version = "0.27.0";
    input.packageLock.packages["node_modules/moment/node_modules/esbuild"].resolved = "https://registry.npmjs.org/esbuild/-/esbuild-0.27.0.tgz";
    expect(() => evaluateOsvReport(input)).toThrow("coverage");
  });
  it("propagates real gate subprocess failures, truncated JSON and existing-output rejection", async () => {
    const work = await mkdtemp(join(tmpdir(), "lifeops-osv-gate-test-"));
    try {
      const fixture = await sample("02_complete_high"), lock = join(work, "package-lock.json"), report = join(work, "report.json"), status = join(work, "status.json"), output = join(work, "gate.json");
      fixture.input.scannerResult.results[0].source.path = lock;
      await writeFile(lock, JSON.stringify(fixture.input.packageLock)); await writeFile(report, JSON.stringify(fixture.input.scannerResult));
      await writeFile(status, JSON.stringify({ scannerExitCode: 1, scannerStderr: "" }));
      const args = [resolve("scripts/osv-audit-gate.mjs"), lock, report, status, output];
      const run = () => spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10_000 });
      expect(run().status).toBe(1); expect(JSON.parse(await readFile(output, "utf8")).blockingFindings).toHaveLength(1);
      const preserved = await readFile(output, "utf8"); expect(run().status).toBe(2); expect(await readFile(output, "utf8")).toBe(preserved);
      await rm(output);
      await writeFile(status, JSON.stringify({ scannerExitCode: 1, scannerStderr: "", scannerResult: { results: [] }, expectedLockSourcePath: "/fictional/override/package-lock.json", packageLock: {} }));
      expect(run().status).toBe(1); expect(await readFile(output, "utf8")).toBe(preserved);
      await rm(output); await writeFile(report, '{"results":['); expect(run().status).toBe(2);
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(work, { recursive: true, force: true }); }
  });
});

describe("public preparation and OS isolation contracts", () => {
  it("retains the original default and scan/isolated positional forms", () => {
    expect(parseAuditArguments(["--prepare", "/fictional/work"])).toEqual({ mode: "--prepare", directory: "/fictional/work", downloadTimeoutSeconds: 300 });
    for (const mode of ["--scan", "--isolated"]) {
      expect(parseAuditArguments([mode, "/fictional/work", "/fictional/lock.json"])).toEqual({ mode, directory: "/fictional/work", lock: "/fictional/lock.json" });
    }
  });
  it.each([30, 900, 3600])("accepts the explicit %s second budget for preparation only", seconds => {
    expect(parseAuditArguments(["--prepare", "/fictional/work", "--download-timeout-seconds", String(seconds)]).downloadTimeoutSeconds).toBe(seconds);
  });
  it.each(["", "29", "3601", "0", "-30", "+30", "30.5", "300.0", "3e2", "300ms", " 300", "300 ", "NaN", "Infinity", "0x12", "9".repeat(400)])("rejects the incomplete or out-of-range budget %j", value => {
    expect(() => parseAuditArguments(["--prepare", "/fictional/work", "--download-timeout-seconds", value])).toThrow();
  });
  it.each([
    ["--prepare", "/fictional/work", "--download-timeout-seconds"],
    ["--prepare", "/fictional/work", "--unknown", "900"],
    ["--prepare", "/fictional/work", "--download-timeout-seconds", "900", "extra"],
    ["--prepare", "/fictional/work", "--download-timeout-seconds", "900", "--download-timeout-seconds", "900"],
    ["--scan", "/fictional/work", "--download-timeout-seconds"],
    ["--scan", "/fictional/work", "/fictional/lock.json", "--download-timeout-seconds", "900"],
    ["--isolated", "/fictional/work", "/fictional/lock.json", "--download-timeout-seconds", "900"]
  ].map(args => ({ args })))("rejects wrong mode or option shape $args", ({ args }) => {
    expect(() => parseAuditArguments(args)).toThrow();
  });
  it.each([undefined, 3600])("uses the actual selected %s budget in prepare curl and parent timeout", async seconds => {
    // The guard makes this regression safe against the old API: never let an
    // ignored injected executor accidentally start a real network download.
    expect(typeof parseAuditArguments).toBe("function");
    const root = await mkdtemp(join(tmpdir(), "lifeops-osv-budget-test-")), work = join(root, "work"), calls: any[] = [];
    try {
      const execute = (command: string, args: string[], options: any) => {
        calls.push({ command, args, options });
        return { status: 28, signal: null, stdout: "", stderr: "Synthetic public transfer deadline" };
      };
      await expect(prepareAudit(work, seconds, execute)).rejects.toThrow("Public GET download failed");
      expect(calls).toHaveLength(1);
      const call = calls[0], selected = seconds ?? 300;
      expect(call.command).toBe("/usr/bin/curl");
      expect(call.args[call.args.indexOf("--max-time") + 1]).toBe(String(selected));
      expect(call.args[call.args.indexOf("--connect-timeout") + 1]).toBe("20");
      expect(call.args[call.args.indexOf("--request") + 1]).toBe("GET");
      expect(call.options.timeout).toBe((selected + 10) * 1000);
      expect(call.options.env).toEqual(auditEnvironment(work));
      expect(call.args.at(-1)).toBe("https://github.com/google/osv-scanner/releases/download/v2.7.0/osv-scanner_darwin_arm64");
      await expect(lstat(join(work, "preparation.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(work, "osv-scanner.download-stderr"), "utf8")).toBe("Synthetic public transfer deadline");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects an invalid direct prepare budget before creating work or invoking transport", async () => {
    expect(typeof parseAuditArguments).toBe("function");
    const root = await mkdtemp(join(tmpdir(), "lifeops-osv-invalid-budget-")), work = join(root, "work");
    let calls = 0;
    try {
      for (const seconds of [NaN, Infinity, 29, 3601, 30.5, "300"]) {
        await expect(prepareAudit(work, seconds, () => { calls++; throw Error("Transport must not execute"); })).rejects.toThrow("download timeout");
        await expect(lstat(work)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(calls).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("keeps invalid CLI inputs at exit 2 without creating preparation files or requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifeops-osv-cli-budget-")), work = join(root, "work");
    try {
      for (const tail of [["--download-timeout-seconds"], ["--download-timeout-seconds", "300ms"], ["--download-timeout-seconds", "3601"]]) {
        const result = spawnSync(process.execPath, [resolve("scripts/offline-osv-audit.mjs"), "--prepare", work, ...tail], { encoding: "utf8", timeout: 10_000 });
        expect(result.status).toBe(2); expect(result.signal).toBeNull(); expect(result.stderr).toContain("Offline OSV audit stopped:");
        await expect(lstat(work)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  const bytes = Buffer.from("fictional database transfer"), md5 = createHash("md5").update(bytes).digest("base64"), hex = createHash("md5").update(bytes).digest("hex");
  const digest = { bytes: bytes.length, md5, sha256: createHash("sha256").update(bytes).digest("hex") };
  const now = "2026-10-14T01:00:00Z";
  const headers = `HTTP/2 200\r\ncontent-length: ${bytes.length}\r\nx-goog-hash: crc32c=fictional, md5=${md5}\r\netag: "${hex}"\r\nlast-modified: Wed, 14 Oct 2026 00:00:00 GMT\r\n\r\n`;
  it("records fresh transfer metadata and rejects length, hash, ETag, status and stale timestamps", () => {
    expect(databaseMetadata(headers, digest, now)).toMatchObject({ transferIntegrityVerified: true, bytes: bytes.length, etag: hex });
    for (const bad of [headers.replace(`length: ${bytes.length}`, "length: 1"), headers.replace(`md5=${md5}`, "md5=broken"), headers.replace(hex, "0".repeat(32)), headers.replace("200", "500"), headers.replace("14 Oct", "01 Oct")]) expect(() => databaseMetadata(bad, digest, now)).toThrow();
  });
  it("excludes inherited secrets, proxy settings and Node preload settings", () => {
    const env = auditEnvironment("/fictional/audit");
    expect(Object.keys(env).sort()).toEqual(["LANG", "LC_ALL", "OSV_SCALIBR_LOCAL_DB_CACHE_DIRECTORY", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]);
    expect(env.XDG_CACHE_HOME).toBe("/fictional/audit/cache");
    expect(env.OSV_SCALIBR_LOCAL_DB_CACHE_DIRECTORY).toBe("/fictional/audit/cache");
    expect(scanArguments("/fictional/audit", "/fictional/package-lock.json")).toEqual(expect.arrayContaining(["--offline", "--all-packages", "--all-vulns", "--no-resolve", "--no-call-analysis=go", "--no-call-analysis=rust"]));
  });
  it("stops before inventory access or scanner execution if OS denial is not proven", async () => {
    const work = await mkdtemp(join(tmpdir(), "lifeops-osv-canary-test-")), calls: string[] = [];
    try {
      await expect(runIsolatedAudit(work, join(work, "missing-package-lock.json"), (command: string) => { calls.push(command); return { status: 9, stdout: '{"code":"ENOTFOUND"}', stderr: "" }; })).rejects.toThrow("network denial");
      expect(calls).toHaveLength(1); await expect(readFile(join(work, "scan-status.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(verifyPreparation(work)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(work, { recursive: true, force: true }); }
  });
});
