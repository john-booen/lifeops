import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSafeCi } from "./verify-ci-local.mjs";
import { exportCiEvidence } from "./ci-evidence.mjs";
import { assert } from "./verify-plugin-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function snapshot() {
  const git = args => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  assert(git(["status", "--porcelain", "--untracked-files=normal"]) === "", "Hosted source must be clean");
  return git(["rev-parse", "HEAD"]);
}

// Intended only for the hosted synthetic source job; ordinary local checks keep their existing CLI.
assert(process.argv.length === 4 && process.argv[2] === "--output", "Usage: verify-source-ci.mjs --output NEW_EVIDENCE_DIR");
const source = snapshot();
assert(process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_SHA === source, "Evidence export requires the exact hosted source checkout");
const github = { repository: process.env.GITHUB_REPOSITORY, workflow: "ci.yml", runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) };
const result = await runSafeCi({ root });
assert(snapshot() === source, "Source changed during full CI");
const evidence = await exportCiEvidence({ root, result, source, output: process.argv[3], github });
console.log(JSON.stringify(result, null, 2));
console.log(JSON.stringify(evidence, null, 2));
