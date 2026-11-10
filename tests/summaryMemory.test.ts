import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage } from "../src/ai";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { FactOperationOptions } from "../src/dataFoundation/factOperation";
import { createPersonalMemory, emptyPersonalMemoryDocument, personalMemoryOrigin, selectPersonalMemories, verifiedPersonalMemoryContextSources } from "../src/personalMemory";
import type { StoreHost } from "../src/store/settingsSlice";
import type { ProviderRequestOptions } from "../src/types";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, Modal: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/"), parseYaml: JSON.parse, stringifyYaml: JSON.stringify
}));
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { DiskVault } = await import("./helpers/diskVault");
const { startMemoryMaintenance, tickMemoryMaintenance } = await import("../src/features/memory/summaryMemory");
const { renderSummary, readSummaryScope, summaryPath } = await import("../src/features/summaries/notes");
const { summaryPeriod } = await import("../src/features/summaries/periods");
const { readPersonalMemoryWithSources } = await import("../src/personalMemorySources");
const { filterStewardMemories, stewardMemoryStatusLabel } = await import("../src/panel/stewardRecords");
const { formatConfirmedPersonalMemoryContext } = await import("../src/personalMemoryContext");
type MemoryHost = import("../src/features/memory/service").MemoryHost;
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>, host: MemoryHost;
const monday = new Date(2026, 10, 16, 9);
const summaryDate = "2026-11-14";
const known = "用户长期偏好用两列对照表比较虚构检索方案。";
const json = JSON.stringify({ items: [{ date: summaryDate, kind: "user_rule", quote: known },
  { date: summaryDate, kind: "core_profile", quote: "原摘要不存在的虚构内容。" }] });
const ask = vi.fn(async (_messages: ChatMessage[], options: ProviderRequestOptions) => {
  await options.beforeTextRequest?.();
  return json;
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-summary-memory-"));
  vault = new DiskVault(root);
  const app = { vault } as unknown as App;
  const settings = structuredClone(DEFAULT_SETTINGS);
  Object.assign(settings.ai, { provider: "custom", endpoint: "https://synthetic.invalid", model: "synthetic", dataDisclosureAccepted: true });
  store = new LifeOpsStore(app, settings) as unknown as StoreHost;
  await store.initializeVault();
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
  ask.mockClear();
  host = {
    store, app, settings, unloaded: false, refreshViews: async () => undefined,
    observeProvider: (_stage: string, _source: string, action: Function) =>
      action({}, store, { generatePlanningJson: ask }, () => undefined, () => undefined),
    async saveLocalOperation(name: string, args: Record<string, unknown>, execute: (scope: StoreHost) => Promise<unknown>, options?: FactOperationOptions) {
      const result = await runtime.executeLocalOperation(name, args, execute, undefined, options);
      if (!result.success) throw Error(result.output);
    }
  } as unknown as MemoryHost;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function seedSummary() {
  const period = summaryPeriod("day", summaryDate);
  const { hash } = await readSummaryScope(store);
  const path = summaryPath(store, period);
  const raw = renderSummary(period, summaryDate, hash,
    { taskCompletionPercent: 100, tasksCompleted: 3, energy: 4, tradePnlCny: null, tradePnlUsd: null },
    0, true, "model", known + "\n\n下周一核对虚构任务。");
  await vault.seed(path, raw);
  return { path, raw };
}

it("automatically saves only a verifiable fact, labels the source, and runs once per week", async () => {
  const { path, raw } = await seedSummary();
  await startMemoryMaintenance(host, monday);
  const { records, summaryMemoryWeek } = await readPersonalMemoryWithSources(store);
  expect(summaryMemoryWeek).toBe("2026-W46");
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ content: known, status: "active", summarySource: expect.anything(),
    sourceRefs: [{ path, observedDate: summaryDate, excerpt: known }] });
  expect(records[0].confirmedAt).toBeUndefined();
  expect(personalMemoryOrigin(records[0])).toBe("摘要");
  expect(stewardMemoryStatusLabel(records[0])).toBe("从摘要自动记下");
  expect(verifiedPersonalMemoryContextSources(records[0])).toMatchObject([{ basis: "summary" }]);
  expect(selectPersonalMemories(records, "虚构检索", 8, monday)).toMatchObject([{ content: known }]);
  expect(formatConfirmedPersonalMemoryContext(records)).toContain("从日摘要自动提炼");
  expect(filterStewardMemories(records, "摘要", "user_rule", "active")).toHaveLength(1);
  expect(ask.mock.calls[0][0][1].content).not.toContain(path);
  expect(await vault.bytes(path)).toBe(raw);
  await tickMemoryMaintenance(host, new Date(2026, 10, 16, 10));
  expect(ask).toHaveBeenCalledOnce();

  await store.writeFile(path, raw + "\n手写更新。");
  const changed = (await readPersonalMemoryWithSources(store)).records;
  expect(selectPersonalMemories(changed, "虚构检索", 8, monday)).toEqual([]);
  expect(stewardMemoryStatusLabel(changed[0])).toBe("来源待核对，暂不使用");
});

