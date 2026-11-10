import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import type { AgentActionSuggestion } from "../src/types";
import { tradingDocumentPath } from "../src/dataFoundation/tradingPersistence";
import { factRecoveryPath } from "../src/dataFoundation/factOperation";
import { createPersonalMemory, reviewPersonalMemoryRecord } from "../src/personalMemory";
import { createPersonalMemoryContextFilter, personalMemoryContextRevision } from "../src/personalMemoryContext";

vi.mock("obsidian", () => ({
  App: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  requestUrl: () => { throw new Error("Network forbidden in fictional review races"); }
}));

const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { AgentRuntime } = await import("../src/agentRuntime");
const { OperationLedger } = await import("../src/dataFoundation/operationLedger");
const { runConfirmedToolAction } = await import("../src/toolRegistry");
const { buildTradingResearchContext } = await import("../src/tradingTools");
const memorySources = await import("../src/personalMemorySources");

let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
let runtime: InstanceType<typeof AgentRuntime>, live: boolean, serial = 0;
const context = () => ({ store, refreshViews: async () => {}, assertCurrent: () => {
  if (!live) throw new Error("Fictional host closed");
} });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function settled<T>(promise: Promise<T>) {
  return promise.then(value => ({ status: "fulfilled" as const, value }),
    cause => ({ status: "rejected" as const, cause }));
}
async function card(input: Record<string, string>) {
  const result = await runtime.executeAiToolCall({ id: `fictional-race-proposal-${++serial}`,
    name: "propose_trading_research_change", arguments: { command: { kind: "save_model", input } }
  }, "kimi", "纯虚构研究，只生成待确认记录，不执行交易");
  expect(result.success, result.output).toBe(true);
  expect(result.actions).toHaveLength(1);
  return result.actions[0];
}
const confirm = (action: AgentActionSuggestion) => runConfirmedToolAction(action, context());
async function publicQuery() {
  const result = await runtime.executeAiToolCall({ id: `fictional-race-query-${++serial}`,
    name: "query_trading_research", arguments: {}
  }, "kimi", "纯虚构只读研究查询");
  if (!result.success) throw new Error(result.output);
  return result.output;
}
async function baseline() {
  await confirm(await card({ title: "纯虚构已保存研究基线", entry: "基线仅供研究" }));
  return vault.bytes(tradingDocumentPath(store));
}
async function source(name: string) {
  const path = store.path(store.settings.folders.tradingReviews, `${name}.md`);
  await vault.seed(path, "纯虚构原文第一版\n");
  return path;
}
function pauseVerified(operationId: string) {
  const entered = deferred(), release = deferred(), original = OperationLedger.prototype.verify;
  vi.spyOn(OperationLedger.prototype, "verify").mockImplementation(async function (
    this: InstanceType<typeof OperationLedger>, ...args
  ) {
    const record = await original.apply(this, args);
    if (args[0] === operationId) { entered.resolve(); await release.promise; }
    return record;
  });
  return { entered, release };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-trading-race-review-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  live = true;
  runtime = new AgentRuntime(context());
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("independent trading research confirmation and publication races in fictional DiskVault", () => {
  it.each(["public query", "duplicate confirmation"] as const)(
    "does not acknowledge a verified audit with pending final commit through %s", async route => {
      const before = await baseline(), path = await source("纯虚构审计等待来源");
      const action = await card({ title: "纯虚构尚未提交候选", entry: "这条规则仍等待最终保护", sourcePath: path });
      const operationId = `confirmed:${action.id}`, pause = pauseVerified(operationId);
      const saving = settled(confirm(action));
      await pause.entered.promise;
      let observed: Awaited<ReturnType<typeof settled<string | boolean>>>;
      try {
        expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("pending");
        const ledger = await store.readJson<any>(new OperationLedger(store).filePath, {});
        expect(ledger.records.find((record: any) => record.operationId === operationId).status).toBe("verified");
        observed = await settled<string | boolean>(route === "public query" ? publicQuery() : confirm(action));
        await vault.seed(path, "纯虚构最终提交前外部更正\n");
      } finally { pause.release.resolve(); }
      const firstResult = await saving;
      expect(firstResult.status, "the original save must actually reject after the external source change").toBe("rejected");
      expect(await vault.bytes(tradingDocumentPath(store))).toBe(before);
      expect(await vault.bytes(path)).toBe("纯虚构最终提交前外部更正\n");
      expect(observed!.status, "pending candidate must neither be published nor acknowledged as saved").toBe("rejected");
    }
  );

  it("does not adopt new source bytes as its baseline after validating the old card context", async () => {
    const before = await baseline(), path = await source("纯虚构二次来源读取");
    const action = await card({ title: "纯虚构旧来源候选", entry: "用户核对的是第一版原文", sourcePath: path });
    const read = vault.read.bind(vault);
    let reads = 0;
    vi.spyOn(vault, "read").mockImplementation(async file => {
      if (file.path === path && ++reads === 2) await vault.seed(path, "纯虚构用户随后更正的第二版原文\n");
      return read(file);
    });
    const result = await settled(confirm(action));
    expect(reads, "the path-specific race must reach the baseline source read").toBeGreaterThanOrEqual(2);
    expect(await vault.bytes(path)).toBe("纯虚构用户随后更正的第二版原文\n");
    expect(result.status, "new source bytes cannot silently replace the reviewed card baseline").toBe("rejected");
    expect(await vault.bytes(tradingDocumentPath(store))).toBe(before);
  });

  it("does not adopt a confirmed memory correction during the second memory read after card validation", async () => {
    const before = await baseline(), path = await source("纯虚构已确认记忆来源");
    const oldText = "纯虚构我当前只研究条件甲", newText = "纯虚构我已更正为只研究条件乙";
    const stamp = "2026-10-05T03:00:00.000Z", nextStamp = "2026-10-05T03:01:00.000Z";
    const originalRecord = createPersonalMemory({ kind: "current_state", truth: "explicit_fact", content: oldText,
      sourceRefs: [{ sourceId: "fictional-memory-source", path, capturedAt: stamp }] }, stamp);
    const confirmed = reviewPersonalMemoryRecord([originalRecord], originalRecord.id, { decision: "confirm" }, stamp);
    const corrected = reviewPersonalMemoryRecord(confirmed, originalRecord.id, { decision: "correct", content: newText }, nextStamp);
    await vault.seed(store.personalMemoryPath(), JSON.stringify({ version: 1, updatedAt: stamp, records: confirmed }));
    const usableBefore = await memorySources.readPersonalMemoryWithSources(store);
    expect(usableBefore.records[0].status).toBe("active");
    const oldRevision = personalMemoryContextRevision(usableBefore.records);
    const action = await card({ title: "纯虚构旧记忆候选", entry: oldText });
    const readMemory = memorySources.readPersonalMemoryWithSources;
    let reads = 0;
    vi.spyOn(memorySources, "readPersonalMemoryWithSources").mockImplementation(async host => {
      if (++reads === 2) await vault.seed(store.personalMemoryPath(), JSON.stringify({ version: 1, updatedAt: nextStamp, records: corrected }));
      return readMemory(host);
    });
    const result = await settled(confirm(action)), latest = await readMemory(store);
    expect(reads, "the real memory correction must land after the reviewed-context read").toBeGreaterThanOrEqual(2);
    expect(latest.records[0].content).toBe(newText);
    expect(personalMemoryContextRevision(latest.records)).not.toBe(oldRevision);
    expect(createPersonalMemoryContextFilter(latest.records)(oldText)).not.toContain(oldText);
    expect(result.status, "the old card must not be saved using a newly corrected memory baseline").toBe("rejected");
    expect(await vault.bytes(tradingDocumentPath(store))).toBe(before);
  });

  it.each(["source bytes", "source exclusion"] as const)(
    "rechecks %s changed while the direct read helper's final memory filter awaits", async cause => {
      const path = await source("纯虚构发布前来源"), secret = "纯虚构不能在来源变化后继续发布的旧规则";
      await confirm(await card({ title: "纯虚构发布核对规则", entry: secret, sourcePath: path }));
      const before = await vault.bytes(tradingDocumentPath(store)), entered = deferred(), release = deferred();
      const readMemory = memorySources.readPersonalMemoryWithSources;
      let reads = 0;
      vi.spyOn(memorySources, "readPersonalMemoryWithSources").mockImplementation(async host => {
        const document = await readMemory(host);
        if (++reads === 3) { entered.resolve(); await release.promise; }
        return document;
      });
      const query = settled(buildTradingResearchContext(store));
      await entered.promise;
      try {
        if (cause === "source bytes") await vault.seed(path, "纯虚构发布等待期间的新原文\n");
        else store.settings.privacy!.excludedVaultPrefixes = [path];
      } finally { release.resolve(); }
      const result = await query;
      expect(reads, "the source change must occur inside the actual final memory read").toBeGreaterThanOrEqual(3);
      expect(await vault.bytes(tradingDocumentPath(store))).toBe(before);
      expect(result.status, "the query must reject rather than publish stale or newly excluded rule text").toBe("rejected");
    }
  );
});
