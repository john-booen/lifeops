import { describe, expect, it } from "vitest";
import { getStats, type StatsData } from "../src/features/stats/stats";
import type { HabitDefinition, LifeOpsTask } from "../src/types";

const now = new Date(2026, 1, 2, 12);
const crossMonth = { from: "2026-01-30", to: "2026-02-02" };
const at = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute).toISOString();

function task(overrides: Partial<LifeOpsTask> = {}): LifeOpsTask {
  return {
    id: "fictional-task", title: "纯虚构整理资料", status: "active", priority: "none", quadrant: "important-not-urgent",
    category: "work", project: "", date: "2026-02-02", endDate: "", time: "", dueDate: "", dueTime: "",
    repeatUnit: "none", repeatInterval: 1, repeatUntil: "", parentTaskId: "", note: "", source: "manual",
    sourceNotePath: "", createdAt: at(2, 2, 8), updatedAt: at(2, 2, 8), completedAt: "", completionLog: [], sortOrder: 0,
    ...overrides
  };
}

function habit(overrides: Partial<HabitDefinition> = {}): HabitDefinition {
  return {
    id: "fictional-habit", name: "纯虚构阅读", frequencyUnit: "day", frequencyInterval: 1,
    targetCount: 1, startDate: "2026-01-01", penaltyThreshold: 3, color: "", createdAt: "", ...overrides
  };
}

function checkin(date: string, overrides: Partial<NonNullable<StatsData["checkins"]>[number]> = {}) {
  return { habitId: "fictional-habit", date, status: "done" as const, count: 1, updatedAt: "", note: "", ...overrides };
}

describe("task statistics", () => {
  it("reports known empty counts and an undefined denominator", () => {
    expect(getStats({ domain: "tasks", range: "today" }, {}, now)).toMatchObject({
      plannedCount: 0, completedCount: 0, overdueCount: 0, completionPercent: null, averageCompletionMin: null
    });
  });

  it("counts completion by local day even if its ISO timestamp uses another date", () => {
    const completedAt = at(2, 2, 0, 15);
    const result = getStats({ domain: "tasks", range: "today" }, {
      tasks: [task({ status: "completed", createdAt: at(2, 1, 23, 45), completedAt })]
    }, now);
    expect(result).toMatchObject({ completedCount: 1, completedPlannedCount: 1, completionPercent: 100, averageCompletionMin: 30 });
  });

  it("includes both ends of a cross-month range and counts the active overdue task", () => {
    const result = getStats({ domain: "tasks", range: crossMonth, groupBy: "week" }, {
      tasks: [task({ id: "jan", date: "2026-01-30" }), task({ id: "feb", date: "2026-02-02" }),
        task({ id: "outside", date: "2026-01-29" })]
    }, now);
    expect(result).toMatchObject({ plannedCount: 2, overdueCount: 1,
      groups: [{ date: "2026-01-26", plannedCount: 1 }, { date: "2026-02-02", plannedCount: 1 }] });
  });

  it("groups planned work and later completions without overstating the planned completion rate", () => {
    const completedAt = at(2, 2, 9);
    const result = getStats({ domain: "tasks", range: "today", groupBy: "category" }, {
      tasks: [task(), task({ id: "old", category: "learning", date: "2026-01-01", status: "completed", completedAt }),
        task({ id: "learning", category: "learning" })]
    }, now);
    expect(result).toMatchObject({ completedCount: 1, completedPlannedCount: 0, completionPercent: 0,
      byCategory: { work: { plannedCount: 1, completedCount: 0 }, learning: { plannedCount: 1, completedCount: 1 } } });
  });

  it("deduplicates completion history and ignores invalid or future timestamps", () => {
    const completedAt = at(2, 2, 9);
    const result = getStats({ domain: "tasks", range: "today" }, { tasks: [task({
      status: "completed", completedAt, completionLog: [completedAt, completedAt, "2026-02-30T09:00:00+08:00", at(2, 2, 22)]
        .map(stamp => ({ completedAt: stamp, note: "" }))
    })] }, now);
    expect(result).toMatchObject({ completedCount: 1, averageCompletionMin: 60 });
  });

  it("accepts a historical completion even when the task has no planned date", () => {
    const result = getStats({ domain: "tasks", range: "last_7d", groupBy: "day" }, {
      tasks: [task({ date: "", status: "completed", completedAt: at(2, 1, 15), createdAt: "" })]
    }, now);
    expect(result).toMatchObject({ plannedCount: 0, completedCount: 1, averageCompletionMin: null,
      groups: [{ date: "2026-02-01", completedCount: 1 }] });
  });
});

