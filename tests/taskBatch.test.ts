import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import { formatDate, addDays } from "../src/date";
import { planTaskBatch } from "../src/agent/taskBatch";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, store: StoreHost;
const now = new Date(2026, 10, 21, 10, 43), date = formatDate(now);
const call = (args: Record<string, unknown> = {}) => ({ id: "fictional-batch", name: "schedule_task_batch",
  arguments: { date, tasks: Array.from({ length: 5 }, (_, i) => ({ title: `虚构样片步骤${i}`, estimateMin: 30 })), ...args } });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-task-batch-"));
  store = new LifeOpsStore({ vault: new DiskVault(root) } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it("plans all five without a history limit, after now, and with 10 minute buffers", async () => {
  const plan = await planTaskBatch(store, call(), now);
  expect(plan.calls).toHaveLength(5);
  expect(plan.calls[0].arguments).toMatchObject({ date, startTime: "10:45", endTime: "11:15", estimateMin: 30 });
  expect(plan.calls[1].arguments).toMatchObject({ startTime: "11:25", endTime: "11:55" });
  expect(plan.notes.join()).toContain("无法据此判断能力上限");
  expect((await store.readTaskDb()).tasks).toEqual([]);
});
it.each(['today','TODAY',' 今天 '])('keeps all five tasks on the turn date when the provider date is %s',async value=>{
  const plan=await planTaskBatch(store,call({date:value}),now);
  expect(plan.calls).toHaveLength(5);expect(plan.calls.every(row=>row.arguments.date===date)).toBe(true);
  expect((await store.readTaskDb({readOnly:true})).tasks).toEqual([]);
});

it("does not turn measured zero historical completions into a one-task hard cap", async () => {
  await store.createTask({ title: "虚构历史未完成", date: addDays(date, -2) });
  const plan = await planTaskBatch(store, call(), now);
  expect(plan.calls).toHaveLength(5);
  expect(plan.notes.join()).toContain("仅作负荷提醒");
});
it("avoids existing intervals and point appointments while keeping their records intact", async () => {
  await store.createTask({ title: "虚构固定会议", date, startTime: "11:00", endTime: "12:00" });
  await store.createTask({ title: "虚构固定电话", date, time: "12:30", estimateMin: 30 });
  const before = await store.readTaskDb();
  const plan = await planTaskBatch(store, call(), now);
  expect(plan.calls[0].arguments).toMatchObject({ startTime: "13:10", endTime: "13:40" });
  expect(await store.readTaskDb()).toEqual(before);
});
it("keeps overflow tasks on the requested date, unscheduled, and computes the risk count", async () => {
  const plan = await planTaskBatch(store, call({ availableEnd: "11:20" }), now);
  expect(plan.calls).toHaveLength(5);
  expect(plan.calls.filter(c => !c.arguments.startTime)).toHaveLength(4);
  expect(plan.calls.every(c => c.arguments.date === date)).toBe(true);
  expect(plan.notes.join()).toContain("4项在剩余时间内放不下");
});
it("keeps a past requested start from moving new tasks into the past", async () => {
  const plan = await planTaskBatch(store, call({ availableStart: "08:00" }), now);
  expect(plan.calls[0].arguments.startTime).toBe("10:45");
});
it("reuses exact same-day tasks on retry rather than creating them twice", async () => {
  const existing = await store.createTask({ title: "虚构样片步骤0", date, startTime: "11:00", endTime: "11:30" });
  const plan = await planTaskBatch(store, call(), now);
  expect(plan.calls).toHaveLength(4);
  expect(plan.existing).toHaveLength(1);
  expect(await store.getTask(existing.id)).toEqual(existing);
});
it("does not recreate an already completed same-day task", async () => {
  const existing = await store.createTask({ title: "虚构样片步骤0", date });
  await store.completeTask(existing.id);
  const plan = await planTaskBatch(store, call(), now);
  expect(plan.calls).toHaveLength(4);
  expect(plan.existing[0]).toContain("已完成");
});
it.each([
  { tasks: [{ title: "虚构重复" }, { title: "虚构重复" }] },
  { tasks: [{ title: "虚构负时长", estimateMin: -1 }] },
  { tasks: [{ title: "虚构不支持字段", command: "delete" }] },
  { tasks: [{ title: "虚构补偿", category: "punishment" }] },
  { availableEnd: "25:00" }, { date: addDays(date, -1) },
  { availableStart: "13:00", availableEnd: "12:00" },
  { tasks: Array.from({ length: 21 }, (_, i) => ({ title: `虚构超限${i}` })) }
])("rejects invalid batch arguments before writing: %j", async args => {
  await expect(planTaskBatch(store, call(args), now)).rejects.toThrow();
  expect((await store.readTaskDb()).tasks).toEqual([]);
});
