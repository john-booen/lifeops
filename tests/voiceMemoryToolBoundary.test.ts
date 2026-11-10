import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { createPersonalMemory, emptyPersonalMemoryDocument, reviewPersonalMemoryRecord } from "../src/personalMemory";
import { MEMORY_CONTEXT_OMISSION } from "../src/personalMemoryContext";
import { VoiceSessionController } from "../src/voice/voiceRuntime";
import { OperationLedger } from "../src/dataFoundation/operationLedger";
import type { StoreHost } from "../src/store/settingsSlice";
import type { AiToolCall } from "../src/ai";

vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(),
  requestUrl: vi.fn(() => { throw new Error("Network forbidden"); })
}));
vi.mock("ws", () => ({ default: class { constructor() { throw new Error("Network forbidden"); } } }));
const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { executeOmniE2eToolCall } = await import("../src/voice/voiceRealtime");

let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: any;
const oldText = "我喜欢晚上跑步";
const newText = "我现在喜欢早晨散步";
const unrelated = "今天核对了蓝色清单。";
const date = "2026-09-27";
let memoryId: string, journalPath: string;
beforeEach(async () => {
  vi.stubGlobal("window", globalThis);
  root = await mkdtemp(join(tmpdir(), "lifeops-voice-memory-tool-"));
  vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
  journalPath = store.dailyNotePath(date, "晚");
  await vault.seed(journalPath, `${oldText}。\n\n${unrelated}`);
  const original = createPersonalMemory({ kind: "core_profile", content: oldText,
    sourceRefs: [{ sourceId: "synthetic-journal", path: journalPath, capturedAt: `${date}T12:00:00Z` }] });
  memoryId = original.id;
  await vault.seed(store.personalMemoryPath(), JSON.stringify({ ...emptyPersonalMemoryDocument(),
    records: reviewPersonalMemoryRecord([original], original.id, { decision: "confirm" }) }));
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), {
    app, store, settings: store.settings, refreshViews: vi.fn(async () => {})
  });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

function viewFor(transcript = "请读一下昨天的晚间日记") {
  const runtime = new VoiceSessionController({ provider: "offline-synthetic" });
  runtime.connect(); runtime.connected();
  runtime.beginTurn({ route: "e2e", transcript });
  runtime.transitionTurn("routing", "test"); runtime.transitionTurn("generating", "test");
  return {
    viewClosed: false, agentTextRequestGeneration: 1, agentVoicePipelineGeneration: 1,
    agentVoiceRuntime: runtime, controller: plugin, pendingAgentActions: [],
    agentOmniE2eReply: "", agentReply: "", agentOmniE2eAssistantIndex: -1,
    refreshAgentSuggestions: vi.fn()
  } as any;
}
function query(arguments_: Record<string, unknown> = {}): AiToolCall {
  return { id: "synthetic-query", name: "query_vault", arguments: {
    domain: "journal", operation: "get", date, period: "晚", ...arguments_
  } };
}
async function review(decision: "correct" | "forget") {
  await store.reviewPersonalMemory(memoryId, decision === "correct" ? { decision, content: newText } : { decision });
}

