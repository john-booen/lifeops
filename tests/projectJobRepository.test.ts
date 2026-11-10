import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { StoreHost } from "../src/store/settingsSlice";
import type { ProjectJob, ProjectJobEffect } from "../src/projectJobRepository";
import { DEFAULT_SETTINGS } from "../src/defaults";
vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(),
  requestUrl: vi.fn(() => { throw new Error("Network forbidden"); })
}));
const { ProjectJobRepository, ProjectJobRepositoryError, projectJobPath, projectJobPlanHash, projectJobStepOperationId, validateProjectJobDocument } = await import("../src/projectJobRepository");
const { OperationLedger, operationFingerprint } = await import("../src/dataFoundation/operationLedger");
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let roots: string[], vault: InstanceType<typeof DiskVault>, store: StoreHost, repo: InstanceType<typeof ProjectJobRepository>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const start = "2026-10-05T00:00:00.000Z";
function taskArguments(step:ProjectJob["steps"][number]) {
  if(step.toolName!=="create_task")throw Error("Expected a version-one task fixture");
  return step.arguments;
}
function job(): ProjectJob {
  const id = randomUUID(), result: ProjectJob = { id, revision: 0, status: "queued", generation: 0, owner: null,
    createdAt: start, updatedAt: start, startedAt: null, finishedAt: null, deadlineAt: "2026-10-06T00:00:00.000Z",
    userMessage: "请创建两项纯虚构任务", authorization: "first-party-confirmation", planHash: "", nextStep: 0,
    baseline: { contextRevision: digest("context"), memoryRevision: digest("memory"), protectedRevision: digest("protected"), settingsRevision: digest("settings"),
      taskJsonHash: digest("before-json"), taskMirrorHash: digest("before-mirror"), sourcePaths: [store.path(store.settings.folders.goals, "纯虚构原文.md")] },
    steps: [], effects: [], error: "" };
  result.steps = [0, 1].map(index => { const args = { title: `纯虚构任务${index}`, date: "2026-10-06", time: "09:30", category: "纯虚构" };
    return { toolName: "create_task", operationId: projectJobStepOperationId(id, index), arguments: args, fingerprint: operationFingerprint("create_task", args) }; });
  result.planHash = projectJobPlanHash(result); return result;
}
function next(current: ProjectJob, patch: Partial<ProjectJob> = {}): ProjectJob {
  return { ...structuredClone(current), revision: current.revision + 1,
    updatedAt: new Date(Date.parse(current.updatedAt) + 1000).toISOString(), ...patch };
}
function running(current: ProjectJob, owner = "synthetic-owner"): ProjectJob {
  const updated = next(current, { status: "running", generation: current.generation + 1, owner, finishedAt: null });
  updated.startedAt = updated.updatedAt; return updated;
}
function effect(current: ProjectJob, index = current.effects.length): ProjectJobEffect {
  return { phase: "effect_recorded", stepIndex: index, operationId: current.steps[index].operationId, fingerprint: current.steps[index].fingerprint,
    taskId: `synthetic-task-${index}`, taskHash: digest(`synthetic-task-hash-${index}`),
    beforeTaskJsonHash: index ? current.effects[index - 1].afterTaskJsonHash : current.baseline.taskJsonHash, afterTaskJsonHash: digest(`after-json-${index}`),
    beforeTaskMirrorHash: index ? current.effects[index - 1].afterTaskMirrorHash : current.baseline.taskMirrorHash, afterTaskMirrorHash: digest(`after-mirror-${index}`),
    contextRevisionAfter: digest(`after-context-${index}`) };
}
async function create(current = job()) { return repo.updateMetadata(await repo.load(), current); }
async function inScope(snapshot: Awaited<ReturnType<typeof repo.load>>, value: ProjectJob) {
  return store.runFactOperation!({ operationId: `local:synthetic-job-scope:${randomUUID()}` }, scope => repo.updateInScope(snapshot, value, scope), async () => {});
}
beforeEach(async () => {
  roots = []; const root = await mkdtemp(join(tmpdir(), "lifeops-project-job-repository-")); roots.push(root); vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault(); repo = new ProjectJobRepository(store);
});
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });

