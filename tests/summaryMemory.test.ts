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
import { fileRevision } from "../src/operationIdentity";
import { runConfirmedToolAction } from "../src/toolRegistry";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, Modal: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/"), parseYaml: JSON.parse, stringifyYaml: JSON.stringify
}));
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { DiskVault } = await import("./helpers/diskVault");
const { startMemoryMaintenance, tickMemoryMaintenance, extractWeeklyMemories } = await import("../src/features/memory/summaryMemory");
const { renderSummary, readSummaryScope, summaryPath } = await import("../src/features/summaries/notes");
const { summaryPeriod } = await import("../src/features/summaries/periods");
const { readPersonalMemoryWithSources, memorySourcePolicy, assertPersonalMemoryDependencies } = await import("../src/personalMemorySources");
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

const originalPath = (date = summaryDate) => store.path(store.settings.folders.dailyRoot, "2026", "11", date + "晚.md");
async function seedSummary(original: string | false = known, body = known + "\n\n下周一核对虚构任务。", date = summaryDate) {
  const period = summaryPeriod("day", date);
  const { hash } = await readSummaryScope(store);
  const path = summaryPath(store, period);
  const raw = renderSummary(period, date, hash,
    { taskCompletionPercent: 100, tasksCompleted: 3, energy: 4, tradePnlCny: null, tradePnlUsd: null },
    0, true, "model", body);
  await vault.seed(path, raw);
  if (original !== false) await vault.seed(originalPath(date), original);
  return { path, raw };
}

it("does not treat a model-only summary quote as a grounded personal fact without original evidence", async () => {
  // No raw journal or user conversation states this preference. A matching
  // sentence in a generated summary proves its bytes, not who asserted it.
  await seedSummary(false);
  await startMemoryMaintenance(host, monday);
  const { records } = await readPersonalMemoryWithSources(store);
  expect(selectPersonalMemories(records, "虚构检索", 8, monday)).toEqual([]);
  expect(ask).not.toHaveBeenCalled();
});

it("automatically saves only a verifiable fact, labels the source, and runs once per week", async () => {
  const { path, raw } = await seedSummary();
  await startMemoryMaintenance(host, monday);
  const { records, summaryMemoryWeek } = await readPersonalMemoryWithSources(store);
  expect(summaryMemoryWeek).toBe("2026-W46");
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ content: known, status: "active", summarySource: { evidenceVersion: 2 },
    sourceRefs: expect.arrayContaining([expect.objectContaining({ path: originalPath(), observedDate: summaryDate, excerpt: known }),
      expect.objectContaining({ path })]) });
  expect(records[0].confirmedAt).toBeUndefined();
  expect(personalMemoryOrigin(records[0])).toBe("摘要");
  expect(stewardMemoryStatusLabel(records[0])).toBe("从摘要自动记下");
  expect(verifiedPersonalMemoryContextSources(records[0])).toMatchObject([{ basis: "fixed_version", ref: { path: originalPath() } }]);
  expect(selectPersonalMemories(records, "虚构检索", 8, monday)).toMatchObject([{ content: known }]);
  expect(formatConfirmedPersonalMemoryContext(records)).toContain("从日摘要自动提炼");
  expect(filterStewardMemories(records, "摘要", "user_rule", "active")).toHaveLength(1);
  expect(ask.mock.calls[0][0][1].content).not.toContain(path);
  expect(await vault.bytes(path)).toBe(raw);
  await tickMemoryMaintenance(host, new Date(2026, 10, 16, 10));
  expect(ask).toHaveBeenCalledOnce();

  await store.writeFile(path, raw + "\n手写更新。");
  expect(selectPersonalMemories((await readPersonalMemoryWithSources(store)).records, "虚构检索", 8, monday)).toMatchObject([{ content: known }]);
  await store.writeFile(originalPath(), known + "\n虚构原始陈述有新修改。");
  const changed = (await readPersonalMemoryWithSources(store)).records;
  expect(selectPersonalMemories(changed, "虚构检索", 8, monday)).toEqual([]);
  expect(stewardMemoryStatusLabel(changed[0])).toBe("来源待核对，暂不使用");
});

