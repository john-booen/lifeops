import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { App, TFile, OpenViewState } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentRuntime } from "../src/agentRuntime";
import { createPersonalMemory, emptyPersonalMemoryDocument, personalMemorySourceAssessment } from "../src/personalMemory";
import { recordRevision } from "../src/operationIdentity";
import { OperationLedger } from "../src/dataFoundation/operationLedger";
import type { StoreHost } from "../src/store/settingsSlice";
import type { StewardRecordsController } from "../src/panel/stewardRecords";
import type { AgentActionSuggestion } from "../src/types";
import type { ReadonlyRecordLibrary } from "../src/readonlyRecordLibrary";

const notices = vi.hoisted(() => [] as string[]);
const openMemorySource = vi.hoisted(() => vi.fn());
vi.mock("../src/personalMemorySourceModal", () => ({ openPersonalMemorySourceModal: openMemorySource }));
vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true },
  Notice: class { constructor(message: string) { notices.push(message); } },
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(),
  requestUrl: vi.fn(() => { throw new Error("Network forbidden for steward records tests"); })
}));

const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { stewardMemoryStatusLabel } = await import("../src/panel/stewardRecords");

let root: string;
let vault: InstanceType<typeof DiskVault>;
let store: StoreHost;
let runtime: AgentRuntime;
let plugin: StewardRecordsController & {
  executeAgentAction(action: AgentActionSuggestion): Promise<void>;
  openProjectSource(path: string): Promise<void>;
  createRecordLibrary(): ReadonlyRecordLibrary;
};
let openFile = vi.fn(async (_file: TFile, _state?: OpenViewState) => {});
let refreshViews = vi.fn(async () => {});
let memoryPath: string;

beforeEach(async () => {
  notices.length = 0;
  openMemorySource.mockClear();
  root = await mkdtemp(join(tmpdir(), "lifeops-steward-records-"));
  vault = new DiskVault(root);
  openFile = vi.fn(async (_file: TFile, _state?: OpenViewState) => {});
  refreshViews = vi.fn(async () => {});
  const app = { vault, workspace: { getLeaf: vi.fn(() => ({ openFile })) } } as unknown as App;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.privacy!.excludedVaultPrefixes = ["私人排除"];
  store = new LifeOpsStore(app, settings) as unknown as StoreHost;
  runtime = new AgentRuntime({ store, refreshViews });
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), { app, store, settings, refreshViews, manifest: { id: "lifeops-assistant" } });
  memoryPath = store.path(settings.folders.aiReports, "Memory", "personal-memory.json");
});

afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function seedMemory() {
  const record = createPersonalMemory({ kind: "user_rule", content: "示例用户偏好上午复盘", sourceRefs: [{
    sourceId: "fake-source", path: "LifeOps/Knowledge/Ideas/来源.md", capturedAt: "2026-09-13T01:00:00.000Z"
  }] }, "2026-09-13T01:00:00.000Z");
  await vault.seed(memoryPath, JSON.stringify({ ...emptyPersonalMemoryDocument(), records: [record] }));
  return record;
}

