import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl, type App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { LifeOpsAi } from "../src/ai";
import { classifyByRules } from "../src/classifier";
import { setProviderEgressSink } from "../src/privacy";
import type { StoreHost } from "../src/store/settingsSlice";
import type { ProviderRunResult } from "../src/types";
import { factRecoveryPath, hasInterruptedFactOperation, recoverFactOperation } from "../src/dataFoundation/factOperation";

vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: vi.fn(),
  parseYaml: JSON.parse, stringifyYaml: JSON.stringify
}));
const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: any;
const request = requestUrl as unknown as ReturnType<typeof vi.fn>;
function reviewText(line = "合成复盘正文。") { return JSON.stringify({good:[],issues:[],suggestions:[],checklist:[line]}); }
function response(content = reviewText()) {
  return { status: 200, text: "synthetic", json: { model: "reported-model", choices: [{ message: { content } }], data: [{ embedding: [1, 2] }] } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
beforeEach(async () => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected real transport"); }));
  root = await mkdtemp(join(tmpdir(), "lifeops-finite-independent-"));
  vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.privacy = { excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
  Object.assign(settings.ai, { provider: "kimi", endpoint: "https://synthetic.invalid", model: "configured-model", apiKey: "synthetic-secret", dataDisclosureAccepted: true, fallbackProvider: "off" });
  Object.assign(settings.embedding, { provider: "openai-compatible", endpoint: "https://synthetic.invalid/embedding", model: "vector-model", apiKey: "synthetic-secret", dataDisclosureAccepted: true });
  store = new LifeOpsStore(app, settings) as unknown as StoreHost;
  await store.initializeVault();
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), { app, store, settings, refreshViews: vi.fn(async () => {}), updateStatusBar: vi.fn(async () => {}),
    lifeOpsEvents: { publish: vi.fn() }, ai: new LifeOpsAi(settings), saveData: vi.fn(async () => {}), hardenPluginDataPermissions: vi.fn(async () => {}), proactiveLifecycle: { setEnabled: vi.fn() } });
  request.mockReset(); request.mockResolvedValue(response());
});
afterEach(async () => {
  setProviderEgressSink(null); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});
async function facts() {
  const snapshot: Record<string, string> = {};
  async function visit(folder: string, prefix = "") {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (path.includes("/Operations/") || path.includes("/Quality/") || path.endsWith("/Operations") || path.endsWith("/Quality")) continue;
      if (entry.isDirectory()) await visit(join(folder, entry.name), path);
      else snapshot[path] = await readFile(join(folder, entry.name), "utf8");
    }
  }
  await visit(root); return snapshot;
}
function invoke(method: string, signal: AbortSignal) {
  return method === "capture" ? plugin.capture("创建合成任务", "synthetic", { signal }) : plugin[method](signal);
}
function blockCommittedWrite(kind: "ledger" | "wal", entered: ReturnType<typeof deferred<void>>, release: ReturnType<typeof deferred<void>>) {
  const original = vault.process.bind(vault);
  let blocked = false;
  vi.spyOn(vault, "process").mockImplementation(async (file, updater) => {
    if (!blocked && file.path.endsWith(kind === "ledger" ? "/operation-ledger.json" : "/write-recovery.json")) {
      const next = JSON.parse(updater(await vault.read(file)));
      if (kind === "ledger" ? next.records.some((row: any) => row.status === "verified") : next.status === "committed") {
        blocked = true; entered.resolve(); await release.promise;
      }
    }
    return original(file, updater);
  });
}

describe("independent finite provider commit cancellation", () => {
  it.each(["capture", "generateDailyReview", "generateTradingReview"])("%s restores facts when cancelled while verified Ledger is waiting to write", async method => {
    if (method === "capture") request.mockResolvedValue(response(JSON.stringify({ kind: "todo", confidence: 0.99, title: "合成任务", content: "合成任务" })));
    const before = await facts(), entered = deferred<void>(), release = deferred<void>(), abort = new AbortController();
    blockCommittedWrite("ledger", entered, release);
    const pending = invoke(method, abort.signal).catch((error: Error) => error);
    await entered.promise; abort.abort(); release.resolve();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(await facts()).toEqual(before);
  });
  it("restores a review when cancelled while committed WAL is waiting to write", async () => {
    const before = await facts(), entered = deferred<void>(), release = deferred<void>(), abort = new AbortController();
    blockCommittedWrite("wal", entered, release);
    const pending = plugin.generateTradingReview(abort.signal).catch((error: Error) => error);
    await entered.promise; abort.abort(); release.resolve();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(await facts()).toEqual(before);
  });
  it("restores the old vector index when cancelled while committed WAL is waiting to write", async () => {
    await vault.seed(`${plugin.settings.folders.ideas}/合成知识.md`, "合成知识正文");
    await store.rebuildVaultIndex();
    await store.rebuildVectorIndex("before-model", async () => [8, 9]);
    const before = await vault.bytes(store.vectorIndexPath()), entered = deferred<void>(), release = deferred<void>(), abort = new AbortController();
    blockCommittedWrite("wal", entered, release);
    const pending = plugin.rebuildVectorIndexIfEnabled(abort.signal).catch((error: Error) => error);
    await entered.promise; abort.abort(); release.resolve();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(await vault.bytes(store.vectorIndexPath())).toBe(before);
  });
});