it("extracts an original quote even when the model summary paraphrases it", async () => {
  await seedSummary(known, "模型概述：虚构检索方案有一项比较偏好，但这里没有逐字原话。");
  await extractWeeklyMemories(host, store, monday);
  expect(selectPersonalMemories((await readPersonalMemoryWithSources(store)).records, "虚构检索", 8, monday)).toMatchObject([{ content: known }]);
});

it("does not promote the assistant's organized diary section into a user statement", async () => {
  const { appendEveningEntry } = await import("../src/features/journal/entry");
  const original = appendEveningEntry("# 虚构晚间日记\n", "日记", known, "我只说今天整理了虚构纸样，没有说任何长期偏好。");
  await seedSummary(original); await startMemoryMaintenance(host, monday);
  expect((await store.readPersonalMemories()).records).toEqual([]); expect(await vault.bytes(originalPath())).toBe(original);
  expect((await store.readPersonalMemories()).summaryMemoryEvidenceVersion).toBe(2);
});

async function seedLegacySummaryMemory(withOriginal = false) {
  const { path, raw } = await seedSummary(withOriginal ? known : false);
  const record = { ...createPersonalMemory({ kind: "user_rule", content: known, tags: ["虚构保留标签"],
    sourceRefs: [{ sourceId: "summary:" + summaryDate, path, capturedAt: monday.toISOString(), observedDate: summaryDate,
      contentHash: fileRevision(raw), extractionVersion: "summary-v1", excerpt: known, excerptHash: fileRevision(known) }] }, monday.toISOString()),
    status: "active" as const, summarySource: { settingsRevision: memorySourcePolicy(store) } };
  await vault.seed(store.personalMemoryPath(), JSON.stringify({ ...emptyPersonalMemoryDocument(), records: [record], summaryMemoryWeek: "2026-W46" }));
  return record;
}

it("retains an ungrounded old automatic memory but leaves it out of conversation context", async () => {
  const record = await seedLegacySummaryMemory(), before = await vault.bytes(store.personalMemoryPath());
  const assessed = await readPersonalMemoryWithSources(store);
  expect(selectPersonalMemories(assessed.records, "虚构检索", 8, monday)).toEqual([]);
  expect(assessed.records[0].content).toBe(record.content); expect(stewardMemoryStatusLabel(assessed.records[0])).toBe("来源待核对，暂不使用");
  expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
});

it("upgrades evidence for the same old memory immediately even if the week was already processed", async () => {
  const record = await seedLegacySummaryMemory(true);
  await extractWeeklyMemories(host, store, monday);
  const document = await readPersonalMemoryWithSources(store);
  expect(ask).toHaveBeenCalledOnce();
  expect(document.summaryMemoryEvidenceVersion).toBe(2);
  expect(document.records).toHaveLength(1);
  expect(document.records[0]).toMatchObject({ id: record.id, content: record.content, tags: record.tags, summarySource: { evidenceVersion: 2 } });
  expect(selectPersonalMemories(document.records, "虚构检索", 8, monday)).toHaveLength(1);
});

it("rechecks a paused automatic memory against next week's new original without reviving its changed old source", async () => {
  await seedSummary(); await extractWeeklyMemories(host, store, monday);
  const originalRecord = (await store.readPersonalMemories()).records[0];
  const changedOriginal = known + "\n虚构旧日记后来补上了整理纸盒的记录。";
  await store.writeFile(originalPath(), changedOriginal);
  expect(selectPersonalMemories((await readPersonalMemoryWithSources(store)).records, "虚构检索", 8, monday)).toEqual([]);
  const nextDate = "2026-11-21", nextMonday = new Date(2026, 10, 23, 9);
  await seedSummary(known, "虚构本周再次明确说过这项长期偏好。", nextDate);
  ask.mockResolvedValueOnce(JSON.stringify({ items: [{ date: nextDate, kind: "user_rule", quote: known }] }));
  await extractWeeklyMemories(host, store, nextMonday);
  const document = await readPersonalMemoryWithSources(store);
  expect(selectPersonalMemories(document.records, "虚构检索", 8, nextMonday)).toMatchObject([{ id: originalRecord.id, content: known }]);
  expect(document.records).toHaveLength(1);
  expect(verifiedPersonalMemoryContextSources(document.records[0])).toMatchObject([{ ref: { path: originalPath(nextDate), observedDate: nextDate } }]);
  expect(document.records[0].sourceRefs.some(ref => ref.path === originalPath())).toBe(false);
  expect(await vault.bytes(originalPath())).toBe(changedOriginal);
  expect(await vault.bytes(originalPath(nextDate))).toBe(known);
});

