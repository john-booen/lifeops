import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl, type App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { todayString } from "../src/date";
import { LifeOpsAi, type AiToolCall } from "../src/ai";
import type { StoreHost } from "../src/store/settingsSlice";
import { createPersonalMemory, emptyPersonalMemoryDocument, reviewPersonalMemoryRecord } from "../src/personalMemory";

vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: vi.fn()
}));
const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: any;
let followup: string, calls: AiToolCall[], initial: string;
let bodies: any[], delivered: string[];
const request = requestUrl as unknown as ReturnType<typeof vi.fn>;
const journalText = "今天核对了合成清单，下午有些疲惫，明天先休息十分钟。";
const writeCall = (): AiToolCall => ({ id: "synthetic-journal-1", name: "append_journal_entry", arguments: { content: journalText, period: "晚", date: todayString() } });

beforeEach(async () => {
  vi.stubGlobal("window", globalThis);
  root = await mkdtemp(join(tmpdir(), "lifeops-daily-flow-"));
  vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.privacy = { ...settings.privacy, excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
  Object.assign(settings.ai, { provider: "openai-compatible", endpoint: "https://synthetic.invalid/chat", model: "kimi-k2.6", apiKey: "synthetic-not-a-secret", dataDisclosureAccepted: true });
  store = new LifeOpsStore(app, settings) as unknown as StoreHost;
  await store.initializeVault();
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), {
    app, store, settings, updateStatusBar: vi.fn(async () => {}),
    lifeOpsEvents: { publish: vi.fn() }, buildSemanticContext: vi.fn(async () => ""), ai: new LifeOpsAi(settings)
  });
  bodies = []; delivered = []; calls = []; initial = "供你选择的草稿。"; followup = "我已经保存到晚间日记。";
  request.mockReset();
  request.mockImplementation(async (options: any) => {
    expect(options.url).toBe("https://synthetic.invalid/chat");
    bodies.push(JSON.parse(options.body));
    return { status: 200, text: "", json: { choices: [{ message: { content: initial, tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } }] } } as any;
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: any) => {
    expect(url).toBe("https://synthetic.invalid/chat");
    const body = JSON.parse(options.body);
    bodies.push(body);
    const outputs = body.messages.filter((message: any) => message.role === "tool");
    const first = outputs.length === 0;
    const toolCalls = first ? calls.map((call, index) => ({ index, id: call.id, type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) : [];
    const content = first ? initial : outputs.map((message: any) => message.content).join("\n");
    const payload = { choices: [{ index: 0, delta: { content, tool_calls: toolCalls },
      finish_reason: toolCalls.length ? "tool_calls" : "stop" }] };
    return new Response("data: " + JSON.stringify(payload) + "\n\ndata: [DONE]\n\n");
  }));
});
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

const submit = (message: string) => plugin.submitAgentMessageStream(message, [], (text: string) => delivered.push(text), { selfTest: true });

