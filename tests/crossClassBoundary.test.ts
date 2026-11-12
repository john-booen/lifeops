import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentRuntime } from "../src/agentRuntime";
import { runDerivedOperation } from "../src/dataFoundation/derivedOperation";
import { factRecoveryPath, fileRevision, recoverFactOperation } from "../src/dataFoundation/factOperation";
import { RecoveryCapacityError } from "../src/dataFoundation/recoveryEncoding";
import { executeProactiveFeedback } from "../src/proactiveFeedbackRuntime";
import { emptyProactivePolicyState } from "../src/proactivePolicy";
import type { ProactiveCandidate } from "../src/scheduler";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: AgentRuntime;
const source = `${DEFAULT_SETTINGS.folders.ideas}/source.md`;
const raw = "# Study\n\nResearch habits and reading notes.\n";
const candidate: ProactiveCandidate = { id: "review-1", kind: "weekly_review", title: "review", reason: "time", priority: "high", workflowId: "weekly_review", createdAt: "2026-09-09T10:00:00Z", expiresAt: "2026-09-10T10:00:00Z", dedupeKey: "weekly:2026-09-09", evidenceRefs: [], confidence: 0.8, voiceEligible: false };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-crossclass-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; runtime = new AgentRuntime({ store, refreshViews: async () => undefined }); await vault.seed(source, raw); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const auditPath = () => store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
function derivedPaths() { return [store.sourceManifestPath(), store.vaultIndexPath(), store.chunkIndexPath(), store.knowledgeGraphPath(), store.memoryIndexPath()]; }

