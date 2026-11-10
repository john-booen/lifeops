import { describe, expect, it } from "vitest";
import {
  archiveMemory,
  createMemoryCandidate,
  hasSufficientMemoryCoverage,
  memoryPriorityScore,
  normalizeMemoryEntry,
  promoteMemory,
  recordMemoryRetrieved,
  selectActiveMemories,
  selectRelevantMemories,
  shouldSuggestGrowthMemory
} from "../src/memoryIndex";

describe("memoryIndex", () => {
  it("creates candidate memories without activating them", () => {
    const entry = createMemoryCandidate({
      content: "用户亏损后容易急于追回",
      source: "LifeOps/TradeReview/2026-06-10.md",
      perspective: "trading_discipline"
    }, "2026-06-11T00:00:00.000Z");

    expect(entry.status).toBe("candidate");
    expect(entry.tier).toBe("episodic");
    expect(entry.id).toMatch(/^mem_/);
  });

  it("promotes and retrieves memories", () => {
    const candidate = createMemoryCandidate({
      content: "用户喜欢 Cici 直接一点",
      source: "Conversations/2026-06-11.md",
      importance: 0.8,
      confidence: 0.8
    }, "2026-06-11T00:00:00.000Z");
    const active = recordMemoryRetrieved(promoteMemory(candidate, "internalized", "2026-06-11T01:00:00.000Z"), "2026-06-11T02:00:00.000Z");

    expect(active.status).toBe("active");
    expect(active.verifiedCount).toBe(1);
    expect(active.retrieveCount).toBe(1);
    expect(memoryPriorityScore(active, new Date("2026-06-11T03:00:00.000Z"))).toBeGreaterThan(0.6);
  });

  it("suggests growth only after repeated verification", () => {
    let entry = createMemoryCandidate({
      content: "连续熬夜会影响第二天交易纪律",
      source: "周报.md",
      confidence: 0.8,
      importance: 0.8
    });
    entry = promoteMemory(entry);
    entry = promoteMemory(entry);
    entry = promoteMemory(entry);

    expect(shouldSuggestGrowthMemory(entry)).toBe(true);
  });

  it("excludes archived memories from active selection", () => {
    const active = promoteMemory(createMemoryCandidate({ content: "active", source: "a.md", importance: 0.9 }));
    const archived = archiveMemory(promoteMemory(createMemoryCandidate({ content: "archived", source: "b.md", importance: 1 })));

    expect(selectActiveMemories([archived, active])).toEqual([active]);
  });

  it("prefers source-grounded memories in the requested domain", () => {
    const trading = promoteMemory(createMemoryCandidate({
      content: "交易模型要求等待确认信号",
      source: "交易模型.md",
      memoryType: "domain",
      domain: "trading-models",
      origin: "source",
      evidence: [{
        sourceId: "source-trading",
        path: "交易模型.md",
        contentHash: "hash",
        mtime: 1
      }],
      importance: 0.9
    }));
    const health = promoteMemory(createMemoryCandidate({
      content: "近期睡眠不足",
      source: "健康.md",
      memoryType: "state",
      domain: "health",
      origin: "source",
      evidence: [{
        sourceId: "source-health",
        path: "健康.md",
        contentHash: "hash",
        mtime: 1
      }]
    }));

    expect(selectRelevantMemories([health, trading], "按我的交易模型分析")[0].id).toBe(trading.id);
    expect(hasSufficientMemoryCoverage([health, trading], "按我的交易模型分析")).toBe(true);
    expect(hasSufficientMemoryCoverage([health, trading], "打开交易模型原文")).toBe(false);
  });

  it("migrates legacy memory entries without losing their original fields", () => {
    const legacy = createMemoryCandidate({
      content: "旧记忆",
      source: "旧来源"
    });
    const normalized = normalizeMemoryEntry({
      ...legacy,
      memoryType: undefined,
      evidence: undefined
    } as unknown as typeof legacy);

    expect(normalized.content).toBe("旧记忆");
    expect(normalized.memoryType).toBe("episode");
    expect(normalized.evidence).toEqual([]);
    expect(normalized.history).toEqual([]);
  });
});
