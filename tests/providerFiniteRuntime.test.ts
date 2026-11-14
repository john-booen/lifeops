import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl, type App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { LifeOpsAi } from "../src/ai";
import { todayString } from "../src/date";
import { setProviderEgressSink } from "../src/privacy";
import type { StoreHost } from "../src/store/settingsSlice";
import type { ProactiveCandidate } from "../src/scheduler";
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn() }));
const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class { constructor(message: string) { notices.push(message); } },
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: vi.fn(),
  parseYaml: JSON.parse, stringifyYaml: JSON.stringify
}));
const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: any;
const screenImage = Buffer.from("fictional native screen bytes").toString("base64");
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
let screenText: string;
const request = requestUrl as unknown as ReturnType<typeof vi.fn>;
function reviewText(line = "合成复盘正文。") { return JSON.stringify({good:[],issues:[],suggestions:[],checklist:[line]}); }
function response(content = reviewText(), status = 200) { return { status, text: "private body synthetic-secret", json: { model: "actual-model", choices: [{ message: { content } }], data: [{ embedding: [1, 2] }] } }; }
function screenResponse(input: { body: string }, fenced = false) {
  const prompt = JSON.parse(input.body).messages[0].content[1].text as string;
  const corpusSha256 = prompt.match(/corpusSha256必须原样返回([a-f0-9]{64})/)![1];
  const raw = JSON.stringify({ snapshotEvidenceVersion: 5, corpusSha256, sensitive: false, confidence: "high", legibility: "partial", needsHelp: false,
    slots: { slot1: { sourceId: "o1", context: "content", color: "black" }, slot2: null, slot3: null, slot4: null },
    geometry: [] });
  const value = response(fenced ? "```json\n" + raw + "\n```" : raw);
  return { ...value, json: { ...value.json, choices: value.json.choices.map(choice => ({ ...choice, finish_reason: "stop" })) } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
beforeEach(async () => {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
  screenText = "虚构资料待核对";
  const actualKill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => { if (pid === 424243) throw Object.assign(new Error("gone"), { code: "ESRCH" }); return actualKill(pid, signal); });
  vi.mocked(spawn).mockImplementation((file: any, args: any) => {
    expect(file).toBe("/usr/bin/osascript"); expect(args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    const child: any = new EventEmitter(); child.pid = 424243; child.stdout = new PassThrough(); child.stderr = new PassThrough(); let inputBytes = 0;
    child.stdin = new Writable({ write(bytes, _encoding, done) { inputBytes += bytes.length; done(); }, final(done) { done(); setImmediate(() => {
      child.stdout.end(JSON.stringify({ revision: 2, level: "accurate", languageCorrection: false, inputBytes, rows: [{ id: "o1", text: screenText, confidence: 1, box: { x: .4, y: .4, width: .2, height: .1 } }] }));
      child.stderr.end(); child.emit("close", 0, null);
    }); } });
    child.kill = vi.fn((signal: string) => { queueMicrotask(() => child.emit("close", null, signal)); return true; }); return child;
  });
  notices.length = 0;
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected transport"); }));
  root = await mkdtemp(join(tmpdir(), "lifeops-provider-finite-")); vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.privacy = { excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
  Object.assign(settings.ai, { provider: "kimi", endpoint: "https://synthetic.invalid/?private=query", model: "configured-model", apiKey: "synthetic-secret", dataDisclosureAccepted: true, fallbackProvider: "off" });
  Object.assign(settings.embedding, { provider: "openai-compatible", endpoint: "https://synthetic.invalid/embedding", model: "old-model", apiKey: "synthetic-secret", dataDisclosureAccepted: true });
  store = new LifeOpsStore(app, settings) as unknown as StoreHost; await store.initializeVault();
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), { app, store, settings, refreshViews: vi.fn(async () => {}), updateStatusBar: vi.fn(async () => {}),
    lifeOpsEvents: { publish: vi.fn() }, ai: new LifeOpsAi(settings), saveData: vi.fn(async () => {}), hardenPluginDataPermissions: vi.fn(async () => {}), proactiveLifecycle: { setEnabled: vi.fn() } });
  request.mockReset(); request.mockResolvedValue(response());
});
afterEach(async () => { setProviderEgressSink(null); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); Object.defineProperty(process, "platform", platformDescriptor); await rm(root, { recursive: true, force: true }); });
function reviewPath() { return store.path(store.settings.folders.aiReports, "交易", todayString() + ".md"); }
async function logs() {
  const raw = await vault.bytes(store.qualityLogPath());
  expect(raw).not.toMatch(/private body|private=query|synthetic-secret|https:\/\//);
  return raw.trim().split("\n").map(line => JSON.parse(line));
}
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

describe("finite provider logging and cancellation through actual temporary files", () => {
  describe("proactive response committed result and presentation", () => {
    async function seedCandidate() {
      const item: ProactiveCandidate = { id: "synthetic-weekly", kind: "weekly_review", title: "虚构周回顾", reason: "仅测试", priority: "high", workflowId: "weekly_review", dedupeKey: "synthetic-weekly:2026-10-14", createdAt: "2026-10-14T00:00:00.000Z", expiresAt: "2099-10-14T00:00:00.000Z", evidenceRefs: [], confidence: 0.8, voiceEligible: false };
      await store.appendProactiveCandidates([item]);
      await store.writeProactivePolicyState({ version: 1, deliveries: [], feedback: [], mutedKinds: [], extension: { keep: true } } as any);
      return item;
    }
    async function feedbackAudit() { return (await vault.bytes(store.proactiveFeedbackAuditPath())).trim().split("\n").map(line => JSON.parse(line)); }
    it.each(["refresh", "event"])("preserves a committed proactive draft when %s presentation fails", async stage => {
      const item = await seedCandidate();
      if (stage === "refresh") plugin.refreshViews.mockRejectedValue(new Error("synthetic refresh detail"));
      else plugin.lifeOpsEvents.publish.mockImplementation(() => { throw new Error("synthetic event detail"); });
      await expect(plugin.respondToProactiveCandidate(item.id, "accepted")).resolves.toBeUndefined();
      const policy = await store.readProactivePolicyState();
      expect(policy.feedback).toEqual([expect.objectContaining({ candidateId: item.id, decision: "accepted" })]);
      expect((policy as any).extension).toEqual({ keep: true });
      const drafts = vault.getMarkdownFiles().filter(file => file.path.includes("/Workflows/")); expect(drafts).toHaveLength(1);
      expect(await feedbackAudit()).toEqual([expect.objectContaining({ candidateId: item.id, outcome: "completed", workflowPath: drafts[0].path })]);
      expect(notices).toContain("提醒已经处理，但页面更新失败，请刷新页面。");
      expect(notices.join()).not.toMatch(/synthetic (refresh|event) detail|提醒处理未完成/);
      expect(request).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    });
    it("still rejects a real draft failure and restores acceptance before retry", async () => {
      const item = await seedCandidate(), before = await vault.bytes(store.proactivePolicyPath());
      const draft = vi.spyOn(store, "writeWorkflowDraft").mockRejectedValueOnce(new Error("synthetic draft failure"));
      await expect(plugin.respondToProactiveCandidate(item.id, "accepted")).rejects.toThrow("synthetic draft failure");
      expect(await vault.bytes(store.proactivePolicyPath())).toBe(before);
      expect(vault.getMarkdownFiles().filter(file => file.path.includes("/Workflows/"))).toHaveLength(0);
      expect(await feedbackAudit()).toEqual([expect.objectContaining({ outcome: "failed" })]);
      expect(notices.join()).not.toContain("提醒已经处理"); expect(plugin.lifeOpsEvents.publish).not.toHaveBeenCalled();
      draft.mockRestore(); await plugin.respondToProactiveCandidate(item.id, "accepted");
      expect(vault.getMarkdownFiles().filter(file => file.path.includes("/Workflows/"))).toHaveLength(1);
      expect((await feedbackAudit()).map(row => row.outcome)).toEqual(["failed", "completed"]);
      expect(request).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    });
  });
  describe("actual finite transport target", () => {
    it("persists the started model while Main rejects unsaved changed-state delivery", async () => {
      const before = await facts(), requestedModel = plugin.settings.embedding.model;
      request.mockResolvedValue({ ...response(), json: { data: [{ embedding: [1, 2] }] } });
      const pending = plugin.observeProvider("embedding", "text", (options: any, _store: StoreHost, ai: LifeOpsAi) => ai.getEmbedding("纯虚构模型切换", options)).catch((error: Error) => error);
      plugin.settings.embedding.model = "started-finite-model";
      expect(await pending).toMatchObject({ name: "AbortError" });
      expect(request).toHaveBeenCalledOnce(); expect(JSON.parse(request.mock.calls[0][0].body).model).toBe("started-finite-model");
      expect(await facts()).toEqual(before);
      expect((await logs()).at(-1)).toMatchObject({ errorCode: "cancelled", localFallbackUsed: false, providerRuns: [{ requestedModel, actualModel: "started-finite-model", status: "success", modelIdentitySource: "configured", attempts: [{ model: "started-finite-model" }] }] });
    });
    it("settings save still cancels before the prepared transport starts", async () => {
      const before = await facts(), entered = deferred<void>(), release = deferred<void>(), model = plugin.settings.embedding.model;
      setProviderEgressSink(async () => { entered.resolve(); await release.promise; });
      const pending = plugin.observeProvider("embedding", "text", (options: any, _store: StoreHost, ai: LifeOpsAi) => ai.getEmbedding("纯虚构发送前撤权", options)).catch((error: Error) => error);
      await entered.promise; plugin.settings.embedding.model = "changed-before-send"; await plugin.saveSettings();
      expect(await pending).toMatchObject({ name: "AbortError" }); release.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(request).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(await facts()).toEqual(before);
      expect((await logs()).at(-1)).toMatchObject({ errorCode: "cancelled", providerRuns: [{ requestedModel: model, status: "cancelled", attempts: [{ model }] }] });
    });
  });
  it.each(["capture", "generateDailyReview", "generateTradingReview"])("%s does not save an incomplete response or substitute a local complete draft", async method => {
    const before = await facts();
    request.mockResolvedValue({ ...response(), json: { model: "actual-model", choices: [{ finish_reason: "length", message: { content: method === "capture" ? '{"kind":"task","title":"虚构截断任务"}' : "合法但截断的复盘正文。" } }] } });
    const work = method === "capture" ? plugin.capture("虚构一般记录", "synthetic") : plugin[method]();
    await expect(work).rejects.toMatchObject({ code: "response_incomplete" }); expect(request).toHaveBeenCalledOnce(); expect(await facts()).toEqual(before);
    expect((await logs()).at(-1)).toMatchObject({ errorCode: "response_incomplete", localFallbackUsed: false, fallbackUsed: false,
      providerRuns: [{ status: "failed", actualModel: "actual-model", attempts: [{ errorCode: "response_incomplete", incompleteReason: "length", httpStatus: 200 }] }] });
  });
  it("records invalid classification with genuine rule fallback and a successful provider", async () => {
    request.mockResolvedValue(response("非 JSON 分类结果"));
    await plugin.capture("合成随手备注", "synthetic");
    const rows = await logs();
    expect(rows.at(-1)).toMatchObject({ providerStage: "classification", localFallbackUsed: true, errorCode: "invalid_response", providerRuns: [{ status: "success", actualModel: "actual-model" }] });
    expect(rows.at(-1).providerTraceId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it.each(["generateDailyReview", "generateTradingReview"])("%s logs local fallback only when it actually returns a draft", async method => {
    request.mockResolvedValue(response("", 429));
    await plugin[method]();
    expect((await logs()).at(-1)).toMatchObject({ localFallbackUsed: true, fallbackUsed: true, errorCode: "rate_limit", providerRuns: [{ status: "failed", attempts: [{ errorCode: "rate_limit" }] }] });
    expect(JSON.stringify(await facts())).toContain("本地生成的结构化草稿");
  });
  it("disabled AI reviews report unavailable with zero remote attempts", async () => {
    plugin.settings.ai.provider = "off";
    await plugin.generateTradingReview();
    expect((await logs()).at(-1)).toMatchObject({ localFallbackUsed: true, providerRuns: [{ status: "unavailable", attempts: [] }] });
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["capture", "generateDailyReview", "generateTradingReview"])("%s cancels an uncooperative provider without saving a draft", async method => {
    const before = await facts(), entered = deferred<void>(), late = deferred<any>(), abort = new AbortController();
    request.mockImplementation(() => { entered.resolve(); return late.promise; });
    const pending = (method === "capture" ? plugin.capture("合成备注", "synthetic", { signal: abort.signal }) : plugin[method](abort.signal)).catch((error: Error) => error);
    await entered.promise; abort.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });
    late.resolve(response()); await Promise.resolve();
    expect(await facts()).toEqual(before);
    expect((await logs()).at(-1)).toMatchObject({ localFallbackUsed: false, errorCode: "cancelled", providerRuns: [{ status: "cancelled" }] });
  });
  it.each(["folders", "excluded"])("%s change revokes a capture before settings persistence awaits", async change => {
    const before = await facts(), entered = deferred<void>(), late = deferred<any>();
    request.mockImplementation(() => { entered.resolve(); return late.promise; });
    const pending = plugin.capture("合成备注", "synthetic").catch((error: Error) => error);
    await entered.promise;
    if (change === "folders") plugin.settings.folders.inbox = "SyntheticNewInbox";
    else plugin.settings.privacy.excludedVaultPrefixes = [plugin.settings.folders.inbox];
    plugin.saveData.mockRejectedValueOnce(new Error("synthetic settings disk failure"));
    await expect(plugin.saveSettings()).rejects.toThrow("synthetic settings disk failure");
    expect(await pending).toMatchObject({ name: "AbortError" });
    late.resolve(response()); await Promise.resolve();
    expect(await facts()).toEqual(before);
  });
  it("does not cancel a request for an unrelated display setting save", async () => {
    const entered = deferred<void>(), late = deferred<any>();
    request.mockImplementation(() => { entered.resolve(); return late.promise; });
    const pending = plugin.generateTradingReview(); await entered.promise;
    plugin.settings.voiceAutoSend = !plugin.settings.voiceAutoSend;
    await plugin.saveSettings(); late.resolve(response()); await pending;
    expect((await logs()).at(-1)).toMatchObject({ providerRuns: [{ status: "success" }], localFallbackUsed: false });
  });
  it("rolls back a cancelled draft even when cancellation arrives during the actual file write", async () => {
    const path = reviewPath(), before = await facts(), entered = deferred<void>(), release = deferred<void>(), abort = new AbortController();
    const original = vault.create.bind(vault);
    vi.spyOn(vault, "create").mockImplementation(async (file, body) => {
      if (file === path) { entered.resolve(); await release.promise; }
      return original(file, body);
    });
    const pending = plugin.generateTradingReview(abort.signal).catch((error: Error) => error);
    await entered.promise; abort.abort(); release.resolve();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(await facts()).toEqual(before);
  });
  it("records each embedding request and uses a stable model through a rebuild", async () => {
    await vault.seed(`${plugin.settings.folders.ideas}/合成知识.md`, "合成知识正文");
    await store.rebuildVaultIndex();
    await plugin.rebuildVectorIndexIfEnabled();
    const rows = (await logs()).filter(row => row.providerStage === "embedding" && row.providerRuns?.length);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.providerRuns.length === 1 && row.providerRuns[0].status === "success")).toBe(true);
    expect(JSON.parse(await vault.bytes(store.vectorIndexPath())).model).toBe("old-model");
  });
  it("rolls back an obsolete vector write before a queued fresh same-Vault rebuild", async () => {
    await vault.seed(`${plugin.settings.folders.ideas}/合成知识.md`, "合成知识正文");
    await store.rebuildVaultIndex(); await store.rebuildVectorIndex("before-model", async () => [0, 1]);
    const vectorPath = store.vectorIndexPath(), entered = deferred<void>(), release = deferred<void>();
    const original = vault.process.bind(vault); let blocked = false;
    vi.spyOn(vault, "process").mockImplementation(async (file, updater) => {
      if (file.path === vectorPath && !blocked) { blocked = true; entered.resolve(); await release.promise; }
      return original(file, updater);
    });
    const old = plugin.rebuildVectorIndexIfEnabled().catch((error: Error) => error);
    await entered.promise;
    plugin.settings.embedding.model = "fresh-model";
    await plugin.saveSettings();
    const fresh = (plugin.store as StoreHost).rebuildVectorIndex("fresh-model", async () => [8, 9]);
    release.resolve();
    const oldOutcome = await old;
    await fresh;
    expect(oldOutcome).toMatchObject({ name: "AbortError" });
    const result = JSON.parse(await vault.bytes(vectorPath));
    expect(result.model).toBe("fresh-model");
    expect(result.entries.every((entry: any) => entry.embedding[0] === 8)).toBe(true);
  });
});

describe("provider observation remains noninterfering", () => {
  describe("late cancellation terminal audit", () => {
    it.each(["configuration", "unload", "external-abort", "saved-configuration-ABA"])("records %s after a successful real adapter result without rewriting provider success", async change => {
      const entered = deferred<void>(), release = deferred<void>(), abort = new AbortController(), append = store.appendQualityLog.bind(store), before = await facts();
      const writer = vi.spyOn(store, "appendQualityLog").mockImplementation(async row => {
        await append(row);
        if (writer.mock.calls.length === 1) { entered.resolve(); await release.promise; }
      });
      const action = vi.fn((options: any, _store: StoreHost, ai: LifeOpsAi) => ai.getEmbedding("纯虚构晚取消文本", options));
      const pending = plugin.observeProvider("embedding", "text", action, abort.signal).catch((error: Error) => error);
      await entered.promise;
      if (change === "configuration") plugin.settings.embedding.model = "changed";
      else if (change === "unload") plugin.unloaded = true;
      else if (change === "external-abort") abort.abort();
      else { const original = plugin.settings.embedding.model; plugin.settings.embedding.model = "changed"; await plugin.saveSettings(); plugin.settings.embedding.model = original; await plugin.saveSettings(); }
      release.resolve(); expect(await pending).toMatchObject({ name: "AbortError" });
      const rows = await logs(); expect(rows).toHaveLength(2); expect(rows[0].errorCode).toBeUndefined(); expect(rows[1].providerTraceId).toBe(rows[0].providerTraceId);
      expect(rows[1]).toMatchObject({ errorCode: "cancelled", fallbackUsed: false, localFallbackUsed: false,
        providerRuns: [{ status: "success", requestedProvider: "openai-compatible", requestedModel: "old-model", actualProvider: "openai-compatible", actualModel: "actual-model", attempts: [{ status: "success" }] }] });
      expect(rows[1].providerRuns).toEqual(rows[0].providerRuns); expect(action).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce();
      expect(await facts()).toEqual(before); expect(plugin.activeProviderRequests.size).toBe(0);
    });
    it("shares the original diagnostic deadline with a hanging terminal audit and consumes its late rejection", async () => {
      vi.useFakeTimers();
      const entered = deferred<void>(), second = deferred<void>(), abort = new AbortController(), append = store.appendQualityLog.bind(store);
      let rejectLate!: (error: Error) => void;
      const writer = vi.spyOn(store, "appendQualityLog").mockImplementation(async row => {
        await append(row);
        if (writer.mock.calls.length === 1) { entered.resolve(); await new Promise(resolve => setTimeout(resolve, 600)); abort.abort(); }
        else { second.resolve(); await new Promise<void>((_resolve, reject) => { rejectLate = reject; }); }
      });
      const action = vi.fn((options: any, _store: StoreHost, ai: LifeOpsAi) => ai.getEmbedding("纯虚构取消文本", options));
      const pending = plugin.observeProvider("embedding", "text", action, abort.signal).catch((error: Error) => error);
      await entered.promise; await vi.advanceTimersByTimeAsync(600); await second.promise;
      let outcome: unknown; pending.then((value: unknown) => { outcome = value; });
      await vi.advanceTimersByTimeAsync(401);
      expect(outcome).toMatchObject({ name: "AbortError" }); expect(await pending).toBe(outcome);
      expect(writer).toHaveBeenCalledTimes(2); expect(action).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce();
      expect((await logs()).at(-1)).toMatchObject({ errorCode: "cancelled", providerRuns: [{ status: "success", actualModel: "actual-model" }] });
      rejectLate(Error("late diagnostic failure")); await vi.advanceTimersByTimeAsync(0);
      expect(plugin.activeProviderRequests.size).toBe(0); expect(vi.getTimerCount()).toBe(0); expect(writer).toHaveBeenCalledTimes(2);
    });
    it("keeps a committed review successful when cancellation arrives during its audit", async () => {
      const append = store.appendQualityLog.bind(store), abort = new AbortController();
      const writer = vi.spyOn(store, "appendQualityLog").mockImplementation(async row => { await append(row); abort.abort(); });
      await plugin.generateTradingReview(abort.signal);
      const rows = await logs(); expect(rows).toHaveLength(1); expect(rows[0].errorCode).toBeUndefined();
      expect(rows[0]).toMatchObject({ localFallbackUsed: false, providerRuns: [{ status: "success", actualModel: "actual-model" }] });
      expect(await vault.bytes(reviewPath())).toContain("合成复盘正文"); expect(writer).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce();
    });
  });
  it.each(["cancelled-readonly","original-failure","committed-review"])("bounds a never-ending quality-log wait for %s without losing the real outcome",async kind=>{
    vi.useFakeTimers();const entered=deferred<void>(),never=deferred<void>(),abort=new AbortController(),original=new Error("original action failure");
    vi.spyOn(store,"appendQualityLog").mockImplementation(async()=>{entered.resolve();await never.promise;});
    const pending=(kind==="committed-review"?plugin.generateTradingReview(abort.signal):plugin.observeProvider("screen","unknown",async()=>{if(kind==="original-failure")throw original;return "old readonly result";},abort.signal)).then((value:unknown)=>({value}),(error:Error)=>({error}));
    await entered.promise;abort.abort();await vi.advanceTimersByTimeAsync(1001);
    let outcome:any;pending.then((value:any)=>outcome=value);await vi.advanceTimersByTimeAsync(0);
    // Release only after observing the deadline, so the old unbounded code cannot pass.
    const returnedBeforeRelease=outcome!==undefined;never.resolve();await pending;expect(returnedBeforeRelease).toBe(true);
    if(kind==="cancelled-readonly")expect(outcome.error).toMatchObject({name:"AbortError"});
    else if(kind==="original-failure")expect(outcome.error).toBe(original);
    else {expect(outcome.error).toBeUndefined();expect(await vault.bytes(reviewPath())).toContain("合成复盘正文");expect(request).toHaveBeenCalledTimes(1);}
    expect(plugin.activeProviderRequests.size).toBe(0);expect(vi.getTimerCount()).toBe(0);expect(store.appendQualityLog).toHaveBeenCalledTimes(1);
  });
  it("consumes a late diagnostic rejection after the wait deadline without retrying the readonly action",async()=>{
    vi.useFakeTimers();const entered=deferred<void>();let rejectLate!:(error:Error)=>void;
    vi.spyOn(store,"appendQualityLog").mockImplementation(()=>{entered.resolve();return new Promise<void>((_resolve,reject)=>rejectLate=reject);});
    const action=vi.fn(async()=>"fresh readonly result"),pending=plugin.observeProvider("screen","unknown",action);
    await entered.promise;await vi.advanceTimersByTimeAsync(1001);let result:unknown;pending.then((value:unknown)=>result=value);await vi.advanceTimersByTimeAsync(0);
    const returnedBeforeLateRejection=result!==undefined;rejectLate(Error("late diagnostic failure"));await pending;await vi.advanceTimersByTimeAsync(0);
    expect(returnedBeforeLateRejection).toBe(true);expect(result).toBe("fresh readonly result");expect(action).toHaveBeenCalledTimes(1);expect(request).not.toHaveBeenCalled();expect(plugin.activeProviderRequests.size).toBe(0);expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["configuration", "unload", "external-abort", "saved-configuration-ABA"])("rejects an uncommitted result when %s arrives during quality-log persistence",async change=>{
    const entered=deferred<void>(),release=deferred<void>(),abort=new AbortController(),append=store.appendQualityLog.bind(store);
    vi.spyOn(store,"appendQualityLog").mockImplementation(async row=>{await append(row);entered.resolve();await release.promise;});
    const action=vi.fn(async()=>"old readonly result");
    const pending=plugin.observeProvider("screen","unknown",action,abort.signal).catch((error:Error)=>error);
    await entered.promise;const retained=plugin.activeProviderRequests.size===1;
    if(change==="configuration")plugin.settings.vision.model="changed";
    else if(change==="unload")plugin.unloaded=true;
    else if(change==="external-abort")abort.abort();
    else {const original=plugin.settings.vision.model;plugin.settings.vision.model="changed";await plugin.saveSettings();plugin.settings.vision.model=original;await plugin.saveSettings();}
    release.resolve();expect(await pending).toMatchObject({name:"AbortError"});expect(retained).toBe(true);
    expect(plugin.activeProviderRequests.size).toBe(0);expect(action).toHaveBeenCalledTimes(1);expect(request).not.toHaveBeenCalled();
  });
  it("keeps the original action error when cancellation arrives during its diagnostic log wait",async()=>{
    const entered=deferred<void>(),release=deferred<void>(),abort=new AbortController(),original=new Error("original action failure"),append=store.appendQualityLog.bind(store);
    vi.spyOn(store,"appendQualityLog").mockImplementation(async row=>{await append(row);entered.resolve();await release.promise;});
    const pending=plugin.observeProvider("screen","unknown",async()=>{throw original;},abort.signal).catch((error:Error)=>error);
    await entered.promise;abort.abort();release.resolve();expect(await pending).toBe(original);expect(plugin.activeProviderRequests.size).toBe(0);
  });
  it("preserves a genuinely saved review if cancellation and logging failure arrive after the fact commit",async()=>{
    const entered=deferred<void>(),release=deferred<void>(),abort=new AbortController();
    vi.spyOn(store,"appendQualityLog").mockImplementation(async()=>{entered.resolve();await release.promise;throw Error("late log failure");});
    const pending=plugin.generateTradingReview(abort.signal).then(()=>"saved",(error:Error)=>error);
    await entered.promise;const saved=await vault.bytes(reviewPath());expect(saved).toContain("合成复盘正文");
    abort.abort();plugin.settings.ai.model="changed";release.resolve();expect(await pending).toBe("saved");
    expect(await vault.bytes(reviewPath())).toBe(saved);expect(request).toHaveBeenCalledTimes(1);expect(plugin.activeProviderRequests.size).toBe(0);
  });
  it.each(["sync", "async"])("%s logging failure preserves a successful review without retry", async kind => {
    vi.spyOn(store, "appendQualityLog").mockImplementation(() => {
      if (kind === "sync") throw new Error("synthetic log failure");
      return Promise.reject(new Error("synthetic log failure"));
    });
    await plugin.generateTradingReview();
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await facts())).toContain("合成复盘正文");
  });
  it.each(["sync", "async"])("%s logging failure preserves cancellation and zero facts", async kind => {
    const before = await facts(), entered = deferred<void>(), abort = new AbortController();
    request.mockImplementation(() => { entered.resolve(); return new Promise(() => {}); });
    vi.spyOn(store, "appendQualityLog").mockImplementation(() => {
      if (kind === "sync") throw new Error("synthetic log failure");
      return Promise.reject(new Error("synthetic log failure"));
    });
    const result = plugin.generateTradingReview(abort.signal).catch((error: Error) => error);
    await entered.promise; abort.abort();
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(await facts()).toEqual(before); expect(request).toHaveBeenCalledTimes(1);
  });
});

