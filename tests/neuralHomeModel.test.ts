import { describe, expect, it } from "vitest";
import { homeBranches } from "../src/panel/neuralHomeModel";
import type { DashboardStats, LifeOpsTask, TaskDashboardData } from "../src/types";

const stats = { morningNoteExists: false, eveningNoteExists: true } as DashboardStats;
function board(): TaskDashboardData {
  return { date: "2026-10-23", today: [], overdue: [], noDate: [], habits: [] } as unknown as TaskDashboardData;
}
const task = (id: string, extra: Partial<LifeOpsTask> = {}) => ({ id, title: `<script>${id}</script>`,
  status: "active", date: "2026-10-23", note: "原始备注\n末行保留", ...extra }) as LifeOpsTask;

describe("home uses existing saved facts", () => {
  it("deduplicates a task in two dashboard buckets without losing its overdue route or dates", () => {
    const b = board(), t = task("one", { dueDate: "2026-10-22", dueTime: "18:30", startTime: "09:00", endTime: "10:00" });
    b.today = [t]; b.overdue = [t];
    const rows = homeBranches("tasks", stats, b);
    expect(rows).toHaveLength(1); expect(rows[0].title).toBe(t.title);
    expect(rows[0].body).toContain(t.note);
    expect(rows[0].meta).toContain("截止 2026-10-22 18:30");
    expect(rows[0].meta).toContain("09:00–10:00"); expect(rows[0].meta).toContain("待完成");
    expect(rows[0].action).toEqual({ label: "在事务中查看", kind: "tasks", filter: "overdue" });
  });
  it("keeps unknown scheduling empty and uses the original no-date filter", () => {
    const b = board(); b.noDate = [task("none", { date: "", status: "abandoned" })];
    const row = homeBranches("tasks", stats, b)[0];
    expect(row.meta).toBe("未定日期 · 已放弃");
    expect(row.action).toMatchObject({ filter: "no-date" });
  });
  it("diary entry availability comes only from the host flags", () => {
    const rows = homeBranches("life", stats, board());
    expect(rows[0].body).toContain("尚未记录"); expect(rows[1].body).toContain("已有记录");
    expect(rows[0].action).toMatchObject({ kind: "record", record: "morning" });
  });
  it("learning and project entries have no invented records or graph counts", () => {
    const b = board(), before = JSON.stringify(b);
    for (const domain of ["learning", "projects"] as const) {
      const rows = homeBranches(domain, stats, b);
      expect(rows).toHaveLength(1); expect(rows[0].action).toMatchObject({ kind: "library", domain });
      expect(rows[0].meta).toBe("记录库");
    }
    expect(JSON.stringify(b)).toBe(before);
  });
  it("keeps a multiweek habit frequency distinct from today's checkin status", () => {
    const b = board();
    b.habits = [{ habit: { id: "h", name: "虚构习惯", frequencyInterval: 3, frequencyUnit: "week", targetCount: 4 },
      status: "pending", periodLabel: "本阶段", periodDone: 1, periodTarget: 4, streak: 0 }] as TaskDashboardData["habits"];
    const row = homeBranches("tasks", stats, b)[0];
    expect(row.meta).toBe("待打卡"); expect(row.body).toContain("频率：每3周4次");
    expect(row.body).toContain("本阶段：1 / 4 次");
  });
});
