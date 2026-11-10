import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { readJournalContext } from "../src/journalContext";
import { buildInjectedContext } from "../src/contextInjection";
import { getCommittedContextEvidence } from "../src/agentRuntime";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store"), { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, now: Date, date: string, morning: string, evening: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-journal-context-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; await store.initializeVault(); now = new Date(); date = now.toLocaleDateString("sv-SE"); morning = store.dailyNotePath(date, "早"); evening = store.dailyNotePath(date, "晚"); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("controlled journal context snapshots", () => {
  it("preserves morning/evening layout and legacy names without writing or repairing", async () => {
    const legacy = store.path(store.settings.folders.dailyRoot, date.slice(0, 4), `${Number(date.slice(5, 7))}月`, `${Number(date.slice(8))}日.md`);
    await vault.seed(morning, "虚构晨间原文"); await vault.seed(evening, "虚构晚间原文"); await vault.seed(legacy, "虚构旧文件原文"); const before = vault.writes.length;
    const snapshot = await readJournalContext(store, date); expect(snapshot.files.map(file => file.path)).toEqual([morning, legacy, evening]);
    expect(snapshot.text).toContain("虚构晨间原文"); expect(snapshot.text).toContain("虚构旧文件原文"); expect(await store.readDailyPair(date)).toBe(snapshot.text); expect(vault.writes).toHaveLength(before);
  });
  it("never reads an excluded diary and keeps its original bytes", async () => {
    await vault.seed(morning, "不得发送的虚构晨间原文"); await vault.seed(evening, "允许的虚构晚间原文"); store.settings.privacy!.excludedVaultPrefixes = [morning];
    const read = vi.spyOn(store, "readPath"), context = await buildInjectedContext(store, now);
    expect(context.recentContext.lastJournalSummary).not.toContain("不得发送"); expect(context.recentContext.lastJournalSummary).toContain("允许"); expect(read.mock.calls.some(([path]) => path === morning)).toBe(false); expect(await vault.bytes(morning)).toBe("不得发送的虚构晨间原文");
  });
  it.each(["privacy", "root"])("rejects a %s replacement while the diary raw read awaits", async kind => {
    await vault.seed(morning, "不得迟到发送的原文"); const read = store.readPath.bind(store);
    vi.spyOn(store, "readPath").mockImplementation(async path => { const raw = await read(path); if (path === morning) { if (kind === "privacy") store.settings.privacy!.excludedVaultPrefixes = [morning]; else store.settings.folders.dailyRoot = "更改后日记目录"; } return raw; });
    await expect(readJournalContext(store, date)).rejects.toThrow("权限或目录变化"); expect(await vault.bytes(morning)).toBe("不得迟到发送的原文");
  });
});
