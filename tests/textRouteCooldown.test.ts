import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { LifeOpsAi } from "../src/ai";
import { DEFAULT_SETTINGS } from "../src/defaults";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));
const request = requestUrl as unknown as ReturnType<typeof vi.fn>;
function settings() {
  const value = structuredClone(DEFAULT_SETTINGS);
  value.privacy = { excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
  Object.assign(value.ai, { provider: "kimi", endpoint: "https://synthetic.invalid/primary", model: "primary-model", apiKey: "synthetic-primary-key", dataDisclosureAccepted: true,
    fallbackProvider: "deepseek", fallbackEndpoint: "https://synthetic.invalid/fallback", fallbackModel: "fallback-model", fallbackApiKey: "synthetic-fallback-key" });
  return value;
}
function response(status = 200) {
  return { status, text: "", headers: {}, arrayBuffer: new ArrayBuffer(0), json: status === 200
    ? { choices: [{ finish_reason: "stop", message: { content: "合成完整回复。" } }] }
    : { error: { message: "synthetic-private-payload" } } };
}
beforeEach(() => { request.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const models = () => request.mock.calls.map(([input]) => JSON.parse(input.body as string).model);
const reply = (ai: LifeOpsAi) => ai.agentReply("虚构上下文", "合成提问");
function streamResponse(status = 200) {
  return new Response(status === 200 ? 'data: {"choices":[{"index":0,"delta":{"content":"合成完整回复。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' : "synthetic-private-payload", { status });
}

describe("text route cooldown on the actual AI entry point", () => {
  it("starts the next turn on the already configured fallback after a primary rate limit", async () => {
    request.mockImplementation(async (input: { url: string }) => response(input.url.includes("/primary") ? 429 : 200));
    const ai = new LifeOpsAi(settings());
    const first = await ai.agentReply("虚构上下文", "第一段合成提问");
    const second = await ai.agentReply("虚构上下文", "接着核对合成资料");
    expect(first.content).toBe("合成完整回复。"); expect(second.content).toBe(first.content);
    const models = request.mock.calls.map(([input]) => typeof input === "object" ? JSON.parse(input.body as string).model : "unexpected");
    expect(models).toEqual(["primary-model", "fallback-model", "fallback-model"]);
    expect(second.providerRun).toMatchObject({ requestedProvider: "kimi", requestedModel: "primary-model", actualProvider: "deepseek", fallbackUsed: true,
      attempts: [{ provider: "deepseek", status: "success" }] });
    expect(second.providerRun?.attempts).toHaveLength(1);
    expect(JSON.stringify(second.providerRun)).not.toMatch(/synthetic-primary-key|synthetic-fallback-key|synthetic-private-payload|https/);
  });

  it("tries the primary again after one minute and keeps it after recovery", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-02-04T08:00:00Z"));
    request.mockResolvedValueOnce(response(429)).mockResolvedValue(response());
    const ai = new LifeOpsAi(settings()); await reply(ai); await reply(ai);
    await vi.advanceTimersByTimeAsync(60_001);
    const recovered = await reply(ai); await reply(ai);
    expect(models()).toEqual(["primary-model", "fallback-model", "fallback-model", "primary-model", "primary-model"]);
    expect(recovered.providerRun).toMatchObject({ actualProvider: "kimi", fallbackUsed: false });
  });

  it.each(["endpoint", "model", "apiKey", "provider"] as const)("discards a hint after the primary %s changes", async field => {
    const config = settings(), ai = new LifeOpsAi(config);
    request.mockResolvedValueOnce(response(429)).mockResolvedValue(response());
    await reply(ai);
    if (field === "provider") config.ai.provider = "deepseek";
    else config.ai[field] = `${config.ai[field]}-changed`;
    const next = await reply(ai);
    expect(request).toHaveBeenCalledTimes(3); expect(models().slice(0, 2)).toEqual(["primary-model", "fallback-model"]);
    expect(request.mock.calls[2][0].url).toContain(config.ai.endpoint);
    expect(JSON.parse(request.mock.calls[2][0].body).model).toBe(config.ai.model);
    expect(request.mock.calls[2][0].headers.Authorization).toBe("Bearer " + config.ai.apiKey);
    expect(next.providerRun?.fallbackUsed).toBe(false);
  });

  it("keeps a second client independent even with identical settings", async () => {
    request.mockResolvedValueOnce(response(429)).mockResolvedValue(response());
    await reply(new LifeOpsAi(settings()));
    const second = await reply(new LifeOpsAi(settings()));
    expect(models()).toEqual(["primary-model", "fallback-model", "primary-model"]);
    expect(second.providerRun?.fallbackUsed).toBe(false);
  });

  it("discards the old routing hint when fallback credentials change", async () => {
    const config = settings(), ai = new LifeOpsAi(config);
    request.mockResolvedValueOnce(response(429)).mockResolvedValue(response());
    await reply(ai); config.ai.fallbackApiKey = "synthetic-new-fallback-key";
    await reply(ai);
    expect(models()).toEqual(["primary-model", "fallback-model", "primary-model"]);
  });

  it("keeps the configured order when both routes are rate limited", async () => {
    request.mockResolvedValue(response(429));
    const ai = new LifeOpsAi(settings());
    await expect(reply(ai)).rejects.toMatchObject({ code: "rate_limit" });
    await expect(reply(ai)).rejects.toMatchObject({ code: "rate_limit" });
    expect(models()).toEqual(["primary-model", "fallback-model", "primary-model", "fallback-model"]);
  });

  it("does not create a rate-limit hint for an ambiguous network failure", async () => {
    request.mockRejectedValueOnce(new Error("synthetic-network-error")).mockResolvedValue(response());
    const ai = new LifeOpsAi(settings()); await reply(ai); await reply(ai);
    expect(models()).toEqual(["primary-model", "fallback-model", "primary-model"]);
  });

  it("uses the sole primary after the fallback is disabled and sends nothing after disclosure is withdrawn", async () => {
    const config = settings(), ai = new LifeOpsAi(config);
    request.mockResolvedValueOnce(response(429)).mockResolvedValue(response());
    await reply(ai); config.ai.fallbackProvider = "off"; await reply(ai);
    expect(models()).toEqual(["primary-model", "fallback-model", "primary-model"]);
    config.ai.dataDisclosureAccepted = false;
    const disabled = await reply(ai);
    expect(disabled.providerRun?.status).toBe("unavailable"); expect(request).toHaveBeenCalledTimes(3);
  });

  it("retains the cooling primary as an alternative when the fallback fails", async () => {
    request.mockResolvedValueOnce(response(429)).mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response());
    const ai = new LifeOpsAi(settings()); await reply(ai);
    const result = await reply(ai);
    expect(models()).toEqual(["primary-model", "fallback-model", "fallback-model", "primary-model"]);
    expect(result.providerRun).toMatchObject({ actualProvider: "kimi", fallbackUsed: true, attempts: [{ errorCode: "http" }, { status: "success" }] });
  });

  it("does not repeat a completed-but-incomplete fallback answer", async () => {
    request.mockResolvedValueOnce(response(429)).mockResolvedValueOnce(response()).mockResolvedValueOnce({ ...response(), json: {
      choices: [{ finish_reason: "length", message: { content: "合成半截回复。" } }]
    } });
    const ai = new LifeOpsAi(settings()); await reply(ai);
    await expect(reply(ai)).rejects.toMatchObject({ code: "response_incomplete", providerRun: { actualProvider: "deepseek", fallbackUsed: true } });
    expect(models()).toEqual(["primary-model", "fallback-model", "fallback-model"]);
  });

  it("does not start a request for a cancelled turn while the primary is cooling", async () => {
    request.mockResolvedValueOnce(response(429)).mockResolvedValue(response());
    const ai = new LifeOpsAi(settings()); await reply(ai);
    const abort = new AbortController(); abort.abort();
    await expect(ai.agentReply("虚构", "取消", [], "text", { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([401, 503])("does not create a rate-limit hint for HTTP %s", async status => {
    request.mockResolvedValueOnce(response(status)).mockResolvedValue(response());
    const ai = new LifeOpsAi(settings()); await reply(ai); await reply(ai);
    expect(models()).toEqual(["primary-model", "fallback-model", "primary-model"]);
  });

  it("shares a hint across streaming and finite text transports", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(streamResponse(429)).mockImplementation(async () => streamResponse());
    vi.stubGlobal("fetch", fetch); request.mockResolvedValue(response());
    const ai = new LifeOpsAi(settings());
    await ai.agentReplyStream("虚构", "第一段", [], vi.fn());
    const finite = await ai.agentTurnStream([{ role: "user", content: "合成问题" }], vi.fn(), { preferFinite: true });
    const streamed = await ai.agentReplyStream("虚构", "下一段", [], vi.fn());
    expect(fetch.mock.calls.map(([, input]) => JSON.parse(input.body).model)).toEqual(["primary-model", "fallback-model", "fallback-model"]);
    expect(models()).toEqual(["fallback-model"]);
    for (const result of [finite, streamed]) expect(result.providerRun).toMatchObject({ requestedProvider: "kimi", actualProvider: "deepseek", fallbackUsed: true });
  });

  it("does not let an older delayed rate limit override a newer primary success", async () => {
    let release!: (value: ReturnType<typeof response>) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(response());
    const ai = new LifeOpsAi(settings()), slow = reply(ai);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await reply(ai); release(response(429)); await slow;
    const current = await reply(ai);
    expect(models()).toEqual(["primary-model", "primary-model", "fallback-model", "primary-model"]);
    expect(current.providerRun?.fallbackUsed).toBe(false);
  });
});
