import { Modal, Notice, Setting, type App } from "obsidian";
import { todayString } from "../../date";
import type { StoreHost } from "../../store/settingsSlice";
import type { LifeOpsSettings } from "../../types";
import type { LocalOperationHost } from "../serviceHost";
import { assertSelectedFileAllowed } from "../screenshots/file";
import { readScreenshotImage, SCREENSHOT_MAX_BYTES, type ScreenshotImage } from "../screenshots/image";
import { combineHealthScreenshotDays, healthDay, healthMetricKeys, HEALTH_METRICS, type HealthDay } from "./model";
import { assertHealthScreenshotReady } from "./screenshot";
import { assertHealthEntriesAllowed, recordHealthEntries } from "./store";

export interface HealthScreenshotHost extends LocalOperationHost {
  app: App;
  store: StoreHost;
  settings: LifeOpsSettings;
  register(callback: () => void): void;
  recognizeHealthScreenshot(image: ScreenshotImage, signal: AbortSignal): Promise<HealthDay[]>;
}

export function openHealthScreenshot(host: HealthScreenshotHost): void {
  const modal = new HealthScreenshotModal(host);
  host.register(() => modal.close());
  modal.open();
}

class HealthScreenshotModal extends Modal {
  private readonly request = new AbortController();

  constructor(private readonly host: HealthScreenshotHost) { super(host.app); }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("健康截图");
    contentEl.addClass("lifeops-form-modal");
    contentEl.createEl("p", { text: "点击发送后，原图会交给已配置的视觉服务。保存前可修改日期和数值。" });
    try { assertHealthScreenshotReady(this.host.settings); }
    catch (error) { contentEl.createEl("p", { text: (error as Error).message }); return; }
    const picker = contentEl.createEl("input", { attr: { type: "file", accept: "image/png,image/jpeg", "aria-label": "选择健康截图" } });
    const status = contentEl.createEl("p", { attr: { role: "status" } });
    new Setting(contentEl).addButton(button => {
      button.setButtonText("发送并识别").setCta().setDisabled(true);
      picker.onchange = () => button.setDisabled(!picker.files?.length);
      button.onClick(async () => {
        const selected = picker.files?.[0];
        if (!selected || picker.disabled || this.request.signal.aborted) return;
        const store = this.host.store;
        const folder = store.settings.folders.health;
        const current = () => {
          if (this.request.signal.aborted || store !== this.host.store || folder !== store.settings.folders.health) {
            throw Error("识别窗口或健康记录目录已变化，请关闭后重新选图。");
          }
        };
        button.setDisabled(true);
        picker.disabled = true;
        status.setText("正在识别…");
        try {
          if (selected.size > SCREENSHOT_MAX_BYTES) throw Error("截图大小须在 4 MB 以内。");
          await assertSelectedFileAllowed(store, selected, false);
          current();
          const image = readScreenshotImage(await selected.arrayBuffer());
          current();
          const rows = await this.host.recognizeHealthScreenshot(image, this.request.signal);
          current();
          if (!rows.length) throw Error("没有识别到可核对的单日健康数据。");
          this.preview(rows, image.digest, current);
        } catch (error) {
          if (this.request.signal.aborted) return;
          status.setText((error as Error).message || "识别未完成。");
          picker.disabled = false;
          button.setDisabled(false);
        }
      });
    });
  }

  onClose(): void {
    this.request.abort();
    this.contentEl.empty();
  }

  private preview(rows: HealthDay[], digest: string, current: () => void): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("核对健康记录");
    contentEl.createEl("p", { text: "缺少完整日期时请补选日期。同一天的不同指标可一起保存。统计采用每项最新值，历史继续保留。" });
    const fields = rows.map((row, index) => this.renderEntry(row, index));
    const status = contentEl.createEl("p", { attr: { role: "status" } });
    new Setting(contentEl).addButton(button => button.setButtonText("确认并保存").setCta().onClick(async () => {
      if (button.buttonEl.disabled) return;
      const inputs = fields.flatMap(({ pick, date, metrics }) => [pick, date, ...metrics.map(([, field]) => field)]);
      button.setDisabled(true);
      for (const input of inputs) input.disabled = true;
      try {
        current();
        const selected = fields.filter(row => row.pick.checked).map(({ date, metrics }) =>
          healthDay(date.value, Object.fromEntries(metrics.map(([key, field]) => [
            key, field.validity.badInput ? NaN : field.value.trim() ? field.valueAsNumber : undefined
          ]))));
        if (!selected.length || selected.some(entry => entry.date > todayString() || !healthMetricKeys.some(key => entry[key] !== undefined))) {
          throw Error("请勾选至少一条有指标的记录，并核对日期。");
        }
        const entries = combineHealthScreenshotDays(selected);
        const assertCurrent = () => {
          current();
          assertHealthEntriesAllowed(this.host.store, entries);
        };
        assertCurrent();
        let saved = 0;
        await this.host.saveLocalOperation("manual_health_screenshot", { digest, entries }, async store => {
          assertCurrent();
          saved = await recordHealthEntries(store, entries);
        }, { assertCurrent });
        await this.host.refreshViews().catch(() => undefined);
        new Notice(saved ? `已核对并保存 ${saved} 天的健康记录。可在「最近操作」撤销。` : "所选记录与已有数据一致。");
        if (!this.request.signal.aborted) this.close();
      } catch (error) {
        if (!this.request.signal.aborted) {
          status.setText((error as Error).message || "健康记录未读回，请核对最近操作。");
          for (const input of inputs) input.disabled = false;
          button.setDisabled(false);
        }
      }
    }));
  }

  private renderEntry(row: HealthDay, index: number) {
    const box = this.contentEl.createEl("fieldset");
    box.createEl("legend", { text: `第 ${index + 1} 条` });
    const select = box.createEl("label", { text: "保存此条 " });
    const pick = select.createEl("input", { attr: { type: "checkbox" } });
    pick.checked = true;
    const dateLabel = box.createEl("label", { text: "日期 " });
    const date = dateLabel.createEl("input", { attr: { type: "date", max: todayString() } });
    date.value = row.date;
    const metrics = healthMetricKeys.map(key => {
      const metric = HEALTH_METRICS[key];
      const label = box.createEl("label", { text: `${metric.label}（${metric.unit}） ` });
      const input = label.createEl("input", { attr: { type: "number", min: "0", max: String(metric.max), step: key === "steps" ? "1" : "0.01" } });
      input.value = row[key]?.toString() ?? "";
      return [key, input] as const;
    });
    return { pick, date, metrics };
  }
}