describe("daily flows through real model serialization and action runtime, synthetic transport only", () => {
  it.each([
    "请把上面这段交易复盘保存到晚间日记",
    "请保存这段交易复盘到晚间日记：纯虚构正文",
    "请你把这段交易复盘写入晚间日记"
  ])("offers journal tools without a misplaced fallback card through the actual serialized request: %s", async message => {
    initial = "请提供要保存的正文。";
    const journalPath = store.dailyNotePath(todayString(), "晚");
    await vault.seed(journalPath, "原有日记正文必须保留。\n");
    const factPaths = [journalPath, store.taskDbPath(), store.habitDbPath(), store.personalMemoryPath()];
    const factsBefore = await Promise.all(factPaths.map(path => vault.bytes(path)));
    const response = await submit(message);
    expect(bodies[0].tools.some((tool: any) => tool.function.name === "append_journal_entry")).toBe(true);
    expect(response.actions).toEqual([]);
    // Retrieval can rebuild derived files; user facts must remain exact.
    expect(await Promise.all(factPaths.map(path => vault.bytes(path)))).toEqual(factsBefore);
  });
  it.each(["早", "晚"] as const)("records a mixed trading journal tool reply only in the requested %s period", async period => {
    const date = "2026-09-30", content = "纯虚构交易复盘：当时没有核对规则，不代表任务或习惯已完成。";
    const target = store.dailyNotePath(date, period), other = store.dailyNotePath(date, period === "早" ? "晚" : "早");
    await vault.seed(target, "原有手写内容必须保留。\n");
    await vault.seed(other, "另一时段内容必须保留。\n");
    const paths = [other, store.taskDbPath(), store.habitDbPath(), store.personalMemoryPath()];
    const before = await Promise.all(paths.map(path => vault.bytes(path)));
    calls = [{ id: `mixed-trade-journal-${period}`, name: "append_journal_entry", arguments: { content, period, date } }];
    await submit(`请把这段交易复盘保存到2026-09-30${period}间日记：${content}`);
    expect(bodies[0].tools.some((tool: any) => tool.function.name === "append_journal_entry")).toBe(true);
    expect(await vault.bytes(target)).toContain("原有手写内容必须保留。");
    expect(await vault.bytes(target)).toContain(content);
    expect(await Promise.all(paths.map(path => vault.bytes(path)))).toEqual(before);
  });
  it.each([
    "请保存这段交易复盘到晚间日记",
    "请你把这段交易复盘写入晚间日记"
  ])("saves natural mixed write wording with literal quotations and questions: %s", async header => {
    const content = "纯虚构复盘。他说“不要着急”，我问自己为什么没有核对？";
    const path = store.dailyNotePath(todayString(), "晚");
    await vault.seed(path, "原有晚间手写内容。\n");
    const factPaths = [store.taskDbPath(), store.habitDbPath(), store.personalMemoryPath()];
    const before = await Promise.all(factPaths.map(item => vault.bytes(item)));
    calls = [{ id: "mixed-natural-journal", name: "append_journal_entry", arguments: { content, period: "晚", date: todayString() } }];
    await submit(`${header}：${content}`);
    expect(await vault.bytes(path)).toContain("原有晚间手写内容。");
    expect(await vault.bytes(path)).toContain(content);
    expect(await Promise.all(factPaths.map(item => vault.bytes(item)))).toEqual(before);
  });
  it("answers an existing memory question without inventing a save card or rewriting the answer", async () => {
    initial = "有1条已确认记录：\n\n**沟通偏好**：先给一句结论，再给两条建议。";
    const before = await vault.bytes(store.personalMemoryPath());
    const response = await submit("你记得我的沟通偏好吗？如果有已经确认的记录，请简短说明。");
    expect(response.reply).toBe(initial);
    expect(response.actions).toEqual([]);
    expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
  });
  it.each(["把这段内容写入晚间日记", "请把这段保存到晚间日记", "请保存这段晚间日记"])("returns verified journal success and restores the exact original with undo: %s", async instruction => {
    calls = [writeCall()];
    const response = await submit(`${instruction}：${journalText}`);
    expect(response.reply).toContain("已写入并读回校验");
    const path = store.dailyNotePath(todayString(), "晚");
    const saved = await store.readPath(path);
    expect(saved).toContain(journalText);
    expect(delivered).toEqual([response.reply]);
    expect(bodies).toHaveLength(2);
    expect(response.receipts).toHaveLength(1);
    await plugin.undoStewardOperation(response.receipts[0].operationId);
    expect(await store.readPath(path)).not.toContain(journalText);
  });
  it("reports a failed journal write from the runtime, without claiming completion", async () => {
    calls = [writeCall()];
    vi.spyOn(store, "appendDaily").mockRejectedValueOnce(new Error("synthetic write failure"));
    const response = await submit(`把这段内容写入晚间日记：${journalText}`);
    expect(response.reply).toContain("synthetic write failure");
    expect(response.reply).not.toContain("已经保存");
    expect(delivered).toEqual([response.reply]);
    expect(bodies).toHaveLength(2);
  });
  it("saves a conversation memory directly and returns an undo receipt", async () => {
    calls = [{ id: "synthetic-memory", name: "append_memory_note", arguments: { content: "合成偏好：先看当日安排。" } }];
    const before = await store.readPath(store.personalMemoryPath());
    const response = await submit("请记住这个偏好：先看当日安排。");
    expect(response.reply).toContain("已记住");
    expect(response.actions).toEqual([]);
    expect(response.receipts).toHaveLength(1);
    expect(await store.readPath(store.personalMemoryPath())).not.toBe(before);
    await plugin.undoStewardOperation(response.receipts![0].operationId);
    expect(await store.readPath(store.personalMemoryPath())).toBe(before);
    expect(delivered).toEqual([response.reply]);
    expect(bodies).toHaveLength(2);
  });
  it("reports mixed success and failure without hiding either outcome", async () => {
    calls = [writeCall(), { id: "synthetic-bad-tool", name: "missing_tool", arguments: {} }];
    const response = await submit(`把这段内容写入晚间日记：${journalText}`);
    expect(response.reply).toContain("已写入并读回校验");
    expect(response.reply).toContain("暂不支持");
    expect(delivered).toEqual([response.reply]);
    expect(bodies).toHaveLength(2);
  });
});
