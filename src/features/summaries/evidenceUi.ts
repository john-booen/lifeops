import { Modal, type App, type Command, type EventRef, type MarkdownView } from "obsidian";
import type { StoreHost } from "../../store/settingsSlice";
import { readSummaryEvidence, summaryEvidencePathAllowed, type SummaryEvidence } from "./evidence";

export interface SummaryEvidenceHost {
  app: App;
  store: StoreHost;
  unloaded: boolean;
  register(callback: () => void): void;
  registerEvent(ref: EventRef): void;
  addCommand(command: Command): void;
}

const generationLabel = (kind: string) => kind === "model" ? "模型整理" : kind === "local" ? "本地草稿" : "生成方式未标注";

export class SummaryEvidenceModal extends Modal {
  private closed = true;
  private generation = 0;
  private request?: AbortController;
  private timer?: ReturnType<typeof globalThis.setInterval>;
  private snapshot?: SummaryEvidence;
  private body!: HTMLElement;
  private status!: HTMLElement;
  private refresh!: HTMLButtonElement;
  private opening = false;
  constructor(private readonly host: SummaryEvidenceHost, private readonly path: string) { super(host.app); }

  onOpen(): void {
    this.closed = false; this.contentEl.empty(); this.contentEl.addClass("lifeops-local-record-picker", "lifeops-summary-evidence");
    this.contentEl.createEl("h2", { text: "摘要依据与原文入口" });
    this.contentEl.createEl("p", { text: "在本机回看当前允许读取的日记与下级摘要，不调用模型。当前文件不代表它们都参与过旧报告，也不等于原话已经逐篇核对。", cls: "lifeops-muted" });
    this.status = this.contentEl.createEl("p", { attr: { role: "status" } });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    this.refresh = actions.createEl("button", { text: "刷新依据", attr: { "aria-label": "刷新摘要依据" } });
    this.refresh.onclick = () => { void this.load(); };
    actions.createEl("button", { text: "关闭" }).onclick = () => this.close();
    this.body = this.contentEl.createDiv({ cls: "lifeops-summary-evidence-body" });
    this.timer = globalThis.setInterval(() => {
      if (!this.snapshot || this.closed) return;
      try { this.snapshot.assertDisplayCurrent(); } catch { this.invalidate("资料范围或文件已变化，请刷新依据。"); }
    }, 500);
    void this.load();
  }

  private async load(): Promise<void> {
    if (this.closed) return;
    const version = ++this.generation, store = this.host.store;
    this.request?.abort(); this.request = new AbortController();
    this.snapshot = undefined; this.body.empty(); this.status.setText("正在读取本地依据…"); this.refresh.disabled = true;
    const current = () => {
      if (this.closed || this.generation !== version || this.host.unloaded || this.host.store !== store) throw Error("查看窗口或资料库已变化。");
    };
    try {
      const data = await readSummaryEvidence(store, this.path, { signal: this.request.signal, assertCurrent: current });
      current(); this.snapshot = data; this.draw(data); this.status.setText("本地只读查看，未改写报告或原文。");
    } catch (error) {
      if (!this.closed && this.generation === version) this.invalidate(error instanceof Error ? error.message : "本地依据暂不可读取，请重试。");
    } finally { if (!this.closed && this.generation === version) this.refresh.disabled = false; }
  }

  private draw(data: SummaryEvidence): void {
    const level = { day: "日", week: "周", month: "月" }[data.period.level];
    this.body.createEl("h3", { text: `${level}摘要：${data.period.from} 至 ${data.period.to}` });
    this.body.createEl("p", { text: `报告统计到 ${data.through}。标记为${generationLabel(data.generatedBy)}${data.edited ? "，版本未核实" : ""}。` });
    if (!data.sourceScopeCurrent) this.body.createEl("p", { text: "旧摘要的来源状态暂不可验证；下方只列当前范围找到的文件。", cls: "lifeops-muted" });
    this.sourceButton(this.body, "打开这份摘要", data.path, data);
    this.body.createEl("h3", { text: "当前找到的日记" });
    this.body.createEl("p", { text: `截止范围共${data.days.length}天：找到日记${data.journalFiles}篇，分布在${data.journalDays}天。篇数与天数分别计算。` });
    const table = this.body.createEl("table"), head = table.createEl("thead").createEl("tr");
    for (const label of ["日期", "找到的日记", "打开原文"]) head.createEl("th", { text: label });
    const rows = table.createEl("tbody");
    for (const day of data.days) {
      const row = rows.createEl("tr"); row.createEl("td", { text: day.date });
      row.createEl("td", { text: day.files ? `${day.files}篇` : "未找到日记" });
      const links = row.createEl("td");
      for (const note of day.notes) this.sourceButton(links, note.path.split("/").pop() ?? note.date, note.path, data);
    }
    if (data.omittedFiles) this.body.createEl("p", { text: `另有${data.omittedFiles}篇未展开。上方篇数按允许范围内找到的全部文件计算，不代表其余原文没写。` });
    this.body.createEl("p", { text: "未找到只表示本次允许范围未找到，不等于没写或没做。文件日期也不自动等于事件发生日期。", cls: "lifeops-muted" });
    if (data.period.level !== "day") this.drawChildren(data);
    this.body.createEl("p", { text: "这里不逐条核对任务、打卡或交易登记，也不重新生成报告或保存长期记忆。", cls: "lifeops-muted" });
  }

