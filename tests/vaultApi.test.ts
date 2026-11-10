import { describe, expect, it } from "vitest";
import {
  completeTaskInBoard,
  createVaultApi,
  defaultTaskBoard,
  parseVaultTasks,
  type VaultFileAdapter,
  type VaultMarkdownFile
} from "../src/vaultApi";

class MemoryVaultAdapter implements VaultFileAdapter {
  constructor(readonly files = new Map<string, string>()) {}

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`Missing test vault file: ${path}`);
    }
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async listMarkdownFiles(): Promise<VaultMarkdownFile[]> {
    return Array.from(this.files.entries())
      .filter(([path]) => path.endsWith(".md"))
      .map(([path, content], index) => ({ path, content, mtime: index }));
  }
}

describe("vaultApi", () => {
  it("creates tasks in the Vault contract format", async () => {
    const adapter = new MemoryVaultAdapter();
    const api = createVaultApi(adapter, {
      now: () => new Date("2026-06-15T01:02:03.000Z")
    });

    const task = await api.createTask({
      title: "给李总发项目材料",
      priority: "high",
      quadrant: "important-urgent",
      date: "2026-06-15",
      endDate: "2026-06-16",
      time: "09:30",
      dueDate: "2026-06-16",
      dueTime: "18:00"
    });

    expect(task.category).toBe("work");
    expect(task.project).toBe("默认");
    expect(adapter.files.get("LifeOps/Goals/Tasks/任务看板.md")).toContain([
      "- [ ] 给李总发项目材料",
      "  - 状态=active · 优先级=高 · 象限=重要且紧急 · 分类=work · 项目=默认 · 日期=2026-06-15 -> 2026-06-16 · 时间=09:30 · 截止=2026-06-16 18:00"
    ].join("\n"));
    expect(adapter.files.get("LifeOps/Goals/Tasks/任务看板.md")).toContain(`ID=${task.id}`);
  });

  it("preserves stable task ids and operation sources through the Markdown projection", async () => {
    const adapter = new MemoryVaultAdapter();
    const api = createVaultApi(adapter, {
      now: () => new Date("2026-06-15T01:02:03.000Z"),
      idFactory: () => "task-operation-123"
    });

    await api.createTask({
      title: "验证数据底座",
      date: "2026-06-15",
      source: "lifeops-agent-tool:call-123"
    });
    const tasks = await api.readTasks();

    expect(tasks[0]).toMatchObject({
      id: "task-operation-123",
      source: "lifeops-agent-tool:call-123",
      title: "验证数据底座"
    });
  });

  it("reads active and completed tasks from the task board", () => {
    const tasks = parseVaultTasks([
      "# LifeOps 任务看板",
      "",
      "## 进行中",
      "- [ ] 山西需要的材料",
      "  - 状态=active · 优先级=中 · 象限=重要不紧急 · 分类=AI建议 · 项目=默认 · 日期=2026-06-15 -> 2026-06-16 · 时间=10:00 · 截止=2026-06-16 18:00 · 重复=每 2 周，至 2026-12-31",
      "",
      "## 已完成",
      "- [x] 复盘昨晚交易",
      "  - 状态=completed · 优先级=高 · 象限=重要且紧急 · 分类=交易 · 项目=默认 · 日期=2026-06-14 -> 2026-06-14 · 时间=21:00 · 截止=2026-06-14 22:00 · 完成=2026-06-14T14:00:00.000Z",
      "",
      "## 放弃"
    ].join("\n"));

    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      title: "山西需要的材料",
      status: "active",
      priority: "medium",
      quadrant: "important-not-urgent",
      date: "2026-06-15",
      endDate: "2026-06-16",
      dueDate: "2026-06-16",
      dueTime: "18:00",
      repeatUnit: "week",
      repeatInterval: 2,
      repeatUntil: "2026-12-31"
    });
    expect(tasks[1]).toMatchObject({
      title: "复盘昨晚交易",
      status: "completed",
      priority: "high",
      completedAt: "2026-06-14T14:00:00.000Z"
    });
  });

  it("moves a task from active to completed", async () => {
    const adapter = new MemoryVaultAdapter(new Map([["LifeOps/Goals/Tasks/任务看板.md", [
      "# LifeOps 任务看板",
      "",
      "## 进行中",
      "- [ ] 给李总发项目材料",
      "  - 状态=active · 优先级=高 · 象限=重要且紧急 · 分类=AI建议 · 项目=默认 · 日期=2026-06-15 -> 2026-06-16 · 时间=09:30 · 截止=2026-06-16 18:00",
      "",
      "## 已完成",
      "",
      "## 放弃",
      ""
    ].join("\n")]]));
    const api = createVaultApi(adapter, {
      now: () => new Date("2026-06-16T10:20:30.000Z")
    });

    const completed = await api.completeTask("给李总发项目材料", "已经发出");
    const board = adapter.files.get("LifeOps/Goals/Tasks/任务看板.md") ?? "";

    expect(completed).toMatchObject({
      title: "给李总发项目材料",
      status: "completed",
      completedAt: "2026-06-16T10:20:30.000Z"
    });
    expect(board).toContain("## 进行中\n\n## 已完成");
    expect(board).toContain("- [x] 给李总发项目材料");
    expect(board).toContain("状态=completed · 优先级=高");
    expect(board).toContain("完成=2026-06-16T10:20:30.000Z");
    expect(board).toContain("完成备注：已经发出");
  });

  it("keeps completeTaskInBoard pure for direct parser tests", () => {
    const result = completeTaskInBoard(defaultTaskBoard().replace("## 进行中\n", [
      "## 进行中",
      "- [ ] 学习英语",
      "  - 状态=active · 优先级=中 · 象限=重要不紧急 · 分类=AI建议 · 项目=默认 · 日期=2026-06-15 -> 2026-06-15 · 时间= · 截止=2026-06-15",
      ""
    ].join("\n")), "学习英语", "2026-06-15T12:00:00.000Z");

    expect(result.markdown).toContain("## 已完成\n- [x] 学习英语");
    expect(parseVaultTasks(result.markdown).find((task) => task.title === "学习英语")?.status).toBe("completed");
  });

  it("builds daily-note and trading-review paths across month and year boundaries", async () => {
    const adapter = new MemoryVaultAdapter(new Map([
      ["LifeOps/Journal/2027/01/2027-01-02早.md", "# 2027-01-02 早\n"],
      ["LifeOps/TradeReview/2027/1月/2027-01-02.md", "# 交易复盘\n"]
    ]));
    const api = createVaultApi(adapter);

    await expect(api.readDailyNote("2027-01-02")).resolves.toMatchObject({
      path: "LifeOps/Journal/2027/01/2027-01-02早.md",
      exists: true
    });
    await expect(api.readDailyNote("2027-01-02", "晚")).resolves.toMatchObject({
      path: "LifeOps/Journal/2027/01/2027-01-02晚.md",
      exists: false
    });
    await expect(api.readTradingJournal("2027-01-02")).resolves.toMatchObject({
      path: "LifeOps/TradeReview/2027/1月/2027-01-02.md",
      exists: true
    });
  });

  it("reads dated journal articles recursively without requiring the early-late template", async () => {
    const adapter = new MemoryVaultAdapter(new Map([
      ["LifeOps/Journal/2026/07/2026.07.16.md", "今天写了一篇点号日期日记。"],
      ["LifeOps/Journal/2026/07/2026-07-15晚复盘.md", "昨天的晚间复盘。"]
    ]));
    const api = createVaultApi(adapter, {
      now: () => new Date(2026, 6, 16, 8, 0, 0)
    });

    await expect(api.readDailyNote("2026-07-16")).resolves.toMatchObject({
      path: "LifeOps/Journal/2026/07/2026.07.16.md",
      content: "今天写了一篇点号日期日记。",
      exists: true
    });
    const recent = await api.readRecentNotes(2, { endDate: "2026-07-16", includeEvening: true });
    expect(recent.filter((note) => note.exists).map((note) => note.path)).toEqual([
      "LifeOps/Journal/2026/07/2026-07-15晚复盘.md",
      "LifeOps/Journal/2026/07/2026.07.16.md"
    ]);
  });

  it("searches the vault and builds a compact user context", async () => {
    const adapter = new MemoryVaultAdapter(new Map([
      ["LifeOps/Goals/目标.md", "# 目标\n\n- 完成 LifeOps 数据底座"],
      ["LifeOps/Goals/Tasks/任务看板.md", [
        "# LifeOps 任务看板",
        "",
        "## 进行中",
        "- [ ] 完成 vaultApi",
        "  - 状态=active · 优先级=高 · 象限=重要不紧急 · 分类=AI建议 · 项目=默认 · 日期=2026-06-15 -> 2026-06-15 · 时间= · 截止=2026-06-15",
        "",
        "## 已完成",
        "",
        "## 放弃"
      ].join("\n")],
      ["LifeOps/Journal/2026/06/2026-06-15早.md", "# 早\n\n今天推进 vaultApi 数据底座。"],
      ["LifeOps/Knowledge/Ideas/LifeOps.md", "vaultApi 让 Cici 有稳定的数据入口。"]
    ]));
    const api = createVaultApi(adapter, {
      now: () => new Date("2026-06-15T08:00:00.000Z")
    });

    const results = await api.searchVault("vaultApi");
    const context = await api.getUserContext({ date: "2026-06-15", recentDays: 1 });

    expect(results.map((result) => result.path)).toContain("LifeOps/Knowledge/Ideas/LifeOps.md");
    expect(context.markdown).toContain("完成 LifeOps 数据底座");
    expect(context.markdown).toContain("完成 vaultApi");
    expect(context.markdown).toContain("今天推进 vaultApi 数据底座");
  });
});
