import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { createPersonalMemory, emptyPersonalMemoryDocument, memoryContentHash, personalMemorySourceAssessment,
  reviewPersonalMemoryRecord, selectPersonalMemories, upsertPersonalMemoryRecord, type PersonalMemoryRecord } from "../src/personalMemory";
import { readPersonalMemoryWithSources } from "../src/personalMemorySources";
import { confirmedMemoryContextSourcePaths, formatConfirmedPersonalMemoryContext } from "../src/personalMemoryContext";
import { preparedContextSourcePaths } from "./helpers/sourceReferences";
import { readVaultQueryWithSources } from "../src/vaultQuery";
import { recordRevision } from "../src/operationIdentity";
import { AgentRuntime } from "../src/agentRuntime";
import { runConfirmedToolAction } from "../src/toolRegistry";
import type { OperationLedgerRecord } from "../src/dataFoundation/operationLedger";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
const stamp = "2026-09-16T10:00:00.000Z", content = "用户偏好简短回复";
const ledgerPath = () => store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
const assessment = (record: PersonalMemoryRecord) => record[personalMemorySourceAssessment]!;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-memory-sources-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function memory(confirmed = false, receipt = false, text = content): PersonalMemoryRecord {
  const sourceRef = { sourceId: confirmed ? "confirmed:test" : "journal:test", path: confirmed ? ledgerPath() : "Notes/source.md", capturedAt: stamp };
  const candidate = createPersonalMemory({ kind: "core_profile", content: text, sourceRefs: [sourceRef] }, stamp);
  return reviewPersonalMemoryRecord([candidate], candidate.id, { decision: "confirm", ...(receipt ? { sourceRef } : {}) }, stamp)[0];
}
async function seed(record: PersonalMemoryRecord): Promise<void> { await vault.seed(store.personalMemoryPath(), JSON.stringify({ ...emptyPersonalMemoryDocument(stamp), records: [record] })); }
function operation(record: PersonalMemoryRecord, changes: Partial<OperationLedgerRecord> = {}): OperationLedgerRecord {
  return { operationId: "confirmed:test", fingerprint: "test", toolName: "confirm_review_memory", source: "system", status: "verified", attempts: 1,
    arguments: { type: "review_memory", memoryId: record.id, memoryDecision: "confirm", content: record.content },
    createdAt: stamp, updatedAt: stamp, finishedAt: stamp, result: { success: true, output: "verified", actions: [] }, ...changes };
}
async function seedLedger(records: OperationLedgerRecord[]): Promise<void> { await vault.seed(ledgerPath(), JSON.stringify({ version: 1, records })); }