describe("cross-class persistence boundaries", () => {
  it("synchronizes all source derivatives without user-fact or recursive audit writes", async () => {
    await store.syncVaultSources();
    for (const path of derivedPaths()) expect(store.getFile(path), path).not.toBeNull();
    expect(await vault.bytes(source)).toBe(raw);
    expect(store.getFile(store.personalMemoryPath())).toBeNull();
    expect(store.getFile(auditPath())).toBeNull();
    expect(JSON.parse(await vault.bytes(factRecoveryPath(store)))).toMatchObject({ purpose: "derived", status: "committed" });
  });
  it("rolls back a partial source refresh and can rebuild on retry", async () => {
    await store.syncVaultSources();
    const before = await Promise.all(derivedPaths().map(path => vault.bytes(path)));
    await vault.seed(source, raw + "New source material.\n");
    const process = vault.process.bind(vault);
    let failed = false;
    vi.spyOn(vault, "process").mockImplementation(async (file, update) => {
      if (file.path === store.knowledgeGraphPath() && !failed) { failed = true; throw new Error("simulated graph failure"); }
      return process(file, update);
    });
    await expect(store.syncVaultSources()).rejects.toThrow("simulated graph failure");
    expect(await Promise.all(derivedPaths().map(path => vault.bytes(path)))).toEqual(before);
    expect(await vault.bytes(source)).toBe(raw + "New source material.\n");
    await store.syncVaultSources();
    expect(await vault.bytes(store.chunkIndexPath())).toContain("New source material");
  });
  it("uses recoverable per-source writes when a full refresh exceeds capacity", async () => {
    const other = store.path(store.settings.folders.ideas, "fictional-other.md");
    const otherText = "# Fictional note\n\nAnother independent source.";
    await vault.seed(other, otherText);
    const run = vi.spyOn(store, "runFactOperation").mockRejectedValueOnce(new RecoveryCapacityError());

    await expect(store.syncVaultSources()).resolves.toEqual({ addedOrChanged: 2, deleted: 0, unchanged: 0 });
    expect(run).toHaveBeenCalledTimes(3);
    expect((await store.readSourceManifest()).entries.map(row => row.path).sort()).toEqual([source, other].sort());
    expect(await vault.bytes(source)).toBe(raw);
    expect(await vault.bytes(other)).toBe(otherText);
    expect(store.getFile(auditPath())).toBeNull();
    await expect(store.syncVaultSources()).resolves.toEqual({ addedOrChanged: 0, deleted: 0, unchanged: 2 });
  });
  it("prevents a derived operation from writing personal facts", async () => {
    await expect(runDerivedOperation(store, scope => scope.writeFile(source, "replacement"))).rejects.toThrow("不能修改用户记录");
    expect(await vault.bytes(source)).toBe(raw);
  });
  it("refuses reads from an interrupted index batch until explicit recovery", async () => {
    await store.syncVaultSources();
    const path = store.chunkIndexPath(), before = await vault.bytes(path), after = '{"generatedAt":"","chunks":[]}';
    await vault.seed(path, after);
    await vault.seed(factRecoveryPath(store), JSON.stringify({ version: 1, operationId: "derived:interrupted", purpose: "derived", status: "pending", entries: [{ path, before, after, beforeHash: fileRevision(before), afterHash: fileRevision(after) }] }));
    await expect(store.buildKnowledgeGraphContext("Research")).rejects.toThrow("上次保存被中断");
    const writesBefore = vault.writes.length;
    await expect(store.initializeVault()).rejects.toThrow("已暂停初始化");
    expect(vault.writes.length).toBe(writesBefore);
    expect(await recoverFactOperation(store)).toBe("restored");
    expect(await vault.bytes(path)).toBe(before);
    expect(store.getFile(auditPath())).toBeNull();
  });
  it("waits for a complete derived batch before returning a query", async () => {
    let release!: () => void, entered!: () => void;
    const reached = new Promise<void>(r => { entered = r; });
    const resume = new Promise<void>(r => { release = r; });
    const updating = runDerivedOperation(store, async scope => { await scope.rebuildVaultIndex(); entered(); await resume; });
    await reached;
    let queried = false;
    const query = store.buildIndexSummaryContext().then(value => { queried = true; return value; });
    await Promise.resolve(); expect(queried).toBe(false);
    release(); await updating;
    expect(await query).toContain("indexedFiles: 1");
  });
  it("preserves unsupported index bytes without altering source files", async () => {
    const broken = '{"version":9,"nodes":[],"edges":[]}';
    await vault.seed(store.knowledgeGraphPath(), broken);
    await expect(store.rebuildVaultIndex()).rejects.toThrow();
    expect(await vault.bytes(store.knowledgeGraphPath())).toBe(broken);
    expect(await vault.bytes(source)).toBe(raw);
    expect(store.getFile(store.vaultIndexPath())).toBeNull();
  });
  it("creates separate drafts and preserves edits to previous drafts", async () => {
    const first = await store.writeWorkflowDraft("weekly", "first");
    await vault.seed(first, "my edited draft");
    const second = await store.writeWorkflowDraft("weekly", "second");
    expect(second).not.toBe(first); expect(await vault.bytes(first)).toBe("my edited draft");
    expect(await vault.bytes(second)).toContain("不代表已经完成");
  });
  it("restores feedback policy if the accepted draft fails, then retries once", async () => {
    const initial = { ...emptyProactivePolicyState(), extension: { keep: true } };
    await store.writeProactivePolicyState(initial);
    const before = await vault.bytes(store.proactivePolicyPath());
    const execute = (fail: boolean) => runtime.executeLocalOperation("feedback", { fail }, async scope => executeProactiveFeedback([candidate], await scope.readProactivePolicyState(), candidate.id, "accepted", {
      writePolicyState: next => scope.writeProactivePolicyState(next),
      createWorkflowDraft: async () => { if (fail) throw new Error("draft failed"); return scope.writeWorkflowDraft("weekly", "draft"); },
      appendAudit: async () => undefined
    }));
    expect((await execute(true)).success).toBe(false);
    expect(await vault.bytes(store.proactivePolicyPath())).toBe(before);
    expect((await execute(false)).success).toBe(true);
    expect((await execute(false)).success).toBe(true);
    expect(vault.getMarkdownFiles().filter(file => file.path.includes("/Workflows/"))).toHaveLength(1);
    expect(JSON.parse(await vault.bytes(store.proactivePolicyPath())).extension).toEqual({ keep: true });
  });
});
