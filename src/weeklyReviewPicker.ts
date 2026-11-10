import { Modal, Notice, type App } from "obsidian";
import { addDays, todayString } from "./date";
import { allowedWeeklyReviewSource, weeklyReviewDates, weeklyReviewDocumentDate } from "./weeklyReview";
import type { StoreHost } from "./store/settingsSlice";

export class WeeklyReviewPickerModal extends Modal {
  private closed = true;
  constructor(app: App, private readonly store: StoreHost,
    private readonly prepare: (message: string, assertCurrent: () => void) => Promise<void>,
    private readonly assertHost: () => void, private readonly closedCallback: () => void) { super(app); }
  onOpen(): void {
    this.closed = false; this.contentEl.empty(); this.contentEl.addClass("lifeops-local-record-picker");
    this.contentEl.createEl("h2", { text: "从原文开始周回顾" });
    this.contentEl.createEl("p", { text: "选择一至七天和最多六篇原始笔记。下一步放入对话，由你点击发送；回顾需要核对支持、反例和未知信息。" });
    const start = this.contentEl.createEl("label", { text: "开始日期" }).createEl("input", { attr: { type: "date", "aria-label": "周回顾开始日期" } }), end = this.contentEl.createEl("label", { text: "结束日期" }).createEl("input", { attr: { type: "date", "aria-label": "周回顾结束日期" } });
    start.value = addDays(todayString(), -6); end.value = todayString();
    const rows = this.contentEl.createDiv(), selects: HTMLSelectElement[] = [], selected = this.app.workspace.getActiveFile()?.path;
    const choices = () => this.app.vault.getMarkdownFiles().map(file => file.path).filter(path => allowedWeeklyReviewSource(this.store, path)).sort();
    const addRow = () => { if (selects.length >= 6) return; const select = rows.createEl("label", { text: `原文 ${selects.length + 1}` }).createEl("select", { attr: { "aria-label": `原文 ${selects.length + 1}` } }); select.createEl("option", { text: "请选择原始笔记", attr: { value: "" } });
      for (const path of choices()) select.createEl("option", { text: `${path} · ${weeklyReviewDocumentDate(path) ?? "笔记日期未知"}`, attr: { value: path } });
      if (selects.length === 0 && selected && allowedWeeklyReviewSource(this.store, selected)) select.value = selected; selects.push(select); };
    addRow();
    const more = this.contentEl.createEl("button", { text: "再选一篇" }); more.onclick = () => { if (!this.closed) addRow(); more.disabled = selects.length >= 6; };
    this.contentEl.createEl("p", { text: "日期未知的笔记可以选择，但不能据此计算发生次数。生成的报告不作为本人原文。", cls: "lifeops-muted" });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" }); const cancel = actions.createEl("button", { text: "取消" }); cancel.onclick = () => this.close();
    const submit = actions.createEl("button", { text: "放入对话，核对后发送", cls: "mod-cta" });
    const assertCurrent = () => { if (this.closed) throw new Error("周回顾选择窗口已关闭。"); this.assertHost(); };
    submit.onclick = async () => { if (submit.disabled || this.closed) return; submit.disabled = true; more.disabled = true; start.disabled = true; end.disabled = true; selects.forEach(select => { select.disabled = true; });
      try { assertCurrent(); const period = weeklyReviewDates(start.value, end.value), paths = selects.map(select => select.value).filter(Boolean);
        if (!paths.length || new Set(paths).size !== paths.length) throw new Error("请选择一至六篇不重复的原文。");
        if (paths.some(path => !allowedWeeklyReviewSource(this.store, path) || weeklyReviewDocumentDate(path) && (weeklyReviewDocumentDate(path)! < period.startDate || weeklyReviewDocumentDate(path)! > period.endDate))) throw new Error("原文已不可读取，或笔记日期不在范围内，请重新选择。");
        const message = `请对 ${period.startDate} 至 ${period.endDate} 做周回顾。只读取这些原始笔记：\n${paths.map(path => `- ${path}`).join("\n")}\n先核对固定版本的原文，再生成包含支持、反例和未知信息的周回顾核对卡；只保存草稿，不确认记忆或完成任务。`;
        await this.prepare(message, assertCurrent); assertCurrent(); this.close();
      } catch (error) { if (!this.closed) new Notice(error instanceof Error ? error.message : "未准备周回顾，请重新选择。"); }
      finally { if (!this.closed) { submit.disabled = false; more.disabled = selects.length >= 6; start.disabled = false; end.disabled = false; selects.forEach(select => { select.disabled = false; }); } }
    };
  }
  onClose(): void { this.closed = true; this.contentEl.empty(); this.closedCallback(); }
}
