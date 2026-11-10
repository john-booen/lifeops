import { describe, expect, it } from "vitest";
import { buildAgentContextBundle, getUserContext, normalizeAgentHistory } from "../src/agentContext";
import type { VaultFileAdapter, VaultMarkdownFile } from "../src/vaultApi";

class MemoryVaultAdapter implements VaultFileAdapter {
  constructor(readonly files = new Map<string, string>()) {}

  async read(path: string): Promise<string> {
    return this.files.get(path) ?? "";
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async listMarkdownFiles(): Promise<VaultMarkdownFile[]> {
    return Array.from(this.files.entries()).map(([path, content]) => ({ path, content }));
  }
}

describe("normalizeAgentHistory", () => {
  it("keeps recent messages and trims long content", () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `message-${index} ${"x".repeat(40)}`
    }));

    const result = normalizeAgentHistory(history, 4, 24);

    expect(result).toHaveLength(4);
    expect(result[0].content).toContain("message-8");
    expect(result[3].content).toContain("truncated");
    expect(result[3].content.length).toBeLessThan(80);
  });
});

describe("buildAgentContextBundle", () => {
  it("keeps high-priority context and retrieval while bounding size", () => {
    const long = "x".repeat(20_000);
    const baseContext = [
      "# LifeOps Context 2026-06-04",
      "## Daily",
      long,
      "## Tasks",
      "- Important task",
      long,
      "## Habits",
      "- Running 0/3",
      "## Long-term Memory",
      "- User wants a strict but warm steward",
      long
    ].join("\n\n");
    const retrievalContext = `### LifeOps/TradeReview/2026/6月/2026-06-04.md\n\n- Retrieved trading note\n${long}`;

    const result = buildAgentContextBundle({ baseContext, retrievalContext });

    expect(result.length).toBeLessThanOrEqual(60_050);
    expect(result).toContain("## Tasks");
    expect(result).toContain("Important task");
    expect(result).toContain("## Habits");
    expect(result).toContain("## Long-term Memory");
    expect(result).toContain("# Retrieved Vault Notes");
    expect(result).toContain("Retrieved trading note");
    expect(result).toContain("truncated");
  });

  it("includes on-demand knowledge context before retrieval snippets", () => {
    const result = buildAgentContextBundle({
      baseContext: "# LifeOps Context\n\n## Vault Facts\n\n- tradingReviews: 5",
      knowledgeContext: "## 交易复盘\n\n### Knowledge Link Summary\n- LifeOps/TradeReview/2026/5月/2026-05-26.md",
      retrievalContext: "### Retrieved note"
    });

    expect(result).toContain("# On-demand Knowledge Context");
    expect(result).toContain("## 交易复盘");
    expect(result.indexOf("# On-demand Knowledge Context")).toBeLessThan(result.indexOf("# Retrieved Vault Notes"));
  });
});

describe("getUserContext", () => {
  it("uses vaultApi to aggregate goals, tasks, and recent notes", async () => {
    const context = await getUserContext({
      adapter: new MemoryVaultAdapter(new Map([
        ["LifeOps/Goals/目标.md", "# 目标\n\n- 做好 LifeOps"],
        ["LifeOps/Goals/Tasks/任务看板.md", [
          "# LifeOps 任务看板",
          "",
          "## 进行中",
          "- [ ] 完成 D0.4",
          "  - 状态=active · 优先级=高 · 象限=重要不紧急 · 分类=AI建议 · 项目=默认 · 日期=2026-06-15 -> 2026-06-15 · 时间= · 截止=2026-06-15",
          "",
          "## 已完成",
          "",
          "## 放弃"
        ].join("\n")],
        ["LifeOps/Journal/2026/06/2026-06-15早.md", "# 早\n\n今天接入 vaultApi。"]
      ])),
      date: "2026-06-15",
      recentDays: 1
    });

    expect(context.tasks[0].title).toBe("完成 D0.4");
    expect(context.markdown).toContain("做好 LifeOps");
    expect(context.markdown).toContain("完成 D0.4");
    expect(context.markdown).toContain("今天接入 vaultApi");
  });
});
