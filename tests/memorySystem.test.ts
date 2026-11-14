import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoreHost } from "../src/store/settingsSlice";
import type { InjectedContext } from "../src/contextInjection";
import type { LifeOpsTask } from "../src/types";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (path: string) => path }));
const { getUserTrends, recordConversationMemory } = await import("../src/memorySystem");
afterEach(() => vi.useRealTimers());

function trendStore(tasks: Array<Partial<LifeOpsTask>> = [], log = ""): StoreHost {
  return {
    settings: { folders: { aiReports: "AI" } }, path: (...parts: string[]) => parts.join("/"),
    readPath: vi.fn().mockResolvedValue(log), appendFile: vi.fn().mockResolvedValue(undefined),
    getTaskDashboard: vi.fn().mockResolvedValue({ tasks: tasks.map(task => ({ title: "", note: "", date: "", dueDate: "", completedAt: "", ...task })) }),
    taskDbPath: () => "Tasks/tasks.json", taskMirrorPath: () => "Tasks/tasks.md"
  } as unknown as StoreHost;
}

describe("memory trend evidence", () => {
  it("ignores completion claims and stale trend metadata in user or assistant logs", async () => {
    const log = ["用户：我完成了报告", "Cici：任务已完成，打卡搞定"].map(content => JSON.stringify({
      type: "conversation_summary", timestamp: new Date().toISOString(), content,
      metadata: { consecutiveLateNights: 20, activeTasks: 99, overdueTasks: 88 }
    })).join("\n");
    const trends = await getUserTrends(trendStore([], log));
    expect(trends).toMatchObject({ consecutiveLateNights: 0, activeTasks: 0, overdueTasks: 0, completionSignals: 0 });
    expect(trends).toHaveProperty("lateNightStatus", "unknown");
  });

  it("counts distinct completed task IDs in the last seven local dates with evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 16, 10));
    const completedAt = new Date(2026, 8, 16, 1).toISOString();
    const trends = await getUserTrends(trendStore([
      { id: "one", title: "已完成任务", status: "completed", completedAt },
      { id: "one", title: "重复记录", status: "completed", completedAt },
      { id: "two", status: "completed", completedAt: new Date(2026, 8, 10, 0).toISOString() },
      { id: "older", status: "completed", completedAt: new Date(2026, 8, 9, 23, 59).toISOString() },
      { id: "active", title: "完成了", status: "active", date: "2026-09-15", completedAt }
    ]));
    expect(trends).toMatchObject({ completionSignals: 2, activeTasks: 1, overdueTasks: 1 });
    expect(trends).toHaveProperty("completionEvidence.0", expect.objectContaining({ taskId: "one", completedAt, localDate: "2026-09-16" }));
    expect(trends).toHaveProperty("taskEvidenceStatus", "available");
  });

  it("counts an explicit completion date and marks missing, invalid and future evidence as incomplete", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 16, 10));
    const trends = await getUserTrends(trendStore([
      { id: "missing", status: "completed" }, { id: "invalid", status: "completed", completedAt: "yesterday" },
      { id: "date-only", status: "completed", completedAt: "2026-09-16" },
      { id: "invalid-date", status: "completed", completedAt: "2026-02-30" },
      { id: "future-date", status: "completed", completedAt: "2026-09-17" },
      { id: "future", status: "completed", completedAt: new Date(2026, 8, 17, 10).toISOString() }
    ]));
    expect(trends.completionEvidence).toMatchObject([{ taskId: "date-only", completedAt: "2026-09-16", localDate: "2026-09-16" }]);
    expect(trends.completionSignals).toBe(1);
    expect(trends).toHaveProperty("taskEvidenceStatus", "partial");
  });

  it("reports unknown when task evidence cannot be read and does not reuse old snapshots", async () => {
    const store = trendStore();
    vi.mocked(store.getTaskDashboard).mockRejectedValue(new Error("unavailable"));
    const fallback = { taskSummary: { totalActive: 88, overdue: 77 }, userState: { consecutiveLateNights: 9 } } as InjectedContext;
    const trends = await getUserTrends(store, fallback);
    expect(trends).toMatchObject({ activeTasks: 0, overdueTasks: 0, completionSignals: 0, consecutiveLateNights: 0 });
    expect(trends).toHaveProperty("taskEvidenceStatus", "unknown");
  });
  it("does not count impossible calendar dates normalized by Date.parse", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 3, 10));
    const trends = await getUserTrends(trendStore([
      { id: "impossible", status: "completed", completedAt: "2026-02-30T10:00:00+08:00" },
      { id: "next-day-normalized", status: "completed", completedAt: "2026-03-02T24:00:00+08:00" }
    ]));
    expect(trends.completionSignals).toBe(0);
    expect(trends.taskEvidenceStatus).toBe("partial");
  });

  it("logs user statements and assistant responses separately with the local source date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 16, 1));
    const store = trendStore();
    const context = { time: { date: "2026-09-16", timeOfDay: "night" }, taskSummary: { totalActive: 0, overdue: 0, dueToday: 0 }, userState: { consecutiveLateNights: 2 } } as InjectedContext;
    await recordConversationMemory(store, "我完成了", "任务已经完成了", context);
    const line = vi.mocked(store.appendFile).mock.calls[0][1];
    const record = JSON.parse(line);
    expect(record).toMatchObject({ userStatement: "我完成了", assistantResponse: "任务已经完成了" });
    expect(record.metadata).toMatchObject({ localDate: "2026-09-16", sourcePath: "AI/Conversations/2026-09-16.md", lateNightStatus: "unknown" });
    expect(record.metadata.consecutiveLateNights).toBeUndefined();
  });
});
