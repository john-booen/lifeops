import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { readContextTasks, readContextHabits, dashboardContextData } from "../src/contextData";
import { buildInjectedContext, formatContextForInstructions } from "../src/contextInjection";
import { createStoreVaultAdapter, type StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-context-data-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; await store.initializeVault(); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("separate read-only AI task and habit data", () => {
  it("refuses writes from the context adapter and the captured habit projection while normal writes remain available", async () => {
    await store.createHabit({ name: "上下文习惯", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    const before = await vault.bytes(store.habitDbPath()), data = await readContextHabits(store), adapter = createStoreVaultAdapter(store, { forContext: true });
    await expect(store.writeHabitDb(data.database)).rejects.toThrow("只读副本");
    await expect(async () => adapter.write!(store.habitDbPath(), "不得写入")).rejects.toThrow("不能写入");
    await expect(async () => adapter.taskAuthority!.createTask({ title: "不得创建" })).rejects.toThrow("不能保存");
    expect(await vault.bytes(store.habitDbPath())).toBe(before); expect((await store.readTaskDb()).tasks).toHaveLength(0);
  });
  it.each(["excluded", "missing"])("also refuses the original unavailable %s habit projection", async kind => {
    await store.createHabit({ name: "不得清空的习惯", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    if (kind === "excluded") store.settings.privacy!.excludedVaultPrefixes = [store.habitDbPath()]; else await vault.delete(store.getFile(store.habitDbPath())!);
    const before = store.getFile(store.habitDbPath()) ? await vault.bytes(store.habitDbPath()) : null;
    const data = await readContextHabits(store); expect(data.available).toBe(false); await expect(store.writeHabitDb(data.database)).rejects.toThrow("只读副本");
    expect(store.getFile(store.habitDbPath()) ? await vault.bytes(store.habitDbPath()) : null).toBe(before);
  });
  it.each(["json_excluded", "missing_json_excluded_mirror"])("does not read or fall through %s and does not claim zero", async mode => {
    const task = await store.createTask({ title: "不应送出的虚构任务" });
    if (mode === "json_excluded") store.settings.privacy!.excludedVaultPrefixes = [store.taskDbPath()];
    else { await vault.delete(store.getFile(store.taskDbPath())!); store.settings.privacy!.excludedVaultPrefixes = [store.taskMirrorPath()]; }
    const read = vi.spyOn(store, "readPath"), before = vault.writes.length;
    const data = await readContextTasks(store); expect(data.available).toBe(false); expect(data.source).toBeUndefined(); expect(data.tasks).toEqual([]);
    expect(read.mock.calls.some(([path]) => store.settings.privacy!.excludedVaultPrefixes.includes(path))).toBe(false);
    const context = await buildInjectedContext(store), text = formatContextForInstructions(context);
    expect(context.taskFacts).toBeUndefined(); expect(text).toContain("任务记录未提供"); expect(text).not.toContain(task.title); expect(text).not.toContain("今日已核实完成");
    expect(vault.writes).toHaveLength(before);
  });
  it("keeps JSON authority with a nonempty allowed JSON and never reads an excluded mirror", async () => {
    const task = await store.createTask({ title: "JSON原任务" }); store.settings.privacy!.excludedVaultPrefixes = [store.taskMirrorPath()];
    const read = vi.spyOn(store, "readPath"), data = await readContextTasks(store);
    expect(data.available).toBe(true); expect(data.tasks[0].id).toBe(task.id); expect(data.source?.path).toBe(store.taskDbPath());
    expect(read.mock.calls.some(([path]) => path === store.taskMirrorPath())).toBe(false);
  });
  it("does not certify an empty JSON when its legacy mirror cannot be checked", async () => {
    store.settings.privacy!.excludedVaultPrefixes = [store.taskMirrorPath()];
    expect((await readContextTasks(store)).available).toBe(false);
  });
  it("reads missing-JSON legacy tasks from their actual mirror without creating or repairing a database", async () => {
    const task = await store.createTask({ title: "纯虚构旧看板任务" }); await vault.delete(store.getFile(store.taskDbPath())!); const before = vault.writes.length;
    const context = await buildInjectedContext(store); expect(context.taskSummary.totalActive).toBe(1);
    expect(context.taskFacts?.sourcePaths).toEqual([store.taskMirrorPath()]); expect((await readContextTasks(store)).tasks[0].id).toBe(task.id);
    expect(store.getFile(store.taskDbPath())).toBeNull(); expect(vault.writes).toHaveLength(before);
  });
  it("filters task fields backed by excluded original notes, labels partial counts, and preserves normal UI authority", async () => {
    const source = store.path(store.settings.folders.ideas, "虚构私人依据.md"); await vault.seed(source, "虚构原文");
    await store.createTask({ title: "不得提供的缓存标题", sourceNotePath: source }); await store.createTask({ title: "允许的任务" });
    const before = await vault.bytes(store.taskDbPath()); store.settings.privacy!.excludedVaultPrefixes = [source];
    const data = await readContextTasks(store); expect(data.filtered).toBe(true); expect(data.tasks.map(task => task.title)).toEqual(["允许的任务"]);
    const context = await buildInjectedContext(store); expect(context.taskSummary.totalActive).toBe(1); expect(context.taskFacts?.allowedSourcesOnly).toBe(true);
    expect(formatContextForInstructions(context)).toContain("不能代表被排除的事项或完整总数");
    expect((await store.getTaskDashboard()).tasks).toHaveLength(2); await expect(store.writeTaskDb({ tasks: data.tasks })).rejects.toThrow();
    expect(await vault.bytes(store.taskDbPath())).toBe(before);
  });
  it.each(["tasks", "habits"])("keeps the other domain available when only %s are excluded", async kind => {
    await store.createTask({ title: "允许或隐藏的任务" }); await store.createHabit({ name: "允许或隐藏的习惯", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    store.settings.privacy!.excludedVaultPrefixes = [kind === "tasks" ? store.taskDbPath() : store.habitDbPath()];
    const context = await buildInjectedContext(store), text = formatContextForInstructions(context);
    expect(context.availability).toEqual({ tasks: kind !== "tasks", habits: kind !== "habits" });
    expect(text).toContain(kind === "tasks" ? "任务记录未提供" : "习惯记录未提供");
    expect(text).toContain(kind === "tasks" ? "共 1 个" : "未完成任务总计 1 个");
  });
  it("computes habit definitions, checkins and weekly failures from one captured database", async () => {
    await store.createHabit({ name: "同次读取习惯", frequencyUnit: "week", frequencyInterval: 1, targetCount: 2 });
    const read = vi.spyOn(store, "readPath"), context = await store.getTaskDashboard(undefined, { forContext: true });
    expect(context.habits[0].habit.name).toBe("同次读取习惯");
    expect(read.mock.calls.filter(([path]) => path === store.habitDbPath())).toHaveLength(1);
    expect(dashboardContextData(context)?.habits.source?.path).toBe(store.habitDbPath());
  });
  it("rejects a permission replacement during the last habit read and preserves all original bytes", async () => {
    await store.createTask({ title: "不得迟到送出的旧任务" }); const before = await Promise.all([store.taskDbPath(), store.habitDbPath()].map(path => vault.bytes(path)));
    const read = store.readPath.bind(store); vi.spyOn(store, "readPath").mockImplementation(async path => { const value = await read(path); if (path === store.habitDbPath()) store.settings.privacy!.excludedVaultPrefixes = [store.taskDbPath()]; return value; });
    await expect(buildInjectedContext(store)).rejects.toThrow("权限变化");
    expect(await Promise.all([store.taskDbPath(), store.habitDbPath()].map(path => vault.bytes(path)))).toEqual(before);
  });
  it("keeps unknown task/habit schema versions intact without repair", async () => {
    for (const path of [store.taskDbPath(), store.habitDbPath()]) { const raw = JSON.stringify({ schemaVersion: 99, tasks: [], habits: [], checkins: [] }); await vault.seed(path, raw); const before = vault.writes.length;
      await expect(path === store.taskDbPath() ? readContextTasks(store) : readContextHabits(store)).rejects.toThrow(); expect(await vault.bytes(path)).toBe(raw); expect(vault.writes).toHaveLength(before);
    }
  });
});
