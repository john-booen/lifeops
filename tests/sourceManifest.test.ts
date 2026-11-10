import { describe, expect, it } from "vitest";
import {
  emptySourceManifest,
  markSourceDeleted,
  renameSource,
  sourceNeedsProcessing,
  upsertSource
} from "../src/dataFoundation/sourceManifest";

describe("source manifest", () => {
  it("uses content hashes to distinguish metadata-only changes from source changes", () => {
    const first = upsertSource(emptySourceManifest(), {
      path: "LifeOps/Knowledge/交易模型.md",
      category: "trading-models",
      content: "只做符合模型的交易。",
      mtime: 1,
      size: 10
    }, "2026-07-27T00:00:00.000Z");
    const metadataOnly = upsertSource(first.manifest, {
      path: "LifeOps/Knowledge/交易模型.md",
      category: "trading-models",
      content: "只做符合模型的交易。",
      mtime: 2,
      size: 10
    }, "2026-07-27T00:01:00.000Z");

    expect(first.changed).toBe(true);
    expect(metadataOnly.changed).toBe(false);
    expect(metadataOnly.entry.mtime).toBe(2);
  });

  it("preserves a stable source id across renames", () => {
    const first = upsertSource(emptySourceManifest(), {
      path: "LifeOps/Knowledge/旧名字.md",
      category: "knowledge",
      content: "内容",
      mtime: 1,
      size: 2
    });
    const renamed = renameSource(first.manifest, "LifeOps/Knowledge/旧名字.md", "LifeOps/Knowledge/新名字.md");

    expect(renamed.entry?.sourceId).toBe(first.entry.sourceId);
    expect(renamed.entry?.previousPaths).toContain("LifeOps/Knowledge/旧名字.md");
    expect(renamed.entry?.contentHash).toBe("");
  });

  it("marks deleted sources and their derived vectors stale", () => {
    const first = upsertSource(emptySourceManifest(), {
      path: "日记/2026-07-27晚.md",
      category: "journal",
      content: "晚间日记",
      mtime: 1,
      size: 4
    });
    const deleted = markSourceDeleted(first.manifest, first.entry.path);

    expect(deleted.entry?.status).toBe("deleted");
    expect(deleted.entry?.vectorStatus).toBe("stale");
  });

  it("uses mtime and size as a cheap preflight before reading content", () => {
    const first = upsertSource(emptySourceManifest(), {
      path: "a.md",
      category: "other",
      content: "A",
      mtime: 10,
      size: 1
    });

    expect(sourceNeedsProcessing(first.entry, { mtime: 10, size: 1 })).toBe(false);
    expect(sourceNeedsProcessing(first.entry, { mtime: 11, size: 1 })).toBe(true);
  });
});
