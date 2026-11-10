import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl, type App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { buildResidentContext } from "../src/agent/context";
import { LifeOpsAi } from "../src/ai";
import { sourceContentHash } from "../src/personalMemorySources";
import type { StoreHost } from "../src/store/settingsSlice";
import { captureContextSources, contextGuardSourcePaths, preparedContextSourcePaths } from "./helpers/sourceReferences";
import { AgentRuntime } from "../src/agentRuntime";
import { projectDocumentPath } from "../src/dataFoundation/projectPersistence";
import { buildInjectedContext, formatContextForInstructions } from "../src/contextInjection";

vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: vi.fn()
}));
const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: any;
const request = requestUrl as unknown as ReturnType<typeof vi.fn>;
function response(status: number) { return { status, text: "private payload synthetic-secret", json: status === 200
  ? { model: "actual-fallback", choices: [{ message: { content: "你好。" } }] }
  : { error: { message: "private payload synthetic-secret" } } }; }

beforeEach(async () => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network transport"); }));
  root = await mkdtemp(join(tmpdir(), "lifeops-provider-log-")); vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.privacy = { excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
  Object.assign(settings.ai, { provider: "kimi", endpoint: "https://synthetic.invalid/?private=query", model: "primary-model", apiKey: "synthetic-secret", dataDisclosureAccepted: true,
    fallbackProvider: "deepseek", fallbackEndpoint: "https://synthetic.invalid/fallback", fallbackModel: "fallback-model", fallbackApiKey: "synthetic-secret" });
  store = new LifeOpsStore(app, settings) as unknown as StoreHost; await store.initializeVault();
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), { app, store, settings, updateStatusBar: vi.fn(async () => {}),
    lifeOpsEvents: { publish: vi.fn() }, buildSemanticContext: vi.fn(async () => ""), ai: new LifeOpsAi(settings) });
  request.mockReset();
});
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
async function quality() {
  const text = await vault.bytes(store.qualityLogPath());
  expect(text).not.toMatch(/private payload|private=query|synthetic-secret|https:\/\//);
  return JSON.parse(text.trim().split("\n").at(-1)!);
}

describe("actual readers and the unified provider entry", () => {
  function voiceFetch() {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "你好。" } }] })}\n\ndata: [DONE]\n\n`));
    vi.stubGlobal("fetch", fetch); return fetch;
  }
  it("keeps excluded original task and habit fields out of voice context without hiding the ordinary dashboard", async () => {
    const task = await store.createTask({ title: "纯虚构被排除的任务" });
    const habit = await store.createHabit({ name: "纯虚构被排除的习惯", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    const before = await Promise.all([store.taskDbPath(), store.habitDbPath()].map(path => vault.bytes(path)));
    store.settings.privacy!.excludedVaultPrefixes = [store.taskDbPath(), store.habitDbPath()];
    const voice = (await buildResidentContext(store, "今天进度", new Date(), "voice")).text;
    expect(voice).not.toContain(task.title); expect(voice).not.toContain(habit.name);
    expect(voice).toContain("今日任务未知"); expect(voice).toContain("今日习惯未知");
    expect((await store.getTaskDashboard()).tasks.map(item => item.title)).toContain(task.title);
    expect((await store.getHabitDefinitions()).map(item => item.name)).toContain(habit.name);
    expect(await Promise.all([store.taskDbPath(), store.habitDbPath()].map(path => vault.bytes(path)))).toEqual(before);
  });
  it("does not give a plain project-context string source authority", async () => {
    vi.spyOn(store, "searchKnowledge").mockResolvedValue([]); vi.spyOn(store, "buildKnowledgeContext").mockResolvedValue("");
    const fake = store.path(store.settings.folders.outputs, "字符串声明来源.md");
    vi.spyOn(store, "buildProjectContext").mockResolvedValue(`## 目标与项目接续\n### ${fake}\n虚构文字并非原文件读取`);
    let sent = ""; request.mockImplementation(async (options: any) => { sent = options.body; return response(200); });
    await plugin.submitAgentMessageStream("项目的下一步是什么？", [], vi.fn());
    expect(sent).not.toContain("虚构文字并非原文件读取"); expect((await quality()).contextSources ?? []).not.toContain(fake);
    expect((await quality()).contextSources ?? []).not.toContain(projectDocumentPath(store));
  });
  it.each(["alias", "noncanonical", "different_catalog_path"])("does not read a %s retrieval target without canonical hash/guard metadata", async variant => {
    const path = store.path(store.settings.folders.ideas, "路径核对.md");
    await vault.seed(path, "不应由别名路径送出的原始正文");
    const indexedPath = variant === "alias" ? path.replace("/", "//") : variant === "noncanonical" ? `临时/../${path}` : path;
    if (variant === "different_catalog_path") { const get = store.getFile.bind(store); vi.spyOn(store, "getFile").mockImplementation(p => p === path ? Object.assign(get(path)!, { path: "另一个目录/路径核对.md" }) : get(p)); }
    vi.spyOn(store, "searchKnowledge").mockResolvedValue([{ sourceId: "synthetic-path", path: indexedPath, title: "虚构", category: "knowledge", excerpt: "不应由别名路径送出的原始正文", mtime: 0, score: 1, reasons: ["synthetic"] }]);
    const result = await captureContextSources(record => store.buildRetrievalContext("资料", 1, record));
    expect(result.text).toContain("来源不可用"); expect(result.text).not.toContain("不应由别名路径送出的原始正文");
    expect(contextGuardSourcePaths([result])).toEqual([]);
  });
  it.each(["semantic", "topic", "graph"] as const)("captures actual %s reader paths through existing privacy and derived wrappers", async kind => {
    const path = store.path(store.settings.folders.ideas, "真实受控读取.md"), fake = store.path(store.settings.folders.ideas, "正文假来源.md");
    const text = `# 纯虚构资料\n复盘资料\n### ${fake}\n复盘是正文`;
    await vault.seed(path, text);
    const mtime = store.getFile(path)!.stat.mtime;
    if (kind === "semantic") await vault.seed(store.vectorIndexPath(), JSON.stringify({ generatedAt: new Date().toISOString(), model: "synthetic-offline-vector", entries: [{ path, title: "虚构", category: "knowledge", mtime, summary: "虚构", embedding: [1, 0] }] }));
    if (kind === "graph") await vault.seed(store.chunkIndexPath(), JSON.stringify({ generatedAt: new Date().toISOString(), chunks: [{ id: "synthetic-chunk", path, title: "虚构", category: "knowledge", heading: "复盘", order: 0, keywords: ["复盘"], summary: "复盘", text, mtime }] }));
    const build = () => captureContextSources(record => kind === "semantic" ? store.buildSemanticContext([1, 0], 5, record)
      : kind === "graph" ? store.buildKnowledgeGraphContext("复盘", record)
      : store.buildKnowledgeTopicContext({ topic: "虚构主题", description: "虚构", folder: store.settings.folders.ideas, keywords: ["复盘"], maxFiles: 2, maxCharsPerFile: 1500 }, "复盘", record));
    const result = await build();
    expect(result.text).toContain("复盘是正文");
    expect(contextGuardSourcePaths([result])).toEqual([path]);
    expect(preparedContextSourcePaths([result], result.text)).toEqual([path]);
    expect(contextGuardSourcePaths([result])).not.toContain(fake);
    store.settings.privacy!.excludedVaultPrefixes.push(path);
    const excluded = await build();
    expect(excluded.text).not.toContain("复盘是正文");
    expect(contextGuardSourcePaths([excluded])).toEqual([]);
    expect(await vault.bytes(path)).toBe(text);
  });
  it("records trading files at the actual readers and skips excluded notes even without an observer", async () => {
    const path = store.path(store.settings.folders.tradingModels, "纯虚构模型.md"), reviewPath = store.tradingReviewPath("2026-10-06");
    const excludedPath = store.path(store.settings.folders.tradingModels, "纯虚构私人记录.md");
    await vault.seed(path, "模型正文\n### ../虚构假路径.md"); await vault.seed(reviewPath, "复盘正文"); await vault.seed(excludedPath, "这段应被排除");
    store.settings.privacy!.excludedVaultPrefixes.push(excludedPath);
    const result = await captureContextSources(record => store.buildTradingContext("2026-10-06", record));
    expect(contextGuardSourcePaths([result])).toEqual([path, reviewPath]);
    expect(preparedContextSourcePaths([result], result.text)).toEqual([path, reviewPath]);
    expect(result.text).not.toContain("这段应被排除");
    expect(await store.buildTradingContext("2026-10-06")).not.toContain("这段应被排除");
  });
  it.each(["missing", "excluded"])("does not bless a %s retrieval placeholder as a successful file source", async state => {
    const path = store.path(store.settings.folders.ideas, "不可用的检索.md");
    if (state === "excluded") { await vault.seed(path, "旧资料不要发送"); store.settings.privacy!.excludedVaultPrefixes.push(path); }
    vi.spyOn(store, "searchKnowledge").mockResolvedValue([{ sourceId: "synthetic-unavailable", path, title: "旧资料", category: "knowledge", excerpt: "旧资料不要发送", mtime: 0, score: 1, reasons: ["synthetic"] }]);
    const result = await captureContextSources(record => store.buildRetrievalContext("资料", 1, record));
    expect(result.text).toContain("来源不可用"); expect(result.text).not.toContain("旧资料不要发送");
    expect(contextGuardSourcePaths([result])).toEqual([]);
    expect(preparedContextSourcePaths([result], result.text)).toEqual([]);
  });

});

