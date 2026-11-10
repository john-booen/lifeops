import { Modal, Notice, Setting, type App } from "obsidian";
import type { StoreHost } from "../../store/settingsSlice";
import type { LifeOpsSettings } from "../../types";
import type { LocalOperationHost } from "../serviceHost";
import { confirmTradeCsv, previewTradeCsv, readTradeCsv, TRADE_CSV_FIELDS, TRADE_CSV_MAX_BYTES,
  type TradeCsvField, type TradeCsvPreview, type TradeCsvTable, type TradeCsvTemplate } from "./csvImport";
import { readTradeDatabase } from "./persistence";
import { tradeNumber } from "./pnl";
import { TRADE_MARKETS, type TradeCurrency, type TradeMarket } from "./types";

export interface TradeCsvHost extends LocalOperationHost {
  app: App;
  store: StoreHost;
  settings: LifeOpsSettings;
  saveSettings(): Promise<void>;
  register(callback: () => void): void;
}

export function openTradeCsvImport(host: TradeCsvHost): void {
  const modal = new TradeCsvImportModal(host);
  host.register(() => modal.close());
  modal.open();
}

class TradeCsvImportModal extends Modal {
  private table?: TradeCsvTable;
  private template: TradeCsvTemplate = { name: "", columns: {} };
  private generation = 0;
  private closed = false;

  constructor(private readonly host: TradeCsvHost) { super(host.app); }

  onOpen(): void { this.closed = false; this.mapping(); }
  onClose(): void { this.closed = true; this.generation++; }

  private mapping(): void {
    this.generation++;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lifeops-form-modal");
    contentEl.createEl("h2", { text: "导入交易 CSV" });
    contentEl.createEl("p", { text: "每行一笔交易。方向列使用持仓方向或开仓买卖。文件先在本机预览。" });
    const file = contentEl.createEl("input", { attr: { type: "file", accept: ".csv,text/csv", "aria-label": "选择交易 CSV" } });
    file.onchange = () => { const selected = file.files?.[0]; if (selected) void this.chooseFile(selected); };
    const table = this.table;
    if (!table) return;
    contentEl.createEl("h3", { text: `${table.name} · 前 ${Math.min(10, table.rows.length)} 行` });
    this.renderTable(contentEl, table);
    this.renderTemplate(contentEl, table);
    this.button(contentEl, "预览解析结果", async () => {
      const generation = this.generation;
      const template = structuredClone(this.template);
      const preview = previewTradeCsv(table, template, (await readTradeDatabase(this.host.store)).trades, this.host.settings.tradingContractMultipliers);
      this.assertCurrent(generation);
      this.confirmation(table, template, preview);
    });
  }

  private async chooseFile(file: File): Promise<void> {
    const generation = ++this.generation;
    try {
      if (file.size > TRADE_CSV_MAX_BYTES) throw new Error("交易 CSV 太大，请拆成较小文件。");
      const table = readTradeCsv(await file.text(), file.name);
      this.assertCurrent(generation);
      this.table = table;
      const columns = Object.fromEntries(Object.entries(TRADE_CSV_FIELDS).flatMap(([key, label]) => {
        const header = table.headers.find(name => name === label || name.toLowerCase() === key.toLowerCase());
        return header ? [[key, header]] : [];
      }));
      this.template = { name: "", columns };
      this.mapping();
    } catch (error) {
      if (!this.closed && generation === this.generation) new Notice(error instanceof Error ? error.message : "CSV 无法读取。");
    }
  }

  private renderTable(parent: HTMLElement, table: TradeCsvTable): void {
    const scroll = parent.createDiv();
    scroll.style.overflowX = "auto";
    const preview = scroll.createEl("table");
    const headers = preview.createEl("thead").createEl("tr");
    for (const header of table.headers) headers.createEl("th", { text: header });
    const body = preview.createEl("tbody");
    for (const cells of table.rows.slice(0, 10)) {
      const row = body.createEl("tr");
      for (const [index] of table.headers.entries()) row.createEl("td", { text: cells[index]?.slice(0, 120) ?? "" });
    }
  }