describe("real voice tool results obey current memory without modifying original sources", () => {
  it.each(["correct", "forget"] as const)("filters the old diary paragraph after %s and preserves source evidence", async decision => {
    const original = await vault.bytes(journalPath);
    await review(decision);
    const reply = await executeOmniE2eToolCall(viewFor(), query());
    expect(reply).not.toContain(oldText);
    expect(reply).toContain(MEMORY_CONTEXT_OMISSION);
    expect(reply).toContain(unrelated);
    expect(reply).toContain(journalPath);
    expect(reply).toContain(`- date: ${date}`);
    expect(reply).toContain("- period: 晚");
    expect(await vault.bytes(journalPath)).toBe(original);
  });

  it.each(["get", "search"])("filters the full diary before its 500 character %s excerpt", async operation => {
    const original = "前".repeat(496) + oldText + `。\n\n${unrelated}`;
    await vault.seed(journalPath, original);
    await review("forget");
    const reply = await executeOmniE2eToolCall(viewFor(), query({ operation, query: date, maxChars: 500 }));
    expect(reply).not.toContain("我喜欢");
    expect(reply).toContain(MEMORY_CONTEXT_OMISSION);
    expect(reply).toContain(unrelated);
    expect(await vault.bytes(journalPath)).toBe(original);
  });

  it("lists diary source metadata without including either active or forgotten body text", async () => {
    await review("forget");
    const reply = await executeOmniE2eToolCall(viewFor(), query({ operation: "list", query: date }));
    expect(reply).toContain(journalPath);
    expect(reply).not.toContain(oldText);
    expect(reply).not.toContain(unrelated);
  });

  it.each(["note", "trade", "health"])("rebuilds clipped %s search excerpts from protected original source", async domain => {
    const folder = domain === "trade" ? store.settings.folders.tradingModels
      : domain === "health" ? store.settings.folders.health : store.settings.folders.ideas;
    const path = store.path(folder, "合成边界检索.md");
    const original = "前".repeat(1796) + oldText + `。\n\n${unrelated}`;
    await vault.seed(path, original);
    await store.syncVaultSources();
    const rawSearch = await store.searchKnowledge(oldText);
    expect(rawSearch.some(hit => hit.path === path && hit.excerpt.includes("我喜欢"))).toBe(true);
    await review("forget");
    const reply = await executeOmniE2eToolCall(viewFor(), query({ domain, operation: "search", query: "合成边界检索", date: "", period: "", maxChars: 5000 }));
    expect(reply).not.toContain("我喜欢");
    expect(reply).toContain(MEMORY_CONTEXT_OMISSION);
    expect(reply).toContain(path);
    expect(reply).toContain(unrelated);
    const forgottenSearch = await executeOmniE2eToolCall(viewFor(), query({ domain, operation: "search", query: oldText, date: "", period: "" }));
    expect(forgottenSearch).not.toContain(path);
    expect(forgottenSearch).not.toContain(unrelated);
    expect(forgottenSearch).not.toContain(oldText);
    expect(await vault.bytes(path)).toBe(original);
  });


  it("preserves a current user quote and the verified diary save receipt after forgetting", async () => {
    await review("forget");
    const content = `这只是今天引用的旧话：${oldText}，请原样留在日记。`;
    const message = `请把这段保存到今天的晚间日记：${content}`;
    const reply = await executeOmniE2eToolCall(viewFor(message), {
      id: "synthetic-save", name: "append_journal_entry", arguments: { content, date: "2026-09-28", period: "晚" }
    });
    expect(reply).toContain("已写入并读回校验");
    expect(await vault.bytes(store.dailyNotePath("2026-09-28", "晚"))).toContain(content);
  });

  it.each(["text", "voice"].flatMap(mode => (["correct", "forget"] as const).map(decision => ({ mode, decision }))))(
    "does not reuse a clipped read cached before $decision through $mode", async ({ mode, decision }) => {
    await vault.seed(journalPath, "前".repeat(496) + oldText + `。\n\n${unrelated}`);
    const call = query({ maxChars: 500 });
    const execute = async () => {
      if (mode === "voice") return executeOmniE2eToolCall(viewFor(), call);
      const execution = await plugin.executeToolCalls([call], "读一下日记");
      expect(execution.results[0].callId).toBe(call.id);
      return execution.replies.join("\n");
    };
    const first = await execute();
    expect(first).toContain("我喜欢");
    await review(decision);
    const retried = await execute();
    expect(retried).not.toContain("我喜欢");
    expect(retried).toContain(MEMORY_CONTEXT_OMISSION);
  });

  it("does not misreport a verified write if memory becomes unreadable after it succeeds", async () => {
    plugin.refreshViews.mockImplementationOnce(async () => { await vault.seed(store.personalMemoryPath(), "{broken"); });
    const reply = await executeOmniE2eToolCall(viewFor(`/todo ${oldText}`), {
      id: "synthetic-memory-read-failure", name: "create_task", arguments: { title: oldText }
    });
    expect(reply).toContain("成功");
    expect(reply).toContain("暂时无法核对");
    expect(reply).not.toContain(oldText);
    expect((await store.readTaskDb()).tasks.some(task => task.title === oldText)).toBe(true);
  });


  it("preserves waiting-for-confirmation and the exact local card while withholding old content from the model", async () => {
    const task = await store.createTask({ title: oldText });
    await review("forget");
    const view = viewFor(`删除任务${oldText}`);
    const reply = await executeOmniE2eToolCall(view, { id: "synthetic-delete", name: "delete_task", arguments: { taskIdOrTitle: task.id } });
    expect(reply).not.toContain(oldText);
    expect(reply).toMatch(/等待确认|待确认/);
    expect(reply).toMatch(/尚未执行|确认后/);
    expect(view.pendingAgentActions).toHaveLength(1);
    expect(view.pendingAgentActions[0].content).toContain(oldText);
    expect((await store.readTaskDb()).tasks.some(candidate => candidate.id === task.id)).toBe(true);
  });

  it("preserves successful creation status when its reply contains a suppressed phrase", async () => {
    await review("forget");
    const reply = await executeOmniE2eToolCall(viewFor(`/todo ${oldText}`), {
      id: "synthetic-task", name: "create_task", arguments: { title: oldText }
    });
    expect(reply).not.toContain(oldText);
    expect(reply).toContain("成功");
    expect((await store.readTaskDb()).tasks.some(task => task.title === oldText)).toBe(true);
  });

  it("preserves failure status when a missing target quotes a suppressed phrase", async () => {
    await review("forget");
    const reply = await executeOmniE2eToolCall(viewFor(`删除任务${oldText}`), {
      id: "synthetic-missing-task", name: "delete_task", arguments: { taskIdOrTitle: oldText }
    });
    expect(reply).not.toContain(oldText);
    expect(reply).toMatch(/未完成|没有完成/);
  });
});
