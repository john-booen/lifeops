import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import { projectDocumentPath } from "../src/dataFoundation/projectPersistence";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { AgentRuntime } = await import("../src/agentRuntime");
const { runConfirmedToolAction } = await import("../src/toolRegistry");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>, goalId: string, projectId: string, taskId: string, entryId: string, serial = 0;
const context = () => ({ store, refreshViews: async () => {} });
const propose = (command: unknown) => runtime.executeAiToolCall({ id: `identity-${++serial}`, name: "propose_project_change", arguments: { command } }, "kimi");
async function confirm(command: unknown) {
  const result = await propose(command); expect(result.success, result.output).toBe(true);
  expect(await runConfirmedToolAction(result.actions[0], context())).toBe(true); return result.actions[0];
}
function reopen() { store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; runtime = new AgentRuntime(context()); }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-project-identity-")); vault = new DiskVault(root); reopen();
  await confirm({ kind: "save_goal", input: { title: "纯虚构原目标", constraints: "保留原约束" } }); goalId = (await store.getProjectSnapshot()).document.goals[0].id;
  await confirm({ kind: "save_project", input: { title: "纯虚构原项目", goalId, commitments: "保留原承诺" } }); projectId = (await store.getProjectSnapshot()).document.projects[0].id;
  await confirm({ kind: "create_task", projectId, input: { title: "纯虚构原任务" } }); taskId = (await store.getProjectSnapshot()).tasks[0].id;
  await confirm({ kind: "add_entry", projectId, entryKind: "review", text: "纯虚构原回顾", nextStep: "补原对照" }); entryId = (await store.getProjectSnapshot()).document.projects[0].entries[0].id;
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function assertRefused(command: unknown) {
  const paths = [projectDocumentPath(store), store.taskDbPath(), store.taskMirrorPath()], before = await Promise.all(paths.map(path => vault.bytes(path)));
  const result = await propose(command); expect(result.success, result.output).toBe(false); expect(result.actions).toEqual([]);
  expect(await Promise.all(paths.map(path => vault.bytes(path)))).toEqual(before);
}
describe("project mutation IDs retain exact identity and explicit create/correct intent", () => {
  it.each(["", " ", "\t", "\n"])("does not turn a supplied blank goal ID %j into a new goal", async id => {
    await assertRefused({ kind: "save_goal", id, input: { title: "纯虚构本应更正的目标" } });
  });
  it.each(["", " ", "\t"])("does not turn a supplied blank project ID %j into a new project", async id => {
    await assertRefused({ kind: "save_project", id, input: { title: "纯虚构本应更正的项目", goalId } });
  });
  it.each(["goal", "project", "parent_goal", "add_project", "linked_task", "task_result", "entry"])("does not normalize a padded %s ID into an existing mutation target", async field => {
    const padded = (id: string) => ` \t${id}\n`;
    const command = field === "goal" ? { kind: "save_goal", id: padded(goalId), input: { reason: "不能改原目标" } }
      : field === "project" ? { kind: "save_project", id: padded(projectId), input: { blockers: "不能改原项目" } }
      : field === "parent_goal" ? { kind: "save_project", id: projectId, input: { goalId: padded(goalId), blockers: "不能归到猜测目标" } }
      : field === "add_project" ? { kind: "add_entry", projectId: padded(projectId), entryKind: "output", text: "不能追加到原项目" }
      : field === "linked_task" ? { kind: "link_task", projectId, taskId: padded(taskId), remove: true }
      : field === "task_result" ? { kind: "record_task_result", projectId, taskId: padded(taskId), entryKind: "output", text: "不能代录原任务结果" }
      : { kind: "correct_entry", projectId, entryId: padded(entryId), text: "不能更正原回顾" };
    await assertRefused(command);
  });
  it.each(["goal", "project", "task", "entry"])("refuses an exact but missing %s ID without a replacement", async field => {
    const command = field === "goal" ? { kind: "save_goal", id: "missing-goal", input: { title: "不替代目标" } }
      : field === "project" ? { kind: "save_project", id: "missing-project", input: { title: "不替代项目", goalId } }
      : field === "task" ? { kind: "link_task", projectId, taskId: "missing-task" }
      : { kind: "correct_entry", projectId, entryId: "missing-entry", text: "不替代回顾" };
    await assertRefused(command);
  });
  it.each(["projectId", "taskId"])("rejects padded %s through the actual task-result wrapper without writes", async field => {
    const before = await vault.bytes(projectDocumentPath(store));
    const result = await runtime.executeAiToolCall({ id: `identity-wrapper-${++serial}`, name: "propose_project_task_result", arguments: {
      projectId, taskId, [field]: ` ${field === "projectId" ? projectId : taskId} `, entryKind: "output", text: "不能归到去掉空白的原对象"
    } }, "kimi");
    expect(result.success, result.output).toBe(false); expect(result.actions).toEqual([]); expect(await vault.bytes(projectDocumentPath(store))).toBe(before);
  });
  it("rejects an exact entry from another project without substituting or copying it", async () => {
    await confirm({ kind: "save_project", input: { title: "纯虚构另一项目", goalId } });
    const other = (await store.getProjectSnapshot()).document.projects.find(project => project.id !== projectId)!;
    await confirm({ kind: "add_entry", projectId: other.id, entryKind: "review", text: "纯虚构另一项目的原回顾" });
    const otherEntry = (await store.getProjectSnapshot()).document.projects.find(project => project.id === other.id)!.entries[0].id;
    await assertRefused({ kind: "correct_entry", projectId, entryId: otherEntry, text: "不能更正另一项目的记录" });
  });
  it.each([null, 9, {}, [], true])("rejects an invalid optional target ID %j", async id => {
    await assertRefused({ kind: "save_goal", id, input: { title: "纯虚构无效对象" } });
  });
  it.each(["", " ", "unknown-entry"])("does not silently discard entryId %j when adding a new record", async id => {
    await assertRefused({ kind: "add_entry", projectId, entryId: id, entryKind: "review", text: "不能暗中追加", nextStep: "不能暗改下一步" });
  });
  it("refuses an existing entry ID on an add command and contradictory entry kind on correction", async () => {
    await assertRefused({ kind: "add_entry", projectId, entryId, entryKind: "review", text: "本应更正原记录", nextStep: "不能重复回顾" });
    await assertRefused({ kind: "correct_entry", projectId, entryId, entryKind: "output", text: "不能悄悄忽略类别" });
  });
  it.each(["save_goal", "save_project"])("keeps explicit %s creation without an ID or with the native undefined optional field", async kind => {
    for (const includeUndefined of [false, true]) {
      const input = kind === "save_goal" ? { title: `纯虚构新目标${includeUndefined}` } : { title: `纯虚构新项目${includeUndefined}`, goalId };
      await confirm({ kind, ...(includeUndefined ? { id: undefined } : {}), input });
    }
    const snapshot = await store.getProjectSnapshot(); expect(kind === "save_goal" ? snapshot.document.goals.length : snapshot.document.projects.length).toBe(3);
  });
  it("changes an exact existing goal and project while preserving history and other fields after reopening", async () => {
    await confirm({ kind: "save_goal", id: goalId, input: { reason: "明确的新理由" } });
    await confirm({ kind: "save_project", id: projectId, input: { blockers: "明确的新阻塞" } }); reopen();
    const snapshot = await store.getProjectSnapshot(); expect(snapshot.document.goals).toHaveLength(1); expect(snapshot.document.projects).toHaveLength(1);
    expect(snapshot.document.goals[0]).toMatchObject({ id: goalId, reason: "明确的新理由", constraints: "保留原约束" });
    expect(snapshot.document.projects[0]).toMatchObject({ id: projectId, blockers: "明确的新阻塞", commitments: "保留原承诺", taskIds: [taskId] });
    expect(snapshot.document.projects[0].entries[0]).toMatchObject({ id: entryId, text: "纯虚构原回顾" });
  });
  it("corrects the exact entry with its matching kind, retaining prior version and undo", async () => {
    const raw = await vault.bytes(projectDocumentPath(store));
    const action = await confirm({ kind: "correct_entry", projectId, entryId, entryKind: "review", text: "明确更正原回顾" }); reopen();
    const entry = (await store.getProjectSnapshot()).document.projects[0].entries[0];
    expect(entry).toMatchObject({ id: entryId, text: "明确更正原回顾", kind: "review" }); expect(entry.revisions[0].text).toBe("纯虚构原回顾");
    const undo = await runtime.executeAiToolCall({ id: `identity-undo-${++serial}`, name: "undo_latest_operation", arguments: {} }, "kimi", "请撤销刚才的回顾更正");
    expect(undo.success, undo.output).toBe(true); expect(await vault.bytes(projectDocumentPath(store))).toBe(raw);
    await expect(runConfirmedToolAction(action, context())).rejects.toThrow(/撤销|重复/);
  });
});
