import { Modal, type App } from "obsidian";
import { listUnderstandingUpdates, prepareUnderstandingUpdate, type UnderstandingUpdate, type UnderstandingUpdateStatus } from "./noteUnderstandingUpdates";
import type { StoreHost } from "./store/settingsSlice";
const labels: Record<UnderstandingUpdateStatus, string> = {
  needs_review: "原文已变化，需要核对新版本", not_reviewed: "当前原文尚未整理过", current_candidate: "已有当前版本候选，等你单独确认",
  current_record: "已有当前版本记录，确认情况请看记忆页", missing: "原文已移动或缺失，请先找回", excluded: "原文已排除，不会读取", too_large: "原文过长，请先选择较短资料", blocked_content: "含已停止使用或更正的旧内容，未重新提供"
};
export class NoteUnderstandingUpdatesModal extends Modal {
  private closed = true; private version = 0; private busy = false;
  constructor(app: App, private readonly store: StoreHost, private readonly compose: (message: string, assertCurrent: () => void) => Promise<void>,
    private readonly assertHost: () => void, private readonly closedCallback: () => void, private readonly selectedPath?: string) { super(app); }
  onOpen() { this.closed = false; void this.refresh(); }
  onClose() { this.closed = true; this.version++; this.contentEl.empty(); this.closedCallback(); }
  private async refresh() {
    const version = ++this.version; this.contentEl.empty(); this.contentEl.addClass("lifeops-local-record-picker"); this.contentEl.createEl("h2", { text: "哪些原文需要重新核对" });
    this.contentEl.createEl("p", { text: "只在本地检查已有理解的原文和当前笔记。选择一篇后放入对话，由你另行发送；新候选不会沿用旧确认。" });
    const status = this.contentEl.createEl("p", { text: "正在核对原文更新…", attr: { role: "status" } }), assertCurrent = () => { if (this.closed || version !== this.version) throw new Error("原文核对窗口已关闭。"); this.assertHost(); };
    const close = this.contentEl.createEl("button", { text: "关闭" }); close.onclick = () => this.close();
    try {
      const result = await listUnderstandingUpdates({ store: this.store, refreshViews: async () => {}, assertCurrent }, this.selectedPath); assertCurrent(); status.setText(result.rows.length ? "以下状态仅说明原文版本，不确认理解或任务。" : "还没有已整理的原文。你可以先打开一篇原始笔记，再打开此入口。");
      for (const row of result.rows) this.renderRow(row, assertCurrent, status);
      if (result.remainingSources) this.contentEl.createEl("p", { text: `本次还有${result.remainingSources}篇既有来源未检查，不代表它们没有变化。` });
      const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
      const refresh = actions.createEl("button", { text: "刷新状态" }); refresh.onclick = () => { if (!this.closed && !this.busy) void this.refresh(); };
    } catch (error) { if (!this.closed && version === this.version) status.setText(error instanceof Error ? error.message : "原文更新暂时无法核对，资料已保留。"); }
  }
  private renderRow(row: UnderstandingUpdate, assertCurrent: () => void, status: HTMLElement) {
    const card = this.contentEl.createEl("article", { cls: "lifeops-steward-memory-card" }); card.createEl("h3", { text: row.path.split("/").at(-1) }); card.createEl("p", { text: row.path, cls: "lifeops-muted" }); card.createEl("p", { text: labels[row.status] });
    if (!["needs_review", "not_reviewed"].includes(row.status)) return;
    const button = card.createEl("button", { text: "放入对话，核对后发送" }); button.onclick = async () => {
      if (this.closed || this.busy) return; this.busy = true; this.contentEl.querySelectorAll("button").forEach(item => { item.disabled = item.textContent !== "关闭"; });
      try { assertCurrent(); await prepareUnderstandingUpdate(row, { store: this.store, refreshViews: async () => {}, assertCurrent }, this.compose); assertCurrent(); this.close(); }
      catch (error) { if (!this.closed) status.setText(error instanceof Error ? error.message : "未准备请求，原文和记忆未修改。"); }
      finally { this.busy = false; if (!this.closed) this.contentEl.querySelectorAll("button").forEach(item => { item.disabled = false; }); }
    };
  }
}
