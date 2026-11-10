import { Modal, Notice, Setting, type App } from "obsidian";
import { TaskModal } from "./modals";
import { newLocalOperationId, recordRevision } from "./operationIdentity";
import {
  PROJECT_STATES, PROJECT_STATE_LABELS, projectSubmissionId, projectTaskEvidence, projectTaskEvidenceLines, type ContinuityGoal, type ContinuityProject, type GoalInput, type ProjectInput,
  type ProjectCommand, type ProjectEntry, type ProjectSnapshot
} from "./projectContinuity";

export interface ProjectBoardController {
  getProjectSnapshot(): Promise<ProjectSnapshot>;
  saveProjectCommand(command: ProjectCommand, expectedRevision: string, operationId: string): Promise<string>;
  openProjectSource(path: string): Promise<void>;
  openProjectTaskPlan?(projectId?: string, onChanged?: () => Promise<void>): void;
}
function action(container: HTMLElement, text: string, callback: () => void | Promise<void>): HTMLButtonElement {
  const button = container.createEl("button", { text });
  button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    try { await callback(); } catch (error) { new Notice(error instanceof Error ? error.message : "操作没有完成，请重试。"); }
    finally { button.disabled = false; }
  };
  return button;
}
function textField(container: HTMLElement, label: string, value: string, update: (value: string) => void, multiline = false): void {
  const setting = new Setting(container).setName(label);
  if (multiline) setting.addTextArea(text => text.setValue(value).onChange(update));
  else setting.addText(text => text.setValue(value).onChange(update));
}
function stateFields(container: HTMLElement, value: GoalInput | ProjectInput): void {
  new Setting(container).setName("当前阶段").addDropdown(dropdown => {
    for (const state of PROJECT_STATES) dropdown.addOption(state, PROJECT_STATE_LABELS[state]);
    dropdown.setValue(value.state).onChange(state => value.state = state as typeof value.state);
  });
  textField(container, "完成或取消的依据", value.stateNote, text => value.stateNote = text, true);
}
class ProjectForm extends Modal {
  readonly operationId = newLocalOperationId("project_change");
  constructor(app: App, private readonly heading: string, private readonly build: (container: HTMLElement) => void,
    private readonly submit: (operationId: string) => Promise<void>, private readonly submitLabel = "确认保存") { super(app); }
  onOpen(): void {
    const container = this.contentEl;
    container.empty(); container.addClass("lifeops-project-form");
    container.createEl("h2", { text: this.heading });
    this.build(container);
    const actions = container.createDiv({ cls: "lifeops-project-actions" });
    action(actions, "取消", () => this.close());
    action(actions, this.submitLabel, async () => {
      const controls = [...container.querySelectorAll<HTMLInputElement>("input, textarea, select, button")];
      const disabled = controls.map(control => control.disabled);
      controls.forEach(control => control.disabled = true);
      try { await this.submit(this.operationId); this.close(); }
      finally { controls.forEach((control, index) => control.disabled = disabled[index]); }
    }).addClass("mod-cta");
  }
}
export class ProjectBoardModal extends Modal {
  private generation = 0;
  private closed = false;
  constructor(app: App, private readonly controller: ProjectBoardController) { super(app); }
  onOpen(): void { this.closed = false; void this.render(); }
  onClose(): void { this.closed = true; this.generation += 1; }
  private async render(): Promise<void> {
    const generation = ++this.generation;
    let snapshot: ProjectSnapshot;
    try { snapshot = await this.controller.getProjectSnapshot(); }
    catch (error) {
      if (this.closed || generation !== this.generation) return;
      this.contentEl.empty();
      this.contentEl.createEl("h2", { text: "目标与项目暂时无法读取" });
      this.contentEl.createEl("p", { text: error instanceof Error ? error.message : "记录未覆盖，请检查后重试。" });
      action(this.contentEl, "重新读取", () => this.render()); return;
    }
    if (this.closed || generation !== this.generation) return;
    const container = this.contentEl;
    container.empty(); container.addClass("lifeops-project-board");
    container.createEl("h2", { text: "目标与项目" });
    container.createEl("p", { text: "把事业和学习接着做：记住目标、上次承诺、阻塞和下一步。", cls: "lifeops-muted" });
    const toolbar = container.createDiv({ cls: "lifeops-project-actions" });
    action(toolbar, "建立目标", () => this.editGoal(snapshot)).addClass("mod-cta");
    action(toolbar, "刷新记录", () => this.render());
    if (this.controller.openProjectTaskPlan) action(toolbar, "可恢复安排", () => this.controller.openProjectTaskPlan!(undefined, () => this.closed ? Promise.resolve() : this.render()));
    if (!snapshot.document.goals.length) container.createEl("p", { text: "先建立一个目标，再把项目和原任务关联起来；已有目标笔记可以选作来源。", cls: "lifeops-project-empty" });
    const current = container.createDiv();
    const archived = container.createEl("details", { cls: "lifeops-project-archive" });
    archived.createEl("summary", { text: "已完成与已取消的目标" });
    for (const goal of snapshot.document.goals) {
      const target = goal.state === "completed" || goal.state === "cancelled" ? archived : current;
      const section = target.createEl("section", { cls: "lifeops-project-goal" });
      section.createEl("h3", { text: goal.title });
      section.createEl("p", { text: `${PROJECT_STATE_LABELS[goal.state]}${goal.reviewOn ? ` · ${goal.reviewOn} 回顾` : ""}`, cls: "lifeops-muted" });
      if (goal.nextStep) section.createEl("p", { text: `下一步：${goal.nextStep}`, cls: "lifeops-project-next" });
      const details = section.createEl("details");
      details.createEl("summary", { text: "目标依据与约束" });
      for (const [label, text] of [["为什么做", goal.reason], ["成功标准", goal.successCriteria], ["时间边界", goal.timeBoundary], ["约束", goal.constraints], ["阶段依据", goal.stateNote]]) {
        if (text) details.createEl("p", { text: `${label}：${text}` });
      }
      if (goal.sourcePath) action(details, "打开原目标笔记", () => this.controller.openProjectSource(goal.sourcePath));
      const actions = section.createDiv({ cls: "lifeops-project-actions" });
      action(actions, "更正目标", () => this.editGoal(snapshot, goal));
      action(actions, "新建项目", () => this.editProject(snapshot, goal.id));
      const projects = snapshot.document.projects.filter(project => project.goalId === goal.id);
      for (const project of projects) this.renderProject(section, snapshot, project);
    }
  }
  private async save(snapshot: ProjectSnapshot, command: ProjectCommand, operationId: string): Promise<void> {
    // Retries of the same submitted contents are one operation; correcting a
    // failed form starts a new one instead of colliding with the failed claim.
    const submitted = structuredClone(command);
    await this.controller.saveProjectCommand(submitted, snapshot.revision, projectSubmissionId(operationId, submitted, snapshot.revision));
    if (!this.closed) await this.render();
  }
  private editGoal(snapshot: ProjectSnapshot, goal?: ContinuityGoal): void {
    const value: GoalInput = { title: "", reason: "", successCriteria: "", timeBoundary: "", constraints: "", nextStep: "", reviewOn: "", sourcePath: "", state: "suggested", stateNote: "", ...goal };
    new ProjectForm(this.app, goal ? "更正目标" : "建立目标", container => {
      textField(container, "目标名称", value.title, text => value.title = text);
      textField(container, "为什么做", value.reason, text => value.reason = text, true);
      textField(container, "怎样算成功", value.successCriteria, text => value.successCriteria = text, true);
      textField(container, "下一步", value.nextStep, text => value.nextStep = text, true);
      const details = container.createEl("details"); details.createEl("summary", { text: "时间、约束与原文来源" });
      textField(details, "时间边界", value.timeBoundary, text => value.timeBoundary = text);
      textField(details, "约束", value.constraints, text => value.constraints = text, true);
      textField(details, "回顾日期（YYYY-MM-DD）", value.reviewOn, text => value.reviewOn = text);
      textField(details, "原目标笔记路径（可选）", value.sourcePath, text => value.sourcePath = text);
      stateFields(container, value);
    }, id => this.save(snapshot, { kind: "save_goal", id: goal?.id, input: value }, id)).open();
  }
  private editProject(snapshot: ProjectSnapshot, goalId: string, project?: ContinuityProject): void {
    const value: ProjectInput = { title: "", goalId, kind: "work", nextStep: "", nextStepSourcePath: "", commitments: "", blockers: "", reviewOn: "", state: "suggested", stateNote: "", ...project };
    new ProjectForm(this.app, project ? "更正项目" : "新建项目", container => {
      textField(container, "项目名称", value.title, text => value.title = text);
      new Setting(container).setName("所属目标").addDropdown(dropdown => {
        for (const goal of snapshot.document.goals) dropdown.addOption(goal.id, goal.title);
        dropdown.setValue(value.goalId).onChange(text => value.goalId = text);
      });
      new Setting(container).setName("项目类型").addDropdown(dropdown => dropdown.addOption("work", "事业").addOption("learning", "学习").setValue(value.kind).onChange(text => value.kind = text as typeof value.kind));
      textField(container, "下一步", value.nextStep, text => value.nextStep = text, true);
      textField(container, "下一步的原文依据（可选）", value.nextStepSourcePath, text => value.nextStepSourcePath = text);
      textField(container, "上次承诺", value.commitments, text => value.commitments = text, true);
      textField(container, "当前阻塞", value.blockers, text => value.blockers = text, true);
      textField(container, "回顾日期（YYYY-MM-DD）", value.reviewOn, text => value.reviewOn = text);
      stateFields(container, value);
    }, id => this.save(snapshot, { kind: "save_project", id: project?.id, input: value }, id)).open();
  }
  private renderProject(parent: HTMLElement, snapshot: ProjectSnapshot, project: ContinuityProject): void {
    const card = parent.createEl("article", { cls: "lifeops-project-card" });
    card.createEl("h4", { text: project.title });
    card.createEl("p", { text: `${project.kind === "work" ? "事业" : "学习"} · ${PROJECT_STATE_LABELS[project.state]}${project.reviewOn ? ` · ${project.reviewOn} 回顾` : ""}`, cls: "lifeops-muted" });
    card.createEl("p", { text: `下一步：${project.nextStep || "待明确"}`, cls: "lifeops-project-next" });
    if (project.commitments) card.createEl("p", { text: `上次承诺：${project.commitments}` });
    if (project.blockers) card.createEl("p", { text: `当前阻塞：${project.blockers}` });
    const actions = card.createDiv({ cls: "lifeops-project-actions" });
    action(actions, "更正项目", () => this.editProject(snapshot, project.goalId, project));
    const taskDetails = card.createEl("details"); taskDetails.createEl("summary", { text: `关联任务（${project.taskIds.length}）` });
    for (const id of project.taskIds) {
      const task = snapshot.tasks.find(task => task.id === id);
      const row = taskDetails.createDiv({ cls: "lifeops-project-task" });
      row.createSpan({ text: task ? `${task.title} · ${task.status === "completed" ? "已完成" : task.status === "abandoned" ? "已取消" : "待办"}` : "原任务记录不可用" });
      if (task) action(row, "记录结果并回顾", () => this.addTaskResult(snapshot, project, id));
      action(row, "解除关联", () => this.save(snapshot, { kind: "link_task", projectId: project.id, taskId: id, remove: true }, newLocalOperationId("project_unlink")));
    }
    const taskActions = taskDetails.createDiv({ cls: "lifeops-project-actions" });
    action(taskActions, "关联已有任务", () => {
      let taskId = snapshot.tasks.find(task => !project.taskIds.includes(task.id))?.id ?? "";
      new ProjectForm(this.app, "关联已有任务", container => {
        new Setting(container).setName("选择原任务").addDropdown(dropdown => {
          dropdown.addOption("", "请选择");
          for (const task of snapshot.tasks.filter(task => !project.taskIds.includes(task.id))) dropdown.addOption(task.id, task.title);
          dropdown.setValue(taskId).onChange(value => taskId = value);
        });
      }, id => {
        const selected = snapshot.tasks.find(task => task.id === taskId);
        return this.save(snapshot, { kind: "link_task", projectId: project.id, taskId,
          expectedTaskRevision: selected ? recordRevision(selected) : undefined }, id);
      }).open();
    });
    if (project.state !== "completed" && project.state !== "cancelled") action(taskActions, "为项目新建任务", () => {
      const id = newLocalOperationId("project_task");
      new TaskModal(this.app, input => this.save(snapshot, { kind: "create_task", projectId: project.id, input }, id), { project: project.title }).open();
    });
    if (project.state !== "completed" && project.state !== "cancelled" && this.controller.openProjectTaskPlan) {
      action(taskActions, "为项目安排多项任务", () => this.controller.openProjectTaskPlan!(project.id, () => this.closed ? Promise.resolve() : this.render()));
    }
    const entries = card.createEl("details"); entries.createEl("summary", { text: `产出与回顾（${project.entries.length}）` });
    for (const entry of project.entries) {
      const item = entries.createDiv({ cls: "lifeops-project-entry" });
      item.createEl("p", { text: `${entry.kind === "output" ? "产出" : "回顾"} · ${entry.receipt.recordedAt.slice(0, 10)} · 由你确认`, cls: "lifeops-muted" });
      item.createEl("p", { text: entry.text });
      if (entry.taskEvidence) {
        for (const line of projectTaskEvidenceLines(entry.taskEvidence, snapshot.tasks.find(task => task.id === entry.taskEvidence!.taskId), project.taskIds.includes(entry.taskEvidence.taskId))) {
          item.createEl("p", { text: line, cls: "lifeops-muted" });
        }
      }
      if (entry.kind === "review" && entry.nextStep) item.createEl("p", { text: `当时调整的下一步：${entry.nextStep}` });
      if (entry.path) {
        item.createEl("p", { text: snapshot.artifacts[entry.id] === "unchanged" ? "来源文件与记录时一致" : snapshot.artifacts[entry.id] === "changed" ? "来源文件已变化，需要重新核对" : "来源文件暂不可用", cls: "lifeops-muted" });
        action(item, "打开产出原文", () => this.controller.openProjectSource(entry.path));
      }
      action(item, "更正这条记录", () => this.addEntry(snapshot, project, entry.kind, entry));
      if (entry.revisions.length) item.createEl("p", { text: `已更正 ${entry.revisions.length} 次，原记录保留。`, cls: "lifeops-muted" });
    }
    const entryActions = entries.createDiv({ cls: "lifeops-project-actions" });
    action(entryActions, "记录产出", () => this.addEntry(snapshot, project, "output"));
    action(entryActions, "记录回顾并调整下一步", () => this.addEntry(snapshot, project, "review"));
  }
  private addTaskResult(snapshot: ProjectSnapshot, project: ContinuityProject, taskId: string): void {
    const task = snapshot.tasks.find(item => item.id === taskId);
    if (!task || !project.taskIds.includes(taskId)) throw new Error("原任务关联已变化，请刷新后核对。");
    const evidence = projectTaskEvidence(task);
    let text = "", path = "", nextStep = project.nextStep;
    new ProjectForm(this.app, "核对任务结果并回顾", container => {
      for (const line of projectTaskEvidenceLines(evidence, task)) container.createEl("p", { text: line, cls: "lifeops-muted" });
      container.createEl("p", { text: "确认后记录原任务当时的状态和你的回顾，不改变任务或项目阶段；任务变化后须重新核对。", cls: "lifeops-muted" });
      textField(container, "实际结果与回顾", text, value => text = value, true);
      textField(container, "结果原文笔记路径（可选）", path, value => path = value);
      textField(container, "调整后的下一步", nextStep, value => nextStep = value, true);
    }, id => this.save(snapshot, { kind: "record_task_result", projectId: project.id, taskId,
      expectedTaskRevision: evidence.taskRevision, entryKind: "review", text, path, nextStep }, id), "确认记录结果").open();
  }
  private addEntry(snapshot: ProjectSnapshot, project: ContinuityProject, kind: "output" | "review", previous?: ProjectEntry): void {
    let text = previous?.text ?? "", path = previous?.path ?? "", nextStep = previous?.nextStep ?? project.nextStep;
    new ProjectForm(this.app, previous ? "更正产出或回顾" : kind === "output" ? "确认实际产出" : "回顾与调整", container => {
      container.createEl("p", { text: "只记录实际发生的结果；保存这条记录不会自动完成项目或任务。", cls: "lifeops-muted" });
      if (previous?.taskEvidence) {
        for (const line of projectTaskEvidenceLines(previous.taskEvidence, snapshot.tasks.find(task => task.id === previous.taskEvidence!.taskId), project.taskIds.includes(previous.taskEvidence.taskId))) {
          container.createEl("p", { text: line, cls: "lifeops-muted" });
        }
        container.createEl("p", { text: "更正保留记录当时的任务依据，不把当前状态替换进旧记录。", cls: "lifeops-muted" });
      }
      textField(container, kind === "output" ? "实际产出" : "反馈与回顾", text, value => text = value, true);
      textField(container, "原文笔记路径（可选）", path, value => path = value);
      if (kind === "review") textField(container, "调整后的下一步", nextStep, value => nextStep = value, true);
    }, id => this.save(snapshot, previous
      ? { kind: "correct_entry", projectId: project.id, entryId: previous.id, text, path, nextStep: kind === "review" ? nextStep : "" }
      : { kind: "add_entry", projectId: project.id, entryKind: kind, text, path, nextStep: kind === "review" ? nextStep : "" }, id), "确认记录").open();
  }
}
