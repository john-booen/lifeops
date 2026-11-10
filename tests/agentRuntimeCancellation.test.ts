import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { AiToolCall } from "../src/ai";
import type { StoreHost } from "../src/store/settingsSlice";
import { DEFAULT_SETTINGS } from "../src/defaults";
vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(),
  requestUrl: vi.fn(() => { throw new Error("Network forbidden"); })
}));
const { AgentRuntime, getCommittedTaskEvidence } = await import("../src/agentRuntime");
const { LifeOpsStore } = await import("../src/store");
const { OperationLedger } = await import("../src/dataFoundation/operationLedger");
const { renderTaskMirror } = await import("../src/dataFoundation/taskPersistence");
const { createPersonalMemory, reviewPersonalMemoryRecord } = await import("../src/personalMemory");
const { projectFileName } = await import("../src/projectContinuity");
const { getLifeOpsTool } = await import("../src/toolRegistry");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
const taskCall = { toolName: "create_task", arguments: { title: "纯虚构取消验证", date: "2026-10-05" }, source: "system" as const, callId: "job-synthetic-cancel-step", confirmedByUser: true };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-runtime-cancel-")); vault = new DiskVault(root);
  store = new LifeOpsStore({ vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault(); runtime = new AgentRuntime({ store, refreshViews: async () => {} });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
function cancellable() {
  let active = true;
  return { cancel: () => { active = false; }, control: { assertCurrent: () => { if (!active) throw new Error("纯虚构取消"); } } };
}
it("does not claim or write when already cancelled", async () => {
  const token = cancellable(); token.cancel(); const before = vault.writes.length;
  const result = await runtime.executeToolCall(taskCall, token.control);
  expect(result.success).toBe(false); expect(vault.writes.length).toBe(before);
});
it("cancellation during task saving restores both facts and never dispatches a checkpoint", async () => {
  const beforeJson = await vault.bytes(store.taskDbPath()), beforeMirror = await vault.bytes(store.taskMirrorPath());
  const entered = deferred(), release = deferred(), token = cancellable();
  const tool = getLifeOpsTool("create_task")!, original = tool.execute;
  vi.spyOn(tool, "execute").mockImplementation(async (...args) => { const result = await original(...args); entered.resolve(); await release.promise; return result; });
  const checkpoint = vi.fn(async () => {});
  const pending = runtime.executeToolCall(taskCall, { ...token.control, checkpoint });
  await entered.promise; token.cancel(); release.resolve(); const result = await pending;
  expect(result.success).toBe(false); expect(checkpoint).not.toHaveBeenCalled();
  expect(await vault.bytes(store.taskDbPath())).toBe(beforeJson); expect(await vault.bytes(store.taskMirrorPath())).toBe(beforeMirror);
  const ledger = await store.readJson<any>(new OperationLedger(store).filePath, {});
  expect(ledger.records.find((r: any) => r.operationId === taskCall.callId).status).toBe("failed");
});
it("cancellation immediately after audit verification restores facts and revokes verified audit", async () => {
  const beforeJson = await vault.bytes(store.taskDbPath()), beforeMirror = await vault.bytes(store.taskMirrorPath());
  const entered = deferred(), release = deferred(), token = cancellable(), original = OperationLedger.prototype.verify;
  vi.spyOn(OperationLedger.prototype, "verify").mockImplementation(async function (this: InstanceType<typeof OperationLedger>, id, result) { const record = await original.call(this, id, result); entered.resolve(); await release.promise; return record; });
  const pending = runtime.executeToolCall(taskCall, token.control); await entered.promise; token.cancel(); release.resolve();
  expect((await pending).success).toBe(false); expect(await vault.bytes(store.taskDbPath())).toBe(beforeJson); expect(await vault.bytes(store.taskMirrorPath())).toBe(beforeMirror);
  const ledger = await store.readJson<any>(new OperationLedger(store).filePath, {});
  expect(ledger.records.find((r: any) => r.operationId === taskCall.callId).status).toBe("failed");
});
it("keeps an already committed receipt truthful if cancellation arrives while refreshing views", async () => {
  const token = cancellable(); runtime = new AgentRuntime({ store, refreshViews: async () => { token.cancel(); } });
  const result = await runtime.executeToolCall(taskCall, token.control);
  expect(result.success).toBe(true); expect((await store.readTaskDb()).tasks).toHaveLength(1);
  expect(getCommittedTaskEvidence(result, store)?.operationId).toBe(taskCall.callId);
});
it("protects checkpoint in the same WAL but task undo excludes internal metadata", async () => {
  const path = store.path(store.settings.folders.aiReports, "Jobs", "synthetic-checkpoint.json");
  const result = await runtime.executeToolCall(taskCall, { assertCurrent: () => {}, userUndoPaths: [store.taskDbPath(), store.taskMirrorPath()], checkpoint: async scope => { await scope.writeJson(path, { synthetic: "control-generation" }); } });
  expect(result.success).toBe(true);
  const wal = await store.readJson<any>(store.path(store.settings.folders.aiReports, "Operations", "write-recovery.json"), {});
  expect(wal.entries).toHaveLength(3); expect(getCommittedTaskEvidence(result, store)?.files).toHaveLength(2);
  await runtime.undoOperation(taskCall.callId);
  expect((await store.readTaskDb()).tasks).toHaveLength(0); expect(await store.readJson(path, {})).toEqual({ synthetic: "control-generation" });
});
it("refuses a first-party checkpoint on an unguarded or unrelated tool", async () => {
  const checkpoint = vi.fn(async () => {});
  const result = await runtime.executeToolCall({ ...taskCall, toolName: "query_vault", arguments: { query: "纯虚构" } }, { assertCurrent: () => {}, checkpoint });
  expect(result.success).toBe(false); expect(checkpoint).not.toHaveBeenCalled();
});
