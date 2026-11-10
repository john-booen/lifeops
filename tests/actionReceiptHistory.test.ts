import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { AgentActionSuggestion } from "../src/types";
import type { StoreHost } from "../src/store/settingsSlice";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { todayString } from "../src/date";

vi.mock("obsidian", () => ({ App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: () => { throw Error("Unexpected provider call"); } }));
const { LifeOpsStore } = await import("../src/store");
const { default: Plugin } = await import("../src/main");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: any;
const receipt = "草稿已核验保存。\n支持、反例和未知保留；没有确认记忆。";
const conversationPath = () => store.path(store.settings.folders.aiReports, "Conversations", `${todayString()}.md`);
const bytes = async (path: string) => vault.bytes(path).catch(() => null);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => {
  vi.stubGlobal("window", globalThis);
  root = await mkdtemp(join(tmpdir(), "lifeops-action-history-")); vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: () => [] } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
  plugin = Object.assign(Object.create(Plugin.prototype), { app, store, settings: store.settings, unloaded: false, lifecycleGeneration: 1,
    refreshViews: async () => {}, updateStatusBar: async () => {}, lifeOpsEvents: { publish: vi.fn() }, recordConversationMemory: vi.fn() });
  vault.writes.length = 0;
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

describe("system action receipt persistence", () => {
  it("preserves earlier history, stores a labelled full receipt, and reads it with a fresh Store", async () => {
    const path = conversationPath(), prefix = "# 原历史\n先前已保存的对话。\n"; await vault.seed(path, prefix);
    const factPaths = [store.taskDbPath(), store.habitDbPath(), store.personalMemoryPath(), store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json")];
    const before = await Promise.all(factPaths.map(bytes));
    expect(await plugin.appendAgentActionReceipt("周回顾草稿", receipt)).toBe(true);
    const fresh = new LifeOpsStore(plugin.app, structuredClone(store.settings)) as unknown as StoreHost;
    const raw = await fresh.readPath(path);
    expect(raw.startsWith(prefix)).toBe(true); expect(raw).toContain("系统操作回执");
    expect(raw).toContain("仅说明当次执行结果；之后可能更正或撤销，不代表当前状态。");
    expect(raw).toContain("> 草稿已核验保存。\n> 支持、反例和未知保留；没有确认记忆。");
    expect(raw).not.toMatch(/^### 我$/m); expect(raw.match(/<!-- lifeops-action-receipt:/g)).toHaveLength(1);
    expect(await Promise.all(factPaths.map(bytes))).toEqual(before); expect(plugin.recordConversationMemory).not.toHaveBeenCalled();
  });

  it("quotes injected headings and normalizes title/receipt line breaks without pretending the user spoke", async () => {
    expect(await plugin.appendAgentActionReceipt("虚构标题\r\n### 我\n额外标题", "实际回执\r### 我\r\n假句子\n另一行")).toBe(true);
    const raw = await vault.bytes(conversationPath());
    expect(raw).toContain("> 操作：虚构标题 ### 我 额外标题");
    expect(raw).toContain("> 实际回执\n> ### 我\n> 假句子\n> 另一行"); expect(raw).not.toMatch(/^### 我$/m);
  });

  it.each(["unloaded", "excluded", "empty"])("does not write an unverifiable receipt when %s", async reason => {
    if (reason === "unloaded") plugin.unloaded = true;
    if (reason === "excluded") plugin.settings.privacy.excludedVaultPrefixes = [plugin.settings.folders.aiReports];
    expect(await plugin.appendAgentActionReceipt("周回顾", reason === "empty" ? "  " : receipt)).toBe(false);
    expect(await bytes(conversationPath())).toBeNull(); expect(vault.writes).toEqual([]);
  });

  it.each(["unload", "generation", "privacy", "folders", "store", "store-policy"])("blocks a late file creation after %s changes during folder preparation", async reason => {
    if (reason === "store-policy") plugin.settings = structuredClone(store.settings);
    const entered = deferred(), release = deferred(), original = store.ensureFolder.bind(store), path = conversationPath();
    vi.spyOn(store, "ensureFolder").mockImplementation(async folder => { await original(folder); entered.resolve(); await release.promise; });
    const pending = plugin.appendAgentActionReceipt("周回顾", receipt); await entered.promise;
    if (reason === "unload") plugin.unloaded = true;
    if (reason === "generation") plugin.lifecycleGeneration++;
    if (reason === "privacy") plugin.settings.privacy.excludedVaultPrefixes = [plugin.settings.folders.aiReports];
    if (reason === "folders") plugin.settings.folders.inbox += "-changed";
    if (reason === "store") plugin.store = {};
    if (reason === "store-policy") store.settings.folders.inbox += "-changed";
    release.resolve(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await bytes(path)).toBeNull(); expect(vault.writes.filter(write => write.kind !== "createFolder")).toEqual([]);
  });

  it("preserves exact existing history when privacy changes before its process callback", async () => {
    const path = conversationPath(), original = "先前原文\n"; await vault.seed(path, original);
    const entered = deferred(), release = deferred(); vault.beforeProcess = async () => { entered.resolve(); await release.promise; };
    const pending = plugin.appendAgentActionReceipt("周回顾", receipt); await entered.promise;
    plugin.settings.privacy.excludedVaultPrefixes = [plugin.settings.folders.aiReports]; release.resolve();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" }); expect(await vault.bytes(path)).toBe(original);
  });

  it("reports ambiguous readback without deleting a receipt that was actually written", async () => {
    vi.spyOn(store, "readPath").mockResolvedValue("unverifiable readback");
    expect(await plugin.appendAgentActionReceipt("周回顾", receipt)).toBe(false);
    expect(await vault.bytes(conversationPath())).toContain("> 草稿已核验保存。");
  });
  it.each(["append", "readback"])("keeps the committed history when its owner changes after %s", async stage => {
    const path = conversationPath(), prefix = "原历史保持。\n"; await vault.seed(path, prefix);
    const factPaths = [store.taskDbPath(), store.habitDbPath(), store.personalMemoryPath()];
    const before = await Promise.all(factPaths.map(bytes));
    if (stage === "append") {
      const append = store.appendFile.bind(store);
      vi.spyOn(store, "appendFile").mockImplementation(async (...args) => { await append(...args); plugin.lifecycleGeneration++; });
    } else {
      const read = store.readPath.bind(store);
      vi.spyOn(store, "readPath").mockImplementation(async path => { const raw = await read(path); plugin.lifecycleGeneration++; return raw; });
    }
    expect(await plugin.appendAgentActionReceipt("周回顾", receipt)).toBe(false);
    const raw = await vault.bytes(path); expect(raw.startsWith(prefix)).toBe(true); expect(raw).toContain("> 草稿已核验保存。");
    expect(await Promise.all(factPaths.map(bytes))).toEqual(before); expect(plugin.recordConversationMemory).not.toHaveBeenCalled();
  });
});

describe("actual Runtime outputs returned to the action panel", () => {
  it.each(["create_task", "append_knowledge_note", "append_trading_model_note"] as const)("returns the actual %s Runtime output", async type => {
    const runtime = { executeToolCall: vi.fn(async () => ({ success: true, output: "实际Runtime回执：已核验保存；含部分状态。", actions: [] })) };
    plugin.createAgentRuntime = () => runtime;
    const action = { id: "fictional-receipt", type, title: "模型标题不能代替结果", description: "", content: "虚构正文", date: todayString() } as AgentActionSuggestion;
    expect(await plugin.executeAgentAction(action)).toBe("实际Runtime回执：已核验保存；含部分状态。");
    expect(runtime.executeToolCall).toHaveBeenCalledOnce();
  });
  it.each(["journal", "capture"])("returns the actual %s result without changing the executed request", async kind => {
    const journal = { success: true, output: "实际日记回执", actions: [] }, capture = { success: true, output: "实际捕获回执", actions: [] };
    const runtime = { executeConfirmedJournalSuggestion: vi.fn(async () => kind === "journal" ? journal : null), executeConfirmedCaptureSuggestion: vi.fn(async () => capture) };
    plugin.createAgentRuntime = () => runtime;
    const action = { id: "fictional-receipt", type: kind === "journal" ? "append_daily_note" : "send_to_inbox", title: "模型标题", description: "", content: "虚构正文", date: todayString() } as AgentActionSuggestion;
    expect(await plugin.executeAgentAction(action)).toBe(kind === "journal" ? journal.output : capture.output);
    if (kind === "journal") expect(runtime.executeConfirmedCaptureSuggestion).not.toHaveBeenCalled();
  });
});
