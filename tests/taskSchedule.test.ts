import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { buildTaskFromInput, formatVaultTaskBlock, parseVaultTasks } from "../src/vaultApi";
import { taskDayInterval, taskScheduleLabel, taskTimeGroup, taskTimelineStart, validateTaskSchedule } from "../src/taskSchedule";
import type { LifeOpsTask } from "../src/types";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const day = "2026-10-08";
const legacy = (): LifeOpsTask => buildTaskFromInput({ title: "原有任务", date: day, time: "12:00", note: "原备注" }, new Date("2026-10-08T01:00:00Z"), () => "old");
const schedule = (startTime = "09:00", endTime = "12:00", endDate = "") => ({ ...legacy(), time: "", startTime, endTime, endDate });
describe("explicit task plan intervals", () => {
  it.each([
    ["09:00", "12:00", "morning"], ["11:59", "12:00", "morning"],
    ["12:00", "14:00", "afternoon"], ["14:00", "16:00", "afternoon"],
    ["16:00", "18:00", "afternoon"], ["18:00", "20:00", "evening"],
    ["09:00", "13:00", "spanning"], ["17:30", "18:30", "spanning"]
  ])("groups %s–%s as %s without endpoint inference", (start, end, group) => {
    expect(taskTimeGroup(schedule(start, end), day)).toBe(group);
  });
  it.each(["12:00", "14:00", "16:00", "18:00"])("a goal at %s invents no start or occupied interval", end => {
    const task = schedule("", end);
    expect(taskTimeGroup(task, day)).toBe("unscheduled");
    expect(taskDayInterval(task, day)).toBeUndefined();
    expect(taskTimelineStart(task, day)).toBeUndefined();
    expect(taskScheduleLabel(task)).toContain(`${end} 前完成`);
  });
  it("does not silently reinterpret a historical point", () => {
    expect(taskTimeGroup(legacy(), day)).toBe("unscheduled");
    expect(taskTimelineStart(legacy(), day)).toBeUndefined();
    expect(taskScheduleLabel(legacy())).toBe("原安排 12:00 · 区间未确认");
  });
  it("an explicit start says end unknown, not a fabricated duration", () => {
    const task = schedule("09:00", "");
    expect(taskTimeGroup(task, day)).toBe("morning");
    expect(taskDayInterval(task, day)).toBeUndefined();
    expect(taskTimelineStart(task, day)).toBe(540);
    expect(taskScheduleLabel(task)).toContain("结束未定");
    expect(taskTimeGroup(task, "2026-10-09")).toBe("unscheduled");
  });
  it("clips a cross-day plan without dropping midnight or the final morning", () => {
    const task = { ...schedule("20:00", "09:00", "2026-10-10"), scheduleMode: "fixed" as const };
    expect(taskDayInterval(task, day)).toEqual({ start: 1200, end: 1440 });
    expect(taskTimeGroup(task, day)).toBe("evening");
    expect(taskDayInterval(task, "2026-10-09")).toEqual({ start: 0, end: 1440 });
    expect(taskTimeGroup(task, "2026-10-09")).toBe("spanning");
    expect(taskTimeGroup(task, "2026-10-10")).toBe("morning");
    expect(taskDayInterval(task, "2026-10-11")).toBeUndefined();
    expect(taskScheduleLabel(task)).toContain("2026-10-10 09:00");
  });
  it.each([
    ["12:00", "09:00", ""], ["12:00", "12:00", ""], ["24:00", "", ""],
    ["", "12:99", ""], ["09:00", "12:00", "2026-10-07"]
  ])("rejects invalid plan %s / %s / %s", (start, end, endDate) => {
    expect(() => validateTaskSchedule(schedule(start, end, endDate))).toThrow();
  });
  it("requires an actual date for new plans and leaves legacy fields intact", () => {
    expect(() => validateTaskSchedule({ ...schedule(), date: "2026-02-30" })).toThrow();
    expect(() => validateTaskSchedule({ ...schedule(), date: "" })).toThrow();
    expect(() => validateTaskSchedule({ ...schedule(), date: "今天" })).toThrow();
    expect(() => validateTaskSchedule({ ...schedule(), date: " 2026-10-08 " })).toThrow();
    expect(() => validateTaskSchedule({ ...legacy(), date: "", time: "old text" })).not.toThrow();
  });
  it("a midnight end occupies no time on its terminal date", () => {
    const task = schedule("22:00", "00:00", "2026-10-09");
    expect(taskDayInterval(task, "2026-10-09")).toBeUndefined();
    expect(taskTimelineStart(task, "2026-10-09")).toBeUndefined();
    expect(taskTimeGroup(task, "2026-10-09")).toBe("boundary");
    expect(taskTimeGroup(task, day)).toBe("evening");
  });
});

