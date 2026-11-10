import { describe, expect, it } from "vitest";
import { buildContextBundle, filterActiveContextBlocks, isContextBlockExpired } from "../src/contextBundle";
import type { ContextBlock } from "../src/contextBundle";

const blocks: ContextBlock[] = [
  {
    label: "Low old",
    content: "old low",
    source: "low.md",
    generatedAt: "2026-06-11T08:00:00.000Z",
    priority: "low"
  },
  {
    label: "Vision",
    content: "user is at desk",
    source: "Vision/current-state.md",
    generatedAt: "2026-06-11T08:02:00.000Z",
    expiresAt: "2026-06-11T08:03:00.000Z",
    confidence: 0.8,
    priority: "high"
  },
  {
    label: "Critical",
    content: "do not auto trade",
    source: "Memory/rules.md",
    generatedAt: "2026-06-10T08:00:00.000Z",
    priority: "critical"
  }
];

describe("contextBundle", () => {
  it("filters expired blocks and sorts by priority", () => {
    const result = buildContextBundle(blocks, { now: "2026-06-11T08:04:00.000Z" });

    expect(result.blocks.map((block) => block.label)).toEqual(["Critical", "Low old"]);
    expect(result.expiredBlocks.map((block) => block.label)).toEqual(["Vision"]);
    expect(result.markdown).toContain("do not auto trade");
    expect(result.markdown).not.toContain("user is at desk");
  });

  it("can include expired blocks with metadata", () => {
    const result = buildContextBundle(blocks, {
      now: "2026-06-11T08:04:00.000Z",
      includeExpired: true
    });

    expect(result.markdown).toContain("expired");
    expect(result.markdown).toContain("Vision");
  });

  it("detects expiration and active blocks", () => {
    expect(isContextBlockExpired(blocks[1], "2026-06-11T08:04:00.000Z")).toBe(true);
    expect(filterActiveContextBlocks(blocks, "2026-06-11T08:02:30.000Z")).toHaveLength(3);
  });
});
