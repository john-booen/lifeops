import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { ChatMessage } from "../src/ai";
import type { ProviderRequestOptions } from "../src/types";
import type { StoreHost } from "../src/store/settingsSlice";
import type { SummaryHost } from "../src/features/summaries/service";

vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Modal: class {}, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/"), parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { DiskVault } = await import("./helpers/diskVault");
const { generatePeriodSummary } = await import("../src/features/summaries/service");
const { summaryPeriod } = await import("../src/features/summaries/periods");
const { readSummary, readSummaryScope } = await import("../src/features/summaries/notes");
const { signalDocumentPath } = await import("../src/features/journal/signalStore");
const { fileRevision } = await import("../src/operationIdentity");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, host: SummaryHost;
const date = "2026-02-04", now = new Date(2026, 1, 5, 8);
const ask = vi.fn(async (_messages: ChatMessage[], options: ProviderRequestOptions) => {
  await options.beforeTextRequest?.(); return "虚构资料只说明登记情况，下一步计划仍需核对。".repeat(18);
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-summary-journal-coverage-")); vault = new DiskVault(root);
  const settings = structuredClone(DEFAULT_SETTINGS);
  Object.assign(settings.ai, { provider: "custom", endpoint: "https://synthetic.invalid", model: "synthetic", dataDisclosureAccepted: true });
  const app = { vault } as unknown as App; store = new LifeOpsStore(app, settings) as unknown as StoreHost;
  await store.initializeVault(); ask.mockClear();
  const runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
  host = { store, app, register() {}, unloaded: false, refreshViews: async () => undefined,
    async saveLocalOperation(name, args, execute, options) {
      const result = await runtime.executeLocalOperation(name, args, execute, undefined, options);
      if (!result.success) throw Error(result.output);
    },
    withAiFallback: (action, _fallback, options) => action(options ?? {}),
    observeProvider: (_stage, _source, action, signal) => action({ signal }, store as unknown as InstanceType<typeof LifeOpsStore>, { generateSummary: ask } as never,
      () => signal?.throwIfAborted(), () => undefined)
  } as SummaryHost;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const journal = (suffix = "早") => store.path(store.settings.folders.dailyRoot, "2026", "02", date + suffix + ".md");
async function currentSignal(path: string, raw: string, copies = 1) {
  const row = { date, period: "晨", energy: null, mood: null, stress: null, sleepHours: null, sleepQuality: null,
    keyEvents: [], plans: [{ text: "虚构已提取计划", when: null }], ideas: [], worries: [], quotes: [], sources: [{ path, sha256: fileRevision(raw) }] };
  await vault.seed(signalDocumentPath(store, date), JSON.stringify({ version: 1, date, 晨: Array.from({ length: copies }, () => row), 晚: [] }));
}
async function inputAndNote() {
  await generatePeriodSummary(host, summaryPeriod("day", date), now);
  return { input: JSON.parse(ask.mock.calls[0][0][1].content),
    note: await readSummary(store, summaryPeriod("day", date), (await readSummaryScope(store)).hash) };
}

it("shows an unextracted diary as unreviewed instead of treating missing signals as no plans", async () => {
  const path = store.path(store.settings.folders.dailyRoot, "2026", "02", date + "早.md");
  const raw = "# 虚构晨记\n我计划下周给紫色纸盒贴标签。这是计划，还没有做。";
  await vault.seed(path, raw);
  await generatePeriodSummary(host, summaryPeriod("day", date), now);
  const input = JSON.parse(ask.mock.calls[0][0][1].content);
  expect(input.daily.journalCoverage).toMatchObject({ journalFiles: 1, withCurrentSignals: 0, missingSignals: 1 });
  expect(JSON.stringify(input)).not.toContain("我计划下周给紫色纸盒贴标签");
  const note = await readSummary(store, summaryPeriod("day", date), (await readSummaryScope(store)).hash);
  expect(note?.text.startsWith("## 日记资料范围")).toBe(true);
  expect(note?.text).toContain("1篇日记尚未纳入整理");
  expect(note?.text).toContain("不代表原文没有计划");
  expect(await vault.bytes(path)).toBe(raw);
});

it("counts current signal sources by diary rather than by duplicate signal rows", async () => {
  const raw = "虚构晨间原文，不应自动外发。";
  await vault.seed(journal(), raw); await vault.seed(journal("晚"), "另一篇虚构原文。");
  await currentSignal(journal(), raw, 2);
  const { input, note } = await inputAndNote();
  expect(input.daily.journalCoverage).toMatchObject({ journalFiles: 2, withCurrentSignals: 1, missingSignals: 1 });
  expect(input.daily.signals).toHaveLength(2);
  expect(JSON.stringify(input)).toContain("虚构已提取计划");
  expect(JSON.stringify(input)).not.toContain(raw);
  expect(note?.text).toContain("1篇日记尚未纳入整理");
});

it("treats a stale signal as unreviewed and leaves the saved signal intact", async () => {
  const path = journal(), old = "虚构旧原话。"; await vault.seed(path, old); await currentSignal(path, old);
  const before = await vault.bytes(signalDocumentPath(store, date));
  await vault.seed(path, "虚构新原话，来源已修改。");
  const { input, note } = await inputAndNote();
  expect(input.daily.journalCoverage).toMatchObject({ journalFiles: 1, withCurrentSignals: 0, missingSignals: 1 });
  expect(input.daily.signals).toEqual([]);
  expect(note?.text).toContain("不代表原文没有计划");
  expect(await vault.bytes(signalDocumentPath(store, date))).toBe(before);
});

it("does not disclose the existence of excluded or unrelated notes", async () => {
  const path = journal(); await vault.seed(path, "虚构排除原文。"); await currentSignal(path, "虚构排除原文。");
  await vault.seed("Unmanaged/" + date + ".md", "虚构非管理目录原文。");
  await vault.seed(store.path(store.settings.folders.dailyRoot, "2026", "02", "2026-02-03早.md"), "虚构另一天原文。");
  store.settings.privacy = { ...store.settings.privacy, excludedVaultPrefixes: [path] };
  const { input, note } = await inputAndNote();
  expect(input.daily.journalCoverage).toMatchObject({ journalFiles: 0, withCurrentSignals: 0, missingSignals: 0 });
  expect(note?.text).not.toContain("## 日记资料范围");
  expect(JSON.stringify(input)).not.toMatch(/虚构排除原文|Unmanaged|非管理目录原文|另一天原文/);
});

it("keeps the code-computed coverage warning in a local fallback without a model request", async () => {
  await vault.seed(journal(), "虚构原文尚未提取。");
  host.withAiFallback = async (_action, fallback, options) => { options?.onLocalFallback?.("unavailable"); return fallback; };
  await generatePeriodSummary(host, summaryPeriod("day", date), now);
  const note = await readSummary(store, summaryPeriod("day", date), (await readSummaryScope(store)).hash);
  expect(ask).not.toHaveBeenCalled(); expect(note?.properties.generatedBy).toBe("local");
  expect(note?.text).toContain("1篇日记尚未纳入整理");
});

it("rejects a saved summary when the diary coverage changes during generation", async () => {
  await vault.seed(journal(), "虚构第一篇原文。");
  ask.mockImplementationOnce(async (_messages, options) => {
    await options.beforeTextRequest?.(); await vault.seed(journal("晚"), "虚构新增的第二篇原文。");
    return "虚构资料只说明登记情况，下一步计划仍需核对。".repeat(18);
  });
  await expect(generatePeriodSummary(host, summaryPeriod("day", date), now)).rejects.toThrow(/依据.*变化/);
  expect(await readSummary(store, summaryPeriod("day", date), (await readSummaryScope(store)).hash)).toBeUndefined();
  expect(await vault.bytes(journal("晚"))).toBe("虚构新增的第二篇原文。");
});
