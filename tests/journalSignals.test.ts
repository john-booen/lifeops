import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../src/ai";
import { addDays, formatDate } from "../src/date";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { LifeOpsEventBus } from "../src/lifeOpsEventBus";
import { fileRevision } from "../src/operationIdentity";
import type { StoreHost } from "../src/store/settingsSlice";
import type { ProviderRequestOptions } from "../src/types";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}));

const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { AgentRuntime } = await import("../src/agentRuntime");
const { buildResidentContext } = await import("../src/agent/context");
const { extractJournalSignal, readJournalSignals, signalDocumentPath } = await import("../src/features/journal/signalStore");
const { JournalSignalLifecycle } = await import("../src/features/journal/signalLifecycle");
const now = new Date(2026, 10, 12, 20, 0), date = formatDate(now);
const morning = `${DEFAULT_SETTINGS.folders.dailyRoot}/${date}早.md`;
const evening = `${DEFAULT_SETTINGS.folders.dailyRoot}/${date}晚.md`;
const morningText = "昨晚睡了5.5小时，今天很累。计划跑5公里。见客户。";

function answer(date: string, period: "晨" | "晚", values = {}) {
  return JSON.stringify({ date, period, ...values });
}

describe("journal signals with actual vault files", () => {
  let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
  let lifecycle: InstanceType<typeof JournalSignalLifecycle> | undefined;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    root = await mkdtemp(join(tmpdir(), "lifeops-journal-signals-"));
    vault = new DiskVault(root);
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.ai = { ...settings.ai, provider: "openai-compatible", endpoint: "https://example.invalid/chat", dataDisclosureAccepted: true };
    store = new LifeOpsStore({ vault } as unknown as App, settings) as unknown as StoreHost;
    await store.initializeVault();
  });

  afterEach(async () => {
    lifecycle?.stop();
    lifecycle = undefined;
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  const noChanges = () => {};
  const signal = () => new AbortController().signal;

  it("keeps morning and evening separately, grounds fields and plans, and skips unchanged originals", async () => {
    await vault.seed(morning, morningText);
    await vault.seed(evening, "今晚心情好。");
    const request = vi.fn()
      .mockResolvedValueOnce(answer(date, "晨", {
        energy: 2, sleepHours: 5.5, mood: 1, stress: 3,
        quotes: [{ field: "energy", text: "今天很累" }, { field: "sleepHours", text: "昨晚睡了5.5小时" },
          { field: "mood", text: "原文没有的话" }],
        plans: [{ text: "跑5公里", when: "今天" }, { text: "编造的计划" }],
        keyEvents: ["见客户", "编造的事件"]
      }))
      .mockResolvedValueOnce(answer(date, "晚", { mood: 4, quotes: [{ field: "mood", text: "今晚心情好" }] }));
    expect(await extractJournalSignal(store, morning, "2026", request, signal(), noChanges)).toBe("saved");
    expect(await extractJournalSignal(store, evening, "2026", request, signal(), noChanges)).toBe("saved");
    expect(await extractJournalSignal(store, morning, "2026", request, signal(), noChanges)).toBe("skipped");
    expect(request).toHaveBeenCalledTimes(2);
    expect(await vault.bytes(morning)).toBe(morningText);
    expect(await vault.bytes(evening)).toBe("今晚心情好。");
    const document = JSON.parse(await vault.bytes(signalDocumentPath(store, date)));
    expect(document).toMatchObject({
      晨: [{ energy: 2, sleepHours: 5.5, mood: null, stress: null, keyEvents: ["见客户"], plans: [{ text: "跑5公里", when: "今天" }],
        sources: [{ path: morning, sha256: fileRevision(morningText) }] }],
      晚: [{ mood: 4, energy: null, sources: [{ path: evening }] }]
    });
    const resident = await buildResidentContext(store, "我今天状态如何", now);
    expect(resident.text).toContain("精力 2，情绪 4，睡眠小时 5.5");
    const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    const stats = await runtime.executeAiToolCall({ name: "get_stats", arguments: { domain: "journal", range: "today" } }, "kimi");
    expect(stats.success, stats.output).toBe(true);
    expect(JSON.parse(stats.output)).toMatchObject({
      count: 2, signalAverages: { energy: 2, mood: 4, sleepHours: 5.5 },
      groups: [{ date, count: 2, signalAverages: { energy: 2 } }]
    });
    await store.createTask({ title: "长任务", date, estimateMin: 100 });
    const plan = await runtime.executeAiToolCall({ name: "plan_today", arguments: {} }, "kimi");
    expect(JSON.parse(plan.output).tasks[0].reasons).toContain("精力偏低，长任务后排");
    store.settings.privacy!.excludedVaultPrefixes = [morning];
    expect((await readJournalSignals(store, date)).map(note => note.period)).toEqual(["晚"]);
    expect((await buildResidentContext(store, "今天状态", now)).text).not.toContain("精力 2");
  });

  it("limits the text sent per note, retries invalid JSON once and preserves a previous result after two failures", async () => {
    const oversized = "虚".repeat(5999) + "🙂不会发送";
    await vault.seed(morning, oversized);
    const request = vi.fn()
      .mockResolvedValueOnce("坏 JSON")
      .mockResolvedValueOnce(answer(date, "晨"));
    expect(await extractJournalSignal(store, morning, "2026", request, signal(), noChanges)).toBe("saved");
    expect(request).toHaveBeenCalledTimes(2);
    const text = request.mock.calls[1][0][1].content.split("\n\n").at(-1);
    expect([...text]).toHaveLength(6000);
    expect(text).toMatch(/🙂$/u);
    expect(text).not.toContain("不会发送");
    const outputPath = signalDocumentPath(store, date), original = await vault.bytes(outputPath);
    await vault.seed(morning, "日记改了一行");
    const invalid = vi.fn().mockResolvedValue("坏 JSON");
    expect(await extractJournalSignal(store, morning, "2026", invalid, signal(), noChanges)).toBe("invalid");
    expect(invalid).toHaveBeenCalledTimes(2);
    expect(await vault.bytes(outputPath)).toBe(original);
  });

  it("rejects a source changed after the model call and ignores excluded sources before any request", async () => {
    await vault.seed(morning, morningText);
    const request = vi.fn(async (_messages: ChatMessage[], options: ProviderRequestOptions) => {
      await options.beforeTextRequest?.();
      await vault.seed(morning, morningText + "\n同步的新文字");
      return answer(date, "晨");
    });
    await expect(extractJournalSignal(store, morning, "2026", request, signal(), noChanges)).rejects.toThrow("新修改");
    expect(store.getFile(signalDocumentPath(store, date))).toBeNull();
    expect(await vault.bytes(morning)).toContain("同步的新文字");
    store.settings.privacy!.excludedVaultPrefixes = [morning];
    expect(await extractJournalSignal(store, morning, "2026", request, signal(), noChanges)).toBe("skipped");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps a malformed output file intact and stops before sending any original", async () => {
    const output = signalDocumentPath(store, date);
    await vault.seed(morning, morningText);
    await vault.seed(output, "{坏数据");
    const request = vi.fn();
    await expect(extractJournalSignal(store, morning, "2026", request, signal(), noChanges)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(await vault.bytes(output)).toBe("{坏数据");
  });

  it("skips unapproved egress and records only a failure code after invalid JSON retries", async () => {
    await vault.seed(morning, morningText);
    store.settings.ai.dataDisclosureAccepted = false;
    const request = vi.fn().mockResolvedValue("不能解析的模型文本");
    lifecycle = new JournalSignalLifecycle(() => store, new LifeOpsEventBus(), request);
    lifecycle.start();
    expect(request).not.toHaveBeenCalled();
    store.settings.ai.dataDisclosureAccepted = true;
    lifecycle.restart();
    await vi.waitFor(async () => {
      expect(await vault.bytes(store.qualityLogPath())).toContain("journal_signal_invalid");
    });
    expect(request).toHaveBeenCalledTimes(2);
    const log = await vault.bytes(store.qualityLogPath());
    expect(log).not.toContain(morningText);
    expect(log).not.toContain("不能解析的模型文本");
    expect(store.getFile(signalDocumentPath(store, date))).toBeNull();
  });

  it("backfills exactly 30 days, debounces edits for two minutes, and checks at 23:30", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(2026, 10, 12, 23, 25));
    const previous = addDays(date, -29), tooOld = addDays(date, -30);
    await vault.seed(`${store.settings.folders.dailyRoot}/${previous}早.md`, "最近30天");
    await vault.seed(`${store.settings.folders.dailyRoot}/${tooOld}早.md`, "超过30天");
    const events = new LifeOpsEventBus();
    const request = vi.fn(async (messages: ChatMessage[]) => {
      const content = messages[1].content;
      const day = content.slice(3, 13);
      return answer(day, content.includes("时段 晚") ? "晚" : "晨");
    });
    lifecycle = new JournalSignalLifecycle(() => store, events, request);
    lifecycle.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(store.getFile(signalDocumentPath(store, previous))).toBeTruthy());
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.getFile(signalDocumentPath(store, tooOld))).toBeNull();

    await vault.seed(morning, morningText);
    events.publish({ type: "vault.created", source: "vault", payload: { path: morning } });
    await vi.advanceTimersByTimeAsync(60_000);
    await vault.seed(morning, morningText + "又写一行");
    events.publish({ type: "vault.modified", source: "vault", payload: { path: morning } });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(store.getFile(signalDocumentPath(store, date))).toBeTruthy());
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0][1].content).toContain("又写一行");

    await vault.seed(evening, "晚间补跑");
    await vi.advanceTimersByTimeAsync(new Date(2026, 10, 12, 23, 30).getTime() - Date.now());
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls[2][0][1].content).toContain("晚间补跑");
    await vi.waitFor(async () => expect((await readJournalSignals(store, date)).some(note => note.period === "晚")).toBe(true));
    lifecycle.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
