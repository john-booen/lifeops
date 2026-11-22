import { Modal } from "obsidian";
import type { ExternalVaultHost } from "./ui";
import { externalVaultScope } from "./catalog";
import { SelectionResultsView } from "./selectionResultsUi";
import { extractSelectedExternalJournalSignals, listSelectableExternalJournals, previewExternalJournal, selectExternalJournalExcerpt,
  SELECTED_JOURNAL_MAX_ITEMS, type ExternalJournalPreview, type ExternalJournalSelection } from "./selectedJournals";

export class ExternalJournalSelectionModal extends Modal {
  private readonly controller = new AbortController();
  private interval?: ReturnType<typeof setInterval>;
  private readonly base;
  private readonly sourceScope;
  constructor(private readonly host: ExternalVaultHost) { super(host.app); this.base = host.store; this.sourceScope = externalVaultScope(this.base); }

  private current = () => {
    this.controller.signal.throwIfAborted();
    if (this.host.store !== this.base || externalVaultScope(this.base) !== this.sourceScope) throw Error("资料范围已变化，请重新打开选段窗口。");
  };

  onOpen(): void {
    this.titleEl.setText("从外部日记选段整理"); this.contentEl.addClass("lifeops-external-journal-picker");
    this.contentEl.createEl("p", { text: "先在本机选日期、预览原文。只有加入下方清单的片段会在你提交后发送给已配置的文字模型；整理要点保存在本地，用于后续回顾。" });
    const status = this.contentEl.createEl("p", { attr: { role: "status" } });
    const picker = this.contentEl.createEl("select", { attr: { "aria-label": "选择日记日期和文件" } });
    const load = this.contentEl.createEl("button", { text: "本机预览原文" });
    const original = this.contentEl.createEl("textarea", { attr: { rows: "8", "aria-label": "日记原文，仅本机预览" } }); original.readOnly = true;
    const saved = this.contentEl.createEl("button", { text: "查看已整理要点" });
    const excerpt = this.contentEl.createEl("textarea", { attr: { rows: "3", "aria-label": "准备发送的连续原文片段", placeholder: "在上方选中文字，或在这里粘贴同一段原文；每段最多2000字。" } });
    const add = this.contentEl.createEl("button", { text: "加入待发送片段" });
    const queue = this.contentEl.createDiv({ cls: "lifeops-external-journal-queue" });
    const start = this.contentEl.createEl("button", { text: "整理所选片段", cls: "mod-cta" });
    const results = new SelectionResultsView(this.contentEl.createDiv({ cls: "lifeops-selected-journal-results" }), this.base, this.current);
    let preview: ExternalJournalPreview | undefined, chosen: ExternalJournalSelection[] = [], busy = false, generation = 0;
    const render = () => {
      queue.empty(); queue.createEl("p", { text: `待发送${chosen.length}段，每次最多${SELECTED_JOURNAL_MAX_ITEMS}段。未加入的原文不会发送。` });
      for (const item of chosen) {
        const row = queue.createDiv(); row.createEl("p", { text: `${item.date} · ${item.reference.split("/").at(-1)}` });
        row.createEl("pre", { text: item.excerpt });
        const remove = row.createEl("button", { text: "移除这段" }); remove.disabled = busy;
        remove.onclick = () => { if (busy) return; try { this.current(); chosen = chosen.filter(selected => selected !== item); results.clear(); render(); } catch { this.invalidate(); } };
      }
      start.disabled = busy || !chosen.length; load.disabled = busy || !picker.value; picker.disabled = busy;
      original.disabled = busy; excerpt.disabled = busy; add.disabled = busy || !preview || chosen.length >= SELECTED_JOURNAL_MAX_ITEMS;
      saved.disabled = busy || !preview;
    };
    picker.onchange = () => { if (busy) return; generation++; preview = undefined; original.value = ""; excerpt.value = ""; results.clear(); render(); };
    load.onclick = async () => {
      if (busy) return;
      const key = ++generation; busy = true; preview = undefined; original.value = ""; excerpt.value = ""; results.clear(); render();
      try {
        this.current(); const loaded = await previewExternalJournal(this.base, picker.value); this.current();
        if (key !== generation) return;
        const removed = chosen.filter(item => item.reference === loaded.reference && item.sourceHash !== loaded.sourceHash).length;
        chosen = chosen.filter(item => item.reference !== loaded.reference || item.sourceHash === loaded.sourceHash);
        preview = loaded; original.value = loaded.text;
        status.setText(`${loaded.date}原文仅在本机预览，请选取需要整理的连续片段。${removed ? `已移出${removed}段旧版本选段，请重新选取。` : ""}`);
      } catch { if (!this.controller.signal.aborted) status.setText("原文暂时读不到或范围已变化，请重新选择。"); }
      finally { if (!this.controller.signal.aborted && key === generation) { busy = false; render(); } }
    };
    saved.onclick = async () => { if (busy || !preview) return; busy = true; render(); try { this.current(); await results.showSaved(preview); } catch { this.invalidate(); } finally { if (!this.controller.signal.aborted) { busy = false; render(); } } };
    add.onclick = () => {
      try {
        this.current(); if (!preview || busy || chosen.length >= SELECTED_JOURNAL_MAX_ITEMS) return;
        const selected = selectExternalJournalExcerpt(preview, excerpt.value || original.value.slice(original.selectionStart, original.selectionEnd));
        if (chosen.some(item => item.reference === selected.reference && item.sourceHash === selected.sourceHash && item.excerptHash === selected.excerptHash)) throw Error("这段已经加入，无需重复。");
        chosen.push(selected); excerpt.value = ""; results.clear(); status.setText("已加入待发送清单，尚未发送。"); render();
      } catch (error) { if (!this.controller.signal.aborted) status.setText(error instanceof Error ? error.message : "请重新选择原文。"); }
    };
    start.onclick = async () => {
      if (busy || !chosen.length) return;
      const settings = this.base.settings.ai;
      if (settings.provider === "off" || !settings.dataDisclosureAccepted || !settings.endpoint || !settings.model) {
        status.setText("请先在设置中配置文字模型，并确认资料使用范围。当前预览和选段尚未发送。"); return;
      }
      const selected = chosen.map(item => ({ ...item }));
      busy = true; results.clear(); render();
      try {
        this.current(); status.setText("正在整理所选片段，关闭窗口可停止。");
        const result = await this.host.observeProvider("daily_review", "text", (request, _store, ai, current) => {
          const check = () => { this.current(); current(); };
          return extractSelectedExternalJournalSignals(this.base, selected, (messages, options) => ai.extractJournalSignals(messages, { ...request, ...options }),
            request.signal ?? this.controller.signal, check);
        }, this.controller.signal);
        this.current(); status.setText(`已保存${result.saved}段，${result.existing}段已有结果。只整理了所选片段，不能据此判断整篇或整周没有其他计划。`);
        await results.showSelected(selected); this.current();
        await this.host.refreshViews().catch(() => undefined);
      } catch { if (!this.controller.signal.aborted) { status.setText("整理中断或原文有更新。已保存片段保留，重新预览后可继续；重复提交会跳过已保存片段。"); await results.showSelected(selected); } }
      finally { if (!this.controller.signal.aborted) { busy = false; render(); } }
    };
    render(); status.setText("正在读取可选日期，不发送原文。");
    void listSelectableExternalJournals(this.base).then(rows => {
      this.current();
      for (const item of rows) picker.createEl("option", { text: item.label, value: item.reference });
      if (rows.length) picker.value = rows[0].reference;
      status.setText(rows.length ? "请选择日期，再在本机预览并选段。" : "没有找到可选的外部日记，请先核对已接入目录。"); render();
    }).catch(() => { if (!this.controller.signal.aborted) status.setText("日期清单暂时不可用，请重新打开。"); });
    this.interval = setInterval(() => { try { this.current(); } catch { this.invalidate(); } }, 500);
  }

  private invalidate(): void {
    this.controller.abort(); if (this.interval) clearInterval(this.interval); this.interval = undefined;
    this.contentEl.empty(); this.contentEl.createEl("p", { text: "资料范围已变化，旧预览与选段已清除，请重新打开。" });
  }
  onClose(): void { this.controller.abort(); if (this.interval) clearInterval(this.interval); this.interval = undefined; this.contentEl.empty(); }
}

export function openSelectedExternalJournalScan(host: ExternalVaultHost): void {
  const modal = new ExternalJournalSelectionModal(host); host.register(() => modal.close()); modal.open();
}
