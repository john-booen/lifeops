import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { setProviderEgressSink } from "../src/privacy";
vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/"), setIcon: vi.fn(), requestUrl: vi.fn()
}));
const { default: LifeOpsPlugin } = await import("../src/main");
let root: string, path: string, plugin: any;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-settings-receipt-")); path = join(root, "data.json");
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.vision.model = "qwen-vl-plus";
  await writeFile(path, JSON.stringify(settings));
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), {
    settings, app: { vault: {}, workspace: { getLeavesOfType: () => [] } }, lifecycleGeneration: 1,
    lifecycleDisposed: false, unloaded: false, visionSettingsGeneration: 0, backgroundWorkSelection: 0,
    activeProviderRequests: new Set(), activeVoiceRequests: new Set(),
    proactiveLifecycle: { setEnabled: vi.fn() },
    saveData: vi.fn(async (value: unknown) => { await writeFile(path, JSON.stringify(value)); }),
    hardenPluginDataPermissions: vi.fn(async () => {}), updateStatusBar: vi.fn(async () => {})
  });
});
afterEach(async () => { setProviderEgressSink(null); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
describe("original settings persistence receipt", () => {
  it("does not emit a receipt or write after the owner has unloaded", async () => {
    const before = await readFile(path, "utf8"), received = vi.fn(); plugin.unloaded = true;
    await plugin.saveSettings({ onPersisted: received });
    expect(received).not.toHaveBeenCalled(); expect(plugin.saveData).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe(before);
  });
  it("notifies exactly after the actual file write and before presentation", async () => {
    const received: string[] = [];
    plugin.settings.vision.model = "qwen3.7-flash";
    plugin.updateStatusBar.mockImplementation(async () => { received.push("presentation"); });
    await plugin.saveSettings({ onPersisted: () => {
      expect(plugin.saveData).toHaveBeenCalledOnce();
      received.push("persisted");
    } });
    expect(JSON.parse(await readFile(path, "utf8")).vision.model).toBe("qwen3.7-flash");
    expect(received).toEqual(["persisted", "presentation"]);
  });
  it("never reports persistence after a pre-write rejection", async () => {
    const before = await readFile(path, "utf8"), received = vi.fn();
    plugin.settings.vision.model = "qwen3.7-flash";
    plugin.saveData.mockRejectedValueOnce(new Error("fictional pre-write failure"));
    await expect(plugin.saveSettings({ onPersisted: received })).rejects.toThrow("fictional pre-write failure");
    expect(received).not.toHaveBeenCalled(); expect(await readFile(path, "utf8")).toBe(before);
  });
  it("retains the write receipt when a later presentation step rejects", async () => {
    const received = vi.fn(); plugin.settings.vision.model = "qwen3.7-flash";
    plugin.updateStatusBar.mockRejectedValueOnce(new Error("fictional presentation failure"));
    await expect(plugin.saveSettings({ onPersisted: received })).rejects.toThrow("fictional presentation failure");
    expect(received).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(path, "utf8")).vision.model).toBe("qwen3.7-flash");
  });
  it("reports a completed write even if the owner is unloaded before presentation", async () => {
    const received = vi.fn(), original = plugin.saveData.getMockImplementation();
    plugin.saveData.mockImplementationOnce(async (value: unknown) => { await original(value); plugin.lifecycleGeneration++; });
    await plugin.saveSettings({ onPersisted: received });
    expect(received).toHaveBeenCalledOnce(); expect(plugin.updateStatusBar).not.toHaveBeenCalled();
  });
  it("remains compatible with callers that do not request a receipt", async () => {
    await expect(plugin.saveSettings()).resolves.toBeUndefined();
    expect(plugin.saveData).toHaveBeenCalledOnce(); expect(plugin.updateStatusBar).toHaveBeenCalledOnce();
  });
});
