import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { readFile } from "node:fs/promises";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { LifeOpsAi } from "../src/ai";
import { setProviderEgressSink } from "../src/privacy";
import { ProviderTransportError, runProviderRequest } from "../src/providerRun";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));
const request = requestUrl as unknown as ReturnType<typeof vi.fn>;
function settings() {
  const value = structuredClone(DEFAULT_SETTINGS);
  value.privacy = { excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
  Object.assign(value.ai, { provider: "kimi", endpoint: "https://synthetic.invalid/primary?secret=hidden", model: "primary-model", apiKey: "synthetic-secret", dataDisclosureAccepted: true,
    fallbackProvider: "deepseek", fallbackEndpoint: "https://synthetic.invalid/fallback", fallbackModel: "fallback-model", fallbackApiKey: "synthetic-secret" });
  return value;
}
function response(status = 200, model = "reported-model") {
  return { status, text: "synthetic-secret private body", headers: {}, arrayBuffer: new ArrayBuffer(0), json: status === 200
    ? { model, choices: [{ message: { content: "合成回复。" } }] }
    : { error: { message: "synthetic-secret private body" } } };
}
beforeEach(() => { request.mockReset(); });
afterEach(() => { setProviderEgressSink(null); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("known credential audit redaction", () => {
  it.each(["throw", "register"])("protects returned metadata when the late second context read changes (%s)", async change => {
    const key = "synthetic-later-context", target = { provider: "synthetic", model: "configured-model" }, observed: any[] = [];
    let reads = 0;
    const execute = vi.fn(async () => ({ value: "合成结果", reportedModel: `reported-${key}` }));
    const result = await runProviderRequest(target, [{ ...target, transport: "fetch", execute }], { additionalSensitiveValues: () => {
      if (++reads === 1) return []; if (change === "throw") throw Error("late private context failure"); return [key];
    }, onProviderRun: run => { observed.push(run); } });
    expect(result.value).toBe("合成结果"); expect(execute).toHaveBeenCalledOnce(); expect(observed).toHaveLength(1); expect(result.providerRun).toEqual(observed[0]);
    expect(result.providerRun).toMatchObject({ status: "success", actualModel: "unknown", fallbackUsed: false });
    expect(JSON.stringify({ result, observed })).not.toContain(key);
  });
  it.each(["failure", "malformed"])("isolates a %s private credential context from the actual operation", async kind => {
    const hidden = "synthetic-context-token", target = { provider: "synthetic", model: `model-${hidden}` }, observed: any[] = [];
    const execute = vi.fn(async () => { if (kind === "failure") throw new ProviderTransportError("configuration", `configuration-${hidden}`); return { value: "合成结果", reportedModel: `reported-${hidden}` }; });
    const result = await runProviderRequest(target, [{ ...target, transport: "fetch", execute }], { additionalSensitiveValues: () => { if (kind === "failure") throw Error("private diagnostic failure"); return null as any; }, onProviderRun: run => { observed.push(run); } }).catch(error => error);
    expect(execute).toHaveBeenCalledOnce(); expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ requestedProvider: "unknown", requestedModel: "unknown", status: kind === "failure" ? "failed" : "success", fallbackUsed: false, attempts: [{ provider: "unknown", model: "unknown" }] });
    if (kind === "failure") expect(result).toMatchObject({ code: "configuration" }); else expect(result.value).toBe("合成结果");
    expect(JSON.stringify({ result, observed })).not.toMatch(/synthetic-context-token|private diagnostic failure/);
  });
  it.each(["primary", "fallback", "stream"])("protects %s configured identities while preserving the actual request", async kind => {
    const s = settings(), key = "synthetic-primary-token", fallbackKey = "synthetic-fallback-token";
    Object.assign(s.ai, { apiKey: key, model: `model-${key}`, fallbackApiKey: fallbackKey, fallbackModel: `model-${fallbackKey}` });
    const egress: any[] = [], runs: any[] = [], audits: any[] = [];
    setProviderEgressSink(record => { egress.push(record); });
    const reply = { status: 200, text: "", json: { choices: [{ finish_reason: "stop", message: { content: "合成回复。" } }] } };
    if (kind === "fallback") request.mockResolvedValueOnce(response(401));
    request.mockResolvedValueOnce(reply);
    const fetch = vi.fn().mockResolvedValue(new Response('data: {"choices":[{"index":0,"delta":{"content":"合成回复。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    vi.stubGlobal("fetch", fetch);
    const options = { onProviderRun: (run: any) => { runs.push(run); }, onRequestAudit: (audit: any) => { audits.push(audit); } };
    const ai = new LifeOpsAi(s), result = kind === "stream" ? await ai.agentReplyStream("合成上下文", "合成消息", [], vi.fn(), "text", options) : await ai.agentReply("合成上下文", "合成消息", [], "text", options);
    const attempts = kind === "stream" ? fetch.mock.calls.map(call => ({ body: call[1].body, headers: call[1].headers })) : request.mock.calls.map(call => call[0]);
    expect(attempts.map(call => JSON.parse(call.body).model)).toEqual(kind === "fallback" ? [s.ai.model, s.ai.fallbackModel] : [s.ai.model]);
    expect(attempts.map(call => call.headers.Authorization)).toEqual(kind === "fallback" ? [`Bearer ${key}`, `Bearer ${fallbackKey}`] : [`Bearer ${key}`]);
    expect(result.content).toBe("合成回复。"); expect(result.providerRun).toMatchObject({ requestedModel: "unknown", actualModel: "unknown", modelIdentitySource: "configured", status: "success", fallbackUsed: kind === "fallback" });
    expect(result.providerRun!.attempts.every(attempt => attempt.model === "unknown")).toBe(true);
    expect(runs).toEqual([result.providerRun]); expect(egress).toHaveLength(attempts.length); expect(audits).toHaveLength(attempts.length);
    expect(JSON.stringify({ runs, egress, audits, result })).not.toMatch(/synthetic-primary-token|synthetic-fallback-token/);
  });
  it("protects unavailable identities from other configured credentials and isolates the observer", async () => {
    const s = settings(); s.gateway.sharedSecret = "synthetic-gateway-token"; s.ai.model = `model-${s.gateway.sharedSecret}`; s.ai.dataDisclosureAccepted = false;
    const received: any[] = [];
    const result = await new LifeOpsAi(s).agentReply("合成", "合成", [], "text", { onProviderRun: run => { received.push(structuredClone(run)); run.status = "success"; run.requestedModel = "observer-edited"; } });
    expect(result.providerRun).toMatchObject({ requestedModel: "unknown", status: "unavailable", attempts: [] });
    expect(JSON.stringify(received)).not.toContain(s.gateway.sharedSecret); expect(request).not.toHaveBeenCalled();
  });
  it("protects zero-attempt cancellation identities", async () => {
    const s = settings(); s.ai.model = `model-${s.ai.apiKey}`; const abort = new AbortController(); abort.abort(); const runs: any[] = [];
    const error = await new LifeOpsAi(s).agentReply("合成", "合成", [], "text", { signal: abort.signal, onProviderRun: run => { runs.push(run); } }).catch(error => error);
    expect(error).toMatchObject({ name: "AbortError" }); expect(runs[0]).toMatchObject({ requestedModel: "unknown", status: "cancelled", attempts: [] });
    expect(JSON.stringify({ error, runs })).not.toContain(s.ai.apiKey); expect(request).not.toHaveBeenCalled();
  });
  it.each(["request_url", "stream"])("protects %s reported identities containing another known credential", async transport => {
    const s = settings(); s.gateway.sharedSecret = "synthetic-other-token";
    request.mockResolvedValue(response(200, `reported-${s.gateway.sharedSecret}`));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('data: '+JSON.stringify({ model: `reported-${s.gateway.sharedSecret}`, choices: [{ index: 0, delta: { content: "合成回复。" }, finish_reason: "stop" }] })+'\n\ndata: [DONE]\n\n')));
    const ai = new LifeOpsAi(s), result = transport === "stream" ? await ai.agentReplyStream("合成", "合成", [], vi.fn()) : await ai.agentReply("合成", "合成");
    expect(result.providerRun).toMatchObject({ actualModel: "primary-model", modelIdentitySource: "configured", status: "success" });
    expect(JSON.stringify(result)).not.toContain(s.gateway.sharedSecret);
  });
  it("protects incomplete response identities without retrying the terminal answer", async () => {
    const s = settings(); s.gateway.sharedSecret = "synthetic-other-token";
    request.mockResolvedValue({ status: 200, text: "", json: { model: `reported-${s.gateway.sharedSecret}`, choices: [{ finish_reason: "length", message: { content: "未完成的合成回复" } }] } });
    const error = await new LifeOpsAi(s).agentReply("合成", "合成").catch(error => error);
    expect(error).toMatchObject({ code: "response_incomplete", providerRun: { actualModel: "primary-model", modelIdentitySource: "configured", status: "failed", attempts: [{ incompleteReason: "length" }] } });
    expect(JSON.stringify(error)).not.toContain(s.gateway.sharedSecret); expect(request).toHaveBeenCalledOnce();
  });
  it("retains the initial credential snapshot through a late adapter result", async () => {
    const key = "synthetic-snapshot-token", credentials = [key], runs: any[] = [];
    let release!: (value: { reportedModel: string; value: string }) => void;
    const adapter = new Promise<{ reportedModel: string; value: string }>(resolve => { release = resolve; });
    const target = { provider: "synthetic", model: `model-${key}` };
    const result = runProviderRequest(target, [{ ...target, transport: "fetch", execute: () => adapter }], { sensitiveValues: credentials, onProviderRun: run => { runs.push(run); } });
    credentials.length = 0; release({ reportedModel: `reported-${key}`, value: "合成结果" });
    const completed = await result;
    expect(completed.value).toBe("合成结果"); expect(completed.providerRun).toMatchObject({ requestedModel: "unknown", actualModel: "unknown", modelIdentitySource: "configured" });
    expect(JSON.stringify({ completed, runs })).not.toContain(key);
  });
});

describe("provider result contract on synthetic transports", () => {
  it("records the requested target, successful fallback and failure category without payloads", async () => {
    request.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response());
    const runs: any[] = [];
    const result = await new LifeOpsAi(settings()).agentReply("private context", "合成输入", [], "text", { onProviderRun: run => runs.push(run) });
    expect(result.providerRun).toMatchObject({ requestedProvider: "kimi", requestedModel: "primary-model", actualProvider: "deepseek", actualModel: "reported-model", modelIdentitySource: "response", status: "success", fallbackUsed: true,
      attempts: [{ provider: "kimi", errorCode: "auth" }, { provider: "deepseek", status: "success" }] });
    expect(runs).toEqual([result.providerRun]);
    expect(JSON.stringify(runs)).not.toMatch(/synthetic-secret|private|https|secret=/);
  });

  it("does not launch non-streaming transport for an already cancelled turn", async () => {
    request.mockResolvedValue(response());
    const controller = new AbortController(); controller.abort();
    const runs: any[] = [];
    await expect(new LifeOpsAi(settings()).agentReply("ctx", "input", [], "text", { signal: controller.signal, onProviderRun: run => runs.push(run) })).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
    expect(runs[0]).toMatchObject({ status: "cancelled", attempts: [] });
  });

  it("stops awaiting a cancelled non-streaming turn and never starts its fallback", async () => {
    let launched!: () => void;
    const started = new Promise<void>(resolve => { launched = resolve; });
    request.mockImplementation(() => { launched(); return new Promise(() => {}); });
    const controller = new AbortController();
    const runs: any[] = [];
    const pending = new LifeOpsAi(settings()).agentReply("ctx", "input", [], "text", { signal: controller.signal, onProviderRun: run => runs.push(run) });
    await started; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(runs[0]).toMatchObject({ status: "cancelled", attempts: [{ errorCode: "cancelled" }] });
  });

  it("records rate limits and the complete failed-stream to non-streaming chain", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("private body", { status: 429 })).mockResolvedValueOnce(new Response("private body", { status: 401 })));
    request.mockResolvedValue(response());
    const result = await new LifeOpsAi(settings()).agentReplyStream("ctx", "input", [], vi.fn());
    expect(result.providerRun).toMatchObject({ status: "success", actualProvider: "kimi", fallbackUsed: true, attempts: [
      { provider: "kimi", transport: "stream", errorCode: "rate_limit", httpStatus: 429 },
      { provider: "deepseek", transport: "stream", errorCode: "auth", httpStatus: 401 },
      { provider: "kimi", transport: "request_url", status: "success" }
    ] });
  });

  it("records a timeout and fallback when non-streaming transport never settles", async () => {
    vi.useFakeTimers();
    request.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(response());
    const pending = new LifeOpsAi(settings()).agentReply("ctx", "input");
    await vi.advanceTimersByTimeAsync(30_001);
    const result = await pending;
    expect(result.providerRun).toMatchObject({ actualProvider: "deepseek", fallbackUsed: true, attempts: [{ errorCode: "timeout" }, { status: "success" }] });
  });

  it("records streamed response model identity and a configured identity when absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`data: ${JSON.stringify({ model: "stream-reported-model", choices: [{ delta: { content: "合成回复" } }] })}\n\ndata: [DONE]\n\n`)));
    const ai = new LifeOpsAi(settings());
    expect((await ai.agentReplyStream("ctx", "input", [], vi.fn())).providerRun).toMatchObject({ actualModel: "stream-reported-model", modelIdentitySource: "response" });
    request.mockResolvedValue(response(200, "https://invalid.example/?secret=private"));
    expect((await ai.agentReply("ctx", "input")).providerRun).toMatchObject({ actualModel: "primary-model", modelIdentitySource: "configured" });
  });

  it("keeps traces local when two calls overlap on the same AI instance", async () => {
    let rejectFirst!: (error: Error) => void;
    request.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; })).mockResolvedValueOnce(response(200, "second-model")).mockResolvedValueOnce(response(200, "first-fallback-model"));
    const ai = new LifeOpsAi(settings());
    const firstRuns: any[] = [], secondRuns: any[] = [];
    const first = ai.agentReply("ctx", "first", [], "text", { onProviderRun: run => firstRuns.push(run) });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const second = await ai.agentReply("ctx", "second", [], "text", { onProviderRun: run => secondRuns.push(run) });
    rejectFirst(new Error("private network payload"));
    const firstResult = await first;
    expect(firstResult.providerRun).toMatchObject({ actualProvider: "deepseek", actualModel: "first-fallback-model" });
    expect(second.providerRun).toMatchObject({ actualProvider: "kimi", actualModel: "second-model", fallbackUsed: false });
    expect(firstRuns).toEqual([firstResult.providerRun]); expect(secondRuns).toEqual([second.providerRun]);
  });
});

