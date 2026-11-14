import {executeStoredQuery} from "./storedQueryRead";
import type { LifeOpsToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./toolRegistry";
import type { OperationUndoDescriptor } from "./dataFoundation/operationLedger";
import { createHash } from "node:crypto";
import { isSafeOperationId, recordRevision } from "./operationIdentity";
import { isVaultPathExcluded } from "./privacy";
import { continuityHash, projectEntrySourcePaths, projectTaskEvidence, projectTaskEvidenceLines, GOAL_FIELDS, PROJECT_FIELDS, PROJECT_STATES, PROJECT_STATE_LABELS, projectFileName, safeProjectPath, validGoalInput, validProjectInput,
  type GoalInput, type ProjectInput, type ProjectCommand, type ProjectSnapshot } from "./projectContinuity";
import type { AgentActionSuggestion, LifeOpsTaskInput } from "./types";
import type { StoreHost } from "./store/settingsSlice";
import { normalizeJournalDate, todayString } from "./date";
import { buildTaskFromInput } from "./vaultApi";
import { parseProjectHistorySelection } from "./projectHistorySelection";

const labels: Record<string, string> = { title: "名称", reason: "为什么做", successCriteria: "成功标准", timeBoundary: "时间边界", constraints: "约束",
  nextStep: "下一步", reviewOn: "回顾日期", sourcePath: "原目标来源", state: "状态", stateNote: "状态依据", goalId: "所属目标", kind: "类型",
  nextStepSourcePath: "下一步来源", commitments: "上次承诺", blockers: "阻塞", text: "内容", path: "原文来源", date: "安排日期", endDate: "结束日期",
  time: "安排时间", dueDate: "截止日期", dueTime: "截止时间", priority: "优先级", quadrant: "四象限", category: "分类", repeatUnit: "重复单位",
  repeatInterval: "重复间隔", repeatUntil: "重复截至", note: "备注" };
const taskFields = ["title", "priority", "quadrant", "category", "date", "endDate", "time", "dueDate", "dueTime", "repeatUnit", "repeatInterval", "repeatUntil", "note"] as const;
function inputParameter(field: string): Record<string, unknown> {
  if (field === "repeatInterval") return { type: "number" };
  if (field === "state") return { type: "string", enum: [...PROJECT_STATES], description: "使用枚举中的英文状态，新建建议可省略，不填中文。" };
  if (field === "kind") return { type: "string", enum: ["work", "learning"], description: "work=事业项目，learning=学习项目。" };
  if (field === "goalId") return { type: "string", minLength: 1, description: "查询取得的准确目标ID，逐字保留；不加减空白，不猜测或另建替代目标。" };
  if (field === "title") return { type: "string", description: "名称逐字保留；更正其他字段时省略名称，不自动改名。" };
  if (field === "stateNote") return { type: "string", description: "用户明确提供的状态依据；不把缺少来源路径写成状态原因，也不推断已经开始或完成。" };
  return { type: "string" };
}
const errorResult = (error: unknown): ToolExecutionResult => ({ success: false, output: error instanceof Error ? error.message : "项目核对失败，未保存。", actions: [] });
const projectDocumentPath = (store: StoreHost): string => store.path(store.settings.folders.goals, projectFileName());
const fileRevision = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请提供具体的项目变更内容。");
  return value as Record<string, unknown>;
}
function string(value: unknown, fallback = ""): string { if (value === undefined) return fallback; if (typeof value !== "string") throw new Error("项目内容须为文字。"); return value.trim(); }
function exactRecordId(value: unknown, optional = false): string {
  if (optional && value === undefined) return "";
  if (!isSafeOperationId(value)) throw new Error("记录编号无效，请重新查询并逐字使用准确编号；新建时省略编号，不传空白编号。");
  return value;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("项目变更包含未支持的字段，请重新提出明确变更。");
}
function patch<T>(value: unknown, fields: readonly string[], previous?: T): T {
  const changes = object(value); keys(changes, fields);
  const defaults = Object.fromEntries(fields.map(field => [field, field === "state" ? "suggested" : field === "kind" ? "work" : ""]));
  return Object.fromEntries(fields.map(field => [field, field === "goalId" && changes[field] !== undefined ? exactRecordId(changes[field])
    : string(changes[field], (previous as Record<string, string> | undefined)?.[field] ?? defaults[field])])) as T;
}
function allowedDocument(store: StoreHost): void {
  if (isVaultPathExcluded(projectDocumentPath(store), store.settings.privacy?.excludedVaultPrefixes)) throw new Error("目标与项目已设为不提供给 AI，未生成或保存变更。");
}
function allowedPath(store: StoreHost, path: string, goal = false): void {
  if (!path) return;
  if (isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)) throw new Error("所选记录的依据已排除，未生成或保存变更。");
  if (!safeProjectPath(path) || !store.isManagedSourcePath(path) || !store.getFile(path) || goal && !path.startsWith(`${store.settings.folders.goals}/`)) {
    throw new Error("请选择资料库中可读取的原文笔记；原目标来源须在目标目录内。");
  }
}
function visibleGoal(store: StoreHost, snapshot: ProjectSnapshot, id: string) {
  const goal = snapshot.document.goals.find(goal => goal.id === id);
  if (!goal) throw new Error("未找到对应目标，请先查询当前目标，不能猜测或另建替代记录。");
  allowedPath(store, goal.sourcePath, true); return goal;
}
function visibleProject(store: StoreHost, snapshot: ProjectSnapshot, id: string) {
  const project = snapshot.document.projects.find(project => project.id === id);
  if (!project) throw new Error("未找到对应项目，请先查询当前项目，不能猜测或另建替代记录。");
  visibleGoal(store, snapshot, project.goalId); allowedPath(store, project.nextStepSourcePath);
  const nextStepEntry = project.entries.find(entry => entry.id === project.nextStepEntryId);
  if (nextStepEntry) {
    for (const path of projectEntrySourcePaths(nextStepEntry)) allowedPath(store, path);
    if (nextStepEntry.taskEvidence && isVaultPathExcluded(store.taskDbPath(), store.settings.privacy?.excludedVaultPrefixes)) throw new Error("项目下一步的任务依据已排除，本轮未生成变更卡。");
  }
  return project;
}
/** Host-only plan selection shares the same source/privacy rules as a project confirmation. */
export function projectForTaskPlan(store: StoreHost, snapshot: ProjectSnapshot, id: string) {
  allowedDocument(store);
  if (isVaultPathExcluded(store.taskDbPath(), store.settings.privacy?.excludedVaultPrefixes)) throw new Error("原任务库已排除，未生成项目安排。");
  const project = visibleProject(store, snapshot, id);
  if (project.state === "completed" || project.state === "cancelled") throw new Error("请先明确重新开始项目，再为它安排任务。");
  return structuredClone(project);
}
function taskInput(value: unknown): LifeOpsTaskInput {
  const raw = object(value); keys(raw, taskFields);
  const input = Object.fromEntries(Object.entries(raw).map(([field, value]) => [field, field === "repeatInterval" ? value : string(value)])) as unknown as LifeOpsTaskInput;
  if (!input.title) throw new Error("请填写任务名称。");
  const today = todayString();
  for (const field of ["date", "endDate", "dueDate", "repeatUntil"] as const) if (input[field]) {
    const date = normalizeJournalDate(input[field]!, today);
    if (!date) throw new Error("任务日期无效，请核对。");
    input[field] = date;
  }
  for (const field of ["time", "dueTime"] as const) if (input[field] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input[field]!)) throw new Error("任务时间须为有效的时:分。");
  if (input.priority && !["high", "medium", "low", "none"].includes(input.priority) || input.quadrant && !["important-urgent", "important-not-urgent", "not-important-urgent", "not-important-not-urgent"].includes(input.quadrant)
    || input.repeatUnit && !["none", "day", "week", "month"].includes(input.repeatUnit) || input.repeatInterval !== undefined && (!Number.isSafeInteger(input.repeatInterval) || input.repeatInterval < 1)) throw new Error("请检查任务优先级、四象限和重复设置。");
  const normalized = buildTaskFromInput(input, new Date(), () => "preview");
  return Object.fromEntries(taskFields.map(field => [field, normalized[field]])) as unknown as LifeOpsTaskInput;
}
function normalizeReviewDate(value: string): string {
  const date = normalizeJournalDate(value);
  if (!date) throw new Error("回顾日期无效，请核对。");
  return date;
}

