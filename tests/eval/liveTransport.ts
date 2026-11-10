import type { RequestUrlParam, RequestUrlResponsePromise } from "obsidian";

interface RequestUsage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  pending?: Promise<void>;
  transportFailed?: boolean;
}

export class EvalTransport {
  private requests: RequestUsage[] = [];
  private readonly originalFetch = globalThis.fetch.bind(globalThis);

  constructor(private readonly allowedEndpoints: readonly string[]) {}

  reset(): void { this.requests = []; }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!this.allowedEndpoints.includes(url)) throw Error("评测请求超出已配置模型范围");
    const body = JSON.parse(String(init?.body));
    const record: RequestUsage = { model: body.model };
    this.requests.push(record);
    const requestBody = body.stream ? { ...body, stream_options: { ...body.stream_options, include_usage: true } } : body;
    const response = await this.originalFetch(url, {
      ...init, body: JSON.stringify(requestBody), redirect: "error",
      signal: init?.signal ?? AbortSignal.timeout(45_000)
    }).catch(error => { record.transportFailed = true; throw error; });
    if (response.status === 408 || response.status === 429 || response.status >= 500) record.transportFailed = true;
    record.pending = response.clone().text().then((text) => {
      const entries = body.stream ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()) : [text];
      for (const entry of entries) {
        if (!entry || entry === "[DONE]") continue;
        let json;
        try { json = JSON.parse(entry); } catch { continue; }
        const inputTokens = json.usage?.prompt_tokens ?? json.usage?.input_tokens;
        const outputTokens = json.usage?.completion_tokens ?? json.usage?.output_tokens;
        if (Number.isInteger(inputTokens) && inputTokens >= 0) record.inputTokens = inputTokens;
        if (Number.isInteger(outputTokens) && outputTokens >= 0) record.outputTokens = outputTokens;
      }
    }).catch(() => { record.transportFailed = true; });
    return response;
  };

  readonly requestUrl = (request: string | RequestUrlParam): RequestUrlResponsePromise => {
    const options = typeof request === "string" ? { url: request } : request;
    const pending = (async () => {
      const response = await this.fetch(options.url, { method: options.method, headers: options.headers, body: options.body });
      const arrayBuffer = await response.arrayBuffer();
      const text = new TextDecoder().decode(arrayBuffer);
      let json;
      try { json = JSON.parse(text); } catch { json = null; }
      if (!response.ok && options.throw !== false) throw Error(`模型请求 HTTP ${response.status}`);
      return { status: response.status, text, json, headers: Object.fromEntries(response.headers), arrayBuffer };
    })();
    return Object.defineProperties(pending, {
      arrayBuffer: { get: () => pending.then((response) => response.arrayBuffer) },
      json: { get: () => pending.then((response) => response.json) },
      text: { get: () => pending.then((response) => response.text) }
    }) as RequestUrlResponsePromise;
  };

  async usage() {
    const requests = this.requests;
    await Promise.all(requests.map((record) => record.pending));
    const sum = (key: "inputTokens" | "outputTokens") => requests.every((record) => record[key] !== undefined)
      ? requests.reduce((total, record) => total + record[key]!, 0) : undefined;
    return {
      inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"),
      peakInputTokens: requests.length && requests.every(record => record.inputTokens !== undefined)
        ? Math.max(...requests.map(record => record.inputTokens!)) : undefined,
      models: [...new Set(requests.map((record) => record.model))], requests: requests.length,
      transportFailures: requests.filter(record => record.transportFailed).length
    };
  }
}