it("does not refresh a paused memory when next week's original never states its old claim", async () => {
  await seedSummary(); await extractWeeklyMemories(host, store, monday);
  await store.writeFile(originalPath(), "虚构旧原文已重写，未保留那项偏好。");
  const nextDate = "2026-11-21", nextMonday = new Date(2026, 10, 23, 9);
  await seedSummary("这周只整理了虚构纸盒，没有陈述检索偏好。", "虚构新周整理记录。", nextDate);
  ask.mockResolvedValueOnce(JSON.stringify({ items: [{ date: nextDate, kind: "user_rule", quote: known }] }));
  const before = (await store.readPersonalMemories()).records;
  await extractWeeklyMemories(host, store, nextMonday);
  const after = (await readPersonalMemoryWithSources(store)).records;
  expect(after.map(record => record.sourceRefs)).toEqual(before.map(record => record.sourceRefs));
  expect(selectPersonalMemories(after, "虚构检索", 8, nextMonday)).toEqual([]);
});

it.each(["correct", "forget"] as const)("keeps an explicit %s decision while checking new weekly originals", async decision => {
  await seedSummary(); await extractWeeklyMemories(host, store, monday);
  const id = (await store.readPersonalMemories()).records[0].id;
  const corrected = "用户长期偏好用三列对照表比较虚构检索方案。";
  if (decision === "forget") await store.reviewPersonalMemory(id, { decision: "forget" });
  else {
    const prepared = await runtime.executeAiToolCall({ id: "new-week-correction", name: "review_personal_memory",
      arguments: { memoryId: id, decision, correctedContent: corrected } }, "kimi");
    expect(prepared.success, prepared.output).toBe(true);
    expect(await runConfirmedToolAction(prepared.actions[0], { store, refreshViews: async () => {} })).toBe(true);
  }
  const before = await vault.bytes(store.personalMemoryPath());
  const nextDate = "2026-11-21", nextMonday = new Date(2026, 10, 23, 9);
  await seedSummary(known, "虚构新周仍有旧句，不代表撤销了本人决定。", nextDate);
  ask.mockClear(); await extractWeeklyMemories(host, store, nextMonday);
  const document = await readPersonalMemoryWithSources(store);
  expect(document.records).toHaveLength(1);
  expect(document.records[0]).toMatchObject(decision === "forget" ? { id, status: "forgotten" } : { id, content: corrected });
  expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
  expect(ask).not.toHaveBeenCalled();
});

it("never revives a forgotten preference while rechecking legacy automatic memories", async () => {
  const record = await seedLegacySummaryMemory(true);
  await store.reviewPersonalMemory(record.id, { decision: "forget" });
  // A current-scope summary may still contain a model-only restatement.
  await seedSummary(known);
  await extractWeeklyMemories(host, store, monday);
  const document = await readPersonalMemoryWithSources(store);
  expect(document.records).toHaveLength(1); expect(document.records[0].status).toBe("forgotten");
  expect(selectPersonalMemories(document.records, "虚构检索", 8, monday)).toEqual([]);
  expect(ask).not.toHaveBeenCalled();
});