it("does not save a fact when its source changes while the model request is in flight", async () => {
  const { path, raw } = await seedSummary();
  ask.mockImplementationOnce(async (_messages, options) => {
    await options.beforeTextRequest?.();
    await store.writeFile(path, raw + "\n虚构摘要刚改过。");
    return json;
  });
  await startMemoryMaintenance(host, monday);
  expect((await store.readPersonalMemories()).records).toEqual([]);
  expect((await store.readPersonalMemories()).summaryMemoryWeek).toBeUndefined();
  expect(await vault.bytes(path)).toContain("虚构摘要刚改过");
});

it("archives expired memory without deleting its content, and the panel can find it", async () => {
  const path = "虚构记忆来源.md";
  await vault.seed(path, "虚构短期计划原始记录");
  const sourceRefs = [{ sourceId: "synthetic", path, capturedAt: "2026-11-01T00:00:00Z" }];
  const expired = { ...createPersonalMemory({ kind: "current_state", content: "虚构短期计划",
    sourceRefs, expiresAt: "2026-11-10T00:00:00Z" }, "2026-11-01T00:00:00Z"),
    status: "active" as const, confirmedAt: "2026-11-01T00:00:00Z" };
  await vault.seed(store.personalMemoryPath(), JSON.stringify({ ...emptyPersonalMemoryDocument(), records: [expired] }));
  await startMemoryMaintenance(host, monday);
  const { records } = await store.readPersonalMemories();
  expect(records).toMatchObject([{ archivedAt: monday.toISOString(), content: expired.content, sourceRefs }]);
  expect(stewardMemoryStatusLabel(records[0])).toBe("已归档");
  expect(filterStewardMemories(records, "短期", "current_state", "archived")).toHaveLength(1);
  expect(filterStewardMemories(records, "短期", "core_profile", "archived")).toEqual([]);
  expect(selectPersonalMemories(records, "", 8, monday)).toEqual([]);
  expect(await vault.bytes(path)).toBe("虚构短期计划原始记录");
});

it("keeps eight relevant records and favors recent use between otherwise similar records", () => {
  const stamp = monday.toISOString();
  const records = Array.from({ length: 10 }, (_, index) => ({
    ...createPersonalMemory({ kind: "user_rule", content: "虚构偏好 " + index,
      sourceRefs: [{ sourceId: "synthetic", path: "source.md", capturedAt: stamp }] }, stamp),
    status: "active" as const, confirmedAt: stamp
  }));
  const used = new Map([[records[9].id, monday.getTime() - 60_000]]);
  const selected = selectPersonalMemories(records, "虚构偏好", 8, monday, used);
  expect(selected).toHaveLength(8);
  expect(selected[0].id).toBe(records[9].id);
});