describe("steward record entry points on real temporary Vault files", () => {
  it("does not label historical active memory as confirmed without confirmation evidence", async () => {
    const record = await seedMemory();
    expect(stewardMemoryStatusLabel(record)).toBe("待你确认");
    expect(stewardMemoryStatusLabel({ ...record, [personalMemorySourceAssessment]: { usable: false, reason: "原文已变化", verifiedSourceIds: [] } })).toBe("来源待核对，暂不使用");
    expect(stewardMemoryStatusLabel({ ...record, status: "active" })).toBe("已记录，确认信息待核对");
    expect(stewardMemoryStatusLabel({ ...record, status: "active", confirmedAt: "invalid" })).toBe("已记录，确认信息待核对");
    expect(stewardMemoryStatusLabel({ ...record, status: "active", truth: "inference", confirmedAt: record.createdAt })).toBe("已记录，确认信息待核对");
    expect(stewardMemoryStatusLabel({ ...record, status: "active", confirmedAt: record.createdAt })).toBe("已记录确认时间");
  });

  it("reads real candidates and prepares a revision-bound correction without writing", async () => {
    const record = await seedMemory();
    const before = await vault.bytes(memoryPath);
    const writes = vault.writes.length;
    const listed = await plugin.getStewardMemories();
    expect(listed).toMatchObject([JSON.parse(JSON.stringify(record))]);
    const actions = await plugin.prepareStewardMemoryReview(listed[0], { decision: "correct", content: "示例用户偏好下午复盘" });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "review_memory", memoryDecision: "correct", correctedMemoryContent: "示例用户偏好下午复盘",
      expectedTargetRevisions: { [`memory:${record.id}`]: recordRevision(record) } });
    expect(await vault.bytes(memoryPath)).toBe(before);
    expect(vault.writes).toHaveLength(writes);
  });

  it("rejects stale displayed memory before making a confirmation card", async () => {
    const record = await seedMemory();
    const doc = await store.readPersonalMemories();
    doc.records[0].content = "后来修改的内容";
    await store.writePersonalMemories(doc);
    const before = await vault.bytes(memoryPath);
    await expect(plugin.prepareStewardMemoryReview(record, { decision: "confirm" })).rejects.toThrow(/变化/);
    expect(await vault.bytes(memoryPath)).toBe(before);
  });

  it("rejects a memory changed between displayed-value validation and tool preparation", async () => {
    const record = await seedMemory();
    const read = store.readPersonalMemories.bind(store);
    let calls = 0;
    vi.spyOn(store, "readPersonalMemories").mockImplementation(async () => {
      if (++calls === 2) {
        const doc = await read();
        doc.records[0].content = "读取间新内容";
        await vault.seed(memoryPath, JSON.stringify(doc));
      }
      return read();
    });
    await expect(plugin.prepareStewardMemoryReview(record, { decision: "forget" })).rejects.toThrow(/确认卡/);
    expect((await read()).records[0]).toMatchObject({ content: "读取间新内容", status: "candidate" });
  });

  it("confirms a prepared correction through the existing guarded action and precisely undoes it", async () => {
    const record = await seedMemory();
    const before = await vault.bytes(memoryPath);
    const [action] = await plugin.prepareStewardMemoryReview(record, { decision: "correct", content: "示例用户偏好下午复盘" });
    await plugin.executeAgentAction(action);
    expect((await plugin.getStewardMemories())[0]).toMatchObject({ content: "示例用户偏好下午复盘", status: "active" });
    const operation = (await plugin.getStewardOperations()).find(item => item.id === `confirmed:${action.id}`);
    expect(operation).toMatchObject({ title: "审查个人记忆", status: "verified", canUndo: true });
    await plugin.undoStewardOperation(operation!.id);
    expect(await vault.bytes(memoryPath)).toBe(before);
    expect((await plugin.getStewardOperations()).find(item => item.id === operation!.id)?.status).toBe("reverted");
  });

  it("requires a fresh card after a later edit even when the old card was already prepared", async () => {
    const record = await seedMemory();
    const [action] = await plugin.prepareStewardMemoryReview(record, { decision: "forget" });
    const doc = await store.readPersonalMemories();
    doc.records[0].content = "确认前的后续修改";
    await store.writePersonalMemories(doc);
    const before = await vault.bytes(memoryPath);
    await expect(plugin.executeAgentAction(action)).rejects.toThrow(/变化|版本/);
    expect(await vault.bytes(memoryPath)).toBe(before);
  });

  it("opens a read-only library record without activating host source normalization", async () => {
    const path = store.path(store.settings.folders.dailyRoot, "2038-06-24早.md");
    const original = "# 纯虚构晨间记录\r\n\r\n只读打开后仍保留原始换行。\r\n";
    const ledgerPath = store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
    const ledgerBefore = '{"version":1,"records":[]}\r\n';
    await vault.seed(path, original); await vault.seed(ledgerPath, ledgerBefore);
    // Model the actual old02 host failure: source view can normalize disk CRLF
    // without an explicit user edit. Preview must never enter that host path.
    openFile.mockImplementation(async (file, state) => {
      if (state?.state?.mode !== "preview") await vault.modify(file, (await vault.read(file)).replace(/\r\n/g, "\n"));
    });
    const library = plugin.createRecordLibrary(), signal = new AbortController().signal;
    await library.list({ domain: "life", signal });
    await library.open('record:' + path, { signal });
    expect(openFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path }), { state: { mode: "preview" } });
    expect(await vault.bytes(path)).toBe(original); expect(await vault.bytes(ledgerPath)).toBe(ledgerBefore);
    expect(vault.writes).toEqual([]);
  });

  it.each(["goals", "outputs"] as const)("opens the exact %s project source in preview without writes", async folder => {
    const path = store.path(store.settings.folders[folder], "纯虚构项目原文.md");
    const original = "# 纯虚构项目原文\r\n\r\n查看来源不应改变原文件换行。\r\n";
    await vault.seed(path, original);
    await plugin.openProjectSource(path);
    expect(plugin.app.workspace.getLeaf).toHaveBeenCalledExactlyOnceWith(false);
    expect(openFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path }), { state: { mode: "preview" } });
    expect(await vault.bytes(path)).toBe(original);
    expect(vault.writes).toEqual([]);
    expect(vault.getAbstractFileByPath(store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json"))).toBeNull();
  });

  it("refuses unavailable and excluded project sources before opening a host leaf", async () => {
    const excluded = "私人排除/纯虚构项目原文.md";
    const generated = store.path(store.settings.folders.aiReports, "纯虚构派生.md");
    const nonMarkdown = store.path(store.settings.folders.outputs, "纯虚构附件.json");
    const folder = store.path(store.settings.folders.outputs, "纯虚构目录.md");
    for (const path of [excluded, generated, nonMarkdown, folder + "/子笔记.md"]) await vault.seed(path, "纯虚构控制资料\r\n");
    const missing = store.path(store.settings.folders.goals, "纯虚构缺失.md");
    const newlyExcluded = store.path(store.settings.folders.outputs, "纯虚构后续排除.md");
    await vault.seed(newlyExcluded, "纯虚构控制资料\r\n");
    store.settings.privacy!.excludedVaultPrefixes = ["私人排除", newlyExcluded];
    for (const path of [excluded, generated, nonMarkdown, folder, missing, newlyExcluded]) await expect(plugin.openProjectSource(path)).rejects.toThrow();
    expect(plugin.app.workspace.getLeaf).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
    expect(vault.writes).toEqual([]);
    for (const path of [excluded, generated, nonMarkdown, folder + "/子笔记.md"]) expect(await vault.bytes(path)).toBe("纯虚构控制资料\r\n");
  });

  it("opens only an exact existing allowed Markdown file, preserving its contents", async () => {
    const path = "LifeOps/Knowledge/Ideas/来源.md";
    const original = "# 纯虚构来源\r\n\r\n原文件换行保持。\r\n";
    await vault.seed(path, original);
    await plugin.openStewardSource(path);
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path }), { state: { mode: "preview" } });
    expect(await vault.bytes(path)).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it.each([
    { folder: "ideas", key: "recentThinkingNotes", name: "纯虚构来源.md" },
    { folder: "outputs", key: "recentOutputs", name: "纯虚构输出.md" },
    { folder: "tradingReviews", key: "recentTradingReviews", name: "纯虚构复盘.md" },
    { folder: "ideas", key: "recentThinkingNotes", name: "保留点号.md.md" }
  ] as const)("opens the exact $folder dashboard source $name without resolving an alias", async ({ folder, key, name }) => {
    const date = "2026-10-18";
    const directory = folder === "tradingReviews" ? store.tradingMonthFolder(date) : store.settings.folders[folder];
    const path = store.path(directory, name), original = "纯虚构原文。仅打开，不补造或保存解释。";
    await vault.seed(path, original);
    // Other text callers still consume the existing extensionless recent-note list.
    expect(await store.recentMarkdownFiles(directory, 3)).toEqual([path.replace(/\.md$/, "")]);
    const stats = await store.getDashboardStats(date);
    expect(stats[key]).toEqual([path]);
    await plugin.openStewardSource(stats[key][0]);
    expect(openFile).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path }), { state: { mode: "preview" } });
    expect(await vault.bytes(path)).toBe(original);
    expect(vault.getAbstractFileByPath(store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json"))).toBeNull();
  });

  it("refuses excluded, generated, missing, ambiguous, traversal and non-Markdown sources", async () => {
    const generated = store.path(store.settings.folders.aiReports, "报告.md");
    for (const path of ["私人排除/隐私.md", generated, "附件/data.json"]) await vault.seed(path, "not displayed");
    await vault.seed("LifeOps/Knowledge/Ideas/来源.md", "不能把去掉扩展名的路径当作准确来源");
    for (const path of ["私人排除/隐私.md", generated, "附件/data.json", "缺失.md", "[[来源]]", "../外部.md", "/外部.md", "LifeOps/Knowledge/../外部.md", "LifeOps/Knowledge/Ideas/来源"]) {
      await plugin.openStewardSource(path);
    }
    expect(openFile).not.toHaveBeenCalled();
    expect(notices).toHaveLength(9);
    expect(notices.every(message => message.includes("无法打开"))).toBe(true);
  });

  it("shows only the selected memory confirmation and never opens the whole operation ledger", async () => {
    const record = await seedMemory();
    const [action] = await plugin.prepareStewardMemoryReview(record, { decision: "confirm" });
    await plugin.executeAgentAction(action);
    const current = (await plugin.getStewardMemories())[0];
    const ref = current.sourceRefs.find(source => source.sourceId === `confirmed:${action.id}`)!;
    const writes = vault.writes.length;
    await plugin.openStewardSource(ref.path, ref.sourceId);
    expect(openMemorySource).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ id: record.id }), ref.sourceId);
    expect(openFile).not.toHaveBeenCalled();
    expect(vault.writes).toHaveLength(writes);
    await plugin.openStewardSource(ref.path, "confirmed:unrelated");
    expect(openMemorySource).toHaveBeenCalledTimes(1);
    expect(notices.at(-1)).toContain("无法打开");
  });

  it("opens only the exact recorded conversation date and respects newly excluded paths", async () => {
    const record = await seedMemory();
    const date = "2026-09-16";
    const path = store.path(store.settings.folders.aiReports, "Conversations", `${date}.md`);
    const sourceId = `conversation:${date}`;
    await vault.seed(path, "用户的示例原话");
    record.sourceRefs = [{ sourceId, path, capturedAt: record.createdAt }];
    await vault.seed(memoryPath, JSON.stringify({ ...emptyPersonalMemoryDocument(), records: [record] }));
    await plugin.openStewardSource(path, sourceId);
    expect(openFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path }), { state: { mode: "preview" } });
    store.settings.privacy!.excludedVaultPrefixes = [path];
    await plugin.openStewardSource(path, sourceId);
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(notices.at(-1)).toContain("无法打开");
    expect(vault.writes).toEqual([]);
  });

  it("does not grant generated-file access to a mismatched conversation reference", async () => {
    const record = await seedMemory();
    const path = store.path(store.settings.folders.aiReports, "Conversations", "2026-09-16.md");
    const sourceId = "conversation:2026-09-15";
    await vault.seed(path, "不应因错误日期引用而打开");
    record.sourceRefs = [{ sourceId, path, capturedAt: record.createdAt }];
    await vault.seed(memoryPath, JSON.stringify({ ...emptyPersonalMemoryDocument(), records: [record] }));
    await plugin.openStewardSource(path, sourceId);
    expect(openFile).not.toHaveBeenCalled();
    expect(notices.at(-1)).toContain("无法打开");
  });

  it("exposes safe operation summaries without raw arguments, undo bytes or internal errors", async () => {
    const path = store.path(store.settings.folders.ideas, "summary.md");
    await vault.seed(path, "original private bytes");
    await runtime.executeLocalOperation("custom-operation", { secret: "private arguments" }, scope => scope.writeFile(path, "new private bytes"), "summary-ok");
    const ledger = new OperationLedger(store);
    await ledger.claim({ operationId: "summary-failure", toolName: "unknown", source: "system", arguments: { secret: "private args" } });
    await ledger.fail("summary-failure", "internal exception private bytes");
    const summaries = await plugin.getStewardOperations();
    expect(summaries.find(item => item.id === "summary-ok")).toMatchObject({ status: "verified", canUndo: true });
    expect(summaries.find(item => item.id === "summary-failure")).toMatchObject({ status: "failed", canUndo: false });
    expect(JSON.stringify(summaries)).not.toMatch(/private|internal|arguments|undo/);
    expect(Object.keys(summaries[0]).sort()).toEqual(["canUndo", "id", "status", "title", "updatedAt"]);
  });

  it("undoes the selected earlier operation after a newer unrelated operation is created", async () => {
    const a = store.path(store.settings.folders.ideas, "a.md");
    const b = store.path(store.settings.folders.ideas, "b.md");
    await vault.seed(a, "old a"); await vault.seed(b, "old b");
    await runtime.executeLocalOperation("edit-a", {}, scope => scope.writeFile(a, "new a"), "selected-a");
    const selected = (await plugin.getStewardOperations()).find(item => item.id === "selected-a")!;
    await runtime.executeLocalOperation("edit-b", {}, scope => scope.writeFile(b, "new b"), "newest-b");
    await plugin.undoStewardOperation(selected.id);
    expect(await vault.bytes(a)).toBe("old a");
    expect(await vault.bytes(b)).toBe("new b");
    expect((await plugin.getStewardOperations()).find(item => item.id === "newest-b")?.status).toBe("verified");
    expect(notices).toEqual(["已撤销你选中的这一条操作。"]);
  });

  it.each([
    ["local_appendHealthEntry", "手动记录健康"],
    ["manual_health_csv_batch", "导入健康 CSV"],
    ["manual_health_screenshot", "截图记健康"],
    ["manual_trade_screenshot_batch", "截图记交易"],
    ["local_addJournalPlanTask", "将日记计划加到任务"]
  ])("names the recent operation %s without exposing its entries", async (name, title) => {
    const path = store.path(store.settings.folders.health, "2026-11-14.md");
    const id = "synthetic-import-label";
    await runtime.executeLocalOperation(name, { entries: ["synthetic private details"] }, scope => scope.writeFile(path, "synthetic private bytes"), id);
    const entry = (await plugin.getStewardOperations()).find(row => row.id === id);
    expect(entry).toMatchObject({ title, canUndo: true });
    expect(JSON.stringify(entry)).not.toContain("synthetic private");
  });

  it("distinguishes same-second weekly drafts by their persisted target and keeps it after selected Undo", async () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-10-18T00:00:00.000Z");
    const a = store.path(store.settings.folders.aiReports, "周回顾", "2026-10-11-至-2026-10-17-aaaaaaaaaaaa.md");
    const b = store.path(store.settings.folders.aiReports, "周回顾", "2026-10-11-至-2026-10-17-bbbbbbbbbbbb.md");
    await runtime.executeLocalOperation("confirm_weekly_review", {}, scope => scope.writeFile(a, "private draft A"), "draft-a");
    await runtime.executeLocalOperation("confirm_weekly_review", {}, scope => scope.writeFile(b, "private draft B"), "draft-b");
    const summaries = await plugin.getStewardOperations();
    const first = summaries.find(item => item.id === "draft-a")!;
    const second = summaries.find(item => item.id === "draft-b")!;
    expect([first.title, first.status, first.updatedAt]).toEqual([second.title, second.status, second.updatedAt]);
    expect(first.targetPath).toBe(a);
    expect(second.targetPath).toBe(b);
    expect(JSON.stringify(summaries)).not.toContain("private draft");
    await plugin.undoStewardOperation(first.id);
    expect((await plugin.getStewardOperations()).find(item => item.id === first.id)).toMatchObject({ targetPath: a, status: "reverted", canUndo: false });
    await expect(vault.bytes(a)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await vault.bytes(b)).toBe("private draft B");
  });

  it("keeps excluded and ambiguous weekly target metadata out of operation summaries", async () => {
    const folder = store.path(store.settings.folders.aiReports, "周回顾");
    const hidden = folder + "/hidden.md";
    store.settings.privacy!.excludedVaultPrefixes.push(hidden);
    await runtime.executeLocalOperation("confirm_weekly_review", {}, scope => scope.writeFile(hidden, "private hidden draft"), "hidden-draft");
    await runtime.executeLocalOperation("confirm_weekly_review", {}, async scope => {
      await scope.writeFile(folder + "/one.md", "private one");
      await scope.writeFile(folder + "/two.md", "private two");
    }, "ambiguous-draft");
    const summaries = await plugin.getStewardOperations();
    expect(summaries.find(item => item.id === "hidden-draft")).not.toHaveProperty("targetPath");
    expect(summaries.find(item => item.id === "ambiguous-draft")).not.toHaveProperty("targetPath");
    expect(JSON.stringify(summaries)).not.toMatch(/hidden\.md|one\.md|two\.md|private/);
  });

  it("preserves every file and shows failure when the selected undo conflicts with a later edit", async () => {
    const a = store.path(store.settings.folders.ideas, "a.md");
    const b = store.path(store.settings.folders.ideas, "b.md");
    await vault.seed(a, "old a"); await vault.seed(b, "old b");
    await runtime.executeLocalOperation("edit-both", {}, async scope => { await scope.writeFile(a, "new a"); await scope.writeFile(b, "new b"); }, "conflict");
    await vault.seed(b, "later user edit");
    refreshViews.mockClear();
    await plugin.undoStewardOperation("conflict");
    expect(await vault.bytes(a)).toBe("new a"); expect(await vault.bytes(b)).toBe("later user edit");
    expect(notices).toHaveLength(1); expect(notices[0]).toContain("撤销没有完成");
    expect(refreshViews).not.toHaveBeenCalled();
    expect((await plugin.getStewardOperations()).find(item => item.id === "conflict")?.status).toBe("verified");
  });

  it("shows an empty state as empty data and fails loudly rather than claiming empty on malformed storage", async () => {
    expect(await plugin.getStewardMemories()).toEqual([]);
    expect(await plugin.getStewardOperations()).toEqual([]);
    await vault.seed(memoryPath, "{invalid");
    await expect(plugin.getStewardMemories()).rejects.toThrow();
    await vault.seed(store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json"), "{invalid");
    await expect(plugin.getStewardOperations()).rejects.toThrow();
  });
});
