import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error This offline CLI is JavaScript; the product TypeScript project excludes JS.
import { assertPhaseBudget, assertReady, ENDPOINT, LIMITS, makePlan, MODEL, parseResponse, resolveBatch, runNext as runNextWithBudget, sha, validatePlan } from "../scripts/eval/daily-quality-runner.mjs";

const NOW = new Date("2026-09-22T12:00:00+08:00");
const KEY = "sk-" + "SYNTHETIC-OFFLINE-CREDENTIAL-ONLY-123456";
let dir: string;
let tempRoot: string;
let outputDir: string;
const FIRST_BATCH = "daily-quality-20260922-01";
const NEXT_BATCH = "daily-quality-20260922-02";

function phaseAuthorization() {
  return { approved: true, max_cny: 100, authorization_date: "2026-09-22", authorization: "Synthetic offline phase approval only", no_auto_topup: true };
}

function runNext(target: string, key: string, mock: (...args: any[]) => any, now: Date) {
  return runNextWithBudget(target, key, mock, now, outputDir);
}

function preview(ids = ["morning", "evening"]) {
  return {
    synthetic: true, schema_version: 1,
    requests: ids.map(id => {
      const body = {
        model: MODEL, stream: true, thinking: { type: "disabled" }, n: 1, max_tokens: 2000,
        messages: [{ role: "system", content: "Use only the supplied fictional facts." }, { role: "user", content: "Prepare a fictional draft." }],
        tools: [{ type: "function", function: { name: "draft_journal", description: "Prepare a draft", parameters: { type: "object", properties: { text: { type: "string" } } } } }],
      };
      return { id, title: id, user_message: "Synthetic request", provided_facts: ["Fictional facts only"], criteria: ["Do not claim a write"], allowed_tools: ["draft_journal"], request: { body }, body_sha256: sha(JSON.stringify(body)) };
    }),
  };
}

function plan(ids = ["morning", "evening"]) {
  return makePlan(preview(ids), ids);
}

