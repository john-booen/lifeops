import { Modal, Notice, Setting, type App } from "obsidian";
import { todayString } from "./date";
import type { ProjectJobRunner, ProjectJobReview, ProjectJobInspection } from "./projectJobRunner";
import { PROJECT_STATE_LABELS } from "./projectContinuity";
import type { ProjectJobProjectBinding } from "./projectJobRepository";

/** User-started plans only. An already confirmed chat run may expose its stop button here. */
export class ProjectJobModal extends Modal {
  private generation = 0;
  private closed = false;
  private activeRequest: AbortController | null = null;
  private draft = { titles: "", date: todayString(), time: "", category: "AI建议", nextStep:"" };
  constructor(app: App, private readonly runner: ProjectJobRunner,
    private readonly started?: { request: AbortController; completion: Promise<ProjectJobInspection> }, private readonly projectId = "",
    private readonly onChanged?: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.closed = false;
    if (!this.started) { void this.render(); return; }
    this.activeRequest = this.started.request; this.busy(this.contentEl);
    void this.started.completion.catch(error => {
      if (!this.closed) new Notice(error instanceof Error ? error.message : "安排保存未完成，请检查后恢复。");
    }).finally(async () => { this.activeRequest = null; await this.onChanged?.(); if (!this.closed) await this.render(); });
  }
  onClose(): void { this.closed = true; this.generation++; }
  private button(container: HTMLElement, label: string, run: () => Promise<void> | void): HTMLButtonElement {
    const button = container.createEl("button", { text: label });
    button.onclick = async () => {
      if (button.disabled || this.closed) return;
      button.disabled = true;
      try { await run(); } catch (error) { if (!this.closed) new Notice(error instanceof Error ? error.message : "安排没有完成，请重新核对。"); }
      finally { button.disabled = false; }
    };
    return button;
  }
  private async render(): Promise<void> {
    const generation = ++this.generation;
    let state: ProjectJobInspection;
    try { state = await this.runner.inspect(); }
    catch (error) {
      if (this.closed || generation !== this.generation) return;
      this.contentEl.empty(); this.contentEl.createEl("h2", { text: "安排暂时无法读取" });
      this.contentEl.createEl("p", { text: error instanceof Error ? error.message : "原记录已保留。" });
      this.button(this.contentEl, "重新读取", () => this.render()); return;
    }
    if (this.closed || generation !== this.generation) return;
    const container = this.contentEl; container.empty(); container.addClass("lifeops-project-board");
    container.createEl("h2", { text: "把安排接着做" });
    container.createEl("p", { text: state.message, cls: "lifeops-muted" });
    const job = state.snapshot.document.job;
    if (!job && !state.canResume) { this.form(container); return; }
    if (job) {
      this.binding(container, job.projectBinding, true);
      container.createEl("p", { text: "这里只保存你确认的任务安排；完成安排不等于完成任务。", cls: "lifeops-muted" });
      for (let index = 0; index < job.steps.length; index++) {
        const step = job.steps[index], effect = job.effects[index];
        const row = container.createEl("section", { cls: "lifeops-project-goal" });
        if(step.toolName==="create_task"){
          row.createEl("h3", { text: step.arguments.title });
          row.createEl("p", { text: [step.arguments.date, step.arguments.time, step.arguments.category].filter(Boolean).join(" · "), cls: "lifeops-muted" });
        }else{row.createEl("h3",{text:"更新项目下一步"});row.createEl("p",{text:step.arguments.text});row.createEl("p",{text:`依据：${step.arguments.sourcePath||"本次输入"}`,cls:"lifeops-muted"});}
        row.createEl("p", { text: effect?.phase === "committed" ? state.savedStateVerified === true
          ? step.toolName==="create_task" ? "本次核对：已保存到事务" : "本次核对：项目下一步已更新"
          : "记录显示曾保存，当前结果待核对" : effect ? "提交待核对" : "原安排记录中尚未开始" });
      }
    }
    const actions = container.createDiv({ cls: "lifeops-project-actions" });
    if (state.canResume) this.button(actions, "检查并恢复后继续", async () => {
      const request = new AbortController(); this.activeRequest = request;
      const pending = this.runner.resume(state.snapshot, request.signal);
      this.busy(container); try { await pending; } finally { if (this.activeRequest === request) this.activeRequest = null; await this.onChanged?.(); await this.render(); }
    }).addClass("mod-cta");
    if (job && ["queued", "running", "failed"].includes(job.status)) this.button(actions, "停止剩余安排", async () => {
      this.activeRequest?.abort(); await this.runner.cancel(state.snapshot); await this.onChanged?.(); await this.render();
    });
    if (job && ["completed", "cancelled", "timed_out"].includes(job.status)) this.button(actions, "保留历史，开始下一份安排", async () => {
      await this.runner.archive(state.snapshot);
      this.draft = { titles: "", date: todayString(), time: "", category: "AI建议",nextStep:"" };
      await this.render();
    });
    this.button(actions, "刷新", () => this.render());
  }
  private form(container: HTMLElement): void {
    container.createEl("p", { text: "一行写一项任务，最多八项；同时更新下一步时最多七项。先核对，再逐项保存；中断后会保留进度。" });
    if (this.projectId) container.createEl("p", { text: "本安排将关联所选已有项目；核对卡会显示项目名称和原阶段。", cls: "lifeops-muted" });
    new Setting(container).setName("任务").addTextArea(text => {
      text.inputEl.rows = 7; text.setPlaceholder("例如：整理资料\n核对第一份原文").setValue(this.draft.titles).onChange(value => this.draft.titles = value);
    });
    for (const [key, label] of [["date", "日期"], ["time", "时间（可留空）"], ["category", "分类"]] as const) {
      new Setting(container).setName(label).addText(text => text.setValue(this.draft[key]).onChange(value => this.draft[key] = value));
    }
    if(this.projectId)new Setting(container).setName("同时更新项目下一步（可留空）").addTextArea(text=>{
      text.inputEl.rows=2;text.setPlaceholder("保存任务之后，项目接下来具体做什么").setValue(this.draft.nextStep).onChange(value=>this.draft.nextStep=value);
    });
    this.button(container.createDiv({ cls: "lifeops-project-actions" }), "核对安排", async () => {
      const generation = this.generation, draft = structuredClone(this.draft);
      const titles = draft.titles.split(/\r?\n/).map(title => title.trim()).filter(Boolean);
      const userMessage = `创建任务：${draft.titles}\n日期：${draft.date}\n时间：${draft.time}\n分类：${draft.category}${draft.nextStep.trim()?`\n更新项目下一步：${draft.nextStep}`:""}`;
      const taskInputs=titles.map(title => ({ title, date: draft.date, time: draft.time, category: draft.category }));
      const review = this.projectId&&draft.nextStep.trim() ? await this.runner.prepareWorkPlan(taskInputs,userMessage,[],this.projectId,{text:draft.nextStep})
        : await this.runner.prepare(taskInputs, userMessage, [], undefined, this.projectId);
      if (this.closed || this.generation !== generation) return;
      this.review(review);
    }).addClass("mod-cta");
  }
  private review(review: ProjectJobReview): void {
    const container = this.contentEl; container.empty(); this.generation++;
    container.createEl("h2", { text: "核对将保存的安排" });
    container.createEl("p", { text: "确认后才保存；重启后不会重新解释日期。", cls: "lifeops-muted" });
    this.binding(container, review.job.projectBinding);
    for (const step of review.job.steps) {
      const row = container.createEl("section", { cls: "lifeops-project-goal" });
      if(step.toolName==="create_task"){
        row.createEl("h3", { text: step.arguments.title });
        row.createEl("p", { text: [step.arguments.date, step.arguments.time, step.arguments.category].filter(Boolean).join(" · ") });
      }else{
        row.createEl("h3",{text:"更新项目下一步"});row.createEl("p",{text:`原下一步：${review.nextStepBefore?.text||"未设置"}`});
        row.createEl("p",{text:`原来源：${review.nextStepBefore?.sourcePath||"本次输入"}`});row.createEl("p",{text:`改为：${step.arguments.text}`});
        row.createEl("p",{text:`新来源：${step.arguments.sourcePath||"本次输入，不沿用原来源"}`});row.createEl("p",{text:"原回顾与历史保留，当前下一步依据改为以上内容。",cls:"lifeops-muted"});
      }
    }
    const actions = container.createDiv({ cls: "lifeops-project-actions" });
    this.button(actions, "返回修改", () => this.render());
    this.button(actions, "确认保存这些安排", async () => {
      const request = new AbortController(); this.activeRequest = request;
      const pending = this.runner.startConfirmed(review, request.signal); this.busy(container);
      try { await pending; } finally { if (this.activeRequest === request) this.activeRequest = null; await this.onChanged?.(); await this.render(); }
    }).addClass("mod-cta");
  }
  private binding(container: HTMLElement, binding?: ProjectJobProjectBinding, historical = false): void {
    if (!binding) return;
    container.createEl("p", { text: historical
      ? `原安排所属目标：${binding.goalTitle}；关联项目：${binding.title}；确认时项目阶段：${PROJECT_STATE_LABELS[binding.state]}`
      : `所属目标：${binding.goalTitle}；关联项目：${binding.title}；项目阶段：${PROJECT_STATE_LABELS[binding.state]}` });
    container.createEl("p", { text: historical ? "以下是原安排记录，当前任务和项目请查看各自页面的最新状态。"
      : "每项新任务会同时关联此项目；任务仍为待办，项目阶段保持原值。", cls: "lifeops-muted" });
  }
  private busy(container: HTMLElement): void {
    container.empty(); this.generation++;
    container.createEl("h2", { text: "正在保存安排" });
    container.createEl("p", { text: "可以停止剩余安排；已经保存的任务会保留。" });
    container.createEl("p", { text: "关闭窗口后仍可从“可恢复安排”查看；要停下请点下面的停止按钮。", cls: "lifeops-muted" });
    this.button(container.createDiv({ cls: "lifeops-project-actions" }), "停止剩余安排", async () => {
      this.activeRequest?.abort(); const state = await this.runner.inspect(); await this.runner.cancel(state.snapshot); await this.onChanged?.(); await this.render();
    });
  }
}
