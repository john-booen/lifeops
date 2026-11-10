import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { buildInjectedContext } from "../src/contextInjection";
import { createPersonalMemory, emptyPersonalMemoryDocument, reviewPersonalMemoryRecord, type PersonalMemoryRecord } from "../src/personalMemory";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const now = new Date(2026, 8, 21, 10);
const oldText = "用户在甲公司工作，并且只在上海办公室办公。";
const diaryPath = "Notes/diary.md";
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-injected-memory-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  vi.spyOn(store, "getTaskDashboard").mockResolvedValue({ tasks: [], habits: [] } as never);
  vi.spyOn(store, "getHabitDefinitions").mockResolvedValue([]);
  vi.spyOn(store, "readDailyPair").mockImplementation(() => vault.bytes(diaryPath));
  // Test the memory filter on an already projected observation. Real media
  // authorization and freshness use DiskVault in visualContextProjection.test.
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function seedAuthority(records: PersonalMemoryRecord[] = []): Promise<void> {
  await vault.seed(store.personalMemoryPath(), JSON.stringify({ ...emptyPersonalMemoryDocument(), records }));
}

function memory(decision: "correct" | "forget" | "missing"): PersonalMemoryRecord[] {
  const record = createPersonalMemory({ kind: "core_profile", content: oldText, sourceRefs: [{
    sourceId: "vault:diary", path: decision === "missing" ? "Notes/missing.md" : diaryPath,
    capturedAt: "2026-09-21T01:00:00Z"
  }] });
  return reviewPersonalMemoryRecord([record], record.id, decision === "correct"
    ? { decision, content: "用户已在乙公司工作。" } : { decision: decision === "missing" ? "confirm" : decision });
}

async function seedClippedSources(): Promise<{ diary: string; vision: string }> {
  const diary = "前".repeat(210) + oldText + "\n\n保留正常日记。";
  const vision = "视觉：" + "前".repeat(167) + oldText + "\n\n光线清晰，保留正常观察。";
  await vault.seed(diaryPath, diary);
  await vault.seed(store.visionStatePath(), vision);
  return { diary, vision };
}

describe("injected source excerpts respect full personal-memory evidence", () => {
  it.each(["correct", "forget", "missing"] as const)("filters before the diary's 220-char boundary after %s", async decision => {
    const raw = await seedClippedSources();
    await seedAuthority(memory(decision));
    const context = await buildInjectedContext(store, now);
    expect(context.recentContext.lastJournalSummary).not.toContain("甲公司");
    expect(context.recentContext.lastJournalSummary).toContain("保留正常日记");
    expect(await vault.bytes(diaryPath)).toBe(raw.diary);
    expect(vault.writes).toEqual([]);
  });

  it.each(["correct", "forget", "missing"] as const)("filters before the observation's 180-char boundary after %s", async decision => {
    const raw = await seedClippedSources();
    await seedAuthority(memory(decision));
    const context = await buildInjectedContext(store, now);
    expect(await vault.bytes(store.visionStatePath())).toBe(raw.vision);
    expect(vault.writes).toEqual([]);
  });

  it("assesses both excerpts after source reads so a concurrent forgetting protects both", async () => {
    const raw = await seedClippedSources();
    await seedAuthority();
    vi.mocked(store.readDailyPair).mockImplementationOnce(async () => {
      await seedAuthority(memory("forget"));
      return raw.diary;
    });
    const context = await buildInjectedContext(store, now);
    expect(context.recentContext.lastJournalSummary).not.toContain("甲公司");
  });

  it.each(["{broken", '{"version":99,"records":[]}'])("does not return unfiltered excerpts when authority is invalid: %s", async authority => {
    await seedClippedSources();
    await vault.seed(store.personalMemoryPath(), authority);
    await expect(buildInjectedContext(store, now)).rejects.toThrow();
    expect(vault.writes).toEqual([]);
  });

  it("withholds historical excerpts when authority is absent", async () => {
    await seedClippedSources();
    const context = await buildInjectedContext(store, now);
    expect(context.recentContext.lastJournalSummary).toBe("");
    expect(vault.writes).toEqual([]);
  });

  it("retains unrelated history with valid empty authority and never rewrites source text", async () => {
    await seedAuthority();
    await vault.seed(diaryPath, "今日用户输入：我想整理资料。");
    await vault.seed(store.visionStatePath(), "光线明亮，桌面清晰。");
    const context = await buildInjectedContext(store, now);
    expect(context.recentContext.lastJournalSummary).toBe("今日用户输入：我想整理资料。");
    expect(vault.writes).toEqual([]);
  });
});
