import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coverageSourceHashes, writeCoverageProvenance } from "./coverage-gate.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function ciPlan({ root = sourceRoot, workDir = "<new system temporary directory>", collectCoverage = false } = {}) {
  const node = process.execPath; const report = join(workDir, "coverage", "coverage-summary.json");
  const steps = [
    { name: "network-guard", command: node, args: ["-e", "require('node:net').connect(443, 'example.com')"], expectBlocked: true },
    { name: "typecheck", command: node, args: [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--skipLibCheck"] },
    { name: "coverage", command: node, args: [join(root, "node_modules/vitest/vitest.mjs"), "run", "--dir", "tests", "--config", join(root, "vitest.coverage.config.mts"), "--maxWorkers=2", "--testTimeout=30000", "--reporter=dot", "--reporter=json", `--outputFile.json=${join(workDir, "test-results.json")}`] }
  ];
  if (!collectCoverage) steps.push(
    { name: "coverage-gate", command: node, args: [join(root, "scripts/coverage-gate.mjs"), "check", "--report", report] },
    { name: "gateway-syntax", command: node, args: ["--check", join(root, "gateway/server.mjs")] },
    { name: "production-bundle", command: node, args: [join(root, "esbuild.config.mjs"), "production", "--outfile", join(workDir, "main.js")] },
    { name: "package-prepare", command: node, args: [join(root, "scripts/prepare-plugin-package.mjs"), "--bundle", join(workDir, "main.js"), "--output", join(workDir, "package")] },
    { name: "package-verify", command: node, args: [join(root, "scripts/verify-plugin-package.mjs"), "--package", join(workDir, "package")] }
  );
  return { mode: collectCoverage ? "collect-coverage" : "verify", root, workDir, report, steps };
}

export function ciEnvironment(root, workDir, inherited = process.env) {
  const guard = join(root, "scripts/offline-network-guard.cjs");
  return {
    ...inherited, LIFEOPS_OFFLINE_VERIFY: "1", LIFEOPS_COVERAGE_DIRECTORY: join(workDir, "coverage"),
    NODE_OPTIONS: [inherited.NODE_OPTIONS, `--require=${JSON.stringify(guard)}`].filter(Boolean).join(" ")
  };
}

export async function runSafeCi({ root = sourceRoot, collectCoverage = false, execute, workParent = tmpdir() } = {}) {
  const vitest = JSON.parse(await readFile(join(root, "node_modules/vitest/package.json"), "utf8"));
  const coverage = JSON.parse(await readFile(join(root, "node_modules/@vitest/coverage-v8/package.json"), "utf8"));
  if (vitest.version !== coverage.version) throw new Error("Vitest and coverage-v8 versions must match the locked installation");
  const workDir = await mkdtemp(join(workParent, "lifeops-ci-"));
  const plan = ciPlan({ root, workDir, collectCoverage }); const env = ciEnvironment(root, workDir);
  const before = await coverageSourceHashes(root); const completed = [];
  const run = execute ?? (step => spawnSync(step.command, step.args, {
    cwd: root, env, encoding: "utf8", stdio: step.expectBlocked ? "pipe" : "inherit",
    // Hosted Intel coverage exceeded the former 20-minute process limit.
    timeout: (step.name === "coverage" ? 45 : 20) * 60_000
  }));
  try {
    for (const step of plan.steps) {
      console.log(`[safe-ci] ${step.name}`);
      const result = await run({ ...step, cwd: root, env });
      if (step.expectBlocked) {
        if (result.status === 0 || !`${result.stderr ?? ""}${result.stdout ?? ""}`.includes("blocked external TCP")) throw new Error("Node network guard self-test failed");
      } else if (result.status !== 0) throw new Error(`${step.name} failed with exit code ${result.status ?? "unknown"}`);
      if (step.name === "coverage") await writeCoverageProvenance({ root, report: plan.report, before });
      completed.push(step.name);
    }
    const result = { schemaVersion: 1, status: collectCoverage ? "coverage_collected_baseline_pending" : "verified", workDir, report: plan.report, completed };
    await writeFile(join(workDir, "ci-result.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    return result;
  } catch (error) {
    await writeFile(join(workDir, "ci-result.json"), `${JSON.stringify({ schemaVersion: 1, status: "failed", workDir, completed, error: error.message }, null, 2)}\n`, { flag: "wx" });
    throw new Error(`${error.message}; preserved diagnostics: ${workDir}`, { cause: error });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === "--plan")) console.log(JSON.stringify(ciPlan(), null, 2));
  else if (args.length === 1 && ["--run", "--collect-coverage"].includes(args[0])) {
    console.log(JSON.stringify(await runSafeCi({ collectCoverage: args[0] === "--collect-coverage" }), null, 2));
  } else throw new Error("Usage: verify-ci-local.mjs [--plan|--run|--collect-coverage]");
}
