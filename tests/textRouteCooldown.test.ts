import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { LifeOpsAi } from "../src/ai";
import { DEFAULT_SETTINGS } from "../src/defaults";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));
const request = vi.mocked(requestUrl);
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
beforeEach(() => request.mockReset());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("text route cooldown on the actual AI entry point", () => {
  it("starts the next turn on the already configured fallback after a primary rate limit", async () => {
    request.mockImplementation(async input => response(typeof input === "object" && input.url.includes("/primary") ? 429 : 200));
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
});