function response() {
  return {
    model: MODEL,
    choices: [{ finish_reason: "stop", message: { content: "Here is a draft based on fictional facts." } }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
}

function authorization(digest: string, calls = 2) {
  return { approved: true, plan_sha256: digest, model: MODEL, max_calls: calls, max_cny: 1, user_confirmation: "Synthetic offline approval fixture only" };
}

async function put(name: string, value: unknown) {
  await writeFile(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function read(name: string) {
  return JSON.parse(await readFile(join(dir, name), "utf8"));
}

async function setup(ids = ["morning", "evening"]) {
  const value = plan(ids);
  await put("evaluation-plan.json", value);
  const digest = sha(await readFile(join(dir, "evaluation-plan.json"), "utf8"));
  await put("authorization.json", authorization(digest, ids.length));
  return { plan: value, digest };
}

function transport(body: unknown = response()) {
  return vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
}

async function reviewLatest(pass = true) {
  const state = await read("live-results.json");
  const latest = state.attempts.at(-1);
  const reviews = [{ id: latest.id, response_sha256: latest.response_sha256, pass, note: "Verified fictional facts and no false write claim." }];
  await put("reviews.json", reviews);
  return reviews;
}

beforeEach(async () => {
  tempRoot = await realpath(await mkdtemp(join(tmpdir(), "lifeops-daily-quality-offline-")));
  outputDir = join(tempRoot, "dist", "daily-quality");
  dir = join(outputDir, FIRST_BATCH);
  await mkdir(dir, { recursive: true });
  await put("phase-budget.json", phaseAuthorization());
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Native network is forbidden in this test"); }));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("daily quality plan boundaries", () => {
  it("prepares a capped synthetic plan without mutating the reviewed fixture", () => {
    const original = preview();
    const snapshot = structuredClone(original);
    const prepared = makePlan(original, ["morning"]);
    expect(prepared.status).toBe("prepared_not_authorized");
    expect(prepared.requests[0].body).toMatchObject({ stream: false, max_tokens: 800 });
    expect(prepared.reserve_cny).toBeLessThanOrEqual(1);
    expect(original).toEqual(snapshot);
    expect(() => validatePlan(prepared)).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[], ["morning", "morning"], ["missing"], Array.from({ length: 9 }, (_, i) => `case-${i}`)].map(ids => ({ ids })))("rejects empty, duplicate, unknown or over-count selections: $ids", ({ ids }) => {
    expect(() => makePlan(preview(), ids)).toThrow();
  });

  it("rejects a changed fixture body and non-synthetic source", () => {
    const changed = preview();
    changed.requests[0].request.body.messages[1].content = "changed after review";
    expect(() => makePlan(changed, ["morning"])).toThrow(/Fixture body changed/);
    expect(() => makePlan({ ...preview(), synthetic: false }, ["morning"])).toThrow();
  });

  it("rejects a request too large for the batch cost ceiling", () => {
    const large = preview(["large"]);
    large.requests[0].request.body.messages[1].content = "x".repeat(160000);
    large.requests[0].body_sha256 = sha(JSON.stringify(large.requests[0].request.body));
    expect(() => makePlan(large, ["large"])).toThrow(/total exceeds/);
  });

  it("rechecks multiple completions at validation, even if reserve fields were recalculated", () => {
    const modified = plan(["morning"]);
    modified.requests[0].body.n = 2;
    // 1 -> 2 has identical serialized byte length: no cost field needs adjustment.
    expect(() => validatePlan(modified)).toThrow();
  });

  it.each(["endpoint", "limits", "price", "reserve", "request-id"])("rejects changed fixed plan field %s", field => {
    const modified = plan();
    if (field === "endpoint") modified.endpoint = "https://invalid.example/api";
    if (field === "limits") modified.limits = { ...LIMITS, calls: 9 };
    if (field === "price") modified.price = { ...modified.price, input: 0 };
    if (field === "reserve") modified.reserve_cny = 0;
    if (field === "request-id") modified.requests[0].id = "../escape";
    expect(() => validatePlan(modified)).toThrow();
  });
});

describe("same-day phase budget and batch isolation", () => {
  it.each(["../daily-quality-20260922-02", "/tmp/daily-quality-20260922-02", "daily-quality-20260922-02/child", "daily-quality-20260922-02\\child", "daily-quality-20260921-02", "daily-quality-20260922-00", "daily-quality-20260922-002", "daily-quality-20260922-10000", "daily-quality-20260922-02 ", "daily-quality-20260922-02\n", ""])("rejects an unsafe or out-of-phase batch name: %j", name => {
    expect(() => resolveBatch(name, outputDir)).toThrow(/Invalid evaluation batch/);
  });

  it("confines accepted batch basenames to the output directory", () => {
    expect(resolveBatch(NEXT_BATCH, outputDir)).toBe(join(outputDir, NEXT_BATCH));
    expect(resolveBatch("daily-quality-20260922-100", outputDir)).toBe(join(outputDir, "daily-quality-20260922-100"));
  });

  it.each(["missing", "not-approved", "larger-ceiling", "missing-ceiling", "date", "confirmation", "auto-topup"])("blocks live requests with %s phase authorization", async kind => {
    await setup();
    const auth: any = phaseAuthorization();
    if (kind === "missing") await rm(join(dir, "phase-budget.json"));
    else {
      if (kind === "not-approved") auth.approved = false;
      if (kind === "larger-ceiling") auth.max_cny = 101;
      if (kind === "missing-ceiling") delete auth.max_cny;
      if (kind === "date") auth.authorization_date = "2026-09-23";
      if (kind === "confirmation") auth.authorization = "  ";
      if (kind === "auto-topup") auth.no_auto_topup = false;
      await put("phase-budget.json", auth);
    }
    const mock = transport();
    await expect(runNext(dir, KEY, mock, NOW)).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
    expect((await readdir(dir)).some(name => name.startsWith("attempt-") || name === "live-results.json")).toBe(false);
  });

  it("counts old stopped batches in full and ignores claimed spending or hand-written reservation totals", async () => {
    const old = await setup();
    await put("live-results.json", { attempts: [{ status: "stopped_unverified" }] });
    await put("phase-budget.json", { ...phaseAuthorization(), charged_usage_estimate_cny: 0, batches: [] });
    dir = join(outputDir, NEXT_BATCH);
    await mkdir(dir);
    const next = await setup(["corrected-memory"]);
    const report = await assertPhaseBudget(dir, outputDir);
    expect(report.batch_count).toBe(2);
    expect(report.total_reserved_cny).toBeCloseTo(old.plan.reserve_cny + next.plan.reserve_cny, 8);
    expect((await runNext(dir, KEY, transport(), NOW)).status).toBe("awaiting_semantic_review");
    expect((await readFile(join(outputDir, FIRST_BATCH, "live-results.json"), "utf8"))).toContain("stopped_unverified");
  });

  it("re-reads phase authorization before every request", async () => {
    await setup();
    const mock = transport();
    await runNext(dir, KEY, mock, NOW);
    await reviewLatest();
    await put("phase-budget.json", { ...phaseAuthorization(), approved: false });
    await expect(runNext(dir, KEY, mock, NOW)).rejects.toThrow(/Phase authorization/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("rejects aggregate reservations over 100 CNY even when every batch is below 1 CNY", async () => {
    await setup();
    const source = preview(["large"]);
    source.requests[0].request.body.messages[1].content = "x".repeat(147000);
    source.requests[0].body_sha256 = sha(JSON.stringify(source.requests[0].request.body));
    const large = makePlan(source, ["large"]);
    expect(large.reserve_cny).toBeLessThanOrEqual(1);
    expect(large.reserve_cny * 101).toBeGreaterThan(100);
    const serialized = JSON.stringify(large);
    for (let index = 1; index <= 101; index++) {
      const target = join(outputDir, `daily-quality-20260922-${String(index).padStart(2, "0")}`);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "evaluation-plan.json"), serialized);
    }
    const mock = transport();
    await expect(runNext(dir, KEY, mock, NOW)).rejects.toThrow(/reservations exceed/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("refuses prior attempt evidence whose reservation has disappeared", async () => {
    await setup();
    const prior = join(outputDir, NEXT_BATCH);
    await mkdir(prior);
    await writeFile(join(prior, "attempt-old.started"), "Synthetic interrupted attempt");
    await expect(assertPhaseBudget(dir, outputDir)).rejects.toThrow(/without a reserved plan/);
  });

  it.each(["batch-directory", "plan-file", "phase-file"])("rejects symbolic links instead of reading outside output: %s", async kind => {
    await setup();
    const external = join(tempRoot, "unrelated");
    await mkdir(external);
    if (kind === "batch-directory") await symlink(external, join(outputDir, NEXT_BATCH));
    else {
      const file = kind === "plan-file" ? "evaluation-plan.json" : "phase-budget.json";
      await copyFile(join(dir, file), join(external, file));
      await rm(join(dir, file));
      await symlink(join(external, file), join(dir, file));
    }
    await expect(assertPhaseBudget(dir, outputDir)).rejects.toThrow(/regular/);
  });

  it("rejects a selected batch outside the fixed output root", async () => {
    await setup();
    const outside = join(tempRoot, NEXT_BATCH);
    await mkdir(outside);
    await expect(assertPhaseBudget(outside, outputDir)).rejects.toThrow(/inside the project output/);
  });

  it.each(["authorization.json", "live-results.json", "reviews.json", "live-results.json.tmp"])("does not follow a linked evidence file during live preflight or persistence: %s", async name => {
    await setup();
    const external = join(tempRoot, "must-not-change.json");
    const sentinel = "SYNTHETIC-PRIVATE-CONTENT";
    await writeFile(external, sentinel);
    await rm(join(dir, name), { force: true });
    await symlink(external, join(dir, name));
    const mock = transport();
    await expect(runNext(dir, KEY, mock, NOW)).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
    expect(await readFile(external, "utf8")).toBe(sentinel);
  });

  it("keeps default and selected-batch check commands offline without phase authorization or credentials", async () => {
    await setup();
    await rm(join(dir, "phase-budget.json"));
    const runner = join(tempRoot, "scripts/eval/daily-quality-runner.mjs");
    await mkdir(dirname(runner), { recursive: true });
    await copyFile(fileURLToPath(new URL("../scripts/eval/daily-quality-runner.mjs", import.meta.url)), runner);
    for (const name of [FIRST_BATCH, NEXT_BATCH]) {
      if (name === NEXT_BATCH) { dir = join(outputDir, name); await mkdir(dir); await setup(["different-payload"]); }
      const child = spawnSync(process.execPath, name === FIRST_BATCH ? [runner] : [runner, "check"], { cwd: tempRoot, env: name === FIRST_BATCH ? {} : { LIFEOPS_EVAL_BATCH: name }, encoding: "utf8", timeout: 10000 });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toMatchObject({ status: "validated_offline", providerCalls: 0, credentialRead: false, cases: name === FIRST_BATCH ? 2 : 1 });
    }
    const child = spawnSync(process.execPath, [runner, "live-session"], { cwd: tempRoot, env: { LIFEOPS_EVAL_BATCH: NEXT_BATCH }, encoding: "utf8", input: "", timeout: 10000 });
    expect(child.status).toBe(1);
    expect(child.stdout).not.toContain("awaiting_ephemeral_credential");
  });
});

describe("authorization, review and spending gates before sending", () => {
  it.each(["missing", "not-approved", "digest", "calls", "cost", "model", "confirmation"])("blocks %s authorization without an attempt marker or request", async kind => {
    await setup();
    const auth = await read("authorization.json");
    if (kind === "missing") await rm(join(dir, "authorization.json"));
    else {
      if (kind === "not-approved") auth.approved = false;
      if (kind === "digest") auth.plan_sha256 = "changed";
      if (kind === "calls") auth.max_calls = 8;
      if (kind === "cost") auth.max_cny = 2;
      if (kind === "model") auth.model = "different-model";
      if (kind === "confirmation") auth.user_confirmation = "  ";
      await put("authorization.json", auth);
    }
    const mock = transport();
    await expect(runNext(dir, KEY, mock, NOW)).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
    expect((await readdir(dir)).some(name => name.startsWith("attempt-") || name === "live-results.json")).toBe(false);
  });

  it("refuses post-authorization plan tampering before the first request", async () => {
    const fixture = await setup();
    fixture.plan.requests[0].title = "changed after approval";
    await put("evaluation-plan.json", fixture.plan);
    const mock = transport();
    await expect(runNext(dir, KEY, mock, NOW)).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
  });

  it.each(["2026-09-21T23:59:59+08:00", "2026-09-24T00:00:00+08:00"])("blocks pricing outside its verified window: %s", async time => {
    await setup();
    const mock = transport();
    await expect(runNext(dir, KEY, mock, new Date(time))).rejects.toThrow(/Refresh pricing/);
    expect(mock).not.toHaveBeenCalled();
  });

  it.each(["missing", "failed", "duplicate", "response-changed", "note-empty"])("requires a unique matching passing review: %s", async kind => {
    await setup();
    const mock = transport();
    expect((await runNext(dir, KEY, mock, NOW)).status).toBe("awaiting_semantic_review");
    if (kind !== "missing") {
      const reviews = await reviewLatest(kind !== "failed");
      if (kind === "duplicate") reviews.push({ ...reviews[0] });
      if (kind === "response-changed") reviews[0].response_sha256 = "changed";
      if (kind === "note-empty") reviews[0].note = "  ";
      await put("reviews.json", reviews);
    }
    await expect(runNext(dir, KEY, mock, NOW)).rejects.toThrow();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).not.toContain("attempt-evening.started");
  });

  it("allows the second reviewed request and refuses a third call beyond authorization", async () => {
    await setup();
    const mock = transport();
    await runNext(dir, KEY, mock, NOW);
    await reviewLatest();
    expect((await runNext(dir, KEY, mock, NOW)).status).toBe("awaiting_semantic_review");
    await expect(runNext(dir, KEY, mock, NOW)).rejects.toThrow(/All approved calls consumed/);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it.each(["response-hash", "cost", "uncertain", "order"])("rejects corrupt persisted attempt evidence: %s", async kind => {
    const fixture = await setup();
    await runNext(dir, KEY, transport(), NOW);
    const reviews = await reviewLatest();
    const state = await read("live-results.json");
    if (kind === "response-hash") state.attempts[0].result.content = "changed";
    if (kind === "cost") {
      state.attempts[0].result.cost_cny_uncached = 0;
      state.attempts[0].response_sha256 = sha(JSON.stringify(state.attempts[0].result));
      reviews[0].response_sha256 = state.attempts[0].response_sha256;
    }
    if (kind === "uncertain") state.attempts[0].status = "started";
    if (kind === "order") state.attempts[0].id = "evening";
    expect(() => assertReady(fixture.plan, fixture.digest, state, reviews, authorization(fixture.digest), NOW)).toThrow();
  });
});

describe("single-attempt transport and credential boundaries", () => {
  it("allows only one concurrent caller through the permanent exclusive marker", async () => {
    await setup();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const mock = vi.fn(async () => { entered(); await waiting; return new Response(JSON.stringify(response())); });
    const first = runNext(dir, KEY, mock, NOW);
    await started;
    // Simulate a stale/missing results snapshot; the independent exclusive marker still wins.
    await rm(join(dir, "live-results.json"));
    await expect(runNext(dir, KEY, mock, NOW)).rejects.toMatchObject({ code: "EEXIST" });
    release();
    expect((await first).status).toBe("awaiting_semantic_review");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).toContain("attempt-morning.started");
  });

  it.each(["http", "truncated", "missing-usage", "malformed-json", "over-size", "timeout", "network"])("records %s as uncertain and never retries", async kind => {
    await setup();
    const mock = vi.fn(async () => {
      if (kind === "http") return new Response(KEY, { status: 429 });
      if (kind === "malformed-json") return new Response(`not json ${KEY}`);
      if (kind === "over-size") return new Response("x".repeat(LIMITS.responseBytes + 1));
      if (kind === "timeout") throw new DOMException(`Timeout ${KEY}`, "TimeoutError");
      if (kind === "network") throw new Error(`Network error ${KEY}`);
      const value: any = response();
      if (kind === "truncated") value.choices[0].finish_reason = "length";
      if (kind === "missing-usage") delete value.usage;
      return new Response(JSON.stringify(value));
    });
    const result = await runNext(dir, KEY, mock, NOW);
    expect(result.status).toBe("stopped_unverified");
    expect(result.failure_class).toBe(kind === "timeout" ? "timeout" : "request_or_response_rejected");
    expect(await readFile(join(dir, "live-results.json"), "utf8")).not.toContain(KEY);
    await expect(runNext(dir, KEY, mock, NOW)).rejects.toThrow(/Uncertain attempt/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("records selected tools without invoking them or making a follow-up request", async () => {
    await setup();
    const value = { ...response(), choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ type: "function", function: { name: "draft_journal", arguments: JSON.stringify({ text: "Synthetic unsaved draft", path: join(dir, "must-not-be-written.md") }) } }] } }] };
    const mock = transport(value);
    const result = await runNext(dir, KEY, mock, NOW);
    expect(result.attempt.result.tool_calls).toEqual([{ name: "draft_journal", arguments: { text: "Synthetic unsaved draft", path: join(dir, "must-not-be-written.md") } }]);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]?.[0]).toBe(ENDPOINT);
    expect(await readdir(dir)).not.toContain("must-not-be-written.md");
  });

  it("redacts credential echoes in reply content, nested arguments and argument keys", async () => {
    await setup();
    const value = { ...response(), choices: [{ finish_reason: "tool_calls", message: { content: `echo ${KEY}`, tool_calls: [{ type: "function", function: { name: "draft_journal", arguments: JSON.stringify({ text: KEY, nested: { [KEY]: KEY } }) } }] } }] };
    const result = await runNext(dir, KEY, transport(value), NOW);
    expect(result.status).toBe("awaiting_semantic_review");
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(await readFile(join(dir, "live-results.json"), "utf8")).not.toContain(KEY);
    expect(result.attempt.result.content).toContain("[REDACTED]");
  });

  it("never persists a credential echoed as a tool name", async () => {
    await setup();
    const value = { ...response(), choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ type: "function", function: { name: `draft_${KEY}`, arguments: "{}" } }] } }] };
    const result = await runNext(dir, KEY, transport(value), NOW);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(await readFile(join(dir, "live-results.json"), "utf8")).not.toContain(KEY);
  });

  it.each(["usage-over-reserve", "usage-fraction", "wrong-model", "multiple-choices", "bad-tool-json"])("rejects unverifiable provider responses: %s", kind => {
    const value: any = response();
    const request = plan().requests[0];
    if (kind === "usage-over-reserve") value.usage.prompt_tokens = request.input_token_reserve + 1;
    if (kind === "usage-fraction") value.usage.completion_tokens = 1.2;
    if (kind === "wrong-model") value.model = "different-model";
    if (kind === "multiple-choices") value.choices.push({ ...value.choices[0] });
    if (kind === "bad-tool-json") value.choices[0].message.tool_calls = [{ type: "function", function: { name: "draft_journal", arguments: "[]" } }];
    expect(() => parseResponse(value, request, KEY)).toThrow();
  });
});
