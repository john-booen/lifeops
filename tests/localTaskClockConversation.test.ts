import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {},
  Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, Platform: { isDesktopApp: true },
  normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(),
  requestUrl: () => { throw Error("Offline fictional fallback clock test"); }
}));
const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: any, originalTask: unknown;
const title = "整理纯虚构蓝鲸图书馆资料", diary = "纯虚构手写日记，完整保留。\n";

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 9, 31, 18)); vi.stubGlobal("window", globalThis);
  root = await mkdtemp(join(tmpdir(), "lifeops-fallback-clock-")); vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; await store.initializeVault();
  originalTask = await store.createTask({ title: "纯虚构原任务", date: "2026-11-02", quadrant: "important-not-urgent", priority: "high", note: "手写备注\n第二行保留", source: "manual" });
  await vault.seed(store.dailyNotePath("2026-10-31", "晚"), diary);
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), {
    app, store, settings: store.settings, lifecycleGeneration: 1, unloaded: false,
    updateStatusBar: vi.fn(async () => {}), refreshViews: vi.fn(async () => {}), lifeOpsEvents: { publish: vi.fn() },
    buildSemanticContext: vi.fn(async () => "")
  });
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

function unavailable() {
  const reply = vi.fn();
  plugin.ai = { agentTurnStream: reply };
  return reply;
}

describe("unconfigured model task clocks through original Main, Runtime and files", () => {
  for (const source of ["text", "voice"] as const) {
    it(`saves the supplied Chinese time and precisely undoes it: ${source}`, async () => {
      const reply = unavailable(), before = await vault.bytes(store.taskDbPath()), mirror = await vault.bytes(store.taskMirrorPath());
      const result = await plugin.submitAgentMessage(`帮我创建一条任务，${title}，明天上午十点开始。`, [], { source, selfTest: true });
      expect(reply).not.toHaveBeenCalled(); expect(result.reply).toContain("已创建任务"); expect(result.actions).toEqual([]);
      const fresh = new LifeOpsStore(plugin.app, plugin.settings) as unknown as StoreHost, db = await fresh.readTaskDb({ readOnly: true });
      expect(db.tasks).toHaveLength(2); expect(db.tasks.find(task => task.title === title)).toMatchObject({ date: "2026-11-01", time: "10:00", status: "active" });
      expect(db.tasks.find(task => task.title === "纯虚构原任务")).toEqual(originalTask);
      expect(await vault.bytes(store.dailyNotePath("2026-10-31", "晚"))).toBe(diary);
      await plugin.undoLatestLifeOpsOperation();
      expect(await vault.bytes(store.taskDbPath())).toBe(before); expect(await vault.bytes(store.taskMirrorPath())).toBe(mirror);
      expect(await vault.bytes(store.dailyNotePath("2026-10-31", "晚"))).toBe(diary);
    });
    it.each(["十点六十分", "上午十五点", "十点到十一点", "十分钟后", "十点 左右", "十点一份资料", "10点三人开会", "整理三点建议", "半小时后", "晚上两点", "晚上十二点", "傍晚十二点"])(`keeps files unchanged rather than dropping the clock: ${source}, %s`, async clock => {
      const reply = unavailable(), before = await vault.bytes(store.taskDbPath()), mirror = await vault.bytes(store.taskMirrorPath()), create = vi.spyOn(store, "createTask");
      const result = await plugin.submitAgentMessage(`帮我创建一条任务，${title}，明天${clock}。`, [], { source, selfTest: true });
      expect(reply).not.toHaveBeenCalled(); expect(result.reply).not.toContain("已创建任务"); expect(create).not.toHaveBeenCalled();
      expect(await vault.bytes(store.taskDbPath())).toBe(before); expect(await vault.bytes(store.taskMirrorPath())).toBe(mirror);
      expect(await vault.bytes(store.dailyNotePath("2026-10-31", "晚"))).toBe(diary);
    });
  }
});
