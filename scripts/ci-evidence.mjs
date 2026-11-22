import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCoverageBaseline } from "./coverage-gate.mjs";
import { assert, PACKAGE_FILES, readSourceFile, sha256, verifyPluginPackage } from "./verify-plugin-package.mjs";

export const FULL_CI_STEPS = ["network-guard", "typecheck", "coverage", "coverage-gate", "gateway-syntax", "production-bundle", "package-prepare", "package-verify"];
const PACKAGE_NAMES = [...PACKAGE_FILES, "SHA256SUMS.txt"].sort();
const EVIDENCE_FILES = ["ci-result.json", "coverage/coverage-summary.json", "coverage/coverage-provenance.json", "test-results.json", ...PACKAGE_NAMES.map(name => `package/${name}`)].sort();
const json = bytes => JSON.parse(bytes.toString("utf8"));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function assertResult(result) {
  assert(result?.schemaVersion === 1 && result.status === "verified" && same(result.completed, FULL_CI_STEPS), "Only a completed full CI run may be archived");
  assert(typeof result.workDir === "string" && isAbsolute(result.workDir) && resolve(result.workDir) === result.workDir && result.report === join(result.workDir, "coverage/coverage-summary.json"), "Invalid original CI paths");
}

export function testCounts(report) {
  assert(report?.success === true, "Tests did not succeed");
  const names = ["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests", "numFailedTestSuites", "numRuntimeErrorTestSuites"];
  for (const name of names) assert(Number.isSafeInteger(report[name] ?? (name === "numRuntimeErrorTestSuites" ? 0 : undefined)) && (report[name] ?? 0) >= 0, `Invalid test counter: ${name}`);
  assert(report.numPassedTests > 0 && report.numFailedTests === 0 && report.numFailedTestSuites === 0 && (report.numRuntimeErrorTestSuites ?? 0) === 0, "Full test run contains failures");
  assert(report.numTotalTests === report.numPassedTests + report.numFailedTests + report.numPendingTests + report.numTodoTests, "Test counters do not balance");
  assert(Array.isArray(report.testResults) && report.testResults.length > 0 && report.testResults.every(row => row.status === "passed" && Array.isArray(row.assertionResults) && row.assertionResults.every(a => ["passed", "skipped", "todo"].includes(a.status))), "Incomplete or failed test results");
  const counters = { passed: 0, pending: 0, todo: 0 };
  for (const row of report.testResults) for (const assertion of row.assertionResults) counters[assertion.status === "skipped" ? "pending" : assertion.status]++;
  assert(counters.passed === report.numPassedTests && counters.pending === report.numPendingTests && counters.todo === report.numTodoTests, "Test rows disagree with counters");
  return { passed: report.numPassedTests, failed: 0, skipped: report.numPendingTests, todo: report.numTodoTests };
}

async function checkContents({ root, folder, recordedRoot }) {
  const contents = new Map();
  for (const name of EVIDENCE_FILES) contents.set(name, await readSourceFile(folder, name));
  const result = json(contents.get("ci-result.json")); assertResult(result);
  const tests = testCounts(json(contents.get("test-results.json")));
  await verifyCoverageBaseline({ root, report: join(folder, "coverage/coverage-summary.json"), reportedRoot: recordedRoot });
  const pkg = await verifyPluginPackage({ root, packageDir: join(folder, "package") });
  for (const name of ["manifest.json", "styles.css"]) assert(pkg.contents.get(name).equals(await readSourceFile(root, name)), `Package differs from source: ${name}`);
  return { contents, result, tests, pkg };
}

async function inventory(folder, prefix = "") {
  const stat = await lstat(folder); assert(stat.isDirectory() && !stat.isSymbolicLink(), "Evidence directory must be regular");
  const names = [];
  for (const name of await readdir(folder)) {
    const path = join(folder, name), relative = prefix + name, item = await lstat(path);
    assert(!item.isSymbolicLink(), "Symbolic link in CI evidence");
    if (item.isDirectory()) {
      assert(!prefix && ["coverage", "package"].includes(name), "Unexpected evidence directory");
      names.push(...await inventory(path, `${relative}/`));
    } else { assert(item.isFile(), "Evidence entry must be regular"); names.push(relative); }
  }
  return names.sort();
}