let vault: InstanceType<typeof DiskVault>, store: StoreHost, root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-task-schedule-"));
  vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await vault.seed(store.taskDbPath(), JSON.stringify({ tasks: [legacy()], extension: { retain: true } }));
  await vault.seed(store.taskMirrorPath(), `# 任务\n\n> 自定义说明\n\n## 进行中\n${formatVaultTaskBlock(legacy())}\n\n## 已完成\n\n## 放弃\n`);
  vault.writes.length = 0;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe("task scheduling canonical disk persistence", () => {
  it("saves the interval in JSON and Markdown, reloads and preserves old records", async () => {
    const created = await store.createTask({ title: "上午安排", date: day, startTime: "09:00", endTime: "12:00", dueDate: "2026-10-10", dueTime: "17:00" });
    const fresh = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS));
    expect(await fresh.getTask(created.id)).toMatchObject({ startTime: "09:00", endTime: "12:00", time: "", completedAt: "", status: "active" });
    const parsed = parseVaultTasks(await vault.bytes(store.taskMirrorPath()));
    expect(parsed.find(t => t.id === created.id)).toMatchObject({ startTime: "09:00", endTime: "12:00" });
    expect(await fresh.getTask("old")).toEqual(legacy());
    expect(JSON.parse(await vault.bytes(store.taskDbPath())).extension).toEqual({ retain: true });
    expect(await vault.bytes(store.taskMirrorPath())).toContain("自定义说明");
  });
  it("all times stay cleared after saving and a fresh Store read", async () => {
    const created = await store.createTask({ title: "清除时刻", date: day, startTime: "09:00", endTime: "12:00", time: "08:00", dueDate: day, dueTime: "13:00" });
    await store.updateTaskDetails(created.id, { title: created.title, startTime: "", endTime: "", time: "", dueTime: "" });
    const fresh = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS));
    expect(await fresh.getTask(created.id)).toMatchObject({ startTime: "", endTime: "", time: "", dueTime: "", dueDate: day });
    expect(parseVaultTasks(await vault.bytes(store.taskMirrorPath())).find(t => t.id === created.id)).toMatchObject({ startTime: "", endTime: "" });
  });
  it("ordinary title edits preserve every planned and actual field", async () => {
    const created = await store.createTask({ title: "编辑", date: day, startTime: "09:00", endTime: "12:00" });
    await store.updateTaskDetails(created.id, { title: "只改标题" });
    expect(await store.getTask(created.id)).toMatchObject({ title: "只改标题", startTime: "09:00", endTime: "12:00", completedAt: "" });
  });
  it.each(["create", "edit"])("invalid %s does not change canonical facts or mirror", async kind => {
    const before = await vault.bytes(store.taskDbPath()), mirror = await vault.bytes(store.taskMirrorPath());
    const input = { title: "非法区间", date: day, startTime: "12:00", endTime: "09:00" };
    await expect(kind === "create" ? store.createTask(input) : store.updateTaskDetails("old", input)).rejects.toThrow();
    expect(await vault.bytes(store.taskDbPath())).toBe(before);
    expect(await vault.bytes(store.taskMirrorPath())).toBe(mirror);
  });
  it.each(["not-a-date", "2026/10/09", "2026-02-30"])("does not discard supplied invalid plan end date %s", async endDate => {
    const before = await vault.bytes(store.taskDbPath()), mirror = await vault.bytes(store.taskMirrorPath());
    await expect(store.createTask({ title: "不吞坏日期", date: day, endDate, startTime: "09:00", endTime: "12:00" })).rejects.toThrow();
    expect(await vault.bytes(store.taskDbPath())).toBe(before); expect(await vault.bytes(store.taskMirrorPath())).toBe(mirror);
  });
  it("refuses a malformed planned mirror-only record without read repair", async () => {
    await vault.delete(vault.getFileByPath(store.taskDbPath())!);
    const mirror = `## 进行中\n- [ ] 不能吞坏日期\n  - 状态=active · 日期=${day} -> not-a-date · 计划开始=09:00 · 计划结束=12:00 · ID=bad\n`;
    await vault.seed(store.taskMirrorPath(), mirror); vault.writes.length = 0;
    await expect(store.readTaskDb({ readOnly: true })).rejects.toThrow();
    expect(vault.writes).toEqual([]); expect(await vault.bytes(store.taskMirrorPath())).toBe(mirror);
  });
  it("duplicates and repeats preserve explicit intervals without declaring completion", async () => {
    const created = await store.createTask({ title: "重复安排", date: day, startTime: "09:00", endTime: "12:00", repeatUnit: "day" });
    await store.duplicateTaskToDate(created.id, "2026-10-09");
    await store.completeTask(created.id, "真实完成记录");
    const children = (await store.readTaskDb()).tasks.filter(t => t.parentTaskId === created.id);
    expect(children).toHaveLength(2);
    expect(children.every(t => t.startTime === "09:00" && t.endTime === "12:00" && !t.completedAt && t.status === "active")).toBe(true);
    const original = await store.getTask(created.id);
    expect(original.completionLog.at(-1)?.note).toBe("真实完成记录");
  });
  it("moves and duplicates overnight plans with their original calendar span", async () => {
    const created = await store.createTask({ title: "跨夜", date: day, endDate: "2026-10-09", startTime: "22:00", endTime: "02:00" });
    await store.duplicateTaskToDate(created.id, "2026-10-10");
    const child = (await store.readTaskDb()).tasks.find(t => t.parentTaskId === created.id)!;
    expect(child).toMatchObject({ date: "2026-10-10", endDate: "2026-10-11", startTime: "22:00", endTime: "02:00" });
    await store.moveTaskToDate(created.id, "2026-10-12");
    expect(await store.getTask(created.id)).toMatchObject({ date: "2026-10-12", endDate: "2026-10-13", startTime: "22:00", endTime: "02:00" });
  });
});
