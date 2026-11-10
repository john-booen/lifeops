import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { LifeOpsAi } from "../src/ai";
import { classifyByRules } from "../src/classifier";
import { normalizeQualityLogEntry } from "../src/qualityLog";
import { runProviderRequest } from "../src/providerRun";
import { setProviderEgressSink } from "../src/privacy";
import type { ProviderRequestOptions, ProviderRunResult } from "../src/types";
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));
const request = requestUrl as unknown as ReturnType<typeof vi.fn>;
const secret = "synthetic-secret";
function configured() {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.privacy = { ...s.privacy, plaintextCredentialStorageAccepted: true, excludedVaultPrefixes: [] };
  Object.assign(s.ai, { provider: "kimi", endpoint: "https://synthetic.invalid/?private=query", apiKey: secret, model: "configured-text", dataDisclosureAccepted: true, fallbackProvider: "off" });
  Object.assign(s.voice, { provider: "openai-compatible", endpoint: "https://synthetic.invalid/?private=query", apiKey: secret, model: "configured-asr", dataDisclosureAccepted: true });
  Object.assign(s.vision, { provider: "openai-compatible", endpoint: "https://synthetic.invalid/?private=query", apiKey: secret, model: "configured-vision", cameraEnabled: true, cameraMode: "snapshot", privacyNoticeAccepted: true, remoteDataDisclosureAccepted: true });
  Object.assign(s.embedding, { provider: "openai-compatible", endpoint: "https://synthetic.invalid/?private=query", apiKey: secret, model: "configured-embedding", dataDisclosureAccepted: true });
  return s;
}
function response(status = 200, model: unknown = "reported-model") {
  return { status, text: `private body ${secret}`, json: { model, choices: [{ message: { content: "纯虚构回复" } }], data: [{ embedding: [1, 2] }] } };
}
const methods = ["transcription", "embedding"] as const;
function invoke(kind: typeof methods[number], ai: LifeOpsAi, options: ProviderRequestOptions) {
  return kind === "transcription" ? ai.transcribeAudio(new Blob(["private audio"]), undefined, options.signal, options)

    : ai.getEmbedding("private body", options);
}
let runs: ProviderRunResult[];
const options = (): ProviderRequestOptions => ({ onProviderRun: run => runs.push(run) });
beforeEach(() => {
  runs = []; request.mockReset(); request.mockResolvedValue(response());
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: "合成转写", model: "reported-model" }) }));
});
afterEach(() => { setProviderEgressSink(null); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("finite capability provider contracts", () => {
  describe("actual finite transport target", () => {
    describe("transport target observer", () => {
      it("metadata failure records unknown without failing or retrying the business request", async () => {
        const business = vi.fn(async () => ({ value: "合成正常结果", reportedModel: undefined }));
        const badTarget = { provider: "prepared", get model(): string { throw new Error("synthetic metadata failure"); } };
        const result = await runProviderRequest({ provider: "requested", model: "requested-model" }, [{ provider: "prepared", model: "prepared-model", transport: "request_url", execute: async (_signal, observe) => { observe?.(badTarget); return business(); } }], options());
        expect(result.value).toBe("合成正常结果"); expect(business).toHaveBeenCalledOnce(); expect(runs).toHaveLength(1);
        expect(result.providerRun).toMatchObject({ requestedProvider: "requested", requestedModel: "requested-model", actualProvider: "unknown", actualModel: "unknown", status: "success", attempts: [{ provider: "unknown", model: "unknown" }] });
      });
      it("a late observer cannot mutate the cancelled attempt or its returned failure", async () => {
        let observe!: (target: { provider: string; model: string }) => void, enter!: () => void, release!: (value: any) => void;
        const entered = new Promise<void>(resolve => { enter = resolve; }), delayed = new Promise<any>(resolve => { release = resolve; }), abort = new AbortController();
        const business = vi.fn((_signal?: AbortSignal, recorder?: typeof observe) => { observe = recorder!; observe({ provider: "started", model: "started-model" }); enter(); return delayed; });
        const pending = runProviderRequest({ provider: "requested", model: "requested-model" }, [{ provider: "prepared", model: "prepared-model", transport: "request_url", execute: business }], { ...options(), signal: abort.signal }).catch(error => error);
        await entered; abort.abort(); const error = await pending, before = JSON.stringify({ error, runs });
        expect(error).toMatchObject({ code: "cancelled" }); expect(runs[0]).toMatchObject({ status: "cancelled", attempts: [{ provider: "started", model: "started-model" }] });
        observe({ provider: "late", model: "late-model" }); release({ value: "late", reportedModel: "late-model" }); await Promise.resolve(); await Promise.resolve();
        expect(JSON.stringify({ error, runs })).toBe(before); expect(runs).toHaveLength(1); expect(business).toHaveBeenCalledOnce();
      });
    });
    it.each(methods.flatMap(kind => (["success", "rate_limit", "cancelled"] as const).map(outcome => [kind, outcome] as const)))("%s records the started target after preparation (%s)", async (kind, outcome) => {
      const s = configured(), config = kind === "transcription" ? s.voice : kind === "embedding" ? s.embedding : s.vision;
      const requestedModel = config.model, startedModel = `started-${kind}`;
      let enter!: () => void, release!: (response: any) => void;
      const entered = new Promise<void>(resolve => { enter = resolve; }), delayed = new Promise<any>(resolve => { release = resolve; });
      request.mockImplementation(() => { enter(); return delayed; });
      const fetchMock = vi.fn((..._args: any[]) => { enter(); return delayed; }); vi.stubGlobal("fetch", fetchMock);
      const abort = new AbortController(), pending = invoke(kind, new LifeOpsAi(s), { ...options(), signal: abort.signal }).catch(error => error);
      config.model = startedModel; await entered;
      const sent: any = kind === "transcription" ? fetchMock.mock.calls[0][1] : request.mock.calls[0][0];
      expect(kind === "transcription" ? sent.body.get("model") : JSON.parse(sent.body).model).toBe(startedModel);
      config.model = requestedModel;
      const status = outcome === "rate_limit" ? 429 : 200;
      const finalResponse = kind === "transcription" ? { status, ok: status === 200, json: async () => ({ text: "合成转写", model: null }) } : response(status, null);
      if (outcome === "cancelled") abort.abort(); else release(finalResponse);
      const result = await pending;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ requestedModel, status: outcome === "rate_limit" ? "failed" : outcome, attempts: [{ model: startedModel }] });
      if (outcome === "success") expect(runs[0]).toMatchObject({ actualModel: startedModel, modelIdentitySource: "configured" });
      else { expect(result).toMatchObject({ code: outcome }); expect(runs[0].actualModel).toBeUndefined(); }
      if (outcome === "cancelled") release(finalResponse);
      expect(kind === "transcription" ? fetchMock : request).toHaveBeenCalledOnce();
    });
    it("transcription keeps one prepared endpoint/model snapshot through egress waiting", async () => {
      const s = configured(), endpoint = s.voice.endpoint, model = s.voice.model, records: any[] = [];
      setProviderEgressSink(record => { records.push(record); s.voice.endpoint = "https://changed.synthetic.invalid/transcribe"; s.voice.model = "changed-during-egress"; });
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: "合成转写" }) }); vi.stubGlobal("fetch", fetchMock);
      expect(await invoke("transcription", new LifeOpsAi(s), options())).toBe("合成转写");
      expect(fetchMock).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[0][0]).toBe(endpoint);
      expect(fetchMock.mock.calls[0][1].body.get("model")).toBe(model); expect(records[0].model).toBe(model);
      expect(runs[0]).toMatchObject({ requestedModel: model, actualModel: model, attempts: [{ model }] });
    });
  });
  describe("known credential audit redaction", () => {
    it("protects newly known credentials when cancellation arrives before adapter entry", async () => {
      const s = configured(), key = "synthetic-before-adapter-token"; s.embedding.model = `model-${key}`;
      const abort = new AbortController(), pending = new LifeOpsAi(s).getEmbedding("合成输入", { ...options(), signal: abort.signal }).catch(error => error);
      s.embedding.apiKey = key; abort.abort(); const error = await pending;
      expect(error).toMatchObject({ name: "AbortError" }); expect(runs[0]).toMatchObject({ requestedModel: "unknown", status: "cancelled", attempts: [] });
      expect(JSON.stringify({ error, runs })).not.toContain(key); expect(request).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    });
    it.each(methods)("%s registers a late inherited key before credential storage rejection", async kind => {
      const s = configured(), key = "synthetic-denied-later-token";
      Object.assign(s.voice, { apiKey: "", model: `model-${key}` }); Object.assign(s.vision, { apiKey: "", model: `model-${key}` }); Object.assign(s.embedding, { apiKey: "", model: `model-${key}` });
      const pending = invoke(kind, new LifeOpsAi(s), options()).catch(error => error);
      s.ai.apiKey = key; s.privacy!.plaintextCredentialStorageAccepted = false;
      const error = await pending;
      expect(error).toMatchObject({ code: "configuration" }); expect(runs[0]).toMatchObject({ requestedModel: "unknown", status: "failed", attempts: [{ model: "unknown", errorCode: "configuration" }] });
      expect(JSON.stringify({ error, runs })).not.toContain(key); expect(request).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    });
    it.each(["success", "cancelled"])("protects a late actual credential after settings restore (%s)", async outcome => {
      const s = configured(), laterKey = "synthetic-later-token", originalKey = s.embedding.apiKey;
      s.embedding.model = `model-${laterKey}`;
      let entered!: () => void, release!: (value: ReturnType<typeof response>) => void;
      const started = new Promise<void>(resolve => { entered = resolve; }), delayed = new Promise<ReturnType<typeof response>>(resolve => { release = resolve; });
      request.mockImplementation(() => { entered(); return delayed; });
      const abort = new AbortController(), pending = new LifeOpsAi(s).getEmbedding("纯虚构配置变化", { ...options(), signal: abort.signal }).catch(error => error);
      s.embedding.apiKey = laterKey; await started;
      expect(request.mock.calls[0][0].headers.Authorization).toBe(`Bearer ${laterKey}`); expect(JSON.parse(request.mock.calls[0][0].body).model).toBe(s.embedding.model);
      s.embedding.apiKey = originalKey;
      if (outcome === "cancelled") abort.abort(); else release(response(200, null));
      const result = await pending;
      expect(runs[0]).toMatchObject({ requestedModel: "unknown", status: outcome, attempts: [{ model: "unknown" }] });
      if (outcome === "success") { expect(result).toEqual([1, 2]); expect(runs[0].actualModel).toBe("unknown"); }
      else { expect(result).toMatchObject({ name: "AbortError" }); release(response(200, null)); }
      expect(JSON.stringify({ result, runs })).not.toContain(laterKey); expect(request).toHaveBeenCalledOnce();
    });
    it.each(methods)("%s protects inherited credential metadata while retaining its exact request", async kind => {
      const s = configured(), model = `model-${secret}`, records: any[] = [];
      Object.assign(s.voice, { apiKey: "", model }); Object.assign(s.vision, { apiKey: "", model }); Object.assign(s.embedding, { apiKey: "", model });
      request.mockResolvedValue(response(200, null));
      const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: "合成转写", model: null }) }); vi.stubGlobal("fetch", fetch);
      setProviderEgressSink(record => { records.push(record); });
      const value = await invoke(kind, new LifeOpsAi(s), options());
      const sent = kind === "transcription" ? fetch.mock.calls[0][1] : request.mock.calls[0][0];
      expect(kind === "transcription" ? sent.body.get("model") : JSON.parse(sent.body).model).toBe(model); expect(sent.headers.Authorization).toBe(`Bearer ${secret}`);
      expect(runs[0]).toMatchObject({ requestedModel: "unknown", actualModel: "unknown", modelIdentitySource: "configured", status: "success", attempts: [{ model: "unknown" }] });
      expect(records).toHaveLength(1); expect(records[0].model).toBe("unknown"); expect(JSON.stringify({ runs, records, value })).not.toContain(secret);
    });
    it.each(methods)("%s protects failed configuration before any transport", async kind => {
      const s = configured(), model = `model-${secret}`;
      Object.assign(s.voice, { provider: "off", model }); Object.assign(s.vision, { provider: "off", model }); Object.assign(s.embedding, { provider: "off", model });
      const error = await invoke(kind, new LifeOpsAi(s), options()).catch(error => error);
      expect(error).toMatchObject({ code: "configuration" }); expect(runs[0]).toMatchObject({ requestedModel: "unknown", status: "failed", attempts: [] });
      expect(JSON.stringify({ error, runs })).not.toContain(secret); expect(request).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    });
  });
  it.each(methods)("%s reports response identity with no payload", async kind => {
    await invoke(kind, new LifeOpsAi(configured()), options());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "success", actualModel: "reported-model", modelIdentitySource: "response", fallbackUsed: false,
      attempts: [{ transport: kind === "transcription" ? "fetch" : "request_url", status: "success" }] });
    expect(JSON.stringify(runs)).not.toMatch(/private|synthetic-secret|https/);
  });
  it.each(methods)("%s records configured identity when model is missing or unsafe", async kind => {
    request.mockResolvedValue(response(200, secret));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: "合成", model: "https://private.invalid" }) }));
    await invoke(kind, new LifeOpsAi(configured()), options());
    expect(runs[0].modelIdentitySource).toBe("configured");
    expect(runs[0].actualModel).toMatch(/^configured-/);
  });
  it.each(methods)("%s classifies HTTP 429 and retains no response error", async kind => {
    request.mockResolvedValue(response(429));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: { message: `private ${secret}` } }) }));
    await expect(invoke(kind, new LifeOpsAi(configured()), options())).rejects.toMatchObject({ code: "rate_limit" });
    expect(runs[0]).toMatchObject({ status: "failed", attempts: [{ errorCode: "rate_limit", httpStatus: 429 }] });
    expect(runs[0].actualProvider).toBeUndefined();
  });
  it.each(methods)("%s times out even if the adapter ignores the abort signal", async kind => {
    vi.useFakeTimers(); request.mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const outcome = invoke(kind, new LifeOpsAi(configured()), options()).catch(error => error);
    await vi.advanceTimersByTimeAsync(45_001);
    expect(await outcome).toMatchObject({ code: "timeout" });
    expect(runs).toHaveLength(1); expect(runs[0]).toMatchObject({ status: "failed", attempts: [{ errorCode: "timeout" }] });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(methods)("%s cancels while egress is blocked and never starts transport", async kind => {
    let release!: () => void, started!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    setProviderEgressSink(async () => { started(); await wait; });
    const abort = new AbortController();
    const outcome = invoke(kind, new LifeOpsAi(configured()), { ...options(), signal: abort.signal }).catch(error => error);
    await entered; abort.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    release(); await Promise.resolve(); await Promise.resolve();
    expect(request).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(runs).toHaveLength(1); expect(runs[0].status).toBe("cancelled");
  });
  it.each(methods)("%s unavailable/off sends no request and has no actual identity", async kind => {
    const s = configured(); s.voice.provider = "off"; s.vision.provider = "off"; s.embedding.provider = "off";
    await expect(invoke(kind, new LifeOpsAi(s), options())).rejects.toMatchObject({ code: "configuration" });
    expect(runs[0].actualModel).toBeUndefined(); expect(runs[0].attempts).toEqual([]);
    expect(request).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("distinguishes successful transport with invalid classification from rules-only unavailable", async () => {
    const fallback = classifyByRules("合成备注", "synthetic"); const local = vi.fn();
    request.mockResolvedValue({ ...response(), json: { choices: [{ message: { content: "这不是分类 JSON" } }] } });
    expect(await new LifeOpsAi(configured()).classify("合成备注", fallback, { ...options(), onLocalFallback: local })).toBe(fallback);
    expect(local).toHaveBeenLastCalledWith("invalid_response"); expect(runs[0].status).toBe("success");
    const s = configured(); s.ai.provider = "off";
    await new LifeOpsAi(s).classify("合成备注", fallback, { ...options(), onLocalFallback: local });
    expect(local).toHaveBeenLastCalledWith("unavailable"); expect(runs[1]).toMatchObject({ status: "unavailable", attempts: [] });
  });
  it("cancelled preflight publishes one zero-attempt result", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(runProviderRequest({ provider: "synthetic", model: "test" }, [], { ...options(), signal: abort.signal, timeoutMs: 10 })).rejects.toMatchObject({ name: "AbortError" });
    expect(runs).toEqual([expect.objectContaining({ status: "cancelled", attempts: [] })]);
  });
  it("filters trace/stage/transport rather than treating unknown transport as request_url", () => {
    const row = normalizeQualityLogEntry({ providerTraceId: "https://private.invalid", providerStage: "private body" as any,
      providerRuns: [{ requestedProvider: "test", requestedModel: "test", status: "failed", fallbackUsed: false,
        attempts: [{ provider: "test", model: "test", status: "failed", transport: "custom" as any }] }] });
    expect(row.providerTraceId).toBeUndefined(); expect(row.providerStage).toBeUndefined();
    expect(row.providerRuns![0].attempts[0].transport).toBe("unknown");
    expect(normalizeQualityLogEntry({ providerTraceId: "local-001", providerStage: "embedding" })).toMatchObject({ providerTraceId: "local-001", providerStage: "embedding" });
  });
});

describe("finite response validation", () => {
  it.each([401, 403, 429, 500])("HTTP %s is classified even when response JSON is malformed", async status => {
    request.mockResolvedValue({ status, get json() { throw new Error("private JSON body"); } });
    await expect(new LifeOpsAi(configured()).getEmbedding("合成内容", options())).rejects.toMatchObject({ code: status === 429 ? "rate_limit" : status < 500 ? "auth" : "http" });
  });
  it.each([null, "not JSON", {}])("invalid embedding response fails without actual identity", async payload => {
    request.mockResolvedValue({ status: 200, json: payload });
    await expect(new LifeOpsAi(configured()).getEmbedding("合成内容", options())).rejects.toMatchObject({ code: "invalid_response" });
    expect(runs[0].actualModel).toBeUndefined();
  });
  it("rejects a partially invalid vector instead of silently dropping its elements", async () => {
    request.mockResolvedValue({ status: 200, json: { data: [{ embedding: [1, "private", 2] }] } });
    await expect(new LifeOpsAi(configured()).getEmbedding("合成内容", options())).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("times out during transcription JSON parsing too", async () => {
    vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) }));
    const result = new LifeOpsAi(configured()).transcribeAudio(new Blob(["合成音频"]), undefined, undefined, options()).catch(error => error);
    await vi.advanceTimersByTimeAsync(45_001);
    expect(await result).toMatchObject({ code: "timeout" }); expect(runs).toHaveLength(1);
  });
});

