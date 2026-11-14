import type { AiToolCall } from "../src/ai";
import { stubAgentModel } from "./helpers/stubAgentModel";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { discoverLinkedNoteNames } from "../src/linkedNoteSettings";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: () => { throw Error("Offline fictional dates"); } }));
const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsStore } = await import("../src/store"), { DiskVault } = await import("./helpers/diskVault");
const tools = [
  { tool: "append_knowledge_note", folder: "ideas", note: "Cici 知识沉淀.md", intent: "保存到知识库" },
  { tool: "append_trading_model_note", folder: "tradingModels", note: "Cici 交易模型迭代.md", intent: "保存到交易模型" }
] as const;
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: any;
const original = "纯虚构原亲写方法，不能覆盖。\n", diary = "纯虚构跨年日记，分类保持独立。\n";
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 0, 1, 12)); vi.stubGlobal("window", globalThis);
  root = await mkdtemp(join(tmpdir(), "lifeops-linked-date-main-")); vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; await store.initializeVault();
  for (const item of tools) await vault.seed(store.path(store.settings.folders[item.folder], item.note), original);
  store.settings.linkedNoteNames = discoverLinkedNoteNames(store.settings, vault.getMarkdownFiles());
  await vault.seed(store.dailyNotePath("2026-01-01", "晚"), diary);
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), { app, store, settings: store.settings, lifecycleGeneration: 1, unloaded: false, updateStatusBar: vi.fn(async () => {}), refreshViews: vi.fn(async () => {}), lifeOpsEvents: { publish: vi.fn() }, buildSemanticContext: vi.fn(async () => ""), tryLocalAgentFallback: vi.fn(async () => null) });
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
function model(call: AiToolCall) {
  const fixed = vi.fn(async () => ({ content: "", toolCalls: [call] }));
  stubAgentModel(plugin, fixed); return fixed;
}
describe("linked knowledge and trading dates through actual Main and disk", () => {
  it("writes a configured neutral note and uses its name in the activity link", async () => {
    expect(discoverLinkedNoteNames(structuredClone(DEFAULT_SETTINGS), [])).toEqual({ knowledge: "知识沉淀.md", trading: "交易模型迭代.md" });
    store.settings.linkedNoteNames = { knowledge: "虚构研究摘记.md", trading: "虚构规则.md" };
    model({ name: "append_knowledge_note", id: "fiction-custom-file", arguments: { content: "虚构摘记正文", date: "今天" } });
    const result = await plugin.submitAgentMessage("保存到知识库：虚构摘记正文", [], { selfTest: true });
    expect(result.reply).toContain("已写入知识库");
    const folder = store.settings.folders.ideas;
    expect(await store.readPath(store.path(folder, "虚构研究摘记.md"))).toContain("虚构摘记正文");
    expect(await store.readPath(store.path(folder, "每日记录", "2026-01-01.md"))).toContain("|虚构研究摘记]]");
    expect(await store.readPath(store.path(folder, "Cici 知识沉淀.md"))).toBe(original);
  });
  for (const item of tools) {
    it.each(["text", "voice"] as const)(`${item.tool} resolves cross-year relative dates, preserves originals, and undoes both files: %s`, async source => {
      const folder = store.settings.folders[item.folder], path = store.path(folder, item.note);
      for (const [supplied, expected] of [["昨天", "2025-12-31"], ["前天", "2025-12-30"], ["2024-02-29", "2024-02-29"], ["", "2026-01-01"]]) {
        const dated = store.path(folder, "每日记录", `${expected}.md`), before = store.getFile(dated) ? await vault.bytes(dated) : null, text = `纯虚构${item.folder}方法${expected}`;
        const fixed = model({ id: `fictional-${item.folder}-${source}-${expected}`, name: item.tool, arguments: { content: text, ...(supplied ? { date: supplied } : {}) } });
        const result = await plugin.submitAgentMessage(`请${item.intent}，日期${supplied || "今天"}：${text}`, [], { source, selfTest: true });
        expect(fixed).toHaveBeenCalledOnce(); expect(result.reply).toContain("读回校验");
        const fresh = new LifeOpsStore(plugin.app, plugin.settings) as unknown as StoreHost;
        expect(await fresh.readPath(path)).toContain(original); expect(await fresh.readPath(path)).toContain(text);
        expect(await fresh.readPath(dated)).toContain(path.replace(/\.md$/, ""));
        expect(await vault.bytes(store.dailyNotePath("2026-01-01", "晚"))).toBe(diary);
        if (expected !== "2026-01-01") expect(store.getFile(store.path(folder, "每日记录", "2026-01-01.md"))).toBeNull();
        await plugin.undoLatestLifeOpsOperation(); expect(await vault.bytes(path)).toBe(original); expect(store.getFile(dated) ? await vault.bytes(dated) : null).toBe(before);
      }
    });
    it.each(["2026-02-30", "2026-13-01", "2025-02-29", "上一周某天", "2026-01-00"])(`${item.tool} refuses supplied invalid date %s without business writes`, async date => {
      const folder = store.settings.folders[item.folder], path = store.path(folder, item.note);
      const append = vi.spyOn(store, item.folder === "ideas" ? "appendKnowledgeNote" : "appendTradingModelNote");
      const result = await plugin.createAgentRuntime().executeToolCall({ callId: `fictional-invalid-${item.folder}-${date}`, toolName: item.tool, source: "kimi", arguments: { content: "纯虚构不可落错日期", date }, userMessage: `请${item.intent}，日期${date}：纯虚构不可落错日期` });
      expect(result.success).toBe(false); expect(result.output).toMatch(/日期.*无法识别|日期.*不存在/); expect(append).not.toHaveBeenCalled();
      expect(await vault.bytes(path)).toBe(original); expect(store.getFile(store.path(folder, "每日记录", `${date}.md`))).toBeNull();
      expect(store.getFile(store.path(folder, "每日记录", "2026-01-01.md"))).toBeNull(); expect(await vault.bytes(store.dailyNotePath("2026-01-01", "晚"))).toBe(diary);
    });
  }
});
