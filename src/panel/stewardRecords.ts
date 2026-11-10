import { Modal, Notice, type App } from "obsidian";
import { personalMemoryOrigin, personalMemorySourceAssessment, type PersonalMemoryKind, type PersonalMemoryRecord, type PersonalMemoryReview } from "../personalMemory";
import type { AgentActionSuggestion } from "../types";

export interface StewardOperationSummary {
  id: string;
  title: string;
  status: "executing" | "verified" | "failed" | "reverted";
  updatedAt: string;
  canUndo: boolean;
  targetPath?: string;
}

export interface StewardRecordsController {
  readonly app: App;
  getStewardMemories(): Promise<PersonalMemoryRecord[]>;
  getStewardOperations(): Promise<StewardOperationSummary[]>;
  openStewardSource(path: string, sourceId?: string): Promise<void>;
  undoStewardOperation(id: string): Promise<void>;
  prepareStewardMemoryReview(record: PersonalMemoryRecord, review: PersonalMemoryReview): Promise<AgentActionSuggestion[]>;
  openStewardSettings(): void;
  openUnderstandingUpdates?(path?: string): void;
}

const operationStatuses = { executing: "处理中", verified: "已保存并核对", failed: "没有完成", reverted: "已撤销" };

export function stewardMemoryStatusLabel(record: PersonalMemoryRecord): string {
  if (record.status === "forgotten") return "已停止使用";
  if (record.archivedAt) return "已归档";
  if (record[personalMemorySourceAssessment]?.usable === false) return "来源待核对，暂不使用";
  if (record.status === "candidate") return "待你确认";
  if (record.summarySource && !record.confirmedAt) return "从摘要自动记下";
  return record.truth === "explicit_fact" && Number.isFinite(Date.parse(record.confirmedAt ?? ""))
    ? "已记录确认时间" : "已记录，确认信息待核对";
}

export async function renderStewardAbout(
  container: HTMLElement,
  controller: StewardRecordsController,
  onActions: (actions: AgentActionSuggestion[]) => void
): Promise<void> {
  const section = container.createEl("section", { cls: "lifeops-steward-records lifeops-neural-about" });
  const heading = section.createDiv({ cls: "lma-heading" });
  const copy = heading.createDiv({ cls: "lma-heading-copy" });
  copy.createEl("p", { text: "关于我", cls: "lma-eyebrow" });
  copy.createEl("h1", { text: "管家记住了什么", cls: "lifeops-steward-page-title" });
  copy.createEl("p", { text: "对话和日摘要里有长期用处的事实会记在这里。你可以搜索、查看来源、编辑或删除。", cls: "lifeops-muted" });
  if (controller.openUnderstandingUpdates) { const updates = heading.createEl("button", { text: "检查原文更新", cls: "lma-button", attr: { type: "button" } }); updates.onclick = () => controller.openUnderstandingUpdates?.(); }
  const list = section.createDiv({ cls: "lifeops-steward-records-list", attr: { "aria-live": "polite", "aria-busy": "true" } });
  list.createEl("p", { text: "正在读取记忆…", cls: "lma-state" });
  try {
    const records = await controller.getStewardMemories();
    if (!section.isConnected) return;
    list.empty();
    if (!records.length) {
      list.createEl("p", { text: "还没有保存的个人记忆。以后有了记忆候选，会在这里等你核对。", cls: "lma-state" });
      return;
    }
    const controls = section.createDiv({ cls: "lifeops-steward-memory-filters" });
    section.insertBefore(controls, list);
    const search = controls.createEl("input", { attr: { type: "search", placeholder: "搜索记忆", "aria-label": "搜索记忆" } });
    const category = controls.createEl("select", { attr: { "aria-label": "记忆类别" } });
    category.createEl("option", { text: "全部类别", attr: { value: "" } });
    for (const [value, label] of Object.entries(memoryKinds)) category.createEl("option", { text: label, attr: { value } });
    const status = controls.createEl("select", { attr: { "aria-label": "记忆状态" } });
    for (const [value, label] of [["all", "全部状态"], ["active", "未归档"], ["archived", "已归档"], ["forgotten", "已删除"]]) {
      status.createEl("option", { text: label, attr: { value } });
    }
    const render = () => {
      list.empty();
      const visible = filterStewardMemories(records, search.value, category.value, status.value);
      if (!visible.length) list.createEl("p", { text: "没有符合条件的记忆。", cls: "lma-state" });
      for (const record of visible) renderMemoryCard(list, controller, record, onActions);
    };
    search.addEventListener("input", render);
    category.addEventListener("change", render);
    status.addEventListener("change", render);
    render();
  } catch {
    if (!section.isConnected) return;
    list.empty();
    list.createEl("p", { text: "记忆暂时无法安全读取，现有内容已保留。请稍后重试，或把这条提示反馈给我。", cls: "lma-state" });
  } finally {
    if (section.isConnected) list.setAttribute("aria-busy", "false");
  }
}

