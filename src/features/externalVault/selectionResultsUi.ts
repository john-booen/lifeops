import type { StoreHost } from "../../store/settingsSlice";
import { assertSelectedJournalResultsCurrent, readSavedJournalResults, readSelectedJournalResults, type SelectedJournalResults } from "./selectedJournalResults";
import type { ExternalJournalPreview, ExternalJournalSelection } from "./selectedJournals";

/** Plain selectable text; no rendering of model or diary HTML. */
export class SelectionResultsView {
  private generation = 0;
  constructor(private readonly el: HTMLElement, private readonly store: StoreHost, private readonly current: () => void) {}
  clear(): void { this.generation++; this.el.empty(); }
  showSelected(chosen: readonly ExternalJournalSelection[]): Promise<void> { return this.show(() => readSelectedJournalResults(this.store, chosen, this.current)); }
  showSaved(preview: ExternalJournalPreview): Promise<void> { return this.show(() => readSavedJournalResults(this.store, preview, this.current)); }
  private async show(read: () => Promise<SelectedJournalResults>): Promise<void> {
    this.clear(); const generation = this.generation;
    const check = () => { this.current(); if (generation !== this.generation) throw Error("查看已更新。"); };
    const status = this.el.createEl("p", { text: "正在本机读取已保存要点，不调用模型。", attr: { role: "status" } });
    try {
      check(); const result = await read(); check();
      status.setText(result.saved ? `已保存要点：${result.saved}段。可直接选中文字或复制。` : "这篇日记还没有当前版本的选段整理结果。请选段后提交整理。");
      if (!result.saved) return;
      const text = this.el.createEl("textarea", { attr: { rows: "10", "aria-label": "已整理的选段要点" } }); text.readOnly = true; text.value = result.text;
      const copy = this.el.createEl("button", { text: "复制整理要点" });
      copy.onclick = async () => {
        if (copy.disabled) return; copy.disabled = true;
        try { check(); await assertSelectedJournalResultsCurrent(this.store, result, check); check(); }
        catch { if (generation === this.generation) { this.clear(); this.el.createEl("p", { text: "原文、资料范围或保存结果已变化，请重新查看。" }); } return; }
        try { await navigator.clipboard.writeText(result.text); check(); copy.setText("已复制整理要点"); }
        catch { try { check(); status.setText("复制未完成，可在上方选中文字后按 Cmd+C 或 Ctrl+C。"); } catch { /* Closed or replaced. */ } }
        finally { copy.disabled = false; }
      };
    } catch { if (generation === this.generation) { this.el.empty(); this.el.createEl("p", { text: "暂时无法核对已保存要点，请重新预览原文后查看。" }); } }
  }
}
