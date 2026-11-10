import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { agentToolsForChat } from "../src/toolRegistry";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({ App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {},
  Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: vi.fn() }));
const { requestUrl } = await import("obsidian");
const { LifeOpsStore } = await import("../src/store");
const { LifeOpsAi } = await import("../src/ai");
const { default: Plugin } = await import("../src/main");
const { DiskVault } = await import("./helpers/diskVault");
const liveFetch = globalThis.fetch.bind(globalThis);
const liveMeasurement = process.env.LIFEOPS_MEASURE_CONTEXT === "1" && process.env.LIFEOPS_MEASURE_LIVE === "1";
const benchmarkClock = new Date("2026-11-06T00:27:14+08:00");
const questions = ["你好", "我今天还有什么任务没完成", "帮我建一个明天下午三点见客户的任务", "今天日记的状态怎么样", "这周习惯完成得怎么样"];
const chars = (value: string) => Array.from(value).length;
let root = "";
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); if (root) await rm(root, { recursive: true, force: true }); });

function segments(body: any) {
  const messages = body.messages as Array<{ role: string; content: string }>;
  const context = messages[1]?.content ?? "";
  const parts = context.split(/\n(?=#{1,4} )/u);
  const memory = parts.filter(part => /^#{1,4} [^\n]*(?:Memory|记忆)/u.test(part));
  return { system: chars(messages.filter(message => message.role === "system").map(message => message.content).join("\n")),
    tools: chars(JSON.stringify(body.tools ?? [])), context: chars(context) - memory.reduce((sum, part) => sum + chars(part), 0),
    memory: memory.reduce((sum, part) => sum + chars(part), 0), history: chars(messages.slice(2, -1).map(message => message.content).join("\n")),
    user: chars(messages.at(-1)?.content ?? ""), request: chars(JSON.stringify(body)) };
}

async function measureUsage(body: any): Promise<{ inputTokens: number; provider: string; model: string }> {
  const saved = JSON.parse(await readFile(process.env.LIFEOPS_MEASURE_CONFIG!, "utf8"));
  const config = saved.ai;
  if (!config?.apiKey?.trim() || !config.endpoint?.startsWith("https://") || !config.model?.trim()) throw Error("服务配置缺少可用的 HTTPS 地址、模型或密钥。");
  if (!config.dataDisclosureAccepted || !saved.privacy?.plaintextCredentialStorageAccepted) throw Error("现有服务配置尚未授权发送。");
  const endpoint = new URL(config.endpoint);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error("服务地址须是不含凭据或查询参数的 HTTPS 地址。");
  const response = await liveFetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ ...body, model: config.model, stream: false, max_tokens: 32 }) });
  if (!response.ok) throw Error(`真实测量请求失败（HTTP ${response.status}），未记录估算 token。`);
  const result = await response.json().catch(() => { throw Error("服务未返回可读取的 JSON usage。"); }) as any;
  const inputTokens = result.usage?.prompt_tokens ?? result.usage?.input_tokens;
  if (!Number.isInteger(inputTokens) || inputTokens < 1) throw Error("服务未返回实际输入 usage，不能冒报为真实测量。");
  return { inputTokens, provider: config.provider, model: config.model };
}

describe("production context measurement with synthetic Test Vault data", () => {
  it("captures the five requested production request bodies without dispatching tools", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(benchmarkClock);
    vi.stubGlobal("window", globalThis);
    root = await mkdtemp(join(tmpdir(), "lifeops-context-measure-"));
    await cp("fixtures/test-vault", root, { recursive: true });
    const vault = new DiskVault(root), app: any = { vault, workspace: { getLeavesOfType: () => [] } };
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.privacy = { ...settings.privacy, excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
    settings.ai = { ...settings.ai, provider: "openai-compatible", endpoint: "https://synthetic.invalid/chat", model: "kimi-k2.6",
      apiKey: "synthetic-not-a-secret", dataDisclosureAccepted: true, fallbackProvider: "off", fallbackApiKey: "" };
    const store = new LifeOpsStore(app, settings) as unknown as StoreHost; await store.initializeVault();
    const plugin = Object.assign(Object.create(Plugin.prototype), { app, store, settings, lifecycleGeneration: 1, unloaded: false,
      ai: new LifeOpsAi(settings), updateStatusBar: async () => {}, refreshViews: async () => {}, lifeOpsEvents: { publish: () => {} },
      buildSemanticContext: async () => "" });
    const captured: any[] = [];
    (requestUrl as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (options: any) => {
      expect(options.url).toBe("https://synthetic.invalid/chat"); captured.push(JSON.parse(options.body));
      return { status: 200, text: "", json: { choices: [{ message: { content: "虚构测量回复。", tool_calls: [] } }] } } as any;
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: any) => {
      expect(url).toBe("https://synthetic.invalid/chat"); captured.push(JSON.parse(options.body));
      return new Response('data: {"choices":[{"delta":{"content":"虚构测量回复。"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    }));
    const reports = [];
    for (const question of questions) {
      captured.length = 0;
      const tasksBefore = await vault.bytes(store.taskDbPath());
      await plugin.submitAgentMessageStream(question, [], () => {}, { selfTest: true });
      expect(captured, question).toHaveLength(1);
      expect(await vault.bytes(store.taskDbPath())).toBe(tasksBefore);
      reports.push({ question, chars: segments(captured[0]), ...(liveMeasurement ? await measureUsage(captured[0]) : { inputTokens: null }) });
    }
    const toolDescriptions = agentToolsForChat().map(tool => ({ name: tool.name, chars: chars(tool.description),
      parameters: Object.entries((tool.parameters as any).properties ?? {}).map(([name, value]: any) => ({ name, chars: chars(value.description ?? "") })) }));
    const report = { phase: process.env.LIFEOPS_MEASURE_PHASE ?? "current", fixture: "fixtures/test-vault (fictional)", clock: benchmarkClock.toISOString(), reports, toolDescriptions };
    if (process.env.LIFEOPS_MEASURE_CONTEXT === "1") {
      if (process.env.LIFEOPS_MEASURE_OUTPUT) await writeFile(process.env.LIFEOPS_MEASURE_OUTPUT, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    }
  }, liveMeasurement ? 660_000 : 30_000);
});