it("distinguishes cross-day record lifetime from actual working time and whole-range plans", () => {
  const result = getStats({ domain: "tasks", range: { from: "2026-02-01", to: "2026-02-02" }, groupBy: "day" }, {
    tasks: [task({ id: "fictional-cross-day", date: "2026-02-01", status: "completed",
      createdAt: "2026-02-01T08:00:00+08:00", completedAt: "2026-02-02T09:00:00+08:00" }),
    task({ id: "fictional-date-only", date: "2026-02-01", status: "completed", createdAt: "", completedAt: "2026-02-02" })]
  }, new Date("2026-02-02T20:00:00+08:00"));
  expect(result).toMatchObject({ averageCompletionMin: 1500, completionIntervalSampleCount: 1,
    completedCount: 2, completedPlannedCount: 2, plannedCount: 2, completionPercent: 100,
    groups: [{ date: "2026-02-01", plannedCount: 2, completedCount: 0 }, { date: "2026-02-02", plannedCount: 0, completedCount: 2 }],
    metricDefinitions: { averageCompletionMin: { unit: "minutes", from: "createdAt", to: "completedAt", isWorkingTime: false },
      completionPercent: { numerator: "completedPlannedCount", denominator: "plannedCount" },
      plannedTime: { fields: ["estimateMin", "startTime", "endTime"], isWorkingTime: false } } });
});

it("keeps missing completion intervals unknown instead of reporting zero work", () => {
  const result = getStats({ domain: "tasks", range: "today" }, { tasks: [task({ status: "completed", createdAt: "", completedAt: "2026-02-02" })] }, now);
  expect(result).toMatchObject({ completedCount: 1, averageCompletionMin: null, completionIntervalSampleCount: 0,
    metricDefinitions: { averageCompletionMin: { isWorkingTime: false } } });
});

it("separates cross-month completion registration from the plan month in the readback contract", () => {
  const tasks = [task({ id: "fictional-last-month-plan", date: "2026-01-30", status: "completed",
    completedAt: "2026-02-01", completionLog: [{completedAt:"2026-01-31",note:""},{completedAt:"2026-02-01",note:""},{completedAt:"2026-02-02",note:""}] }),
  task({id:"fictional-current-plan",date:"2026-02-02",status:"completed",completedAt:"2026-02-02"})];
  const january = getStats({domain:"tasks",range:"last_month"},{tasks},now);
  const february = getStats({domain:"tasks",range:"this_month"},{tasks},now);
  expect(january).toMatchObject({range:{from:"2026-01-01",to:"2026-01-31"},completedTaskCount:1,plannedCount:1});
  expect(february).toMatchObject({completedTaskCount:2,completedCount:3,plannedCount:1,completedPlannedCount:1,
    metricDefinitions:{completedTaskCount:{dateBasis:"completion_registration_date",identity:"taskId"},
      completedCount:{dateBasis:"completion_registration_date"},plannedCount:{dateBasis:"planned_date"}}});
});

describe("habit statistics", () => {
  it("returns no habits for an empty database", () => {
    expect(getStats({ domain: "habits", range: "this_week" }, {}, now)).toMatchObject({ habits: [] });
  });

  it("uses one weekly target for a partial current week", () => {
    const result = getStats({ domain: "habits", range: "this_week" }, {
      habits: [habit({ frequencyUnit: "week", targetCount: 4 })], checkins: [checkin("2026-02-02")]
    }, now);
    expect(result).toMatchObject({ habits: [{ targetCount: 4, doneCount: 1, completionPercent: 25, currentStreak: 1 }] });
  });

  it("uses local calendar intervals across a month boundary", () => {
    const result = getStats({ domain: "habits", range: crossMonth, groupBy: "day" }, {
      habits: [habit({ startDate: "2026-01-31", frequencyInterval: 2 })],
      checkins: [checkin("2026-01-31"), checkin("2026-02-02")]
    }, now);
    expect(result).toMatchObject({ habits: [{ targetCount: 2, doneCount: 2, completionPercent: 100, groups: [
      { date: "2026-01-30", targetCount: 0 }, { date: "2026-01-31", targetCount: 1 },
      { date: "2026-02-01", targetCount: 0 }, { date: "2026-02-02", targetCount: 1 }
    ] }] });
  });

  it("keeps yesterday's streak while today is pending and excludes future checkins", () => {
    const result = getStats({ domain: "habits", range: "this_month" }, {
      habits: [habit()], checkins: ["2026-01-31", "2026-02-01", "2026-02-03"].map(date => checkin(date))
    }, now);
    expect(result).toMatchObject({ habits: [{ doneCount: 1, currentStreak: 2 }] });
  });

  it("keeps numerical values separate from counts, with zero as an observed value", () => {
    const result = getStats({ domain: "habits", range: crossMonth }, {
      habits: [habit()], checkins: [checkin("2026-01-30", { value: 0, count: 2 }), checkin("2026-01-31", { value: 100 }),
        checkin("2026-02-01", { status: "leave", value: 90 }), checkin("2026-02-02")]
    }, now);
    expect(result).toMatchObject({ habits: [{ doneCount: 4, valueTotal: 100, valueAverage: 50 }] });
  });

  it("keeps a weekly target out of each individual day's denominator", () => {
    const result = getStats({ domain: "habits", range: "today", groupBy: "day" }, {
      habits: [habit({ frequencyUnit: "week", targetCount: 4 })], checkins: [checkin("2026-02-02")]
    }, now);
    expect(result).toMatchObject({ habits: [{ targetCount: 4, groups: [{ targetCount: null, doneCount: 1, completionPercent: null }] }] });
  });

  it("includes the last valid day without stepping past the supported date format", () => {
    const date = "9999-12-31";
    expect(getStats({ domain: "habits", range: { from: date, to: date } }, {
      habits: [habit({ startDate: date })]
    }, new Date(9999, 11, 31, 12))).toMatchObject({ habits: [{ targetCount: 1 }] });
  });
});

