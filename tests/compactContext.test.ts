import { describe, expect, it, vi } from "vitest";
import { buildCompactModelContext, compactInjectedFacts, recentJournalTitles } from "../src/compactContext";
import { standardAgentSystemPrompt } from "../src/agentInstructions";
import { agentToolsForChat, agentToolsForRealtime } from "../src/toolRegistry";
import type { InjectedContext } from "../src/contextInjection";
import type { StoreHost } from "../src/store/settingsSlice";
import type { TaskDashboardData } from "../src/types";
vi.mock("obsidian", () => ({ Notice: class {}, normalizePath: (path: string) => path }));

const context: InjectedContext = { time: { date: "2026-11-06", iso: "2026-11-06T01:00:00Z", timeOfDay: "morning", dayOfWeek: "周五" },
  taskSummary: { totalActive: 31, overdue: 1, dueToday: 25, dueTomorrow: 5 }, habitSummary: { total: 1, pendingToday: 0 },
  userState: { consecutiveLateNights: 0 }, recentContext: { lastJournalSummary: "虚构日记正文不应注入", recentCompletedTasks: [],
    journals: [{ date: "2026-11-06", title: "2026-11-06早", path: "日记/2026-11-06早.md" }] } };
const dashboard = { tasks: [
  ...Array.from({ length: 25 }, (_, i) => ({ id: `today-${i}`, title: `今日虚构任务${i}`, date: "2026-11-06", status: "active" })),
  { id: "yesterday", title: "过期正文不自动注入", date: "2026-11-05", status: "active" },
  { id: "tomorrow", title: "明日正文不自动注入", date: "2026-11-07", status: "active" }
], habits: [{ habit: { id: "reading", name: "虚构阅读", targetCount: 1 }, status: "done", checkin: { count: 1, note: "历史打卡正文不注入" } }] } as unknown as TaskDashboardData;

describe("compact default model context", () => {
  it("includes at most fifteen current tasks, today's habit state and diary metadata", () => {
    const text = compactInjectedFacts(context, dashboard);
    expect(text.match(/\[today-/g)).toHaveLength(15); expect(text).toContain("今日待办：25 项");
    expect(text).toContain("[reading]：done · 1/1"); expect(text).toContain("2026-11-06早");
    for (const omitted of ["过期正文不自动注入", "明日正文不自动注入", "虚构日记正文不应注入", "历史打卡正文不注入"]) expect(text).not.toContain(omitted);
    expect(text).toContain("其余按需读取");
  });
  it("lists only allowed diary titles in the last three dates without reading bodies", () => {
    const files = ["2026-11-03早", "2026-11-04晚", "2026-11-05早", "2026-11-06早", "2026-11-07早"].map(title => ({ path: `日记/${title}.md`, basename: title }));
    const read = vi.fn(() => { throw Error("must not read diary bodies"); });
    const store = { app: { vault: { getMarkdownFiles: () => files, read } }, settings: { folders: { dailyRoot: "日记" }, privacy: { excludedVaultPrefixes: ["日记/2026-11-05早.md"] } } } as unknown as StoreHost;
    expect(recentJournalTitles(store, "2026-11-06").map(item => item.title)).toEqual(["2026-11-06早", "2026-11-04晚"]);
    expect(read).not.toHaveBeenCalled();
  });
  it("keeps unavailable domains unknown and keeps supplied memory separate from facts", () => {
    const unavailable = { ...context, availability: { tasks: false, habits: false } };
    const text = buildCompactModelContext({ context: unavailable, dashboard, memory: "已确认虚构偏好", personality: "助手表达策略" });
    expect(text).toContain("资料未提供，状态未知"); expect(text).not.toContain("今日待办：0");
    expect(text.match(/已确认虚构偏好/g)).toHaveLength(1); expect(text).toContain("助手表达策略");
  });
  it("publishes no more than ten system principles for either conversation mode", () => {
    for (const prompt of [standardAgentSystemPrompt(false), standardAgentSystemPrompt(true)]) {
      expect(prompt.match(/^\d+\./gm)!.length).toBeLessThanOrEqual(10);
      expect(Array.from(prompt).length).toBeLessThan(1500);
    }
  });
  it("keeps actual published tool and nested parameter descriptions inside their budgets", () => {
    function parameters(schema: any, path: string): void {
      if (!schema || typeof schema !== "object") return;
      if (typeof schema.description === "string") expect(Array.from(schema.description).length, path).toBeLessThanOrEqual(40);
      for (const [key, value] of Object.entries(schema)) if (key !== "description") parameters(value, `${path}.${key}`);
    }
    for (const tool of [...agentToolsForChat(), ...agentToolsForRealtime()] as any[]) {
      expect(Array.from(tool.description).length, tool.name).toBeLessThanOrEqual(120);
      parameters(tool.parameters, tool.name);
    }
  });
});
