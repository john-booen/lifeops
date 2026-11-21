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

it("shows an unextracted diary as unreviewed instead of treating missing signals as no plans", async () => {
  const path = store.path(store.settings.folders.dailyRoot, "2026", "02", date + "早.md");
  const raw = "# 虚构晨记\n我计划下周给紫色纸盒贴标签。这是计划，还没有做。";
  await vault.seed(path, raw);
  await generatePeriodSummary(host, summaryPeriod("day", date), now);
  const input = JSON.parse(ask.mock.calls[0][0][1].content);
  expect(input.daily.journalCoverage).toMatchObject({ journalFiles: 1, withCurrentSignals: 0, missingSignals: 1 });
  expect(JSON.stringify(input)).not.toContain("我计划下周给紫色纸盒贴标签");
  const note = await readSummary(store, summaryPeriod("day", date), (await readSummaryScope(store)).hash);
  expect(note?.text).toContain("1篇日记尚无当前可用提取信号");
  expect(note?.text).toContain("不代表原文没有计划");
  expect(await vault.bytes(path)).toBe(raw);
});