it("restores task JSON, task mirror and activity notes after cancellation during classified task persistence", async () => {
  const before = await facts(), entered = deferred<void>(), release = deferred<void>(), abort = new AbortController();
  request.mockResolvedValue(response(JSON.stringify({ kind: "todo", confidence: 0.99, title: "合成任务", content: "合成任务", reason: "明确请求" })));
  const original = vault.process.bind(vault); let blocked = false;
  vi.spyOn(vault, "process").mockImplementation(async (file, update) => {
    if (file.path === store.taskDbPath() && !blocked) { blocked = true; entered.resolve(); await release.promise; }
    return original(file, update);
  });
  const result = plugin.capture("创建合成任务", "synthetic", { signal: abort.signal }).catch((error: Error) => error);
  await entered.promise; abort.abort(); release.resolve();
  expect(await result).toMatchObject({ name: "AbortError" });
  expect(blocked).toBe(true); expect(await facts()).toEqual(before);
});

it("persists a successful classified task with accurate JSON, activity and provider facts", async () => {
  request.mockResolvedValue(response(JSON.stringify({ kind: "todo", confidence: 0.99, title: "合成任务", content: "合成任务", reason: "明确请求" })));
  await plugin.capture("创建合成任务", "synthetic");
  const tasks = JSON.parse(await vault.bytes(store.taskDbPath()));
  expect(tasks.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ title: "合成任务" })]));
  expect(JSON.stringify(await facts())).toContain("合成任务");
  expect((await logs()).at(-1)).toMatchObject({ providerStage: "classification", localFallbackUsed: false, providerRuns: [{ status: "success" }] });
});

