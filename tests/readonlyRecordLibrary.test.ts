import { link, mkdtemp, rm, symlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App, CachedMetadata, TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import { createReadonlyRecordLibrary } from "../src/readonlyRecordLibrary";

vi.mock("obsidian", () => ({
  App: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
let ownerActive: boolean, openFile: ReturnType<typeof vi.fn<(file: TFile, signal: AbortSignal) => Promise<void>>>;
let cache: Map<string, CachedMetadata>;
const source = "LifeOps/Knowledge/Ideas/原文.md", target = "LifeOps/Inbox/来源.md";
const id = (path: string) => `record:${path}`;
const options = () => ({ signal: new AbortController().signal });
const library = () => createReadonlyRecordLibrary(store, openFile, () => { if (!ownerActive) throw Error("closed"); });
const list = (adapter: ReturnType<typeof library>, domain: "all" | "life" = "all") => adapter.list({ domain, ...options() });
function setLink(path: string, body: string, link: string, original = `[[${link}]]`) {
  const start = body.indexOf(original);
  cache.set(path, { links: [{ link, original, position: {
    start: { line: 0, col: start, offset: start }, end: { line: 0, col: start + original.length, offset: start + original.length }
  } }] });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-record-library-")); vault = new DiskVault(root);
  Object.assign(vault, { adapter: { getBasePath: () => root } });
  cache = new Map(); ownerActive = true; openFile = vi.fn(async () => {});
  const app = { vault, metadataCache: { getFileCache: (file: TFile) => cache.get(file.path) ?? null } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("read-only records on real temporary Vault files", () => {
  it("lists only configured, allowed Markdown metadata without reading or writing bodies", async () => {
    for (const path of [source, target, "LifeOps/Output/AI/Operations/secret.md", "LifeOps/Output/AI/Desktop/state.md",
      "未管理/外部.md", ".obsidian/配置.md", "LifeOps/Inbox/.hidden.md", "LifeOps/Inbox/排除/秘密.md"])
      await vault.seed(path, "原文保持");
    store.settings.privacy!.excludedVaultPrefixes = ["LifeOps/Inbox/排除"];
    const read = vi.spyOn(vault, "read"), cached = vi.spyOn(vault, "cachedRead");
    const adapter = library(), rows = await list(adapter);
    expect(rows.map(row => row.path).sort()).toEqual([source, target].sort());
    expect(read).not.toHaveBeenCalled(); expect(cached).not.toHaveBeenCalled(); expect(vault.writes).toEqual([]);
    expect(rows.find(row => row.path === source)).toMatchObject({ id: id(source), title: "原文", domain: "learning", kind: "note" });
    expect(rows[0].updatedAt).toBeDefined(); expect(rows[0].date).toBeUndefined();
    rows[0].path = "LifeOps/Inbox/伪造.md";
    expect((await list(adapter)).some(row => row.path === "LifeOps/Inbox/伪造.md")).toBe(false);
  });

  it("uses the most specific configured domain and only known record filename dates", async () => {
    const paths = ["LifeOps/Goals/Tasks/安排.md", "LifeOps/Goals/Habits/打卡.md", "LifeOps/Goals/项目.md",
      "LifeOps/Journal/2024/02/2024-02-29早.md", "LifeOps/Journal/2026/02/2026-02-29晚.md", "LifeOps/TradeReview/2026/10月/2026-10-23.md"];
    for (const path of paths) await vault.seed(path, "正文");
    const rows = await list(library());
    expect(rows.find(row => row.path === paths[0])?.domain).toBe("tasks");
    expect(rows.find(row => row.path === paths[1])?.domain).toBe("tasks");
    expect(rows.find(row => row.path === paths[2])?.domain).toBe("projects");
    expect(rows.find(row => row.path === paths[3])).toMatchObject({ date: "2024-02-29", kind: "morning" });
    expect(rows.find(row => row.path === paths[4])?.date).toBeUndefined();
    expect(rows.find(row => row.path === paths[5])).toMatchObject({ date: "2026-10-23", kind: "review", domain: "trading" });
  });

  it("reads the selected complete raw note exactly once with no file or ledger write", async () => {
    const raw = "---\r\n字段: 保留\r\n---\r\n# 原文\r\n长中文\r\n" + "完整文字。".repeat(3000);
    await vault.seed(source, raw); await vault.seed(target, "不能顺带读取");
    const adapter = library(); await list(adapter); const read = vi.spyOn(vault, "read");
    expect((await adapter.read(id(source), options())).body).toBe(raw);
    expect(read.mock.calls.map(([file]) => file.path)).toEqual([source]);
    expect(vault.writes).toEqual([]); expect(await vault.bytes(source)).toBe(raw);
  });

  it.each(["LifeOps/Inbox/新建.md", "../外部.md", "/tmp/外部.md", "LifeOps/Inbox/../来源.md"])("rejects unissued or forged ID %s without body IO or creation", async path => {
    await vault.seed(source, "原文"); const adapter = library(); await list(adapter);
    const read = vi.spyOn(vault, "read");
    await expect(adapter.read(id(path), options())).rejects.toThrow();
    await expect(adapter.open(id(path), options())).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(openFile).not.toHaveBeenCalled(); expect(vault.writes).toEqual([]);
  });

  it("rejects an ID from a prior domain, and never opens a removed file or recreates it", async () => {
    await vault.seed(source, "原文"); await vault.seed(target, "来源"); const adapter = library(); await list(adapter);
    await list(adapter, "life"); await expect(adapter.read(id(source), options())).rejects.toThrow();
    await vault.delete(store.getFile(target)!); const writes = vault.writes.length;
    await expect(adapter.open(id(target), options())).rejects.toThrow();
    expect(vault.writes).toHaveLength(writes); expect(openFile).not.toHaveBeenCalled();
  });

  it("revalidates current exclusions, configured roots and ownership after listing", async () => {
    await vault.seed(source, "原文"); const adapter = library(); await list(adapter);
    store.settings.privacy!.excludedVaultPrefixes = ["LifeOps/Knowledge"];
    await expect(adapter.read(id(source), options())).rejects.toThrow();
    store.settings.privacy!.excludedVaultPrefixes = []; store.settings.folders.ideas = "换了目录";
    await expect(adapter.open(id(source), options())).rejects.toThrow();
    ownerActive = false; await expect(list(adapter)).rejects.toThrow("closed"); expect(openFile).not.toHaveBeenCalled();
  });


  it("rejects an owner, permission or cancellation change while awaiting a body", async () => {
    await vault.seed(source, "原文"); const adapter = library(); await list(adapter);
    const original = vault.read.bind(vault), abort = new AbortController();
    vi.spyOn(vault, "read").mockImplementationOnce(async file => { const raw = await original(file); abort.abort(); return raw; });
    await expect(adapter.read(id(source), { signal: abort.signal })).rejects.toThrow();
    vi.spyOn(vault, "read").mockImplementationOnce(async file => { const raw = await original(file); store.settings.privacy!.excludedVaultPrefixes = ["个人知识库"]; return raw; });
    await expect(adapter.read(id(source), options())).rejects.toThrow();
    expect(vault.writes).toEqual([]);
  });

  it("includes only an exact current explicit link whose cached offsets match raw text", async () => {
    const raw = `# 原文\n[[${target}]]`; await vault.seed(source, raw); await vault.seed(target, "来源"); setLink(source, raw, target);
    const adapter = library(); await list(adapter);
    expect((await adapter.read(id(source), options())).relations).toEqual([{ id: id(target), path: target, title: "来源", kind: "link" }]);
    setLink(source, raw, "来源", `[[来源]]`);
    expect((await adapter.read(id(source), options())).relations).toEqual([]);
    setLink(source, raw, "https://invalid.example/key", raw);
    expect((await adapter.read(id(source), options())).relations).toEqual([]);
    expect(openFile).not.toHaveBeenCalled(); expect(vault.writes).toEqual([]);
  });

  it("opens a verified relation only after re-reading the current selected source", async () => {
    const raw = `[[${target}]]`; await vault.seed(source, raw); await vault.seed(target, "来源"); setLink(source, raw, target);
    const adapter = library(); await list(adapter); await adapter.read(id(source), options());
    const read = vi.spyOn(vault, "read"); await adapter.openRelation(id(source), id(target), options());
    expect(read.mock.calls.map(([file]) => file.path)).toEqual([source]); expect(openFile.mock.calls[0][0].path).toBe(target);
    expect(vault.writes).toEqual([]);
  });

  it("repeatedly rejects a changed relation source until the user explicitly reselects it", async () => {
    const raw = `[[${target}]]`; await vault.seed(source, raw); await vault.seed(target, "来源"); setLink(source, raw, target);
    const adapter = library(); await list(adapter); await adapter.read(id(source), options());
    await vault.seed(source, `${raw}\n新正文`);
    await expect(adapter.openRelation(id(source), id(target), options())).rejects.toThrow(/变化/);
    await expect(adapter.openRelation(id(source), id(target), options())).rejects.toThrow(/变化/);
    expect(openFile).not.toHaveBeenCalled();
  });

  it("blocks a late relation open after record selection or page lifetime changes", async () => {
    const raw = `[[${target}]]`; await vault.seed(source, raw); await vault.seed(target, "来源"); setLink(source, raw, target);
    const adapter = library(); await list(adapter); await adapter.read(id(source), options());
    const original = vault.read.bind(vault), abort = new AbortController();
    vi.spyOn(vault, "read").mockImplementationOnce(async file => { const body = await original(file); abort.abort(); return body; });
    await expect(adapter.openRelation(id(source), id(target), { signal: abort.signal })).rejects.toThrow();
    await expect(adapter.openRelation(id(source), id(target), { ...options(), assertCurrent: () => { throw Error("changed selection"); } })).rejects.toThrow("changed selection");
    expect(openFile).not.toHaveBeenCalled();
  });


  it("uses only the original open callback and rejects pre-aborted ordinary opens", async () => {
    await vault.seed(source, "原文"); const adapter = library(); await list(adapter);
    const abort = new AbortController(); abort.abort();
    await expect(adapter.open(id(source), { signal: abort.signal })).rejects.toThrow();
    await adapter.open(id(source), options()); expect(openFile).toHaveBeenCalledTimes(1);
    expect(openFile.mock.calls[0][0].path).toBe(source); expect(vault.writes).toEqual([]);
  });

  it.each(["私人排除/秘密.md", "LifeOps/Output/AI/秘密.md", "LifeOps/Inbox/.hidden/秘密.md"])("rejects a native file alias into %s before any body IO", async hidden => {
    await vault.seed(hidden, "FICTIONAL_EXCLUDED_BODY"); await vault.seed(source, "原文");
    store.settings.privacy!.excludedVaultPrefixes = ["私人排除"];
    const alias = "LifeOps/Knowledge/Ideas/alias.md";
    await symlink(vault.diskPath(hidden), vault.diskPath(alias));
    const adapter = library(), read = vi.spyOn(vault, "read");
    expect((await list(adapter)).some(row => row.path === alias)).toBe(false);
    await expect(adapter.read(id(alias), options())).rejects.toThrow();
    await expect(adapter.open(id(alias), options())).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(openFile).not.toHaveBeenCalled();
  });

  it("rejects directory aliases and hardlinked files even inside allowed roots", async () => {
    await vault.seed(source, "原文"); await vault.seed(target, "来源");
    const hard = "LifeOps/Knowledge/Ideas/hard.md", alias = "LifeOps/Knowledge/Ideas/dir/来源.md";
    await link(vault.diskPath(target), vault.diskPath(hard));
    await symlink(vault.diskPath("LifeOps/Inbox"), vault.diskPath("LifeOps/Knowledge/Ideas/dir"));
    const getFiles = vault.getMarkdownFiles.bind(vault);
    vi.spyOn(vault, "getMarkdownFiles").mockImplementation(() => [...getFiles(), vault.getFileByPath(alias)!]);
    const adapter = library(), read = vi.spyOn(vault, "read");
    const rows = await list(adapter); expect(rows.map(row => row.path)).toEqual([source]);
    await expect(adapter.read(id(hard), options())).rejects.toThrow();
    await expect(adapter.open(id(alias), options())).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(openFile).not.toHaveBeenCalled();
  });

  it("rejects a source replaced by an excluded alias after listing", async () => {
    await vault.seed(source, "原文"); await vault.seed("私人排除/秘密.md", "FICTIONAL_EXCLUDED_BODY");
    store.settings.privacy!.excludedVaultPrefixes = ["私人排除"];
    const adapter = library(); await list(adapter);
    await rm(vault.diskPath(source)); await symlink(vault.diskPath("私人排除/秘密.md"), vault.diskPath(source));
    const read = vi.spyOn(vault, "read");
    await expect(adapter.read(id(source), options())).rejects.toThrow();
    await expect(adapter.open(id(source), options())).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(openFile).not.toHaveBeenCalled();
  });
});
