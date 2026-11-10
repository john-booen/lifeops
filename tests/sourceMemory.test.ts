import { describe, expect, it } from "vitest";
import {
  deriveSourceMemories,
  mergeSourceMemories,
  staleSourceMemories
} from "../src/dataFoundation/sourceMemory";
import type { SourceManifestEntry } from "../src/dataFoundation/sourceManifest";

const source: SourceManifestEntry = {
  sourceId: "source_trade",
  path: "LifeOps/Knowledge/TradeRules/我的模型.md",
  previousPaths: [],
  category: "trading-models",
  contentHash: "hash-v1",
  mtime: 1,
  size: 100,
  status: "active",
  chunkIds: ["chunk-1"],
  memoryIds: [],
  vectorStatus: "stale",
  firstSeenAt: "2026-07-27T00:00:00.000Z",
  lastProcessedAt: "2026-07-27T00:00:00.000Z"
};

describe("source-derived memory", () => {
  it("keeps reference knowledge out of personal memory", () => {
    const memories = deriveSourceMemories(source, {
      path: source.path,
      title: "我的交易模型",
      category: source.category,
      summary: "只做符合流动性模型的交易。",
      mtime: 1
    }, [{
      id: "chunk-1",
      heading: "入场纪律",
      summary: "没有确认信号不入场。",
      text: "没有确认信号不入场。"
    }], "2026-07-27T01:00:00.000Z");

    expect(memories).toEqual([]);
  });

  it("creates source-grounded episodes from personal journal data", () => {
    const journalSource = {
      ...source,
      sourceId: "source_journal",
      path: "LifeOps/Journal/2026/07/2026.07.27.md",
      category: "daily"
    };
    const memories = deriveSourceMemories(journalSource, {
      path: journalSource.path,
      title: "2026.07.27",
      category: journalSource.category,
      summary: "今天完成了跑步。",
      mtime: 1
    }, [], "2026-07-27T01:00:00.000Z");

    expect(memories[0]).toMatchObject({
      status: "active",
      memoryType: "episode",
      truth: "fact",
      origin: "source",
      domain: "daily"
    });
    expect(memories[0].evidence[0]).toMatchObject({
      sourceId: "source_journal",
      path: journalSource.path,
      contentHash: "hash-v1"
    });
  });

  it("keeps revision history when the same source memory changes", () => {
    const journalSource = { ...source, category: "daily", path: "日记/2026.07.27.md" };
    const first = deriveSourceMemories(journalSource, {
      path: journalSource.path,
      title: "日记",
      category: journalSource.category,
      summary: "旧规则。",
      mtime: 1
    }, [], "2026-07-27T01:00:00.000Z");
    const updatedSource = { ...journalSource, contentHash: "hash-v2", mtime: 2 };
    const second = deriveSourceMemories(updatedSource, {
      path: journalSource.path,
      title: "日记",
      category: journalSource.category,
      summary: "新规则。",
      mtime: 2
    }, [], "2026-07-27T02:00:00.000Z");

    const merged = mergeSourceMemories(first, journalSource.sourceId, second, "2026-07-27T02:00:00.000Z");
    expect(merged[0].content).toContain("新规则");
    expect(merged[0].history).toHaveLength(1);
    expect(merged[0].history[0].content).toContain("旧规则");
  });

  it("marks memories stale when their source is deleted", () => {
    const journalSource = { ...source, category: "daily", path: "日记/2026.07.27.md" };
    const active = deriveSourceMemories(journalSource, {
      path: journalSource.path,
      title: "日记",
      category: journalSource.category,
      summary: "交易规则。",
      mtime: 1
    }, []);
    const stale = staleSourceMemories(active, journalSource.sourceId, "source deleted");

    expect(stale.every((memory) => memory.status === "stale")).toBe(true);
    expect(stale.every((memory) => memory.validTo)).toBe(true);
  });
});
