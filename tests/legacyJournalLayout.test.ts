import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewLegacyJournalLayout } from "../src/legacyJournalLayout";
import { fileRevision } from "../src/dataFoundation/factOperation";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentRuntime } from "../src/agentRuntime";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({ App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(),
  requestUrl: () => { throw Error("Provider forbidden in local layout maintenance"); }
}));
const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const date = "2026-09-15";
const headings = ["今日主题", "晨间计划", "待办", "已完成", "打卡", "健康", "交易", "灵感", "日记"];
const body = "\n  合成正文：保留空格、标点、emoji🌿和组合字e\u0301。\r\n\t第二行。  \n\n## 正文原有标题\n结尾不补换行";
function prefix(newline = "\n", day = date) { return [`# ${day}早`, ...headings.map(h => `## ${h}`)].join(newline + newline) + newline; }
const source = (newline = "\n") => prefix(newline) + body;

describe("pure exact legacy morning layout preview", () => {
  it.each(["\n", "\r\n"])("removes only the 19-line empty prefix (%j) and preserves every body byte", newline => {
    const raw = source(newline), result = previewLegacyJournalLayout(`${date}早.md`, raw);
    expect(prefix(newline).split(newline).at(-2)).toBe("## 日记");
    expect(prefix(newline).split(newline)).toHaveLength(20);
    expect(result.eligible).toBe(true);
    if (!result.eligible) throw Error(result.reason);
    expect(Buffer.from(result.content)).toEqual(Buffer.from(body));
    expect(result.beforeHash).toBe(fileRevision(raw)); expect(result.afterHash).toBe(fileRevision(body));
    expect(result.removedPrefixBytes).toBe(Buffer.byteLength(prefix(newline)));
  });
  it("preserves a body beginning immediately after the final heading newline", () => {
    const result = previewLegacyJournalLayout(`${date}早.md`, prefix() + "正文第一字不可删除。");
    expect(result).toMatchObject({ eligible: true, content: "正文第一字不可删除。" });
  });
  it.each(headings.slice(0, -1))("rejects any content in the %s section", heading => {
    const raw = source().replace(`## ${heading}\n\n`, `## ${heading}\n不可丢弃的原始记录\n`);
    expect(previewLegacyJournalLayout(`${date}早.md`, raw).eligible).toBe(false);
  });
  it.each([
    ["frontmatter", "---\nauthor: 合成\n---\n" + source()],
    ["BOM", "\uFEFF" + source()],
    ["leading whitespace", "\n" + source()],
    ["missing section", source().replace("## 健康\n\n", "")],
    ["extra blank", source().replace("## 健康\n\n", "## 健康\n\n\n")],
    ["changed heading", source().replace("## 打卡", "## 习惯打卡")],
    ["mixed prefix newlines", source().replace("## 健康\n", "## 健康\r\n")],
    ["wrong title date", source().replace(`# ${date}早`, "# 2026-09-16早")],
    ["wrong title period", source().replace(`# ${date}早`, `# ${date}晚`)],
    ["empty body", prefix()],
    ["plain body", body]
  ])("rejects %s without attempting a fuzzy template removal", (_label, raw) => {
    expect(previewLegacyJournalLayout(`${date}早.md`, raw).eligible).toBe(false);
  });
  it.each([`${date}晚.md`, "2026-02-30早.md", `${date}早副本.md`])("rejects unsupported date/period filename %s", path => {
    expect(previewLegacyJournalLayout(path, source()).eligible).toBe(false);
  });
});

