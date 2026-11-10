import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import { personalMemorySourceAssessment } from "../src/personalMemory";
import { activeFactOperation, factRecoveryPath, runFactOperation } from "../src/dataFoundation/factOperation";
import * as operations from "../src/dataFoundation/factOperation";
import { runDerivedOperation } from "../src/dataFoundation/derivedOperation";
import { readPersonalMemoryWithSources } from "../src/personalMemorySources";

vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), requestUrl: () => { throw Error("No network"); } }));
const { LifeOpsStore } = await import("../src/store"), { DiskVault } = await import("./helpers/diskVault"), { AgentRuntime } = await import("../src/agentRuntime");
const { runConfirmedToolAction } = await import("../src/toolRegistry");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>, serial = 0;
const path = "Notes/2026-10-09晚.md", excerpt = "纯虚构我先确认时间再安排任务。", raw = `${excerpt}\n`, claim = "纯虚构安排任务前先确认时间";
const context = () => ({ store, refreshViews: async () => {} });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
async function holdDerived() {
  const entered = deferred(), release = deferred(), version = ++serial;
  const operation = runDerivedOperation(store, async scope => {
    // Different bytes for each writer: a no-op creates no private live identity.
    await scope.writeFile(scope.vaultIndexPath(), JSON.stringify({ entries: [], diagnosticVersion: version }));
    entered.resolve(); await release.promise;
  });
  await entered.promise;
  expect(activeFactOperation(store)?.purpose).toBe("derived");
  return { release, operation, id: activeFactOperation(store)!.operationId };
}
async function holdFact(operationId = `fiction-memory-live-fact-${++serial}`) {
  const entered = deferred(), release = deferred();
  const operation = runFactOperation(store, { operationId }, async scope => {
    await scope.writeFile(scope.path(scope.settings.folders.ideas, `fiction-fact-${++serial}.md`), "纯虚构尚未结束的保存");
    entered.resolve(); await release.promise;
  }, async () => {});
  await entered.promise; expect(activeFactOperation(store)?.operationId).toBe(operationId);
  return { release, operation, id: operationId };
}
const query = () => runtime.executeAiToolCall({ id: `fiction-memory-derived-query-${++serial}`, name: "query_vault", arguments: { domain: "memory", operation: "get", query: "纯虚构" } }, "kimi", "请只读查询个人记忆");
async function seedBoundMemory() {
  await vault.seed(path, raw);
  const read = await runtime.executeAiToolCall({ id: `fiction-memory-derived-source-${++serial}`, name: "inspect_note_understanding_source", arguments: { path } }, "kimi");
  expect(read.success, read.output).toBe(true);
  const proposal = await runtime.executeAiToolCall({ id: `fiction-memory-derived-proposal-${++serial}`, name: "propose_note_understanding", arguments: { path, sourceToken: JSON.parse(read.output).sourceToken, candidates: [{ kind: "current_state", content: claim, excerpt }] } }, "kimi");
  expect(proposal.success, proposal.output).toBe(true); await runConfirmedToolAction(proposal.actions[0], context());
  const candidate = (await store.readPersonalMemories()).records[0]; expect(candidate.status).toBe("candidate");
  const confirm = await runtime.executeAiToolCall({ id: `fiction-memory-derived-confirm-${++serial}`, name: "review_personal_memory", arguments: { memoryId: candidate.id, decision: "confirm" } }, "kimi");
  expect(confirm.success, confirm.output).toBe(true); await runConfirmedToolAction(confirm.actions[0], context());
  const active = (await readPersonalMemoryWithSources(store)).records[0];
  expect(active.status).toBe("active"); expect(active.sourceBinding).toBeDefined();
  expect(active[personalMemorySourceAssessment]?.usable).toBe(true);
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-memory-derived-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; runtime = new AgentRuntime(context()); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("memory queries distinguish derived work from changed user facts", () => {
  it("reads empty memory during a real index writer without a note-style pending gate", async () => {
    const held = await holdDerived(); let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([query(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error("empty memory query unnecessarily waited for derived work")), 750); })]);
      expect(result.success, result.output).toBe(true);
      expect(activeFactOperation(store)?.operationId).toBe(held.id);
      expect((await store.readPersonalMemories()).records).toEqual([]);
    } finally { clearTimeout(timeout); held.release.resolve(); await held.operation; }
  });
  it.each(["fact", "derived"] as const)("does not grant a durable orphan %s journal the private derived exemption", async purpose => {
    await seedBoundMemory(); const active = (await store.readPersonalMemories()).records[0];
    const pending = JSON.stringify({ version: 1, operationId: active.confirmationReceipt!.operationId, purpose, status: "pending", entries: [] }); await vault.seed(factRecoveryPath(store), pending);
    expect(activeFactOperation(store)).toBeUndefined();
    const record = (await readPersonalMemoryWithSources(store)).records[0]; expect(record[personalMemorySourceAssessment]?.usable).toBe(false);
    expect(await vault.bytes(factRecoveryPath(store))).toBe(pending); expect(await vault.bytes(path)).toBe(raw);
  });
  it("rejects an unknown durable journal rather than ignoring its declared derived purpose", async () => {
    await seedBoundMemory(); const pending = JSON.stringify({ version: 99, purpose: "derived", status: "pending", entries: [] }); await vault.seed(factRecoveryPath(store), pending);
    await expect(readPersonalMemoryWithSources(store)).rejects.toThrow(); expect(await vault.bytes(factRecoveryPath(store))).toBe(pending); expect(await vault.bytes(path)).toBe(raw);
  });
  it.each(["derived", "fact"] as const)("rechecks the privately live %s writer that starts inside the awaited pending read", async purpose => {
    await seedBoundMemory(); const active = (await store.readPersonalMemories()).records[0];
    const original = operations.hasPendingFactOperation; let held: Awaited<ReturnType<typeof holdFact>> | Awaited<ReturnType<typeof holdDerived>> | undefined;
    vi.spyOn(operations, "hasPendingFactOperation").mockImplementationOnce(async host => { held = purpose === "derived" ? await holdDerived() : await holdFact(active.confirmationReceipt!.operationId); return original(host); });
    try { const record = (await readPersonalMemoryWithSources(store)).records[0]; expect(record[personalMemorySourceAssessment]?.usable).toBe(purpose === "derived"); expect(activeFactOperation(store)?.operationId).toBe(held!.id); }
    finally { held?.release.resolve(); await held?.operation; }
  });
  it("keeps original and privacy changes unavailable while the private writer is derived", async () => {
    await seedBoundMemory(); const before = await vault.bytes(store.personalMemoryPath()), held = await holdDerived();
    try {
      await vault.seed(path, raw + "纯虚构后续改变。\n"); expect((await readPersonalMemoryWithSources(store)).records[0][personalMemorySourceAssessment]?.usable).toBe(false);
      await vault.seed(path, raw); store.settings.privacy!.excludedVaultPrefixes = [path]; expect((await readPersonalMemoryWithSources(store)).records[0][personalMemorySourceAssessment]?.usable).toBe(false);
      expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
    } finally { held.release.resolve(); await held.operation; }
  });
  it("cannot use a privately derived scope to write source notes or PersonalMemory", async () => {
    await seedBoundMemory(); const before = await vault.bytes(store.personalMemoryPath()), managedSource = store.path(store.settings.folders.ideas, "fiction-must-stay.md");
    await vault.seed(managedSource, raw);
    for (const target of [managedSource, store.personalMemoryPath()]) {
      const content = target === managedSource ? "纯虚构越界写入" : JSON.stringify(JSON.parse(before));
      await expect(runDerivedOperation(store, scope => scope.writeFile(target, content))).rejects.toThrow(/不能修改用户记录/);
    }
    expect(await vault.bytes(managedSource)).toBe(raw); expect(await vault.bytes(path)).toBe(raw); expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
  });
  it("strictly validates a fresh WAL that changes to unknown schema after the pending snapshot", async () => {
    await seedBoundMemory(); const active = (await store.readPersonalMemories()).records[0], pending = JSON.stringify({ version: 1, operationId: active.confirmationReceipt!.operationId, status: "pending", entries: [] });
    await vault.seed(factRecoveryPath(store), pending);
    const original = operations.hasPendingFactOperation, unknown = JSON.stringify({ version: 99, status: "pending", purpose: "derived", entries: [] });
    vi.spyOn(operations, "hasPendingFactOperation").mockImplementationOnce(async host => { const sampled = await original(host); await vault.seed(factRecoveryPath(store), unknown); return sampled; });
    await expect(readPersonalMemoryWithSources(store)).rejects.toThrow(); expect(await vault.bytes(factRecoveryPath(store))).toBe(unknown); expect(await vault.bytes(path)).toBe(raw);
  });
  it("uses a fresh completed WAL rather than the earlier pending confirmation snapshot", async () => {
    await seedBoundMemory(); const active = (await store.readPersonalMemories()).records[0], pending = { version: 1, operationId: active.confirmationReceipt!.operationId, status: "pending", entries: [] };
    await vault.seed(factRecoveryPath(store), JSON.stringify(pending)); const committed = JSON.stringify({ ...pending, status: "committed" }), original = operations.hasPendingFactOperation;
    vi.spyOn(operations, "hasPendingFactOperation").mockImplementationOnce(async host => { const sampled = await original(host); await vault.seed(factRecoveryPath(store), committed); return sampled; });
    expect((await readPersonalMemoryWithSources(store)).records[0][personalMemorySourceAssessment]?.usable).toBe(true); expect(await vault.bytes(factRecoveryPath(store))).toBe(committed);
  });
  it("retains a fact that starts during the fresh WAL reread", async () => {
    await seedBoundMemory(); const active = (await store.readPersonalMemories()).records[0], original = store.readPath.bind(store); let held: Awaited<ReturnType<typeof holdFact>> | undefined;
    vi.spyOn(operations, "hasPendingFactOperation").mockResolvedValueOnce(true);
    vi.spyOn(store, "readPath").mockImplementation(async target => { const content = await original(target); if (target === factRecoveryPath(store) && !held) held = await holdFact(active.confirmationReceipt!.operationId); return content; });
    try { expect((await readPersonalMemoryWithSources(store)).records[0][personalMemorySourceAssessment]?.usable).toBe(false); expect(activeFactOperation(store)?.operationId).toBe(held!.id); }
    finally { held?.release.resolve(); await held?.operation; }
  });
  it("recognizes a derived writer that starts during the fresh WAL reread without rewriting its recovery", async () => {
    await seedBoundMemory(); const original = store.readPath.bind(store); let held: Awaited<ReturnType<typeof holdDerived>> | undefined;
    vi.spyOn(operations, "hasPendingFactOperation").mockResolvedValueOnce(true);
    vi.spyOn(store, "readPath").mockImplementation(async target => { const content = await original(target); if (target === factRecoveryPath(store) && !held) held = await holdDerived(); return content; });
    try { expect((await readPersonalMemoryWithSources(store)).records[0][personalMemorySourceAssessment]?.usable).toBe(true); expect(activeFactOperation(store)?.operationId).toBe(held!.id); expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("pending"); }
    finally { held?.release.resolve(); await held?.operation; }
  });
});
