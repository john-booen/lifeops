import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error Operator scripts use synthetic filesystem fixtures.
import { COVERAGE_TARGETS, coverageSourceHashes, writeCoverageProvenance, recordCoverageBaseline } from "../scripts/coverage-gate.mjs";
// @ts-expect-error Operator scripts use synthetic filesystem fixtures.
import { FULL_CI_STEPS, exportCiEvidence, verifyCiEvidence, testCounts } from "../scripts/ci-evidence.mjs";
// @ts-expect-error Operator scripts use synthetic filesystem fixtures.
import { preparePluginPackage } from "../scripts/prepare-plugin-package.mjs";
// @ts-expect-error Operator scripts use synthetic filesystem fixtures.
import { sha256 } from "../scripts/verify-plugin-package.mjs";

let home: string, root: string, workDir: string, output: string, result: any;
const source = "a".repeat(40), github = { repository: "fictional/lifeops", workflow: "ci.yml", runId: 17, runAttempt: 1 };
const reportData = () => ({ success: true, numTotalTests: 3, numPassedTests: 1, numFailedTests: 0, numPendingTests: 1, numTodoTests: 1, numFailedTestSuites: 0, testResults: [{ status: "passed", assertionResults: [{ status: "passed" }, { status: "skipped" }, { status: "todo" }] }] });
async function put(name: string, data: string | Buffer) { await mkdir(dirname(name), { recursive: true }); await writeFile(name, data); }
const options = () => ({ root, result, source, output, github });
const verify = (extra = {}) => verifyCiEvidence({ root, evidenceDir: output, expectedSource: source, expectedRun: github, ...extra });
async function editManifest(edit: (manifest: any) => void) { const path = join(output, "evidence.json"), manifest = JSON.parse(await readFile(path, "utf8")); edit(manifest); await writeFile(path, JSON.stringify(manifest)); }

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "lifeops-ci-evidence-test-")));
  root = join(home, "source"); workDir = join(home, "run"); output = join(home, "export");
  for (const name of Object.keys(COVERAGE_TARGETS)) await put(join(root, name), `// fictional ${name}\n`);
  await put(join(root, "vitest.coverage.config.mts"), "// fictional policy\n");
  const report = join(workDir, "coverage/coverage-summary.json"), rows: any = { total: {} };
  for (const name of Object.keys(COVERAGE_TARGETS)) rows[join(root, name)] = { lines: { total: 20, covered: 10 }, branches: { total: 8, covered: 4 } };
  await put(report, JSON.stringify(rows)); await writeCoverageProvenance({ root, report, before: await coverageSourceHashes(root) });
  await mkdir(join(root, "scripts"), { recursive: true }); await recordCoverageBaseline({ root, report });
  await put(join(root, "manifest.json"), JSON.stringify({ id: "lifeops-assistant", version: "0.1.0", isDesktopOnly: true }));
  await put(join(root, "styles.css"), "/* fictional css */"); await put(join(root, "main.js"), "// fictional bundle");
  const resources = JSON.parse(await readFile("scripts/plugin-package-resources.json", "utf8"));
  for (const file of resources.files) { const bytes = Buffer.from(`Fictional resource ${file.path}\n`); file.sizeBytes = bytes.length; file.sha256 = sha256(bytes); await put(join(root, file.source), bytes); }
  await put(join(root, "scripts/plugin-package-resources.json"), JSON.stringify(resources));
  await preparePluginPackage({ root, output: join(workDir, "package") });
  await put(join(workDir, "test-results.json"), JSON.stringify(reportData()));
  result = { schemaVersion: 1, status: "verified", workDir, report, completed: [...FULL_CI_STEPS] };
  await put(join(workDir, "ci-result.json"), JSON.stringify(result));
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("portable exact-source full CI evidence", () => {
  it("preserves original reports and the verified six-file package across source roots", async () => {
    const exported = await exportCiEvidence(options());
    expect(exported.tests).toEqual({ passed: 1, failed: 0, skipped: 1, todo: 1 });
    const relocated = join(home, "relocated"); await cp(root, relocated, { recursive: true }); await rm(root, { recursive: true });
    expect(await verify({ root: relocated })).toMatchObject({ source, version: "0.1.0", verified: true });
    expect(await readFile(join(output, "coverage/coverage-summary.json"))).toEqual(await readFile(result.report));
    expect(Object.keys(exported.packageHashes)).toHaveLength(6);
  });
  it("never overwrites existing evidence", async () => {
    await exportCiEvidence(options()); const before = await readFile(join(output, "evidence.json"));
    await expect(exportCiEvidence(options())).rejects.toThrow("already exists"); expect(await readFile(join(output, "evidence.json"))).toEqual(before);
  });
  it.each(["failed", "coverage_collected_baseline_pending"])("rejects %s runs", async status => {
    result.status = status; await expect(exportCiEvidence(options())).rejects.toThrow("completed full CI");
  });
  it("rejects a missing step and an in-memory result different from its saved bytes", async () => {
    result.completed.pop(); await expect(exportCiEvidence(options())).rejects.toThrow("completed full CI");
    result.completed.push("package-verify"); result.extra = true;
    await expect(exportCiEvidence(options())).rejects.toThrow("differs from original");
  });
  it("requires the exact source and hosted run identity", async () => {
    await exportCiEvidence(options()); await expect(verify({ expectedSource: "b".repeat(40) })).rejects.toThrow("different source");
    await expect(verify({ expectedRun: { ...github, runId: 18 } })).rejects.toThrow("runId differs");
  });
  it.each(["src/privacy.ts", "vitest.coverage.config.mts"])("rejects source or policy changes: %s", async name => {
    await exportCiEvidence(options()); await writeFile(join(root, name), "changed"); await expect(verify()).rejects.toThrow(/current source|policy changed/);
  });
  it.each(["manifest.json", "styles.css"])("rejects package bytes inconsistent with the source: %s", async name => {
    await exportCiEvidence(options()); await writeFile(join(root, name), name === "manifest.json" ? JSON.stringify({ id: "lifeops-assistant", version: "0.1.0", isDesktopOnly: true, name: "changed" }) : "changed css");
    await expect(verify()).rejects.toThrow("Package differs from source");
  });
  it.each(["test-results.json", "coverage/coverage-summary.json", "package/main.js"])("rejects changed archive bytes: %s", async name => {
    await exportCiEvidence(options()); await writeFile(join(output, name), "tampered"); await expect(verify()).rejects.toThrow("hash mismatch");
  });
  it("rejects an edited root mapping even if its file hashes are untouched", async () => {
    await exportCiEvidence(options()); await editManifest(m => { m.recordedRoot = join(root, "wrong"); }); await expect(verify()).rejects.toThrow("unexpected file");
  });
  it("still applies the current nonregression baseline at import", async () => {
    await exportCiEvidence(options()); const path = join(root, "scripts/coverage-baseline.json"), baseline = JSON.parse(await readFile(path, "utf8")); baseline.files["src/privacy.ts"].lines.covered++;
    await writeFile(path, JSON.stringify(baseline)); await expect(verify()).rejects.toThrow("Coverage regression");
  });
  it("rejects extra files, missing files and symbolic links", async () => {
    await exportCiEvidence(options()); const path = join(output, "private.json"); await writeFile(path, "{}"); await expect(verify()).rejects.toThrow("file set"); await rm(path);
    const report = join(output, "test-results.json"); await rm(report); await expect(verify()).rejects.toThrow("file set"); await symlink(join(workDir, "test-results.json"), report); await expect(verify()).rejects.toThrow("Symbolic link");
  });
  it.each([
    { success: false }, { numFailedTests: 1 }, { numFailedTestSuites: 1 }, { numRuntimeErrorTestSuites: 1 }, { numTotalTests: 4 }, { numPassedTests: 1.5 }, { testResults: [] },
    { testResults: [{ status: "failed", assertionResults: [] }] }, { testResults: [{ status: "passed", assertionResults: [] }] },
    { testResults: [{ status: "passed", assertionResults: [{ status: "passed" }, { status: "pending" }, { status: "todo" }] }] }
  ])("refuses invalid successful-looking counters %j", change => {
    expect(() => testCounts({ ...reportData(), ...change })).toThrow();
  });
});
