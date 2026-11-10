import { describe, expect, it } from "vitest";
import {
  findLatestJournalFiles,
  findJournalFilesForDate,
  isLatestJournalRequest,
  isJournalPath,
  journalDateFromPath,
  journalPeriodFromPath
} from "../src/journalResolver";

const root = "LifeOps/Journal";

describe("journal resolver", () => {
  it("treats every nested markdown file under the configured root as a journal path", () => {
    expect(isJournalPath("LifeOps/Journal/2026/07/2026.07.16.md", root)).toBe(true);
    expect(isJournalPath("LifeOps/Knowledge/2026.07.16.md", root)).toBe(false);
  });

  it.each([
    ["LifeOps/Journal/2026/07/2026.07.16.md", "2026-07-16"],
    ["LifeOps/Journal/2026/07/2026-07-16早.md", "2026-07-16"],
    ["LifeOps/Journal/2026/07/2026年7月16日.md", "2026-07-16"],
    ["LifeOps/Journal/2026/07/7月16日.md", "2026-07-16"],
    ["LifeOps/Journal/2026/07/16日复盘.md", "2026-07-16"]
  ])("extracts the journal date from %s", (path, expected) => {
    expect(journalDateFromPath(path, root)).toBe(expected);
  });

  it("keeps descriptive suffixes and rejects invalid dates", () => {
    expect(journalDateFromPath("LifeOps/Journal/2026/03/2026-03-19月反思.md", root)).toBe("2026-03-19");
    expect(journalDateFromPath("LifeOps/Journal/2026/02/2026.02.31.md", root)).toBeNull();
  });

  it("returns every article for the date in morning, plain, evening order", () => {
    const files = [
      { path: "LifeOps/Journal/2026/07/2026-07-16晚复盘.md" },
      { path: "LifeOps/Journal/2026/07/2026.07.16.md" },
      { path: "LifeOps/Journal/2026/07/2026-07-16早.md" },
      { path: "LifeOps/Journal/2026/07/2026-07-15早.md" }
    ];

    expect(findJournalFilesForDate(files, root, "2026-07-16").map((file) => file.path)).toEqual([
      "LifeOps/Journal/2026/07/2026-07-16早.md",
      "LifeOps/Journal/2026/07/2026.07.16.md",
      "LifeOps/Journal/2026/07/2026-07-16晚复盘.md"
    ]);
    expect(journalPeriodFromPath(files[0].path)).toBe("晚");
  });

  it("uses the requested year when the hierarchy only contains a month folder", () => {
    const files = [{ path: "LifeOps/Journal/7月/7月16日.md" }];
    expect(findJournalFilesForDate(files, root, "2026-07-16")).toEqual(files);
  });

  it("finds the latest journal by journal date and prefers evening over morning", () => {
    const files = [
      { path: "LifeOps/Journal/2026/07/2026-07-27早.md", mtime: 300 },
      { path: "LifeOps/Journal/2026/07/2026-07-27晚.md", mtime: 100 },
      { path: "LifeOps/Journal/2026/07/2026-07-25晚.md", mtime: 500 },
      { path: "LifeOps/Knowledge/2026-08-01.md", mtime: 900 }
    ];

    expect(findLatestJournalFiles(files, root).map((file) => file.path)).toEqual([
      "LifeOps/Journal/2026/07/2026-07-27晚.md",
      "LifeOps/Journal/2026/07/2026-07-27早.md",
      "LifeOps/Journal/2026/07/2026-07-25晚.md"
    ]);
  });

  it("distinguishes the latest journal from a bounded recent-days query", () => {
    expect(isLatestJournalRequest("请读取我最后一篇日记")).toBe(true);
    expect(isLatestJournalRequest("我上一次写的日记是哪天")).toBe(true);
    expect(isLatestJournalRequest("总结最近 7 天的日记")).toBe(false);
  });
});