describe("independent finite text total timeout", () => {
  it("allows a summary transport to use its longer deadline", async () => {
    const entered = deferred<void>(), release = deferred<ReturnType<typeof response>>();
    request.mockImplementation(() => { entered.resolve(); return release.promise; });
    vi.useFakeTimers();
    const ai = new LifeOpsAi(plugin.settings);
    let settled = false;
    const result = ai.generateSummary([{ role: "user", content: "虚构摘要资料" }])
      .then(value => { settled = true; return value; }, error => { settled = true; return error; });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30_001);
    expect(settled).toBe(false);
    release.resolve(response("虚构摘要"));
    expect(await result).toBe("虚构摘要");
  });

  it.each(["classify", "generateSummary", "tradingReview"])("%s settles within the 30 second timeout while its egress audit is blocked", async method => {
    const entered = deferred<void>(), release = deferred<void>();
    setProviderEgressSink(async () => { entered.resolve(); await release.promise; });
    vi.useFakeTimers();
    let settled = false;
    const runs: ProviderRunResult[] = [];
    const options = { onProviderRun: (run: ProviderRunResult) => runs.push(run) };
    const ai = new LifeOpsAi(plugin.settings);
    const result = (method === "classify" ? ai.classify("合成备注", classifyByRules("合成备注", "synthetic"), options)
      : method === "generateSummary" ? ai.generateSummary([{ role: "user", content: "合成资料" }], options, { timeoutMs: 30_000 })
      : ai.tradingReview("合成资料", options))
      .then(value => { settled = true; return value; }, error => { settled = true; return error; });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30_001);
    const bounded = settled;
    release.resolve(); const outcome = await result;
    expect(bounded).toBe(true);
    expect(outcome).toMatchObject({ code: "timeout" });
    expect(runs).toEqual([expect.objectContaining({ status: "failed", attempts: [expect.objectContaining({ errorCode: "timeout" })] })]);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("independent malformed finite response classification", () => {
  it.each([null, { choices: [{ message: { content: { synthetic: "object" } } }] }])("classifies malformed text response %j as invalid_response", async json => {
    request.mockResolvedValue({ status: 200, text: "synthetic", json });
    await expect(new LifeOpsAi(plugin.settings).classify("合成备注", classifyByRules("合成备注", "synthetic")))
      .rejects.toMatchObject({ code: "invalid_response" });
  });
  it("classifies nontext transcription as invalid_response", async () => {
    Object.assign(plugin.settings.voice, { provider: "openai-compatible", endpoint: "https://synthetic.invalid/asr", model: "configured-asr", dataDisclosureAccepted: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: 42 }) }));
    await expect(new LifeOpsAi(plugin.settings).transcribeAudio(new Blob(["synthetic audio"])))
      .rejects.toMatchObject({ code: "invalid_response" });
  });
});

async function interruptCancelledRollback() {
  const entered = deferred<void>(), release = deferred<void>(), abort = new AbortController();
  const original = vault.process.bind(vault);
  let blocked = false;
  vi.spyOn(vault, "process").mockImplementation(async (file, updater) => {
    if (file.path.endsWith("/operation-ledger.json")) {
      const next = JSON.parse(updater(await vault.read(file)));
      if (next.records.some((row: any) => row.status === "failed")) throw new Error("Synthetic interruption after rollback intent");
      if (!blocked && next.records.some((row: any) => row.status === "verified")) {
        blocked = true; entered.resolve(); await release.promise;
      }
    }
    return original(file, updater);
  });
  const pending = plugin.generateTradingReview(abort.signal).catch((error: Error) => error);
  await entered.promise; abort.abort(); release.resolve();
  expect(await pending).toMatchObject({ name: "AbortError" });
  const intent = JSON.parse(await vault.bytes(factRecoveryPath(store)));
  expect(intent).toMatchObject({ status: "pending", rollbackRequired: true });
  const ledgerPath = store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
  expect(JSON.parse(await vault.bytes(ledgerPath)).records.at(-1).status).toBe("verified");
  vi.restoreAllMocks();
  return { intent, ledgerPath };
}

