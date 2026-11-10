import { Modal, type App } from "obsidian";
import { todayString } from "./date";
import type { LocalRecordKind } from "./localRecordNotes";

/** Pick the date before opening the existing Obsidian editor. Closing is read-only. */
export class LocalRecordNoteModal extends Modal {
  private closed = false;
  private busy = false;

  constructor(app: App, private readonly openNote: (input: { kind: LocalRecordKind; date: string }, isCurrent: () => boolean) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("打开日记或复盘");
    this.contentEl.addClass("lifeops-local-record-picker");
    this.contentEl.createEl("p", { text: "选择记录的日期。已有内容会直接打开；没有记录时建立空白模板。打开后可以直接写字，Obsidian 会自动保存。" });
    const kindLabel = this.contentEl.createEl("label", { text: "记录类型" });
    const kind = kindLabel.createEl("select", { attr: { "aria-label": "记录类型" } });
    for (const [value, label] of [["morning", "晨间日记"], ["evening", "晚间日记"], ["trading-review", "交易复盘"]]) {
      kind.createEl("option", { text: label, attr: { value } });
    }
    const dateLabel = this.contentEl.createEl("label", { text: "记录日期" });
    const date = dateLabel.createEl("input", { attr: { type: "date", "aria-label": "记录日期" } });
    date.value = todayString();
    const feedback = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    const open = actions.createEl("button", { text: "打开记录", cls: "mod-cta" });
    open.onclick = async () => {
      if (this.busy || this.closed) return;
      if (!date.value || !date.checkValidity()) { feedback.setText("请选择有效的记录日期。"); return; }
      this.busy = true;
      open.disabled = true;
      kind.disabled = true;
      date.disabled = true;
      feedback.setText("正在打开…");
      try {
        await this.openNote({ kind: kind.value as LocalRecordKind, date: date.value }, () => !this.closed);
        if (!this.closed) this.close();
      } catch {
        if (!this.closed) feedback.setText("记录没有打开，已有内容已保留。可以重试；若再次失败，请把这条提示告诉我。");
      } finally {
        this.busy = false;
        if (!this.closed) { open.disabled = false; kind.disabled = false; date.disabled = false; }
      }
    };
  }

  onClose(): void { this.closed = true; this.contentEl.empty(); }
}
