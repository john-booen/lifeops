import { stubAgentModel } from "./helpers/stubAgentModel";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: () => { throw Error("Offline fictional task dates"); } }));
const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsStore } = await import("../src/store"), { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: any, originalTask: unknown;
const title = "纯虚构跨年补记待办", diary = "纯虚构手写跨年日记，保留原文。\n";
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 0, 1, 12)); vi.stubGlobal("window", globalThis);
  root = await mkdtemp(join(tmpdir(), "lifeops-task-date-main-")); vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; await store.initializeVault();
  originalTask = await store.createTask({ title: "纯虚构原任务", date: "2026-01-02", quadrant: "important-not-urgent", priority: "high", note: "亲写备注\n保留第二行", source: "manual" });
  await vault.seed(store.dailyNotePath("2026-01-01", "晚"), diary);
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), { app, store, settings: store.settings, lifecycleGeneration: 1, unloaded: false, updateStatusBar: vi.fn(async () => {}), refreshViews: vi.fn(async () => {}), lifeOpsEvents: { publish: vi.fn() }, buildSemanticContext: vi.fn(async () => ""), tryLocalAgentFallback: vi.fn(async () => null) });
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
async function submit(date: string, source: "text" | "voice") {
  const fixed = vi.fn(async () => ({ content: "", toolCalls: [{ id: `fictional-task-date-${source}-${date || "omitted"}`, name: "create_task", arguments: { title, ...(date ? { date } : {}) } }] }));
  stubAgentModel(plugin, fixed);
  const result = await plugin.submitAgentMessage(`请创建待办，${date ? "日期" + date : "先不定日期"}：${title}`, [], { source, selfTest: true });
  expect(fixed).toHaveBeenCalledOnce(); return result;
}
describe("task dates through actual Main and disk without erasing supplied dates", () => {
  for (const source of ["text", "voice"] as const) {
    it.each([["昨天", "2025-12-31"], ["前天", "2025-12-30"], ["2024-02-29", "2024-02-29"], ["", ""]])(`preserves requested date %s and an omitted date, with precise undo: ${source}`, async (supplied, expected) => {
      const before = await vault.bytes(store.taskDbPath()), mirror = await vault.bytes(store.taskMirrorPath());
      const result = await submit(supplied, source); expect(result.actions).toEqual([]); expect(result.reply).toContain("已创建任务");
      const fresh = new LifeOpsStore(plugin.app, plugin.settings) as unknown as StoreHost, db = await fresh.readTaskDb({ readOnly: true });
      expect(db.tasks).toHaveLength(2); expect(db.tasks.find(t => t.title === title)).toMatchObject({ date: expected, status: "active" });
      expect(db.tasks.find(t => t.title === "纯虚构原任务")).toEqual(originalTask);
      expect(await vault.bytes(store.dailyNotePath("2026-01-01", "晚"))).toBe(diary);
      await plugin.undoLatestLifeOpsOperation(); expect(await vault.bytes(store.taskDbPath())).toBe(before); expect(await vault.bytes(store.taskMirrorPath())).toBe(mirror);
    });
    it.each(["2026-02-30", "2025-02-29", "2026-13-01", "上周某天"])(`rejects supplied invalid date %s without creating an undated substitute: ${source}`, async date => {
      const before = await vault.bytes(store.taskDbPath()), mirror = await vault.bytes(store.taskMirrorPath()), create = vi.spyOn(store, "createTask");
      const result = await submit(date, source); expect(result.actions).toEqual([]); expect(result.reply).toMatch(/日期.*无法识别|日期.*不存在/);
      expect(create).not.toHaveBeenCalled(); expect(await vault.bytes(store.taskDbPath())).toBe(before); expect(await vault.bytes(store.taskMirrorPath())).toBe(mirror);
      expect(await vault.bytes(store.dailyNotePath("2026-01-01", "晚"))).toBe(diary);
    });
  }
});
