import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { localRecordNotePath, type LocalRecordKind } from "../src/localRecordNotes";
import type { StoreHost } from "../src/store/settingsSlice";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true },
  Notice: class { constructor(message: string) { notices.push(message); } },
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(),
  requestUrl: vi.fn(() => { throw new Error("Provider forbidden in local writing"); })
}));
const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");

let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: InstanceType<typeof LifeOpsPlugin>;
let openFile = vi.fn(async (..._args: unknown[]) => {});
beforeEach(async () => {
  notices.length = 0;
  root = await mkdtemp(join(tmpdir(), "lifeops-record-entry-"));
  vault = new DiskVault(root);
  openFile = vi.fn(async (..._args: unknown[]) => {});
  const app = { vault, workspace: { getLeaf: vi.fn(() => ({ openFile })) } } as unknown as App;
  const settings = structuredClone(DEFAULT_SETTINGS);
  store = new LifeOpsStore(app, settings) as unknown as StoreHost;
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), {
    app, store, settings, refreshViews: vi.fn(async () => {}), manifest: { id: "lifeops-assistant" }
  });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("local writing through the production plugin entry", () => {
  it.each(["morning", "evening", "trading-review"] as LocalRecordKind[])("creates %s and opens the exact file in editing mode", async kind => {
    await plugin.openLocalRecordNote(kind, "2026-09-14");
    const path = localRecordNotePath(store, { kind, date: "2026-09-14" });
    expect(openFile).toHaveBeenCalledWith(store.getFile(path), { state: { mode: "source" } });
    expect(await vault.bytes(path)).toContain("2026-09-14");
    expect(notices).toEqual([]);
  });

  it("reopens handwritten content with zero writes, including zero ledger writes", async () => {
    const date = "2026-09-13", path = store.dailyNotePath(date, "晚");
    const content = "# 昨晚的日记\r\n\r\n保持这段手写内容和格式。  \r\n";
    await vault.seed(path, content);
    await plugin.openLocalRecordNote("evening", date);
    await plugin.openLocalRecordNote("evening", date);
    expect(await vault.bytes(path)).toBe(content);
    expect(vault.writes).toEqual([]);
    expect(openFile).toHaveBeenCalledTimes(2);
  });

  it("invalid input does not reach files, ledger, or editor", async () => {
    await expect(plugin.openLocalRecordNote("morning", "2026-02-30")).rejects.toThrow("记录没有打开");
    expect(vault.writes).toEqual([]);
    expect(openFile).not.toHaveBeenCalled();
  });

  it("a failed save never opens a phantom document", async () => {
    const path = store.tradingReviewPath("2026-09-14"), create = vault.create.bind(vault);
    vi.spyOn(vault, "create").mockImplementation(async (target, content) => {
      if (target === path) throw new Error("disk unavailable");
      return create(target, content);
    });
    await expect(plugin.openLocalRecordNote("trading-review", "2026-09-14")).rejects.toThrow();
    expect(store.getFile(path)).toBeNull();
    expect(openFile).not.toHaveBeenCalled();
    expect(notices.at(-1)).toContain("记录没有打开");
  });

  it("retrying after an editor failure preserves the created note and adds no write", async () => {
    openFile.mockRejectedValueOnce(new Error("editor unavailable"));
    await expect(plugin.openLocalRecordNote("morning", "2026-09-14")).rejects.toThrow();
    const path = store.dailyNotePath("2026-09-14", "早");
    const before = await vault.bytes(path), count = vault.writes.length;
    await plugin.openLocalRecordNote("morning", "2026-09-14");
    expect(await vault.bytes(path)).toBe(before);
    expect(vault.writes).toHaveLength(count);
    expect(openFile).toHaveBeenCalledTimes(2);
  });

  it("closing the picker during creation suppresses the late editor navigation", async () => {
    let current = true;
    const path = store.dailyNotePath("2026-09-14", "早"), create = vault.create.bind(vault);
    vi.spyOn(vault, "create").mockImplementation(async (target, content) => {
      const result = await create(target, content);
      if (target === path) current = false;
      return result;
    });
    await plugin.openLocalRecordNote("morning", "2026-09-14", () => current);
    expect(store.getFile(path)).not.toBeNull();
    expect(openFile).not.toHaveBeenCalled();
  });

  it("an already closed picker does not create a note", async () => {
    await plugin.openLocalRecordNote("morning", "2026-09-14", () => false);
    expect(vault.writes).toEqual([]);
    expect(openFile).not.toHaveBeenCalled();
  });
});
