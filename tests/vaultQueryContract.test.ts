import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { executeVaultQuery, readVaultQueryWithSources, vaultQueryReadCoverage } from "../src/vaultQuery";
import { preparedContextSourcePaths } from "./helpers/sourceReferences";
import { createPersonalMemory, emptyPersonalMemoryDocument, reviewPersonalMemoryRecord } from "../src/personalMemory";
import { AgentRuntime } from "../src/agentRuntime";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  requestUrl: () => { throw new Error("Network forbidden in query contract tests"); }
}));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-query-contract-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as any, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("query_vault contract on a real temporary synthetic Vault", () => {
  it("explains unsupported catalog pagination instead of reporting a permission change", async () => {
    const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    const result = await runtime.executeToolCall({ toolName: "query_vault", callId: "fictional-invalid-list-page", source: "kimi",
      arguments: { domain: "journal", operation: "list", limit: 12, offset: 12 } });
    expect(result.success).toBe(false); expect(result.actions).toEqual([]);
    expect(result.output).toContain("原文分页"); expect(result.output).toContain("准确 path");
    expect(result.output).not.toContain("权限刚刚变化");
  });
  it("reads the requested diary week instead of silently reducing it to its anchor date", async () => {
    for (const [date, text] of [["2026-11-01", "虚构前周"], ["2026-11-02", "虚构周一原话"],
      ["2026-11-04", "虚构周三原话"], ["2026-11-08", "虚构周日原话"], ["2026-11-09", "虚构后周"]]) {
      await vault.seed(store.dailyNotePath(date, "晚"), text);
    }
    const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    const result = await runtime.executeToolCall({ toolName: "query_vault", callId: "fictional-invalid-diary-range", source: "kimi",
      arguments: { domain: "journal", operation: "get", date: "2026-11-04", range: "week" } });
    expect(result.success, result.output).toBe(true);
    for (const word of ["虚构周一原话", "虚构周三原话", "虚构周日原话"]) expect(result.output).toContain(word);
    expect(result.output).not.toContain("虚构前周"); expect(result.output).not.toContain("虚构后周");
  });
  it("keeps diary week search and listing within the same privacy-filtered dates", async () => {
    for (const date of ["2026-11-01", "2026-11-02", "2026-11-04", "2026-11-08", "2026-11-09"]) {
      await vault.seed(store.dailyNotePath(date, "晚"), "虚构纸样 " + date);
    }
    store.settings.privacy!.excludedVaultPrefixes = [store.dailyNotePath("2026-11-04", "晚")];
    for (const operation of ["search", "list"] as const) {
      const result = await executeVaultQuery(store, { domain: "journal", operation, date: "2026-11-04", range: "week",
        ...(operation === "search" ? { query: "虚构纸样" } : {}), sort: "oldest", limit: 12 });
      expect(result).toContain("2026-11-02晚.md"); expect(result).toContain("2026-11-08晚.md");
      expect(result.indexOf("2026-11-02晚.md")).toBeLessThan(result.indexOf("2026-11-08晚.md"));
      for (const date of ["2026-11-01", "2026-11-04", "2026-11-09"]) expect(result).not.toContain(date + "晚.md");
    }
    await expect(executeVaultQuery(store, { domain: "journal", operation: "get", date: "2026-11-04", range: "week",
      path: store.dailyNotePath("2026-11-09", "晚") })).rejects.toThrow("不匹配");
  });
  it("uses today's date for an unanchored diary range and honors a specific single-day anchor", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 12, 9));
    try {
      for (const date of ["2026-11-02", "2026-11-09", "2026-11-12", "2026-11-15", "2026-11-16"]) {
        await vault.seed(store.dailyNotePath(date, "晚"), "虚构范围 " + date);
      }
      const week = await executeVaultQuery(store, { domain: "journal", operation: "get", range: "week" });
      for (const date of ["2026-11-09", "2026-11-12", "2026-11-15"]) expect(week).toContain(date + "晚.md");
      expect(week).not.toContain("2026-11-02晚.md"); expect(week).not.toContain("2026-11-16晚.md");
      const day = await executeVaultQuery(store, { domain: "journal", operation: "get", date: "2026-11-02", range: "today" });
      expect(day).toContain("2026-11-02晚.md"); expect(day).not.toContain("2026-11-12晚.md");
    } finally { vi.useRealTimers(); }
  });
  it("pages protected raw text with real later-page provenance and reports only the actual interval", async () => {
    const path = store.dailyNotePath("2026-10-06", "晚"), raw = "甲".repeat(20_000) + "FICT-LATER-PAGE";
    await vault.seed(path, raw); const read = await readVaultQueryWithSources(store, { domain: "journal", operation: "get", path, offset: 20_000, maxChars: 500 });
    try {
      expect(read.text).toContain("FICT-LATER-PAGE"); expect(read.text).not.toContain("甲甲"); expect(read.text).toContain("nextOffset: none");
      expect(vaultQueryReadCoverage(read)?.pages).toEqual([{ path, start: 20_000, end: raw.length, total: raw.length }]);
      expect(preparedContextSourcePaths([read.sources], read.text)).toEqual([path]);
      await vault.seed(path, raw + "改变"); await expect(read.assertSourcesCurrent()).rejects.toThrow(/变化/);
    } finally { read.dispose(); }
  });
  it.each([-1, 0.5, "20", Number.NaN, Number.POSITIVE_INFINITY])("rejects unsafe page offset %s rather than guessing", async offset => {
    const read = vi.spyOn(vault, "read");
    await expect(executeVaultQuery(store, { domain: "journal", operation: "get", path: "日记/原文.md", offset: offset as number })).rejects.toThrow("分页"); expect(read).not.toHaveBeenCalled();
  });
  it("does not allow paging to broaden exact source reads or memory authority", async () => {
    for (const input of [
      { domain: "journal", operation: "get", offset: 10 },
      { domain: "journal", operation: "search", path: "日记/原文.md", query: "甲", offset: 10 },
      { domain: "memory", operation: "get", path: "memory.md", offset: 10 }
    ] as const) await expect(executeVaultQuery(store, input)).rejects.toThrow("分页");
  });
  it("reports a limited recent diary catalog without crediting the list as read body", async () => {
    for (let i = 1; i <= 14; i++) await vault.seed(store.dailyNotePath(`2026-09-${String(i).padStart(2, "0")}`, "晚"), "不得当作已阅读的正文。");
    const read = await readVaultQueryWithSources(store, { domain: "journal", operation: "list", limit: 12 });
    try { expect(read.text).toContain("尚有 2 篇未列出"); expect(vaultQueryReadCoverage(read)?.pages).toEqual([]); expect(read.sources.blocks).toEqual([]); } finally { read.dispose(); }
  });
  it("applies forgotten-memory filtering before page offsets and never revives omitted source text", async () => {
    const path = store.dailyNotePath("2026-10-06", "晚"), forgotten = "纯虚构已遗忘的旧状态", record = createPersonalMemory({ kind: "current_state", content: forgotten, sourceRefs: [] });
    await vault.seed(store.personalMemoryPath(), JSON.stringify({ ...emptyPersonalMemoryDocument(), records: reviewPersonalMemoryRecord([record], record.id, { decision: "forget" }) }));
    await vault.seed(path, "甲".repeat(500) + "\n\n" + forgotten + "\n\n" + "FICT-ACTIVE-TAIL");
    const read = await readVaultQueryWithSources(store, { domain: "journal", operation: "get", path, offset: 500, maxChars: 500 });
    try { expect(read.text).not.toContain(forgotten); expect(read.text).toContain("FICT-ACTIVE-TAIL"); expect(preparedContextSourcePaths([read.sources], read.text)).toEqual([path]); } finally { read.dispose(); }
  });
  it("searches historical body text even when the filename has no keyword", async () => {
    const old = store.dailyNotePath("2001-01-02", "晚");
    await vault.seed(old, "合成原文：蓝鲸航线只在正文出现。");
    await vault.seed(store.dailyNotePath("2026-09-28", "早"), "最新日记无匹配。");
    const output = await executeVaultQuery(store, { domain: "journal", operation: "search", query: "蓝鲸航线" });
    expect(output).toContain(old); expect(output).toContain("蓝鲸航线");
  });
  it("reads only an exact journal path and does not enumerate unrelated files", async () => {
    const old = store.dailyNotePath("2001-01-02", "晚");
    await vault.seed(old, "准确的历史原文。");
    await vault.seed(store.dailyNotePath("2026-09-28", "早"), "不能代替指定路径。");
    const enumerate = vi.spyOn(vault, "getMarkdownFiles");
    const output = await executeVaultQuery(store, { domain: "journal", operation: "get", path: old });
    expect(output).toContain("准确的历史原文"); expect(output).not.toContain("不能代替指定路径");
    expect(enumerate).not.toHaveBeenCalled();
  });
  it.each(["journal", "note"] as const)("does not replace a missing %s path with a similar file", async domain => {
    const path = domain === "journal" ? store.dailyNotePath("2026-09-28", "早") : "中文资料/甲/同名.md";
    await vault.seed(path, "不得替代缺失路径的合成正文。");
    const missing = domain === "journal" ? path.replace("28", "27") : "中文资料/乙/同名.md";
    const output = await executeVaultQuery(store, { domain, operation: "get", path: missing });
    expect(output).toContain("没有找到"); expect(output).not.toContain("不得替代");
  });
  it("distinguishes same-name Chinese files with an exact path", async () => {
    await vault.seed("中文资料/甲/同名.md", "甲正文。"); await vault.seed("中文资料/乙/同名.md", "乙正文。");
    const output = await executeVaultQuery(store, { domain: "note", operation: "get", path: "中文资料/甲/同名.md" });
    expect(output).toContain("甲正文"); expect(output).not.toContain("乙正文");
    expect(output).toContain("vault:中文资料/甲/同名.md");
  });
  it.each(["../outside.md", "/absolute.md", "https://example.invalid/x.md", "资料/../目标.md"])("rejects an invalid vault path %s", async path => {
    const read = vi.spyOn(vault, "read");
    await expect(executeVaultQuery(store, { domain: "note", operation: "get", path })).rejects.toThrow("路径无效");
    expect(read).not.toHaveBeenCalled();
  });
  it("applies privacy exclusions to journal get, list, search, and exact paths before reading", async () => {
    const path = store.dailyNotePath("2026-09-27", "晚"); await vault.seed(path, "紫色风铃私密样本。");
    store.settings.privacy = { ...DEFAULT_SETTINGS.privacy!, excludedVaultPrefixes: [path] };
    const read = vi.spyOn(vault, "read");
    for (const operation of ["get", "list", "search"] as const) {
      const output = await executeVaultQuery(store, { domain: "journal", operation, date: "2026-09-27", query: "紫色风铃" });
      expect(output).not.toContain("私密样本");
    }
    await expect(executeVaultQuery(store, { domain: "journal", operation: "get", path })).rejects.toThrow("排除");
    expect(read).not.toHaveBeenCalled();
  });
  it("excludes generated files even when the configured generated directory is below the journal root", async () => {
    store.settings.folders.aiReports = `${store.settings.folders.dailyRoot}/AI生成`;
    const path = `${store.settings.folders.aiReports}/2026-09-27晚.md`; await vault.seed(path, "自动生成的虚构原文。");
    for (const domain of ["journal", "note"] as const) {
      const output = await executeVaultQuery(store, { domain, operation: "search", query: "自动生成" });
      expect(output).not.toContain("虚构原文");
      await expect(executeVaultQuery(store, { domain, operation: "get", path })).rejects.toThrow("排除");
    }
  });
  it("lists metadata without reading any file body and keeps get as one note", async () => {
    await vault.seed("中文资料/甲.md", "合成正文甲。"); await vault.seed("中文资料/乙.md", "合成正文乙。");
    const read = vi.spyOn(vault, "read");
    const list = await executeVaultQuery(store, { domain: "note", operation: "list", limit: 2 });
    expect(list).toContain("中文资料/甲.md"); expect(list).toContain("中文资料/乙.md");
    expect(list).not.toContain("合成正文"); expect(read).not.toHaveBeenCalled();
    const get = await executeVaultQuery(store, { domain: "note", operation: "get" });
    expect(get.match(/- path:/g)).toHaveLength(1); expect(get).toContain("合成正文");
  });
  it("sorts notes by source mtime before limiting and ignores derived indices", async () => {
    await vault.seed("中文资料/旧.md", "排序样本旧。"); await vault.seed("中文资料/新.md", "排序样本新。");
    await utimes(vault.diskPath("中文资料/旧.md"), 100, 100); await utimes(vault.diskPath("中文资料/新.md"), 200, 200);
    const writes = vault.writes.length;
    const oldest = await executeVaultQuery(store, { domain: "note", operation: "search", query: "排序样本", sort: "oldest", limit: 1 });
    const newest = await executeVaultQuery(store, { domain: "note", operation: "search", query: "排序样本", sort: "newest", limit: 1 });
    expect(oldest).toContain("中文资料/旧.md"); expect(newest).toContain("中文资料/新.md");
    expect(vault.writes).toHaveLength(writes); expect(store.getFile(store.vaultIndexPath())).toBeNull();
  });
  it("never falls back from health or trade to ordinary notes", async () => {
    await vault.seed("普通资料/云杉清单.md", "云杉普通笔记正文。");
    for (const domain of ["health", "trade"] as const) {
      expect(await executeVaultQuery(store, { domain, operation: "search", query: "云杉" })).toContain("没有找到");
    }
    await vault.seed(`${store.settings.folders.health}/云杉.md`, "云杉健康记录正文。");
    expect(await executeVaultQuery(store, { domain: "health", operation: "search", query: "云杉" })).toContain("云杉健康记录正文");
  });
  it("discloses blank source bodies and distinguishes no matches and blank searches", async () => {
    const path = store.dailyNotePath("2026-09-27", "晚"); await vault.seed(path, " \n ");
    expect(await executeVaultQuery(store, { domain: "journal", operation: "get", path })).toContain("没有可读取的正文");
    expect(await executeVaultQuery(store, { domain: "journal", operation: "get", date: "2020-01-01" })).toContain("没有找到");
    await expect(executeVaultQuery(store, { domain: "journal", operation: "search", query: "  " })).rejects.toThrow("关键词为空");
  });
  it("rejects unsupported date filters and exact journal path/date conflicts", async () => {
    await expect(executeVaultQuery(store, { domain: "note", operation: "list", date: "2026-09-27" })).rejects.toThrow("仅适用于日记");
    const path = store.dailyNotePath("2026-09-27", "晚"); await vault.seed(path, "不能混淆日期的原文。");
    await expect(executeVaultQuery(store, { domain: "journal", operation: "get", path, date: "2026-09-28" })).rejects.toThrow("不匹配");
  });
  it("shows a distant body match in a clipped excerpt with source evidence", async () => {
    await vault.seed("中文资料/长原文.md", "前".repeat(7000) + "正文深处的蓝鲸关键词" + "后".repeat(1000));
    const output = await executeVaultQuery(store, { domain: "note", operation: "search", query: "蓝鲸关键词", maxChars: 500 });
    expect(output).toContain("蓝鲸关键词"); expect(output).toContain("前文已省略");
    expect(output).toContain("已截断"); expect(output).toContain("vault:中文资料/长原文.md");
    expect(output.length).toBeLessThan(1000);
  });
  it("distinguishes unreadable sources from empty or missing sources", async () => {
    const path = "中文资料/读取失败.md"; await vault.seed(path, "不能误报为空。");
    vault.readFailure = new Error("synthetic read failure");
    const output = await executeVaultQuery(store, { domain: "note", operation: "get", path });
    expect(output).toContain(path); expect(output).toContain("读取失败");
    expect(output).not.toContain("没有可读取的正文"); expect(output).not.toContain("synthetic read failure");
  });
  it("caps history search and explicitly reports the unexamined remainder", async () => {
    // Disk sources exercise the real executor. The final matching file sits just
    // beyond the safety budget; the result must not claim a complete absence.
    for (let index = 0; index < 1001; index += 1) {
      const path = `中文资料/${String(index).padStart(4, "0")}.md`;
      await vault.seed(path, index === 1000 ? "边界外唯一命中。" : "合成无匹配资料。");
      await utimes(vault.diskPath(path), index + 100, index + 100);
    }
    const read = vi.spyOn(vault, "read");
    const output = await executeVaultQuery(store, { domain: "note", operation: "search", query: "唯一命中", sort: "oldest" });
    expect(read).toHaveBeenCalledTimes(1000);
    expect(output).toContain("尚有 1 篇未检查"); expect(output).toContain("不是完整历史清单");
    const exact = await executeVaultQuery(store, { domain: "note", operation: "get", path: "中文资料/1000.md" });
    expect(exact).toContain("边界外唯一命中");
  });
  it("preserves true journal date ordering even after an old note is recently modified", async () => {
    const old = store.dailyNotePath("2001-01-02", "晚"), recent = store.dailyNotePath("2026-09-28", "早");
    await vault.seed(old, "旧日期正文。"); await vault.seed(recent, "新日期正文。");
    await utimes(vault.diskPath(old), 10000, 10000); await utimes(vault.diskPath(recent), 100, 100);
    expect(await executeVaultQuery(store, { domain: "journal", operation: "get" })).toContain(recent);
    expect(await executeVaultQuery(store, { domain: "journal", operation: "get", sort: "oldest" })).toContain(old);
  });
  it("clamps list limits and orders same-time Chinese paths deterministically", async () => {
    for (let index = 0; index < 14; index += 1) {
      const path = `中文资料/${String(index).padStart(2, "0")}.md`;
      await vault.seed(path, "无需读取的正文。"); await utimes(vault.diskPath(path), 100, 100);
    }
    const one = await executeVaultQuery(store, { domain: "note", operation: "list", limit: -1 });
    const twelve = await executeVaultQuery(store, { domain: "note", operation: "list", limit: 99 });
    expect(one.match(/- path:/g)).toHaveLength(1); expect(twelve.match(/- path:/g)).toHaveLength(12);
    expect(one).toContain("中文资料/00.md");
  });
  it("returns structured runtime failure for invalid query parameters", async () => {
    const runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
    for (const [index, arguments_] of [
      { domain: "note", operation: "get", path: "../outside.md" },
      { domain: "journal", operation: "get", date: "2026-02-30" },
      { domain: "note", operation: "search", query: " " }
    ].entries()) {
      const result = await runtime.executeToolCall({ toolName: "query_vault", callId: `invalid-query-${index}`, source: "kimi", arguments: arguments_ });
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/路径无效|日期无效|关键词为空/);
    }
  });
});
