import { Modal, Notice, Setting, type App, type Command } from "obsidian";
import { todayString } from "../../date";
import type LifeOpsPlugin from "../../main";
import type { StoreHost } from "../../store/settingsSlice";
import type { LocalOperationHost } from "../serviceHost";
import { LEARNING_TRACKS, learningProgress, type LearningTrackId, type LearningUnitStatus } from "./model";
import { prepareLearningPlan, saveLearningPlan, type LearningPlan, type LearningPlanMode } from "./plans";
import { existingLearningTrack, readLearningDocument, updateLearningUnit, visibleLearningTrack } from "./store";

export interface LearningUiHost extends LocalOperationHost {
  app: App;
  store: StoreHost;
  observeProvider: LifeOpsPlugin["observeProvider"];
  register(callback: () => void): void;
  addCommand(command: Command): Command;
}

const trackIds = Object.keys(LEARNING_TRACKS) as LearningTrackId[];
const UNIT_LABELS = { todo: "待学", doing: "在学", done: "完成" } as const;
const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

export function registerLearningCommands(host: LearningUiHost): void {
  host.addCommand({ id: "initialize-lifeops-learning", name: "初始化学习轨道", callback: () => openLearningPlan(host, "initialize") });
  host.addCommand({ id: "adjust-lifeops-learning", name: "调整学习计划", callback: () => openLearningPlan(host, "adjust") });
}

export function openLearningPlan(host: LearningUiHost, mode: LearningPlanMode, id?: LearningTrackId): void {
  const modal = new LearningPlanModal(host, mode, id);
  host.register(() => modal.close());
  modal.open();
}

class LearningPlanModal extends Modal {
  private readonly request = new AbortController();
  private busy = false;
  constructor(private readonly host: LearningUiHost, private readonly mode: LearningPlanMode, private readonly id?: LearningTrackId) { super(host.app); }
  onOpen(): void {
    this.contentEl.addClass("lifeops-form-modal");
    void this.pickTrack().catch(error => this.notify(error));
  }
  onClose(): void { this.request.abort(); this.contentEl.empty(); }

  private async pickTrack(): Promise<void> {
    const doc = await readLearningDocument(this.host.store);
    this.request.signal.throwIfAborted();
    const container = this.contentEl;
    container.empty();
    container.createEl("h2", { text: this.mode === "initialize" ? "初始化学习轨道" : "调整下周学习计划" });
    const eligible = trackIds.filter(id => !!existingLearningTrack(this.host.store, doc, id).goal === (this.mode === "adjust"));
    const options = this.id && eligible.includes(this.id) ? [this.id] : eligible;
    if (!options.length) {
      container.createEl("p", { text: this.mode === "initialize" ? "四条轨道都已建立计划，可以使用调整学习计划。" : "请先初始化至少一条学习轨道。" });
      return;
    }
    const disclosure = container.createEl("p", { text: "生成草案时，已配置模型会读取这条轨道允许使用的资料和进度。可以编辑后再保存。" });
    for (const id of options) this.button(LEARNING_TRACKS[id] + " · 生成草案", async () => {
      const aiSettings = this.host.store.settings.ai;
      if (aiSettings.provider === "off" || !aiSettings.dataDisclosureAccepted || !aiSettings.endpoint || !aiSettings.model) {
        throw new Error("请先配置允许读取笔记的模型。");
      }
      disclosure.setText("正在生成，可关闭窗口停止。");
      const plan = await this.host.observeProvider<LearningPlan>("learning_plan", "text", (request, _store, ai, current) =>
        prepareLearningPlan(this.host.store, id, this.mode, (messages, options) => ai.generatePlanningJson(messages, options),
          { ...request, assertTextRequestCurrent: current }), this.request.signal);
      this.request.signal.throwIfAborted();
      this.review(plan);
    });
  }