describe("persistent single project Job repository", () => {
  it("loads missing state read-only, then persists a bound authorization and survives a fresh Store", async () => {
    const writes = vault.writes.length, empty = await repo.load();
    expect(empty.document).toEqual({ version: 1, job: null }); expect(empty.raw).toBeNull(); expect(vault.writes).toHaveLength(writes);
    const value = job(), created = await repo.updateMetadata(empty, value), ledger = new OperationLedger(store);
    const document = await store.readJson<any>(ledger.filePath, null), authorization = document.records.find((item: any) => item.operationId === `job:${value.id}:authorize`);
    expect(authorization).toMatchObject({ toolName: "project_job_metadata", source: "system", status: "verified", arguments: {
      jobId: value.id, planHash: value.planHash, fromRevision: null, toRevision: 0, fromStatus: null, toStatus: "queued", beforeHash: "absent", afterHash: digest(created.raw!) }
    });
    expect(authorization.result.undo).toBeUndefined(); expect(await ledger.latestReversible()).toBeNull();
    const fresh = new LifeOpsStore(store.app, structuredClone(store.settings)) as unknown as StoreHost;
    expect((await new ProjectJobRepository(fresh).load()).document).toEqual(created.document);
    expect(Object.isFrozen(created.document.job!.steps[0].arguments)).toBe(true);
  });

  it("preserves unknown document/job/step/baseline/effect fields and includes them in exact raw CAS", async () => {
    const value = job(); value.vendor = { keep: "原字" }; value.steps[0].vendor = ["步骤" ]; value.baseline.vendor = { keep: true };
    await vault.seed(projectJobPath(store), JSON.stringify({ version: 1, job: null, vendor: { keep: [1, 2] } }));
    const created = await create(value), active = await repo.updateMetadata(created, running(created.document.job!));
    const changed = next(active.document.job!); delete changed.vendor; delete changed.steps[0].vendor; delete changed.baseline.vendor;
    const first = effect(changed); first.vendor = "效果扩展"; changed.effects.push(first);
    const saved = await inScope(active, changed), committed = next(saved.document.job!); delete committed.effects[0].vendor;
    committed.effects[0].phase = "committed"; committed.nextStep = 1;
    const final = await repo.updateMetadata(saved, committed);
    expect(final.document.vendor).toEqual({ keep: [1, 2] }); expect(final.document.job!.vendor).toEqual({ keep: "原字" });
    expect(final.document.job!.steps[0].vendor).toEqual(["步骤"]); expect(final.document.job!.baseline.vendor).toEqual({ keep: true }); expect(final.document.job!.effects[0].vendor).toBe("效果扩展");
  });

  it("records candidate and committed effects in order, then completes without user undo", async () => {
    let snapshot = await create(); snapshot = await repo.updateMetadata(snapshot, running(snapshot.document.job!));
    for (let index = 0; index < 2; index++) {
      const candidate = next(snapshot.document.job!); candidate.effects.push(effect(candidate)); snapshot = await inScope(snapshot, candidate);
      expect(snapshot.document.job!.nextStep).toBe(index);
      const committed = next(snapshot.document.job!); committed.effects[index].phase = "committed"; committed.nextStep = index + 1;
      snapshot = await repo.updateMetadata(snapshot, committed);
    }
    const completed = next(snapshot.document.job!, { status: "completed", owner: null }); completed.finishedAt = completed.updatedAt;
    snapshot = await repo.updateMetadata(snapshot, completed); expect(snapshot.document.job!.status).toBe("completed");
    expect(await new OperationLedger(store).latestReversible()).toBeNull();
  });

  it("permits CAS-protected new owner generation for explicit recovery and failed recovery", async () => {
    let snapshot = await create(); snapshot = await repo.updateMetadata(snapshot, running(snapshot.document.job!));
    const resumed = running(snapshot.document.job!, "synthetic-new-process"); snapshot = await repo.updateMetadata(snapshot, resumed);
    expect(snapshot.document.job!.generation).toBe(2);
    const failed = next(snapshot.document.job!, { status: "failed", owner: null, error: "纯虚构失败" }); failed.finishedAt = failed.updatedAt;
    snapshot = await repo.updateMetadata(snapshot, failed); snapshot = await repo.updateMetadata(snapshot, running(snapshot.document.job!, "synthetic-explicit-retry"));
    expect(snapshot.document.job!.generation).toBe(3);
  });

  it.each(["cancelled", "timed_out"] as const)("fences %s by incrementing generation and clearing owner, then denies reopening", async status => {
    let snapshot = await create(); snapshot = await repo.updateMetadata(snapshot, running(snapshot.document.job!));
    const stopped = next(snapshot.document.job!, { status, generation: snapshot.document.job!.generation + 1, owner: null }); stopped.finishedAt = stopped.updatedAt;
    snapshot = await repo.updateMetadata(snapshot, stopped);
    await expect(repo.updateMetadata(snapshot, running(snapshot.document.job!, "synthetic-late-owner"))).rejects.toBeInstanceOf(ProjectJobRepositoryError);
    expect((await repo.load()).document.job!.status).toBe(status);
  });

  it("allows an explicit cancellation of failed remaining work while permanently revoking reopening", async () => {
    let snapshot = await create(); snapshot = await repo.updateMetadata(snapshot, running(snapshot.document.job!));
    const failed = next(snapshot.document.job!, { status: "failed", owner: null, error: "纯虚构未完成" }); failed.finishedAt = failed.updatedAt;
    snapshot = await repo.updateMetadata(snapshot, failed);
    const cancelled = next(snapshot.document.job!, { status: "cancelled", generation: snapshot.document.job!.generation + 1, owner: null }); cancelled.finishedAt = cancelled.updatedAt;
    snapshot = await repo.updateMetadata(snapshot, cancelled);
    await expect(repo.updateMetadata(snapshot, running(snapshot.document.job!, "synthetic-explicit-retry"))).rejects.toBeInstanceOf(ProjectJobRepositoryError);
    expect((await repo.load()).document.job!.status).toBe("cancelled");
  });

  it("rejects stale raw snapshots and changed bytes at the native process boundary without overwriting", async () => {
    const created = await create(), stale = created; const active = await repo.updateMetadata(created, running(created.document.job!));
    await expect(repo.updateMetadata(stale, running(stale.document.job!))).rejects.toThrow(); expect((await repo.load()).raw).toBe(active.raw);
    const external = `${active.raw!}\n`, process = vault.process.bind(vault); let injected = false;
    vi.spyOn(vault, "process").mockImplementation(async (file, updater) => {
      if (file.path === projectJobPath(store) && !injected) { injected = true; await vault.seed(file.path, external); }
      return process(file, updater);
    });
    await expect(inScope(active, next(active.document.job!))).rejects.toThrow(); expect(await vault.bytes(projectJobPath(store))).toBe(external);
  });

  it("never overwrites a create race or a renamed file", async () => {
    const empty = await repo.load(), value = job(), external = JSON.stringify({ version: 1, job: job(), vendor: "外部创建" });
    const createFile = vault.create.bind(vault); let injected = false;
    vi.spyOn(vault, "create").mockImplementation(async (path, content) => {
      if (path === projectJobPath(store) && !injected) { injected = true; await vault.seed(path, external); }
      return createFile(path, content);
    });
    await expect(repo.updateMetadata(empty, value)).rejects.toThrow(); expect(await vault.bytes(projectJobPath(store))).toBe(external);
  });

  it("rejects a renamed current TFile inside native process", async () => {
    const snapshot = await create(), path = projectJobPath(store), moved = store.path(store.settings.folders.aiReports, "Jobs", "pure-synthetic-moved.json");
    const process = vault.process.bind(vault);
    vi.spyOn(vault, "process").mockImplementation(async (file, updater) => { if (file.path === path) await vault.rename(file, moved); return process(file, updater); });
    await expect(inScope(snapshot, running(snapshot.document.job!))).rejects.toThrow();
    expect(store.getFile(path)).toBeNull(); expect(await vault.bytes(moved)).toBe(snapshot.raw);
  });

  it("refuses unguarded writes, copied snapshots, another Store and a real foreign Vault scope", async () => {
    const snapshot = await repo.load(), value = job();
    await expect(repo.updateInScope(snapshot, value)).rejects.toBeInstanceOf(ProjectJobRepositoryError);
    await expect(repo.updateMetadata({ ...snapshot }, value)).rejects.toBeInstanceOf(ProjectJobRepositoryError);
    const another = new LifeOpsStore(store.app, structuredClone(store.settings)) as unknown as StoreHost;
    await expect(new ProjectJobRepository(another).updateMetadata(snapshot, value)).rejects.toBeInstanceOf(ProjectJobRepositoryError);
    const foreignRoot = await mkdtemp(join(tmpdir(), "lifeops-project-job-foreign-")); roots.push(foreignRoot);
    const foreign = new LifeOpsStore({ vault: new DiskVault(foreignRoot), workspace: {} } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    await foreign.initializeVault();
    await expect(foreign.runFactOperation!({ operationId: "local:synthetic-foreign-scope" }, scope => repo.updateInScope(snapshot, value, scope), async () => {})).rejects.toBeInstanceOf(ProjectJobRepositoryError);
    expect(store.getFile(projectJobPath(store))).toBeNull(); expect(foreign.getFile(projectJobPath(foreign))).toBeNull();
  });

  it("never reads an excluded or oversized Job file", async () => {
    const snapshot = await create(), reads = vi.spyOn(vault, "read"); store.settings.privacy!.excludedVaultPrefixes.push(projectJobPath(store));
    await expect(repo.load()).rejects.toBeInstanceOf(ProjectJobRepositoryError);
    await expect(repo.updateMetadata(snapshot, running(snapshot.document.job!))).rejects.toBeInstanceOf(ProjectJobRepositoryError);
    expect(reads.mock.calls.some(([file]) => file.path === projectJobPath(store))).toBe(false);
    store.settings.privacy!.excludedVaultPrefixes = []; await vault.seed(projectJobPath(store), " ".repeat(1024 * 1024 + 1)); reads.mockClear();
    await expect(repo.load()).rejects.toBeInstanceOf(ProjectJobRepositoryError);
    expect(reads.mock.calls.some(([file]) => file.path === projectJobPath(store))).toBe(false);
  });

  it("uses the live original privacy guard and restores a metadata write when exclusion changes mid-save", async () => {
    const snapshot = await create(), process = vault.process.bind(vault);
    vi.spyOn(vault, "process").mockImplementation(async (file, updater) => {
      const result = await process(file, updater); if (file.path === projectJobPath(store)) store.settings.privacy!.excludedVaultPrefixes.push(file.path); return result;
    });
    await expect(repo.updateMetadata(snapshot, running(snapshot.document.job!))).rejects.toThrow();
    expect(await vault.bytes(projectJobPath(store))).toBe(snapshot.raw);
  });

  it("does not create a Job when it becomes excluded during folder creation", async () => {
    const empty = await repo.load(), path = projectJobPath(store), folder = path.split("/").slice(0, -1).join("/"), createFolder = vault.createFolder.bind(vault);
    vi.spyOn(vault, "createFolder").mockImplementation(async location => {
      const result = await createFolder(location); if (location === folder) store.settings.privacy!.excludedVaultPrefixes.push(path); return result;
    });
    await expect(repo.updateMetadata(empty, job())).rejects.toBeInstanceOf(ProjectJobRepositoryError);
    expect(store.getFile(path)).toBeNull(); expect(vault.writes.some(write => write.path === path)).toBe(false);
  });

  it("internal metadata leaves an earlier user undo available and guards cancellation before commit", async () => {
    const ledger = new OperationLedger(store), claim = await ledger.claim({ operationId: "synthetic-user-fact", toolName: "create_task", source: "system", arguments: { title: "纯虚构用户动作" } });
    expect(claim.kind).toBe("execute");
    await store.runFactOperation!({ operationId: "synthetic-user-fact" }, scope => scope.writeFile(scope.path(scope.settings.folders.inbox, "纯虚构动作.md"), "纯虚构记录"), async (_, undo) => {
      await ledger.verify("synthetic-user-fact", { success: true, output: "纯虚构保存", actions: [], undo });
    });
    const snapshot = await create(); expect((await ledger.latestReversible())!.operationId).toBe("synthetic-user-fact");
    let written = false; const process = vault.process.bind(vault);
    vi.spyOn(vault, "process").mockImplementation(async (file, updater) => { const result = await process(file, updater); if (file.path === projectJobPath(store)) written = true; return result; });
    await expect(repo.updateMetadata(snapshot, running(snapshot.document.job!), { assertCurrent: () => { if (written) throw new Error("Synthetic cancellation"); } })).rejects.toThrow();
    expect(await vault.bytes(projectJobPath(store))).toBe(snapshot.raw); expect((await ledger.latestReversible())!.operationId).toBe("synthetic-user-fact");
  });

  it("rejects no-op and nested metadata before claiming or writing another authorization", async () => {
    const snapshot = await create(), writes = vault.writes.length, ledger = new OperationLedger(store), audit = await vault.bytes(ledger.filePath);
    await expect(repo.updateMetadata(snapshot, structuredClone(snapshot.document.job!))).rejects.toBeInstanceOf(ProjectJobRepositoryError);
    await expect(store.runFactOperation!({ operationId: "local:synthetic-nested-metadata" }, async scope => {
      const nested = new ProjectJobRepository(scope); return nested.updateMetadata(await nested.load(), running(snapshot.document.job!));
    }, async () => {})).rejects.toBeInstanceOf(ProjectJobRepositoryError);
    expect(vault.writes.length).toBe(writes); expect(await vault.bytes(ledger.filePath)).toBe(audit);
    expect(await vault.bytes(projectJobPath(store))).toBe(snapshot.raw);
  });

  it("freezes each submitted Job before the first await", async () => {
    const value = job(), title = taskArguments(value.steps[0]).title, message = value.userMessage;
    const pending = repo.updateMetadata(await repo.load(), value); value.userMessage = "纯虚构等待中改的原话"; taskArguments(value.steps[0]).title = "纯虚构等待中改的参数";
    const created = await pending; expect(created.document.job!.userMessage).toBe(message); expect(taskArguments(created.document.job!.steps[0]).title).toBe(title);
    const active = running(created.document.job!), originalOwner = active.owner;
    const saved = await store.runFactOperation!({ operationId: "local:synthetic-frozen-scope" }, scope => {
      const saving = repo.updateInScope(created, active, scope); active.owner = "synthetic-late-edit"; return saving;
    }, async () => {});
    expect(saved.document.job!.owner).toBe(originalOwner);
  });

  it("rejects a folder configuration change during read before returning old-path state", async () => {
    const snapshot = await create(), path = projectJobPath(store), read = vault.read.bind(vault);
    vi.spyOn(vault, "read").mockImplementation(async file => {
      const raw = await read(file); if (file.path === path) store.settings.folders.aiReports = "纯虚构已更换目录"; return raw;
    });
    await expect(repo.load()).rejects.toBeInstanceOf(ProjectJobRepositoryError); expect(await vault.bytes(path)).toBe(snapshot.raw);
  });

  const malformed: Array<[string, (value: any) => void]> = [
    ["unknown version", value => { value.version = 2; }], ["schemaVersion", value => { value.schemaVersion = 1; }],
    ["missing job", value => { delete value.job; }], ["bad state", value => { value.job.status = "suggested"; }],
    ["bad generation", value => { value.job.generation = -1; }], ["bad UUID", value => { value.job.id = "synthetic-not-uuid"; }],
    ["bad plan binding", value => { value.job.userMessage = "纯虚构后来改的授权"; }], ["relative date", value => { value.job.steps[0].arguments.date = "明天"; }],
    ["invalid date", value => { value.job.steps[0].arguments.date = "2026-02-30"; }], ["invalid time", value => { value.job.steps[0].arguments.time = "24:01"; }],
    ["unknown argument", value => { value.job.steps[0].arguments.confirmedByUser = true; }], ["unsupported tool", value => { value.job.steps[0].toolName = "complete_task"; }],
    ["wrong stable ID", value => { value.job.steps[0].operationId = value.job.steps[1].operationId; }], ["missing fingerprint", value => { delete value.job.steps[0].fingerprint; }],
    ["wrong nextStep", value => { value.job.nextStep = 1; }], ["completed without effects", value => { value.job.status = "completed"; value.job.finishedAt = start; }],
    ["unsafe source", value => { value.job.baseline.sourcePaths = ["../日用原文.md"]; }], ["duplicate source", value => { value.job.baseline.sourcePaths.push(value.job.baseline.sourcePaths[0]); }]
  ];
  it.each(malformed)("rejects %s on load and protected generic write without replacing bytes", async (_name, change) => {
    const document = { version: 1, job: job() }; change(document); const raw = JSON.stringify(document); await vault.seed(projectJobPath(store), raw);
    expect(validateProjectJobDocument(document)).toBe(false);
    await expect(repo.load()).rejects.toBeInstanceOf(ProjectJobRepositoryError);
    await expect(store.writeJson(projectJobPath(store), { version: 1, job: job() })).rejects.toThrow();
    expect(await vault.bytes(projectJobPath(store))).toBe(raw);
  });

  it("rejects broken JSON without echoing or overwriting private content", async () => {
    const raw = '{"version":1,"job":"纯虚构应保留片段'; await vault.seed(projectJobPath(store), raw);
    await expect(repo.load()).rejects.toThrow("安排记录已变化或格式无法识别"); expect(await vault.bytes(projectJobPath(store))).toBe(raw);
  });

  it.each(["fixed plan", "fixed baseline", "extension", "generation rewind", "owner swap without generation", "replace Job", "clear Job"])("rejects metadata change: %s", async kind => {
    let snapshot = await create(); snapshot = await repo.updateMetadata(snapshot, running(snapshot.document.job!));
    const changed = next(snapshot.document.job!);
    if (kind === "fixed plan") { taskArguments(changed.steps[0]).title = "纯虚构改计划"; changed.steps[0].fingerprint = operationFingerprint("create_task", changed.steps[0].arguments); changed.planHash = projectJobPlanHash(changed); }
    if (kind === "fixed baseline") { changed.baseline.contextRevision = digest("modified-context"); changed.planHash = projectJobPlanHash(changed); }
    if (kind === "extension") changed.steps[0].vendor = "新固定扩展";
    if (kind === "generation rewind") changed.generation--;
    if (kind === "owner swap without generation") changed.owner = "synthetic-new-owner";
    if (kind === "replace Job") Object.assign(changed, job());
    const before = snapshot.raw;
    await expect(repo.updateMetadata(snapshot, kind === "clear Job" ? null as unknown as ProjectJob : changed)).rejects.toBeInstanceOf(ProjectJobRepositoryError);
    expect(await vault.bytes(projectJobPath(store))).toBe(before);
  });

  it.each(["drop", "edit committed", "rewind phase", "wrong chain", "direct committed append"])("rejects effect change: %s", async kind => {
    let snapshot = await create(); snapshot = await repo.updateMetadata(snapshot, running(snapshot.document.job!));
    const candidate = next(snapshot.document.job!); candidate.effects.push(effect(candidate)); snapshot = await inScope(snapshot, candidate);
    const committed = next(snapshot.document.job!); committed.effects[0].phase = "committed"; committed.nextStep = 1; snapshot = await repo.updateMetadata(snapshot, committed);
    const changed = next(snapshot.document.job!);
    if (kind === "drop") { changed.effects = []; changed.nextStep = 0; }
    if (kind === "edit committed") changed.effects[0].taskHash = digest("external-modified-task");
    if (kind === "rewind phase") { changed.effects[0].phase = "effect_recorded"; changed.nextStep = 0; }
    if (kind === "wrong chain") { const another = effect(changed); another.beforeTaskJsonHash = digest("unrelated-before"); changed.effects.push(another); }
    if (kind === "direct committed append") { const another = effect(changed); another.phase = "committed"; changed.effects.push(another); changed.nextStep = 2; }
    await expect(repo.updateMetadata(snapshot, changed)).rejects.toBeInstanceOf(ProjectJobRepositoryError); expect(await vault.bytes(projectJobPath(store))).toBe(snapshot.raw);
  });

  it.each(["new owner", "failed", "cancelled"])("never combines candidate commitment with %s", async kind => {
    let snapshot = await create(); snapshot = await repo.updateMetadata(snapshot, running(snapshot.document.job!));
    const candidate = next(snapshot.document.job!); candidate.effects.push(effect(candidate)); snapshot = await inScope(snapshot, candidate);
    const changed = next(snapshot.document.job!); changed.effects[0].phase = "committed"; changed.nextStep = 1;
    if (kind === "new owner") { changed.generation++; changed.owner = "synthetic-new-process"; }
    else { changed.status = kind === "failed" ? "failed" : "cancelled"; changed.owner = null; changed.finishedAt = changed.updatedAt; if (kind === "cancelled") changed.generation++; }
    expect(validateProjectJobDocument({ version: 1, job: changed })).toBe(true);
    await expect(repo.updateMetadata(snapshot, changed)).rejects.toBeInstanceOf(ProjectJobRepositoryError); expect(await vault.bytes(projectJobPath(store))).toBe(snapshot.raw);
  });
});