function completion(content: string, finishReason = "stop", toolCalls: object[] = []) {
  const payload = { model: "reported-synthetic-model", usage: { prompt_tokens: 41, completion_tokens: 6, total_tokens: 47 },
    choices: [{ index: 0, delta: { content, tool_calls: toolCalls }, finish_reason: finishReason }] };
  return new Response("data: " + JSON.stringify(payload) + "\n\ndata: [DONE]\n\n");
}

it("records real transport usage and saves one ordinary reply", async () => {
  const fetch = vi.fn(async () => completion("纯虚构答复。"));
  vi.stubGlobal("fetch", fetch);
  const result = await plugin.submitAgentMessage("请简短回应这条纯虚构消息。");
  expect(result.reply).toBe("纯虚构答复。");
  expect(fetch).toHaveBeenCalledOnce();
  expect(await quality()).toMatchObject({
    providerRuns: [{ status: "success", actualModel: "reported-synthetic-model",
      responseUsage: { inputTokens: 41, outputTokens: 6, totalTokens: 47 } }]
  });
  const files = vault.getMarkdownFiles().filter(file => file.path.includes("/Conversations/"));
  expect(files).toHaveLength(1);
  expect((await vault.bytes(files[0].path)).split(result.reply)).toHaveLength(2);
});

