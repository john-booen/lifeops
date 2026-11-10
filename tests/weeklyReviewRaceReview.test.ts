import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App, TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import type { AgentActionSuggestion } from "../src/types";

vi.mock("obsidian", () => ({
  App: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  requestUrl: () => { throw new Error("Network forbidden in independent synthetic review"); }
}));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { AgentRuntime } = await import("../src/agentRuntime");
const { OperationLedger } = await import("../src/dataFoundation/operationLedger");
const weekly = await import("../src/weeklyReview");
const { runConfirmedToolAction } = await import("../src/toolRegistry");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
let runtime: InstanceType<typeof AgentRuntime>, live: boolean, serial = 0;
const sourcePath = "Notes/2026-10-01.md";
const original = "纯虚构本人当日尝试只安排一件事情。\n";
const alternate = "纯虚构本人当日希望同时安排三件事情。\n";
const sourceArgs = { startDate: "2026-10-01", endDate: "2026-10-01", paths: [sourcePath] };
const context = () => ({ store, refreshViews: async () => {}, assertCurrent: () => {
  if (!live) throw new Error("Fictional weekly-review host stopped");
} });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function settled<T>(promise: Promise<T>) {
  return promise.then(value => ({ status: "fulfilled" as const, value }), cause => ({ status: "rejected" as const, cause }));
}
function inspect(id = `independent-weekly-inspect-${++serial}`) {
  return runtime.executeAiToolCall({ id, name: "inspect_weekly_review_sources", arguments: structuredClone(sourceArgs) },
    "kimi", "只读这篇纯虚构笔记，日期为2026-10-01，先不要保存任何回顾");
}
async function card(): Promise<AgentActionSuggestion> {
  const collected = await inspect(); expect(collected.success, collected.output).toBe(true);
  const sourceToken = JSON.parse(collected.output).sourceToken;
  const result = await runtime.executeAiToolCall({ id: `independent-weekly-proposal-${++serial}`, name: "propose_weekly_review", arguments: {
    sourceToken, hypotheses: [{ claim: "纯虚构可能单项安排更适合当日", supports: [{ path: sourcePath, excerpt: original.trim() }],
      counterexamples: [], uncertainties: ["只有一篇记录，是否代表长期习惯未知"] }]
  } }, "kimi", "从这份已选择原文生成待我核对的周回顾草稿，不确认记忆或完成任务");
  expect(result.success, result.output).toBe(true); expect(result.actions).toHaveLength(1);
  return result.actions[0];
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-weekly-race-independent-")); vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  live = true; runtime = new AgentRuntime(context()); await vault.seed(sourcePath, original);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("independent weekly-review source and receipt race review", () => {


  it("does not acknowledge an old saved-draft card after handwritten feedback was appended", async () => {
    const action = await card(); await runConfirmedToolAction(action, context());
    const path = action.weeklyReviewPath!, before = await vault.bytes(path);
    const handwritten = `${before}\n## 本人手写更正\n纯虚构：前面的假设不符合本人情况。\n`;
    await vault.seed(path, handwritten);
    const writes = vault.writes.length;
    const outcome = await settled(runConfirmedToolAction(action, context()));
    expect(await vault.bytes(path)).toBe(handwritten); expect(vault.writes).toHaveLength(writes);
    expect(outcome.status, "containing the old card body is not an exact saved-draft receipt").toBe("rejected");
  });

  it("does not acknowledge cached confirmation if its target changes in the final source wait", async () => {
    const action = await card(); await runConfirmedToolAction(action, context());
    const path = action.weeklyReviewPath!, before = await vault.bytes(path);
    const handwritten = `${before}\n## 最后读取期间的本人更正\n纯虚构：请保留这句更正，原卡不再代表当前稿。\n`;
    const entered = deferred(), release = deferred(), read = vault.read.bind(vault);
    let targetRead = false, paused = false;
    vi.spyOn(vault, "read").mockImplementation(async (file: TFile) => {
      const raw = await read(file);
      if (file.path === path) targetRead = true;
      if (targetRead && !paused && file.path === sourcePath) {
        paused = true; entered.resolve(); await release.promise;
      }
      return raw;
    });
    const pending = settled(runConfirmedToolAction(action, context()));
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error("Expected cached confirmation source wait was not reached"); })]);
      await vault.seed(path, handwritten);
    } finally { release.resolve(); }
    const outcome = await pending;
    expect(await vault.bytes(path)).toBe(handwritten);
    expect(outcome.status, "target bytes must remain protected throughout the last source guard").toBe("rejected");
  });
});
