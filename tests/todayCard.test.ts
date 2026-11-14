import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, formatDate } from "../src/date";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { LocalOperationHost } from "../src/features/serviceHost";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, requestUrl: vi.fn(() => { throw Error("Unexpected AI request"); }),
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}));
const { requestUrl } = await import("obsidian");
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { DiskVault } = await import("./helpers/diskVault");
const { extractJournalSignal } = await import("../src/features/journal/signalStore");
const { addJournalPlanTask, getTodayCard } = await import("../src/features/today/service");
const now = new Date(2026, 10, 12, 10);
const date = formatDate(now), tomorrow = addDays(date, 1), yesterday = addDays(date, -1);
const morning = `${DEFAULT_SETTINGS.folders.dailyRoot}/${date}早.md`;
const raw = "今天精力 2 分，昨晚睡了 5.5 小时。明天跑5公里；下周整理旧笔记。";

describe("today card reads and journal plan creation", () => {
  let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
  let host: LocalOperationHost;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    root = await mkdtemp(join(tmpdir(), "lifeops-today-card-"));
    vault = new DiskVault(root);
    store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    await store.initializeVault();
    runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    host = {
      async saveLocalOperation(name, args, execute, options) {
        const result = await runtime.executeLocalOperation(name, args, execute, undefined, options);
        if (!result.success) throw Error(result.output);
      },
      refreshViews: vi.fn(async () => {})
    };
    await vault.seed(morning, raw);
    await extractJournalSignal(store, morning, "2026", async () => JSON.stringify({
      date, period: "晨", energy: 2, sleepHours: 5.5,
      quotes: [{ field: "energy", text: "今天精力 2 分" }, { field: "sleepHours", text: "昨晚睡了 5.5 小时" }],
      plans: [{ text: "跑5公里", when: "明天" }, { text: "整理旧笔记", when: "下周" }]
    }), new AbortController().signal, () => {});
  });
  afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

  it("uses source quotes, real counts and the same top three as plan_today without calling a model", async () => {
    vi.setSystemTime(new Date(yesterday + "T18:00:00"));
    const past = await store.createTask({ title: "历史完成", date: yesterday, estimateMin: 35 });
    await store.completeTask(past.id);
    vi.setSystemTime(now);
    const done = await store.createTask({ title: "今天已完成", date });
    await store.completeTask(done.id);
    await store.createTask({ title: "临近见客户", date, startTime: "10:30", quadrant: "important-urgent" });
    await store.createTask({ title: "较长的任务", date, estimateMin: 120, quadrant: "important-urgent" });
    await store.createTask({ title: "其他今天任务", date });
    await store.createTask({ title: "昨天过期的任务", date: yesterday });
    await store.createHabit({ name: "虚构阅读", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    const paths = [store.taskDbPath(), store.taskMirrorPath(), morning];
    const before = await Promise.all(paths.map(path => vault.bytes(path)));
    const card = await getTodayCard(store, await store.getTaskDashboard(date));
    expect(card).toMatchObject({ completed: 1, total: 4, capacity: { overloaded: true, typicalCount: 1 },
      status: [{ label: "精力", value: "2/5", quote: "今天精力 2 分" }, { label: "情绪", value: "未记录" },
        { label: "睡眠", value: "5.5 小时", quote: "昨晚睡了 5.5 小时" }, { label: "睡眠质量", value: "未记录" }],
      habits: [{ title: "虚构阅读", done: 0, target: 1 }] });
    expect(card.priorities).toHaveLength(3);
    const tool = await runtime.executeAiToolCall({ name: "plan_today", arguments: {} }, "kimi");
    expect(card.priorities.map(task => task.id)).toEqual(JSON.parse(tool.output).tasks.slice(0, 3).map((task: { id: string }) => task.id));
    expect(card.priorities[0].reasons).toContain("一小时内有安排");
    expect(card.plans).toMatchObject([{ plan: { title: "跑5公里", date: tomorrow }, added: false },
      { plan: { title: "整理旧笔记", date: "" }, added: false }]);
    expect(requestUrl).not.toHaveBeenCalled();
    expect(await Promise.all(paths.map(path => vault.bytes(path)))).toEqual(before);
  });

  it("deduplicates an existing task and concurrent clicks, then supports undo of the one new task", async () => {
    await store.createTask({ title: "跑 5 公里", date: tomorrow });
    const [existing, fresh] = (await getTodayCard(store, await store.getTaskDashboard(date))).plans;
    expect(existing.added).toBe(true);
    await addJournalPlanTask(host, () => store, existing.plan);
    expect((await store.readTaskDb()).tasks).toHaveLength(1);
    await Promise.all([addJournalPlanTask(host, () => store, fresh.plan), addJournalPlanTask(host, () => store, fresh.plan)]);
    const tasks = (await store.readTaskDb()).tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks.find(task => task.title === "整理旧笔记")).toMatchObject({ date: "", sourceNotePath: morning });
    expect((await getTodayCard(store, await store.getTaskDashboard(date))).plans.every(item => item.added)).toBe(true);
    await runtime.undoLatestOperation();
    expect((await store.readTaskDb()).tasks).toHaveLength(1);
    expect(await vault.bytes(morning)).toBe(raw);
  });

  it("adds and undoes a plan from a diary extracted with normalized text reads", async () => {
    const exact = `\uFEFF${raw}\r\n虚构日记末行  \r\n`;
    await vault.seed(morning, exact);
    const read = vault.read.bind(vault);
    Object.assign(vault, {
      adapter: { getBasePath: () => root },
      readBinary: async (file: { path: string }) => Buffer.from(await vault.bytes(file.path), "utf8")
    });
    vi.spyOn(vault, "read").mockImplementation(async file => {
      const text = await read(file);
      return file.path === morning ? text.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n") : text;
    });
    await extractJournalSignal(store, morning, "2026", async () => JSON.stringify({
      date, period: "晨", plans: [{ text: "跑5公里", when: "明天" }]
    }), new AbortController().signal, () => {});

    const [choice] = (await getTodayCard(store, await store.getTaskDashboard(date))).plans;
    expect(choice.plan).toMatchObject({ title: "跑5公里", date: tomorrow });
    await addJournalPlanTask(host, () => store, choice.plan);
    expect((await store.readTaskDb()).tasks).toMatchObject([{ title: "跑5公里", date: tomorrow, sourceNotePath: morning }]);
    await runtime.undoLatestOperation();
    expect((await store.readTaskDb()).tasks).toEqual([]);
    expect(await vault.bytes(morning)).toBe(exact);
  });

  it("keeps the day and point time of two same-title plans and deduplicates only the matching slot", async () => {
    await vault.seed(morning, "明天上午十点核对虚构纸样，明天下午三点继续核对虚构纸样。");
    await extractJournalSignal(store, morning, "2026", async () => JSON.stringify({
      date, period: "晨", plans: [{ text: "核对虚构纸样", when: "明天上午十点" }, { text: "核对虚构纸样", when: "明天下午三点" }]
    }), new AbortController().signal, () => {});
    await store.createTask({ title: "核对虚构纸样", date: tomorrow, time: "10:00" });
    const choices = (await getTodayCard(store, await store.getTaskDashboard(date))).plans;
    expect(choices).toMatchObject([
      { plan: { title: "核对虚构纸样", date: tomorrow, time: "10:00" }, added: true },
      { plan: { title: "核对虚构纸样", date: tomorrow, time: "15:00" }, added: false }
    ]);
    await addJournalPlanTask(host, () => store, choices[1].plan);
    expect((await store.readTaskDb()).tasks).toMatchObject([
      { title: "核对虚构纸样", date: tomorrow, time: "10:00" },
      { title: "核对虚构纸样", date: tomorrow, time: "15:00", sourceNotePath: morning }
    ]);
    await runtime.undoLatestOperation();
    expect((await store.readTaskDb()).tasks).toMatchObject([{ date: tomorrow, time: "10:00" }]);
  });

  it("resolves the explicit evening time and leaves an approximate time unscheduled", async () => {
    await vault.seed(morning, "明晚八点摆虚构立牌，明天下午三点左右收虚构纸夹。");
    await extractJournalSignal(store, morning, "2026", async () => JSON.stringify({
      date, period: "晨", plans: [{ text: "摆虚构立牌", when: "明晚八点" }, { text: "收虚构纸夹", when: "明天下午三点左右" }]
    }), new AbortController().signal, () => {});
    const choices = (await getTodayCard(store, await store.getTaskDashboard(date))).plans;
    expect(choices[0].plan).toMatchObject({ title: "摆虚构立牌", date: tomorrow, time: "20:00" });
    expect(choices[1].plan).toMatchObject({ title: "收虚构纸夹", date: "" });
    expect(choices[1].plan.time).toBeUndefined();
  });

  it("includes a task scheduled today in the day's priorities even if its deadline is tomorrow", async () => {
    const task = await store.createTask({ title: "今天处理虚构纸卡", date, dueDate: tomorrow, startTime: "10:30" });
    const card = await getTodayCard(store, await store.getTaskDashboard(date));
    expect(card.capacity.plannedCount).toBe(1);
    expect(card.priorities).toMatchObject([{ id: task.id, reasons: expect.arrayContaining(["一小时内有安排"]) }]);
    const plan = await runtime.executeAiToolCall({ name: "plan_today", arguments: {} }, "kimi");
    expect(JSON.parse(plan.output).tasks.map((row: { id: string }) => row.id)).toEqual([task.id]);
  });

  it("stops a stale plan before any task write and retains a source edit that lands during save", async () => {
    const [choice] = (await getTodayCard(store, await store.getTaskDashboard(date))).plans;
    await vault.seed(morning, raw + "补一行。");
    const refreshed = await getTodayCard(store, await store.getTaskDashboard(date));
    expect(refreshed.plans).toEqual([]);
    expect(refreshed.status.find(item => item.label === "精力")?.value).toBe("未记录");
    await expect(addJournalPlanTask(host, () => store, choice.plan)).rejects.toThrow("已变更");
    expect((await store.readTaskDb()).tasks).toEqual([]);
    await vault.seed(morning, raw);
    const originalProcess = vault.process.bind(vault);
    vi.spyOn(vault, "process").mockImplementation(async (file, updater) => {
      const next = await originalProcess(file, updater);
      if (file.path === store.taskMirrorPath()) await vault.seed(morning, raw + "同步新增内容。");
      return next;
    });
    await expect(addJournalPlanTask(host, () => store, choice.plan)).rejects.toThrow("已变更");
    expect((await store.readTaskDb()).tasks).toEqual([]);
    expect(await vault.bytes(morning)).toBe(raw + "同步新增内容。");
  });

  it("rolls back a task when a settings reload replaces the store during save", async () => {
    const [choice] = (await getTodayCard(store, await store.getTaskDashboard(date))).plans;
    let current = store;
    const replacement = new LifeOpsStore(store.app, structuredClone(store.settings)) as unknown as StoreHost;
    const process = vault.process.bind(vault);
    vi.spyOn(vault, "process").mockImplementation(async (file, updater) => {
      const next = await process(file, updater);
      if (file.path === store.taskMirrorPath()) current = replacement;
      return next;
    });
    await expect(addJournalPlanTask(host, () => current, choice.plan)).rejects.toThrow("已变更");
    expect(current).toBe(replacement);
    expect((await replacement.readTaskDb()).tasks).toEqual([]);
    expect(await vault.bytes(morning)).toBe(raw);
  });
});
