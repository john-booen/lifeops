import { expect, it } from "vitest";
import { tradeStats } from "../src/features/stats/trades";
import { validTradeDatabase } from "../src/features/trading/types";
import { validLearningDocument, learningProgress } from "../src/features/learning/model";
import { validQuizDocument } from "../src/features/learning/quizModel";
import { validReadingDocument } from "../src/features/reading/model";
// @ts-expect-error Deterministic Node-only generator is covered with behavior assertions.
import { buildEvalFixture, EVAL_NOW } from "../scripts/make-eval-vault.mjs";

it("reproduces the same fictional month with twelve current tasks and three completed", async () => {
  const first: Map<string, string> = await buildEvalFixture();
  expect([...first]).toEqual([...await buildEvalFixture()]);
  expect(first.size).toBe(84);
  const { tasks } = JSON.parse(first.get("LifeOps/Goals/Tasks/LifeOps任务库.json")!);
  const today = tasks.filter((task: { date: string }) => task.date === EVAL_NOW.slice(0, 10));
  expect(today).toHaveLength(12);
  expect(today.filter((task: { status: string }) => task.status === "completed")).toHaveLength(3);
  expect(today.filter((task: { status: string }) => task.status === "active")).toHaveLength(9);
  const mirror = first.get("LifeOps/Goals/Tasks/任务看板.md")!;
  expect(tasks.every((task: { id: string }) => mirror.includes(`ID=${task.id} ·`))).toBe(true);
  expect(first.get("LifeOps/Journal/2026/10/2026-10-28晚.md")).toContain("AI 漫剧");
  expect(first.get("LifeOps/Journal/2026/11/2026-11-10早.md")).toContain("5.5 小时");
  expect(tasks.find((task: { category: string }) => task.category === "punishment")).toMatchObject({
    status: "active", dueDate: "2026-10-19", habitPunishment: { rule: { kind: "reflection", minChars: 200 } }
  });
  expect(JSON.parse(first.get("LifeOps/Output/AI/Signals/2026-11-10.json")!).晨[0]).toMatchObject({ sleepHours: 5.5, energy: 2 });
});

it("contains a previous-week summary, comparable monthly snapshots and two fictional memories", async () => {
  const files: Map<string, string> = await buildEvalFixture();
  const base = "LifeOps/Output/AI/";
  const fields = (path: string) => JSON.parse(files.get(base + path)!.split("\n")[1]);
  expect(fields("摘要/周/2026-W45.md")).toMatchObject({ through: "2026-11-08", complete: true, metrics: { tasksCompleted: 26 } });
  expect(fields("摘要/月/2026-10.md")).toMatchObject({ complete: true, metrics: { tasksCompleted: 60, tradePnlCny: 5, tradePnlUsd: 15 } });
  expect(fields("摘要/月/2026-11.md")).toMatchObject({ through: "2026-11-12", complete: false,
    metrics: { tasksCompleted: 46, tradePnlCny: 180, tradePnlUsd: 120 } });
  expect(JSON.parse(files.get(base + "Memory/personal-memory.json")!).records).toHaveLength(2);
});

it("seeds five fictional ideas, current and next-week English progress, grounded quiz cards, and an indexed article", async () => {
  const files: Map<string, string> = await buildEvalFixture();
  const ideas = [...files].filter(([path]) => path.startsWith("LifeOps/Knowledge/Ideas/"));
  expect(ideas).toHaveLength(5);
  expect(files.get("LifeOps/Knowledge/Ideas/AI 漫剧.md")).toContain('"lastProgress":"2026-10-28"');
  const root = "LifeOps/Output/AI/", learn = JSON.parse(files.get(root + "Learning/LifeOps学习轨道.json")!);
  expect(validLearningDocument(learn)).toBe(true);
  expect(learningProgress(learn.tracks[0], new Date(EVAL_NOW))).toMatchObject({ completedUnits: 2, totalUnits: 8, recordedMinutes: 75,
    weeklyMinutes: 150, nextWeek: { from: "2026-11-16", weeklyMinutes: 100 } });
  const quiz = JSON.parse(files.get(root + "Learning/LifeOps复习卡.json")!);
  expect(validQuizDocument(quiz)).toBe(true);
  expect(quiz.active.cardIds).toHaveLength(3);
  for (const card of quiz.cards) expect(files.get(card.sourcePath)).toContain(card.sourceQuote);
  const reading = JSON.parse(files.get(root + "Reading/index.json")!);
  expect(validReadingDocument(reading)).toBe(true);
  expect(reading.entries[0].ideaIds).toEqual(["idea-eval-1111111111111111"]);
});

it("contains thirty fictional trades with hand-checked market, monthly and daily statistics", async () => {
  const files: Map<string, string> = await buildEvalFixture();
  const database = JSON.parse(files.get("LifeOps/TradeReview/LifeOps交易记录.json")!);
  expect(validTradeDatabase(database)).toBe(true);
  expect(database.trades).toHaveLength(30);
  const range = { from: "2026-11-01", to: "2026-11-12" };
  expect(tradeStats(database.trades, range, "market")).toMatchObject({
    count: 26, byCurrency: { CNY: { count: 6, totalPnl: 180 }, USD: { count: 20, totalPnl: 120 } },
    groups: [
      { key: "A股", byCurrency: { CNY: { winPercent: 60 } } },
      { key: "加密", byCurrency: { USD: { winPercent: 57.14 } } },
      { key: "外汇", byCurrency: { USD: { winPercent: 66.67 } } },
      { key: "美股", byCurrency: { USD: { winPercent: 50 } } }
    ]
  });
  expect(database.trades.filter((trade: { openedAt: string }) => trade.openedAt.startsWith(range.to))).toHaveLength(4);
  expect(JSON.parse(files.get("LifeOps/Goals/Habits/LifeOps打卡库.json")!).habits).toContainEqual(
    expect.objectContaining({ id: "habit-eval-trade", source: "trades", target: { kind: "number", perDay: 10, unit: "笔" } })
  );
});

it("gives the current week one running check-in toward a four-session target", async () => {
  const files: Map<string, string> = await buildEvalFixture();
  const { habits, checkins } = JSON.parse(files.get("LifeOps/Goals/Habits/LifeOps打卡库.json")!);
  const running = habits.find((habit: { name: string }) => habit.name === "跑步");
  expect(running.targetCount).toBe(4);
  expect(checkins.filter((checkin: { habitId: string; date: string }) => checkin.habitId === running.id && checkin.date >= "2026-11-09")).toHaveLength(1);
  expect(habits.find((habit: { name: string }) => habit.name === "阅读").target).toMatchObject({ kind: "number", unit: "分钟", perDay: 30 });
});