describe("incomplete text responses terminate without another paid transport", () => {
  const call = { id: "synthetic-complete-tool", type: "function", function: { name: "create_task", arguments: '{"title":"虚构半截任务"}' } };
  function plain(reason: unknown, tools = false) {
    return { ...response(), json: { model: "reported-model", choices: [{ index: 0, finish_reason: reason, message: { content: "合法正文也可能尚未完成。", ...(tools ? { tool_calls: [call] } : {}) } }] } };
  }
  function sse(reason: unknown, tools = false, tail = "\n\ndata: [DONE]\n\n") {
    return `data: ${JSON.stringify({ model: "reported-model", choices: [{ index: 0, delta: tools ? { tool_calls: [call] } : { content: "尚未完成的合成正文。" }, finish_reason: null }] })}\n\n  data: ${JSON.stringify({ model: "reported-model", choices: [{ index: 0, delta: {}, finish_reason: reason }] })}${tail}`;
  }
  it.each(["length", "content_filter", "private payload synthetic-secret"])("rejects ordinary %s before returning text or a complete tool", async reason => {
    request.mockResolvedValue(plain(reason, true)); const runs: any[] = [];
    await expect(new LifeOpsAi(settings()).agentReply("ctx", "input", [], "text", { onProviderRun: run => runs.push(run) })).rejects.toMatchObject({ code: "response_incomplete" });
    expect(request).toHaveBeenCalledOnce();
    expect(runs).toMatchObject([{ actualProvider: "kimi", actualModel: "reported-model", status: "failed", fallbackUsed: false,
      attempts: [{ errorCode: "response_incomplete", httpStatus: 200, incompleteReason: reason === "length" || reason === "content_filter" ? reason : "unknown" }] }]);
    expect(JSON.stringify(runs)).not.toMatch(/private payload|synthetic-secret|尚未完成/);
  });
  it("checks every choice consumed by tool parsing", async () => {
    const result = plain("stop"); result.json.choices.push({ index: 1, finish_reason: "length", message: { content: "", tool_calls: [call] } } as any);
    request.mockResolvedValue(result); await expect(new LifeOpsAi(settings()).agentReply("ctx", "input")).rejects.toMatchObject({ code: "response_incomplete" });
    expect(request).toHaveBeenCalledOnce();
  });
  it.each(["stop", "tool_calls", "function_call"])("preserves a completed %s tool turn", async reason => {
    request.mockResolvedValue(plain(reason, true));
    expect((await new LifeOpsAi(settings()).agentReply("ctx", "input")).toolCalls).toMatchObject([{ name: "create_task", arguments: { title: "虚构半截任务" } }]);
  });
  it.each(["structured", "content"])("rejects a normally stopped %s undo with incomplete parameters", async kind => {
    const broken = { ...call, function: { name: "undo_latest_operation", arguments: '{"x":' } }, result = plain("stop");
    result.json.choices[0].message = kind === "content" ? { content: JSON.stringify({ tool_calls: [broken] }) } : { content: "", tool_calls: [broken] } as any;
    request.mockResolvedValue(result); await expect(new LifeOpsAi(settings()).agentReply("ctx", "input")).rejects.toMatchObject({ code: "response_incomplete" }); expect(request).toHaveBeenCalledOnce();
  });
  it.each(["top-level", "second-choice"])("validates the %s content actually used by ordinary tool parsing", async kind => {
    const content = JSON.stringify({ tool_calls: [{ ...call, function: { name: "undo_latest_operation", arguments: '{"x":' } }] }), result = plain("stop");
    result.json.choices[0].message.content = "";
    if (kind === "top-level") (result.json as any).content = content;
    else result.json.choices.push({ index: 1, finish_reason: "stop", message: { content } });
    request.mockResolvedValue(result); await expect(new LifeOpsAi(settings()).agentReply("ctx", "input")).rejects.toMatchObject({ code: "response_incomplete" }); expect(request).toHaveBeenCalledOnce();
  });
  it.each(["\n\ndata: [DONE]\n\n", ""])("rejects a length tail with or without a final newline: %j", async tail => {
    const fetch = vi.fn().mockResolvedValue(new Response(sse("length", true, tail))); vi.stubGlobal("fetch", fetch);
    const runs: any[] = [], delivered = vi.fn();
    await expect(new LifeOpsAi(settings()).agentReplyStream("ctx", "input", [], delivered, "text", { onProviderRun: run => runs.push(run) })).rejects.toMatchObject({ code: "response_incomplete" });
    expect(fetch).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled(); expect(delivered).not.toHaveBeenCalled();
    expect(runs[0]).toMatchObject({ status: "failed", actualModel: "reported-model", attempts: [{ incompleteReason: "length" }] });
  });
  it.each(["stop", "tool_calls"])("accepts a complete %s tail without newline or DONE", async reason => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sse(reason, true, ""))));
    expect((await new LifeOpsAi(settings()).agentReplyStream("ctx", "input", [], vi.fn())).toolCalls).toHaveLength(1);
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["\n\ndata: [DONE]\n\n", ""])("rejects complete tools appended after the choice already stopped: %j", async tail => {
    const raw = sse("stop", false, "") + `\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [call] } }] })}${tail}`;
    const fetch = vi.fn().mockResolvedValue(new Response(raw)); vi.stubGlobal("fetch", fetch);
    await expect(new LifeOpsAi(settings()).agentReplyStream("ctx", "input", [], vi.fn())).rejects.toMatchObject({ code: "response_incomplete" });
    expect(fetch).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
  });
  it.each(["stop", null])("rejects incomplete undo arguments even when a stream ends with %j and DONE", async finish => {
    const broken = { ...call, function: { name: "undo_latest_operation", arguments: '{"x":' } };
    const raw = `data: ${JSON.stringify({ model: "reported-model", choices: [{ index: 0, delta: { tool_calls: [broken] }, finish_reason: finish }] })}\n\ndata: [DONE]`;
    const fetch = vi.fn().mockResolvedValue(new Response(raw)); vi.stubGlobal("fetch", fetch);
    await expect(new LifeOpsAi(settings()).agentReplyStream("ctx", "input", [], vi.fn())).rejects.toMatchObject({ code: "response_incomplete" }); expect(fetch).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
  });
  it("retains an intentional empty-parameter complete tool", async () => {
    const result = plain("tool_calls", true); (result.json.choices[0].message as any).tool_calls[0] = { ...call, function: { name: "undo_latest_operation", arguments: "{}" } };
    request.mockResolvedValue(result); expect((await new LifeOpsAi(settings()).agentReply("ctx", "input")).toolCalls).toMatchObject([{ name: "undo_latest_operation", arguments: {} }]);
  });
  it.each(["missing", "invalid", "mixed", "error"])("rejects an incomplete %s stream without executing accumulated tools", async kind => {
    let raw = sse(null, true, "");
    if (kind === "invalid") raw += '\n\ndata: {"broken":';
    if (kind === "mixed") raw = sse("stop", true, "") + '\n\ndata: {"choices":[{"index":1,"delta":{"content":"截断旁支"}}]}';
    if (kind === "error") raw += '\n\ndata: {"error":{"message":"private payload synthetic-secret"}}';
    const fetch = vi.fn().mockResolvedValue(new Response(raw)); vi.stubGlobal("fetch", fetch);
    await expect(new LifeOpsAi(settings()).agentReplyStream("ctx", "input", [], vi.fn())).rejects.toMatchObject({ code: "response_incomplete" });
    expect(fetch).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
  });
  it("replays a fictional length-limited R01 response through both production adapters", async () => {
    const json = JSON.parse(await readFile(new URL("./fixtures/provider-r01-length.json", import.meta.url), "utf8"));
    request.mockResolvedValue({ ...response(), json });
    const plainRuns: any[] = [];
    await expect(new LifeOpsAi(settings()).agentReply("ctx", "合成复盘", [], "text", { onProviderRun: run => plainRuns.push(run) })).rejects.toMatchObject({ code: "response_incomplete" });
    expect(plainRuns[0]).toMatchObject({ actualModel: "kimi-k2.6", attempts: [{ incompleteReason: "length" }] });
    const fetch = vi.fn().mockResolvedValue(new Response(await readFile(new URL("./fixtures/provider-r01-length.sse", import.meta.url), "utf8"))); vi.stubGlobal("fetch", fetch);
    await expect(new LifeOpsAi(settings()).agentReplyStream("ctx", "合成复盘", [], vi.fn())).rejects.toMatchObject({ code: "response_incomplete" });
    expect(fetch).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce();
  });
});
