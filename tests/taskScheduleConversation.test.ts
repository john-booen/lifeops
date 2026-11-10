import { stubAgentModel } from "./helpers/stubAgentModel";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import { buildResidentContext } from "../src/agent/context";
vi.mock("obsidian", () => ({ App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: () => { throw Error("Offline fictional task plans"); } }));
const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsStore } = await import("../src/store"), { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: any;
const day = "2026-10-08", title = "纯虚构任务计划", diary = "纯虚构亲写日记，保留。\n";
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 9, 8, 10)); vi.stubGlobal("window", globalThis);
  root = await mkdtemp(join(tmpdir(), "lifeops-task-plan-main-")); vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; await store.initializeVault();
  await vault.seed(store.dailyNotePath(day, "早"), diary);
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), { app, store, settings: store.settings, lifecycleGeneration: 1, unloaded: false, updateStatusBar: vi.fn(async () => {}), refreshViews: vi.fn(async () => {}), lifeOpsEvents: { publish: vi.fn() }, buildSemanticContext: vi.fn(async () => ""), tryLocalAgentFallback: vi.fn(async () => null) });
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
async function submit(plan: Record<string, unknown>, source: "text" | "voice") {
  const fixed = vi.fn(async () => ({ content: "", toolCalls: [{ id: `fictional-plan-${source}`, name: "create_task", arguments: { title, date: day, ...plan } }] }));
  stubAgentModel(plugin, fixed);
  const result = await plugin.submitAgentMessage(`请创建待办，按已明确的计划：${title}`, [], { source, selfTest: true });
  expect(fixed).toHaveBeenCalledOnce(); return result;
}
describe("actual Main task plans and source boundaries, fixed model only", () => {
  for (const source of ["text", "voice"] as const) {
    it.each([{ startTime: "09:00", endTime: "12:00" }, { endTime: "12:00" }, { startTime: "22:00", endTime: "02:00", endDate: "明天" }])(`stores an explicit plan, leaves completion unknown and exactly undoes it: ${source}`, async plan => {
      const before = await vault.bytes(store.taskDbPath()), mirror = await vault.bytes(store.taskMirrorPath());
      const response = await submit(plan, source); expect(response.actions).toEqual([]); expect(response.reply).toContain("已创建任务");
      const fresh = new LifeOpsStore(plugin.app, plugin.settings) as unknown as StoreHost;
      const task = (await fresh.readTaskDb({ readOnly: true })).tasks.find(t => t.title === title)!;
      expect(task).toMatchObject({ ...(plan.startTime ? { startTime: plan.startTime } : {}), endTime: plan.endTime, status: "active", completedAt: "", time: "" });
      if (!plan.startTime) expect(task.startTime).toBeUndefined();
      if (plan.endDate) expect(task.endDate).toBe("2026-10-09");
      expect(task.completionLog).toEqual([]);
      const context = await fresh.buildTaskContext(day);
      expect(context).toContain(plan.startTime ? "计划" : "未排区间");
      expect(context).toContain(plan.endTime);
      const voice = await buildResidentContext(fresh, "今天任务", new Date(day + "T12:00:00"), "voice");
      expect(voice.text).toContain(plan.endTime);
      await plugin.undoLatestLifeOpsOperation();
      expect(await vault.bytes(store.taskDbPath())).toBe(before); expect(await vault.bytes(store.taskMirrorPath())).toBe(mirror);
      expect(await vault.bytes(store.dailyNotePath(day, "早"))).toBe(diary);
    });
    it.each([{ startTime: "12:00", endTime: "09:00" }, { startTime: "24:00" }, { endTime: 12 }, { endTime: false }, { startTime: "09:00", endTime: "12:00", endDate: "2026-02-30" }, { date: "", endTime: "12:00" }])(`rejects an invalid new plan before canonical write: ${source}`, async plan => {
      const before = await vault.bytes(store.taskDbPath()), mirror = await vault.bytes(store.taskMirrorPath()), create = vi.spyOn(store, "createTask");
      const result = await submit(plan, source); expect(result.actions).toEqual([]); expect(result.reply).not.toContain("已创建任务");
      expect(create).not.toHaveBeenCalled(); expect(await vault.bytes(store.taskDbPath())).toBe(before); expect(await vault.bytes(store.taskMirrorPath())).toBe(mirror);
    });
  }
});
