import { assertRecordRevision, assertSafeOperationId } from "../operationIdentity";
import { fileRevision, guardedOperationIdentity, isGuardedOperationScope } from "../dataFoundation/factOperation";
import { isVaultPathExcluded } from "../privacy";
import { persistProjectDocument, projectConflict, projectDocumentPath, projectDocumentRevision, projectReadSnapshot, readProjectDocument } from "../dataFoundation/projectPersistence";
import {
  continuityHash, projectEntryFields, projectEntrySourcePaths, projectTaskEvidence, projectTaskEvidenceLines, GOAL_FIELDS, PROJECT_FIELDS, PROJECT_SNAPSHOT_FIELDS, PROJECT_STATE_LABELS, safeProjectPath, validGoalInput, validProjectInput,
  type ContinuityChange, type ContinuityReceipt, type ProjectCommand, type ProjectDocument, type ProjectSnapshot
} from "../projectContinuity";
import type { StoreHost } from "./settingsSlice";
import { isContextSourcePath, recordContextSource, type ContextSourceRecorder } from "../sourceReferences";
import { taskReadSnapshot } from "../dataFoundation/taskPersistence";
import { parseProjectHistorySelection, type ProjectHistorySelection } from "../projectHistorySelection";
import { createPersonalMemoryContextFilter, MEMORY_CONTEXT_OMISSION } from "../personalMemoryContext";
import { readPersonalMemoryWithSources } from "../personalMemorySources";

