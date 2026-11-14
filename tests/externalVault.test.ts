import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { FactOperationOptions } from "../src/dataFoundation/factOperation";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, Modal: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/"), parseYaml: JSON.parse, stringifyYaml: JSON.stringify
}));

const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { DiskVault } = await import("./helpers/diskVault");
const { ReadOnlyExternalVault } = await import("../src/features/externalVault/readOnly");
const { indexedExternalVault, externalSourcePath } = await import("../src/features/externalVault/catalog");
const { extractExternalJournalSignals } = await import("../src/features/externalVault/journals");
const { readJournalSignals } = await import("../src/features/journal/signalStore");
const { addJournalPlanTask, getTodayCard } = await import("../src/features/today/service");
const { readStats } = await import("../src/features/stats/tools");
const { listIdeaCandidates } = await import("../src/features/ideas/candidates");
const { registerIdeaCandidates } = await import("../src/features/ideas/service");
const { listExternalTradeBackfillNotes, scanTradeBackfill, previewTradeBackfill, confirmTradeBackfill } = await import("../src/features/trading/backfill");
const { readTradeDatabase } = await import("../src/features/trading/persistence");
const { executeVaultQuery, readVaultQueryWithSources, vaultQueryReadCoverage } = await import("../src/vaultQuery");

const originName = "虚构私人库";
const journal = "LifeOps/Journal/2026/08/2026-08-01晚.md";
const idea = "LifeOps/Knowledge/Ideas/虚构检索工具.md";
const trade = "LifeOps/TradeReview/2026-08-01虚构复盘.md";
const journalQuote = "试做一个可以对比两种虚构摘要的工具。";
const tradeQuote = "2026-08-01 09:30 美股 AAPL 做多 2 股，盈亏 3 USD。";
let root: string, origin: string, store: StoreHost, vault: InstanceType<typeof DiskVault>, runtime: InstanceType<typeof AgentRuntime>;

const host = {
  async saveLocalOperation(name: string, args: Record<string, unknown>, execute: (scope: StoreHost) => Promise<unknown>, options?: FactOperationOptions) {
    const result = await runtime.executeLocalOperation(name, args, execute, undefined, options);
    if (!result.success) throw Error(result.output);
  },
  refreshViews: async () => undefined
};

const seedOriginal = async (path: string, text: string) => {
  await mkdir(dirname(join(origin, path)), { recursive: true });
  await writeFile(join(origin, path), text);
};
const fingerprint = () => execFileSync(process.execPath, ["scripts/vault-fingerprint.mjs", origin], { encoding: "utf8" });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-external-vault-"));
  origin = join(root, "original");
  await mkdir(origin);
  vault = new DiskVault(join(root, "daily"));
  await mkdir(join(root, "daily"));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.externalVaults = [{ name: originName, path: origin, folders: ["LifeOps/Journal", "LifeOps/TradeReview", "LifeOps/Knowledge/Ideas"] }];
  store = new LifeOpsStore({ vault } as unknown as App, settings) as unknown as StoreHost;
  await store.initializeVault();
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
  await seedOriginal(journal, "# 虚构晚记\n\n精力四分。\n" + journalQuote);
  await seedOriginal(idea, "# 虚构旧构思\n\n虚构命中：整理一个索引工具。");
  await seedOriginal(trade, "# 2026-08-01\n\n" + tradeQuote);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("refuses all writes, excluded and symlink reads, and indexes without copying original bodies", async () => {
  await seedOriginal(".obsidian/private.md", "虚构内部配置。");
  await seedOriginal("未选择/秘密.md", "虚构未选择目录。");
  const link = join(origin, "LifeOps/Knowledge/Ideas/虚构链接.md");
  await symlink(join(origin, "未选择/秘密.md"), link);
  const before = fingerprint();
  const config = store.settings.externalVaults![0], reader = new ReadOnlyExternalVault(config);
  expect((await reader.listMarkdown()).map(item => item.path)).toEqual(expect.arrayContaining([journal, trade, idea]));
  expect((await reader.listMarkdown()).map(item => item.path)).toHaveLength(3);
  await expect(reader.read("LifeOps/Knowledge/Ideas/虚构链接.md")).rejects.toThrow("符号链接");
  await expect(reader.read("未选择/秘密.md")).rejects.toThrow("超出");
  await expect(reader.read("LifeOps/Knowledge/Ideas/../../.obsidian/private.md")).rejects.toThrow("超出");
  for (const method of ["write", "create", "modify", "append", "delete", "rename", "mkdir", "remove", "trash"] as const) {
    expect(() => reader[method]()).toThrow("只读");
  }
  expect(await indexedExternalVault(store, config)).toMatchObject({ files: 3, unreadable: 0 });
  const index = await store.readJson<any>(store.path(store.settings.folders.aiReports, "Index", "external-" + originName + ".json"), {});
  expect(index.entries).toHaveLength(3);
  expect(index.entries.every((entry: any) => entry.chunks.every((chunk: any) => !("text" in chunk) && !("summary" in chunk)))).toBe(true);
  expect(fingerprint()).toBe(before);
});