it("keeps successful provider text beginning with AI 未启用 instead of substituting a local draft", async () => {
  request.mockResolvedValue(response(reviewText("AI 未启用是昨天记录中的原话；今天的合成复盘如下。")));
  await plugin.generateTradingReview();
  const after = await vault.bytes(reviewPath());
  expect(after).toContain("AI 未启用是昨天记录中的原话");
  expect(after).not.toContain("本地生成的结构化草稿");
  expect((await logs()).at(-1).localFallbackUsed).toBe(false);
});

it("keeps a slow idea plan long enough to return its confirmation card", async () => {
  const { listIdeas } = await import("../src/features/ideas/notes");
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-11-12T20:00:00+08:00"));
  const path = store.path(store.settings.folders.ideas, "虚构创意.md");
  await vault.seed(path, "---\n" + JSON.stringify({
    lifeops: "idea", status: "exploring", created: "2026-10-20", lastProgress: "2026-10-28",
    nextAction: "", nextReview: "2026-11-13", sources: []
  }) + "\n---\n\n纯虚构创意正文。\n");
  const [idea] = await listIdeas(store);
  const entered = deferred<void>();
  const plan = deferred<ReturnType<typeof response>>();
  request.mockImplementationOnce(() => { entered.resolve(); return plan.promise; });
  const result = plugin.createAgentRuntime().executeAiToolCall(
    { name: "advance_idea", arguments: { id: idea.ideaId } }, "kimi", "把虚构创意拆成本周任务"
  );
  await entered.promise;
  await vi.advanceTimersByTimeAsync(35_000);
  plan.resolve(response(JSON.stringify({ summary: "虚构创意在准备样例。", steps: [{ title: "整理虚构样例", minutes: 30 }] })));
  const draft = await result;
  expect(draft.success, draft.output).toBe(true);
  expect(draft.actions).toMatchObject([{ type: "idea_advance", title: "推进「虚构创意」" }]);
  expect((await store.readTaskDb()).tasks).toEqual([]);
});

