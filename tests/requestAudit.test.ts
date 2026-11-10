import { describe, expect, it, vi } from "vitest";
import { notifyRequestAudit } from "../src/requestAudit";
import { normalizeQualityLogEntry } from "../src/qualityLog";
import type { ProviderRequestAudit, QualityLogEntry } from "../src/types";

describe("content-free prepared request audit", () => {
  it("known credential audit redaction covers another configured key without forwarding the context", () => {
    const key = "synthetic-other-token", observer = vi.fn();
    notifyRequestAudit(JSON.stringify({ model: `model-${key}`, messages: [{ content: "合成消息" }] }), { provider: "kimi", model: `model-${key}`, apiKey: "synthetic-current-token" }, "request_url", { onRequestAudit: observer }, [key]);
    expect(observer).toHaveBeenCalledOnce(); expect(observer.mock.calls[0][0].requestedModel).toBe("unknown"); expect(JSON.stringify(observer.mock.calls)).not.toContain(key);
  });
  it("counts the final Unicode body without forwarding any body or secret fields", () => {
    const raw = JSON.stringify({ model: "model", messages: [{ role: "user", content: "私密测试正文🔥" }],
      tools: [{ type: "function", function: { name: "read", parameters: {} } }], max_tokens: 280 });
    const observer = vi.fn();
    notifyRequestAudit(raw, { provider: "kimi", model: "model", apiKey: "synthetic-secret" }, "request_url", { onRequestAudit: observer });
    const event = observer.mock.calls[0][0];
    expect(event.requestBytes).toBe(Buffer.byteLength(raw, "utf8"));
    expect(event.messageChars).toBe("私密测试正文🔥".length);
    expect(event.maxOutputTokens).toBe(280);
    expect(JSON.stringify(event)).not.toMatch(/私密|🔥|synthetic-secret|parameters|messages|role|actualInputTokens/);
    expect(JSON.parse(raw).messages[0].content).toBe("私密测试正文🔥");
  });
  it("omits an absent output limit and rejects configured identities containing the key", () => {
    const observer = vi.fn();
    notifyRequestAudit(JSON.stringify({ messages: [{ content: "ok" }] }), { provider: "kimi", model: "synthetic-secret-model", apiKey: "synthetic-secret" }, "stream", { onRequestAudit: observer });
    expect(observer.mock.calls[0][0]).toMatchObject({ requestedModel: "unknown", toolSchemaChars: 0 });
    expect(observer.mock.calls[0][0]).not.toHaveProperty("maxOutputTokens");
    expect(JSON.stringify(observer.mock.calls)).not.toContain("synthetic-secret");
  });
  it("does not let synchronous or asynchronous observer errors escape", async () => {
    const raw = JSON.stringify({ messages: [{ content: "ok" }] }), target = { provider: "kimi", model: "model", apiKey: "" };
    expect(() => notifyRequestAudit(raw, target, "request_url", { onRequestAudit: () => { throw Error("observer failure"); } })).not.toThrow();
    notifyRequestAudit(raw, target, "stream", { onRequestAudit: () => Promise.reject(Error("async observer failure")) });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  it("ignores uninspectable bodies rather than inventing zero lengths", () => {
    const observer = vi.fn(), target = { provider: "kimi", model: "model", apiKey: "" };
    notifyRequestAudit("{malformed", target, "request_url", { onRequestAudit: observer });
    notifyRequestAudit(JSON.stringify({ messages: [{ content: [{ type: "image_url" }] }] }), target, "request_url", { onRequestAudit: observer });
    expect(observer).not.toHaveBeenCalled();
  });
  it("caps rows, accounts for rejected/truncated entries and strips unknown fields", () => {
    const event = { stage: "prepared", requestedProvider: "kimi", requestedModel: "model", transport: "request_url",
      requestBytes: 50, messageCount: 1, messageChars: 2, toolSchemaChars: 0, endpoint: "https://private.invalid", body: "private payload", apiKey: "private key" };
    const events = Array.from({ length: 20 }, () => ({ ...event }));
    events[0].requestBytes = Infinity;
    const log = normalizeQualityLogEntry({ requestAudits: events, requestAuditDropped: 3 } as unknown as QualityLogEntry);
    expect(log.requestAudits).toHaveLength(15);
    expect(log.requestAuditDropped).toBe(8);
    expect(JSON.stringify(log)).not.toMatch(/private|endpoint|apiKey|body|Infinity/);
    expect(events).toHaveLength(20);
  });
  it.each([-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])("drops invalid numeric metadata: %s", requestBytes => {
    const event: ProviderRequestAudit = { stage: "prepared", requestedProvider: "kimi", requestedModel: "model", transport: "stream", requestBytes,
      messageCount: 1, messageChars: 2, toolSchemaChars: 0 };
    expect(normalizeQualityLogEntry({ requestAudits: [event] }).requestAuditDropped).toBe(1);
  });
});
