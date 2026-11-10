import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { ProactiveLifecycle } from "../src/proactiveLifecycle";
vi.mock("obsidian", () => ({ Notice: class {}, setIcon: vi.fn(), requestUrl: vi.fn() }));
const { requestUrl } = await import("obsidian");
const { LifeOpsAi } = await import("../src/ai");
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("experimental default-off runtime locks", () => {
  it("does not request providers, devices, capture permissions or notifications with fresh settings", async () => {
    vi.useFakeTimers(); const getUserMedia = vi.fn(); vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const ai = new LifeOpsAi(structuredClone(DEFAULT_SETTINGS));
    await expect(ai.getEmbedding("synthetic")).rejects.toThrow();
    expect(getUserMedia).not.toHaveBeenCalled(); expect(requestUrl).not.toHaveBeenCalled();
    expect(DEFAULT_SETTINGS.proactive).toMatchObject({ enabled: true, highPriorityVoiceEnabled: false, systemNotificationsEnabled: false });
    expect(DEFAULT_SETTINGS.vision).toMatchObject({ cameraEnabled: false, cameraMode: "off", screenEnabled: false });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not subscribe or allocate timers while proactive support is off", () => {
    vi.useFakeTimers(); const run = vi.fn(), subscribe = vi.fn(() => vi.fn()); const lifecycle = new ProactiveLifecycle(run, subscribe);
    lifecycle.setEnabled(false); lifecycle.schedule(); vi.advanceTimersByTime(600_000);
    expect(subscribe).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels timers, unsubscribes and invalidates old work across disable/re-enable", () => {
    vi.useFakeTimers(); const run = vi.fn(), unsubscribe = vi.fn(); let notify!: () => void;
    const subscribe = vi.fn(callback => { notify = callback; return unsubscribe; }); const lifecycle = new ProactiveLifecycle(run, subscribe);
    lifecycle.setEnabled(true); const old = lifecycle.generation; notify(); expect(vi.getTimerCount()).toBe(2);
    lifecycle.setEnabled(false); expect(unsubscribe).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(lifecycle.isCurrent(old)).toBe(false); vi.advanceTimersByTime(600_000); expect(run).not.toHaveBeenCalled();
    lifecycle.setEnabled(true); lifecycle.setEnabled(true); expect(subscribe).toHaveBeenCalledTimes(2);
    expect(lifecycle.isCurrent(old)).toBe(false); notify(); vi.advanceTimersByTime(2_000); expect(run).toHaveBeenCalledOnce(); lifecycle.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it("wires load/save/unload to lifecycle locks and labels experimental/excluded controls", () => {
    const main = readFileSync("src/main.ts", "utf8"), settings = readFileSync("src/settingsTab.ts", "utf8");
    expect(main.match(/proactiveLifecycle.setEnabled/g)).toHaveLength(2); expect(main).toContain("this.proactiveLifecycle.stop()");
    expect(main).not.toContain("proactiveEventTimer");
    expect(settings).toContain("Experimental"); expect(settings).toContain("Excluded");
    expect(settings).not.toContain('setName("允许高优先级主动语音")');
  });
});