it("queries both vaults by default, supports exact external selection, and rejects stale reads", async () => {
  await vault.seed("虚构日用.md", "# 日用\n\n虚构命中：日用资料。");
  const all = await executeVaultQuery(store, { domain: "note", operation: "search", query: "虚构命中" });
  expect(all).toContain("日用资料");
  expect(all).toContain("来自原私人库");
  expect(all).toContain("整理一个索引工具");
  const local = await executeVaultQuery(store, { domain: "note", operation: "search", query: "虚构命中", vault: "local" });
  expect(local).toContain("日用资料");
  expect(local).not.toContain("原私人库");
  const path = externalSourcePath(originName, journal);
  const opened = await readVaultQueryWithSources(store, { domain: "journal", operation: "get", date: "2026-08-01", path, vault: originName });
  expect(opened.text).toContain(journalQuote);
  expect(opened.allowsCandidateObservation).toBe(false);
  expect(vaultQueryReadCoverage(opened)?.pages).toMatchObject([{ path }]);
  await opened.assertSourcesCurrent();
  const result = await runtime.executeAiToolCall({
    id: "virtual-source-once", name: "query_vault", arguments: { domain: "journal", operation: "get", path, vault: originName }
  }, "kimi");
  expect(result.output).toContain(journalQuote);
  const ledger = await store.readJson<{ records: unknown[] }>(store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json"), { records: [] });
  expect(JSON.stringify(ledger)).not.toContain(journalQuote);
  await seedOriginal(journal, "虚构外部文件已修改。");
  await expect(opened.assertSourcesCurrent()).rejects.toThrow("外部");
  opened.dispose();
  store.settings.privacy!.excludedVaultPrefixes = ["LifeOps/Knowledge/Ideas"];
  expect(await executeVaultQuery(store, { domain: "note", operation: "get", path: idea, vault: originName })).not.toContain("索引工具");
});

it("generates external signals and candidates, and confirms imported ideas and trades only in the daily vault", async () => {
  const before = fingerprint(), date = "2026-08-01", now = new Date(2026, 10, 15, 12);
  const signal = new AbortController().signal;
  const result = await extractExternalJournalSignals(store, async (_messages, options) => {
    await options.beforeTextRequest?.();
    return JSON.stringify({ date, period: "晚", energy: 4, quotes: [{ field: "energy", text: "精力四分" }],
      ideas: [{ text: "虚构摘要比较工具", quote: journalQuote }] });
  }, signal, () => undefined, now);
  expect(result).toMatchObject({ examined: 1, saved: 1, unavailable: 0 });
  expect((await readJournalSignals(store, date))[0]).toMatchObject({ energy: 4, sources: [{ path: externalSourcePath(originName, journal) }] });
  const stats = await readStats(store, { domain: "journal", range: { from: date, to: date } }, now);
  expect(JSON.parse(stats.output)).toMatchObject({ count: 1, signalAverages: { energy: 4 } });
  const ideas = await listIdeaCandidates(store, now);
  expect(ideas).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "external", path: externalSourcePath(originName, idea) }),
    expect.objectContaining({ kind: "journal", path: externalSourcePath(originName, journal) })
  ]));
  const choice = ideas.find(item => item.kind === "external")!;
  const [saved] = await registerIdeaCandidates(host, store, [{ candidate: choice }]);
  expect(saved.sources).toEqual([choice.path]);
  expect(store.getFile(saved.path)).toBeTruthy();

  const sources = await listExternalTradeBackfillNotes(store);
  expect(sources).toEqual([externalSourcePath(originName, trade)]);
  const scan = await scanTradeBackfill(store, sources, async () => JSON.stringify({ kind: "trade", trades: [{
    quote: tradeQuote, symbol: "AAPL", market: "美股", direction: "long", openedAt: "2026-08-01 09:30", qty: 2, pnl: 3, currency: "USD"
  }] }), signal);
  expect(scan.candidates).toHaveLength(1);
  expect((await readTradeDatabase(store)).trades).toEqual([]);
  const preview = previewTradeBackfill(scan, "2026-08", []);
  expect(await confirmTradeBackfill(host, store, scan, preview)).toBe(1);
  expect((await readTradeDatabase(store)).trades).toMatchObject([{ symbol: "AAPL", source: { ref: sources[0] } }]);
  expect(await readFile(join(origin, trade), "utf8")).toContain(tradeQuote);
  expect(fingerprint()).toBe(before);
});

it("adds and undoes an external diary plan locally, and rejects the plan after the original changes", async () => {
  const date = "2026-08-01", title = "虚构整理纸卡";
  await seedOriginal(journal, `# 虚构晚记\n明天${title}。`);
  const before = fingerprint(), sourceNotePath = externalSourcePath(originName, journal);
  const result = await extractExternalJournalSignals(store, async () => JSON.stringify({
    date, period: "晚", plans: [{ text: title, when: "明天" }]
  }), new AbortController().signal, () => {}, new Date(2026, 7, 1, 22));
  expect(result.saved).toBe(1);
  const [choice] = (await getTodayCard(store, await store.getTaskDashboard(date))).plans;
  expect(choice.plan).toMatchObject({ title, date: "2026-08-02", source: { path: sourceNotePath } });
  await addJournalPlanTask(host, store, choice.plan);
  expect((await store.readTaskDb()).tasks).toMatchObject([{ title, date: "2026-08-02", sourceNotePath }]);
  await runtime.undoLatestOperation();
  expect((await store.readTaskDb()).tasks).toEqual([]);
  expect(fingerprint()).toBe(before);

  await seedOriginal(journal, "# 虚构晚记\n计划已变更。");
  const afterEdit = fingerprint();
  await expect(addJournalPlanTask(host, store, choice.plan)).rejects.toThrow("已变更");
  expect((await store.readTaskDb()).tasks).toEqual([]);
  expect(fingerprint()).toBe(afterEdit);
});