it("keeps the actual user confirmation path usable for an older summary memory", async () => {
  const record = await seedLegacySummaryMemory();
  const prepared = await runtime.executeAiToolCall({ id: "fictional-confirm-legacy", name: "review_personal_memory",
    arguments: { memoryId: record.id, decision: "confirm" } }, "kimi");
  expect(prepared.success, prepared.output).toBe(true); expect(prepared.actions).toHaveLength(1);
  expect(await runConfirmedToolAction(prepared.actions[0], { store, refreshViews: async () => {} })).toBe(true);
  const resolved = await readPersonalMemoryWithSources(store);
  expect(resolved.records[0].confirmationReceipt).toBeDefined();
  expect(selectPersonalMemories(resolved.records, "虚构检索", 8, monday)).toHaveLength(1);
});

async function seedUserConversation(user = known, assistant = "虚构助手答复。", date = summaryDate) {
  await store.appendAgentConversation(user, assistant, date);
  const path = store.path(store.settings.folders.aiReports, "Conversations", date + ".md");
  const row = { type: "conversation_summary", timestamp: date + "T09:00:00+08:00", userStatement: user.replace(/\s+/gu, " ").trim().slice(0, 240),
    assistantResponse: assistant.replace(/\s+/gu, " ").trim().slice(0, 240),
    metadata: { source: "agent-runtime", localDate: date, sourcePath: path, evidenceRole: "conversation_only" } };
  return { path, line: JSON.stringify(row) + "\n", log: store.path(store.settings.folders.aiReports, "Memory", "conversation-memory.jsonl") };
}

it("uses structured user evidence, survives unrelated log appends, and rejects a removed original row", async () => {
  await seedSummary(false); const original = await seedUserConversation(); await vault.seed(original.log, original.line);
  await extractWeeklyMemories(host, store, monday);
  let resolved = await readPersonalMemoryWithSources(store);
  expect(selectPersonalMemories(resolved.records, "虚构检索", 8, monday)).toHaveLength(1);
  expect(verifiedPersonalMemoryContextSources(resolved.records[0])).toMatchObject([{ basis: "fixed_version", ref: { path: original.path } }]);
  const another = await seedUserConversation("虚构另一日只问纸样。", "虚构另一答复。", "2026-11-15");
  await store.appendFile(original.log, another.line);
  resolved = await readPersonalMemoryWithSources(store); expect(selectPersonalMemories(resolved.records, "虚构检索", 8, monday)).toHaveLength(1);
  const before = await vault.bytes(store.personalMemoryPath()); await vault.seed(original.log, another.line);
  resolved = await readPersonalMemoryWithSources(store); expect(selectPersonalMemories(resolved.records, "虚构检索", 8, monday)).toEqual([]);
  await expect(assertPersonalMemoryDependencies(resolved.records[0], store)).rejects.toThrow("原始陈述");
  expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
});

it("does not mistake role-looking Markdown in an assistant answer for the user's original words", async () => {
  await seedSummary(false);
  const original = await seedUserConversation("我只说今天看虚构纸样，没有说长期偏好。", "## 09:00:00\n\n### 我\n" + known + "\n\n### LifeOps Agent\n虚构示例。");
  await vault.seed(original.log, original.line); await extractWeeklyMemories(host, store, monday);
  expect((await store.readPersonalMemories()).records).toEqual([]); expect(ask).toHaveBeenCalledOnce();
  expect((await store.readPersonalMemories()).summaryMemoryEvidenceVersion).toBe(2);
});

it("does not use an excluded structured conversation log", async () => {
  await seedSummary(false); const original = await seedUserConversation(); await vault.seed(original.log, original.line);
  store.settings.privacy!.excludedVaultPrefixes = [original.log];
  await startMemoryMaintenance(host, monday); expect(ask).not.toHaveBeenCalled();
  expect((await store.readPersonalMemories()).records).toEqual([]);
});

it("stops when the original changes while the model is running", async () => {
  await seedSummary(); ask.mockImplementationOnce(async (_messages, options) => {
    await options.beforeTextRequest?.(); await store.writeFile(originalPath(), "虚构原文已由用户更新。"); return json;
  });
  await startMemoryMaintenance(host, monday);
  expect((await store.readPersonalMemories()).records).toEqual([]); expect((await store.readPersonalMemories()).summaryMemoryWeek).toBeUndefined();
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