  private review(plan: LearningPlan): void {
    const container = this.contentEl, draft = structuredClone(plan.draft);
    let weeklyMinutes = String(draft.weeklyMinutes), folders = draft.folders.join("\n"), units = draft.units.join("\n");
    container.empty();
    container.createEl("h2", { text: plan.track.name + (plan.mode === "adjust" ? " · 下周计划" : " · 初始计划") });
    if (plan.scheduledFrom) container.createEl("p", { text: "从 " + plan.scheduledFrom + " 开始使用这份计划。" });
    container.createEl("p", { text: plan.sourcePaths.length ? "参考资料 " + plan.sourcePaths.length + " 篇。已完成单元会保留。" : "当前没有可读取的映射笔记。可补充目录，已完成单元会保留。" });
    if (plan.sourcePaths.length) {
      const sources = container.createEl("details");
      sources.createEl("summary", { text: "查看草案参考资料" });
      for (const path of plan.sourcePaths) sources.createEl("p", { text: path });
    }
    new Setting(container).setName("学习目标").addTextArea(field => field.setValue(draft.goal).onChange(value => { draft.goal = value; }));
    new Setting(container).setName("目标日期").setDesc("可选").addText(field => {
      field.inputEl.type = "date";
      field.setValue(draft.targetDate ?? "").onChange(value => { draft.targetDate = value || undefined; });
    });
    new Setting(container).setName("每周分钟数").addText(field => {
      field.inputEl.type = "number";
      field.inputEl.min = "1";
      field.setValue(weeklyMinutes).onChange(value => { weeklyMinutes = value; });
    });
    new Setting(container).setName("学习资料目录").setDesc("库内路径，一行一个。可留空。").addTextArea(field =>
      field.setValue(folders).onChange(value => { folders = value; }));
    new Setting(container).setName("待学单元").setDesc(plan.mode === "initialize" ? "一行一个，8 至 12 项。" : "一行一个，已完成的自动保留。").addTextArea(field =>
      field.setValue(units).onChange(value => { units = value; }));
    this.button("返回", () => this.pickTrack());
    this.button("确认保存计划", async () => {
      await saveLearningPlan(this.host, this.host.store, plan, { ...draft, weeklyMinutes: Number(weeklyMinutes), folders: lines(folders), units: lines(units) },
        () => this.request.signal.throwIfAborted());
      new Notice("学习计划已保存，可在最近操作中撤销。");
      this.close();
    });
  }

  private button(text: string, action: () => Promise<void>): void {
    const button = this.contentEl.createEl("button", { text, attr: { type: "button" } });
    button.onclick = async () => {
      if (this.busy || this.request.signal.aborted) return;
      this.busy = true; button.disabled = true;
      try { await action(); }
      catch (error) { this.notify(error); }
      finally { this.busy = false; button.disabled = false; }
    };
  }

  private notify(error: unknown): void {
    if (!this.request.signal.aborted) new Notice(error instanceof Error ? error.message : "学习计划暂时无法处理。");
  }
}

export function mountLearningPanel(host: LearningUiHost, parent: HTMLElement): () => Promise<void> {
  const section = parent.createEl("details", { cls: "lifeops-learning-panel" });
  section.createEl("summary", { text: "学习轨道" });
  const body = section.createDiv();
  let revision = 0;
  const refresh = async () => {
    const current = ++revision;
    try {
      const doc = await readLearningDocument(host.store), now = new Date();
      if (current !== revision || !section.isConnected) return;
      body.empty();
      for (const id of trackIds) {
        const track = visibleLearningTrack(host.store, existingLearningTrack(host.store, doc, id));
        const progress = learningProgress(track, now);
        const item = body.createEl("details");
        item.createEl("summary", { text: track.name + " · " + progress.completedUnits + "/" + progress.totalUnits + " 单元 · 本周 "
          + progress.recordedMinutes + (progress.weeklyMinutes ? "/" + progress.weeklyMinutes : "") + " 分钟" });
        item.createEl("p", { text: track.goal || "还没有学习计划。" });
        if (track.targetDate) item.createEl("p", { text: "目标日期 " + track.targetDate });
        if (track.nextPlan) item.createEl("p", { text: "已保存下周计划 · " + track.nextPlan.from + " 起 · " + track.nextPlan.weeklyMinutes + " 分钟" });
        if (progress.sessionsWithoutMinutes) item.createEl("p", { text: progress.sessionsWithoutMinutes + " 次记录未填写用时。" });
        const button = item.createEl("button", { text: track.goal ? "调整学习计划" : "生成初始计划", attr: { type: "button" } });
        button.onclick = () => openLearningPlan(host, track.goal ? "adjust" : "initialize", id);
        for (const unit of track.units) {
          const row = item.createDiv();
          row.createSpan({ text: unit.title });
          const select = row.createEl("select", { attr: { "aria-label": unit.title + "的学习状态" } });
          for (const [status, label] of Object.entries(UNIT_LABELS)) select.createEl("option", { text: label, attr: { value: status } });
          select.value = unit.status;
          select.onchange = async () => {
            const status = select.value as LearningUnitStatus;
            select.disabled = true;
            try {
              await host.saveLocalOperation("local_update_learning_unit", { id, unit: unit.id, status },
                store => updateLearningUnit(store, id, unit.id, status, todayString()));
              await refresh();
            } catch (error) {
              select.value = unit.status;
              new Notice(error instanceof Error ? error.message : "学习进度暂时无法保存。");
            } finally { select.disabled = false; }
          };
        }
      }
    } catch {
      if (current === revision && section.isConnected) {
        body.empty();
        body.createEl("p", { text: "学习记录暂时无法读取。", cls: "lifeops-muted" });
      }
    }
  };
  void refresh();
  return refresh;
}