it("links a recorded trade violation to its exact model version and rule", async () => {
  const { formatRecordedTradeDiscipline } = await import("../src/features/trading/reviewData");
  const evidence = [{ date: "2026-11-12", label: "FICT-A 多单", modelId: "model", versionId: "v1", ruleViolations: ["stop"] }];
  const rules = [
    { modelId: "model", versionId: "v2", modelName: "虚构新版", ruleId: "stop", text: "虚构新版规则" },
    { modelId: "model", versionId: "v1", modelName: "虚构第一版", ruleId: "stop", text: "触及预设止损价立即退出。" }
  ];
  const reply = formatRecordedTradeDiscipline(JSON.stringify({ evidence, rules, filtered: false }));
  expect(reply).toBe("2026-11-12 的 FICT-A 多单有一条已记录的违规。对应的是「虚构第一版」中的「触及预设止损价立即退出」。下次在 LifeOps 的交易备注记下这条规则是否触发和当时的处理，再用该笔回执核对。");
  expect(formatRecordedTradeDiscipline(JSON.stringify({ evidence, rules: rules.slice(0, 1) }))).toBeUndefined();
});

it("uses the same trade numbers for a spoken review, saves a separate report and creates a task only when clicked", async () => {
  const { recordTradeDrafts, readTradeDatabase } = await import("../src/features/trading/persistence");
  const { addTradeReviewTask } = await import("../src/features/trading/reviewUi");
  const originalPath = store.tradingReviewPath(todayString()), original = "# 虚构手写交易复盘\n原内容不动。\n";
  await vault.seed(originalPath, original);
  const date = todayString(), openedAt = `${date}T09:00:00+08:00`, closedAt = `${date}T10:00:00+08:00`;
  await plugin.saveLocalOperation("fictional_trade", {}, (scope: StoreHost) => recordTradeDrafts(scope, [{
    openedAt, closedAt, market: "A股", direction: "long", symbol: "FICTIONAL", pnl: -20, source: { kind: "form" }
  }]));
  const trade = (await readTradeDatabase(store)).trades[0];
  const task = { kind: "task" as const, title: "核对虚构交易的止损流程" };
  const runtime = plugin.createAgentRuntime();
  const before = await facts();
  const spoken = await runtime.executeAiToolCall({ name: "inspect_trade_review", arguments: { period: "day" } }, "kimi");
  expect(spoken.success, spoken.output).toBe(true);
  expect(JSON.parse(spoken.output)).toMatchObject({ stats: { count: 1, byCurrency: { CNY: { totalPnl: -20 } } }, largestLossIds: [trade.id] });
  const rulesOnly = await runtime.executeAiToolCall({ name: "inspect_trade_review", arguments: { period: "day", focus: "rules" } }, "kimi");
  expect(rulesOnly.success, rulesOnly.output).toBe(true);
  const ruleEvidence = JSON.parse(rulesOnly.output);
  expect(ruleEvidence).toMatchObject({ evidence: [], violationCount: 0 });
  expect(ruleEvidence).not.toHaveProperty("stats");
  expect(await facts()).toEqual(before);
  request.mockResolvedValue(response(JSON.stringify({ good: [], issues: [{ text: "核对这笔亏损的执行经过", tradeIds: [trade.id] },
    { text: "虚构不存在的引用", tradeIds: ["missing-id"] }], suggestions: [task], checklist: ["复查已记录的止损依据。"] })));
  await plugin.generateTradingReview();
  const path = reviewPath(), report = await vault.bytes(path);
  expect(report).toContain("交易 1 笔"); expect(report).toContain("总盈亏 -20");
  expect(report).toContain(trade.id); expect(report).not.toContain("虚构不存在的引用");
  expect(report).toContain("lifeops-trade-review-action");
  expect(await vault.bytes(originalPath)).toBe(original);
  expect((await store.readTaskDb()).tasks).toEqual([]);
  await plugin.generateTradingReview();
  expect((await vault.bytes(path)).startsWith(report)).toBe(true);
  expect(await addTradeReviewTask(plugin, store, path, task)).toBe(true);
  expect(await addTradeReviewTask(plugin, store, path, task)).toBe(false);
  expect((await store.readTaskDb()).tasks).toMatchObject([{ title: task.title, sourceNotePath: path }]);
  await runtime.undoLatestOperation();
  expect((await store.readTaskDb()).tasks).toEqual([]);
});

