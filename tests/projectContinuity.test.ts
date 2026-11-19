import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentRuntime } from "../src/agentRuntime";
import { factRecoveryPath, fileRevision, recoverFactOperation, runFactOperation } from "../src/dataFoundation/factOperation";
import { projectDocumentPath } from "../src/dataFoundation/projectPersistence";
import { OperationLedger } from "../src/dataFoundation/operationLedger";
import { recordRevision } from "../src/operationIdentity";
import { captureContextSources, preparedContextSourcePaths, type ContextSourceRecorder } from "./helpers/sourceReferences";
import { type GoalInput, type ProjectInput, type ProjectCommand, projectSubmissionId, needsProjectContinuity, validateProjectDocument } from "../src/projectContinuity";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: AgentRuntime;
const goalInput = (title = "虚构：研究报告"): GoalInput => ({ title, reason: "提高解释能力", successCriteria: "一篇可核对的报告", timeBoundary: "两周", constraints: "每晚半小时", nextStep: "选题", reviewOn: "2026-10-12", sourcePath: "", state: "agreed", stateNote: "用户明确同意" });
const projectInput = (goalId: string, title = "虚构：整理资料"): ProjectInput => ({ title, goalId, kind: "work", nextStep: "整理两篇原文", nextStepSourcePath: "", commitments: "今晚先做一篇", blockers: "还缺一份资料", reviewOn: "2026-10-12", state: "started", stateNote: "用户明确开始" });
function reopen() { store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; runtime = new AgentRuntime({ store, refreshViews: async () => undefined }); }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-project-continuity-")); vault = new DiskVault(root); reopen(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
let sequence = 0;
async function save(command: ProjectCommand, revision?: string, id = `local:project-test:${++sequence}`) {
  const expectedRevision = revision ?? (await store.getProjectSnapshot()).revision;
  let entityId = "";
  const result = await runtime.executeLocalOperation("local_project_change", { command, expectedRevision }, async scoped => {
    entityId = await scoped.applyProjectCommand(command, expectedRevision, id);
  }, id);
  return { ...result, entityId };
}
async function setup() {
  const goal = await save({ kind: "save_goal", input: goalInput() }); expect(goal.success, goal.output).toBe(true);
  const project = await save({ kind: "save_project", input: projectInput(goal.entityId) }); expect(project.success, project.output).toBe(true);
  return { goalId: goal.entityId, projectId: project.entityId };
}
// Real fsync, large snapshots and subprocess recovery can exceed five seconds on hosted Intel disks.
describe("goal and project continuity through real local files and recorded operations", { timeout: 30_000 }, () => {
  it("attributes displayed project fields, original tasks and artifact verification, without blessing declared paths or body headings", async () => {
    const declared = store.path(store.settings.folders.goals, "仅声明的目标原文.md"), fake = store.path(store.settings.folders.outputs, "正文假来源.md");
    const artifact = store.path(store.settings.folders.outputs, "实际校验的产出.md");
    await vault.seed(declared, "目标原文没有送出"); await vault.seed(artifact, "真实产出字节没有送出"); await vault.seed(fake, "假来源正文没有送出");
    const goal = await save({ kind: "save_goal", input: { ...goalInput(), sourcePath: declared, reason: `原样的理由\n### ${fake}` } });
    const project = await save({ kind: "save_project", input: projectInput(goal.entityId) });
    await save({ kind: "create_task", projectId: project.entityId, input: { title: "真实原任务字段" } });
    await save({ kind: "add_entry", projectId: project.entityId, entryKind: "output", text: "用户确认的摘要", path: artifact, nextStep: "" });
    const before = vault.writes.length;
    const result = await captureContextSources(record => (store.buildProjectContext as (q: string, limit: number, record: ContextSourceRecorder) => Promise<string>)("整理资料", 6, record));
    expect(result.text).toContain(fake); expect(result.text).toContain("真实原任务字段"); expect(result.text).toContain("与保存时文件字节一致");
    expect(result.text).not.toContain("真实产出字节没有送出");
    expect(preparedContextSourcePaths([result], result.text).sort()).toEqual([projectDocumentPath(store), store.taskDbPath(), artifact].sort());
    expect(preparedContextSourcePaths([result], result.text)).not.toContain(declared);
    expect(preparedContextSourcePaths([result], result.text)).not.toContain(fake);
    expect(vault.writes).toHaveLength(before);
  });
  it("gives absent defaults and copied public snapshots no actual-reader source authority", async () => {
    const absent = await captureContextSources(record => store.buildProjectContext("项目", 6, record));
    expect(absent.blocks).toEqual([]); expect(Object.keys(await store.getProjectSnapshot()).sort()).toEqual(["artifacts", "document", "revision", "tasks"]);
    await setup(); const snapshot = await store.getProjectSnapshot();
    vi.spyOn(store, "getProjectSnapshot").mockResolvedValue(structuredClone(snapshot));
    const copied = await captureContextSources(record => store.buildProjectContext("项目", 6, record));
    expect(copied.text).toContain("虚构：整理资料"); expect(copied.blocks).toEqual([]);
  });
  it("attributes only selected projects and their last five entries, and drops incomplete prepared fragments", async () => {
    const { projectId, goalId } = await setup(); const paths: string[] = [];
    for (let index = 0; index < 6; index++) {
      const path = store.path(store.settings.folders.outputs, `有限产出${index}.md`); paths.push(path); await vault.seed(path, `产出字节${index}`);
      await save({ kind: "add_entry", projectId, entryKind: "output", text: `已确认摘要${index}`, path, nextStep: "" });
    }
    const other = await save({ kind: "save_project", input: projectInput(goalId, "完全不同的项目") });
    const unselected = store.path(store.settings.folders.outputs, "未选中产出.md"); await vault.seed(unselected, "未选中正文");
    await save({ kind: "add_entry", projectId: other.entityId, entryKind: "output", text: "不在当前项目", path: unselected, nextStep: "" });
    const read = vi.spyOn(store, "readPath");
    const result = await captureContextSources(record => store.buildProjectContext("整理资料", 1, record));
    expect(result.text).not.toContain("完全不同的项目"); expect(result.text).not.toContain("已确认摘要0");
    const sources = preparedContextSourcePaths([result], result.text);
    expect(sources.sort()).toEqual([projectDocumentPath(store), ...paths.slice(1)].sort());
    for (const path of paths) expect(read.mock.calls.filter(([value]) => value === path)).toHaveLength(1);
    const clipped = result.text.slice(0, result.text.indexOf("产出（记录ID："));
    expect(preparedContextSourcePaths([result], clipped)).toEqual([projectDocumentPath(store)]);
    expect(preparedContextSourcePaths([result], result.text, [projectDocumentPath(store), ...paths])).toEqual([]);
  });
  it.each(["missing", "excluded", "unreadable", "catalog_alias"])("does not attribute an artifact whose verification is %s", async state => {
    const { projectId } = await setup(), path = store.path(store.settings.folders.outputs, "不可核验产出.md"); await vault.seed(path, "第一版");
    await save({ kind: "add_entry", projectId, entryKind: "output", text: "保留用户确认", path, nextStep: "" });
    if (state === "missing") await vault.delete(store.getFile(path)!);
    if (state === "excluded") store.settings.privacy = { excludedVaultPrefixes: [path] };
    if (state === "unreadable") { const read = store.readPath.bind(store); vi.spyOn(store, "readPath").mockImplementation(value => value === path ? Promise.reject(new Error("synthetic unavailable")) : read(value)); }
    if (state === "catalog_alias") { const get = store.getFile.bind(store); vi.spyOn(store, "getFile").mockImplementation(value => value === path ? Object.assign(get(value)!, { path: "不同目录/不可核验产出.md" }) : get(value)); }
    const result = await captureContextSources(record => store.buildProjectContext("项目", 6, record));
    expect(preparedContextSourcePaths([result], result.text)).toEqual([projectDocumentPath(store)]);
    if (state === "excluded") expect(result.text).not.toContain("保留用户确认"); else expect(result.text).toContain("原文件不可用");
  });
  it("attributes changed artifact verification without claiming to send its raw contents", async () => {
    const { projectId } = await setup(), path = store.path(store.settings.folders.outputs, "已变产出.md"); await vault.seed(path, "第一版");
    await save({ kind: "add_entry", projectId, entryKind: "output", text: "确认摘要", path, nextStep: "" }); await vault.seed(path, "第二版只用于核验");
    const result = await captureContextSources(record => store.buildProjectContext("项目", 6, record));
    expect(result.text).toContain("原文件已变化，须重新核对"); expect(result.text).not.toContain("第二版只用于核验");
    expect(preparedContextSourcePaths([result], result.text)).toContain(path);
    expect(result.blocks.find(block => block.path === path)?.sourceHash).toBe(fileRevision("第二版只用于核验"));
  });
  it("attributes legacy task fields to the actually selected mirror and respects its exclusion", async () => {
    const { projectId } = await setup(); await save({ kind: "create_task", projectId, input: { title: "仅看板恢复的任务" } });
    await vault.delete(store.getFile(store.taskDbPath())!);
    const before = vault.writes.length;
    const result = await captureContextSources(record => store.buildProjectContext("项目", 6, record));
    expect(result.text).toContain("仅看板恢复的任务");
    expect(preparedContextSourcePaths([result], result.text).sort()).toEqual([projectDocumentPath(store), store.taskMirrorPath()].sort());
    store.settings.privacy = { excludedVaultPrefixes: [store.taskMirrorPath()] };
    const excluded = await captureContextSources(record => store.buildProjectContext("项目", 6, record));
    expect(excluded.text).not.toContain("仅看板恢复的任务"); expect(preparedContextSourcePaths([excluded], excluded.text)).toEqual([projectDocumentPath(store)]);
    expect(vault.writes).toHaveLength(before); expect(store.getFile(store.taskDbPath())).toBeNull();
  });
  it("keeps project context and user bytes identical when a diagnostic observer throws", async () => {
    await setup(); const before = await vault.bytes(projectDocumentPath(store)); const expected = await store.buildProjectContext("项目");
    expect(await store.buildProjectContext("项目", 6, () => { throw new Error("diagnostic-only failure"); })).toBe(expected);
    expect(await vault.bytes(projectDocumentPath(store))).toBe(before);
  });
  it("withholds copied result evidence and next steps as well as linked tasks when the actual legacy mirror is excluded", async () => {
    const { projectId } = await setup(); await save({ kind: "create_task", projectId, input: { title: "应隐藏的任务标题" } });
    const task = (await store.getProjectSnapshot()).tasks[0];
    expect((await save({ kind: "record_task_result", projectId, taskId: task.id, expectedTaskRevision: recordRevision(task), entryKind: "review", text: "应隐藏的任务反馈", path: "", nextStep: "应隐藏的派生下一步" })).success).toBe(true);
    await vault.delete(store.getFile(store.taskDbPath())!);
    expect(await store.buildProjectContext("项目")).toContain("应隐藏的任务标题");
    store.settings.privacy = { excludedVaultPrefixes: [store.taskMirrorPath()] };
    const before = await vault.bytes(projectDocumentPath(store));
    const result = await captureContextSources(record => store.buildProjectContext("项目", 6, record));
    for (const text of ["应隐藏的任务标题", "应隐藏的任务反馈", "应隐藏的派生下一步"]) expect(result.text).not.toContain(text);
    expect(result.text).toContain("依据原文已排除"); expect(preparedContextSourcePaths([result], result.text)).toEqual([projectDocumentPath(store)]);
    expect(await vault.bytes(projectDocumentPath(store))).toBe(before);
  });
  it("reads an empty continuity store without creating drafts or migrating old Markdown", async () => {
    const path = store.path(store.settings.folders.goals, "旧目标.md");
    await vault.seed(path, "# 原有目标\n\n逐字保留\n");
    const before = vault.writes.length;
    expect((await store.getProjectSnapshot()).document).toEqual({ version: 1, goals: [], projects: [] });
    expect(vault.writes).toHaveLength(before); expect(await vault.bytes(path)).toBe("# 原有目标\n\n逐字保留\n");
  });
  it("reconstructs work and learning goals, blockers, promises, task IDs, outputs and adjusted next steps after reopening the Store", async () => {
    const { projectId } = await setup();
    const learningGoal = await save({ kind: "save_goal", input: goalInput("虚构：学习概率") });
    const learningProject = await save({ kind: "save_project", input: { ...projectInput(learningGoal.entityId, "虚构：读概率教材"), kind: "learning", state: "suggested" } });
    expect(learningProject.success).toBe(true);
    expect((await save({ kind: "create_task", projectId, input: { title: "虚构：阅读第一篇", date: "2026-10-05" } })).success).toBe(true);
    const path = store.path(store.settings.folders.outputs, "虚构报告.md"); await vault.seed(path, "# 虚构产出\n\n证据一\n");
    expect((await save({ kind: "add_entry", projectId, entryKind: "output", text: "完成第一份摘录", path, nextStep: "" })).success).toBe(true);
    expect((await save({ kind: "add_entry", projectId, entryKind: "review", text: "资料缺少对照组，先补证据", path: "", nextStep: "明天找对照材料" })).success).toBe(true);
    const before = await vault.bytes(projectDocumentPath(store)); reopen();
    const after = await store.getProjectSnapshot(), project = after.document.projects.find(project => project.id === projectId)!;
    expect(after.document.goals).toHaveLength(2); expect(after.document.projects).toHaveLength(2);
    expect(project.nextStep).toBe("明天找对照材料"); expect(project.commitments).toBe("今晚先做一篇"); expect(project.blockers).toBe("还缺一份资料");
    expect(project.taskIds).toEqual([after.tasks[0].id]); expect(project.entries).toHaveLength(2);
    expect(project.state).toBe("started"); expect(after.document.projects.find(project => project.id === learningProject.entityId)!.state).toBe("suggested");
    expect(after.artifacts[project.entries[0].id]).toBe("unchanged"); expect(await vault.bytes(projectDocumentPath(store))).toBe(before);
    const context = await store.buildProjectContext("整理资料的下一步");
    expect(context).toContain("明天找对照材料"); expect(context).toContain("用户确认"); expect(context).toContain("原任务库");
  });
  it("keeps original task authority, and does not infer project completion even when all linked tasks are completed", async () => {
    const { projectId } = await setup();
    await save({ kind: "create_task", projectId, input: { title: "虚构任务" } });
    const taskId = (await store.getProjectSnapshot()).document.projects[0].taskIds[0];
    await runtime.executeLocalOperation("complete", {}, scoped => scoped.completeTask(taskId), "local:complete-test");
    expect((await store.getProjectSnapshot()).document.projects[0].state).toBe("started");
    expect(await store.buildProjectContext()).toContain("已完成（任务库记录）");
    await runtime.executeLocalOperation("delete", {}, scoped => scoped.deleteTask(taskId), "local:delete-test");
    const snapshot = await store.getProjectSnapshot(); expect(snapshot.document.projects[0].taskIds).toContain(taskId);
    expect(await store.buildProjectContext()).toContain("原记录不可用，未推断状态"); expect(snapshot.tasks).toHaveLength(0);
  });
  it("refuses unrecorded writes or receipts belonging to a different operation", async () => {
    const command: ProjectCommand = { kind: "save_goal", input: goalInput() };
    await expect(store.applyProjectCommand(command, "absent", "local:one")).rejects.toThrow("确认");
    await expect(runFactOperation(store, { operationId: "local:actual" }, scope => scope.applyProjectCommand(command, "absent", "local:pretend"), async () => undefined)).rejects.toThrow("不一致");
    expect(store.getFile(projectDocumentPath(store))).toBeNull();
  });
  it("rejects an old form after a newer correction and retains full correction history", async () => {
    const { goalId } = await setup(), old = await store.getProjectSnapshot();
    expect((await save({ kind: "save_goal", id: goalId, input: { ...goalInput(), nextStep: "新的下一步" } })).success).toBe(true);
    const before = await vault.bytes(projectDocumentPath(store));
    const stale = await save({ kind: "save_goal", id: goalId, input: { ...goalInput(), nextStep: "旧的下一步" } }, old.revision);
    expect(stale.success).toBe(false); expect(await vault.bytes(projectDocumentPath(store))).toBe(before);
    const goal = (await store.getProjectSnapshot()).document.goals[0]; expect(goal.changes).toHaveLength(2);
    expect(goal.changes[0].fields.nextStep).toBe("选题"); expect(goal.nextStep).toBe("新的下一步");
  });
  it("detects a concurrent edit at the actual process callback without overwriting it", async () => {
    const { goalId } = await setup(), snapshot = await store.getProjectSnapshot();
    const path = projectDocumentPath(store), external = JSON.stringify({ ...snapshot.document, outsideEdit: "保留这个后来修改" });
    const process = vault.process.bind(vault); let raced = false;
    vi.spyOn(vault, "process").mockImplementation(async (file, update) => {
      if (file.path === path && !raced) { raced = true; vault.beforeProcess = async () => vault.seed(path, external); }
      return process(file, update);
    });
    const result = await save({ kind: "save_goal", id: goalId, input: { ...goalInput(), title: "旧表单" } });
    expect(result.success).toBe(false); expect(await vault.bytes(path)).toBe(external);
  });
  it("preserves compatible extension metadata on the root and records", async () => {
    const { goalId, projectId } = await setup(), snapshot = await store.getProjectSnapshot();
    snapshot.document.extension = { retain: true }; Object.assign(snapshot.document.goals[0], { custom: "保留目标扩展" }); Object.assign(snapshot.document.projects[0], { custom: "保留项目扩展" });
    await vault.seed(projectDocumentPath(store), JSON.stringify(snapshot.document));
    await save({ kind: "save_goal", id: goalId, input: { ...goalInput(), nextStep: "修改后的步骤" } });
    await save({ kind: "save_project", id: projectId, input: { ...projectInput(goalId), blockers: "已解决资料问题" } });
    const document = (await store.getProjectSnapshot()).document;
    expect(document.extension).toEqual({ retain: true }); expect((document.goals[0] as any).custom).toBe("保留目标扩展"); expect((document.projects[0] as any).custom).toBe("保留项目扩展");
  });
  it.each(["version", "schema", "record_schema", "shape", "duplicate", "missing_goal", "receipt", "taskIds"])("blocks unsupported or malformed %s data before replacing it", async kind => {
    await setup(); const path = projectDocumentPath(store), value = JSON.parse(await vault.bytes(path));
    if (kind === "version") value.version = 2;
    if (kind === "schema") value.schemaVersion = 1;
    if (kind === "record_schema") value.projects[0].schemaVersion = 1;
    if (kind === "shape") value.projects = {};
    if (kind === "duplicate") value.goals.push(value.goals[0]);
    if (kind === "missing_goal") value.projects[0].goalId = "missing";
    if (kind === "receipt") value.projects[0].changes[0].receipt.contentHash = "f".repeat(64);
    if (kind === "taskIds") value.projects[0].taskIds = ["unconfirmed-task"];
    const invalid = JSON.stringify(value); await vault.seed(path, invalid);
    expect(validateProjectDocument(value)).toBe(false);
    await expect(store.getProjectSnapshot()).rejects.toThrow("停止");
    const result = await save({ kind: "save_goal", input: goalInput() }, fileRevision(invalid));
    expect(result.success).toBe(false); expect(await vault.bytes(path)).toBe(invalid);
    await expect(store.writeJson(path, { version: 1, goals: [], projects: [] })).rejects.toThrow("停止"); expect(await vault.bytes(path)).toBe(invalid);
  });
  it("does not create another task when a stable operation is replayed after its audit was compacted", async () => {
    const { projectId } = await setup(), revision = (await store.getProjectSnapshot()).revision;
    const command: ProjectCommand = { kind: "create_task", projectId, input: { title: "虚构一次任务" } }, id = "local:stable-task";
    expect((await save(command, revision, id)).success).toBe(true);
    const projectBytes = await vault.bytes(projectDocumentPath(store)), taskBytes = await vault.bytes(store.taskDbPath());
    await vault.seed(store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json"), '{"version":1,"records":[]}');
    expect((await save(command, revision, id)).success).toBe(true);
    expect(await vault.bytes(projectDocumentPath(store))).toBe(projectBytes); expect(await vault.bytes(store.taskDbPath())).toBe(taskBytes);
    await vault.seed(store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json"), '{"version":1,"records":[]}');
    expect((await save({ ...command, input: { title: "冒充同一操作" } }, revision, id)).success).toBe(false);
    expect((await store.getProjectSnapshot()).tasks).toHaveLength(1);
  });
  it("rolls back both the new task and its mirror if the project save later fails", async () => {
    const { projectId } = await setup();
    const original = await vault.bytes(projectDocumentPath(store));
    const create = vault.create.bind(vault); vi.spyOn(vault, "create").mockImplementation(async (path, text) => create(path, text));
    const process = vault.process.bind(vault); vi.spyOn(vault, "process").mockImplementation(async (file, update) => {
      if (file.path === projectDocumentPath(store)) throw new Error("synthetic project save failure"); return process(file, update);
    });
    const result = await save({ kind: "create_task", projectId, input: { title: "不应遗留的任务" } });
    expect(result.success).toBe(false); expect(await vault.bytes(projectDocumentPath(store))).toBe(original);
    expect((await store.readTaskDb({ readOnly: true })).tasks).toHaveLength(0);
  });
  it("uses existing undo, stops stale undo, and never changes an output's original file", async () => {
    const { projectId } = await setup(); const path = store.path(store.settings.folders.outputs, "产出原文.md"); await vault.seed(path, "原文保留\n");
    const first = await save({ kind: "add_entry", projectId, entryKind: "output", text: "实际产出一", path, nextStep: "" });
    expect(await runtime.undoOperation(first.callId)).toBe(true); expect((await store.getProjectSnapshot()).document.projects[0].entries).toHaveLength(0);
    expect(await vault.bytes(path)).toBe("原文保留\n");
    const old = await save({ kind: "add_entry", projectId, entryKind: "output", text: "产出二", path: "", nextStep: "" });
    await save({ kind: "add_entry", projectId, entryKind: "review", text: "更新后回顾", path: "", nextStep: "继续" });
    const before = await vault.bytes(projectDocumentPath(store)); await expect(runtime.undoOperation(old.callId)).rejects.toThrow(); expect(await vault.bytes(projectDocumentPath(store))).toBe(before);
  });
  it("requires a completion/cancellation basis and records the user choice rather than deducing it", async () => {
    const { goalId, projectId } = await setup();
    expect((await save({ kind: "save_project", id: projectId, input: { ...projectInput(goalId), state: "completed", stateNote: "" } })).success).toBe(false);
    expect((await save({ kind: "save_project", id: projectId, input: { ...projectInput(goalId), state: "completed", stateNote: "用户确认报告已交付" } })).success).toBe(true);
    expect((await store.getProjectSnapshot()).document.goals[0].state).toBe("agreed");
    expect((await save({ kind: "create_task", projectId, input: { title: "已结束项目的新任务" } })).success).toBe(false);
    expect((await save({ kind: "save_project", id: projectId, input: { ...projectInput(goalId), state: "cancelled", stateNote: "用户取消" } })).success).toBe(true);
  });
  it("reports changed or missing artifact bytes, without removing past user confirmation", async () => {
    const { projectId } = await setup(), path = store.path(store.settings.folders.outputs, "虚构产出.md"); await vault.seed(path, "第一版");
    await save({ kind: "add_entry", projectId, entryKind: "output", text: "用户确认的产出", path, nextStep: "" });
    await vault.seed(path, "第二版"); expect(await store.buildProjectContext()).toContain("原文件已变化，须重新核对");
    await vault.delete(store.getFile(path)!); expect(await store.buildProjectContext()).toContain("原文件不可用");
    expect((await store.getProjectSnapshot()).document.projects[0].entries[0].text).toBe("用户确认的产出");
  });
  it.each(["unchanged", "changed", "missing", "excluded"])("keeps a buried current next-step source visible as %s without rewriting the confirmed plan", async state => {
    const { projectId } = await setup(), path = store.path(store.settings.folders.outputs, "当前下一步依据.md");
    await vault.seed(path, "确认时的方案");
    await save({ kind: "add_entry", projectId, entryKind: "review", text: "先前确认的回顾", path, nextStep: "按甲方案整理" });
    for (let index = 0; index < 5; index++) await save({ kind: "add_entry", projectId, entryKind: "output", text: `后续产出${index}`, path: "", nextStep: "" });
    const before = await vault.bytes(projectDocumentPath(store));
    if (state === "changed") await vault.seed(path, "现在已经换成乙方案");
    if (state === "missing") await vault.delete(store.getFile(path)!);
    if (state === "excluded") store.settings.privacy = { excludedVaultPrefixes: [path] };
    const writes = vault.writes.length;
    const result = await captureContextSources(record => store.buildProjectContext("整理资料", 1, record));
    expect(result.text).not.toContain("先前确认的回顾");
    if (state === "excluded") {
      expect(result.text).not.toContain("按甲方案整理"); expect(result.text).not.toContain(path);
      expect(result.text).toContain("依据原文已排除");
    } else {
      expect(result.text).toContain("下一步：按甲方案整理"); expect(result.text).toContain(`下一步依据：${path}`);
      expect(result.text).toContain(state === "unchanged" ? "与保存时文件字节一致" : state === "changed" ? "原文件已变化，须重新核对" : "原文件不可用");
      if (state !== "unchanged") expect(result.text).toContain("保留此前确认的安排，不能视为当前已核实的下一步");
    }
    const attributed = preparedContextSourcePaths([result], result.text);
    expect(attributed).toEqual(state === "unchanged" || state === "changed" ? [projectDocumentPath(store), path] : [projectDocumentPath(store)]);
    expect(result.text).not.toContain("现在已经换成乙方案");
    expect(await vault.bytes(projectDocumentPath(store))).toBe(before); expect(vault.writes).toHaveLength(writes);
    reopen(); expect((await store.getProjectSnapshot()).document.projects[0].nextStep).toBe("按甲方案整理");
  });
  it("withholds excluded continuity records before reading their project data", async () => {
    await setup(); store.settings.privacy = { excludedVaultPrefixes: [store.settings.folders.goals] };
    const spy = vi.spyOn(store, "getProjectSnapshot");
    expect(await store.buildProjectContext()).toContain("不提供给 AI"); expect(spy).not.toHaveBeenCalled();
  });
  it("does not expose output text whose source was later excluded", async () => {
    const { projectId } = await setup(), path = store.path(store.settings.folders.outputs, "隐藏产出.md"); await vault.seed(path, "资料");
    await save({ kind: "add_entry", projectId, entryKind: "output", text: "隐藏产出正文", path, nextStep: "" });
    store.settings.privacy = { excludedVaultPrefixes: [path] };
    expect(await store.buildProjectContext()).not.toContain("隐藏产出正文");
  });
  it("also withholds the current next step copied from an excluded review source", async () => {
    const { projectId } = await setup(), path = store.path(store.settings.folders.outputs, "敏感回顾.md"); await vault.seed(path, "私人资料");
    await save({ kind: "add_entry", projectId, entryKind: "review", text: "隐私回顾", path, nextStep: "不能发送的派生下一步" });
    store.settings.privacy = { excludedVaultPrefixes: [path] };
    const context = await store.buildProjectContext(); expect(context).not.toContain("隐私回顾"); expect(context).not.toContain("不能发送的派生下一步"); expect(context).toContain("依据原文已排除");
  });
  it("lets a corrected failed form submit with a new payload ID while same-payload retries retain the ID", async () => {
    const revision = "absent", baseId = "local:same-form";
    const invalid: ProjectCommand = { kind: "save_goal", input: { ...goalInput(), title: "" } };
    const valid: ProjectCommand = { kind: "save_goal", input: goalInput() };
    expect((await save(invalid, revision, projectSubmissionId(baseId, invalid, revision))).success).toBe(false);
    const first = await save(valid, revision, projectSubmissionId(baseId, valid, revision)); expect(first.success).toBe(true);
    expect((await save(valid, revision, projectSubmissionId(baseId, valid, revision))).success).toBe(true);
    expect((await store.getProjectSnapshot()).document.goals).toHaveLength(1);
  });
  it("retains a reversal tombstone when the actual detailed audit window drops the old operation", async () => {
    const command: ProjectCommand = { kind: "save_goal", input: goalInput() }, id = "local:undo-then-compact";
    expect((await save(command, "absent", id)).success).toBe(true); await runtime.undoOperation(id);
    const pendingUndo = JSON.parse(await vault.bytes(factRecoveryPath(store))); pendingUndo.status = "pending";
    await vault.seed(factRecoveryPath(store), JSON.stringify(pendingUndo));
    const baseTime = Date.now() + 10000; let tick = 0;
    const ledger = new OperationLedger(store, () => new Date(baseTime + tick++));
    for (let i = 0; i < 501; i++) await ledger.claim({ operationId: `local:synthetic-audit:${i}`, toolName: "synthetic_only", source: "system", arguments: {} });
    const document = await store.readJson<any>(ledger.filePath, {});
    expect(document.records).toHaveLength(500); expect(document.records.some((item: any) => item.operationId === id)).toBe(false);
    expect(document.revertedOperationHashes).toHaveLength(1);
    expect(await recoverFactOperation(store)).toBe("kept"); expect(await recoverFactOperation(store)).toBe("none");
    const replay = await save(command, "absent", id); expect(replay.success).toBe(false); expect(replay.output).toContain("撤销");
    expect((await store.getProjectSnapshot()).document.goals).toHaveLength(0);
  });
  it("rejects a task association whose selected task changed after the form opened", async () => {
    const { projectId } = await setup(), task = await store.createTask({ title: "最初选中的任务" });
    const revision = (await store.getProjectSnapshot()).revision;
    await store.updateTaskDetails(task.id, { title: "后来改成的不相关任务" });
    const command: ProjectCommand = { kind: "link_task", projectId, taskId: task.id, expectedTaskRevision: recordRevision(task) };
    expect((await save(command, revision)).success).toBe(false);
    expect((await store.getProjectSnapshot()).document.projects[0].taskIds).toEqual([]);
    const current = await store.getTask(task.id);
    expect((await save({ ...command, expectedTaskRevision: recordRevision(current) }, revision)).success).toBe(true);
    expect((await save({ ...command, expectedTaskRevision: undefined })).success).toBe(false);
  });
  it("keeps old output and review contents while correcting their current meaning and next-step lineage", async () => {
    const { projectId, goalId } = await setup();
    await save({ kind: "add_entry", projectId, entryKind: "review", text: "原回顾", path: "", nextStep: "原下一步" });
    const entryId = (await store.getProjectSnapshot()).document.projects[0].entries[0].id;
    await save({ kind: "correct_entry", projectId, entryId, text: "更正后的回顾", path: "", nextStep: "更正后的下一步" });
    let project = (await store.getProjectSnapshot()).document.projects[0];
    expect(project.nextStep).toBe("更正后的下一步"); expect(project.entries[0].revisions[0].text).toBe("原回顾");
    await save({ kind: "save_project", id: projectId, input: { ...projectInput(goalId), nextStep: "后来独立安排的下一步" } });
    await save({ kind: "correct_entry", projectId, entryId, text: "再更正历史回顾", path: "", nextStep: "旧回顾的新说明" });
    project = (await store.getProjectSnapshot()).document.projects[0];
    expect(project.nextStep).toBe("后来独立安排的下一步"); expect(project.entries[0].revisions).toHaveLength(2);
    expect(await store.buildProjectContext()).not.toContain("原回顾\n");
  });
  it.each(["继续上次那件事", "接着做上一项", "上回停在哪", "项目的下一步"])("loads persisted context for natural resumption: %s", message => {
    expect(needsProjectContinuity(message)).toBe(true); expect(needsProjectContinuity(message, "quoted_explanation")).toBe(false);
    expect(needsProjectContinuity(message, "communication_preference")).toBe(false);
  });
  it("blocks malformed reversal tombstones without overwriting the audit or project", async () => {
    await setup(); const path = store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
    const malformed = '{"version":1,"records":[],"revertedOperationHashes":["not-a-hash"]}'; await vault.seed(path, malformed);
    const before = await vault.bytes(projectDocumentPath(store));
    await expect(save({ kind: "save_goal", input: goalInput("不应写入") })).rejects.toThrow("停止");
    expect(await vault.bytes(path)).toBe(malformed); expect(await vault.bytes(projectDocumentPath(store))).toBe(before);
  });
  it("keeps pre-upgrade reverted records blocked and seeds their tombstones on the next ordinary audit write", async () => {
    const command: ProjectCommand = { kind: "save_goal", input: goalInput() }, id = "local:legacy-reverted";
    const result = await save(command, "absent", id); expect(result.success).toBe(true); await runtime.undoOperation(id);
    const ledger = new OperationLedger(store), legacy = JSON.parse(await vault.bytes(ledger.filePath)); delete legacy.revertedOperationHashes;
    await vault.seed(ledger.filePath, JSON.stringify(legacy));
    expect((await save(command, "absent", id)).success).toBe(false); expect((await store.getProjectSnapshot()).document.goals).toHaveLength(0);
    await ledger.claim({ operationId: "local:after-upgrade", toolName: "synthetic_only", source: "system", arguments: {} });
    expect(JSON.parse(await vault.bytes(ledger.filePath)).revertedOperationHashes).toHaveLength(1);
  });
});
