import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";

describe("default provider policy", () => {
  it("does not point a fresh LifeOps install at OpenAI or Claude services", () => {
    const serialized = JSON.stringify({
      ai: DEFAULT_SETTINGS.ai,
      voice: DEFAULT_SETTINGS.voice,
      vision: DEFAULT_SETTINGS.vision,
      embedding: DEFAULT_SETTINGS.embedding,
      realtimeVoice: DEFAULT_SETTINGS.realtimeVoice
    }).toLowerCase();

    expect(serialized).not.toContain("api.openai.com");
    expect(serialized).not.toContain("anthropic");
    expect(serialized).not.toContain("claude");
    expect(DEFAULT_SETTINGS.ai).toMatchObject({
      provider: "off",
      endpoint: "https://api.moonshot.cn/v1/chat/completions",
      model: "kimi-k2.6"
    });
  });
});
