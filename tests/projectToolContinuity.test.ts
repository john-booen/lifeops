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
const { captureProjectToolSnapshot, assertProjectToolSnapshotCurrent, advanceProjectToolSnapshot, advanceProjectTaskCompletionSnapshot, ProjectToolContinuityError } = await import("../src/projectToolContinuity");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
let source: string, memorySource: string, extraSource: string;
const call = (id = "synthetic-continuity-first", title = "纯虚构新任务甲"): AiToolCall => ({ id, name: "create_task", arguments: { title } });
const execute = (request: AiToolCall = call()) => runtime.executeAiToolCall(request, "kimi", "创建任务：纯虚构两项安排");
const ledgerPath = () => new OperationLedger(store).filePath;
const recoveryPath = () => store.path(store.settings.folders.aiReports, "Operations", "write-recovery.json");
const projectPath = () => store.path(store.settings.folders.goals, projectFileName());
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
async function mutateTasks(change: (document: any) => void) {
  const document = JSON.parse(await vault.bytes(store.taskDbPath())); change(document);
  const mirror = renderTaskMirror(document.tasks, await vault.bytes(store.taskMirrorPath()));
  document.taskMirror = { version: 1, sha256: digest(mirror) };
  await vault.seed(store.taskDbPath(), `${JSON.stringify(document, null, 2)}\n`);
  await vault.seed(store.taskMirrorPath(), mirror);
}
async function patchJson(path: string, change: (document: any) => void) {
  const document = JSON.parse(await vault.bytes(path)); change(document); await vault.seed(path, `${JSON.stringify(document, null, 2)}\n`);
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-project-tool-continuity-")); vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault(); runtime = new AgentRuntime({ store, refreshViews: vi.fn(async () => {}) });
  source = store.path(store.settings.folders.goals, "纯虚构项目原文.md");
  memorySource = store.path(store.settings.folders.ideas, "纯虚构记忆来源.md");
  extraSource = store.path(store.settings.folders.ideas, "纯虚构本轮检索.md");
  await vault.seed(source, "纯虚构项目原文第一版"); await vault.seed(memorySource, "纯虚构记忆依据"); await vault.seed(extraSource, "纯虚构检索资料");
  const snapshot = await store.getProjectSnapshot();
  const command = { kind: "save_goal" as const, input: { title: "纯虚构目标", reason: "纯虚构理由", successCriteria: "纯虚构标准",
    timeBoundary: "", constraints: "", nextStep: "", reviewOn: "", sourcePath: source, state: "agreed" as const, stateNote: "" } };
  const seeded = await runtime.executeLocalOperation("synthetic_seed_goal", { command }, scope => scope.applyProjectCommand(command, snapshot.revision, "local:synthetic-seed-goal"), "local:synthetic-seed-goal");
  expect(seeded.success).toBe(true);
  const memory = createPersonalMemory({ kind: "user_rule", truth: "explicit_fact", content: "纯虚构记忆",
    sourceRefs: [{ sourceId: "synthetic-source", path: memorySource, capturedAt: "2026-10-05T00:00:00Z" }] }, "2026-10-05T00:00:00Z");
  const records = reviewPersonalMemoryRecord([memory], memory.id, { decision: "confirm" }, "2026-10-05T00:00:00Z");
  await vault.seed(store.personalMemoryPath(), `${JSON.stringify({ version: 1, records }, null, 2)}\n`);
  expect((await execute(call("synthetic-existing-task", "纯虚构原任务"))).success).toBe(true);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("committed completion continues the project baseline", () => {
  async function complete() {
    const target = (await store.readTaskDb({ readOnly: true })).tasks.find(item => item.title === "纯虚构原任务")!;
    const request: AiToolCall = { id: "synthetic-completion-continuity", name: "complete_task", arguments: { taskIdOrTitle: target.id } };
    const before = await captureProjectToolSnapshot(store, [store.taskMirrorPath(), extraSource]);
    const result = await runtime.executeAiToolCall(request, "kimi", "请把任务纯虚构原任务标记为已完成");
    expect(result.success).toBe(true);
    return { target, request, before, result };
  }
  it("admits the exact task completion, dated activity, mirror and original project source", async () => {
    const projectBefore = await vault.bytes(projectPath()), sourceBefore = await vault.bytes(source);
    const { target, request, before, result } = await complete();
    const next = await advanceProjectTaskCompletionSnapshot(store, before, request, result);
    await assertProjectToolSnapshotCurrent(store, next);
    expect((await store.readTaskDb({ readOnly: true })).tasks.find(item => item.id === target.id)?.status).toBe("completed");
    expect(await vault.bytes(projectPath())).toBe(projectBefore); expect(await vault.bytes(source)).toBe(sourceBefore);
    await runtime.undoOperation(result.callId);
    expect((await store.readTaskDb({ readOnly: true })).tasks.find(item => item.id === target.id)?.status).toBe("active");
    await expect(advanceProjectTaskCompletionSnapshot(store, before, request, result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
  });
  it.each(["task", "mirror", "project", "memory", "source"])("refuses a later external %s change and retains it", async kind => {
    const { request, before, result } = await complete();
    const path = kind === "task" ? store.taskDbPath() : kind === "mirror" ? store.taskMirrorPath() : kind === "project" ? projectPath() : kind === "memory" ? store.personalMemoryPath() : extraSource;
    const later = (await vault.bytes(path)) + "\n纯虚构后来修改\n"; await vault.seed(path, later);
    await expect(advanceProjectTaskCompletionSnapshot(store, before, request, result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
    expect(await vault.bytes(path)).toBe(later);
  });
  it("refuses a copied receipt, different arguments and changed ledger proof", async () => {
    const { request, before, result } = await complete();
    await expect(advanceProjectTaskCompletionSnapshot(store, before, request, structuredClone(result))).rejects.toBeInstanceOf(ProjectToolContinuityError);
    await expect(advanceProjectTaskCompletionSnapshot(store, before, { ...request, arguments: { taskIdOrTitle: "另一任务" } }, result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
    await patchJson(ledgerPath(), doc => { doc.records.find((item: any) => item.operationId === result.callId).status = "reverted"; });
    await expect(advanceProjectTaskCompletionSnapshot(store, before, request, result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
  });
  it.each(["rollback", "wrong-operation", "wrong-files", "rolled_back", "false-derived"])("refuses completion WAL %s", async state => {
    const { request, before, result } = await complete();
    await patchJson(recoveryPath(), doc => {
      if (state === "rollback") { doc.status = "pending"; doc.rollbackRequired = true; }
      if (state === "wrong-operation") doc.operationId = "synthetic-other-operation";
      if (state === "wrong-files") doc.entries = [];
      if (state === "rolled_back") doc.status = "rolled_back";
      if (state === "false-derived") doc.purpose = "derived";
    });
    const changed = await vault.bytes(recoveryPath());
    await expect(advanceProjectTaskCompletionSnapshot(store, before, request, result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
    expect(await vault.bytes(recoveryPath())).toBe(changed);
  });
  it("accepts a subsequently committed native-style derived index transaction without granting it fact authority", async () => {
    const { request, before, result } = await complete();
    await store.syncVaultSources();
    const recovery = JSON.parse(await vault.bytes(recoveryPath())); expect(recovery.purpose).toBe("derived"); expect(recovery.status).toBe("committed");
    const next = await advanceProjectTaskCompletionSnapshot(store, before, request, result);
    await assertProjectToolSnapshotCurrent(store, next);
  });
  it("refuses a derived index changed during the final source reread and retains the outside bytes", async () => {
    const { request, before, result } = await complete();
    await store.syncVaultSources();
    const recovery = JSON.parse(await vault.bytes(recoveryPath()));
    expect(recovery.purpose).toBe("derived");
    const entry = recovery.entries[0]; expect(entry).toBeDefined();
    const outside = (await vault.bytes(entry.path)) + "\n纯虚构外部索引改动\n";
    const readPath = store.readPath;
    let derivedRead = false, changed = false;
    vi.spyOn(store, "readPath").mockImplementation(async function (this: StoreHost, path: string) {
      if (path === entry.path) derivedRead = true;
      if (path === extraSource && derivedRead && !changed) {
        changed = true; await vault.seed(entry.path, outside);
      }
      return readPath.call(this, path);
    });
    await expect(advanceProjectTaskCompletionSnapshot(store, before, request, result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
    expect(changed).toBe(true); expect(await vault.bytes(entry.path)).toBe(outside);
  });
});

describe("proof of this turn's committed create_task", () => {
  it("advances exact own Task mirror sources twice, then refuses an external mirror edit", async () => {
    const firstCall = call(), secondCall = call("synthetic-mirror-second", "纯虚构镜像新任务乙");
    const before = await captureProjectToolSnapshot(store, [store.taskMirrorPath()]);
    const first = await execute(firstCall), next = await advanceProjectToolSnapshot(store, before, firstCall, first);
    const second = await execute(secondCall), final = await advanceProjectToolSnapshot(store, next, secondCall, second);
    await assertProjectToolSnapshotCurrent(store, final);
    await vault.seed(store.taskMirrorPath(), (await vault.bytes(store.taskMirrorPath())) + "\n纯虚构外部手写必须保留\n");
    await expect(advanceProjectToolSnapshot(store, next, secondCall, second)).rejects.toBeInstanceOf(ProjectToolContinuityError);
    expect(await vault.bytes(store.taskMirrorPath())).toContain("纯虚构外部手写必须保留");
  });
  it("chains two exact committed writes without completing tasks or changing project facts", async () => {
    const before = await captureProjectToolSnapshot(store), firstCall = call(), secondCall = call("synthetic-continuity-second", "纯虚构新任务乙");
    const projectBefore = await vault.bytes(projectPath()), first = await execute(firstCall);
    const evidence = getCommittedTaskEvidence(first, store)!;
    expect(evidence.operationId).toBe(firstCall.id); expect(evidence.files.map(file => file.path).sort()).toEqual([store.taskDbPath(), store.taskMirrorPath()].sort());
    expect(JSON.stringify(first)).not.toContain("CommittedTaskEvidence");
    for (const file of evidence.files) { expect(file.beforeHash).toBe(digest(file.before!)); expect(file.afterHash).toBe(digest(file.after!)); }
    await expect(assertProjectToolSnapshotCurrent(store, before)).rejects.toBeInstanceOf(ProjectToolContinuityError);
    const afterFirst = await advanceProjectToolSnapshot(store, before, firstCall, first);
    await assertProjectToolSnapshotCurrent(store, afterFirst);
    const second = await execute(secondCall), afterSecond = await advanceProjectToolSnapshot(store, afterFirst, secondCall, second);
    await assertProjectToolSnapshotCurrent(store, afterSecond);
    expect((await store.readTaskDb()).tasks.map(task => task.status)).toEqual(["active", "active", "active"]);
    expect(await vault.bytes(projectPath())).toBe(projectBefore);
    expect((await store.readTaskDb()).tasks.filter(task => task.source === `lifeops-agent-tool:${secondCall.id}`)).toHaveLength(1);
  });

  it("keeps unknown task/database fields and handwritten mirror text", async () => {
    await mutateTasks(db => { db.syntheticExtension = { preserved: [1, 2] }; db.tasks[0].syntheticExtension = "保留"; });
    const mirror = `${await vault.bytes(store.taskMirrorPath())}\n## 纯虚构手写区\n保留每一个字\n`;
    await vault.seed(store.taskMirrorPath(), mirror); await patchJson(store.taskDbPath(), db => { db.taskMirror.sha256 = digest(mirror); });
    const before = await captureProjectToolSnapshot(store), result = await execute();
    await advanceProjectToolSnapshot(store, before, call(), result);
    const db = JSON.parse(await vault.bytes(store.taskDbPath()));
    expect(db.syntheticExtension).toEqual({ preserved: [1, 2] }); expect(db.tasks[0].syntheticExtension).toBe("保留");
    expect(await vault.bytes(store.taskMirrorPath())).toContain("保留每一个字");
  });

  const externalChanges: Array<[string, () => Promise<unknown>]> = [
    ["goal/project bytes", () => patchJson(projectPath(), db => { db.goals[0].title = "纯虚构外部更正"; })],
    ["old task", () => mutateTasks(db => { db.tasks[0].title = "纯虚构外部原任务更正"; })],
    ["external new task", () => mutateTasks(db => { db.tasks.push({ ...db.tasks[0], id: "synthetic-external-task", source: "synthetic-external", title: "纯虚构外部新增" }); })],
    ["external task removal", () => mutateTasks(db => { db.tasks = []; })],
    ["goal source", () => vault.seed(source, "纯虚构来源第二版")],
    ["memory source", () => vault.seed(memorySource, "纯虚构记忆依据第二版")],
    ["extra context source", () => vault.seed(extraSource, "纯虚构检索第二版")],
    ["privacy", async () => { store.settings.privacy!.excludedVaultPrefixes.push(source); }],
    ["memory contents", () => patchJson(store.personalMemoryPath(), db => { db.records[0].content = "纯虚构记忆更正"; })],
    ["folders", async () => { store.settings.folders.ideas = "纯虚构新资料目录"; }]
  ];
  it.each(externalChanges)("rejects %s changed while the first task waits; keeps its actual saved receipt", async (_name, change) => {
    const before = await captureProjectToolSnapshot(store, [extraSource]), started = deferred(), release = deferred();
    const tool = getLifeOpsTool("create_task")!, original = tool.execute!;
    vi.spyOn(tool, "execute").mockImplementation(async (...args) => { started.resolve(); await release.promise; return original(...args); });
    const pending = execute(); await started.promise; await change(); release.resolve();
    const result = await pending; expect(result.success).toBe(true);
    await expect(advanceProjectToolSnapshot(store, before, call(), result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
    expect((await store.readTaskDb()).tasks.some(task => task.source === `lifeops-agent-tool:${call().id}`)).toBe(true);
  });

  it("rejects a source changing again after it already differed from saved bytes", async () => {
    await vault.seed(source, "纯虚构来源已变化"); const before = await captureProjectToolSnapshot(store), result = await execute();
    await vault.seed(source, "纯虚构来源再变化");
    await expect(advanceProjectToolSnapshot(store, before, call(), result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
  });

  it("rejects edits to the newly created task after commit", async () => {
    const before = await captureProjectToolSnapshot(store), result = await execute();
    await mutateTasks(db => { db.tasks.at(-1).title = "纯虚构外部新任务更正"; });
    await expect(advanceProjectToolSnapshot(store, before, call(), result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
  });

  it("does not advance from cache, copied result, success text, failed status, pending card, wrong ID or edited arguments", async () => {
    const before = await captureProjectToolSnapshot(store), result = await execute(), cached = await execute();
    expect(cached.success).toBe(true); expect(getCommittedTaskEvidence(cached, store)).toBeUndefined();
    const rejected = [cached, { ...result }, { callId: call().id!, success: true, output: "已保存", actions: [] },
      Object.assign(result, { success: false })];
    for (const candidate of rejected) await expect(advanceProjectToolSnapshot(store, before, call(), candidate)).rejects.toBeInstanceOf(ProjectToolContinuityError);
    result.success = true; result.actions = [{ id: "synthetic-pending", type: "create_task", title: "纯虚构待确认", content: "", description: "", date: "2026-10-05" }];
    await expect(advanceProjectToolSnapshot(store, before, call(), result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
    result.actions = [];
    await expect(advanceProjectToolSnapshot(store, before, call("synthetic-other-id"), result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
    await expect(advanceProjectToolSnapshot(store, before, call(undefined, "纯虚构改动参数"), result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
  });

  it("freezes current task parameters before awaiting the claim", async () => {
    const before = await captureProjectToolSnapshot(store), request = call(), started = deferred(), release = deferred();
    const original = OperationLedger.prototype.claim;
    vi.spyOn(OperationLedger.prototype, "claim").mockImplementation(async function (this: InstanceType<typeof OperationLedger>, input) {
      const outcome = await original.call(this, input); started.resolve(); await release.promise; return outcome;
    });
    const frozen = structuredClone(request), pending = execute(request); await started.promise;
    request.arguments.title = "纯虚构后来改动"; release.resolve(); const result = await pending;
    expect(result.success).toBe(true); expect((await store.readTaskDb()).tasks.at(-1)!.title).toBe(frozen.arguments.title);
    await advanceProjectToolSnapshot(store, before, frozen, result);
  });

  it("requires the actual FactOperation completion callback", async () => {
    const before = await captureProjectToolSnapshot(store), original = store.runFactOperation!;
    vi.spyOn(store, "runFactOperation").mockImplementation((identity, execute, finalize, options) => original.call(store, identity, execute, finalize, { ...options, onCommitted: undefined }));
    const result = await execute(); expect(result.success).toBe(true); expect(getCommittedTaskEvidence(result, store)).toBeUndefined();
    await expect(advanceProjectToolSnapshot(store, before, call(), result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
  });

  it("does not mint a receipt when a real guarded cancellation rolls back the task pair", async () => {
    const before = await captureProjectToolSnapshot(store), jsonBefore = await vault.bytes(store.taskDbPath()), mirrorBefore = await vault.bytes(store.taskMirrorPath());
    const originalFact = store.runFactOperation!, tool = getLifeOpsTool("create_task")!, originalTool = tool.execute!;
    let cancelled = false;
    vi.spyOn(tool, "execute").mockImplementation(async (...args) => { const result = await originalTool(...args); cancelled = true; return result; });
    vi.spyOn(store, "runFactOperation").mockImplementation((identity, execute, finalize, options) => originalFact.call(store, identity, execute, finalize,
      { ...options, assertCurrent: () => { if (cancelled) throw new Error("Synthetic cancellation"); } }));
    const result = await execute(); expect(result.success).toBe(false); expect(getCommittedTaskEvidence(result, store)).toBeUndefined();
    expect(await vault.bytes(store.taskDbPath())).toBe(jsonBefore); expect(await vault.bytes(store.taskMirrorPath())).toBe(mirrorBefore);
    expect(JSON.parse(await vault.bytes(recoveryPath())).status).toBe("rolled_back");
    await expect(advanceProjectToolSnapshot(store, before, call(), result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
  });

  it.each(["unrelated file", "old task", "database extension"])("rejects a compound tool effect changing %s", async effect => {
    const before = await captureProjectToolSnapshot(store), tool = getLifeOpsTool("create_task")!, original = tool.execute!;
    vi.spyOn(tool, "execute").mockImplementation(async (...args) => {
      const result = await original(...args), scoped = args[1].store;
      if (effect === "unrelated file") await scoped.writeFile(scoped.path(scoped.settings.folders.inbox, "纯虚构额外写入.md"), "纯虚构非任务改动");
      else {
        const db = await scoped.readTaskDb();
        if (effect === "old task") db.tasks[0].title = "纯虚构同事务旧任务改动";
        else db.syntheticExtension = "纯虚构同事务扩展改动";
        await scoped.writeTaskDb(db);
      }
      return result;
    });
    const result = await execute(); expect(result.success).toBe(true);
    await expect(advanceProjectToolSnapshot(store, before, call(), result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
  });

  it("keeps an already saved result truthful when its evidence read fails", async () => {
    const before = await captureProjectToolSnapshot(store), originalFact = store.runFactOperation!, readJson = store.readJson;
    let committed = false;
    vi.spyOn(store, "runFactOperation").mockImplementation((identity, execute, finalize, options) => originalFact.call(store, identity, execute, finalize,
      { ...options, onCommitted: () => { options?.onCommitted?.(); committed = true; } }));
    vi.spyOn(store, "readJson").mockImplementation((path, fallback) => {
      if (path === ledgerPath() && committed) throw new Error("Synthetic audit unavailable");
      return readJson.call(store, path, fallback);
    });
    const result = await execute(); expect(result.success).toBe(true); expect(getCommittedTaskEvidence(result, store)).toBeUndefined();
    await expect(advanceProjectToolSnapshot(store, before, call(), result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
    expect((await store.readTaskDb()).tasks.at(-1)!.source).toBe(`lifeops-agent-tool:${call().id}`);
  });

  it("binds the completion evidence to the original Store instance", async () => {
    const before = await captureProjectToolSnapshot(store), result = await execute();
    const anotherStore = new LifeOpsStore(store.app, store.settings) as unknown as StoreHost;
    const anotherBaseline = await captureProjectToolSnapshot(anotherStore);
    expect(getCommittedTaskEvidence(result, anotherStore)).toBeUndefined();
    await expect(advanceProjectToolSnapshot(anotherStore, anotherBaseline, call(), result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
    await advanceProjectToolSnapshot(store, before, call(), result);
  });

  it.each(["failed", "reverted", "executing"])("rejects current audit status %s despite a past successful return", async status => {
    const before = await captureProjectToolSnapshot(store), result = await execute();
    await patchJson(ledgerPath(), db => { db.records.find((item: any) => item.operationId === call().id).status = status; });
    await expect(advanceProjectToolSnapshot(store, before, call(), result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
  });

  it.each(["rollback", "wrong-operation", "wrong-files", "rolled_back"])("rejects WAL %s", async state => {
    const before = await captureProjectToolSnapshot(store), result = await execute();
    await patchJson(recoveryPath(), db => {
      if (state === "rollback") { db.status = "pending"; db.rollbackRequired = true; }
      if (state === "wrong-operation") db.operationId = "synthetic-other-operation";
      if (state === "wrong-files") db.entries = [];
      if (state === "rolled_back") db.status = "rolled_back";
    });
    await expect(advanceProjectToolSnapshot(store, before, call(), result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
  });

  it("accepts the existing completed-audit recovery path only after onCommitted", async () => {
    const before = await captureProjectToolSnapshot(store), process = vault.process.bind(vault); let once = false;
    vi.spyOn(vault, "process").mockImplementation(async (file, updater) => {
      if (file.path === recoveryPath() && !once && JSON.parse(updater(await vault.read(file))).status === "committed") {
        once = true; throw new Error("Synthetic final WAL update failure");
      }
      return process(file, updater);
    });
    const result = await execute(); expect(result.success).toBe(true); expect(getCommittedTaskEvidence(result, store)).toBeDefined();
    expect(JSON.parse(await vault.bytes(recoveryPath())).status).toBe("pending");
    await advanceProjectToolSnapshot(store, before, call(), result);
  });

  it("rejects clipped audit evidence and cannot mint from an existing operation source", async () => {
    const before = await captureProjectToolSnapshot(store), result = await execute();
    const ledger = new OperationLedger(store);
    for (let i = 0; i < 501; i++) await ledger.claim({ operationId: `synthetic-continuity-audit-fill-${i}`, toolName: "synthetic_read_only", source: "system", arguments: { i } });
    await expect(advanceProjectToolSnapshot(store, before, call(), result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
    const replay = await execute(); expect(replay.success).toBe(true); expect(getCommittedTaskEvidence(replay, store)).toBeUndefined();
    await expect(advanceProjectToolSnapshot(store, before, call(), replay)).rejects.toBeInstanceOf(ProjectToolContinuityError);
  });

  it("fails closed on read errors and a copied baseline; ordinary non-project queries remain unaffected", async () => {
    const before = await captureProjectToolSnapshot(store), result = await execute();
    await expect(advanceProjectToolSnapshot(store, { ...before }, call(), result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
    vault.readFailure = new Error("Synthetic unavailable disk");
    await expect(captureProjectToolSnapshot(store)).rejects.toBeInstanceOf(ProjectToolContinuityError);
    await expect(advanceProjectToolSnapshot(store, before, call(), result)).rejects.toBeInstanceOf(ProjectToolContinuityError);
    vault.readFailure = undefined;
    const query = await runtime.executeAiToolCall({ id: "synthetic-ordinary-query", name: "query_vault", arguments: { domain: "note", operation: "list" } }, "kimi");
    expect(query.success).toBe(true); expect(getCommittedTaskEvidence(query, store)).toBeUndefined();
  });
});
