import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { ProviderRunFailure, providerRunStart } from "../src/providerRun";
import type { AiChatResult } from "../src/ai";
import type { OperationLedgerDocument } from "../src/dataFoundation/operationLedger";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {},
  Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: vi.fn(),
  parseYaml: JSON.parse, stringifyYaml: JSON.stringify
}));
const { createFsApp } = await import("./helpers/fsApp");
const { LifeOpsStore } = await import("../src/store");
const { LifeOpsAi } = await import("../src/ai");
const { default: Plugin } = await import("../src/main");
let root = "";
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  if (root) await rm(root, { recursive: true, force: true });
});

it("preserves useful read-only month statistics when the subsequent model answer is incomplete", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-12T12:00:00+08:00"));
  root = await mkdtemp(join(tmpdir(), "lifeops-read-only-recovery-"));
  const app = createFsApp(root), settings = structuredClone(DEFAULT_SETTINGS);
  settings.ai = { ...settings.ai, provider: "custom", endpoint: "https://fictional.invalid", model: "synthetic-read-only",
    apiKey: "fictional-fixture-key", fallbackProvider: "off", dataDisclosureAccepted: true };
  settings.privacy = { ...settings.privacy, plaintextCredentialStorageAccepted: true, excludedVaultPrefixes: [] };
  const store = new LifeOpsStore(app, settings) as unknown as StoreHost; await store.initializeVault();
  const completed = await store.createTask({ title: "虚构十月纸样", date: "2026-10-04" });
  await store.updateTask(completed.id, row => ({ ...row, createdAt: "2026-10-04T08:00:00+08:00",
    status: "completed", completedAt: "2026-10-05T17:00:00+08:00" }));
  await store.createTask({ title: "虚构十一月纸盒", date: "2026-11-04" });
  const before = await store.readPath(store.taskDbPath());
  const run = providerRunStart(settings.ai); run.status = "failed";
  const interrupted = new ProviderRunFailure(run, "response_incomplete");
  const turn: AiChatResult = { content: "", toolCalls: [
    { id: "fictional-october-read", name: "get_stats", arguments: { domain: "tasks", range: { from: "2026-10-01", to: "2026-10-31" } } },
    { id: "fictional-november-read", name: "get_stats", arguments: { domain: "tasks", range: { from: "2026-11-01", to: "2026-11-12" } } }
  ] };
  const model = vi.spyOn(LifeOpsAi.prototype, "agentTurnStream").mockRejectedValue(interrupted).mockResolvedValueOnce(turn);
  const plugin = Object.assign(Object.create(Plugin.prototype), {
    app, store, settings: store.settings, lifecycleGeneration: 1, unloaded: false,
    ai: new LifeOpsAi(store.settings), updateStatusBar: async () => {}, refreshViews: async () => {},
    lifeOpsEvents: { publish: () => {} }, buildSemanticContext: async () => ""
  }) as InstanceType<typeof Plugin>;
  let result: Awaited<ReturnType<typeof plugin.submitAgentMessageStream>> | undefined, failure: unknown;
  try {
    result = await plugin.submitAgentMessageStream("对照这个月与上个月的任务完成情况和交易净盈亏，分别列区间和任务数，人民币和美元分开，不保存任何记录。", [], undefined, { source: "text" });
  } catch (error) { failure = error; }
  expect(await store.readPath(store.taskDbPath())).toBe(before);
  expect(model).toHaveBeenCalledTimes(2);
  const ledger = await store.readJson<OperationLedgerDocument>(store.path(settings.folders.aiReports, "Operations", "operation-ledger.json"), { version: 1, records: [] });
  const reads = ledger.records.filter(row => row.toolName === "get_stats" && row.status === "verified");
  expect(reads).toHaveLength(2);
  expect(reads.map(row => JSON.parse(row.result!.output).plannedCount)).toEqual([1, 1]);
  expect(failure, "The statistics succeeded; a later incomplete model response must not discard them.").toBeUndefined();
  expect(result?.actions).toEqual([]); expect(result?.receipts ?? []).toEqual([]);
  for (const value of ["2026-10-01", "2026-10-31", "2026-11-01", "2026-11-12", "100%", "0%"]) expect(result?.reply).toContain(value);
  expect(result?.reply).toMatch(/中断|未完成/);
});