describe("independent finite recovery and committed response", () => {
  it("restores interrupted rollbackRequired facts after restart even when the verified audit survived", async () => {
    const before = await facts();
    const { ledgerPath } = await interruptCancelledRollback();
    const reopened = new LifeOpsStore(plugin.app, plugin.settings) as unknown as StoreHost;
    expect(await hasInterruptedFactOperation(reopened)).toBe(true);
    await expect(reopened.runFactOperation!({ operationId: "synthetic:blocked-next-write" }, async scope => scope.appendCalendarNote("2026-10-05", "must not write"), async () => undefined))
      .rejects.toThrow("上次保存被中断");
    expect(await recoverFactOperation(reopened)).toBe("restored");
    expect(await facts()).toEqual(before);
    expect(JSON.parse(await vault.bytes(ledgerPath)).records.at(-1).status).toBe("failed");
    expect(JSON.parse(await vault.bytes(factRecoveryPath(reopened)))).toMatchObject({ status: "rolled_back", rollbackRequired: true });
    expect(await recoverFactOperation(reopened)).toBe("none");
  });
  it("preserves later human edits and all other facts when interrupted cancellation recovery conflicts", async () => {
    const { intent } = await interruptCancelledRollback();
    const changed = intent.entries.find((entry: any) => entry.path.endsWith(".md"));
    expect(changed).toBeDefined();
    await vault.modify(vault.getFileByPath(changed.path)!, "后来人工新增的正文，必须保全。\n");
    const beforeRecovery = await facts();
    const reopened = new LifeOpsStore(plugin.app, plugin.settings) as unknown as StoreHost;
    await expect(recoverFactOperation(reopened)).rejects.toThrow("后来发生了变化");
    expect(await facts()).toEqual(beforeRecovery);
    expect(JSON.parse(await vault.bytes(factRecoveryPath(reopened)))).toMatchObject({ status: "pending", rollbackRequired: true });
    expect(await hasInterruptedFactOperation(reopened)).toBe(true);
  });
  it.each(["capture", "generateDailyReview", "generateTradingReview"])("%s reports success if cancelled only while refresh awaits after a complete commit", async method => {
    if (method === "capture") request.mockResolvedValue(response(JSON.stringify({ kind: "todo", confidence: 0.99, title: "合成任务", content: "合成任务" })));
    if (method === "generateDailyReview") request.mockResolvedValue(response("合成复盘正文。".repeat(45)));
    const entered = deferred<void>(), release = deferred<void>(), abort = new AbortController();
    plugin.refreshViews.mockImplementation(async () => { entered.resolve(); await release.promise; });
    const pending = invoke(method, abort.signal).then(() => "saved", (error: Error) => error);
    await entered.promise;
    const atCommit = await facts();
    expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("committed");
    abort.abort(); release.resolve();
    expect(await pending).toBe("saved");
    expect(await facts()).toEqual(atCommit);
    const ledgerPath = store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
    expect(JSON.parse(await vault.bytes(ledgerPath)).records.at(-1).status).toBe("verified");
    const log = JSON.parse((await vault.bytes(store.qualityLogPath())).trim().split("\n").at(-1)!);
    expect(log.errorCode).toBeUndefined();
    expect(log.providerRuns[0].status).toBe("success");
  });
  it("keeps a verified commit if only the final WAL write fails", async () => {
    const original = vault.process.bind(vault);
    vi.spyOn(vault, "process").mockImplementation(async (file, updater) => {
      if (file.path === factRecoveryPath(store) && JSON.parse(updater(await vault.read(file))).status === "committed") throw new Error("Synthetic final WAL failure");
      return original(file, updater);
    });
    await plugin.generateTradingReview();
    const after = await facts();
    expect(JSON.stringify(after)).toContain("合成复盘正文");
    expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("pending");
    vi.restoreAllMocks();
    expect(await hasInterruptedFactOperation(store)).toBe(false);
    expect(await recoverFactOperation(store)).toBe("kept");
    expect(await facts()).toEqual(after);
  });
  it("restores facts when cancellation coincides with a failing final WAL write", async () => {
    const before = await facts(), entered = deferred<void>(), release = deferred<void>(), abort = new AbortController();
    const original = vault.process.bind(vault);
    vi.spyOn(vault, "process").mockImplementation(async (file, updater) => {
      if (file.path === factRecoveryPath(store) && JSON.parse(updater(await vault.read(file))).status === "committed") {
        entered.resolve(); await release.promise;
        throw new Error("Synthetic final WAL failure while cancelled");
      }
      return original(file, updater);
    });
    const pending = plugin.generateTradingReview(abort.signal).then(() => "saved", (error: Error) => error);
    await entered.promise; abort.abort(); release.resolve();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(await facts()).toEqual(before);
  });
});
