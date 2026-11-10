import { afterEach, describe, expect, it } from "vitest";
import {
  countProviderSources,
  isVaultPathExcluded,
  normalizeExcludedVaultPrefixes,
  parseExcludedVaultPrefixes,
  providerDisclosureRequired,
  recordProviderEgress,
  setProviderEgressSink,
  utf8RequestBytes
} from "../src/privacy";

describe("privacy boundaries", () => {
  afterEach(() => setProviderEgressSink(null));

  it("normalizes user-configured sensitive Vault prefixes", () => {
    expect(parseExcludedVaultPrefixes(" 私人资料, 财务/密钥\n私人资料/ ")).toEqual([
      "私人资料",
      "财务/密钥"
    ]);
    expect(normalizeExcludedVaultPrefixes(["A/", "A", "B"])).toEqual(["A", "B"]);
  });

  it("excludes exact paths, descendants and .obsidian without overmatching siblings", () => {
    expect(isVaultPathExcluded("私人资料/a.md", ["私人资料"])).toBe(true);
    expect(isVaultPathExcluded("私人资料", ["私人资料"])).toBe(true);
    expect(isVaultPathExcluded("私人资料备份/a.md", ["私人资料"])).toBe(false);
    expect(isVaultPathExcluded(".obsidian/plugins/x/data.json", [])).toBe(true);
  });

  it("explains the data category before each Provider can be authorized", () => {
    expect(providerDisclosureRequired("text")).toContain("Vault/记忆文本片段");
    expect(providerDisclosureRequired("embedding")).toContain("Vault 文本片段");
    expect(providerDisclosureRequired("vision")).toContain("完整屏幕截图");
    expect(providerDisclosureRequired("voice")).toContain("麦克风音频");
  });

  it("known credential audit redaction protects provider and oversized model before shortening", async () => {
    const key = "synthetic-private-long-token", records: unknown[] = [];
    setProviderEgressSink(record => { records.push(record); });
    const record = await recordProviderEgress({ capability: "text", provider: `provider-${key}`, model: "model-" + "x".repeat(100) + key,
      purpose: "chat", requestBytes: 42, sourceCount: 0 }, [key]);
    expect(record).toMatchObject({ provider: "unknown", model: "unknown", purpose: "chat", requestBytes: 42, contentLogged: false });
    expect(records).toEqual([record]); expect(JSON.stringify(records)).not.toContain(key.slice(0, 8));
  });

  it("records Provider egress metadata without recording request content", async () => {
    const saved: unknown[] = [];
    setProviderEgressSink((record) => {
      saved.push(record);
    });
    const privateText = "绝不能写进审计的私人正文";

    const record = await recordProviderEgress({
      capability: "text",
      provider: "test-provider",
      model: "test-model",
      purpose: "chat",
      requestBytes: utf8RequestBytes(privateText),
      sourceCount: 2
    });

    expect(saved).toEqual([record]);
    expect(record).toMatchObject({
      capability: "text",
      provider: "test-provider",
      model: "test-model",
      purpose: "chat",
      sourceCount: 2,
      contentLogged: false
    });
    expect(record.requestBytes).toBeGreaterThan(privateText.length);
    expect(JSON.stringify(record)).not.toContain(privateText);
  });

  it("counts distinct Vault sources without retaining their content", () => {
    expect(countProviderSources([{
      role: "user",
      content: "# Retrieved Vault Notes\n\n### 项目/A.md\n正文\n\n### 日记/B.md\n正文"
    }])).toBe(2);
    expect(countProviderSources({ path: "项目/A.md", nested: { sourcePath: "日记/B.md" } })).toBe(2);
  });
});
