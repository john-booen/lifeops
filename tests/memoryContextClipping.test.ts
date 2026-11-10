import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { activityNotePath } from "../src/activityRecords";
import { createPersonalMemory, emptyPersonalMemoryDocument, reviewPersonalMemoryRecord } from "../src/personalMemory";
import type { StoreHost, KnowledgeTopic } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
const oldText = "用户在甲公司工作，并且只在上海办公室办公。";
const sourcePath = "Notes/source.md";
const source = { sourceId: "vault:source", path: sourcePath, capturedAt: "2026-09-16T10:00:00Z" };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-memory-clipping-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function seed(decision: "correct" | "forget", boundary: number): Promise<string> {
  const record = createPersonalMemory({ kind: "core_profile", content: oldText, sourceRefs: [source] });
  const records = reviewPersonalMemoryRecord([record], record.id, decision === "forget" ? { decision } : { decision, content: "用户已在乙公司工作" });
  await vault.seed(store.personalMemoryPath(), JSON.stringify({ ...emptyPersonalMemoryDocument(), records }));
  const text = "前".repeat(boundary - 10) + oldText + "\n\n保留这一段正常资料。";
  await vault.seed(sourcePath, text);
  return text;
}

describe("filter complete source before automatic context clipping", () => {
  it.each(["correct", "forget"] as const)("protects the 700-char conversation boundary after %s without changing source", async decision => {
    const raw = await seed(decision, 700);
    const context = await store.readRecentMarkdownContext("Notes", 1, 700);
    expect(context).not.toContain("甲公司");
    expect(context).toContain("保留这一段正常资料");
    expect(await vault.bytes(sourcePath)).toBe(raw);
  });

  it.each(["correct", "forget"] as const)("protects the 1800-char semantic boundary after %s", async decision => {
    const raw = await seed(decision, 1800);
    const file = store.getFile(sourcePath)!;
    await store.writeJson(store.vectorIndexPath(), { generatedAt: source.capturedAt, model: "test", entries: [
      { path: sourcePath, title: "source", category: "notes", mtime: file.stat.mtime, summary: "", embedding: [1, 0] }
    ] });
    const context = await store.buildSemanticContext([1, 0]);
    expect(context).not.toContain("甲公司");
    expect(context).toContain("保留这一段正常资料");
    expect(await vault.bytes(sourcePath)).toBe(raw);
  });

  it.each(["correct", "forget"] as const)("protects retrieval excerpts after %s while preserving explicit source search", async decision => {
    const raw = await seed(decision, 1800);
    await store.syncVaultSources();
    const context = await store.buildRetrievalContext("甲公司");
    expect(context).not.toContain("甲公司");
    expect(context).toContain("保留这一段正常资料");
    const direct = await store.searchKnowledge("甲公司");
    expect(direct.some(result => result.excerpt.includes("甲公司"))).toBe(true);
    expect(await vault.bytes(sourcePath)).toBe(raw);
  });

  it("rebuilds graph excerpt and its previously clipped summary from the protected source", async () => {
    const raw = await seed("forget", 900);
    await store.writeJson(store.chunkIndexPath(), { generatedAt: source.capturedAt, chunks: [{
      id: "test", path: sourcePath, title: "source", category: "notes", heading: "source", order: 0,
      keywords: ["公司"], summary: "用户在甲公司工作", text: raw, mtime: 1
    }] });
    const context = await store.buildKnowledgeGraphContext("公司");
    expect(context).not.toContain("甲公司");
    expect(context).toContain("保留这一段正常资料");
    expect(await vault.bytes(sourcePath)).toBe(raw);
  });

  it("filters before the 420-char topic summary even when its source excerpt is shorter", async () => {
    const raw = await seed("forget", 420 - "source: ".length);
    const topic: KnowledgeTopic = { topic: "source", description: "test", folder: "Notes", keywords: ["公司"], maxFiles: 1, maxCharsPerFile: 100 };
    const context = await store.buildKnowledgeTopicContext(topic, "公司");
    expect(context).not.toContain("甲公司");
    expect(context).toContain("保留这一段正常资料");
    expect(await vault.bytes(sourcePath)).toBe(raw);
  });

  it("filters recent daily text before its 1200-char excerpt", async () => {
    const raw = await seed("forget", 1200);
    vi.spyOn(store, "readDailyPair").mockResolvedValueOnce(raw).mockResolvedValue("");
    const context = await store.buildRecentDailyContext("2026-09-16");
    expect(context).not.toContain("甲公司");
    expect(context).toContain("保留这一段正常资料");
  });

  it.each(["correct", "forget"] as const)("protects task activity and the daily review context before the 1600-char boundary after %s", async decision => {
    await store.initializeVault();
    const raw = await seed(decision, 1600);
    const path = activityNotePath(store, "tasks", "2026-09-15");
    await vault.seed(path, raw);
    for (const context of [await store.buildTaskContext("2026-09-16"), await store.buildContext("2026-09-16")]) {
      expect(context).not.toContain("甲公司");
      expect(context).toContain("保留这一段正常资料");
      expect(context).toContain("不代表任务数据库已完成");
    }
    expect(await vault.bytes(path)).toBe(raw);
  });
});
