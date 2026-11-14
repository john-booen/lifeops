import { App, Modal, Notice } from "obsidian";
import { PHONE_INBOX_PATH, type PhoneInboxReceipt } from "./model";
import { PhoneInboxBusyError, summarizePhoneInbox, type PhoneInbox } from "./service";

export class PhoneInboxModal extends Modal {
  private generation = 0;

  constructor(app: App, private readonly inbox: PhoneInbox) { super(app); }

  onOpen(): void { void this.render(); }
  onClose(): void { this.generation++; this.contentEl.empty(); }

  private async render(): Promise<void> {
    const generation = ++this.generation;
    const host = this.contentEl;
    host.empty();
    this.setTitle("手机随手记");
    if (!this.inbox.enabled) {
      host.createEl("p", { text: "可在 LifeOps 设置中启用；收件箱及回执目录须允许读取。" });
      return;
    }
    host.createEl("p", { text: PHONE_INBOX_PATH });
    if (!this.inbox.autoProcessingReady) {
      host.createEl("p", { text: "文字模型未配置或未授权，合格原行会等待。现在可在本地检查需要核对的记录。" });
    }
    this.button(host, "打开收件箱", async () => {
      await this.inbox.createFile();
      await this.app.workspace.openLinkText(PHONE_INBOX_PATH, "", true);
      this.close();
    }, false);
    const status = host.createEl("p", { attr: { role: "status" } });
    this.button(host, "检查新记录", async () => {
      status.setText("正在检查新记录…");
      try { await this.inbox.scan(true); }
      finally { status.setText(""); }
    });
    try {
      const { receipts, source, pending, unfinished } = await this.inbox.snapshot();
      if (generation !== this.generation) return;
      if (source === "unreadable") host.createEl("p", { text: "当前无法读取收件箱原文，已有回执仍可查看。" });
      if (pending) host.createEl("p", { text: `${pending} 条完整记录待检查。` });
      if (unfinished) host.createEl("p", { text: "最后一行还没有换行。写完后换行，或确认内容完整后点「检查新记录」。" });
      host.createEl("p", { text: receipts.length ? summarizePhoneInbox(receipts) : "暂无回执。" });
      const list = host.createEl("ol");
      for (const row of receipts) this.renderRow(list, row);
    } catch {
      if (generation === this.generation) host.createEl("p", { text: "回执暂时无法安全读取。" });
    }
  }

  private renderRow(list: HTMLElement, row: PhoneInboxReceipt): void {
    const item = list.createEl("li");
    const label = row.undone ? "已撤销" : { processing: "待核对", saved: "已保存", review: "待核对", confirm: "待确认", dismissed: "已归档" }[row.status];
    item.createEl("strong", { text: row.sourceUnavailable ? `原行待核对 · ${label}` : `第 ${row.line} 行 · ${label}` });
    item.createEl("p", { text: row.message });
    if (row.status === "confirm" && row.action) {
      item.createEl("p", { text: [row.action.title, row.action.content, row.action.description].join(" · ") });
      if (!row.sourceUnavailable) this.button(item, "确认执行", () => this.inbox.resolve(row.id, "confirm"));
    }
    if (["confirm", "review", "processing"].includes(row.status)) {
      this.button(item, row.status === "confirm" ? "取消操作" : "归档回执", () => this.inbox.resolve(row.id, "dismiss"));
    }
    if (row.operationId && !row.undone) this.button(item, "撤销这条", () => this.inbox.resolve(row.id, "undo"));
  }

  private button(host: HTMLElement, text: string, action: () => Promise<void>, refresh = true): void {
    const button = host.createEl("button", { text, attr: { type: "button" } });
    const generation = this.generation;
    button.onclick = async () => {
      if (generation !== this.generation || button.disabled) return;
      button.disabled = true;
      try {
        await action();
        if (refresh && generation === this.generation) await this.render();
      } catch (error) {
        new Notice(error instanceof PhoneInboxBusyError ? error.message : "操作未读回成功，请核对「最近操作」和手机随手记回执。");
      } finally {
        button.disabled = false;
      }
    };
  }
}