  private renderTemplate(parent: HTMLElement, table: TradeCsvTable): void {
    const saved = Array.isArray(this.host.settings.tradingCsvTemplates) ? this.host.settings.tradingCsvTemplates.filter(item =>
      typeof item?.name === "string" && !!item.columns && typeof item.columns === "object" && !Array.isArray(item.columns)) : [];
    new Setting(parent).setName("列映射模板").addDropdown(dropdown => {
      dropdown.addOption("", "新建模板或临时映射");
      for (const [index, item] of saved.entries()) if (item?.name && item.columns) dropdown.addOption(String(index), item.name);
      const index = saved.findIndex(item => item?.name === this.template.name);
      dropdown.setValue(index < 0 ? "" : String(index)).onChange(value => {
        if (value !== "" && saved[Number(value)]) this.template = structuredClone(saved[Number(value)]);
        else this.template.name = "";
        this.mapping();
      });
    });
    new Setting(parent).setName("模板名称").addText(input => input.setValue(this.template.name).onChange(value => { this.template.name = value.trim(); }));
    for (const [key, label] of Object.entries(TRADE_CSV_FIELDS) as [TradeCsvField, string][]) {
      new Setting(parent).setName(label).addDropdown(dropdown => {
        dropdown.addOption("", "未选择");
        for (const header of table.headers) dropdown.addOption(header, header);
        const configured = this.template.columns[key];
        if (configured && !table.headers.includes(configured)) dropdown.addOption(configured, `${configured}（文件缺此列）`);
        dropdown.setValue(configured ?? "").onChange(value => { this.generation++; this.template.columns[key] = value || undefined; });
      });
    }
    new Setting(parent).setName("没有市场列时的默认市场").addDropdown(dropdown => {
      dropdown.addOption("", "未选择");
      for (const market of TRADE_MARKETS) dropdown.addOption(market, market);
      dropdown.setValue(this.template.market ?? "").onChange(value => { this.generation++; this.template.market = (value as TradeMarket) || undefined; });
    });
    new Setting(parent).setName("没有币种列时的默认币种").addDropdown(dropdown => dropdown
      .addOption("", "按市场默认").addOption("CNY", "CNY").addOption("USD", "USD")
      .setValue(this.template.currency ?? "").onChange(value => { this.generation++; this.template.currency = value as TradeCurrency || undefined; }));
    this.button(parent, "保存模板", async () => {
      const template = structuredClone(this.template);
      if (!template.name || template.name.length > 50) throw new Error("请填入 1 至 50 字的模板名称。");
      previewTradeCsv(table, template, []);
      const next = [...saved.filter(item => item?.name !== template.name), template];
      this.host.settings.tradingCsvTemplates = next;
      try { await this.host.saveSettings(); }
      catch (error) {
        if (this.host.settings.tradingCsvTemplates === next) this.host.settings.tradingCsvTemplates = saved;
        throw error;
      }
      if (!this.closed) this.mapping();
      new Notice("交易 CSV 模板已保存。");
    });
  }

  private confirmation(table: TradeCsvTable, template: TradeCsvTemplate, preview: TradeCsvPreview): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "确认导入交易" });
    contentEl.createEl("p", { text: `可导入 ${preview.ready} 笔，重复 ${preview.duplicates} 笔，无效 ${preview.invalid} 行。仅写入可导入项。` });
    const list = contentEl.createEl("ul");
    list.style.maxHeight = "22em";
    list.style.overflowY = "auto";
    for (const row of preview.rows) list.createEl("li", { text: `第 ${row.line} 条 · ${row.kind === "invalid" ? row.reason
      : `${row.kind === "duplicate" ? "重复，跳过" : "可导入"} · ${row.draft.symbol} ${row.draft.direction === "long" ? "多" : "空"} · ${row.draft.openedAt} · 数量 ${row.draft.qty ?? "未知"} · ${row.draft.entry ?? "?"}→${row.draft.exit ?? "?"} · 费用 ${row.draft.fees ?? "未提供"} · 盈亏 ${row.pnl === undefined ? "未知" : tradeNumber(row.pnl)} ${row.currency}${row.pnlSource === "computed" ? "（计算）" : row.pnlSource === "stated" ? "（CSV）" : ""}`}` });
    this.button(contentEl, "返回修改映射", async () => this.mapping());
    if (preview.ready) this.button(contentEl, `确认导入 ${preview.ready} 笔`, async () => {
      const generation = this.generation;
      const count = await confirmTradeCsv(this.host, table, template, preview, () => this.assertCurrent(generation));
      if (!this.closed) this.close();
      new Notice(`已导入 ${count} 笔交易，可在最近操作中撤销。`);
    }).addClass("mod-cta");
  }

  private assertCurrent(generation: number): void {
    if (this.closed || this.generation !== generation) throw new Error("导入窗口已变化，未继续写入。");
  }

  private button(parent: HTMLElement, label: string, action: () => Promise<void>): HTMLButtonElement {
    const button = parent.createEl("button", { text: label, attr: { type: "button" } });
    button.onclick = async () => {
      if (button.disabled) return;
      button.disabled = true;
      try { await action(); }
      catch (error) { new Notice(error instanceof Error ? error.message : "交易 CSV 操作未完成。"); }
      finally { button.disabled = false; }
    };
    return button;
  }
}