  private drawChildren(data: SummaryEvidence): void {
    this.body.createEl("h3", { text: "当前可回看的下级摘要" });
    this.body.createEl("p", { text: `旧报告的“已完成下级摘要”标记为${data.savedInputCount}份；当前可回看${data.children.length}份。份数和“周期结束”标记都不证明原文齐全或实际行动天数。` });
    for (const child of data.children) {
      const outside = child.period.from < data.period.from || child.period.to > data.through;
      this.sourceButton(this.body, `${child.period.from} 至 ${child.period.to} · ${generationLabel(child.generatedBy)}${child.edited ? " · 版本未核实" : ""}${outside ? " · 跨截止范围" : ""}`, child.path, data);
    }
    if (data.period.level === "month") this.body.createEl("p", { text: "跨月周稿仅供回看，不能整份当成本月原文或本月数字。", cls: "lifeops-muted" });
  }

  private sourceButton(parent: HTMLElement, label: string, path: string, data: SummaryEvidence): void {
    const button = parent.createEl("button", { text: label, cls: "lifeops-summary-source-button", attr: { "data-source-path": path, "aria-label": "打开来源：" + path, title: path } });
    button.onclick = async () => {
      if (this.closed || this.opening || this.snapshot !== data) return;
      const version = this.generation;
      this.opening = true; button.disabled = true;
      try {
        const file = await data.fileFor(path);
        if (this.closed || this.snapshot !== data || this.host.unloaded) return;
        await this.app.workspace.getLeaf("tab").openFile(file, { state: { mode: "preview" } });
        this.close();
      } catch { if (!this.closed && this.generation === version) this.invalidate("来源或读取范围已变化，请刷新依据。"); }
      finally { this.opening = false; button.disabled = false; }
    };
  }

  private invalidate(message: string): void { this.snapshot = undefined; this.body.empty(); this.status.setText(message); }
  onClose(): void {
    this.closed = true; this.generation++; this.request?.abort(); this.snapshot = undefined;
    if (this.timer !== undefined) globalThis.clearInterval(this.timer);
    this.timer = undefined; this.contentEl.empty();
  }
}

export function registerSummaryEvidenceUi(host: SummaryEvidenceHost): void {
  const open = (path: string) => {
    if (host.unloaded || !summaryEvidencePathAllowed(host.store, path)) return;
    const modal = new SummaryEvidenceModal(host, path); host.register(() => modal.close()); modal.open();
  };
  host.addCommand({ id: "inspect-lifeops-summary-evidence", name: "查看摘要依据", checkCallback: checking => {
    const path = host.app.workspace.getActiveFile()?.path;
    const available = !host.unloaded && !!path && summaryEvidencePathAllowed(host.store, path);
    if (available && !checking) open(path!);
    return available;
  } });
  host.registerEvent(host.app.workspace.on("file-menu", (menu, file) => {
    if (!host.unloaded && summaryEvidencePathAllowed(host.store, file.path)) menu.addItem(item => item.setTitle("查看摘要依据").setIcon("files").onClick(() => open(file.path)));
  }));
  registerHeaderActions(host, open);
}

function registerHeaderActions(host: SummaryEvidenceHost, open: (path: string) => void): void {
  const actions = new Map<MarkdownView, HTMLElement>();
  const refresh = () => {
    const views = (host.app.workspace.getLeavesOfType?.("markdown") ?? []).map(leaf => leaf.view as MarkdownView);
    for (const [view, action] of actions) if (host.unloaded || !views.includes(view) || !view.file || !summaryEvidencePathAllowed(host.store, view.file.path)) {
      action.remove(); actions.delete(view);
    }
    if (host.unloaded) return;
    for (const view of views) {
      if (actions.has(view) || !view.file || !summaryEvidencePathAllowed(host.store, view.file.path) || typeof view.addAction !== "function") continue;
      const action = view.addAction("files", "查看摘要依据", () => { if (view.file) open(view.file.path); });
      action.setAttribute("data-lifeops-summary-evidence", "true"); actions.set(view, action);
    }
  };
  host.registerEvent(host.app.workspace.on("file-open", refresh));
  host.registerEvent(host.app.workspace.on("layout-change", refresh));
  host.register(() => { for (const action of actions.values()) action.remove(); actions.clear(); });
  refresh();
}
