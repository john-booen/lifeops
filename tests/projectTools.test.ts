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
describe("project tool proposals and confirmed fact writes in a fresh synthetic disk vault", () => {
  it("does not claim or save a model proposal; confirmation persists and reopening preserves exact goal fields", async () => {
    const action = await card({ kind: "save_goal", input: { title: "虚构目标", reason: "虚构原因", constraints: "不超过半小时" } });
    expect(store.getFile(projectDocumentPath(store))).toBeNull(); expect(vault.writes).toHaveLength(0);
    expect(action.content).toContain("建议"); expect(action.content).toContain("不超过半小时"); assertProjectConfirmationPayload(action);
    await confirm(action); const raw = await vault.bytes(projectDocumentPath(store)); reopen();
    expect((await store.getProjectSnapshot()).document.goals[0]).toMatchObject({ title: "虚构目标", reason: "虚构原因", state: "suggested", constraints: "不超过半小时" });
    expect(await vault.bytes(projectDocumentPath(store))).toBe(raw);
  });
  it("patches only specified fields and shows clear values without losing goal constraints or prior history", async () => {
    const { goalId } = await setup();
    const action = await card({ kind: "save_goal", id: goalId, input: { nextStep: "", reason: "更正的虚构理由" } });
    expect(action.content).toContain("找第一份来源 → 未填写"); expect(action.content).toContain("未列字段保持原值");
    await confirm(action); const goal = (await store.getProjectSnapshot()).document.goals[0];
    expect(goal).toMatchObject({ reason: "更正的虚构理由", nextStep: "", constraints: "每晚半小时", successCriteria: "整理两份原文" }); expect(goal.changes).toHaveLength(2);
  });
  it("offers task defaults exactly, retains original quadrants/date and does not mark the project finished", async () => {
    const { projectId } = await setup();
    const action = await card({ kind: "create_task", projectId, input: { title: "虚构任务：核对来源", date: "2026-10-06", quadrant: "important-urgent", dueTime: "14:30" } });
    expect(action.content).toContain("重要且紧急"); expect(action.content).toContain("14:30"); expect(action.content).toContain("优先级：中");
    await confirm(action); const snapshot = await store.getProjectSnapshot();
    expect(snapshot.tasks[0]).toMatchObject({ title: "虚构任务：核对来源", date: "2026-10-06", quadrant: "important-urgent", dueTime: "14:30", priority: "medium", project: "虚构项目：河流材料" });
    expect(snapshot.document.projects[0].taskIds).toEqual([snapshot.tasks[0].id]); expect(snapshot.document.projects[0].state).toBe("suggested");
  });
  it.each([{ date: "2026-02-30" }, { dueTime: "25:99" }, { source: "fabricated-origin" }, { repeatInterval: 0 }, { quadrant: "imagined" }])("rejects unreviewable/invalid task fields %j without writes", async input => {
    const { projectId } = await setup(), raw = await vault.bytes(projectDocumentPath(store)), before = vault.writes.length;
    const result = await propose({ kind: "create_task", projectId, input: { title: "虚构任务", ...input } });
    expect(result.success).toBe(false); expect(result.actions).toEqual([]); expect(await vault.bytes(projectDocumentPath(store))).toBe(raw); expect(vault.writes).toHaveLength(before);
  });
  it("records output, review and review correction; exact previous versions and current next step survive reopening", async () => {
    const { projectId } = await setup(), path = store.path(store.settings.folders.outputs, "虚构证据.md"); await vault.seed(path, "# 虚构原文\n");
    await confirm(await card({ kind: "add_entry", projectId, entryKind: "output", text: "整理第一份摘录", path }));
    await confirm(await card({ kind: "add_entry", projectId, entryKind: "review", text: "还缺对照", nextStep: "补一份对照" }));
    const entryId = (await store.getProjectSnapshot()).document.projects[0].entries[1].id;
    await confirm(await card({ kind: "correct_entry", projectId, entryId, text: "更正：缺两个对照", nextStep: "补两个对照" })); reopen();
    const project = (await store.getProjectSnapshot()).document.projects[0]; expect(project.nextStep).toBe("补两个对照"); expect(project.entries[1].revisions[0]).toMatchObject({ text: "还缺对照", nextStep: "补一份对照" }); expect(project.state).toBe("suggested");
    const result = await runtime.executeAiToolCall({ id: "query-ids", name: "query_projects", arguments: {} }, "kimi");
    expect(result.success).toBe(true); expect(result.output).toContain(projectId); expect(result.output).toContain(entryId); expect(result.output).toContain(path); expect(result.output).toContain("与保存时文件字节一致");
  });
  it("links and unlinks the exact original task while retaining its facts", async () => {
    const { projectId } = await setup();
    await runtime.executeLocalOperation("synthetic-task", {}, scope => scope.createTask({ title: "虚构原任务", note: "完整保留", date: "2026-10-07" }), `local:task-${++serial}`);
    const task = (await store.getProjectSnapshot()).tasks[0];
    await confirm(await card({ kind: "link_task", projectId, taskId: task.id }));
    await confirm(await card({ kind: "link_task", projectId, taskId: task.id, remove: true }));
    const snapshot = await store.getProjectSnapshot(); expect(snapshot.tasks[0]).toEqual(task); expect(snapshot.document.projects[0].taskIds).toEqual([]);
  });
  it.each(["project", "task", "privacy", "new_source", "old_source", "changed_source_again"])("rejects an old card after %s changes and preserves all later facts", async cause => {
    const { goalId, projectId } = await setup(), source = store.path(store.settings.folders.goals, "虚构原目标.md"), path = store.path(store.settings.folders.outputs, "虚构产出.md");
    await vault.seed(source, "虚构原目标一"); await vault.seed(path, "虚构产出一");
    if (cause === "old_source") await confirm(await card({ kind: "save_goal", id: goalId, input: { sourcePath: source } }));
    if (cause === "changed_source_again") { await confirm(await card({ kind: "add_entry", projectId, entryKind: "output", text: "原产出", path })); await vault.seed(path, "虚构产出二"); }
    const action = await card({ kind: "save_goal", id: goalId, input: { nextStep: "旧卡中的下一步", ...(cause === "new_source" ? { sourcePath: source } : {}) } });
    if (cause === "project") await confirm(await card({ kind: "save_goal", id: goalId, input: { reason: "外部的新事实" } }));
    if (cause === "task") await runtime.executeLocalOperation("synthetic-task", {}, scope => scope.createTask({ title: "后来新增的虚构任务" }), `local:new-task-${++serial}`);
    if (cause === "privacy") store.settings.privacy!.excludedVaultPrefixes = [source];
    if (cause === "old_source" || cause === "new_source") await vault.seed(source, "虚构原目标二");
    if (cause === "changed_source_again") await vault.seed(path, "虚构产出三");
    const before = await vault.bytes(projectDocumentPath(store));
    await expect(runConfirmedToolAction(action, context())).rejects.toThrow(/变化|排除/); expect(await vault.bytes(projectDocumentPath(store))).toBe(before);
    expect((await store.getProjectSnapshot()).document.goals[0].nextStep).toBe("找第一份来源");
  });
  it.each(["content", "title", "projectCommand", "projectReviewHash"])("rejects tampering with %s before claiming an operation", async field => {
    const action = await card({ kind: "save_goal", input: { title: "虚构目标" } });
    if (field === "projectCommand") (action.projectCommand as any).input.title = "被暗改的虚构目标"; else (action as any)[field] = "被暗改";
    await expect(runConfirmedToolAction(action, context())).rejects.toThrow("不一致"); expect(vault.writes).toHaveLength(0);
  });
  it("does not expose excluded original goal/project IDs or propose replacement by hidden ID", async () => {
    const { goalId, projectId } = await setup(), source = store.path(store.settings.folders.goals, "虚构私密目标.md"); await vault.seed(source, "虚构私密原文");
    await confirm(await card({ kind: "save_goal", id: goalId, input: { sourcePath: source } })); store.settings.privacy!.excludedVaultPrefixes = [source];
    const result = await runtime.executeAiToolCall({ id: "private-query", name: "query_projects", arguments: {} }, "kimi");
    expect(result.success).toBe(true); expect(result.output).not.toContain(goalId); expect(result.output).not.toContain(projectId); expect(result.output).not.toContain("河流");
    const change = await propose({ kind: "save_project", id: projectId, input: { blockers: "新阻塞" } }); expect(change.success).toBe(false); expect(change.actions).toEqual([]);
  });
  it("retains exact malformed future-version data and supplies no card", async () => {
    const path = projectDocumentPath(store), raw = '{"version":99,"future":"完整保留"}'; await vault.seed(path, raw);
    const result = await propose({ kind: "save_goal", input: { title: "虚构目标" } }); expect(result.success).toBe(false); expect(result.actions).toEqual([]); expect(await vault.bytes(path)).toBe(raw);
  });
  it("reuses durable receipts after detail-cache trimming, then blocks repeat after undo", async () => {
    const action = await card({ kind: "save_goal", input: { title: "虚构可撤销目标" } }); await confirm(action);
    const ledger = new OperationLedger(store), before = await vault.bytes(projectDocumentPath(store));
    for (let i = 0; i < 510; i++) await ledger.claim({ operationId: `synthetic:padding:${i}`, toolName: "synthetic_read", source: "system", arguments: { i } });
    await confirm(action); expect(await vault.bytes(projectDocumentPath(store))).toBe(before); expect((await store.getProjectSnapshot()).document.goals).toHaveLength(1);
    const fresh = await card({ kind: "save_goal", input: { title: "虚构新目标" } }); await confirm(fresh);
    const undo = await runtime.executeAiToolCall({ id: "undo-project", name: "undo_latest_operation", arguments: {} }, "kimi", "请撤销刚才保存的目标"); expect(undo.success, undo.output).toBe(true);
    await expect(runConfirmedToolAction(fresh, context())).rejects.toThrow(/撤销|重复/); expect((await store.getProjectSnapshot()).document.goals).toHaveLength(1);
  });
  it("rolls back its project change if a reviewed source changes while fact persistence runs", async () => {
    const { goalId } = await setup(), source = store.path(store.settings.folders.goals, "虚构竞态来源.md"); await vault.seed(source, "原文一");
    const action = await card({ kind: "save_goal", id: goalId, input: { sourcePath: source, nextStep: "竞态步骤" } }), raw = await vault.bytes(projectDocumentPath(store));
    const original = vault.process.bind(vault); let triggered = false;
    vi.spyOn(vault, "process").mockImplementation(async (file, update) => { if (file.path === projectDocumentPath(store) && !triggered) { triggered = true; await vault.seed(source, "用户后来修改的原文二"); } return original(file, update); });
    await expect(runConfirmedToolAction(action, context())).rejects.toThrow("保存期间"); expect(triggered).toBe(true); expect(await vault.bytes(projectDocumentPath(store))).toBe(raw); expect(await vault.bytes(source)).toBe("用户后来修改的原文二");
  });
  it("denies direct tool execution and does not permit unknown IDs or automatic completion without evidence", async () => {
    const direct = await getLifeOpsTool("propose_project_change")!.execute({ command: { kind: "save_goal", input: { title: "虚构" } } }, context(), { operationId: "test-direct", source: "kimi" }); expect(direct.success).toBe(false); expect(vault.writes).toHaveLength(0);
    for (const command of [{ kind: "save_goal", id: "guessed-id", input: { title: "虚构" } }, { kind: "save_goal", input: { title: "虚构", state: "completed" } }, { kind: "save_goal", input: { title: "虚构", extension: "unknown" } }]) {
      const result = await propose(command); expect(result.success).toBe(false); expect(result.actions).toEqual([]);
    }
  });
});
