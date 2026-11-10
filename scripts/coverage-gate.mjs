import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COVERAGE_TARGETS = {
  "src/agentRuntime.ts": "Runtime", "src/toolRegistry.ts": "Runtime",
  "src/privacy.ts": "privacy", "src/dataFoundation/factOperation.ts": "undo",
  "src/dataFoundation/operationLedger.ts": "undo"
};
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const keys = value => Object.keys(value).sort();
const sameTargets = value => JSON.stringify(keys(value)) === JSON.stringify(keys(COVERAGE_TARGETS));

export async function coverageSourceHashes(root) {
  return Object.fromEntries(await Promise.all(keys(COVERAGE_TARGETS).map(async path => [path, hash(await readFile(join(root, path)))])));
}

export async function coveragePolicyHash(root) {
  const directives = {};
  for (const name of keys(COVERAGE_TARGETS)) {
    const lines = (await readFile(join(root, name), "utf8")).split(/\r?\n/);
    directives[name] = lines.flatMap((line, index) => /(?:v8|istanbul|c8)\s+ignore/.test(line)
      ? [`${line.trim()}\n${(lines[index + 1] ?? "").trim()}`] : []);
  }
  return hash(JSON.stringify({ config: await readFile(join(root, "vitest.coverage.config.mts"), "utf8"), directives }));
}

export async function writeCoverageProvenance({ root, report, before }) {
  const after = await coverageSourceHashes(root);
  ensure(JSON.stringify(after) === JSON.stringify(before), "Coverage sources changed during the run; rerun the fixed candidate");
  const bytes = await readFile(report);
  const metadata = { schemaVersion: 1, status: "coverage_completed", reportSha256: hash(bytes), sources: after, policySha256: await coveragePolicyHash(root), node: process.version };
  await writeFile(join(dirname(report), "coverage-provenance.json"), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
  return metadata;
}

export async function readCoverageMetrics({ root, report }) {
  const bytes = await readFile(report);
  const provenance = JSON.parse(await readFile(join(dirname(report), "coverage-provenance.json"), "utf8"));
  ensure(provenance.schemaVersion === 1 && provenance.status === "coverage_completed" && provenance.reportSha256 === hash(bytes), "Missing or mismatched coverage provenance");
  const current = await coverageSourceHashes(root);
  ensure(sameTargets(provenance.sources) && JSON.stringify(current) === JSON.stringify(provenance.sources), "Coverage report does not describe the current source candidate");
  ensure(provenance.policySha256 === await coveragePolicyHash(root), "Coverage policy changed after this report");
  const summary = JSON.parse(bytes.toString("utf8")); const files = {};
  for (const [absolutePath, metrics] of Object.entries(summary)) {
    if (absolutePath === "total") continue;
    const name = relative(root, absolutePath).split("\\").join("/");
    ensure(Object.hasOwn(COVERAGE_TARGETS, name) && !files[name], "Coverage scope changed or contains an unexpected file");
    files[name] = { group: COVERAGE_TARGETS[name] };
    for (const metric of ["lines", "branches"]) {
      const { total, covered, skipped = 0 } = metrics[metric] ?? {};
      ensure(Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger(covered) && covered >= 0 && covered <= total && skipped === 0,
        `Invalid or empty ${metric} coverage for ${name}`);
      files[name][metric] = { total, covered };
    }
  }
  ensure(sameTargets(files), "Coverage report is missing a required file");
  return { files, provenance };
}

export async function recordCoverageBaseline({ root = rootDir, report, baseline = join(root, "scripts/coverage-baseline.json") }) {
  const measured = await readCoverageMetrics({ root, report });
  const baselineData = { schemaVersion: 1, targets: COVERAGE_TARGETS, files: measured.files, provenance: measured.provenance };
  // Initial registration never overwrites an approved baseline.
  await writeFile(baseline, `${JSON.stringify(baselineData, null, 2)}\n`, { flag: "wx" });
  return baselineData;
}

export async function verifyCoverageBaseline({ root = rootDir, report, baseline = join(root, "scripts/coverage-baseline.json") }) {
  const measured = await readCoverageMetrics({ root, report });
  let saved;
  try { saved = JSON.parse(await readFile(baseline, "utf8")); }
  catch (error) { if (error.code === "ENOENT") throw new Error("Coverage baseline is not registered; collect a real report and explicitly record it first"); throw error; }
  ensure(saved.schemaVersion === 1 && sameTargets(saved.files) && JSON.stringify(saved.targets) === JSON.stringify(COVERAGE_TARGETS), "Coverage baseline scope changed; separate review required");
  ensure(saved.provenance?.policySha256 === measured.provenance.policySha256, "Coverage config or ignore directives changed; separate review required");
  for (const name of keys(COVERAGE_TARGETS)) {
    ensure(saved.files[name].group === COVERAGE_TARGETS[name], "Coverage group changed; separate review required");
    for (const metric of ["lines", "branches"]) {
      const old = saved.files[name][metric]; const next = measured.files[name][metric];
      ensure(Number.isSafeInteger(old?.total) && old.total > 0 && Number.isSafeInteger(old.covered) && old.covered >= 0 && old.covered <= old.total, "Invalid coverage baseline metric");
      ensure(BigInt(next.covered) * BigInt(old.total) >= BigInt(old.covered) * BigInt(next.total),
        `Coverage regression: ${name} ${metric} ${(old.covered / old.total * 100).toFixed(2)}% -> ${(next.covered / next.total * 100).toFixed(2)}%`);
    }
  }
  return measured.files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2); const options = {};
  ensure(mode === "check" || mode === "record", "Usage: coverage-gate.mjs check|record --report SUMMARY_JSON [--baseline BASELINE_JSON]");
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index] === "--report" ? "report" : args[index] === "--baseline" ? "baseline" : "";
    ensure(key && !options[key] && args[index + 1], "Invalid coverage command arguments"); options[key] = resolve(args[index + 1]);
  }
  ensure(options.report, "A real coverage report is required");
  if (mode === "record") { await recordCoverageBaseline(options); console.log("Recorded initial measured coverage baseline; review before committing"); }
  else { await verifyCoverageBaseline(options); console.log("Per-file line and branch coverage did not regress across all required files"); }
}
