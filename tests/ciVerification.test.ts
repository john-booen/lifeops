import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error Operator scripts are exercised with synthetic filesystem fixtures.
import { COVERAGE_TARGETS, coverageSourceHashes, writeCoverageProvenance, recordCoverageBaseline, verifyCoverageBaseline } from "../scripts/coverage-gate.mjs";
// @ts-expect-error Operator scripts are exercised with a fake child-process executor.
import { ciPlan, ciEnvironment, runSafeCi } from "../scripts/verify-ci-local.mjs";
// @ts-expect-error Build options are pure JavaScript and do not import esbuild.
import { bundleOptions, assertFreshBundleOutput } from "../scripts/bundle-options.mjs";

let root: string, report: string, baseline: string;
function workflowJob(text: string, name: string): string {
  const body = text.split(`\n  ${name}:\n`)[1];
  if (body === undefined) throw Error("Workflow job missing: " + name);
  return body.split(/\n  [\w-]+:\s*\n/u)[0];
}
async function put(path: string, body: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, body); }
async function summary(path = report, changes: Record<string, unknown> = {}) {
  const rows: Record<string, any> = { total: {} };
  for (const name of Object.keys(COVERAGE_TARGETS)) rows[join(root, name)] = {
    lines: { total: 20, covered: 10, skipped: 0 }, branches: { total: 8, covered: 4, skipped: 0 }
  };
  for (const [name, change] of Object.entries(changes)) Object.assign(rows[join(root, name)], change);
  await put(path, JSON.stringify(rows)); return rows;
}
async function measured() {
  await summary(); await writeCoverageProvenance({ root, report, before: await coverageSourceHashes(root) });
}
async function baselineFixture() { await measured(); await recordCoverageBaseline({ root, report, baseline }); }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-ci-test-")); report = join(root, "coverage/coverage-summary.json"); baseline = join(root, "scripts/coverage-baseline.json");
  for (const name of Object.keys(COVERAGE_TARGETS)) await put(join(root, name), `// synthetic ${name}\n`);
  await put(join(root, "vitest.coverage.config.mts"), "// synthetic measured coverage policy\n");
  await mkdir(join(root, "scripts"), { recursive: true });
  for (const name of ["vitest", "@vitest/coverage-v8"]) await put(join(root, "node_modules", name, "package.json"), '{"version":"4.1.7"}');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("measured coverage registration and regression gate", () => {
  it("refuses to pass or create a baseline silently", async () => {
    await measured(); await expect(verifyCoverageBaseline({ root, report, baseline })).rejects.toThrow("not registered");
    await expect(readFile(baseline)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("records measured per-file counters explicitly and never overwrites the first baseline", async () => {
    await baselineFixture(); expect(Object.keys(await verifyCoverageBaseline({ root, report, baseline }))).toHaveLength(5);
    await expect(recordCoverageBaseline({ root, report, baseline })).rejects.toMatchObject({ code: "EEXIST" });
  });
  it.each(Object.keys(COVERAGE_TARGETS).flatMap(name => ["lines", "branches"].map(metric => [name, metric])))
  ("blocks an individual %s %s regression even if other files improve", async (name, metric) => {
    await baselineFixture();
    const rows = await summary(); rows[join(root, name)][metric].covered--;
    await writeFile(report, JSON.stringify(rows)); await rm(join(dirname(report), "coverage-provenance.json"));
    await writeCoverageProvenance({ root, report, before: await coverageSourceHashes(root) });
    await expect(verifyCoverageBaseline({ root, report, baseline })).rejects.toThrow(`Coverage regression: ${name} ${metric}`);
  });
  it("requires a fresh run after source changes or report tampering", async () => {
    await baselineFixture(); await writeFile(join(root, "src/privacy.ts"), "changed source");
    await expect(verifyCoverageBaseline({ root, report, baseline })).rejects.toThrow("current source");
    await writeFile(report, "{}"); await expect(verifyCoverageBaseline({ root, report, baseline })).rejects.toThrow("provenance");
  });
  it("rejects incomplete, empty and altered scopes", async () => {
    await measured(); const rows = JSON.parse(await readFile(report, "utf8")); delete rows[join(root, "src/privacy.ts")];
    await writeFile(report, JSON.stringify(rows)); await rm(join(dirname(report), "coverage-provenance.json")); await writeCoverageProvenance({ root, report, before: await coverageSourceHashes(root) });
    await expect(recordCoverageBaseline({ root, report, baseline })).rejects.toThrow("missing");
    await summary(report, { "src/privacy.ts": { branches: { total: 0, covered: 0 } } });
    await rm(join(dirname(report), "coverage-provenance.json")); await writeCoverageProvenance({ root, report, before: await coverageSourceHashes(root) });
    await expect(recordCoverageBaseline({ root, report, baseline })).rejects.toThrow("empty");
  });
  it("does not bless a report when sources changed during coverage", async () => {
    const before = await coverageSourceHashes(root); await summary(); await writeFile(join(root, "src/toolRegistry.ts"), "changed");
    await expect(writeCoverageProvenance({ root, report, before })).rejects.toThrow("changed during");
    await expect(readFile(join(dirname(report), "coverage-provenance.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("requires separate review when coverage exclusions change despite unchanged percentages", async () => {
    await baselineFixture(); await put(join(root, "vitest.coverage.config.mts"), "// changed exclusion policy\n");
    await rm(join(dirname(report), "coverage-provenance.json")); await writeCoverageProvenance({ root, report, before: await coverageSourceHashes(root) });
    await expect(verifyCoverageBaseline({ root, report, baseline })).rejects.toThrow("separate review");
  });
});

describe("safe local CI planning and orchestration", () => {
  it("defaults to a read-only plan and has no installation, vault rebuild or default artifact path", async () => {
    const child = spawnSync(process.execPath, [resolve("scripts/verify-ci-local.mjs"), "--plan"], { encoding: "utf8" });
    expect(child.status).toBe(0); const plan = JSON.parse(child.stdout);
    expect(plan.steps.map((step: { name: string }) => step.name)).toEqual(["network-guard", "typecheck", "coverage", "coverage-gate", "gateway-syntax", "production-bundle", "package-prepare", "package-verify"]);
    expect(child.stdout).not.toMatch(/test-vault|rebuild|install-plugin|offline-verify|dist\//);
    expect(plan.steps.find((step: { name: string }) => step.name === "production-bundle").args).toContain("--outfile");
    expect(plan.steps.find((step: { name: string }) => step.name === "coverage").args).toContain("--maxWorkers=2");
  });
  it("injects the existing Node guard and allocates coverage inside the isolated directory", () => {
    const env = ciEnvironment("/synthetic project", "/tmp/synthetic-ci", { NODE_OPTIONS: "--trace-warnings" });
    expect(env.NODE_OPTIONS).toContain('--require="/synthetic project/scripts/offline-network-guard.cjs"');
    expect(env.NODE_OPTIONS).toContain("--trace-warnings"); expect(env.LIFEOPS_COVERAGE_DIRECTORY).toBe("/tmp/synthetic-ci/coverage");
  });
  it("runs the planned sequence only and preserves isolated diagnostics", async () => {
    const steps: string[] = [];
    const result = await runSafeCi({ root, workParent: root, execute: async (step: any) => {
      steps.push(step.name); if (step.name === "coverage") await summary(join(step.env.LIFEOPS_COVERAGE_DIRECTORY, "coverage-summary.json"));
      return step.expectBlocked ? { status: 1, stderr: "blocked external TCP" } : { status: 0 };
    } });
    expect(result.status).toBe("verified"); expect(result.completed).toEqual(steps); expect(result.workDir.startsWith(root)).toBe(true);
    expect(JSON.parse(await readFile(join(result.workDir, "ci-result.json"), "utf8")).status).toBe("verified");
    await expect(readFile(join(root, "main.js"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("marks collection as pending and does not claim a full CI pass", async () => {
    const result = await runSafeCi({ root, workParent: root, collectCoverage: true, execute: async (step: any) => {
      if (step.name === "coverage") await summary(join(step.env.LIFEOPS_COVERAGE_DIRECTORY, "coverage-summary.json"));
      return step.expectBlocked ? { status: 1, stderr: "blocked external TCP" } : { status: 0 };
    } });
    expect(result.status).toBe("coverage_collected_baseline_pending"); expect(result.completed).toEqual(["network-guard", "typecheck", "coverage"]);
  });
  it("stops before coverage and bundle when a required command fails", async () => {
    const steps: string[] = [];
    await expect(runSafeCi({ root, workParent: root, execute: async (step: any) => {
      steps.push(step.name); return step.expectBlocked ? { status: 1, stderr: "blocked external TCP" } : { status: 2 };
    } })).rejects.toThrow("typecheck failed"); expect(steps).toEqual(["network-guard", "typecheck"]);
  });
  it("does not run tests when the network guard self-test does not prove blocking", async () => {
    await expect(runSafeCi({ root, workParent: root, execute: async () => ({ status: 0 }) })).rejects.toThrow("network guard");
  });
  it("rejects mismatched coverage tooling without installing or creating a run directory", async () => {
    await writeFile(join(root, "node_modules/@vitest/coverage-v8/package.json"), '{"version":"other"}');
    const before = await readdir(root); await expect(runSafeCi({ root, workParent: root })).rejects.toThrow("versions must match"); expect(await readdir(root)).toEqual(before);
  });
  it("keeps future workflow runs read-only and makes high dependency advisories blocking", async () => {
    const text = await readFile(".github/workflows/ci.yml", "utf8");
    expect(text).toContain("contents: read"); expect(text).toContain("persist-credentials: false");
    expect(text).toContain("offline-osv-audit.mjs --prepare"); expect(text).toContain("offline-osv-audit.mjs --scan");
    expect(text).not.toContain("npm audit");
    expect(text).not.toMatch(/secrets\.|continue-on-error|deploy|schedule:/);
    for (const name of ["verify", "dependency-audit"]) expect(workflowJob(text, name)).not.toContain("upload-artifact");
    const native = workflowJob(text, "native-task-content");
    expect(native).toContain("github.event_name == 'workflow_dispatch' && inputs.native_task_content");
    const artifacts = native.split("uses: actions/upload-artifact@v4")[1];
    expect(artifacts).toBeDefined();
    for (const path of ["result.json", "*.png", "*.log"]) expect(artifacts).toContain("native-task-content-*/" + path);
    expect(artifacts).not.toMatch(/vault|profile|data\.json|main\.js|secrets/u);
  });
  it("disables implicit dependency inventory audits in every installation step", async () => {
    const text = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const installs = text.split("\n").filter(line => /\bnpm (?:ci|install)\b/.test(line));
    expect(installs.length).toBeGreaterThanOrEqual(3);
    for (const step of installs) {
      expect(step).toContain("--ignore-scripts");
      expect(step).toContain("--no-audit");
    }
    expect(workflowJob(text, "dependency-audit")).not.toMatch(/npm ci|npm audit/);
  });
});

describe("explicit isolated build outputs", () => {
  it("preserves default developer options but supports a fresh production outfile", async () => {
    expect(bundleOptions([])).toMatchObject({ production: false, outfile: "main.js" });
    const file = join(root, "isolated.js"); const options = bundleOptions(["production", "--outfile", file]);
    expect(options).toMatchObject({ production: true, outfile: file, explicitOutput: true }); await assertFreshBundleOutput(options);
    await writeFile(file, "existing candidate"); await expect(assertFreshBundleOutput(options)).rejects.toThrow("already exists"); expect(await readFile(file, "utf8")).toBe("existing candidate");
  });
  it.each([{ args: ["--outfile"] }, { args: ["--unknown"] }, { args: ["--outfile", "--watch"] }])
    ("rejects malformed arguments %j", ({ args }) => { expect(() => bundleOptions(args)).toThrow("Usage"); });
});
