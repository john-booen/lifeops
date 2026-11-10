import { describe, expect, it } from "vitest";
import {
  hasSourceGrounding,
  knowledgeResultsToMarkdown,
  type KnowledgeResult
} from "../src/dataFoundation/knowledgeResult";

const grounded: KnowledgeResult = {
  sourceId: "source_123",
  path: "LifeOps/Journal/2026/07/2026.07.28.md",
  title: "2026.07.28",
  category: "daily",
  excerpt: "今天完成了跑步。",
  mtime: 123456,
  score: 0.92,
  reasons: ["category:daily", "term:跑步"],
  contentHash: "hash-1"
};

describe("knowledge result", () => {
  it("requires source identity, path, timestamp and original excerpt", () => {
    expect(hasSourceGrounding(grounded)).toBe(true);
    expect(hasSourceGrounding({ ...grounded, excerpt: "" })).toBe(false);
    expect(hasSourceGrounding({ ...grounded, sourceId: "" })).toBe(false);
  });

  it("renders provenance next to the retrieved source", () => {
    const markdown = knowledgeResultsToMarkdown([grounded]);
    expect(markdown).toContain("sourceId: source_123");
    expect(markdown).toContain("contentHash: hash-1");
    expect(markdown).toContain("mtime: 123456");
    expect(markdown).toContain("今天完成了跑步");
  });
});
