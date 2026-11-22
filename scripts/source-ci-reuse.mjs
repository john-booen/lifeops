import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./verify-plugin-package.mjs";

/** Read only. Reuse only a completed full source run, never a native-only or reuse-only run. */
export async function findSourceCi({ repository, source, currentRun, request, now = Date.now() }) {
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository) && /^[a-f0-9]{40}$/.test(source) && Number.isSafeInteger(currentRun) && currentRun > 0, "Invalid source CI lookup identity");
  const prefix = `/repos/${repository}/actions`;
  const list = await request(`${prefix}/workflows/ci.yml/runs?head_sha=${source}&status=success&per_page=100`);
  assert(Array.isArray(list.workflow_runs), "Invalid workflow list");
  for (const run of list.workflow_runs) {
    if (run.id === currentRun || run.head_sha !== source || run.status !== "completed" || run.conclusion !== "success" || run.event === "pull_request" || run.repository?.full_name !== repository || !/^\.github\/workflows\/ci\.yml(?:@.*)?$/.test(run.path ?? "")) continue;
    assert(Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, "Invalid prior run identity");
    const age = now - Date.parse(run.updated_at); if (!Number.isFinite(age) || age < 0 || age > 24 * 60 * 60_000) continue;
    const jobs = await request(`${prefix}/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length) continue;
    const complete = name => jobs.jobs.filter(job => job.name === name && job.status === "completed" && job.conclusion === "success").length === 1;
    if (!complete("verify") || !complete("dependency-audit") || !jobs.jobs.every(job => job.status === "completed" && (job.conclusion === "success" || ["reuse-evidence", "native-task-content", "native-task-content (1.5.8)", "native-task-content (1.12.7)"].includes(job.name) && job.conclusion === "skipped"))) continue;
    const artifacts = await request(`${prefix}/runs/${run.id}/artifacts?per_page=100`);
    if (!Array.isArray(artifacts.artifacts) || artifacts.total_count !== artifacts.artifacts.length) continue;
    const matches = artifacts.artifacts.filter(artifact => artifact.name === `source-ci-evidence-${source}` && artifact.expired === false && artifact.workflow_run?.id === run.id && artifact.workflow_run?.head_sha === source && Number.isSafeInteger(artifact.id) && artifact.id > 0 && Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? ""));
    if (matches.length !== 1) continue;
    return { reuse: true, source, repository, runId: run.id, runAttempt: run.run_attempt, artifactId: matches[0].id, artifactDigest: matches[0].digest, priorFullAndAuditSucceeded: true };
  }
  return { reuse: false, source, repository, reason: "No complete full source run with a live immutable evidence artifact" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv.length === 2 && process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_OUTPUT, "Run source CI planning only in GitHub Actions");
  const token = process.env.GITHUB_TOKEN; assert(token, "Read-only Actions token is required");
  const plan = await findSourceCi({ repository: process.env.GITHUB_REPOSITORY, source: process.env.GITHUB_SHA, currentRun: Number(process.env.GITHUB_RUN_ID), request: async path => {
    const response = await fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, signal: AbortSignal.timeout(30_000) });
    assert(response.ok, `Source CI lookup failed: HTTP ${response.status}`); return response.json();
  } });
  await appendFile(process.env.GITHUB_OUTPUT, `reuse=${plan.reuse}\nrun_id=${plan.runId ?? ""}\nrun_attempt=${plan.runAttempt ?? ""}\nartifact_id=${plan.artifactId ?? ""}\n`);
  console.log(JSON.stringify(plan, null, 2));
}
