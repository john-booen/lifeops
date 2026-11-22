import { mkdtemp, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import { AgentRuntime } from "../src/agentRuntime";
import { OperationLedger } from "../src/dataFoundation/operationLedger";
import { getLifeOpsTool } from "../src/toolRegistry";
import type { ToolExecutionContext } from "../src/toolRegistry";
import type { ToolExecutionControl } from "../src/agentRuntime";
import type { VaultQueryRead } from "../src/vaultQueryRead";
import { fileRevision } from "../src/operationIdentity";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, Modal: class {}, Plugin: class {},
  WorkspaceLeaf: class {}, ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, setIcon: vi.fn(),
  normalizePath: (path: string) => path.replace(/\\/g, "/"), parseYaml: JSON.parse, stringifyYaml: JSON.stringify,
  requestUrl: () => { throw Error("No provider calls in the fictional continuity fixture"); } }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { LifeOpsAi } = await import("../src/ai");
const { default: Plugin } = await import("../src/main");
let root: string, store: StoreHost, vault: InstanceType<typeof DiskVault>, runtime: AgentRuntime;
let context: ToolExecutionContext;
const range = { from: "2026-11-02", to: "2026-11-08" };
const original = "虚构蓝纸归档：完成12张。", latest = original + "\n虚构补充原话：黄纸已整理7张。";
const path = "LifeOps/Journal/2026/11/2026-11-04晚.md";
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-23T01:30:00+08:00"));
  root = await mkdtemp(join(tmpdir(), "lifeops-summary-continuity-")); vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault(); await vault.seed(path, original);
  await store.createTask({ title: "虚构保留任务", date: "2026-11-04" });
  context = { store, refreshViews: async () => {} }; runtime = new AgentRuntime(context);
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
const summary = (control?: ToolExecutionControl, args: Record<string, unknown> = { level: "week", range, includeOriginals: true }) =>
  runtime.executeAiToolCall({ id: "fictional-continuity-summary", name: "get_summaries", arguments: args }, "kimi", "", control);
function refreshOnDirectRead(update: (raw: string, count: number) => Promise<void> | void) {
  const read = vault.read.bind(vault); let count = 0;
  // Native cachedRead is independent of read. Change only the actual original
  // read, not a memory-source attestation that may precede the query itself.
  vi.spyOn(vault, "cachedRead").mockImplementation(file => read(file));
  vi.spyOn(vault, "read").mockImplementation(async file => {
    const raw = await read(file); if (file.path === path) await update(raw, ++count); return raw;
  });
  return () => count;
}
async function confirmMemory() {
  const source = store.path(store.settings.folders.ideas, "虚构独立规则.md"), content = "虚构独立规则：纸样归档安排25分钟。";
  await vault.seed(source, content);
  const row = await store.upsertPersonalMemory({ kind: "current_state", content,
    sourceRefs: [{ sourceId: "fictional-continuity-independent", path: source, capturedAt: new Date().toISOString(), contentHash: fileRevision(content), extractionVersion: "fictional-v1" }] });
  await store.reviewPersonalMemory(row.id, { decision: "confirm" }); return { row, source, content };
}

it("reads current originals after a one-time source refresh following statistics, with no model or business write", async () => {
  const tasks = await vault.bytes(store.taskDbPath()), memory = await vault.bytes(store.personalMemoryPath());
  const stats = await runtime.executeAiToolCall({ id: "fictional-continuity-stats", name: "get_stats", arguments: { domain: "tasks", range } }, "kimi");
  expect(stats.success, stats.output).toBe(true);
  const execute = vi.spyOn(getLifeOpsTool("get_summaries")!, "execute");
  const reads = refreshOnDirectRead(async (_raw, count) => { if (count === 1) await vault.seed(path, latest); });
  const result = await summary();
  expect(result.success, result.output).toBe(true);
  expect(JSON.parse(result.output).originalEvidence.notes[0].text).toBe(latest);
  expect(reads()).toBeGreaterThanOrEqual(2); expect(execute).toHaveBeenCalledTimes(2); expect(result.receipt).toBeUndefined(); expect(result.actions).toEqual([]);
  expect(await vault.bytes(store.taskDbPath())).toBe(tasks); expect(await vault.bytes(store.personalMemoryPath())).toBe(memory);
  expect(await vault.bytes(path)).toBe(latest);
  const ledger = await store.readJson(new OperationLedger(store).filePath, { version: 1, records: [] as any[] });
  expect(ledger.records.filter(row => row.toolName === "get_summaries")).toHaveLength(1);
});