const memoryKinds: Record<PersonalMemoryKind, string> = {
  core_profile: "核心画像", current_state: "当前状态", episode: "经历", pattern_candidate: "模式", user_rule: "个人规则"
};

export function filterStewardMemories(records: PersonalMemoryRecord[], query: string, category: string, state: string): PersonalMemoryRecord[] {
  const normalized = (value: string) => value.normalize("NFKC").trim().toLowerCase();
  const term = normalized(query);
  return records.filter(record => {
    if (category && record.kind !== category) return false;
    const status = record.status === "forgotten" ? "forgotten" : record.archivedAt ? "archived" : "active";
    if (state !== "all" && state !== status) return false;
    return !term || normalized([record.content, ...record.tags, personalMemoryOrigin(record), memoryKinds[record.kind]].join(" ")).includes(term);
  });
}

function renderMemoryCard(list: HTMLElement, controller: StewardRecordsController, record: PersonalMemoryRecord,
  onActions: (actions: AgentActionSuggestion[]) => void): void {
  const card = list.createEl("article", { cls: "lifeops-steward-memory-card" });
  card.createEl("h2", { text: record.content, cls: "lma-memory-title" });
  card.createEl("p", { text: `${stewardMemoryStatusLabel(record)} · ${record.truth === "inference" ? "管家的推测" : "记录为明确陈述"}${record.sensitive ? " · 涉及私人信息" : ""}`, cls: "lma-meta" });
  const created = Number.isFinite(Date.parse(record.createdAt)) ? new Date(record.createdAt).toLocaleString("zh-CN") : "时间待核对";
  card.createEl("p", { text: memoryKinds[record.kind] + " · " + personalMemoryOrigin(record) + " · " + created, cls: "lma-meta" });
  if (record[personalMemorySourceAssessment]?.usable === false) card.createEl("p", { text: record[personalMemorySourceAssessment]!.reason, cls: "lma-warning" });
  if (record.archivedAt) {
    card.createEl("p", { text: "归档于 " + new Date(record.archivedAt).toLocaleString("zh-CN") + "。", cls: "lma-warning" });
  } else if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
    card.createEl("p", { text: "这条记忆已过期，不会作为当前记忆使用。", cls: "lma-warning" });
  }
  const sources = card.createDiv({ cls: "lifeops-steward-memory-sources" });
  if (!record.sourceRefs.length) sources.createEl("p", { text: "暂无可核对的来源。" });
  for (const source of record.sourceRefs) {
    const label = source.sourceId.startsWith("confirmed:")
      ? `${source.sourceId.startsWith("confirmed:conversation:") ? "对话" : "查看确认记录"}：${Number.isFinite(Date.parse(source.capturedAt)) ? new Date(source.capturedAt).toLocaleString("zh-CN") : "时间待核对"}`
      : `查看来源：${source.path}`;
    const button = sources.createEl("button", { text: label, attr: { type: "button" } });
    button.onclick = () => {
      void controller.openStewardSource(source.path, source.sourceId).catch(() => {
        new Notice("这份来源目前无法打开。请核对来源位置，原资料没有修改。");
      });
    };
  }
  if (record.status === "forgotten") return;
  const actions = card.createDiv({ cls: "lifeops-steward-memory-actions" });
  const invalidVersion = !!record.sourceBinding && record[personalMemorySourceAssessment]?.usable === false;
  if (invalidVersion && !record.summarySource && controller.openUnderstandingUpdates) {
    const update = actions.createEl("button", { text: "核对原文新版本", attr: { type: "button" } }); update.onclick = () => controller.openUnderstandingUpdates?.(record.sourceRefs.find(ref => ref.contentHash)?.path);
  }
  const choices: Array<{ label: string; decision: PersonalMemoryReview["decision"] }> = [
    ...(!invalidVersion && (record.status === "candidate" || record.truth !== "explicit_fact" || !Number.isFinite(Date.parse(record.confirmedAt ?? "")) || record[personalMemorySourceAssessment]?.usable === false)
      ? [{ label: "确认这条理解", decision: "confirm" as const }] : []),
    ...(!invalidVersion ? [{ label: "编辑", decision: "correct" as const }] : []), { label: "删除记忆", decision: "forget" }
  ];
  for (const choice of choices) {
    const button = actions.createEl("button", { text: choice.label, attr: { type: "button" } });
    button.onclick = () => new StewardMemoryReviewModal(controller.app, controller, record, choice.decision, onActions).open();
  }
}

class StewardMemoryReviewModal extends Modal {
  private closed = false;
  private preparing = false;