/** Preserve original runner bytes. Root mapping affects only path lookup, never source hashes. */
export async function verifyCiEvidence({ root, evidenceDir, expectedSource, expectedRun }) {
  assert(/^[a-f0-9]{40}$/.test(expectedSource), "Exact candidate source is required");
  assert(same(await inventory(evidenceDir), [...EVIDENCE_FILES, "evidence.json"].sort()), "CI evidence file set differs");
  const manifest = json(await readSourceFile(evidenceDir, "evidence.json"));
  assert(manifest.schemaVersion === 1 && manifest.kind === "lifeops-source-ci" && manifest.source === expectedSource, "CI evidence describes a different source");
  assert(manifest.github?.workflow === "ci.yml" && /^[\w.-]+\/[\w.-]+$/.test(manifest.github.repository) && Number.isSafeInteger(manifest.github.runId) && manifest.github.runId > 0 && Number.isSafeInteger(manifest.github.runAttempt) && manifest.github.runAttempt > 0, "Invalid hosted CI identity");
  if (expectedRun) for (const [name, value] of Object.entries(expectedRun)) assert(manifest.github[name] === value, `Hosted CI ${name} differs`);
  assert(same(Object.keys(manifest.files ?? {}).sort(), EVIDENCE_FILES), "CI evidence inventory is incomplete");
  for (const name of EVIDENCE_FILES) {
    const bytes = await readSourceFile(evidenceDir, name), pin = manifest.files[name];
    assert(pin?.sha256 === sha256(bytes) && pin.bytes === bytes.length, `CI evidence hash mismatch: ${name}`);
  }
  const checked = await checkContents({ root, folder: evidenceDir, recordedRoot: manifest.recordedRoot });
  assert(manifest.recordedRoot && manifest.version === json(checked.pkg.contents.get("manifest.json")).version && same(manifest.tests, checked.tests), "CI evidence version or counters differ");
  assert(same(manifest.packageHashes, Object.fromEntries([...checked.pkg.contents].map(([name, bytes]) => [name, sha256(bytes)]))), "CI evidence package fingerprint differs");
  return { source: manifest.source, version: manifest.version, github: manifest.github, tests: checked.tests, packageHashes: manifest.packageHashes, completed: checked.result.completed, verified: true };
}

export async function exportCiEvidence({ root, result, source, output, github }) {
  assertResult(result); assert(/^[a-f0-9]{40}$/.test(source), "Exact candidate source is required");
  const original = json(await readSourceFile(result.workDir, "ci-result.json")); assert(same(original, result), "CI result differs from original file");
  const checked = await checkContents({ root, folder: result.workDir, recordedRoot: root });
  const manifest = {
    schemaVersion: 1, kind: "lifeops-source-ci", source, recordedRoot: root,
    version: json(checked.pkg.contents.get("manifest.json")).version, github, tests: checked.tests,
    files: Object.fromEntries([...checked.contents].map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha256(bytes) }])),
    packageHashes: Object.fromEntries([...checked.pkg.contents].map(([name, bytes]) => [name, sha256(bytes)]))
  };
  const target = resolve(output); await mkdir(dirname(target), { recursive: true });
  assert(!(await lstat(dirname(target))).isSymbolicLink(), "Evidence output parent must be regular");
  const lockPath = `${target}.export.lock`, lock = await open(lockPath, "wx", 0o600); let stage;
  try {
    try { await lstat(target); throw Error("CI evidence output already exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    stage = await mkdtemp(`${target}.stage-`);
    for (const [name, bytes] of checked.contents) { await mkdir(dirname(join(stage, name)), { recursive: true }); await writeFile(join(stage, name), bytes, { flag: "wx" }); }
    await writeFile(join(stage, "evidence.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    const verified = await verifyCiEvidence({ root, evidenceDir: stage, expectedSource: source, expectedRun: github });
    await rename(stage, target); stage = undefined; return { ...verified, evidenceDir: target };
  } finally { if (stage) await rm(stage, { recursive: true, force: true }); await lock.close(); await rm(lockPath); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv.length === 5 && ["--verify", "--reuse"].includes(process.argv[2]), "Usage: ci-evidence.mjs --verify|--reuse EVIDENCE_DIR EXACT_SOURCE_SHA");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() === process.argv[4], "Evidence source differs from the current Git checkout");
  const expectedRun = process.argv[2] === "--reuse" ? { repository: process.env.GITHUB_REPOSITORY, runId: Number(process.env.SOURCE_CI_RUN_ID), runAttempt: Number(process.env.SOURCE_CI_RUN_ATTEMPT), workflow: "ci.yml" } : undefined;
  console.log(JSON.stringify(await verifyCiEvidence({ root, evidenceDir: resolve(process.argv[3]), expectedSource: process.argv[4], expectedRun }), null, 2));
}