it("prepares a stable original just once, including after an unrelated confirmed memory", async () => {
  await confirmMemory(); const execute = vi.spyOn(getLifeOpsTool("get_summaries")!, "execute");
  const result = await summary(); expect(result.success, result.output).toBe(true); expect(execute).toHaveBeenCalledTimes(1);
  expect(JSON.parse(result.output).originalEvidence.notes[0].text).toBe(original);
});
it("recovers a metadata-only refresh without changing original bytes", async () => {
  const execute = vi.spyOn(getLifeOpsTool("get_summaries")!, "execute");
  refreshOnDirectRead(async (_raw, count) => { if (count === 1) await utimes(vault.diskPath(path), new Date("2026-11-04T18:00:00Z"), new Date("2026-11-04T18:00:00Z")); });
  const result = await summary(); expect(result.success, result.output).toBe(true); expect(execute).toHaveBeenCalledTimes(2);
  expect(JSON.parse(result.output).originalEvidence.notes[0].text).toBe(original); expect(await vault.bytes(path)).toBe(original);
});
it("keeps both requested weeks when only one original changes during a cross-week read", async () => {
  const other = "LifeOps/Journal/2026/11/2026-11-11晚.md", otherText = "虚构第二周：绿纸已归档3张。";
  await vault.seed(other, otherText); const tasks = await vault.bytes(store.taskDbPath());
  refreshOnDirectRead(async (_raw, count) => { if (count === 1) await vault.seed(path, latest); });
  const result = await summary(undefined, { level: "week", range: { from: "2026-11-02", to: "2026-11-15" }, includeOriginals: true });
  expect(result.success, result.output).toBe(true);
  const notes = JSON.parse(result.output).originalEvidence.notes;
  expect(notes.map((note: { date: string }) => note.date)).toEqual(["2026-11-04", "2026-11-11"]);
  expect(notes.map((note: { text: string }) => note.text)).toEqual([latest, otherText]);
  expect(await vault.bytes(other)).toBe(otherText); expect(await vault.bytes(store.taskDbPath())).toBe(tasks);
});
it("stops after the second changing original without publishing either obsolete body or claiming a write", async () => {
  const execute = vi.spyOn(getLifeOpsTool("get_summaries")!, "execute");
  const reads = refreshOnDirectRead(async (_raw, count) => { await vault.seed(path, latest + "\n虚构变更" + count); });
  const result = await summary(); expect(result.success).toBe(false); expect(execute).toHaveBeenCalledTimes(2); expect(reads()).toBe(2);
  expect(result.output).not.toContain("蓝纸"); expect(result.output).not.toContain("黄纸"); expect(result.actions).toEqual([]); expect(result.receipt).toBeUndefined();
});
it.each(["policy", "cancel", "store", "host", "memory"])("does not retry a source refresh after %s changes", async change => {
  const execute = vi.spyOn(getLifeOpsTool("get_summaries")!, "execute"), controller = new AbortController(); let current = true;
  context.assertCurrent = () => { if (!current) throw Error("Closed context"); };
  const reads = refreshOnDirectRead(async (_raw, count) => {
    if (count !== 1) return; await vault.seed(path, latest);
    if (change === "policy") store.settings.privacy!.excludedVaultPrefixes = [path];
    if (change === "cancel") controller.abort();
    if (change === "store") context.store = new LifeOpsStore(store.app, structuredClone(store.settings)) as unknown as StoreHost;
    if (change === "host") current = false;
    if (change === "memory") await confirmMemory();
  });
  const result = await summary({ assertCurrent: () => {}, signal: controller.signal });
  expect(result.success).toBe(false); expect(execute).toHaveBeenCalledTimes(1); expect(reads()).toBe(1);
  expect(result.output).not.toContain("虚构蓝纸"); expect(result.output).not.toContain("操作记录无法安全读取"); expect(result.actions).toEqual([]);
});
it("does not retry when an existing memory's source becomes invalid between attempts", async () => {
  const memory = await confirmMemory(), before = await vault.bytes(store.personalMemoryPath());
  const tool = getLifeOpsTool("get_summaries")!, originalExecute = tool.execute!;
  const execute = vi.spyOn(tool, "execute").mockImplementation(async (args, ctx, identity) => {
    const result = await originalExecute(args, ctx, identity);
    if (!result.success) await vault.seed(memory.source, memory.content + "原始依据后来改过。"); return result;
  });
  refreshOnDirectRead(async (_raw, count) => { if (count === 1) await vault.seed(path, latest); });
  const result = await summary(); expect(result.success).toBe(false); expect(execute).toHaveBeenCalledTimes(1); expect(result.output).not.toContain("黄纸");
  expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
});
it("keeps the original requested dates even if the caller changes its arguments during the refresh", async () => {
  await vault.seed("LifeOps/Journal/2026/11/2026-11-11晚.md", "虚构未授权扩展日期里的绿纸。");
  const args = { level: "week", range: { ...range }, includeOriginals: true };
  refreshOnDirectRead(async (_raw, count) => { if (count === 1) { args.range = { from: "2026-11-09", to: "2026-11-15" }; await vault.seed(path, latest); } });
  const result = await summary(undefined, args); expect(result.success, result.output).toBe(true);
  expect(JSON.parse(result.output).range).toMatchObject(range); expect(result.output).toContain("黄纸"); expect(result.output).not.toContain("绿纸");
});
it("holds the new actual source revision after recovery and still refuses subsequent changes", async () => {
  refreshOnDirectRead(async (_raw, count) => { if (count === 1) await vault.seed(path, latest); }); let read: VaultQueryRead | undefined;
  const result = await summary({ assertCurrent: () => {}, onQueryRead: (_result, value) => { read = value; } });
  expect(result.success, result.output).toBe(true); expect(read?.text).toBe(result.output);
  try { await read!.assertSourcesCurrent(); await vault.seed(path, latest + "后来又改过。"); await expect(read!.assertSourcesCurrent()).rejects.toThrow(); }
  finally { read?.dispose(); }
});
it.each(["memory", "cancel"])("disposes a prepared second read when %s changes before it can be published", async change => {
  const tool = getLifeOpsTool("get_summaries")!, execute = tool.execute!, controller = new AbortController(); let calls = 0, read: VaultQueryRead | undefined;
  refreshOnDirectRead(async (_raw, count) => { if (count === 1) await vault.seed(path, latest); });
  vi.spyOn(tool, "execute").mockImplementation(async (args, ctx, identity) => {
    const result = await execute(args, { ...ctx, onVaultQueryRead: value => { read = value; ctx.onVaultQueryRead?.(value); } }, identity);
    if (++calls === 2) { if (change === "memory") await confirmMemory(); else controller.abort(); }
    return result;
  });
  const result = await summary({ assertCurrent: () => {}, signal: controller.signal });
  expect(result.success).toBe(false); expect(read).toBeDefined(); expect(() => read!.assertCurrent()).toThrow(); expect(result.output).not.toContain("黄纸");
});
it.each(["保存尚未结束，请等待或恢复后再读取历史依据。", "查询权限已变化，请重新读取。", "外部日记信号格式异常。"])("does not retry other preparation failures: %s", async output => {
  const execute = vi.spyOn(getLifeOpsTool("get_summaries")!, "execute").mockResolvedValue({ success: false, output, actions: [] });
  expect((await summary()).success).toBe(false); expect(execute).toHaveBeenCalledTimes(1);
});
it("never extends the summary retry rule to a write tool", async () => {
  const tasks = await vault.bytes(store.taskDbPath());
  const execute = vi.spyOn(getLifeOpsTool("create_task")!, "execute").mockResolvedValue({ success: false, output: "查询范围已变化，请重新读取后再操作。", actions: [] });
  const result = await runtime.executeAiToolCall({ id: "fictional-failed-write", name: "create_task", arguments: { title: "虚构不会被重放的任务", date: "2026-11-23" } }, "kimi");
  expect(result.success).toBe(false); expect(execute).toHaveBeenCalledTimes(1); expect(await vault.bytes(store.taskDbPath())).toBe(tasks);
});
it("delivers the refreshed original through the production conversation entry with no extra model round or task change", async () => {
  vi.stubGlobal("window", globalThis); Object.assign(store.app, { workspace: { getLeavesOfType: () => [] } });
  store.settings.ai = { ...store.settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", model: "synthetic", apiKey: "fictional-key", dataDisclosureAccepted: true };
  store.settings.privacy!.plaintextCredentialStorageAccepted = true;
  const before = await vault.bytes(store.taskDbPath()), answer = "11月4日原话已补充：黄纸已整理7张。下一步（建议）：按这次原话核对纸样清单。";
  const execute = vi.spyOn(getLifeOpsTool("get_summaries")!, "execute"); let turns = 0;
  vi.spyOn(LifeOpsAi.prototype, "agentTurnStream").mockImplementation(async (messages, onText, options) => {
    if (++turns === 1) return { content: "", toolCalls: [{ id: "fictional-refresh-turn", name: "get_summaries", arguments: { level: "week", range, includeOriginals: true } }] };
    expect(JSON.stringify(messages)).toContain("黄纸已整理7张"); expect(JSON.stringify(messages)).not.toContain("暂无法安全核对");
    if (turns === 2) { onText("虚构未发布草稿"); return { content: "虚构未发布草稿", toolCalls: [] }; }
    expect(turns).toBe(3); expect(JSON.stringify(messages)).not.toContain("虚构未发布草稿"); expect(options?.tools).toEqual([]);
    onText(answer); return { content: answer, toolCalls: [] };
  });
  const plugin = Object.assign(Object.create(Plugin.prototype), { app: store.app, store, settings: store.settings, lifecycleGeneration: 1, unloaded: false,
    ai: new LifeOpsAi(store.settings), updateStatusBar: async () => {}, refreshViews: async () => {}, lifeOpsEvents: { publish: () => {} }, buildSemanticContext: async () => "" });
  refreshOnDirectRead(async (_raw, count) => { if (count === 1) await vault.seed(path, latest); });
  const streamed: string[] = [];
  const result = await plugin.submitAgentMessageStream("查看2026年11月2日至8日的原始日记，给一条基于原话的归档建议，不修改记录。", [], (text: string) => streamed.push(text), { source: "text", selfTest: true });
  expect(result.reply).toBe(answer); expect(streamed.at(-1)).toBe(answer); expect(streamed.join("")).not.toContain("虚构未发布草稿");
  expect(turns).toBe(3); expect(execute).toHaveBeenCalledTimes(2);
  expect(result.actions).toEqual([]); expect(result.receipts).toEqual([]); expect(await vault.bytes(store.taskDbPath())).toBe(before);
  expect(await vault.bytes(path)).toBe(latest);
});
