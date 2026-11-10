import { Modal, Notice, Setting, type App } from "obsidian";
import { todayString } from "../../date";
import { tradeTime } from "./inputs";
import { isTradeDraft, TRADE_MARKETS, type Trade, type TradeDraft, type TradePatch } from "./types";

const TEXT_FIELDS = { openedAt: "开仓日期或时间", closedAt: "平仓时间", symbol: "品种", qtyUnit: "数量单位",
  modelId: "模型名称或编号", modelVersionId: "规则版本编号", emotion: "情绪" } as const;
const NUMBER_FIELDS = { qty: "数量", entry: "入场价", exit: "出场价", stop: "止损价", target: "目标价",
  fees: "手续费", pnl: "已知盈亏", riskAmount: "计划亏损额" } as const;
type TextKey = keyof typeof TEXT_FIELDS;
type NumberKey = keyof typeof NUMBER_FIELDS;
type FormKey = TextKey | NumberKey | "market" | "direction" | "currency" | "planned" | "notes" | "attachments";
type Fields = Partial<Record<FormKey, string>>;

export class TradeEntryModal extends Modal {
  private readonly initial: Fields;
  private readonly values: Fields;

  constructor(app: App, private readonly onSubmit: (draft: TradeDraft, patch: TradePatch) => Promise<void>, private readonly trade?: Trade) {
    super(app);
    this.initial = trade ? this.initialFields(trade) : { openedAt: todayString() };
    this.values = { ...this.initial };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lifeops-form-modal");
    contentEl.createEl("h2", { text: this.trade ? "修改交易" : "记录交易" });
    const dropdown = (key: FormKey, label: string, options: Record<string, string>) => new Setting(contentEl).setName(label).addDropdown(control => {
      control.addOptions(options).setValue(this.values[key] ?? "").onChange(value => { this.values[key] = value; });
    });
    dropdown("market", "市场", { "": "请选择", ...Object.fromEntries(TRADE_MARKETS.map(market => [market, market])) });
    dropdown("direction", "方向", { "": "请选择", long: "做多", short: "做空" });
    dropdown("currency", "币种", { "": "按市场默认", CNY: "CNY 人民币", USD: "USD 美元" });
    dropdown("planned", "是否计划内", { "": "未说明", yes: "计划内", no: "计划外" });
    for (const [key, label] of Object.entries(TEXT_FIELDS) as [TextKey, string][]) {
      const setting = new Setting(contentEl).setName(label);
      if (key === "openedAt") setting.setDesc("只记日期可填 YYYY-MM-DD。有具体时间可填 YYYY-MM-DD HH:mm，按本机时区。");
      if (key === "closedAt") setting.setDesc("可留空。有具体时间可填 YYYY-MM-DD HH:mm。");
      setting.addText(control => control.setValue(this.values[key] ?? "").onChange(value => { this.values[key] = value; }));
    }
    for (const [key, label] of Object.entries(NUMBER_FIELDS) as [NumberKey, string][]) {
      const setting = new Setting(contentEl).setName(label);
      if (key === "pnl") setting.setDesc("可填负数或零。留空时按价格、数量和费用计算。");
      setting.addText(control => control.setValue(this.values[key] ?? "").onChange(value => { this.values[key] = value; }));
    }
    for (const [key, label] of [["notes", "复盘备注"], ["attachments", "附件路径（每行一个）"]] as const) {
      new Setting(contentEl).setName(label).addTextArea(control => control.setValue(this.values[key] ?? "")
        .onChange(value => { this.values[key] = value; }));
    }
    new Setting(contentEl).addButton(button => button.setButtonText("保存交易记录").setCta().onClick(async () => {
      button.setDisabled(true);
      try {
        const draft = this.draft();
        const patch = Object.fromEntries(Object.keys(this.values).filter(key => this.values[key as FormKey] !== this.initial[key as FormKey])
          .map(key => [key, draft[key as FormKey]])) as TradePatch;
        if (Object.hasOwn(patch, "openedAt")) patch.openedAtPrecision = draft.openedAtPrecision;
        await this.onSubmit(draft, patch);
        this.close();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "交易未保存，请重试。");
        button.setDisabled(false);
      }
    }));
  }

  private initialFields(trade: Trade): Fields {
    const entries = [...Object.keys(TEXT_FIELDS), ...Object.keys(NUMBER_FIELDS), "market", "direction", "currency", "notes"];
    const values = Object.fromEntries(entries.map(key => [key, String(trade[key as keyof Trade] ?? "")]));
    return { ...values, openedAt: trade.openedAtPrecision ? trade.openedAt.slice(0, 10) : trade.openedAt,
      pnl: trade.pnlSource === "stated" ? String(trade.pnl) : "", planned: trade.planned === null ? "" : trade.planned ? "yes" : "no",
      attachments: trade.attachments.join("\n") };
  }

  private draft(): TradeDraft {
    const value = this.values;
    const text = Object.fromEntries(Object.keys(TEXT_FIELDS).map(key => [key, value[key as TextKey]?.trim() || undefined]));
    const numeric = Object.fromEntries(Object.keys(NUMBER_FIELDS).map(key => {
      const raw = value[key as NumberKey]?.trim();
      return [key, raw ? Number(raw) : undefined];
    }));
    const close = value.closedAt?.trim() ? tradeTime(value.closedAt.trim()) : undefined;
    if (close?.openedAtPrecision) throw new Error("平仓时间请填写具体时刻，未知可以留空。");
    const draft = { ...text, ...numeric, ...tradeTime(value.openedAt?.trim()), closedAt: close?.openedAt,
      market: value.market, direction: value.direction, currency: value.currency || undefined,
      planned: value.planned === "yes" ? true : value.planned === "no" ? false : null,
      notes: value.notes?.trim() || undefined, attachments: value.attachments?.split(/\r?\n/).map(path => path.trim()).filter(Boolean),
      source: { kind: "form" } };
    if (!isTradeDraft(draft)) throw new Error("请核对市场、品种、方向、日期和数字。");
    return draft;
  }
}
