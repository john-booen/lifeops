import { configuredCredentials } from "../../credentialSecurity";
import { recordProviderEgress } from "../../privacy";
import { assertProviderActive, ProviderTransportError, runProviderRequest } from "../../providerRun";
import type { LifeOpsSettings, ProviderRequestOptions } from "../../types";
import { readScreenshotImage, type ScreenshotImage } from "./image";

export function screenshotEndpoint(value: string): string {
  const invalid = () => Error("请填写视觉模型的 HTTPS /chat/completions 地址。");
  let endpoint: URL;
  try { endpoint = new URL(value.trim()); } catch { throw invalid(); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !endpoint.pathname.endsWith("/chat/completions")) throw invalid();
  return endpoint.toString();
}

async function readResponse(response: Response): Promise<{ model?: string; choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }> }> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderTransportError("invalid_response", "视觉服务没有返回识别结果。");
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 128_000) {
        void reader.cancel().catch(() => undefined);
        throw new ProviderTransportError("invalid_response", "识别结果超出大小上限，请拆图重试。");
      }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new ProviderTransportError("invalid_response", "视觉服务没有返回有效识别结果。"); }
  } finally { reader.releaseLock(); }
}

interface ScreenshotVisionRequest<T> {
  purpose: "trade_screenshot" | "health_screenshot";
  prompt: string;
  ready(settings: LifeOpsSettings): string;
  parse(content: string): T;
}

export async function recognizeScreenshot<T>(settings: LifeOpsSettings, selected: ScreenshotImage, config: ScreenshotVisionRequest<T>, options: ProviderRequestOptions = {},
  assertCurrent: () => void = () => undefined): Promise<T> {
  assertProviderActive(options.signal);
  assertCurrent();
  const endpoint = config.ready(settings);
  const image = readScreenshotImage(selected.bytes);
  if (image.digest !== selected.digest) throw Error("选中的截图已经变化，请重新选择。");
  const { provider, model, apiKey } = settings.vision;
  const target = { provider, model: model.trim() };
  const credentials = configuredCredentials(settings);
  const body = JSON.stringify({ model: target.model, stream: false, max_tokens: 3500,
    messages: [{ role: "user", content: [
      { type: "text", text: config.prompt },
      { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.bytes.toString("base64")}` } }
    ] }] });
  const result = await runProviderRequest(target, [{ ...target, transport: "fetch", async execute(signal) {
    await recordProviderEgress({ capability: "vision", ...target, purpose: config.purpose, requestBytes: Buffer.byteLength(body), sourceCount: 1 }, credentials)
      .catch(() => undefined);
    assertProviderActive(signal);
    assertCurrent();
    const response = await fetch(endpoint, { method: "POST", signal, redirect: "error", credentials: "omit",
      headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" }, body });
    if (!response.ok) throw new ProviderTransportError(response.status === 401 || response.status === 403 ? "auth"
      : response.status === 429 ? "rate_limit" : "http", "视觉服务请求失败。", response.status);
    const json = await readResponse(response);
    const choice = json?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string" || choice?.finish_reason && choice.finish_reason !== "stop") {
      throw new ProviderTransportError("invalid_response", "没有得到完整的截图识别结果。");
    }
    let rows: T;
    try { rows = config.parse(content); }
    catch (error) { throw new ProviderTransportError("invalid_response", (error as Error).message); }
    assertCurrent();
    return { rows, reportedModel: json.model };
  } }], { ...options, timeoutMs: 40_000, sensitiveValues: credentials });
  assertCurrent();
  return result.rows;
}
