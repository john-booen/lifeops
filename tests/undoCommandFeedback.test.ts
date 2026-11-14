import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentRuntime } from "../src/agentRuntime";
import type { StoreHost } from "../src/store/settingsSlice";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {},
  WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {},
  Platform: { isDesktopApp: true },
  Notice: class { constructor(message: string) { notices.push(message); } },
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  setIcon: vi.fn(),
  requestUrl: vi.fn(() => { throw new Error("Network must not be used by the undo command"); })
}));

const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");

let root: string;
let vault: InstanceType<typeof DiskVault>;
let store: StoreHost;
let runtime: AgentRuntime;
let refreshViews = vi.fn(async () => {});
let plugin: { undoLatestLifeOpsOperation(): Promise<void> };

beforeEach(async () => {
  notices.length = 0;
  root = await mkdtemp(join(tmpdir(), "lifeops-undo-command-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  refreshViews = vi.fn(async () => {});
  runtime = new AgentRuntime({ store, refreshViews });
  // Exercise the production command handler and Runtime on real temporary files,
  // without running plugin onload, creating a window, or starting devices/IPC.
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), { store, refreshViews });
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("undo command feedback through the production handler", () => {
  it("explains a capacity refusal while leaving saved content and WAL unchanged", async () => {
    const path = store.path(store.settings.folders.ideas, "command-capacity.md");
    await vault.seed(path, "original note");
    await runtime.executeLocalOperation("command-fixture", {}, scope => scope.writeFile(path, "saved note"), "command-capacity");
    const ledgerPath = store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
    const document = JSON.parse(await vault.bytes(ledgerPath));
    document.preservedHistoricalExtension = "x".repeat(32 * 1024 * 1024);
    await vault.seed(ledgerPath, JSON.stringify(document));
    const walPath = store.path(store.settings.folders.aiReports, "Operations", "write-recovery.json");
    const wal = await vault.bytes(walPath), audit = await vault.bytes(ledgerPath), writes = vault.writes.length;
    refreshViews.mockClear();
    await plugin.undoLatestLifeOpsOperation();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("安全撤销容量");
    expect(notices[0]).toContain("仍可保存新内容");
    expect(notices[0]).not.toContain("已撤销最近一次写入");
    expect(await vault.bytes(path)).toBe("saved note");
    expect(await vault.bytes(walPath)).toBe(wal);
    expect(await vault.bytes(ledgerPath)).toBe(audit);
    expect(vault.writes).toHaveLength(writes);
    expect(refreshViews).not.toHaveBeenCalled();
  }, 20_000);
  it("reports that there is nothing to undo without refreshing the view", async () => {
    await plugin.undoLatestLifeOpsOperation();
    expect(notices).toEqual(["LifeOps 当前没有可撤销的写入操作"]);
    expect(refreshViews).not.toHaveBeenCalled();
  });

  it("reports success only after the actual saved content has been restored", async () => {
    const path = store.path(store.settings.folders.ideas, "command-success.md");
    await vault.seed(path, "original note");
    const operation = await runtime.executeLocalOperation("command-fixture", {}, scope => scope.writeFile(path, "saved note"), "command-success");
    expect(operation.success).toBe(true);
    await plugin.undoLatestLifeOpsOperation();
    expect(await vault.bytes(path)).toBe("original note");
    expect(notices).toEqual(["LifeOps 已撤销最近一次写入：command-success"]);
    expect(refreshViews).toHaveBeenCalled();
  });

  it("shows a visible failure instead of rejecting silently when a later edit blocks undo", async () => {
    const left = store.path(store.settings.folders.ideas, "command-left.md");
    const right = store.path(store.settings.folders.ideas, "command-right.md");
    await vault.seed(left, "original left");
    await vault.seed(right, "original right");
    const operation = await runtime.executeLocalOperation("command-fixture", {}, async scope => {
      await scope.writeFile(left, "saved left");
      await scope.writeFile(right, "saved right");
    }, "command-conflict");
    expect(operation.success).toBe(true);
    await vault.seed(right, "later user edit must survive");
    refreshViews.mockClear();

    await expect(plugin.undoLatestLifeOpsOperation()).resolves.toBeUndefined();

    expect(await vault.bytes(left)).toBe("saved left");
    expect(await vault.bytes(right)).toBe("later user edit must survive");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/撤销/);
    expect(notices[0]).toMatch(/停止|没有完成|未能|失败/);
    expect(notices[0]).not.toContain("已撤销最近一次写入");
    expect(refreshViews).not.toHaveBeenCalled();
    const ledger = await store.readJson<{ records: Array<{ operationId: string; status: string }> }>(
      store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json"), { records: [] }
    );
    expect(ledger.records.find(record => record.operationId === "command-conflict")?.status).toBe("verified");
  });
});
