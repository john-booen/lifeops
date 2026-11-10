import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import { projectDocumentPath } from "../src/dataFoundation/projectPersistence";
import type { AgentActionSuggestion } from "../src/types";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { AgentRuntime } = await import("../src/agentRuntime");
const { getLifeOpsTool, runConfirmedToolAction } = await import("../src/toolRegistry");
const { OperationLedger } = await import("../src/dataFoundation/operationLedger");
const { assertProjectConfirmationPayload } = await import("../src/projectTools");
let root: string, store: StoreHost, vault: InstanceType<typeof DiskVault>, runtime: InstanceType<typeof AgentRuntime>;
let serial = 0;
const context = () => ({ store, refreshViews: async () => undefined });
function reopen() { store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; runtime = new AgentRuntime(context()); }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-project-tools-")); vault = new DiskVault(root); reopen(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function propose(command: unknown, id = `project-proposal-${++serial}`) {
  return runtime.executeAiToolCall({ id, name: "propose_project_change", arguments: { command } }, "kimi", "请先给我看具体的项目变更");
}
async function card(command: unknown) { const result = await propose(command); expect(result.success, result.output).toBe(true); expect(result.actions).toHaveLength(1); return result.actions[0]; }
async function confirm(action: AgentActionSuggestion) { expect(await runConfirmedToolAction(action, context())).toBe(true); }
async function setup() {
  await confirm(await card({ kind: "save_goal", input: { title: "虚构目标：河流研究", reason: "积累解释能力", constraints: "每晚半小时", successCriteria: "整理两份原文", nextStep: "找第一份来源" } }));
  const goalId = (await store.getProjectSnapshot()).document.goals[0].id;
  await confirm(await card({ kind: "save_project", input: { title: "虚构项目：河流材料", goalId, commitments: "整理一份摘录", blockers: "缺原文" } }));
  return { goalId, projectId: (await store.getProjectSnapshot()).document.projects[0].id };
}
afterEach(() => vi.restoreAllMocks());
// The shared disk fixture is prepended below; every fact here is fictional.
describe("reviewed project task results", () => {
  async function linked(completed = false) {
    const { projectId } = await setup();
    await confirm(await card({ kind: "create_task", projectId, input: { title: "纯虚构核对材料", date: "2026-10-06" } }));
    let task = (await store.getProjectSnapshot()).tasks[0];
    if (completed) {
      await runtime.executeLocalOperation("complete-original", {}, scoped => scoped.completeTask(task.id), `local:complete-${++serial}`);
      task = (await store.getProjectSnapshot()).tasks[0];
    }
    return { projectId, task };
  }
  const command = (projectId: string, taskId: string, extra = {}) => ({ kind: "record_task_result", projectId, taskId,
    entryKind: "review", text: "纯虚构实际反馈：还缺对照", nextStep: "纯虚构下一步：补对照", ...extra });
  it("exposes an explicit required-field model tool and refuses missing/forged args without writes", async () => {
    const { projectId, task } = await linked();
    const tool = getLifeOpsTool("propose_project_task_result")!;
    expect(tool.parameters.required).toEqual(["projectId", "taskId", "entryKind", "text"]);
    const { kind: _kind, ...args } = command(projectId, task.id), before = vault.writes.length;
    const valid = await runtime.executeAiToolCall({ id: "dedicated-result", name: tool.name, arguments: args }, "kimi", "虚构结果");
    expect(valid.success, valid.output).toBe(true); expect(valid.actions[0].projectCommand?.kind).toBe("record_task_result"); expect(vault.writes).toHaveLength(before);
    for (const fields of [{ taskId: task.id, text: "缺项目和类型" }, { ...args, taskEvidence: { status: "completed" } }]) {
      const result = await runtime.executeAiToolCall({ id: `dedicated-bad-${++serial}`, name: tool.name, arguments: fields }, "kimi", "虚构结果");
      expect(result.success).toBe(false); expect(result.actions).toEqual([]); expect(vault.writes).toHaveLength(before);
    }
  });
  it("previews actual completion read-only, records original evidence, preserves Task bytes/stage and reopens exactly", async () => {
    const { projectId, task } = await linked(true), taskRaw = await vault.bytes(store.taskDbPath()), mirror = await vault.bytes(store.taskMirrorPath()), writes = vault.writes.length;
    const action = await card(command(projectId, task.id));
    expect(action.content).toContain("已完成（任务库记录）"); expect(action.content).toContain(task.completedAt);
    expect(action.content).toContain("不自动认定项目已完成"); expect(vault.writes).toHaveLength(writes);
    await confirm(action); const raw = await vault.bytes(projectDocumentPath(store)), snapshot = await store.getProjectSnapshot(), entry = snapshot.document.projects[0].entries[0];
    expect(entry.taskEvidence).toMatchObject({ taskId: task.id, title: task.title, status: "completed", completedAt: task.completedAt });
    expect(snapshot.document.projects[0].state).toBe("suggested"); expect(snapshot.document.projects[0].nextStep).toBe("纯虚构下一步：补对照");
    expect(await vault.bytes(store.taskDbPath())).toBe(taskRaw); expect(await vault.bytes(store.taskMirrorPath())).toBe(mirror);
    reopen(); expect((await store.getProjectSnapshot()).document.projects[0].entries[0]).toEqual(entry); expect(await vault.bytes(projectDocumentPath(store))).toBe(raw);
    expect(await store.buildProjectContext()).toContain("当前任务字段与当时一致");
  });
  it.each(["active", "abandoned"])("records actual %s, never fabricated completion", async status => {
    const { projectId, task } = await linked();
    if (status === "abandoned") await runtime.executeLocalOperation("abandon", {}, scoped => scoped.abandonTask(task.id), `local:abandon-${++serial}`);
    const action = await card(command(projectId, task.id));
    expect(action.content).toContain(status === "active" ? "待办（任务库记录）" : "已取消（任务库记录）"); expect(action.content).not.toContain("当时完成时间");
    await confirm(action); expect((await store.getProjectSnapshot()).document.projects[0].entries[0].taskEvidence).toMatchObject({ status, completedAt: "" });
  });
  it.each(["task_changed", "deleted", "unlinked", "task_db_excluded", "task_source_excluded"])("refuses stale results after %s and preserves later facts", async cause => {
    const { projectId, task } = await linked(), source = store.path(store.settings.folders.outputs, "纯虚构任务来源.md");
    await vault.seed(source, "纯虚构来源"); await runtime.executeLocalOperation("assign-source", {}, scoped => scoped.updateTask(task.id, value => ({ ...value, sourceNotePath: source })), `local:source-${++serial}`);
    const action = await card(command(projectId, task.id));
    if (cause === "task_changed") await runtime.executeLocalOperation("abandon", {}, scoped => scoped.abandonTask(task.id), `local:change-${++serial}`);
    if (cause === "deleted") await runtime.executeLocalOperation("delete", {}, scoped => scoped.deleteTask(task.id), `local:delete-${++serial}`);
    if (cause === "unlinked") await confirm(await card({ kind: "link_task", projectId, taskId: task.id, remove: true }));
    if (cause === "task_db_excluded") store.settings.privacy = { excludedVaultPrefixes: [store.taskDbPath()] };
    if (cause === "task_source_excluded") store.settings.privacy = { excludedVaultPrefixes: [source] };
    const projectRaw = await vault.bytes(projectDocumentPath(store)), taskRaw = await vault.bytes(store.taskDbPath());
    await expect(confirm(action)).rejects.toThrow(); expect(await vault.bytes(projectDocumentPath(store))).toBe(projectRaw); expect(await vault.bytes(store.taskDbPath())).toBe(taskRaw);
  });
  it("refuses model evidence/versions and unlinked task claims", async () => {
    const { projectId, task } = await linked();
    for (const extra of [{ taskEvidence: { status: "completed" } }, { completedAt: "2026-10-05T00:00:00Z" }, { expectedTaskRevision: "f".repeat(64) }]) expect((await propose(command(projectId, task.id, extra))).success).toBe(false);
    await confirm(await card({ kind: "link_task", projectId, taskId: task.id, remove: true }));
    expect((await propose(command(projectId, task.id))).success).toBe(false); expect((await store.getProjectSnapshot()).document.projects[0].entries).toEqual([]);
  });
  it.each(["fake_evidence", "missing_revision", "unlinked", "excluded"])("the scoped Store independently rejects %s without relying on model preparation", async cause => {
    const { projectId, task } = await linked();
    const reviewed: any = (await card(command(projectId, task.id))).projectCommand;
    if (cause === "fake_evidence") reviewed.taskEvidence = { status: "completed" };
    if (cause === "missing_revision") delete reviewed.expectedTaskRevision;
    if (cause === "unlinked") await confirm(await card({ kind: "link_task", projectId, taskId: task.id, remove: true }));
    if (cause === "excluded") store.settings.privacy = { excludedVaultPrefixes: [store.taskDbPath()] };
    const snapshot = await store.getProjectSnapshot(), before = await vault.bytes(projectDocumentPath(store)), id = `local:independent-result-${++serial}`;
    const saved = await runtime.executeLocalOperation("direct-result", {}, scoped => scoped.applyProjectCommand(reviewed, snapshot.revision, id), id);
    expect(saved.success).toBe(false); expect(await vault.bytes(projectDocumentPath(store))).toBe(before);
  });
  it("does not invent a completion date from a malformed calendar timestamp", async () => {
    const { projectId, task } = await linked(true), db = JSON.parse(await vault.bytes(store.taskDbPath()));
    db.tasks[0].completedAt = "2026-02-30T09:00:00Z"; await vault.seed(store.taskDbPath(), JSON.stringify(db));
    const action = await card(command(projectId, task.id)); expect(action.content).toContain("未有效记录，不能推断");
    await confirm(action); expect((await store.getProjectSnapshot()).document.projects[0].entries[0].taskEvidence?.completedAt).toBe("");
  });
  it("preserves original evidence in current and prior corrections when Tasks change", async () => {
    const { projectId, task } = await linked(true); await confirm(await card(command(projectId, task.id))); const original = (await store.getProjectSnapshot()).document.projects[0].entries[0];
    await runtime.executeLocalOperation("reopen", {}, scoped => scoped.updateTask(task.id, value => ({ ...value, status: "active", completedAt: "" })), `local:reopen-${++serial}`);
    const correction = await card({ kind: "correct_entry", projectId, entryId: original.id, text: "更正反馈：需要两个对照" });
    expect(correction.content).toContain("当前原任务已变化"); expect(correction.content).toContain("保留记录当时的任务依据"); await confirm(correction);
    const entry = (await store.getProjectSnapshot()).document.projects[0].entries[0]; expect(entry.taskEvidence).toEqual(original.taskEvidence); expect(entry.revisions[0].taskEvidence).toEqual(original.taskEvidence);
    expect(entry.revisions[0].text).toBe(original.text); expect(await store.buildProjectContext()).toContain("当时记录只作历史");
  });
  it("withholds historical text/evidence/next step when the old source is excluded after a Task changes source", async () => {
    const { projectId, task } = await linked(), a = store.path(store.settings.folders.outputs, "纯虚构旧来源.md"), b = store.path(store.settings.folders.outputs, "纯虚构新来源.md");
    await vault.seed(a, "旧原文"); await vault.seed(b, "新原文");
    await runtime.executeLocalOperation("source-a", {}, scoped => scoped.updateTask(task.id, value => ({ ...value, sourceNotePath: a })), `local:a-${++serial}`);
    await confirm(await card(command(projectId, task.id)));
    await runtime.executeLocalOperation("source-b", {}, scoped => scoped.updateTask(task.id, value => ({ ...value, sourceNotePath: b, title: "当前任务不同名称" })), `local:b-${++serial}`);
    store.settings.privacy = { excludedVaultPrefixes: [a] };
    const output = await store.buildProjectContext(); expect(output).not.toContain("纯虚构实际反馈"); expect(output).not.toContain("纯虚构下一步"); expect(output).not.toContain("纯虚构核对材料"); expect(output).toContain("本轮省略对应内容");
    const patch = await propose({ kind: "save_project", id: projectId, input: { nextStep: "允许的新下一步" } });
    expect(patch.success).toBe(false); expect(patch.actions).toEqual([]); expect(patch.output).not.toContain("纯虚构下一步");
    store.settings.privacy = { excludedVaultPrefixes: [store.taskDbPath()] }; expect(await store.buildProjectContext()).not.toContain("纯虚构实际反馈");
  });
  it("replays after audit trimming without refreshing evidence or duplicating entries", async () => {
    const { projectId, task } = await linked(true), action = await card(command(projectId, task.id)); await confirm(action);
    await runtime.executeLocalOperation("reopen", {}, scoped => scoped.updateTask(task.id, value => ({ ...value, status: "active", completedAt: "" })), `local:again-${++serial}`);
    const before = await vault.bytes(projectDocumentPath(store)); await vault.seed(store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json"), '{"version":1,"records":[]}');
    await confirm(action); expect(await vault.bytes(projectDocumentPath(store))).toBe(before); expect((await store.getProjectSnapshot()).document.projects[0].entries).toHaveLength(1);
  });
  it.each(["status", "title", "extra", "null"])("refuses tampered persisted evidence %s without overwriting bytes", async kind => {
    const { projectId, task } = await linked(true); await confirm(await card(command(projectId, task.id))); const doc = JSON.parse(await vault.bytes(projectDocumentPath(store))), e = doc.projects[0].entries[0];
    if (kind === "status") e.taskEvidence.status = "imagined";
    if (kind === "title") e.taskEvidence.title = "冒充新标题";
    if (kind === "extra") e.taskEvidence.claim = "model-fabricated";
    if (kind === "null") e.taskEvidence = null;
    const raw = JSON.stringify(doc); await vault.seed(projectDocumentPath(store), raw); await expect(store.getProjectSnapshot()).rejects.toThrow(); expect(await vault.bytes(projectDocumentPath(store))).toBe(raw);
  });
  it("rolls back a result if Task facts change after final audit verification, preserving external Task bytes", async () => {
    const { projectId, task } = await linked(true), action = await card(command(projectId, task.id)), before = await vault.bytes(projectDocumentPath(store));
    const verify = OperationLedger.prototype.verify; let external = "";
    vi.spyOn(OperationLedger.prototype, "verify").mockImplementation(async function(this: InstanceType<typeof OperationLedger>, id, result) {
      const saved = await verify.call(this, id, result);
      if (id === `confirmed:${action.id}`) { const db = JSON.parse(await vault.bytes(store.taskDbPath())); db.tasks[0].title = "提交期间的外部更正"; external = JSON.stringify(db); await vault.seed(store.taskDbPath(), external); }
      return saved;
    });
    await expect(confirm(action)).rejects.toThrow("任务"); expect(await vault.bytes(projectDocumentPath(store))).toBe(before); expect(await vault.bytes(store.taskDbPath())).toBe(external);
    const ledger = JSON.parse(await vault.bytes(new OperationLedger(store).filePath));
    expect(ledger.records.find((record: any) => record.operationId === `confirmed:${action.id}`)?.status).toBe("failed");
  });
  it.each(["folder_policy", "task_fact"])("refuses %s changed while the final memory read awaits", async cause => {
    const { projectId, task } = await linked(true);
    await vault.seed(store.personalMemoryPath(), '{"version":1,"records":[]}');
    const action = await card(command(projectId, task.id)), before = await vault.bytes(projectDocumentPath(store));
    let armed = false, changed = false;
    const verify = OperationLedger.prototype.verify, read = store.readPath.bind(store), memoryPath = store.personalMemoryPath();
    vi.spyOn(OperationLedger.prototype, "verify").mockImplementation(async function(this: InstanceType<typeof OperationLedger>, id, result) {
      const saved = await verify.call(this, id, result); if (id === `confirmed:${action.id}`) armed = true; return saved;
    });
    vi.spyOn(store, "readPath").mockImplementation(async path => {
      const memory = await read(path);
      if (path === memoryPath && armed && !changed) {
        changed = true;
        if (cause === "folder_policy") store.settings.folders.outputs = "纯虚构新目录";
        else { const db = JSON.parse(await vault.bytes(store.taskDbPath())); db.tasks[0].title = "最终等待期间的更正"; await vault.seed(store.taskDbPath(), JSON.stringify(db)); }
      }
      return memory;
    });
    await expect(confirm(action)).rejects.toThrow(); expect(changed).toBe(true); expect(await vault.bytes(projectDocumentPath(store))).toBe(before);
    if (cause === "task_fact") expect((await store.readTaskDb({ readOnly: true })).tasks[0].title).toBe("最终等待期间的更正");
  });
});
