import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost, VaultIndexEntry } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), requestUrl: () => { throw Error("Offline fixture"); } }));
const { scoreIndexEntry } = await import("../src/store/settingsSlice");
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const now = Date.parse("2026-10-18T00:00:00Z");
const entry = (ageDays = 0): VaultIndexEntry => ({ path: "LifeOps/Knowledge/Ideas/original.md", title: "原始资料", category: "ideas", tags: [], frontmatter: {},
  mtime: now - ageDays * 86400000, size: 10, summary: "纯虚构中性文字" });

describe("recency ranks relevant knowledge without manufacturing a match", () => {
  beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(now); });
  afterEach(() => { vi.restoreAllMocks(); });
  it.each([0, 10, 40])("leaves an unrelated %i-day-old file at zero", age => {
    const result = scoreIndexEntry(entry(age), ["nufrozyqil"], new Set());
    expect(result.score).toBe(0); expect(result.reasons).toEqual([]);
  });
  it("does not treat a recent file as a match for an empty query", () => {
    expect(scoreIndexEntry(entry(), [], new Set()).score).toBe(0);
  });
  it.each(["title", "path", "summary", "tags"] as const)("retains a real %s match and its age ordering", key => {
    const make = (age: number) => ({ ...entry(age), [key]: key === "tags" ? ["qavrenzulp"] : "qavrenzulp" });
    const fresh = scoreIndexEntry(make(0), ["qavrenzulp"], new Set()), old = scoreIndexEntry(make(40), ["qavrenzulp"], new Set());
    expect(old.score).toBeGreaterThan(0); expect(fresh.score).toBeGreaterThan(old.score);
    expect(fresh.reasons).toContain(`${key === "tags" ? "tag" : key}:qavrenzulp`);
  });
  it("preserves an intentional category match", () => {
    expect(scoreIndexEntry(entry(), [], new Set(["ideas"]))).toMatchObject({ score: 6.2, reasons: ["category:ideas"] });
  });
});

describe("actual Store local index search", () => {
  let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
  const note = "LifeOps/Knowledge/Ideas/纯虚构来源.md", privateNote = "LifeOps/Knowledge/Ideas/虚构隐私/仅测试.md", report = "LifeOps/Output/AI/仅输出.md";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lifeops-search-match-")); vault = new DiskVault(root);
    store = new LifeOpsStore({ vault } as any, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    store.settings.privacy!.excludedVaultPrefixes = ["LifeOps/Knowledge/Ideas/虚构隐私"];
    await store.initializeVault();
    await vault.seed(note, "# 纯虚构来源\n\nqavrenzulp"); await vault.seed(privateNote, "wexlunprat"); await vault.seed(report, "zebruqxam");
    await store.rebuildVaultIndex();
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it.each(["nufrozyqil", "wexlunprat", "zebruqxam"])("returns no unrelated recent files for %s", async query => {
    const before = await vault.bytes(note);
    expect(await store.searchKnowledge(query, 8)).toEqual([]);
    expect(await vault.bytes(note)).toEqual(before);
  });
  it("still returns the actual matching managed source", async () => {
    const result = await store.searchKnowledge("qavrenzulp", 8);
    expect(result).toHaveLength(1); expect(result[0].path).toBe(note); expect(result[0].excerpt).toContain("qavrenzulp");
  });
});
