import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { buildResidentContext } from "../src/agent/context";
import { AgentRuntime } from "../src/agentRuntime";
import { ACCOUNTABILITY_BOUNDARY, acknowledgeAccountability, hasPendingAccountability } from "../src/accountability";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-accountability-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const path = () => store.path(store.settings.folders.habits, "Punishments.md");
describe("accountability and review", () => {
  it("initializes neutral reminders without modifying an existing historical note", async () => {
    await store.initializeVault();
    expect(await vault.bytes(path())).toContain("# 责任与复盘记录");
    const old = "# 惩罚记录\n\n用户原始历史内容\n- [ ] 接受惩罚\n";
    await vault.seed(path(), old); await store.initializeVault();
    expect(await vault.bytes(path())).toBe(old);
  });
  it("acknowledges an existing review reminder without changing habits and supports undo", async () => {
    await store.initializeVault();
    const before = await vault.bytes(store.habitDbPath());
    const previous = "# 责任与复盘记录\n\n- [ ] 确认复盘提醒\n- 原因：reading incomplete\n";
    await vault.seed(path(), previous);
    const runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
    expect(await store.hasOpenPunishment()).toBe(true);
    expect((await runtime.executeLocalOperation("acknowledge", {}, scope => scope.acceptPunishments())).success).toBe(true);
    expect(await store.hasOpenPunishment()).toBe(false);
    expect(await vault.bytes(store.habitDbPath())).toBe(before);
    await runtime.undoLatestOperation(); expect(await vault.bytes(path())).toBe(previous);
  });
  it.each(["\n", "\r\n"])("closes legacy reminders without claiming physical punishment occurred (%j)", async newline => {
    const old = ["# Legacy", "- [ ] 接受惩罚", "- 原因：old reason", "my notes", ""].join(newline);
    expect(hasPendingAccountability(old)).toBe(true);
    const next = acknowledgeAccountability(old);
    expect(next).toContain("不代表接受或执行身体惩罚");
    expect(next).toContain("- 原因：old reason" + newline + "my notes" + newline);
    expect(hasPendingAccountability(next)).toBe(false);
    expect(acknowledgeAccountability(next)).toBe(next);
  });
  it.each(["text", "voice"] as const)("keeps the non-harm boundary in the %s model context", async source => {
    expect((await buildResidentContext(store, "虚构习惯复盘", new Date(), source)).text).toContain(ACCOUNTABILITY_BOUNDARY);
  });
  it("connects the boundary to text and realtime prompt builders without punitive UI labels", async () => {
    for (const file of ["src/ai.ts", "src/bailianRealtime.ts", "src/voice/voiceRealtime.ts"]) {
      const text = await readFile(file, "utf8"); expect(text.match(/ACCOUNTABILITY_BOUNDARY/g)!.length).toBeGreaterThan(1);
    }
    for (const file of ["src/main.ts", "src/agent/service.ts", "src/features/habits/service.ts", "src/features/review/service.ts", "src/modals.ts", "src/panel/statusBar.ts"]) {
      expect(await readFile(file, "utf8")).not.toMatch(/接受惩罚|惩罚提醒|惩罚阈值|惩罚已触发/);
    }
  });
});