describe("read-only personal memory source assessment", () => {
  it.each(["confirm", "correct", "trimmed"] as const)("projects only the current %s basis without exporting old excluded or unverified paths", async state => {
    const text = "合成沟通偏好：先说结论再列依据。", record = memory(true, true, text);
    const oldPath = "Notes/old-excluded.md", missingPath = "Notes/old-missing.md", visiblePath = "Notes/old-visible.md";
    record.revisions.push({ content: "合成沟通偏好：先列依据。", changedAt: stamp, reason: "corrected" });
    record.sourceRefs.push({ sourceId: "journal:old", path: oldPath, capturedAt: stamp },
      { sourceId: "journal:missing", path: missingPath, capturedAt: stamp },
      { sourceId: "confirmed:older", path: "Notes/older-confirmation.md", capturedAt: stamp },
      { sourceId: "journal:visible", path: visiblePath, capturedAt: stamp });
    await seed(record); await vault.seed(oldPath, "合成沟通偏好：先列依据。");
    await vault.seed(visiblePath, "合成沟通偏好：先列依据。");
    store.settings.privacy!.excludedVaultPrefixes = [oldPath];
    const unrelated = operation(record, { operationId: "confirmed:unrelated", arguments: { type: "review_memory", memoryId: "other", memoryDecision: "confirm", content: "旁支事实" } });
    await seedLedger([unrelated, ...(state === "trimmed" ? [] : [operation(record, { arguments: { type: "review_memory", memoryId: record.id,
      memoryDecision: state, ...(state === "correct" ? { correctedMemoryContent: text } : { content: text }) } })])]);
    const beforeMemory = await vault.bytes(store.personalMemoryPath()), beforeLedger = await vault.bytes(ledgerPath());
    const resolved = await readPersonalMemoryWithSources(store), context = formatConfirmedPersonalMemoryContext(resolved.records);
    const toolContext = await store.buildPersonalMemoryContext("沟通偏好");
    for (const body of [context, toolContext]) {
      expect(body).toContain(text); expect(body).toContain(ledgerPath());
      expect(body).toContain(visiblePath); expect(body).toContain("旧来源文件存在；不单独证明当前正文来自该文件");
      expect(body).not.toContain(oldPath); expect(body).not.toContain(missingPath); expect(body).not.toContain("Notes/older-confirmation.md");
      if (state === "correct") expect(body).toContain("当前正文的更正确认操作已核验");
      else expect(body).not.toContain("当前正文的更正确认操作已核验");
      if (state === "trimmed") expect(body).toContain("不能据此推断更正过程");
    }
    expect(confirmedMemoryContextSourcePaths(resolved.records, "沟通偏好", context)).toEqual([ledgerPath(), visiblePath]);
    const read = await readVaultQueryWithSources(store, { domain: "memory", operation: "search", query: "沟通偏好", maxChars: 18_000 });
    try {
      expect(read.sources.blocks).toHaveLength(2);
      expect(read.text).toContain(read.sources.blocks[0].fragment);
      expect(preparedContextSourcePaths([read.sources], read.text)).toEqual([ledgerPath(), visiblePath]);
      expect(read.sources.blocks[0].fragment).not.toContain(oldPath);
      await read.assertSourcesCurrent();
    } finally { read.dispose(); }
    expect(await vault.bytes(store.personalMemoryPath())).toBe(beforeMemory); expect(await vault.bytes(ledgerPath())).toBe(beforeLedger);
    expect(JSON.stringify(resolved)).not.toContain("contextSources"); expect(vault.writes).toEqual([]);
  });
  it("does not turn a legacy file's existence or correction history into current content provenance", async () => {
    const record = memory(); record.revisions.push({ content: "old", changedAt: stamp, reason: "corrected" });
    await seed(record); await vault.seed("Notes/source.md", "This file does not contain the confirmed preference.");
    const resolved = await readPersonalMemoryWithSources(store), context = formatConfirmedPersonalMemoryContext(resolved.records);
    expect(context).toContain(content); expect(context).toContain("旧来源文件存在");
    expect(context).not.toContain("当前正文的确认操作已核验"); expect(context).not.toContain("当前正文的更正确认操作已核验");
  });
  it("excludes missing sources without rewriting memory or adding JSON fields", async () => {
    const record = memory(); await seed(record);
    const before = await vault.bytes(store.personalMemoryPath());
    const resolved = await readPersonalMemoryWithSources(store);
    expect(assessment(resolved.records[0]).usable).toBe(false);
    expect(selectPersonalMemories(resolved.records)).toEqual([]);
    expect(JSON.parse(JSON.stringify(resolved)).records[0]).toEqual(JSON.parse(JSON.stringify(record)));
    expect(recordRevision(resolved.records[0])).toBe(recordRevision(record));
    expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
    expect(vault.writes).toEqual([]);
  });
  it("recognizes an existing original, then marks a rename unresolved without guessing", async () => {
    await seed(memory()); await vault.seed("Notes/source.md", content);
    expect(assessment((await readPersonalMemoryWithSources(store)).records[0]).usable).toBe(true);
    await vault.rename(store.getFile("Notes/source.md")!, "Notes/moved.md");
    const resolved = await readPersonalMemoryWithSources(store);
    expect(assessment(resolved.records[0]).usable).toBe(false);
    expect(resolved.records[0].sourceRefs[0].path).toBe("Notes/source.md");
  });
  it("allows only the exact conversation date path and honors privacy exclusion", async () => {
    const record = memory();
    const path = store.path(store.settings.folders.aiReports, "Conversations", "2026-09-16.md");
    record.sourceRefs = [{ sourceId: "conversation:2026-09-16", path, capturedAt: stamp }];
    await seed(record); await vault.seed(path, content);
    expect(assessment((await readPersonalMemoryWithSources(store)).records[0]).usable).toBe(true);
    store.settings.privacy!.excludedVaultPrefixes = [path];
    expect(assessment((await readPersonalMemoryWithSources(store)).records[0]).usable).toBe(false);
    store.settings.privacy!.excludedVaultPrefixes = [];
    record.sourceRefs[0].sourceId = "conversation:2026-09-15"; await seed(record);
    expect(assessment((await readPersonalMemoryWithSources(store)).records[0]).usable).toBe(false);
  });
  it.each(["../outside.md", "/tmp/outside.md", "Notes/../source.md", "Notes\\source.md"])("rejects unsafe source %s before looking it up", async path => {
    const record = memory(); record.sourceRefs[0].path = path; await seed(record);
    const spy = vi.spyOn(store, "getFile");
    expect(assessment((await readPersonalMemoryWithSources(store)).records[0]).usable).toBe(false);
    expect(spy).not.toHaveBeenCalledWith(path);
  });
  it("uses a verified confirmation independently of a missing diary and checks content/target", async () => {
    const record = memory(true); record.sourceRefs.push({ sourceId: "journal:gone", path: "gone.md", capturedAt: stamp }); await seed(record);
    await seedLedger([operation(record)]);
    expect(assessment((await readPersonalMemoryWithSources(store)).records[0]).usable).toBe(true);
    await seedLedger([operation(record, { arguments: { type: "review_memory", memoryId: "another", memoryDecision: "confirm", content } })]);
    expect(assessment((await readPersonalMemoryWithSources(store)).records[0]).usable).toBe(false);
    await seedLedger([operation(record, { arguments: { type: "review_memory", memoryId: record.id, memoryDecision: "confirm", content: "不同内容" } })]);
    expect(assessment((await readPersonalMemoryWithSources(store)).records[0]).usable).toBe(false);
  });
  it.each(["executing", "failed", "reverted"] as const)("does not let a receipt or diary bypass a current %s operation", async status => {
    const record = memory(true, true); record.sourceRefs.push({ sourceId: "journal:test", path: "Notes/source.md", capturedAt: stamp });
    await seed(record); await vault.seed("Notes/source.md", content); await seedLedger([operation(record, { status })]);
    expect(assessment((await readPersonalMemoryWithSources(store)).records[0]).usable).toBe(false);
  });
  it("survives rolling-ledger trimming with a bound receipt but does not invent legacy receipts", async () => {
    const record = memory(true, true); await seed(record); await seedLedger([]);
    expect(assessment((await readPersonalMemoryWithSources(store)).records[0]).usable).toBe(true);
    delete record.confirmationReceipt; await seed(record);
    const before = await vault.bytes(store.personalMemoryPath());
    expect(assessment((await readPersonalMemoryWithSources(store)).records[0]).usable).toBe(false);
    expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
  });
  it("withholds receipt-based facts when the ledger itself is missing or unreadable", async () => {
    await seed(memory(true, true));
    expect(assessment((await readPersonalMemoryWithSources(store)).records[0]).usable).toBe(false);
    await vault.seed(ledgerPath(), "broken json");
    expect(assessment((await readPersonalMemoryWithSources(store)).records[0]).usable).toBe(false);
  });
  it("keeps memory visible as unresolved when reading the confirmation log fails", async () => {
    const record = memory(true, true); await seed(record); await seedLedger([operation(record)]);
    const read = store.readPath.bind(store);
    vi.spyOn(store, "readPath").mockImplementation(path => path === ledgerPath() ? Promise.reject(new Error("unavailable")) : read(path));
    expect(assessment((await readPersonalMemoryWithSources(store)).records[0]).usable).toBe(false);
  });
  it.each(["version", "memoryId", "contentHash", "confirmedAt", "sourcePath"])("rejects an invalid receipt %s without rewriting", async key => {
    const record = memory(true, true);
    (record.confirmationReceipt as unknown as Record<string, unknown>)[key] = key === "version" ? 2 : "invalid";
    await seed(record); const before = await vault.bytes(store.personalMemoryPath());
    await expect(readPersonalMemoryWithSources(store)).rejects.toThrow();
    expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
  });
  it("writes a receipt through Runtime and removes it with conflict-protected undo", async () => {
    const context = { store, refreshViews: async () => undefined }, runtime = new AgentRuntime(context);
    const proposal = await runtime.executeAiToolCall({ id: "receipt", name: "append_memory_note", arguments: { content, fileName: "个人画像.md" } }, "kimi");
    expect(proposal.success, proposal.output).toBe(true); expect(proposal.actions).toEqual([]);
    const record = (await readPersonalMemoryWithSources(store)).records[0];
    expect(record.confirmationReceipt).toMatchObject({ memoryId: record.id, contentHash: memoryContentHash(content), operationId: proposal.receipt!.operationId });
    expect(assessment(record).usable).toBe(true);
    await runtime.undoOperation(proposal.receipt!.operationId);
    expect((await readPersonalMemoryWithSources(store)).records).toEqual([]);
  });
  it("saves a rule by category in structured personal memory and reports its actual location", async () => {
    const runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
    const saved = await runtime.executeAiToolCall({ id: "category-rule", name: "append_memory_note",
      arguments: { content, category: "rules", explicit: true } }, "kimi");
    expect(saved.success, saved.output).toBe(true);
    const record = (await readPersonalMemoryWithSources(store)).records[0];
    expect(record.kind).toBe("user_rule"); expect(record.tags).toContain("管家规则");
    expect(record.confirmationReceipt?.operationId).toBe(saved.receipt?.operationId);
    expect(assessment(record).usable).toBe(true);
    expect(saved.output).toContain("分类：管家规则"); expect(saved.output).toContain("「关于我」的个人记忆");
    expect(saved.output).not.toContain(".md");
    expect(vault.writes.some(write => write.path.endsWith("管家规则.md"))).toBe(false);
    await runtime.undoOperation(saved.receipt!.operationId);
    expect((await readPersonalMemoryWithSources(store)).records).toEqual([]);
  });
  it("rejects conflicting new and legacy categories without saving or reclassifying memory", async () => {
    await seed(memory(true, true)); await seedLedger([operation(memory(true, true))]);
    const before = await vault.bytes(store.personalMemoryPath());
    const runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
    const saved = await runtime.executeAiToolCall({ id: "conflicting-category", name: "append_memory_note",
      arguments: { content: "合成规则", category: "rules", fileName: "当前状态.md" } }, "kimi");
    expect(saved.success).toBe(false); expect(saved.output).toContain("分类不一致");
    expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
  });
  it("rolls back the receipt with the fact if final Ledger verification fails", async () => {
    const context = { store, refreshViews: async () => undefined }, runtime = new AgentRuntime(context);
    const write = store.writeJson.bind(store); let failed = false;
    vi.spyOn(store, "writeJson").mockImplementation(async (path, value) => {
      if (path === ledgerPath() && !failed && (value as { records: OperationLedgerRecord[] }).records.some(record => record.status === "verified")) {
        failed = true; throw new Error("synthetic finalization failure");
      }
      return write(path, value);
    });
    const failedWrite = await runtime.executeAiToolCall({ id: "receipt-failure", name: "append_memory_note", arguments: { content, fileName: "个人画像.md" } }, "kimi");
    expect(failedWrite.success).toBe(false);
    expect(failed).toBe(true);
    expect((await readPersonalMemoryWithSources(store)).records).toEqual([]);
  });
  it("clears receipts from observations and forgotten records", () => {
    const record = memory(true, true);
    const candidate = upsertPersonalMemoryRecord([], record)[0];
    expect(candidate.confirmationReceipt).toBeUndefined();
    const forgotten = reviewPersonalMemoryRecord([record], record.id, { decision: "forget" })[0];
    expect(forgotten.confirmationReceipt).toBeUndefined();
  });
});