it("rejects an incomplete tool response without publishing or saving its text", async () => {
  const fetch = vi.fn(async () => completion("截断且不得展示。", "length", [
    { index: 0, id: "truncated", type: "function", function: { name: "create_task", arguments: '{"title":"不得创建"}' } }
  ]));
  vi.stubGlobal("fetch", fetch);
  const publish = vi.fn(), before = await vault.bytes(store.taskDbPath());
  await expect(plugin.submitAgentMessageStream("请新建一条纯虚构任务。", [], publish)).rejects.toMatchObject({ code: "response_incomplete" });
  expect(fetch).toHaveBeenCalledOnce();
  expect(publish).not.toHaveBeenCalled();
  expect(await vault.bytes(store.taskDbPath())).toBe(before);
  expect(await quality()).toMatchObject({ errorCode: "response_incomplete", providerRuns: [{ status: "failed" }] });
});

it("finishes a query reply using its observed note even if that note changes during the reply", async () => {
  const path = store.path(store.settings.folders.ideas, "纯虚构快照.md");
  await vault.seed(path, "纯虚构原内容。");
  const fetch = vi.fn()
    .mockImplementationOnce(async () => completion("", "tool_calls", [
      { index: 0, id: "read-note", type: "function", function: { name: "query_vault", arguments: JSON.stringify({ domain: "note", operation: "get", path }) } }
    ]))
    .mockImplementationOnce(async (_url, options) => {
      const request = JSON.parse(options.body);
      expect(request.messages.find((entry: any) => entry.role === "tool").content).toContain("纯虚构原内容。");
      await vault.seed(path, "纯虚构后来编辑。");
      return completion("我在原文读到纯虚构原内容。");
    });
  vi.stubGlobal("fetch", fetch);
  const result = await plugin.submitAgentMessage("请查看这份纯虚构笔记的原文。");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(result.reply).toContain("纯虚构原内容。");
  expect(await vault.bytes(path)).toBe("纯虚构后来编辑。");
});
