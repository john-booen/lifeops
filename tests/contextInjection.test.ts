import { describe, expect, it, vi } from "vitest";
import { buildInjectedContext, formatContextForInstructions, type InjectedContext } from "../src/contextInjection";
import type { StoreHost } from "../src/store/settingsSlice";
import type { LifeOpsTask } from "../src/types";

vi.mock("obsidian", () => ({ normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));

describe("context injection", () => {
  it("formats objective facts without injecting emotion labels", () => {
    const context: InjectedContext = {
      time: {
        iso: "2026-06-26T01:00:00.000Z",
        date: "2026-06-26",
        timeOfDay: "night",
        dayOfWeek: "周五"
      },
      taskSummary: {
        totalActive: 8,
        overdue: 3,
        dueToday: 2,
        dueTomorrow: 1
      },
      habitSummary: {
        total: 4,
        pendingToday: 2
      },
      userState: {
        consecutiveLateNights: 2,
      },
      recentContext: {
        lastJournalSummary: "今天主要在测试语音系统。",
        recentCompletedTasks: ["整理会议纪要"]
      }
    };

    const block = formatContextForInstructions(context);

    expect(block).toContain("任务概况：未完成任务总计 8 个（其中过期 3 个");
    expect(block).toContain("连续熬夜：缺少可核实的睡眠记录，未知");
    expect(block).not.toContain("2 天");
    expect(block).toContain("只把以下内容当作客观事实");
    expect(block).not.toContain("沮丧");
    expect(block).not.toContain("焦虑");
    expect(block).not.toContain("情绪低落");
  });

  it("does not infer consecutive late nights from the current clock or task wording", async () => {
    const store = contextStore([{ id: "active", title: "熬夜完成报告", note: "凌晨晚睡", status: "active" }]);
    const context = await buildInjectedContext(store, new Date(2026, 8, 16, 23, 30));
    expect(context.userState.consecutiveLateNights).toBe(0);
    expect(formatContextForInstructions(context)).toContain("连续熬夜：缺少可核实的睡眠记录，未知");
  });

  it("keeps overdue and due-date counts within the active total, including overlapping dates", async () => {
    const context = await buildInjectedContext(contextStore([
      { id: "overdue", status: "active", date: "2026-09-26" },
      { id: "two-dates", status: "active", date: "2026-09-27", dueDate: "2026-09-28" },
      { id: "done", status: "completed", date: "2026-09-25" }
    ]), new Date(2026, 8, 27, 8));
    expect(context.taskSummary).toEqual({ totalActive: 2, overdue: 1, dueToday: 1, dueTomorrow: 1 });
    const block = formatContextForInstructions(context);
    expect(block).toContain("未完成任务总计 2 个（其中过期 1 个、今天到期 1 个、明天到期 1 个）");
    expect(block).toContain("这些分类均包含在未完成总数内，可能重叠，不能相加或当成额外任务");
  });

  it("includes recent completion only from task state with a valid completion time", async () => {
    const now = new Date(2026, 8, 16, 10);
    const store = contextStore([
      { id: "ok", title: "确已完成", status: "completed", completedAt: new Date(2026, 8, 16, 1).toISOString() },
      { id: "words", title: "已经完成了", status: "active", completedAt: now.toISOString() },
      { id: "missing", title: "缺时间", status: "completed", updatedAt: now.toISOString() },
      { id: "future", title: "未来时间", status: "completed", completedAt: new Date(2026, 8, 17, 1).toISOString() },
      { id: "old", title: "旧完成记录", status: "completed", completedAt: new Date(2026, 7, 1, 1).toISOString() }
    ]);
    const context = await buildInjectedContext(store, now);
    expect(context.recentContext.recentCompletedTasks).toEqual(["确已完成"]);
    const block = formatContextForInstructions(context);
    expect(block).toContain("近7个本地日有完成时间的任务");
    expect(block).toContain("task:ok");
    expect(block).toContain("2026-09-16");
    expect(block).toContain("完成时间缺失或无效");
    expect(block).not.toContain("缺时间；");
  });

  it("does not format unverified legacy completed-task strings as facts", () => {
    const context = {
      time: { iso: "2026-09-16T02:00:00Z", date: "2026-09-16", timeOfDay: "morning", dayOfWeek: "周三" },
      taskSummary: { totalActive: 0, overdue: 0, dueToday: 0, dueTomorrow: 0 },
      habitSummary: { total: 0, pendingToday: 0 }, userState: { consecutiveLateNights: 2 },
      recentContext: { recentCompletedTasks: ["AI声称已完成"] }
    } as InjectedContext;
    expect(formatContextForInstructions(context)).not.toContain("AI声称已完成");
    expect(formatContextForInstructions(context)).toContain("完成记录：缺少可核实的任务状态与完成时间");
  });

  it("gives a separate verified-today total instead of asking the model to infer it from seven days", async () => {
    const context = await buildInjectedContext(contextStore([
      { id: "today", title: "核对清单", status: "completed", completedAt: new Date(2026, 8, 21, 0, 30).toISOString() },
      { id: "yesterday", title: "昨日材料", status: "completed", completedAt: new Date(2026, 8, 20, 23, 30).toISOString() },
      { id: "unknown", status: "completed", completedAt: "" }
    ]), new Date(2026, 8, 21, 10));
    const block = formatContextForInstructions(context);
    expect(block).toContain("今日已核实完成（2026-09-21）：1 个");
    expect(block).toContain("这不是全部历史完成数");
  });
});

function contextStore(tasks: Array<Partial<LifeOpsTask>>): StoreHost {
  return {
    getTaskDashboard: vi.fn().mockResolvedValue({ tasks: tasks.map(task => ({ title: "", note: "", date: "", dueDate: "", completedAt: "", updatedAt: "", ...task })), habits: [] }),
    getHabitDefinitions: vi.fn().mockResolvedValue([]), readPath: vi.fn().mockResolvedValue(""),
    visionStatePath: () => "AI/vision.md", readDailyPair: vi.fn().mockResolvedValue(""),
    taskDbPath: () => "Tasks/tasks.json", taskMirrorPath: () => "Tasks/tasks.md"
  } as unknown as StoreHost;
}