describe("journal statistics", () => {
  it("computes the last three calendar dates across a month boundary", () => {
    const result = getStats({ domain: "journal", range: "last_3d" }, {
      journal: [
        { date: "2026-01-30", signals: { sleepHours: 9 } },
        { date: "2026-01-31", signals: { sleepHours: 5.5 } },
        { date: "2026-02-01", signals: { sleepHours: 5.5 } },
        { date: "2026-02-02", signals: { sleepHours: 5.5 } }
      ]
    }, now);
    expect(result).toMatchObject({
      range: { from: "2026-01-31", to: "2026-02-02" },
      count: 3, signalAverages: { sleepHours: 5.5 }
    });
  });

  it("reports known zero notes and missing signal values", () => {
    expect(getStats({ domain: "journal", range: "today" }, {}, now)).toMatchObject({
      count: 0, signalAverages: { energy: null, mood: null, stress: null, sleepHours: null, sleepQuality: null }
    });
  });

  it("counts distinct morning and evening entries on the same day", () => {
    const result = getStats({ domain: "journal", range: "today" }, {
      journal: [{ date: "2026-02-02" }, { date: "2026-02-02" }, { date: "2026-02-01" }]
    }, now);
    expect(result).toMatchObject({ count: 2 });
  });

  it("groups notes in a range spanning two months and two local weeks", () => {
    const result = getStats({ domain: "journal", range: crossMonth, groupBy: "week" }, {
      journal: [{ date: "2026-01-31" }, { date: "2026-02-01" }, { date: "2026-02-02" }]
    }, now);
    expect(result).toMatchObject({ count: 3, groups: [{ date: "2026-01-26", count: 2 }, { date: "2026-02-02", count: 1 }] });
  });

  it("uses the supplied local date near a time-zone boundary", () => {
    const localMidnight = new Date(2026, 1, 1, 0, 1);
    expect(getStats({ domain: "journal", range: "this_month" }, {
      journal: [{ date: "2026-01-31" }, { date: "2026-02-01" }]
    }, localMidnight)).toMatchObject({ count: 1, range: { from: "2026-02-01", to: "2026-02-01" } });
  });

  it("averages observed signals and excludes null or nonfinite entries", () => {
    const result = getStats({ domain: "journal", range: "today", groupBy: "day" }, {
      journal: [
        { date: "2026-02-02", signals: { energy: 2, mood: 4, sleepHours: 5.5 } },
        { date: "2026-02-02", signals: { energy: 4, mood: null, stress: Infinity, sleepHours: 6.5 } }
      ]
    }, now);
    expect(result).toMatchObject({ signalAverages: { energy: 3, mood: 4, stress: null, sleepHours: 6, sleepQuality: null },
      groups: [{ date: "2026-02-02", count: 2 }] });
  });
});

it("counts only recorded learning minutes within the range while retaining untimed sessions and unit progress", () => {
  const result = getStats({ domain: "learning", range: crossMonth, groupBy: "day" }, { learning: [
    { id: "english", name: "英语", goal: "虚构目标", folders: [], weeklyMinutes: 150,
      units: [{ id: "u1", title: "已完成", status: "done" }, { id: "u2", title: "在学", status: "doing" }],
      sessions: [{ date: "2026-01-30", minutes: 25 }, { date: "2026-02-02" }, { date: "2026-01-27", minutes: 15 }] }
  ] }, now);
  expect(result).toMatchObject({ domain: "learning", tracks: [{ id: "english", weeklyMinutes: 150, minutes: 25, sessions: 2,
    sessionsWithoutMinutes: 1, completionPercent: 50, groups: [{ date: "2026-01-30", minutes: 25 }, { date: "2026-02-02", minutes: 0 }] }] });
});

it("counts present idea status separately from registrations and latest progress within the requested dates", () => {
  const result = getStats({ domain: "ideas", range: crossMonth, groupBy: "day" }, { ideas: [
    { created: "2026-01-01", lastProgress: "2026-01-30", status: "building", stalled: false },
    { created: "2026-02-02", lastProgress: "2026-02-02", status: "seed", stalled: false },
    { created: "2026-01-07", lastProgress: "2026-01-07", status: "exploring", stalled: true }
  ] }, now);
  expect(result).toMatchObject({ currentByStatus: { building: 1, exploring: 1, seed: 1 }, stalled: 1, created: 1, progressed: 1,
    groups: [{ date: "2026-01-30", created: 0, progressed: 1 }, { date: "2026-02-02", created: 1, progressed: 0 }] });
});

it.each([{ from: "2026-02-30", to: "2026-03-02" }, { from: "2026-02-02", to: "2026-01-30" }])(
  "rejects invalid or reversed explicit ranges (%j)", range => {
    expect(() => getStats({ domain: "tasks", range }, {}, now)).toThrow("统计区间");
  }
);
