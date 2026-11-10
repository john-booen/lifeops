import { stubAgentModel } from "./helpers/stubAgentModel";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { AgentActionSuggestion } from "../src/types";
import type { GoalInput, ProjectCommand } from "../src/projectContinuity";
import type { StoreHost } from "../src/store/settingsSlice";
import type { ToolExecutionContext } from "../src/toolRegistry";
import { DEFAULT_SETTINGS } from "../src/defaults";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true },
  Notice: class { constructor(message: string) { notices.push(message); } },
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(),
  requestUrl: vi.fn(() => { throw new Error("Network forbidden"); })
}));
const { AgentRuntime } = await import("../src/agentRuntime");
const { OperationLedger } = await import("../src/dataFoundation/operationLedger");
const { LifeOpsStore } = await import("../src/store");
const { default: LifeOpsPlugin } = await import("../src/main");
const { applySuggestionsPanel } = await import("../src/panel/suggestions");
const { getLifeOpsTool, runConfirmedToolAction } = await import("../src/toolRegistry");
const { createPersonalMemory, reviewPersonalMemoryRecord } = await import("../src/personalMemory");
const { DiskVault } = await import("./helpers/diskVault");
const { projectDocumentPath } = await import("../src/dataFoundation/projectPersistence");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
let context: ToolExecutionContext, runtime: InstanceType<typeof AgentRuntime>;
let sourcePath: string;
const firstTitle = "纯虚构项目对话目标甲";
const nextTitle = "纯虚构项目对话目标乙";
function input(title = firstTitle): GoalInput {
  return { title, reason: "纯虚构理由", successCriteria: "纯虚构成功标准", timeBoundary: "", constraints: "", nextStep: "", reviewOn: "", sourcePath: "", state: "agreed", stateNote: "" };
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function proposal(command: ProjectCommand = { kind: "save_goal", input: input() }, id = "synthetic-project-proposal") {
  const result = await runtime.executeAiToolCall({ id, name: "propose_project_change", arguments: { command } }, "kimi", "纯虚构项目建议");
  expect(result.success).toBe(true); expect(result.actions).toHaveLength(1);
  return result.actions[0];
}
async function seedGoal(title = firstTitle) {
  const snapshot = await store.getProjectSnapshot();
  const id = `local:synthetic-seed-${title}`;
  const goal = snapshot.document.goals[0];
  const command: ProjectCommand = { kind: "save_goal", ...(goal ? { id: goal.id } : {}), input: { ...input(title), sourcePath } };
  const result = await runtime.executeLocalOperation("synthetic_project_seed", { command }, scope => scope.applyProjectCommand(command, snapshot.revision, id), id);
  expect(result.success).toBe(true);
}
function query() { return runtime.executeAiToolCall({ id: "synthetic-same-query-id", name: "query_projects", arguments: {} }, "kimi"); }
function panel(action: AgentActionSuggestion) {
  class Panel {}
  applySuggestionsPanel(Panel);
  const host: any = Object.assign(new Panel(), {
    viewClosed: false, agentBusy: false, pendingAgentActions: [action],
    agentMessages: [], appendAgentMessage: vi.fn(), scrollAgentTranscriptToBottom: vi.fn(),
    controller: { executeAgentAction: vi.fn(async () => {}), appendQualityLog: vi.fn(async () => {}) },
    recoverTimedOutAgentBusy: vi.fn(), refreshAgentSurfaceState: vi.fn(), refreshAgentSuggestions: vi.fn(),
    rememberSentVoiceTurn: vi.fn(), clearVoiceTurnBufferAfterSend: vi.fn(), setAgentInput: vi.fn(),
    setAgentBusy: (busy: boolean) => { host.agentBusy = busy; }
  });
  return host;
}
function render(host: any, action: AgentActionSuggestion) {
  const text: string[] = [], fields: Record<string, any[]> = {}, callbacks: Record<string, () => void> = {};
  const element = (): any => ({
    createDiv: (options?: { text?: string }) => { if (options?.text) text.push(options.text); return element(); },
    createSpan: () => element(),
    createEl: (tag: string, options?: unknown) => { const child = element(); child.creationOptions = options; (fields[tag] ??= []).push(child); return child; },
    setAttr: vi.fn()
  });
  host.iconButton = vi.fn((_node: unknown, _icon: string, label: string, callback: () => void) => { callbacks[label] = callback; });
  host.renderAgentSuggestionCard(element(), action);
  return { text, fields, callbacks };
}
function pluginHost() {
  const model = vi.fn(async () => ({ content: "这是普通对话。", toolCalls: [] }));
  return Object.assign(Object.create(LifeOpsPlugin.prototype), {
    store, settings: store.settings, lifeOpsEvents: { publish: vi.fn() },
    updateStatusBar: vi.fn(async () => {}), refreshViews: vi.fn(async () => {}),
    buildSemanticContext: vi.fn(async () => ""),
    ai: { agentReply: model, agentReplyStream: model, delegatedReplyStream: model, agentReplyAfterToolResultsStream: model }
  });
}

beforeEach(async () => {
  notices.length = 0; vi.stubGlobal("window", globalThis);
  root = await mkdtemp(join(tmpdir(), "lifeops-project-confirmation-ui-"));
  vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
  sourcePath = store.path(store.settings.folders.goals, "纯虚构原文.md");
  await vault.seed(sourcePath, "纯虚构目标来源");
  context = { store, refreshViews: vi.fn(async () => {}) };
  runtime = new AgentRuntime(context);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

describe("actual plugin entry for task result final commit", () => {
  it("puts the real saved result in the visible dialogue and session history without marking Tasks or project complete", async () => {
    await seedGoal();
    const propose = async (command: unknown, id: string) => {
      const result = await runtime.executeAiToolCall({ id, name: "propose_project_change", arguments: { command } }, "kimi", "纯虚构结果核对");
      expect(result.success, result.output).toBe(true); return result.actions[0];
    };
    const goalId = (await store.getProjectSnapshot()).document.goals[0].id;
    await runConfirmedToolAction(await propose({ kind: "save_project", input: { title: "纯虚构结果对话", goalId } }, "saved-project"), context);
    const projectId = (await store.getProjectSnapshot()).document.projects[0].id;
    await runConfirmedToolAction(await propose({ kind: "create_task", projectId, input: { title: "纯虚构结果任务" } }, "saved-task"), context);
    const taskId = (await store.getProjectSnapshot()).tasks[0].id;
    const action = await propose({ kind: "record_task_result", projectId, taskId, entryKind: "review", text: "纯虚构反馈", nextStep: "继续核对" }, "saved-result");
    const host = panel(action), plugin = pluginHost(); Object.assign(plugin, { unloaded: false, lifecycleGeneration: 1 });
    host.controller.executeAgentAction = (value: AgentActionSuggestion) => plugin.executeAgentAction(value);
    await host.acceptAgentSuggestion(action);
    const receipt = "任务结果已记录为回顾；原任务和项目阶段保持不变。";
    expect(host.appendAgentMessage).toHaveBeenCalledWith({ role: "assistant", content: receipt });
    expect(host.agentMessages).toContainEqual({ role: "assistant", content: receipt }); expect(host.pendingAgentActions).toEqual([]);
    const snapshot = await store.getProjectSnapshot(); expect(snapshot.tasks[0].status).toBe("active"); expect(snapshot.document.projects[0].state).toBe("suggested");
    expect(snapshot.document.projects[0].entries[0].taskEvidence?.status).toBe("active");
  });
  it("rejects a Task change during audit save, restores only its project result and preserves the external Task change", async () => {
    await seedGoal();
    const propose = async (command: unknown, id: string) => {
      const result = await runtime.executeAiToolCall({ id, name: "propose_project_change", arguments: { command } }, "kimi", "纯虚构结果核对");
      expect(result.success, result.output).toBe(true); return result.actions[0];
    };
    const goalId = (await store.getProjectSnapshot()).document.goals[0].id;
    await runConfirmedToolAction(await propose({ kind: "save_project", input: { title: "纯虚构结果项目", goalId } }, "result-project"), context);
    const projectId = (await store.getProjectSnapshot()).document.projects[0].id;
    await runConfirmedToolAction(await propose({ kind: "create_task", projectId, input: { title: "纯虚构原任务" } }, "result-task"), context);
    const taskId = (await store.getProjectSnapshot()).tasks[0].id;
    const action = await propose({ kind: "record_task_result", projectId, taskId, entryKind: "review", text: "纯虚构反馈", nextStep: "继续核对" }, "result-proposal");
    const before = await vault.bytes(projectDocumentPath(store)), plugin = pluginHost();
    Object.assign(plugin, { unloaded: false, lifecycleGeneration: 1 });
    const verify = OperationLedger.prototype.verify;
    vi.spyOn(OperationLedger.prototype, "verify").mockImplementation(async function(this: InstanceType<typeof OperationLedger>, id, result) {
      const saved = await verify.call(this, id, result);
      if (id === "local:plugin-result-race") {
        const db = JSON.parse(await vault.bytes(store.taskDbPath())); db.tasks[0].title = "提交期间本人改名";
        await vault.seed(store.taskDbPath(), JSON.stringify(db));
      }
      return saved;
    });
    await expect(plugin.saveProjectCommand(action.projectCommand!, action.projectRevision!, "local:plugin-result-race")).rejects.toThrow("任务");
    expect(await vault.bytes(projectDocumentPath(store))).toBe(before); expect((await store.getProjectSnapshot()).tasks[0].title).toBe("提交期间本人改名");
  });
});

describe("project confirmation UI and Runtime wiring", () => {
  it("keeps the complete review read-only and omits unrelated record dates", async () => {
    const action = await proposal(), host = panel(action), rendered = render(host, action);
    expect(rendered.fields.textarea[0].readOnly).toBe(true);
    expect(rendered.fields.textarea[0].creationOptions.attr.rows).toBe("8");
    const displayed = action.content;
    rendered.fields.textarea[0].value = "误改的纯虚构显示内容"; rendered.fields.textarea[0].oninput();
    expect(host.pendingAgentActions[0].content).toBe(displayed);
    expect(rendered.text).toContain("目标与项目变更确认");
    expect(rendered.text.some(text => text.startsWith("写入日期："))).toBe(false);
    expect(rendered.fields.select).toBeUndefined();
  });

  it.each(["确认", "可以", "对"])("does not use voice '%s' to approve a project change", async message => {
    const host = panel(await proposal());
    expect(await host.tryAcceptPendingActionFromVoice(message)).toBe(false);
    expect(host.controller.executeAgentAction).not.toHaveBeenCalled();
    expect((await store.getProjectSnapshot()).document.goals).toEqual([]);
  });

  it("saves only from the current visible click and reports project success", async () => {
    const action = await proposal(), host = panel(action), plugin = pluginHost();
    host.controller.executeAgentAction = (submitted: AgentActionSuggestion) => plugin.executeAgentAction(submitted);
    const rendered = render(host, action);
    expect((await store.getProjectSnapshot()).document.goals).toEqual([]);
    rendered.callbacks["确认"]();
    await vi.waitFor(() => expect(host.agentBusy).toBe(false));
    expect((await store.getProjectSnapshot()).document.goals[0].title).toBe(firstTitle);
    expect(host.pendingAgentActions).toEqual([]);
    expect(notices).toContain("LifeOps 已保存目标与项目变更");
    expect(notices.some(text => text.includes("已删除"))).toBe(false);
  });

  it("retains a project proposal returned during ordinary chat", async () => {
    const plugin = pluginHost();
    const model = vi.fn(async () => ({ content: "这只是一份待确认建议。", toolCalls: [{ id: "synthetic-chat-project-proposal", name: "propose_project_change", arguments: { command: { kind: "save_goal", input: input() } } }] }));
    stubAgentModel(plugin, model);
    const result = await plugin.submitAgentMessageStream("最近有点疲惫，想聊聊天", [], vi.fn(), { source: "text", selfTest: true });
    expect(model).toHaveBeenCalledOnce();
    expect(result.actions).toHaveLength(1); expect(result.actions[0].type).toBe("project_change");
    expect((await store.getProjectSnapshot()).document.goals).toEqual([]);
  });

  it("freezes both audited and executed nested commands before waiting for confirmation claim", async () => {
    const action = await proposal(), original = structuredClone(action), started = deferred(), release = deferred();
    const claim = OperationLedger.prototype.claim;
    vi.spyOn(OperationLedger.prototype, "claim").mockImplementation(async function (this: InstanceType<typeof OperationLedger>, request) {
      const result = await claim.call(this, request);
      if (request.toolName === "confirm_project_change") { started.resolve(); await release.promise; }
      return result;
    });
    const saving = runConfirmedToolAction(action, context);
    await started.promise;
    if (action.projectCommand?.kind === "save_goal") action.projectCommand.input.title = nextTitle;
    action.content = "提交后篡改的纯虚构差异"; action.projectRevision = "later-revision";
    release.resolve(); expect(await saving).toBe(true);
    expect((await store.getProjectSnapshot()).document.goals[0].title).toBe(firstTitle);
    const ledger = await store.readJson<{ records: Array<{ operationId: string; arguments: Record<string, unknown> }> }>(store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json"), { records: [] });
    const argumentsSaved = ledger.records.find(record => record.operationId === `confirmed:${original.id}`)?.arguments;
    expect(argumentsSaved?.projectCommand).toEqual(original.projectCommand);
    expect(argumentsSaved?.projectRevision).toBe(original.projectRevision);
    expect(argumentsSaved?.projectContextRevision).toBe(original.projectContextRevision);
    expect(argumentsSaved?.projectReviewHash).toBe(original.projectReviewHash);
  });

  it("never treats a cached unsuccessful confirmation as a success", async () => {
    const action = await proposal();
    vi.spyOn(OperationLedger.prototype, "claim").mockResolvedValue({ kind: "cached", record: { status: "verified", result: { success: false, output: "纯虚构失败回执", actions: [] } } } as any);
    await expect(runConfirmedToolAction(action, context)).rejects.toThrow("没有成功回执");
    expect((await store.getProjectSnapshot()).document.goals).toEqual([]);
  });

  it("rejects a reused confirmation ID with a freshly bound different project command", async () => {
    const first = await proposal(); await runConfirmedToolAction(first, context);
    const goal = (await store.getProjectSnapshot()).document.goals[0];
    const second = await proposal({ kind: "save_goal", id: goal.id, input: input(nextTitle) });
    expect(second.id).toBe(first.id);
    await expect(runConfirmedToolAction(second, context)).rejects.toThrow("ID 冲突");
    expect((await store.getProjectSnapshot()).document.goals[0].title).toBe(firstTitle);
  });

  it("rolls back if the original Store excludes a source during the guarded save", async () => {
    await seedGoal();
    const snapshot = await store.getProjectSnapshot(), goal = snapshot.document.goals[0];
    const action = await proposal({ kind: "save_goal", id: goal.id, input: { ...input(nextTitle), sourcePath } });
    const projectPath = store.path(store.settings.folders.goals, "LifeOps目标项目.json");
    const hook = async (file: { path: string }) => {
      if (file.path !== projectPath) { vault.beforeProcess = hook; return; }
      store.settings.privacy!.excludedVaultPrefixes.push(sourcePath);
    };
    vault.beforeProcess = hook;
    await expect(runConfirmedToolAction(action, context)).rejects.toThrow();
    expect(store.settings.privacy!.excludedVaultPrefixes).toContain(sourcePath);
    expect((await store.getProjectSnapshot()).document.goals[0].title).toBe(firstTitle);
  });

  it("reads current shared memory bytes during save and preserves the external correction when rolling back", async () => {
    await seedGoal();
    const snapshot = await store.getProjectSnapshot(), goal = snapshot.document.goals[0];
    const action = await proposal({ kind: "save_goal", id: goal.id, input: { ...input(nextTitle), sourcePath } });
    const before = await store.readPersonalMemories(), memory = createPersonalMemory({ kind: "user_rule", content: "纯虚构保存中确认的偏好" });
    const records = reviewPersonalMemoryRecord([...before.records, memory], memory.id, { decision: "confirm", sourceRef: { sourceId: "synthetic-external-memory-change", path: sourcePath, capturedAt: new Date().toISOString() } });
    const projectPath = store.path(store.settings.folders.goals, "LifeOps目标项目.json");
    const hook = async (file: { path: string }) => {
      if (file.path !== projectPath) { vault.beforeProcess = hook; return; }
      await vault.seed(store.personalMemoryPath(), JSON.stringify({ ...before, records }));
    };
    vault.beforeProcess = hook;
    await expect(runConfirmedToolAction(action, context)).rejects.toThrow("保存期间");
    expect((await store.getProjectSnapshot()).document.goals[0].title).toBe(firstTitle);
    expect((await store.readPersonalMemories()).records.find(record => record.id === memory.id)?.status).toBe("active");
  });

  it("keeps durable confirmation receipts after actual 501-claim audit trimming without replaying over a later correction", async () => {
    const action = await proposal(); await runConfirmedToolAction(action, context);
    await seedGoal(nextTitle);
    const before = await store.getProjectSnapshot(), ledger = new OperationLedger(store);
    for (let index = 0; index < 501; index += 1) {
      await ledger.claim({ operationId: `synthetic-project-audit-fill-${index}`, toolName: "synthetic_read_only_filler", source: "system", arguments: { index } });
    }
    const audit = await store.readJson<{ records: Array<{ operationId: string }> }>(ledger.filePath, { records: [] });
    expect(audit.records.some(record => record.operationId === `confirmed:${action.id}`)).toBe(false);
    expect(await runConfirmedToolAction(action, context)).toBe(true);
    const after = await store.getProjectSnapshot();
    expect(after.document).toEqual(before.document);
    expect(after.document.goals[0].title).toBe(nextTitle);
    expect(after.document.goals[0].changes.filter(change => change.receipt.operationId === `confirmed:${action.id}`)).toHaveLength(1);
  });
});

describe("project query cache freshness in the actual Runtime", () => {
  it("refreshes the same provider call ID after project records change", async () => {
    await seedGoal(); expect((await query()).output).toContain(firstTitle);
    await seedGoal(nextTitle);
    const current = await query(); expect(current.success).toBe(true);
    expect(current.output).toContain(nextTitle); expect(current.output).not.toContain(firstTitle);
  });

  it("refreshes the same provider call ID after a source is excluded", async () => {
    await seedGoal(); expect((await query()).output).toContain(firstTitle);
    store.settings.privacy!.excludedVaultPrefixes.push(sourcePath);
    const current = await query(); expect(current.success).toBe(true); expect(current.output).not.toContain(firstTitle);
  });

  it("separates query cache entries across personal memory changes", async () => {
    await seedGoal(); const execute = vi.spyOn(getLifeOpsTool("query_projects")!, "execute");
    expect((await query()).success).toBe(true); expect(execute).toHaveBeenCalledOnce();
    const before = await store.readPersonalMemories();
    const memory = createPersonalMemory({ kind: "user_rule", content: "纯虚构新的已确认偏好" });
    const records = reviewPersonalMemoryRecord([...before.records, memory], memory.id, { decision: "confirm", sourceRef: { sourceId: "local:synthetic-personal-memory-change", path: sourcePath, capturedAt: new Date().toISOString() } });
    const result = await runtime.executeLocalOperation("synthetic_personal_memory_change", { content: memory.content }, scope => scope.writePersonalMemories({ ...before, records }), "local:synthetic-personal-memory-change");
    expect(result.success).toBe(true); expect((await query()).success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("withholds a previously successful cache when current project data cannot be read", async () => {
    await seedGoal(); expect((await query()).output).toContain(firstTitle);
    vi.spyOn(store, "getProjectContextRevision").mockRejectedValue(new Error("Synthetic unreadable project data"));
    const current = await query(); expect(current.success).toBe(false);
    expect(current.output).toContain("停止"); expect(current.output).not.toContain(firstTitle);
  });

  it.each(["changed", "unreadable"] as const)("continues the observed query unless permission changes (%s)", async change => {
    await seedGoal(); expect((await query()).output).toContain(firstTitle);
    const started = deferred(), release = deferred(), claim = OperationLedger.prototype.claim;
    vi.spyOn(OperationLedger.prototype, "claim").mockImplementation(async function (this: InstanceType<typeof OperationLedger>, request) {
      const result = await claim.call(this, request);
      if (request.toolName === "query_projects" && result.kind === "cached") { started.resolve(); await release.promise; }
      return result;
    });
    const pending = query(); await started.promise;
    if (change === "changed") store.settings.privacy!.excludedVaultPrefixes.push(sourcePath);
    else vi.spyOn(store, "getProjectContextRevision").mockRejectedValue(new Error("Synthetic late read failure"));
    release.resolve(); const current = await pending;
    expect(current.success).toBe(change === "unreadable");
    if (change === "unreadable") expect(current.output).toContain(firstTitle);
    else expect(current.output).not.toContain(firstTitle);
  });

  it("withholds a just-read result if a source becomes excluded during the read", async () => {
    await seedGoal(); const started = deferred(), release = deferred(), tool = getLifeOpsTool("query_projects")!, execute = tool.execute;
    vi.spyOn(tool, "execute").mockImplementation(async (...args) => {
      const result = await execute(...args); started.resolve(); await release.promise; return result;
    });
    const pending = query(); await started.promise;
    store.settings.privacy!.excludedVaultPrefixes.push(sourcePath);
    release.resolve(); const current = await pending;
    expect(current.success).toBe(false); expect(current.output).not.toContain(firstTitle);
  });
});