export interface ProjectSliceApi {
  getProjectSnapshot(): Promise<ProjectSnapshot>;
  getProjectContextRevision(): Promise<string>;
  applyProjectCommand(command: ProjectCommand, expectedRevision: string, operationId: string): Promise<string>;
  buildProjectContext(query?: string, limit?: number, record?: ContextSourceRecorder, history?: ProjectHistorySelection): Promise<string>;
}
type ReadSource = { path: string; sourceHash?: string };
// Private, ephemeral reader provenance. Public snapshots/JSON keep their old shape.
// Diagnostic sources never enter the project's action/revision dependencies.
const snapshotSources = new WeakMap<ProjectSnapshot, { document?: ReadSource; tasks?: ReadSource; artifacts: Map<string, ReadSource>; nextSteps: Map<string, ReadSource> }>();
function fields(record: Record<string, any>, names: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(names.map(name => [name, record[name]]));
}
function requireSource(store: StoreHost, path: string, goal = false): void {
  if (!safeProjectPath(path) || !store.isManagedSourcePath(path) || !store.getFile(path)
    || goal && !path.startsWith(`${store.settings.folders.goals}/`)) throw new Error("请选择资料库中可读取的原文笔记；目标来源须在现有目标目录内。");
}
function receipts(document: ProjectDocument): Array<{ id: string; receipt: ContinuityReceipt }> {
  return [...document.goals, ...document.projects].flatMap(record => [
    ...record.changes.map(change => ({ id: record.id, receipt: change.receipt })),
    ...("entries" in record ? record.entries.flatMap(entry => [entry.receipt, ...entry.revisions.map(revision => revision.receipt)].map(receipt => ({ id: record.id, receipt }))) : [])
  ]);
}
const projectSlice: ProjectSliceApi = {
  async getProjectContextRevision(this: StoreHost): Promise<string> {
    const excluded = this.settings.privacy?.excludedVaultPrefixes ?? [];
    if (isVaultPathExcluded(projectDocumentPath(this), excluded)) return continuityHash({ excluded, available: false });
    const snapshot = await this.getProjectSnapshot();
    const paths = new Set([...snapshot.document.goals.map(goal => goal.sourcePath),
      ...snapshot.document.projects.flatMap(project => [project.nextStepSourcePath, ...project.entries.flatMap(projectEntrySourcePaths)]),
      ...snapshot.tasks.map(task => task.sourceNotePath)].filter(Boolean));
    const sources = await Promise.all([...paths].sort().filter(path => !isVaultPathExcluded(path, excluded)).map(async path => {
      try { return [path, this.isManagedSourcePath(path) && this.getFile(path) ? fileRevision(await this.readPath(path)) : "unavailable"]; }
      catch { return [path, "unavailable"]; }
    }));
    return continuityHash({ revision: snapshot.revision, tasks: snapshot.tasks, artifacts: snapshot.artifacts, sources, excluded });
  },
  async getProjectSnapshot(this: StoreHost): Promise<ProjectSnapshot> {
    const document = await readProjectDocument(this);
    const taskDb = await this.readTaskDb({ readOnly: true });
    const tasks = taskDb.tasks;
    const artifacts: ProjectSnapshot["artifacts"] = {};
    const artifactSources = new Map<string, ReadSource>();
    const nextStepSources = new Map<string, ReadSource>();
    for (const project of document.projects) for (const entry of project.entries) {
      if (!entry.path) continue;
      try {
        const file = isContextSourcePath(entry.path) && !isVaultPathExcluded(entry.path, this.settings.privacy?.excludedVaultPrefixes) && this.isManagedSourcePath(entry.path) ? this.getFile(entry.path) : null;
        if (file?.path === entry.path) {
          const sourceHash = fileRevision(await this.readPath(entry.path));
          artifacts[entry.id] = sourceHash === entry.artifactHash ? "unchanged" : "changed";
          artifactSources.set(entry.id, { path: entry.path, sourceHash });
        } else artifacts[entry.id] = "unavailable";
      } catch { artifacts[entry.id] = "unavailable"; }
    }
    for (const project of document.projects) {
      const path = project.nextStepSourcePath;
      if (project.nextStepEntryId || !path || isVaultPathExcluded(path, this.settings.privacy?.excludedVaultPrefixes)) continue;
      const goal = document.goals.find(goal => goal.id === project.goalId);
      if (goal?.sourcePath && isVaultPathExcluded(goal.sourcePath, this.settings.privacy?.excludedVaultPrefixes)) continue;
      try {
        const file = isContextSourcePath(path) && this.isManagedSourcePath(path) ? this.getFile(path) : null;
        if (file?.path === path) nextStepSources.set(project.id, { path, sourceHash: fileRevision(await this.readPath(path)) });
      } catch { /* No historical version exists; failed current reads cannot grant provenance. */ }
    }
    const { [projectReadSnapshot]: _snapshot, ...publicDocument } = document;
    const snapshot = { revision: projectDocumentRevision(document), document: publicDocument, tasks, artifacts };
    const taskRead = taskDb[taskReadSnapshot];
    snapshotSources.set(snapshot, {
      ...(_snapshot?.raw !== null && _snapshot?.raw !== undefined ? { document: { path: projectDocumentPath(this), sourceHash: snapshot.revision } } : {}),
      ...(taskRead?.source && (taskRead.source === "mirror" ? taskRead.mirror !== null : taskRead.json !== null || tasks.length > 0)
        ? { tasks: { path: taskRead.source === "mirror" ? this.taskMirrorPath() : this.taskDbPath() } } : {}),
      artifacts: artifactSources, nextSteps: nextStepSources
    });
    return snapshot;
  },
  async applyProjectCommand(this: StoreHost, command: ProjectCommand, expectedRevision: string, operationId: string): Promise<string> {
    if (!isGuardedOperationScope(this)) throw new Error("目标与项目只能通过确认后的保存入口修改。");
    assertSafeOperationId(operationId);
    const identity = guardedOperationIdentity(this);
    if (identity?.operationId !== operationId || identity.purpose === "derived") throw new Error("项目确认与当前保存操作不一致，已停止修改。");
    const document = await readProjectDocument(this), commandHash = continuityHash(command);
    const replay = receipts(document).filter(item => item.receipt.operationId === operationId);
    if (replay.length) {
      if (replay.some(item => item.receipt.commandHash !== commandHash)) throw new Error("项目操作标识发生冲突，已停止重复保存。");
      return replay[0].id;
    }
    if (projectDocumentRevision(document) !== expectedRevision) projectConflict();
    const now = new Date().toISOString();
    const receipt = (content: unknown): ContinuityReceipt => ({ kind: "user_confirmation", operationId, recordedAt: now, commandHash, contentHash: continuityHash(content) });
    const change = (content: Record<string, unknown>): ContinuityChange => ({ fields: content, receipt: receipt(content) });
    const id = (prefix: string): string => `${prefix}-${continuityHash(operationId).slice(0, 24)}`;
    let targetId: string;
    if (command.kind === "save_goal") {
      if (!validGoalInput(command.input)) throw new Error("请填写目标名称，检查回顾日期；完成或取消须说明依据。");
      if (command.input.sourcePath) requireSource(this, command.input.sourcePath, true);
      const previous = command.id ? document.goals.find(goal => goal.id === command.id) : undefined;
      if (command.id && !previous) throw new Error("目标已不存在，请重新打开目标列表。");
      const input = fields(command.input, GOAL_FIELDS) as unknown as typeof command.input;
      const goal = { ...previous, ...input, id: previous?.id ?? id("goal"), createdAt: previous?.createdAt ?? now, updatedAt: now,
        changes: [...(previous?.changes ?? []), change(fields(input, GOAL_FIELDS))] };
      if (previous) document.goals[document.goals.indexOf(previous)] = goal;
      else document.goals.push(goal);
      targetId = goal.id;
    } else if (command.kind === "save_project") {
      if (!validProjectInput(command.input) || !document.goals.some(goal => goal.id === command.input.goalId)) throw new Error("请填写项目名称并选择已有目标，检查回顾日期；完成或取消须说明依据。");
      if (command.input.nextStepSourcePath) requireSource(this, command.input.nextStepSourcePath);
      const previous = command.id ? document.projects.find(project => project.id === command.id) : undefined;
      if (command.id && !previous) throw new Error("项目已不存在，请重新打开项目列表。");
      const input = fields(command.input, PROJECT_FIELDS) as unknown as typeof command.input;
      const project = { ...previous, ...input, id: previous?.id ?? id("project"), taskIds: previous?.taskIds ?? [], entries: previous?.entries ?? [],
        nextStepEntryId: previous?.nextStep === input.nextStep && previous?.nextStepSourcePath === input.nextStepSourcePath ? previous.nextStepEntryId : "",
        createdAt: previous?.createdAt ?? now, updatedAt: now, changes: [] as ContinuityChange[] };
      project.changes = [...(previous?.changes ?? []), change(fields(project, PROJECT_SNAPSHOT_FIELDS))];
      if (previous) document.projects[document.projects.indexOf(previous)] = project;
      else document.projects.push(project);
      targetId = project.id;
    } else {
      const project = document.projects.find(item => item.id === command.projectId);
      if (!project) throw new Error("项目已不存在，请重新打开项目列表。");
      if (command.kind === "link_task") {
        if (!command.remove) {
          const task = (await this.readTaskDb({ readOnly: true })).tasks.find(task => task.id === command.taskId);
          if (!task) throw new Error("关联任务已不存在，未创建替代任务。");
          if (!command.expectedTaskRevision || !/^[a-f0-9]{64}$/.test(command.expectedTaskRevision)) throw new Error("请重新选择并核对关联任务，再确认保存。");
          assertRecordRevision(task, command.expectedTaskRevision);
        }
        project.taskIds = command.remove ? project.taskIds.filter(id => id !== command.taskId) : [...new Set([...project.taskIds, command.taskId])];
      } else if (command.kind === "create_task") {
        if (project.state === "completed" || project.state === "cancelled") throw new Error("请先明确重新开始项目，再为它新建任务。");
        if (!command.input.title?.trim()) throw new Error("任务名称不能为空。");
        const task = await this.createTask({ ...command.input, project: project.title, source: `project-operation:${operationId}` });
        project.taskIds.push(task.id);
      } else if (command.kind === "add_entry" || command.kind === "correct_entry" || command.kind === "record_task_result") {
        const previous = command.kind === "correct_entry" ? project.entries.find(entry => entry.id === command.entryId) : undefined;
        if (command.kind === "correct_entry" && !previous) throw new Error("这条产出或回顾已不存在，请重新读取。");
        const entryKind = previous?.kind ?? (command.kind !== "correct_entry" ? command.entryKind : undefined);
        if (!entryKind || !["output", "review"].includes(entryKind) || !command.text.trim()) throw new Error("请填写实际产出或回顾内容。");
        let taskEvidence = previous?.taskEvidence;
        if (command.kind === "record_task_result") {
          if (Object.keys(command).some(key => !["kind", "projectId", "taskId", "expectedTaskRevision", "entryKind", "text", "path", "nextStep"].includes(key))) throw new Error("任务依据只能从原任务库核对，不能另传完成事实。");
          const excluded = this.settings.privacy?.excludedVaultPrefixes;
          if (isVaultPathExcluded(this.taskDbPath(), excluded)) throw new Error("原任务库已排除，未记录任务结果。");
          if (!project.taskIds.includes(command.taskId)) throw new Error("请先关联这个原任务，再核对任务结果。");
          const task = (await this.readTaskDb({ readOnly: true })).tasks.find(item => item.id === command.taskId);
          if (!task || task.sourceNotePath && isVaultPathExcluded(task.sourceNotePath, excluded)) throw new Error("原任务或其依据不可用，未记录任务结果。");
          if (task.sourceNotePath) requireSource(this, task.sourceNotePath);
          if (!/^[a-f0-9]{64}$/.test(command.expectedTaskRevision ?? "")) throw new Error("请重新选择并核对原任务。");
          assertRecordRevision(task, command.expectedTaskRevision);
          taskEvidence = projectTaskEvidence(task);
        }
        let artifactHash = "";
        if (command.path) { requireSource(this, command.path); artifactHash = fileRevision(await this.readPath(command.path)); }
        if (entryKind === "output" && command.nextStep.trim()) throw new Error("产出记录不改下一步，请另记回顾。");
        const content = { kind: entryKind, text: command.text.trim(), path: command.path, artifactHash, nextStep: command.nextStep.trim(),
          ...(taskEvidence ? { taskEvidence: structuredClone(taskEvidence) } : {}) };
        const entry = { ...previous, ...content, id: previous?.id ?? id("entry"), receipt: receipt(content),
          revisions: [...(previous?.revisions ?? []), ...(previous ? [{ ...projectEntryFields(previous), receipt: previous.receipt } as typeof content & { receipt: ContinuityReceipt }] : [])] };
        if (previous) project.entries[project.entries.indexOf(previous)] = entry;
        else project.entries.push(entry);
        if (entryKind === "review" && (!previous || project.nextStepEntryId === previous.id)) {
          project.nextStep = content.nextStep; project.nextStepSourcePath = content.path; project.nextStepEntryId = entry.id;
        }
      } else throw new Error("不支持这个项目操作。");
      project.updatedAt = now;
      project.changes.push(change(fields(project, PROJECT_SNAPSHOT_FIELDS)));
      targetId = project.id;
    }
    await persistProjectDocument(this, document);
    return targetId;
  },
  async buildProjectContext(this: StoreHost, query = "", limit = 6, record?: ContextSourceRecorder, selection?: ProjectHistorySelection): Promise<string> {
    const history = selection ? parseProjectHistorySelection(selection as unknown as Record<string, unknown>) : undefined;
    const excluded = this.settings.privacy?.excludedVaultPrefixes;
    if (isVaultPathExcluded(projectDocumentPath(this), excluded)) return "## 目标与项目接续\n\n目标与项目已被设为不提供给 AI，本轮没有可确认的项目进度。";
    const snapshot = await this.getProjectSnapshot();
    if (history?.historyRevision && history.historyRevision !== snapshot.revision) throw Error("项目保存历史已变化，请重新读取第一页；未拼接不同版本。");
    const protectText = createPersonalMemoryContextFilter((await readPersonalMemoryWithSources(this)).records);
    const sources = snapshotSources.get(snapshot);
    const register = (source: ReadSource | undefined, fragment: string): void => {
      if (source && !isVaultPathExcluded(source.path, excluded)) recordContextSource(record, source.path, fragment, source.sourceHash);
    };
    const { artifacts } = snapshot;
    const goalsAllowed = snapshot.document.goals.filter(goal => !goal.sourcePath || !isVaultPathExcluded(goal.sourcePath, excluded));
    const document = { ...snapshot.document, goals: goalsAllowed, projects: snapshot.document.projects.filter(project => goalsAllowed.some(goal => goal.id === project.goalId)) };
    const taskSourceExcluded = isVaultPathExcluded(this.taskDbPath(), excluded)
      || !!sources?.tasks && isVaultPathExcluded(sources.tasks.path, excluded);
    const tasks = taskSourceExcluded ? [] : snapshot.tasks.filter(task => !task.sourceNotePath || !isVaultPathExcluded(task.sourceNotePath, excluded));
    const entryExcluded = (entry: typeof document.projects[number]["entries"][number]): boolean =>
      projectEntrySourcePaths(entry).some(path => isVaultPathExcluded(path, excluded))
      || !!entry.taskEvidence && taskSourceExcluded;
    const nextStepExcluded = (project: typeof document.projects[number]): boolean =>
      isVaultPathExcluded(project.nextStepSourcePath, excluded)
      || !!project.nextStepEntryId && !!project.entries.find(entry => entry.id === project.nextStepEntryId && entryExcluded(entry));
    const words = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    const rank = (project: typeof document.projects[number]): number => {
      const goal = document.goals.find(goal => goal.id === project.goalId)!;
      const text = `${project.title} ${goal.title} ${nextStepExcluded(project) ? "" : project.nextStep}`.toLowerCase();
      return words.reduce((sum, word) => sum + (text.includes(word) || word.includes(project.title.toLowerCase()) ? 10 : 0), 0)
        + (project.state === "started" ? 3 : project.state === "agreed" ? 2 : project.state === "suggested" ? 1 : 0);
    };
    const selectedProject = history ? document.projects.find(project => project.id === history.projectId) : undefined;
    if (history && !selectedProject) throw Error("准确项目记录不存在或不在本轮允许范围内，未使用其它项目替代。");
    if (history?.entryId && !selectedProject!.entries.some(entry => entry.id === history.entryId)) throw Error("准确记录不属于所选项目，未使用其它产出替代。");
    const projects = history ? [selectedProject!] : [...document.projects].sort((a, b) => rank(b) - rank(a) || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, Math.min(30, limit)));
    const usedGoals = new Set(projects.map(project => project.goalId));
    const goals = document.goals.filter(goal => usedGoals.has(goal.id) || !history && !document.projects.some(project => project.goalId === goal.id)).slice(0, 30);
    const clip = (text: string): string => { const safe = protectText(text); return safe.length > 1000 ? `${safe.slice(0, 1000)}…（内容未全部提供）` : safe; };
    const entryPage = (project: typeof document.projects[number]) => {
      if (history?.entryId) return [project.entries.find(entry => entry.id === history.entryId)!];
      const end = Math.max(0, project.entries.length - (history?.entryOffset ?? 0));
      if (history && (history.entryOffset ?? 0) > project.entries.length) throw Error("记录分页位置超出当前历史范围，请重新读取第一页。");
      return project.entries.slice(Math.max(0, end - (history?.entryLimit ?? 5)), end);
    };
    const historyCoverage = (project: typeof document.projects[number]): string => {
      const page = entryPage(project), older = Math.max(0, project.entries.length - (history?.entryOffset ?? 0) - page.length);
      return `产出／回顾覆盖：共${project.entries.length}条；本轮提供${page.length}条${history?.entryId ? `指定记录，其它${project.entries.length - page.length}条未提供` : `原列表条目，较早${older}条未提供`}。历史版本：${snapshot.revision}。` +
        (history?.entryId ? "保存字段按字符分页；更正前正文未提供。" : `按原列表末尾向前分页，页内保留原列表顺序，不按最近纠正日期重排；继续读取使用query_projects的准确projectId、entryOffset=${(history?.entryOffset ?? 0) + page.length}和本页historyRevision。`) +
        "历史版本只绑定保存记录，原任务、文件状态和权限逐次核对；不能声称各页处于同一时刻。";
    };
    const savedFieldPage = (entry: typeof document.projects[number]["entries"][number]): string => {
      const field = history!.entryField ?? "text", raw = entry[field], start = history!.textOffset ?? 0;
      // Filter the complete field before slicing: a forgotten phrase may cross
      // the page boundary and must not leak through a shorter fragment.
      if (protectText(raw) !== raw) return `保存字段${field}：${MEMORY_CONTEXT_OMISSION}；该字段本轮未提供，不按截短内容继续分析。`;
      if (start > raw.length) throw Error("保存文本分页位置超出字段长度，请重新读取该记录第一页。");
      const splitsCharacter = (position: number): boolean => position > 0 && position < raw.length && /[\uD800-\uDBFF]/.test(raw[position - 1]) && /[\uDC00-\uDFFF]/.test(raw[position]);
      if (splitsCharacter(start)) throw Error("文本分页位置不能切开一个完整字符，请使用上一页返回的位置。");
      let end = Math.min(raw.length, start + (history!.maxChars ?? 4000));
      if (splitsCharacter(end)) end--;
      return `保存字段${field}；文本页：${start}-${end}/${raw.length}；${end === raw.length ? "本字段已读到末尾" : `本字段未读完，继续使用textOffset=${end}和本页historyRevision`}。本页仅提供此区间，不代表本轮已读全字段。这只是本条已确认保存字段，不是原产出文件全文。\n${raw.slice(start, end)}`;
    };
    const nextStepLine = (project: typeof document.projects[number]): string => {
      const hidden = nextStepExcluded(project);
      let fragment = `下一步：${hidden ? "依据原文已排除，本轮不提供" : clip(project.nextStep)}；回顾日期：${project.reviewOn || "未约定"}`;
      const entry = hidden ? undefined : project.entries.find(entry => entry.id === project.nextStepEntryId);
      if (entry?.path) {
        const status = artifacts[entry.id];
        fragment += `；下一步依据：${entry.path}；${status === "unchanged" ? "与保存时文件字节一致" : status === "changed" ? "原文件已变化，须重新核对" : "原文件不可用"}`;
        if (status !== "unchanged") fragment += "；保留此前确认的安排，不能视为当前已核实的下一步";
        register(sources?.artifacts.get(entry.id), fragment);
      } else if (!hidden && project.nextStepSourcePath) {
        const source = sources?.nextSteps.get(project.id);
        fragment += `；下一步依据：${project.nextStepSourcePath}；${source ? "本次已核对当前文件可读取" : "原文件不可用或本次未核验"}；未保存确认时的原文件版本，不能比较是否变化；保留此前确认的安排，不能视为当前已核实的下一步`;
        register(source, fragment);
      }
      return fragment;
    };
    const summary = `来源：${projectDocumentPath(this)}；共${document.goals.length}个目标、${document.projects.length}个项目，本轮提供${projects.length}个项目。`;
    register(sources?.document, summary);
    return ["## 目标与项目接续", summary,
      "以下内容来自明确保存的记录；建议、同意、开始、完成和取消须分别理解。产出是用户确认记录；文件校验只证明当前字节一致，不证明质量或项目完成。任务状态只引用原任务库，不得从模型文字或产出推断完成。",
      "记录ID仅用于工具准确选择已有记录，正常回复使用名称，不向用户展示内部ID。",
      "产出来源正文未提供；文件可读取或字节校验不等于已提供报告全文。分析原文件时须用query_vault按准确path的get继续读取，未读内容不可补造。历史页或单条保存正文用query_projects的准确projectId；单条用entryId、entryField和字符分页。",
      ...goals.map(goal => { const fragment = [
        `目标：${goal.title}；目标ID：${goal.id}；状态：${PROJECT_STATE_LABELS[goal.state]}`, `理由：${clip(goal.reason)}`, `成功标准：${clip(goal.successCriteria)}`,
        `时间边界：${clip(goal.timeBoundary)}；约束：${clip(goal.constraints)}`, `下一步：${clip(goal.nextStep)}；回顾日期：${goal.reviewOn || "未约定"}`,
        `状态依据：${clip(goal.stateNote) || "未填写"}`,
        goal.sourcePath ? `原文来源：${goal.sourcePath}（${this.isManagedSourcePath(goal.sourcePath) && this.getFile(goal.sourcePath) ? "可读取" : "暂不可用"}）` : ""
      ].filter(Boolean).join("\n"); register(sources?.document, fragment); return fragment; }),
      ...projects.map(project => { const fragment = [
        `项目：${project.title}；项目ID：${project.id}；所属目标：${document.goals.find(goal => goal.id === project.goalId)!.title}；${project.kind === "work" ? "事业" : "学习"}；状态：${PROJECT_STATE_LABELS[project.state]}`,
        nextStepLine(project), `上次承诺：${clip(project.commitments)}；阻塞：${clip(project.blockers)}`,
        `状态依据：${clip(project.stateNote) || "未填写"}`,
        ...project.taskIds.map(id => {
          const task = tasks.find(task => task.id === id);
          const fragment = task ? `关联任务：${task.title}；任务ID：${task.id}；${task.status === "completed" ? "已完成（任务库记录）" : task.status === "abandoned" ? "已取消（任务库记录）" : "待办（任务库记录）"}` : "关联任务：原记录不可用，未推断状态";
          if (task) register(sources?.tasks, fragment);
          return fragment;
        }),
        historyCoverage(project),
        ...entryPage(project).map(entry => {
          if (entryExcluded(entry)) return "产出或回顾来源已排除，本轮省略对应内容。";
          const currentTask = tasks.find(task => task.id === entry.taskEvidence?.taskId), linked = !!entry.taskEvidence && project.taskIds.includes(entry.taskEvidence.taskId);
          const evidence = entry.taskEvidence ? `\n任务结果依据（原任务ID：${entry.taskEvidence.taskId}）：\n${projectTaskEvidenceLines(entry.taskEvidence, currentTask, linked).join("\n")}` : "";
          const fragment = `${entry.kind === "output" ? "产出" : "回顾"}（记录ID：${entry.id}；用户确认，${entry.receipt.recordedAt}）：${history?.entryId ? savedFieldPage(entry) : clip(entry.text)}${entry.path ? `；来源：${entry.path}；${artifacts[entry.id] === "unchanged" ? "与保存时文件字节一致" : artifacts[entry.id] === "changed" ? "原文件已变化，须重新核对" : "原文件不可用"}` : ""}${entry.kind === "review" && !history?.entryId ? `；调整后的下一步：${clip(entry.nextStep)}` : ""}${evidence}\n首次记录确认时间：${entry.revisions[0]?.receipt.recordedAt ?? entry.receipt.recordedAt}；确认／最近更正时间：${entry.receipt.recordedAt}；不等于事件发生日，更正前正文未提供。`;
          register(sources?.artifacts.get(entry.id), fragment);
          if (currentTask && linked) register(sources?.tasks, evidence);
          return fragment;
        })
      ].join("\n"); register(sources?.document, fragment); return fragment; }),
      !document.goals.length ? "尚未建立持续目标；既有目标 Markdown 保留，不能自动当成已确认项目。" : ""
    ].filter(Boolean).join("\n\n");
  }
};
export function applyProjectSlice(Store: { prototype: object }): void { Object.assign(Store.prototype, projectSlice); }
