import { Modal, Notice, type App } from "obsidian";
import { parseHealthCsv } from "../../csv";
import type { StoreHost } from "../../store/settingsSlice";
import type { HealthEntry } from "../../types";
import type { LocalOperationHost } from "../serviceHost";
import { HEALTH_METRICS, healthMetricKeys } from "./model";
import { recordHealthEntries } from "./store";

interface CsvImportHost extends LocalOperationHost {
  app: App;
  store(): StoreHost;
  register(callback: () => void): void;
}

export function openHealthCsvImport(host: CsvImportHost): void {
  const modal = new HealthCsvImportModal(host);
  host.register(() => modal.close());
  modal.open();
}

export class HealthCsvImportModal extends Modal {
  private text = "";
  private generation = 0;

  constructor(private readonly host: CsvImportHost) { super(host.app); }

  onOpen(): void {
    this.contentEl.addClass("lifeops-form-modal");
    this.edit();
  }

  onClose(): void {
    this.generation++;
    this.contentEl.empty();
  }

  private edit(): void {
    this.generation++;
    const parent = this.contentEl;
    parent.empty();
    this.setTitle("导入健康 CSV");
    parent.createEl("p", {
      text: "支持日期、睡眠小时、步数、跑步距离、体重、静息心率，以及主观运动、疲劳、精力和备注。英文列名见使用指南。"
    });
    const textarea = parent.createEl("textarea", { attr: {
      rows: "10", "aria-label": "健康 CSV", placeholder: "date,sleepHours,steps\n2026-05-25,7.5,8000"
    } });
    textarea.style.width = "100%";
    textarea.value = this.text;
    this.button("核对导入内容", async () => {
      this.text = textarea.value;
      const entries = parseHealthCsv(this.text);
      if (!entries.length) throw Error("没有可核对的健康记录。");
      this.preview(entries);
    }).addClass("mod-cta");
  }

  private preview(entries: HealthEntry[]): void {
    const generation = ++this.generation;
    const store = this.host.store(), folder = store.settings.folders.health;
    const parent = this.contentEl;
    parent.empty();
    this.setTitle("确认导入健康记录");
    parent.createEl("p", { text: `共 ${entries.length} 条。没填的字段保留原记录，同一天的同一指标按最后一条有效数值统计。` });
    const list = parent.createEl("ul");
    list.style.maxHeight = "22em";
    list.style.overflowY = "auto";
    for (const entry of entries) {
      const numbers = healthMetricKeys.flatMap(key => {
        const { label, unit } = HEALTH_METRICS[key];
        return entry[key] === undefined ? [] : [`${label} ${entry[key]} ${unit}`];
      });
      list.createEl("li", { text: [entry.date, ...numbers, entry.exercise ? `运动 ${entry.exercise}` : "",
        entry.fatigue === undefined ? "" : `疲劳 ${entry.fatigue}`, entry.energy === undefined ? "" : `精力 ${entry.energy}`,
        entry.note ? `备注 ${entry.note}` : ""].filter(Boolean).join(" · ") });
    }
    this.button("返回修改", async () => this.edit());
    this.button(`确认导入 ${entries.length} 条`, async () => {
      const current = () => {
        if (generation !== this.generation || this.host.store() !== store || store.settings.folders.health !== folder) {
          throw Error("导入窗口或健康记录位置已变化，请返回修改并重新核对。");
        }
      };
      current();
      let saved = 0;
      await this.host.saveLocalOperation("manual_health_csv_batch", { entries }, async scope => {
        current();
        saved = await recordHealthEntries(scope, entries);
      }, { assertCurrent: current });
      await this.host.refreshViews().catch(() => undefined);
      new Notice(saved ? `已导入 ${saved} 条健康记录，可在「最近操作」撤销。` : "与已有数据一致。");
      if (generation === this.generation) this.close();
    }).addClass("mod-cta");
  }

  private button(label: string, action: () => Promise<void>): HTMLButtonElement {
    const button = this.contentEl.createEl("button", { text: label, attr: { type: "button" } });
    button.onclick = async () => {
      if (button.disabled) return;
      button.disabled = true;
      try { await action(); }
      catch (error) { new Notice(error instanceof Error ? error.message : "健康 CSV 导入失败，请核对内容。"); }
      finally { button.disabled = false; }
    };
    return button;
  }
}
