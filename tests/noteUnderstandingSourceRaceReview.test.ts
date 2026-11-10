import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App, TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { createPersonalMemory, emptyPersonalMemoryDocument, reviewPersonalMemoryRecord } from "../src/personalMemory";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  requestUrl: () => { throw new Error("Network forbidden in independent synthetic source review"); }
}));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { AgentRuntime } = await import("../src/agentRuntime");
const { OperationLedger } = await import("../src/dataFoundation/operationLedger");
const { factRecoveryPath } = await import("../src/dataFoundation/factOperation");
const noteSource = await import("../src/noteUnderstandingSource");
const { listUnderstandingUpdates, prepareUnderstandingUpdate } = await import("../src/noteUnderstandingUpdates");

let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
let runtime: InstanceType<typeof AgentRuntime>, live: boolean, serial = 0;
const sourcePath = "Notes/纯虚构来源版本.md";
const original = "纯虚构本人目前只打算先开始一件事情。\n";
const alternate = "纯虚构本人目前希望同时开始三件事情。\n";
const context = (host = store) => ({ store: host, refreshViews: async () => {}, assertCurrent: () => {
  if (!live) throw new Error("Fictional source host stopped");
} });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function settled<T>(promise: Promise<T>) {
  return promise.then(value => ({ status: "fulfilled" as const, value }), cause => ({ status: "rejected" as const, cause }));
}
function inspect(id = `independent-source-inspect-${++serial}`, hostRuntime = runtime) {
  return hostRuntime.executeAiToolCall({ id, name: "inspect_note_understanding_source", arguments: { path: sourcePath } },
    "kimi", "只读取这篇纯虚构笔记的固定原文，不保存或启用理解");
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-note-source-independent-")); vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  live = true; runtime = new AgentRuntime(context()); await vault.seed(sourcePath, original);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("independent fixed-note source and update consistency review", () => {

  it("does not release raw when the original host closes during Ledger verification", async () => {
    const entered = deferred(), release = deferred(), verify = OperationLedger.prototype.verify;
    vi.spyOn(OperationLedger.prototype, "verify").mockImplementation(async function(this: InstanceType<typeof OperationLedger>, ...args) {
      const result = await verify.apply(this, args); entered.resolve(); await release.promise; return result;
    });
    const pending = settled(inspect());
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error("Expected audit wait was not reached"); })]);
      live = false;
    } finally { release.resolve(); }
    const outcome = await pending;
    expect(outcome.status).toBe("fulfilled");
    if (outcome.status !== "fulfilled") return;
    expect(outcome.value.success).toBe(false);
    expect(outcome.value.output).not.toContain(original.trim());
  });

  it("gives a fresh StoreHost its own read instead of reusing the old token or cached body", async () => {
    const callId = `independent-source-new-host-${++serial}`, old = await inspect(callId);
    expect(old.success, old.output).toBe(true);
    const oldToken = JSON.parse(old.output).sourceToken;
    const freshStore = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    const freshRuntime = new AgentRuntime(context(freshStore));
    const fresh = await inspect(callId, freshRuntime);
    expect(fresh.success, fresh.output).toBe(true);
    expect(JSON.parse(fresh.output).sourceToken).not.toBe(oldToken);
    const proposal = await freshRuntime.executeAiToolCall({ id: `independent-old-token-${++serial}`, name: "propose_note_understanding", arguments: {
      sourceToken: oldToken, path: sourcePath,
      candidates: [{ kind: "current_state", content: "纯虚构待核对的单项安排想法", excerpt: original.trim() }]
    } }, "kimi", "只生成候选确认卡，不保存");
    expect(proposal.success).toBe(false); expect(proposal.actions).toEqual([]);
    expect(freshStore.getFile(freshStore.personalMemoryPath())).toBeNull();
  });

});
