import { describe, expect, it } from "vitest";
// @ts-expect-error Operator source-run lookup uses fake read-only responses.
import { findSourceCi } from "../scripts/source-ci-reuse.mjs";

const source = "a".repeat(40), repository = "fictional/lifeops";
function fixture() {
  return {
    run: { id: 17, run_attempt: 1, updated_at: new Date().toISOString(), head_sha: source, status: "completed", conclusion: "success", event: "workflow_dispatch", repository: { full_name: repository }, path: ".github/workflows/ci.yml" },
    jobs: { total_count: 5, jobs: [{ name: "source-plan", status: "completed", conclusion: "success" }, { name: "verify", status: "completed", conclusion: "success" }, { name: "dependency-audit", status: "completed", conclusion: "success" }, { name: "reuse-evidence", status: "completed", conclusion: "skipped" }, { name: "native-task-content (1.5.8)", status: "completed", conclusion: "skipped" }] },
    artifacts: { total_count: 1, artifacts: [{ id: 23, name: `source-ci-evidence-${source}`, expired: false, size_in_bytes: 100, digest: `sha256:${"b".repeat(64)}`, workflow_run: { id: 17, head_sha: source } }] }
  };
}
async function find(data: ReturnType<typeof fixture>, requests: string[] = []) {
  return findSourceCi({ source, repository, currentRun: 18, request: async (path: string) => { requests.push(path); return path.includes("/jobs?") ? data.jobs : path.includes("/artifacts?") ? data.artifacts : { workflow_runs: [data.run] }; } });
}
describe("same-source CI reuse planning", () => {
  it("reuses full source and audit success by exact SHA without depending on branch labels", async () => {
    const data = fixture(), requests: string[] = []; (data.run as any).head_branch = "dev";
    expect(await find(data, requests)).toMatchObject({ reuse: true, source, runId: 17, runAttempt: 1, artifactId: 23 });
    expect(requests).toHaveLength(3); expect(requests[0]).toContain(`head_sha=${source}`); expect(requests[1]).toContain("attempts/1/jobs");
  });
  it.each([
    { id: 18 }, { head_sha: "b".repeat(40) }, { status: "in_progress" }, { conclusion: "failure" }, { event: "pull_request" }, { repository: { full_name: "other/repo" } }, { path: ".github/workflows/other.yml" }
  ])("rejects an unrelated or incomplete run %j", async change => { const data = fixture(); Object.assign(data.run, change); expect(await find(data)).toMatchObject({ reuse: false }); });
  it.each(["verify", "dependency-audit"])("requires actual %s success, not a reuse-only/native-only success", async name => {
    const data = fixture(); data.jobs.jobs.find(job => job.name === name)!.conclusion = "skipped"; expect(await find(data)).toMatchObject({ reuse: false });
  });
  it("rejects duplicate or paginated job sets and an unrelated skipped job", async () => {
    const data = fixture(); data.jobs.jobs.push(data.jobs.jobs[1]); data.jobs.total_count++; expect(await find(data)).toMatchObject({ reuse: false });
    data.jobs.jobs.pop(); expect(await find(data)).toMatchObject({ reuse: false });
    data.jobs.total_count--; data.jobs.jobs[3].name = "unexpected"; expect(await find(data)).toMatchObject({ reuse: false });
  });
  it.each([{ expired: true }, { digest: "" }, { id: 0 }, { name: "old-evidence" }, { workflow_run: { id: 16, head_sha: source } }, { workflow_run: { id: 17, head_sha: "b".repeat(40) } }])("rejects missing immutable artifact identity %j", async change => {
    const data = fixture(); Object.assign(data.artifacts.artifacts[0], change); expect(await find(data)).toMatchObject({ reuse: false });
  });
  it("rejects ambiguous artifacts", async () => { const data = fixture(); data.artifacts.artifacts.push({ ...data.artifacts.artifacts[0], id: 24 }); data.artifacts.total_count++; expect(await find(data)).toMatchObject({ reuse: false }); });
  it("accepts GitHub's unexpanded skipped native matrix job", async () => { const data = fixture(); data.jobs.jobs[4].name = "native-task-content"; expect(await find(data)).toMatchObject({ reuse: true }); });
  it.each(["invalid", new Date(Date.now() - 25 * 60 * 60_000).toISOString(), new Date(Date.now() + 60_000).toISOString()])("does not reuse an out-of-batch or invalid audit time: %s", async updated_at => { const data = fixture(); data.run.updated_at = updated_at; expect(await find(data)).toMatchObject({ reuse: false }); });
  it("does not turn lookup failures into another full suite", async () => {
    await expect(findSourceCi({ source, repository, currentRun: 18, request: async () => { throw Error("offline"); } })).rejects.toThrow("offline");
  });
});