it("takes a report's rule suggestion through a fresh confirmation and retains the previous rule", async () => {
  const { prepareTradingAction } = await import("../src/tradingTools");
  const { runConfirmedToolAction } = await import("../src/toolRegistry");
  const { recordTradeDrafts } = await import("../src/features/trading/persistence");
  const { prepareTradeReviewRuleChange } = await import("../src/features/trading/reviewUi");
  const originalPath = `${store.settings.folders.tradingModels}/虚构规则.md`, quote = "进场先核对风险。";
  await vault.seed(originalPath, quote);
  const context = { store, refreshViews: async () => undefined };
  const oldRule = { id: "rule-fiction", text: quote, kind: "risk", checkable: true, sourcePath: originalPath, quote };
  const initial = await prepareTradingAction({ kind: "save_model", input: { title: "虚构模型", rules: [oldRule] } }, context, "seed-rule");
  await runConfirmedToolAction(initial, context);
  const version = (await store.getTradingSnapshot()).document.models[0].versions[0];
  await plugin.saveLocalOperation("fictional_loss", {}, (scope: StoreHost) => recordTradeDrafts(scope, [{
    openedAt: `${todayString()}T09:00:00+08:00`, market: "A股", direction: "long", symbol: "FICTIONAL", pnl: -100,
    modelId: version.modelId, modelVersionId: version.id, ruleViolations: [oldRule.id], ruleCheckStatus: "checked", source: { kind: "form" }
  }]));
  const action = { kind: "rule" as const, title: "把风险核对写清", modelId: version.modelId, versionId: version.id,
    ruleId: oldRule.id, revisedText: "进场前书面记下风险预算。" };
  request.mockResolvedValue(response(JSON.stringify({ good: [], issues: [], suggestions: [action], checklist: [] })));
  await plugin.generateTradingReview();
  expect(await vault.bytes(reviewPath())).toContain(oldRule.id);
  const preview = await prepareTradeReviewRuleChange(store, reviewPath(), action, () => undefined);
  expect(preview.content).toContain(action.revisedText);
  expect((await store.getTradingSnapshot()).document.models[0].versions).toHaveLength(1);
  await runConfirmedToolAction(preview, context);
  expect((await store.getTradingSnapshot()).document.models[0].versions).toMatchObject([
    { rules: [oldRule] }, { rules: [{ ...oldRule, text: action.revisedText, reviewPath: reviewPath() }] }
  ]);
  expect(await vault.bytes(originalPath)).toBe(quote);
  await expect(prepareTradeReviewRuleChange(store, reviewPath(), action, () => undefined)).rejects.toThrow("版本已变化");
});