function normalizeCommand(value: unknown, store: StoreHost, snapshot: ProjectSnapshot): ProjectCommand {
  const raw = object(value), kind = string(raw.kind), id = exactRecordId(raw.id, true);
  if (kind === "save_goal") {
    keys(raw, ["kind", "id", "input"]); const previous = id ? visibleGoal(store, snapshot, id) : undefined;
    const input = patch<GoalInput>(raw.input, GOAL_FIELDS, previous);
    if (input.reviewOn) input.reviewOn = normalizeReviewDate(input.reviewOn);
    if (!validGoalInput(input)) throw new Error("请填写目标名称，检查回顾日期；完成或取消须说明依据。");
    allowedPath(store, input.sourcePath, true); return { kind, ...(id ? { id } : {}), input };
  }
  if (kind === "save_project") {
    keys(raw, ["kind", "id", "input"]); const previous = id ? visibleProject(store, snapshot, id) : undefined;
    const input = patch<ProjectInput>(raw.input, PROJECT_FIELDS, previous);
    if (input.reviewOn) input.reviewOn = normalizeReviewDate(input.reviewOn);
    if (!validProjectInput(input)) throw new Error("请填写项目名称并选择已有目标，检查回顾日期；完成或取消须说明依据。");
    visibleGoal(store, snapshot, input.goalId); allowedPath(store, input.nextStepSourcePath); return { kind, ...(id ? { id } : {}), input };
  }
  const projectId = exactRecordId(raw.projectId), project = visibleProject(store, snapshot, projectId);
  if (kind === "create_task") {
    keys(raw, ["kind", "projectId", "input"]);
    if (isVaultPathExcluded(store.taskDbPath(), store.settings.privacy?.excludedVaultPrefixes)) throw new Error("原任务库已排除，未生成项目任务。");
    if (["completed", "cancelled"].includes(project.state)) throw new Error("请先明确重新开始项目，再为它新建任务。");
    return { kind, projectId, input: taskInput(raw.input) };
  }
  if (kind === "link_task") {
    keys(raw, ["kind", "projectId", "taskId", "remove"]);
    if (isVaultPathExcluded(store.taskDbPath(), store.settings.privacy?.excludedVaultPrefixes)) throw new Error("原任务库已排除，未生成关联变更。");
    if (raw.remove !== undefined && typeof raw.remove !== "boolean") throw new Error("请明确关联还是解除关联。");
    const taskId = exactRecordId(raw.taskId), task = snapshot.tasks.find(task => task.id === taskId);
    if (!task) throw new Error("原任务已不存在，未创建替代任务。");
    allowedPath(store, task.sourceNotePath);
    return { kind, projectId, taskId, expectedTaskRevision: recordRevision(task), remove: raw.remove === true };
  }
  if (kind === "record_task_result") {
    keys(raw, ["kind", "projectId", "taskId", "entryKind", "text", "path", "nextStep"]);
    if (isVaultPathExcluded(store.taskDbPath(), store.settings.privacy?.excludedVaultPrefixes)) throw new Error("原任务库已排除，未生成任务结果卡。");
    const taskId = exactRecordId(raw.taskId), task = snapshot.tasks.find(task => task.id === taskId);
    if (!task || !project.taskIds.includes(taskId)) throw new Error("请先读取并关联这个原任务，再记录其结果。");
    allowedPath(store, task.sourceNotePath);
    projectTaskEvidence(task);
    const entryKind = string(raw.entryKind), text = string(raw.text), path = string(raw.path), nextStep = string(raw.nextStep);
    if (entryKind !== "output" && entryKind !== "review" || !text) throw new Error("请明确记录产出或回顾，并填写实际结果。");
    if (entryKind === "output" && nextStep) throw new Error("产出记录不改下一步；请另记回顾。");
    allowedPath(store, path);
    return { kind, projectId, taskId, expectedTaskRevision: recordRevision(task), entryKind, text, path, nextStep };
  }
  if (kind === "add_entry" || kind === "correct_entry") {
    keys(raw, ["kind", "projectId", "entryId", "entryKind", "text", "path", "nextStep"]);
    if (kind === "add_entry" && raw.entryId !== undefined) throw new Error("追加新记录不能带旧记录编号；更正已有记录请先查询并明确更正。");
    const entryId = kind === "correct_entry" ? exactRecordId(raw.entryId) : "", previous = kind === "correct_entry" ? project.entries.find(entry => entry.id === entryId) : undefined;
    if (kind === "correct_entry" && !previous) throw new Error("未找到原产出或回顾，请先读取当前项目。");
    if (previous && raw.entryKind !== undefined && raw.entryKind !== previous.kind) throw new Error("更正不能改变原记录类别，请分别确认产出或回顾。");
    if (previous) {
      for (const path of projectEntrySourcePaths(previous)) allowedPath(store, path);
      if (previous.taskEvidence && isVaultPathExcluded(store.taskDbPath(), store.settings.privacy?.excludedVaultPrefixes)) throw new Error("任务结果依据已排除，本轮未生成更正卡。");
    }
    const entryKind = previous?.kind ?? string(raw.entryKind);
    if (entryKind !== "output" && entryKind !== "review") throw new Error("请明确记录产出还是回顾。");
    const text = string(raw.text), path = string(raw.path, previous?.path), nextStep = string(raw.nextStep, previous?.nextStep);
    if (!text) throw new Error("请填写实际产出或回顾内容。");
    if (entryKind === "output" && nextStep) throw new Error("产出记录不改下一步；请另提回顾或项目变更。");
    allowedPath(store, path);
    return kind === "add_entry" ? { kind, projectId, entryKind, text, path, nextStep } : { kind, projectId, entryId, text, path, nextStep };
  }
  throw new Error("未支持该项目操作，未生成变更。");
}
function display(field: string, value: unknown, snapshot: ProjectSnapshot): string {
  if (field === "state") return PROJECT_STATE_LABELS[value as keyof typeof PROJECT_STATE_LABELS] ?? String(value);
  if (field === "goalId") return snapshot.document.goals.find(goal => goal.id === value)?.title ?? "未找到目标";
  if (field === "kind") return value === "learning" ? "学习" : "事业";
  if (field === "priority") return ({ high: "高", medium: "中", low: "低", none: "无" } as Record<string, string>)[String(value)];
  if (field === "quadrant") return ({ "important-urgent": "重要且紧急", "important-not-urgent": "重要不紧急", "not-important-urgent": "不重要但紧急", "not-important-not-urgent": "不重要不紧急" } as Record<string, string>)[String(value)];
  if (field === "repeatUnit") return ({ none: "不重复", day: "天", week: "周", month: "月" } as Record<string, string>)[String(value)];
  return String(value ?? "") || "未填写";
}
function review(command: ProjectCommand, snapshot: ProjectSnapshot): Pick<AgentActionSuggestion, "title" | "description" | "content"> {
  const lines: string[] = []; let title: string;
  const fields = (values: Record<string, unknown>, names: readonly string[], previous?: Record<string, unknown>) => {
    for (const field of names) {
      if (previous && previous[field] === values[field]) continue;
      lines.push(`${labels[field]}：${previous ? `${display(field, previous[field], snapshot)} → ` : ""}${display(field, values[field], snapshot)}`);
    }
  };
  if (command.kind === "save_goal" || command.kind === "save_project") {
    const isGoal = command.kind === "save_goal", previous = command.id ? (isGoal ? snapshot.document.goals : snapshot.document.projects).find(item => item.id === command.id) : undefined;
    title = `${previous ? "更正" : "建立"}${isGoal ? "目标" : "项目"}：${command.input.title}`;
    fields(command.input as unknown as Record<string, unknown>, isGoal ? GOAL_FIELDS : PROJECT_FIELDS, previous as unknown as Record<string, unknown>);
    if (!lines.length) throw new Error("当前记录与所提内容相同，无需重复保存。");
    if (previous) lines.unshift(`原记录：${previous.title}；未列字段保持原值。`);
  } else {
    const project = snapshot.document.projects.find(project => project.id === command.projectId)!;
    lines.push(`项目：${project.title}`);
    if (command.kind === "create_task") { title = `新建项目任务：${command.input.title}`; fields(command.input as unknown as Record<string, unknown>, taskFields); lines.push("新任务为待办；保留原任务库、四象限和日期视图。"); }
    else if (command.kind === "link_task") {
      const task = snapshot.tasks.find(task => task.id === command.taskId)!;
      title = `${command.remove ? "解除" : "添加"}原任务关联：${task.title}`;
      lines.push(`原任务：${task.title}；${task.status === "completed" ? "已完成" : task.status === "abandoned" ? "已取消" : "待办"}`, "仅修改项目关联，保留原任务内容和状态。");
    } else {
      const previous = command.kind === "correct_entry" ? project.entries.find(entry => entry.id === command.entryId)! : undefined;
      const kind = previous?.kind ?? (command.kind === "add_entry" || command.kind === "record_task_result" ? command.entryKind : "output");
      title = `${previous ? "更正" : "记录"}${kind === "review" ? "回顾" : "产出"}：${project.title}`;
      fields(command as unknown as Record<string, unknown>, ["text", "path", "nextStep"], previous as unknown as Record<string, unknown>);
      if (previous) lines.push("更正保留原版本历史。");
      const evidence = command.kind === "record_task_result"
        ? projectTaskEvidence(snapshot.tasks.find(task => task.id === command.taskId)!) : previous?.taskEvidence;
      if (evidence) {
        lines.push(...projectTaskEvidenceLines(evidence, snapshot.tasks.find(task => task.id === evidence.taskId), project.taskIds.includes(evidence.taskId)));
        if (previous) lines.push("更正保留记录当时的任务依据，不把当前状态替换进旧记录。");
      }
      if (kind === "review") lines.push(!previous || project.nextStepEntryId === previous.id ? "本次回顾同时更新项目下一步。" : "这条旧回顾已非当前下一步依据，本次更正保留项目现有下一步。");
      lines.push("记录产出或回顾，不自动认定项目已完成。");
    }
  }
  return { title, description: "请核对以下具体变更，确认后才保存；资料或依据变化后须重新生成。", content: lines.join("\n\n") };
}
function reviewHash(action: AgentActionSuggestion): string {
  return continuityHash({ title: action.title, description: action.description, content: action.content, command: action.projectCommand, revision: action.projectRevision, contextRevision: action.projectContextRevision });
}
export function assertProjectConfirmationPayload(action: AgentActionSuggestion): void {
  if (action.type !== "project_change" || !action.projectCommand || !action.title || !action.description || !action.content
    || !/^(absent|[a-f0-9]{64})$/.test(action.projectRevision ?? "") || !/^[a-f0-9]{64}$/.test(action.projectContextRevision ?? "")
    || action.projectReviewHash !== reviewHash(action)) throw new Error("项目确认卡与具体变更不一致，请重新生成并核对，未保存。");
}
/** Recheck the card's own basis even if no query put projects in socket history. */
export async function assertProjectConfirmationDeliverable(action:AgentActionSuggestion,context:ToolExecutionContext,
  beforeFinalCheck?:()=>Promise<void>):Promise<void>{
  const submitted=structuredClone(action);assertProjectConfirmationPayload(submitted);
  const store=context.store,policy=recordRevision({folders:store.settings.folders,privacy:store.settings.privacy});
  const changed=()=>{throw Error("项目确认卡的原值、来源或权限已变化，未展示这张旧卡，请重新核对。");};
  const current=()=>{
    context.assertCurrent?.();
    if(recordRevision({folders:store.settings.folders,privacy:store.settings.privacy})!==policy||reviewHash(action)!==submitted.projectReviewHash||action.id!==submitted.id)changed();
    allowedDocument(store);
  };

  current();const snapshot=await store.getProjectSnapshot();current();if(snapshot.revision!==submitted.projectRevision)changed();
  const command=submitted.projectCommand!;

  if(await contextRevision(store,command)!==submitted.projectContextRevision)changed();current();
  await beforeFinalCheck?.();current();
  if(await contextRevision(store,command)!==submitted.projectContextRevision)changed();current();
  const path=projectDocumentPath(store),raw=store.getFile(path)?await store.readPath(path):null;
  if((raw===null?"absent":fileRevision(raw))!==submitted.projectRevision)changed();current();
}
async function memoryState(store: StoreHost) {
  const { readPersonalMemoryWithSources } = await import("./personalMemorySources");
  const { createPersonalMemoryContextFilter, personalMemoryContextRevision } = await import("./personalMemoryContext");
  const document = await readPersonalMemoryWithSources(store);
  return { revision: personalMemoryContextRevision(document.records), filter: createPersonalMemoryContextFilter(document.records) };
}
async function contextRevision(store: StoreHost, command?: ProjectCommand): Promise<string> {
  allowedDocument(store); const memory = await memoryState(store);
  const extraPath = command?.kind === "save_goal" ? command.input.sourcePath : command?.kind === "save_project" ? command.input.nextStepSourcePath : command && "path" in command ? command.path : "";
  const extraSource = extraPath ? [extraPath, store.getFile(extraPath) ? fileRevision(await store.readPath(extraPath)) : "absent"] : [];
  return continuityHash({ projects: await store.getProjectContextRevision(), memory: memory.revision, extraSource });
}
async function sourcesState(store: StoreHost, snapshot: ProjectSnapshot, command: ProjectCommand): Promise<string> {
  const paths = new Set([...snapshot.document.goals.map(goal => goal.sourcePath), ...snapshot.document.projects.flatMap(project => [project.nextStepSourcePath, ...project.entries.flatMap(projectEntrySourcePaths)]),
    ...snapshot.tasks.map(task => task.sourceNotePath), ...(command.kind === "save_goal" ? [command.input.sourcePath] : command.kind === "save_project" ? [command.input.nextStepSourcePath] : "path" in command ? [command.path] : [])].filter(Boolean));
  const excluded = store.settings.privacy?.excludedVaultPrefixes ?? [];
  const bytes = await Promise.all([...paths].sort().filter(path => !isVaultPathExcluded(path, excluded)).map(async path => [path, store.getFile(path) ? fileRevision(await store.readPath(path)) : "absent"]));
  return continuityHash({ bytes, excluded, memory: (await memoryState(store)).revision });
}
function recorded(snapshot: ProjectSnapshot, operationId: string, command: ProjectCommand): boolean {
  const receipts = [...snapshot.document.goals, ...snapshot.document.projects].flatMap(record => [...record.changes.map(change => change.receipt), ...("entries" in record ? record.entries.flatMap(entry => [entry.receipt, ...entry.revisions.map(revision => revision.receipt)]) : [])]).filter(receipt => receipt.operationId === operationId);
  if (receipts.some(receipt => receipt.commandHash !== continuityHash(command))) throw new Error("项目操作标识冲突，未重复保存。");
  return receipts.length > 0;
}
/** Live host reads at the final Fact/WAL boundary; no own project write is part of this baseline. */
export type ProjectTaskResultGuard = (() => Promise<void>) & { assertPolicy: () => void };
export async function prepareProjectTaskResultGuard(store: StoreHost, command: ProjectCommand, operationId: string): Promise<ProjectTaskResultGuard | undefined> {
  if (command.kind !== "record_task_result") return;
  const policy = recordRevision({ folders: store.settings.folders, privacy: store.settings.privacy });
  const snapshot = await store.getProjectSnapshot();
  if (recorded(snapshot, operationId, command)) return;
  const task = snapshot.tasks.find(item => item.id === command.taskId);
  if (!task || recordRevision(task) !== command.expectedTaskRevision) throw new Error("原任务已变化，请重新核对任务结果。");
  if (isVaultPathExcluded(store.taskDbPath(), store.settings.privacy?.excludedVaultPrefixes)
    || task.sourceNotePath && isVaultPathExcluded(task.sourceNotePath, store.settings.privacy?.excludedVaultPrefixes)) throw new Error("任务结果依据已排除，未保存。");
  const paths = [store.taskDbPath(), store.taskMirrorPath()];
  const readPair = () => Promise.all(paths.map(async path => store.getFile(path) ? fileRevision(await store.readPath(path)) : "absent"));
  const baselinePair = await readPair();
  const sources = await sourcesState(store, snapshot, command);
  const changed = () => { throw new Error("保存期间任务、来源、隐私或记忆依据变化，已停止本次结果记录；请重新核对。"); };
  const assertPolicy = () => { if (recordRevision({ folders: store.settings.folders, privacy: store.settings.privacy }) !== policy) changed(); };
  const guard = Object.assign(async () => {
    assertPolicy();
    const firstPair = await readPair(), currentSources = await sourcesState(store, snapshot, command), lastPair = await readPair();
    // Recheck after every awaited source/memory read, including the last WAL boundary.
    assertPolicy();
    if (JSON.stringify(firstPair) !== JSON.stringify(baselinePair) || JSON.stringify(lastPair) !== JSON.stringify(baselinePair) || currentSources !== sources) changed();
  }, { assertPolicy });
  await guard();
  return guard;
}
export async function executeConfirmedProjectChange(action: AgentActionSuggestion, context: ToolExecutionContext): Promise<{ output: string; undo?: OperationUndoDescriptor }> {
  assertProjectConfirmationPayload(action); const store = context.store; allowedDocument(store);
  const snapshot = await store.getProjectSnapshot(), command = action.projectCommand!, operationId = `confirmed:${action.id}`;
  // Durable receipts remain authoritative after the bounded audit cache is trimmed.
  const replay = recorded(snapshot, operationId, command);
  if (!replay) {
    if (await contextRevision(store, command) !== action.projectContextRevision) throw new Error("项目、任务或依据已变化，请读取最新记录并重新确认；未保存这张旧卡。");
    // Revalidate targets, without normalizing the already reviewed command again.
    if (command.kind === "save_goal") { if (command.id) visibleGoal(store, snapshot, command.id); allowedPath(store, command.input.sourcePath, true); }
    else if (command.kind === "save_project") { if (command.id) visibleProject(store, snapshot, command.id); visibleGoal(store, snapshot, command.input.goalId); allowedPath(store, command.input.nextStepSourcePath); }
    else { visibleProject(store, snapshot, command.projectId); if ("path" in command) allowedPath(store, command.path); }
  }
  const sources = await sourcesState(store, snapshot, command);
  await store.applyProjectCommand(command, action.projectRevision!, operationId);
  if (!replay && await sourcesState(store, snapshot, command) !== sources) throw new Error("保存期间原文、隐私或记忆依据发生变化，已停止并恢复本次变更；请重新核对。");
  return { output: replay ? "这项项目变更已保存过，本次未重复写入。" : "已保存这项目标或项目变更，并完成读回核对。" };
}
export const PROJECT_TOOLS: LifeOpsToolDefinition[] = [
  { name: "query_projects", description: "只读查项目和准确ID。历史按projectId分页，后页沿用historyRevision；正文用entryId/entryField/textOffset续读，文件用query_vault。", safety: "safe",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, projectId: { type: "string" }, entryOffset: { type: "number", minimum: 0 }, entryLimit: { type: "number", minimum: 1, maximum: 10 }, entryId: { type: "string" }, entryField: { type: "string", enum: ["text", "nextStep"] }, textOffset: { type: "number", minimum: 0 }, maxChars: { type: "number", minimum: 500, maximum: 18000 }, historyRevision: { type: "string", description: "上一页返回的保存历史版本；非零位置必填。" } } },
    execute: async (args, context) => { try {
      return await executeStoredQuery("query_projects",args,context);
    } catch (error) { return errorResult(error); } } },
  { name: "propose_project_change", description: "提出目标/项目变更确认卡，点击后保存。先查询准确ID；省略字段保留原值。状态不推断，完成/取消须stateNote。关联任务结果用propose_project_task_result。",
    safety: "ui-confirm", parameters: { type: "object", properties: { command: { type: "object", properties: { kind: { type: "string", enum: ["save_goal", "save_project", "create_task", "link_task", "add_entry", "correct_entry"] }, id: { type: "string", minLength: 1, description: "已有目标或项目的准确ID；新建时省略，不传空字符串或空白，不改写编号。" }, projectId: { type: "string", minLength: 1, description: "查询取得的准确项目ID，逐字保留。" }, input: { type: "object", properties: Object.fromEntries([...new Set([...GOAL_FIELDS, ...PROJECT_FIELDS, ...taskFields])].map(field => [field, inputParameter(field)])) }, taskId: { type: "string" }, remove: { type: "boolean" }, entryId: { type: "string", minLength: 1, description: "仅correct_entry用所选项目的记录ID；add_entry省略。" }, entryKind: { type: "string", enum: ["output", "review"] }, text: { type: "string" }, path: { type: "string" }, nextStep: { type: "string" } }, required: ["kind"] } }, required: ["command"] },
    execute: async () => errorResult(new Error("项目变更须先展示具体确认卡，用户确认后才保存。")),
    prepareConfirmation: async (args, context, request) => { try {
      const store = context.store, before = await contextRevision(store), snapshot = await store.getProjectSnapshot();
      const command = normalizeCommand(args.command, store, snapshot), preview = review(command, snapshot), memory = await memoryState(store);
      const protectedText = [preview.title, preview.content, ...("input" in command ? Object.values(command.input).filter(value => typeof value === "string") : [])].join("\n\n");
      if (memory.filter(protectedText) !== protectedText) throw new Error("这项变更包含已更正、遗忘或暂不可用的依据，请重新提出当前可确认内容。");
      const reviewedContext = await contextRevision(store, command);
      if (await contextRevision(store) !== before) throw new Error("生成卡片期间记录变化，请重新读取后提出变更。");
      if (await contextRevision(store, command) !== reviewedContext) throw new Error("生成卡片期间原文变化，请重新读取后提出变更。");
      const action: AgentActionSuggestion = { id: `project-proposal:${continuityHash(request.operationId).slice(0, 24)}`, type: "project_change", ...preview, date: todayString(), projectCommand: structuredClone(command), projectRevision: snapshot.revision, projectContextRevision: reviewedContext };
      action.projectReviewHash = reviewHash(action);
      return { success: true, output: "已生成具体项目变更卡；尚未保存，请用户核对并确认。", actions: [action] };
    } catch (error) { return errorResult(error); } } },
  { name: "propose_project_task_result", description: "为已关联任务提出产出/回顾确认卡。先查询projectId/taskId。output不改下一步；review须nextStep。正文原样保留，不推断项目完成。",
    safety: "ui-confirm", parameters: { type: "object", additionalProperties: false, properties: {
      projectId: { type: "string", description: "query_projects返回的精确项目ID，不能省略或猜测。" },
      taskId: { type: "string", description: "该项目已关联的精确原任务ID。" },
      entryKind: { type: "string", enum: ["output", "review"], description: "output=产出，review=回顾。" },
      text: { type: "string", description: "实际结果/回顾原文，逐字保留正文及标点，不补写字段外内容。" },
      path: { type: "string", description: "已有结果原文笔记路径，可省略。" },
      nextStep: { type: "string", description: "仅回顾提供下一步；逐字保留正文及标点，不添加字段外标点。" }
    }, required: ["projectId", "taskId", "entryKind", "text"] },
    execute: async () => errorResult(new Error("任务结果须先核对完整确认卡，再点击记录。")),
    prepareConfirmation: async (args, context, request) => { try {
      keys(args, ["projectId", "taskId", "entryKind", "text", "path", "nextStep"]);
      return PROJECT_TOOLS.find(tool => tool.name === "propose_project_change")!.prepareConfirmation!({ command: { kind: "record_task_result", ...args } }, context, request);
    } catch (error) { return errorResult(error); } } }
];

export async function queryProjectsText(store:StoreHost,args:Record<string,unknown>,record?:import("./sourceReferences").ContextSourceRecorder):Promise<string>{
  const history=parseProjectHistorySelection(args);
  const query=string(args.query),limit=typeof args.limit==="number"&&Number.isFinite(args.limit)?Math.max(1,Math.min(30,Math.floor(args.limit))):6;
  return store.buildProjectContext(query,limit,record,history);
}