  constructor(
    app: App,
    private readonly controller: StewardRecordsController,
    private readonly record: PersonalMemoryRecord,
    private readonly decision: PersonalMemoryReview["decision"],
    private readonly onActions: (actions: AgentActionSuggestion[]) => void
  ) { super(app); }

  onOpen(): void {
    this.closed = false;
    this.titleEl.setText(this.decision === "correct" ? "纠正管家的理解" : this.decision === "forget" ? "停止使用这条记忆" : "核对这条理解");
    this.contentEl.createEl("p", { text: `当前内容：${this.record.content}` });
    this.contentEl.createEl("p", { text: this.decision === "forget"
      ? "确认后，这条记忆及相同旧内容将停止使用。原始笔记不会被删除；已有操作记录仍会保留。"
      : "下一步会生成确认卡。在确认卡中同意后，才会保存修改。" });
    let input: HTMLTextAreaElement | undefined;
    if (this.decision === "correct") {
      input = this.contentEl.createEl("textarea", { attr: { rows: "5", "aria-label": "正确的理解" } });
      input.value = this.record.content;
      input.style.width = "100%";
    }
    const feedback = this.contentEl.createEl("p", { attr: { role: "status" } });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    const prepare = actions.createEl("button", { text: "生成确认卡", cls: "mod-cta" });
    prepare.onclick = async () => {
      if (this.preparing || this.closed) return;
      const corrected = input?.value.trim() ?? "";
      if (this.decision === "correct" && !corrected) { feedback.setText("请先填写正确的理解。"); return; }
      this.preparing = true;
      prepare.disabled = true;
      try {
        const review: PersonalMemoryReview = this.decision === "correct"
          ? { decision: "correct", content: corrected } : { decision: this.decision };
        const proposals = await this.controller.prepareStewardMemoryReview(this.record, review);
        if (this.closed) return;
        if (!proposals.length) { feedback.setText("确认卡没有生成，记忆保持不变。请刷新后重试。"); return; }
        this.onActions(proposals);
        this.close();
      } catch {
        if (!this.closed) feedback.setText("这条记忆可能已经变化，确认卡没有生成。请关闭后刷新记忆，再重新核对。");
      } finally {
        this.preparing = false;
        if (!this.closed) prepare.disabled = false;
      }
    };
  }

  onClose(): void { this.closed = true; this.contentEl.empty(); }
}

export function openStewardOperations(app: App, controller: StewardRecordsController): void {
  new StewardOperationsModal(app, controller).open();
}

class StewardOperationsModal extends Modal {
  private closed = false;
  private loadingVersion = 0;
  private undoBusy = false;

  constructor(app: App, private readonly controller: StewardRecordsController) { super(app); }

  onOpen(): void {
    this.closed = false;
    this.titleEl.setText("最近的操作");
    void this.refresh();
  }

  onClose(): void { this.closed = true; this.loadingVersion += 1; this.contentEl.empty(); }

  private async refresh(): Promise<void> {
    const version = ++this.loadingVersion;
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "正在读取操作记录…", attr: { role: "status" } });
    try {
      const records = await this.controller.getStewardOperations();
      if (this.closed || version !== this.loadingVersion) return;
      this.contentEl.empty();
      this.contentEl.createEl("p", { text: "显示最近 30 条操作。撤销只处理你选中的这一条；资料已有后续修改时，会停止并保留当前内容。" });
      if (!records.length) this.contentEl.createEl("p", { text: "还没有记录到操作。" });
      for (const record of records) {
        const card = this.contentEl.createEl("article", { cls: "lifeops-steward-operation-card" });
        card.createEl("h3", { text: record.title });
        if (record.targetPath) card.createEl("p", { text: `资料：${record.targetPath}`, cls: "lifeops-steward-operation-target" });
        const timestamp = new Date(record.updatedAt);
        card.createEl("p", { text: `${operationStatuses[record.status]} · ${Number.isNaN(timestamp.getTime()) ? "时间待核对" : timestamp.toLocaleString("zh-CN", { hour12: false })}` });
        if (!record.canUndo) continue;
        const button = card.createEl("button", { text: "撤销这一条" });
        button.onclick = async () => {
          if (this.undoBusy || this.closed) return;
          this.undoBusy = true;
          for (const item of this.contentEl.querySelectorAll("button")) item.disabled = true;
          try { await this.controller.undoStewardOperation(record.id); }
          catch { new Notice("撤销没有完成，当前资料已保留。请稍后核对。"); }
          finally {
            this.undoBusy = false;
            if (!this.closed) await this.refresh();
          }
        };
      }
    } catch {
      if (this.closed || version !== this.loadingVersion) return;
      this.contentEl.empty();
      this.contentEl.createEl("p", { text: "操作记录暂时无法安全读取。请保留当前资料，并把这条提示反馈给我。", attr: { role: "status" } });
    }
  }
}