let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: InstanceType<typeof LifeOpsPlugin>, path: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-legacy-layout-")); vault = new DiskVault(root);
  const settings = structuredClone(DEFAULT_SETTINGS), app = { vault } as any;
  store = new LifeOpsStore(app, settings) as unknown as StoreHost;
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), { app, store, settings, refreshViews: vi.fn(async () => {}) });
  path = store.dailyNotePath(date, "早");
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("explicit local legacy layout maintenance on real temporary files", () => {
  it("performs one guarded source write, reads back, and keeps a verified undo record", async () => {
    const raw = source(); await vault.seed(path, raw); await vault.seed("日记/邻近原文.md", "旁边的合成原文不得改变");
    const result = await plugin.normalizeLegacyJournalLayout(path, fileRevision(raw));
    expect(result).toMatchObject({ path, changed: true, beforeHash: fileRevision(raw), afterHash: fileRevision(body) });
    expect(Buffer.from(await vault.bytes(path))).toEqual(Buffer.from(body));
    expect(await vault.bytes("日记/邻近原文.md")).toBe("旁边的合成原文不得改变");
    const ledger = await store.readJson<any>(store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json"), { records: [] });
    const record = ledger.records.find((r: any) => r.operationId === result.operationId);
    expect(record.status).toBe("verified"); expect(record.arguments).toEqual({ path, expectedHash: fileRevision(raw) });
    expect(record.result.undo).toMatchObject({ kind: "restore_guarded_files", files: [{ path, before: raw, after: body }] });
    expect(record.result.undo.files).toHaveLength(1);
    expect(vault.writes.filter(write => write.path === path)).toHaveLength(1);
  });
  it("retries the same explicit path/hash with zero further writes", async () => {
    const raw = source(); await vault.seed(path, raw);
    const first = await plugin.normalizeLegacyJournalLayout(path, fileRevision(raw)), count = vault.writes.length;
    const second = await plugin.normalizeLegacyJournalLayout(path, fileRevision(raw));
    expect(second).toMatchObject({ operationId: first.operationId, changed: false, afterHash: first.afterHash });
    expect(vault.writes).toHaveLength(count); expect(await vault.bytes(path)).toBe(body);
  });
  it("rejects malformed layout before creating any ledger or recovery writes", async () => {
    const raw = source().replace("## 待办\n\n", "## 待办\n原任务内容\n"); await vault.seed(path, raw);
    await expect(plugin.normalizeLegacyJournalLayout(path, fileRevision(raw))).rejects.toThrow("未完整匹配");
    expect(await vault.bytes(path)).toBe(raw); expect(vault.writes).toEqual([]);
  });
  it("refuses the later current hash of an already plain body rather than pretending it is a legacy template", async () => {
    await vault.seed(path, body);
    await expect(plugin.normalizeLegacyJournalLayout(path, fileRevision(body))).rejects.toThrow("未完整匹配");
    expect(await vault.bytes(path)).toBe(body); expect(vault.writes).toEqual([]);
  });
  it("rejects a stale preview hash and preserves the later edit", async () => {
    const raw = source(), edited = raw + "\n预览后手写"; await vault.seed(path, edited);
    await expect(plugin.normalizeLegacyJournalLayout(path, fileRevision(raw))).rejects.toThrow("预览后发生变化");
    expect(await vault.bytes(path)).toBe(edited); expect(vault.writes.some(write => write.path === path)).toBe(false);
  });
  it("rejects a race at the actual source write without replacing concurrent input", async () => {
    const raw = source(), edited = raw + "\n并发手写"; await vault.seed(path, raw);
    const original = vault.process.bind(vault); let raced = false;
    vi.spyOn(vault, "process").mockImplementation(async (file, update) => {
      if (file.path === path && !raced) { raced = true; await vault.seed(path, edited); }
      return original(file, update);
    });
    await expect(plugin.normalizeLegacyJournalLayout(path, fileRevision(raw))).rejects.toThrow();
    expect(raced).toBe(true); expect(await vault.bytes(path)).toBe(edited);
  });
  it("refuses a cached success when the normalized source was edited later", async () => {
    const raw = source(); await vault.seed(path, raw); await plugin.normalizeLegacyJournalLayout(path, fileRevision(raw));
    const edited = body + "\n后续手写"; await vault.seed(path, edited); const count = vault.writes.length;
    await expect(plugin.normalizeLegacyJournalLayout(path, fileRevision(raw))).rejects.toThrow("又发生变化");
    expect(await vault.bytes(path)).toBe(edited); expect(vault.writes).toHaveLength(count);
  });
  it("does not follow a TFile renamed while the scoped source is being read", async () => {
    const raw = source(), moved = store.dailyNotePath("2026-09-16", "早"); await vault.seed(path, raw);
    const read = vault.read.bind(vault); let count = 0, renamed = false;
    vi.spyOn(vault, "read").mockImplementation(async file => {
      const value = await read(file);
      if (file.path === path && ++count === 2) { renamed = true; await vault.rename(file, moved); }
      return value;
    });
    await expect(plugin.normalizeLegacyJournalLayout(path, fileRevision(raw))).rejects.toThrow();
    expect(renamed).toBe(true); expect(store.getFile(path)).toBeNull();
    expect(await vault.bytes(moved)).toBe(raw);
  });
  it("does not normalize a renamed file at the final native process boundary", async () => {
    const raw = source(), moved = store.dailyNotePath("2026-09-16", "早"); await vault.seed(path, raw);
    const process = vault.process.bind(vault); let renamed = false;
    vi.spyOn(vault, "process").mockImplementation(async (file, update) => {
      if (file.path === path && !renamed) { renamed = true; await vault.rename(file, moved); }
      return process(file, update);
    });
    await expect(plugin.normalizeLegacyJournalLayout(path, fileRevision(raw))).rejects.toThrow();
    expect(renamed).toBe(true); expect(store.getFile(path)).toBeNull();
    expect(await vault.bytes(moved)).toBe(raw);
  });
  it("restores every original byte on undo and never automatically reapplies a reverted operation", async () => {
    const raw = source("\r\n"); await vault.seed(path, raw);
    const result = await plugin.normalizeLegacyJournalLayout(path, fileRevision(raw));
    const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    await runtime.undoOperation(result.operationId);
    expect(Buffer.from(await vault.bytes(path))).toEqual(Buffer.from(raw));
    const count = vault.writes.length;
    await expect(plugin.normalizeLegacyJournalLayout(path, fileRevision(raw))).rejects.toThrow("已经撤销");
    expect(vault.writes).toHaveLength(count);
  });
  it("blocks undo after a later handwritten edit and preserves that edit", async () => {
    const raw = source(); await vault.seed(path, raw);
    const result = await plugin.normalizeLegacyJournalLayout(path, fileRevision(raw));
    const edited = body + "\n撤销前手写"; await vault.seed(path, edited);
    const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    await expect(runtime.undoOperation(result.operationId)).rejects.toThrow();
    expect(await vault.bytes(path)).toBe(edited);
  });
  it.each(["../2026-09-15早.md", "LifeOps/Knowledge/2026-09-15早.md", "LifeOps/Journal/../2026-09-15早.md"])("rejects a nonmanaged/external path %s without writes", async target => {
    await expect(plugin.normalizeLegacyJournalLayout(target, fileRevision(source()))).rejects.toThrow("准确路径");
    expect(vault.writes).toEqual([]);
  });
  it("respects explicit privacy exclusions and does not create missing files", async () => {
    await vault.seed(path, source()); store.settings.privacy = { ...DEFAULT_SETTINGS.privacy!, excludedVaultPrefixes: [path] };
    await expect(plugin.normalizeLegacyJournalLayout(path, fileRevision(source()))).rejects.toThrow("准确路径");
    store.settings.privacy.excludedVaultPrefixes = [];
    await expect(plugin.normalizeLegacyJournalLayout(store.dailyNotePath("2026-09-16", "早"), fileRevision(source()))).rejects.toThrow("不存在");
    expect(vault.writes).toEqual([]);
  });
});