it.each([false, true])("preserves a valid classification JSON through the text adapter (fenced=%s)", async fenced => {
  const fallback = classifyByRules("合成随手描述", "synthetic");
  const content = JSON.stringify({ kind: "todo", confidence: 0.99, title: "合成任务", content: "合成任务", reason: "明确请求" });
  request.mockResolvedValue({ ...response(), json: { choices: [{ message: { content: fenced ? `\`\`\`json\n${content}\n\`\`\`` : content } }] } });
  const local = vi.fn();
  const result = await new LifeOpsAi(configured()).classify("合成随手描述", fallback, { ...options(), onLocalFallback: local });
  expect(result).toMatchObject({ kind: "todo", content: "合成任务", confidence: 0.99 });
  expect(local).not.toHaveBeenCalled();
});

// Append inside tests/providerFiniteContract.test.ts after the current batch closes.
// Reuses that file's configured(), options(), runs, secret, vi and LifeOpsAi.
// Draft only: root does not edit or run shared tests.
const rejectedTranscriptionStatuses = [401, 403, 429, 500] as const;
it.each(rejectedTranscriptionStatuses.flatMap(status =>
  (["hang", "reject", "sync-throw"] as const).map(parse => [status, parse] as const)
))("transcription preserves HTTP %s without reading a %s error body", async (status, parse) => {
  vi.useFakeTimers();
  let late!: (value: unknown) => void;
  const body = new Promise<unknown>(resolve => { late = resolve; });
  const json = vi.fn(() => {
    if (parse === "hang") return body;
    if (parse === "sync-throw") throw Error(`synthetic private body ${secret}`);
    return Promise.reject(Error(`synthetic private body ${secret}`));
  });
  const fetch = vi.fn().mockResolvedValue({ ok: false, status, json });
  vi.stubGlobal("fetch", fetch);
  let settled = false;
  const pending = new LifeOpsAi(configured()).transcribeAudio(new Blob(["合成音频"]), undefined, undefined, options())
    .then(value => { settled = true; return value; }, error => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(0);
  const settledBeforeDeadline = settled;
  await vi.advanceTimersByTimeAsync(45_001); // Cleanly settles the old defective path too.
  const result = await pending;
  const code = status === 429 ? "rate_limit" : status === 500 ? "http" : "auth";
  expect(result).toMatchObject({ code });
  expect(settledBeforeDeadline).toBe(true);
  expect(json).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
  expect(runs).toEqual([expect.objectContaining({ status: "failed", attempts: [expect.objectContaining({ errorCode: code, httpStatus: status })] })]);
  const terminal = JSON.stringify(runs);
  expect(terminal).not.toContain(secret); expect(terminal).not.toContain("synthetic private body");
  late({ text: "合成迟到内容", model: "late-model" }); await vi.advanceTimersByTimeAsync(0);
  expect(JSON.stringify(runs)).toBe(terminal);
});

it.each(rejectedTranscriptionStatuses)("transcription cancellation before HTTP %s remains cancellation", async status => {
  let entered!: () => void, release!: (value: unknown) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const json = vi.fn(async () => ({ error: { message: `synthetic private body ${secret}` } }));
  const fetch = vi.fn(() => { entered(); return response; }); vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const pending = new LifeOpsAi(configured()).transcribeAudio(new Blob(["合成音频"]), undefined, controller.signal, options()).catch(error => error);
  await started; controller.abort(); release({ ok: false, status, json });
  expect(await pending).toMatchObject({ code: "cancelled", name: "AbortError" });
  expect(json).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
  expect(runs).toEqual([expect.objectContaining({ status: "cancelled", attempts: [expect.objectContaining({ errorCode: "cancelled" })] })]);
});
// Keep existing 200-body timeout, successful transcription and active cancellation tests.