it.each([401, 403, 429, 500])("transcription production entry retains rejected HTTP %s without reading its body or writing facts", async status => {
  Object.assign(plugin.settings.voice, { provider: "openai-compatible", endpoint: "https://synthetic.invalid/asr", model: "configured-asr", dataDisclosureAccepted: true });
  const before = await facts();
  const ledgerPath = join(root, store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json"));
  const readLedger = async () => readFile(ledgerPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  const ledgerBefore = await readLedger();
  vi.useFakeTimers();
  const entered = deferred<void>(), body = deferred<unknown>();
  const json = vi.fn(() => body.promise);
  const fetch = vi.fn(async () => { entered.resolve(); return { ok: false, status, json }; });
  vi.stubGlobal("fetch", fetch);
  const pending = plugin.transcribeAgentAudio(new Blob(["合成音频"])).catch((error: Error) => error);
  await entered.promise;
  await vi.advanceTimersByTimeAsync(0);
  // Let the original broken body wait reach its deadline without timing out
  // diagnostic disk I/O in the corrected immediate HTTP-failure path.
  if (json.mock.calls.length) await vi.advanceTimersByTimeAsync(45_001);
  const code = status === 429 ? "rate_limit" : status === 500 ? "http" : "auth";
  expect(await pending).toMatchObject({ code });
  expect(json).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
  expect(await facts()).toEqual(before);
  expect(await readLedger()).toBe(ledgerBefore);
  const rows = await logs();
  expect(rows).toEqual([expect.objectContaining({ inputSource: "voice", providerStage: "transcription", errorCode: code, fallbackUsed: false, localFallbackUsed: false,
    providerRuns: [expect.objectContaining({ status: "failed", attempts: [expect.objectContaining({ errorCode: code, httpStatus: status })] })] })]);
  expect(rows[0].providerTraceId).toMatch(/^[0-9a-f-]{36}$/);
  expect(rows[0].providerRuns[0].actualProvider).toBeUndefined(); expect(rows[0].providerRuns[0].actualModel).toBeUndefined();
  expect(plugin.activeVoiceRequests.size).toBe(0); expect(plugin.activeProviderRequests.size).toBe(0);
  const terminal = JSON.stringify(rows);
  body.resolve({ text: "合成迟到转写", model: "late-model" }); await vi.advanceTimersByTimeAsync(0);
  expect(JSON.stringify(await logs())).toBe(terminal);
});
