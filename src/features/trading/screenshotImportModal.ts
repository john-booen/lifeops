import { Modal, Notice, Setting, type App } from "obsidian";
import { assertSelectedFileAllowed } from "../screenshots/file";
import type { StoreHost } from "../../store/settingsSlice";
import type { LifeOpsSettings } from "../../types";
import type { LocalOperationHost } from "../serviceHost";
import { readTradeDatabase } from "./persistence";
import { tradeNumber } from "./pnl";
import { confirmTradeScreenshot, previewTradeScreenshot, readTradeScreenshot, TRADE_SCREENSHOT_MAX_BYTES,
  type parseTradeScreenshotRows, type TradeScreenshot, type TradeScreenshotPreview } from "./screenshotImport";
import { assertTradeScreenshotReady } from "./screenshotVision";

export interface TradeScreenshotHost extends LocalOperationHost {
  app: App;
  store: StoreHost;
  settings: LifeOpsSettings;
  register(callback: () => void): void;
  recognizeTradeScreenshot(image: TradeScreenshot, signal: AbortSignal): Promise<ReturnType<typeof parseTradeScreenshotRows>>;
}

export function openTradeScreenshotImport(host: TradeScreenshotHost, clipboardImage?: File): void {
  const modal = new TradeScreenshotImportModal(host, clipboardImage);
  host.register(() => modal.close());
  modal.open();
}

class TradeScreenshotImportModal extends Modal {
  private selection?: File;
  private request?: AbortController;
  private openGeneration = 0;

  constructor(private readonly host: TradeScreenshotHost, private clipboardImage?: File) { super(host.app); }

  onOpen(): void { this.choose(); }
  onClose(): void {
    this.openGeneration++;
    this.request?.abort("trade screenshot closed");
    this.request = undefined;
    this.selection = undefined;
    this.clipboardImage = undefined;
    this.contentEl.empty();
  }

  private choose(): void {
    const generation = ++this.openGeneration;
    this.request?.abort("trade screenshot replaced");
    this.request = undefined;
    this.selection = this.clipboardImage;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lifeops-form-modal");
    contentEl.createEl("h2", { text: "截图记交易" });
    contentEl.createEl("p", { text: "所选原图会发送给已配置的视觉服务。请在确认卡逐笔核对后保存。" });
    try { assertTradeScreenshotReady(this.host.settings); }
    catch (error) { contentEl.createEl("p", { text: (error as Error).message }); return; }
    const picker = contentEl.createEl("input", { attr: { type: "file", accept: "image/png,image/jpeg", "aria-label": "选择交易截图" } });
    const status = contentEl.createEl("p", { text: this.selection ? "已粘贴 1 张图片。" : "", attr: { role: "status" } });
    new Setting(contentEl).addButton(button => {
      const recognize = async () => {
        const selected = this.selection, store = this.host.store;
        if (!selected || generation !== this.openGeneration || this.request) return;
        const request = this.request = new AbortController();
        const folder = store.settings.folders.tradingReviews;
        const current = () => {
          if (request.signal.aborted || this.openGeneration !== generation || this.host.store !== store) {
            throw Error("截图确认已失效，请重新选择。");
          }
          if (folder !== store.settings.folders.tradingReviews) throw Error("交易记录目录已变化，请重选截图。");
        };
        button.setDisabled(true);
        picker.disabled = true;
        status.setText("正在识别这张截图…");
        try {
          assertTradeScreenshotReady(this.host.settings);
          if (selected.size > TRADE_SCREENSHOT_MAX_BYTES) throw Error("请选择 4 MB 以内的截图。");
          await assertSelectedFileAllowed(store, selected, selected === this.clipboardImage);
          current();
          const image = readTradeScreenshot(await selected.arrayBuffer());
          current();
          const rows = await this.host.recognizeTradeScreenshot(image, request.signal);
          current();
          const preview = previewTradeScreenshot(rows, image.digest, (await readTradeDatabase(store)).trades,
            this.host.settings.tradingContractMultipliers);
          current();
          this.selection = undefined;
          this.clipboardImage = undefined;
          this.confirm(rows, image.digest, preview, current);
        } catch (error) {
          if (!request.signal.aborted && this.openGeneration === generation) {
            status.setText(error instanceof Error ? error.message : "识别未完成，请换一张清晰截图重试。");
            picker.disabled = false;
            button.setDisabled(false);
          }
        } finally { if (this.request === request) this.request = undefined; }
      };
      button.setButtonText("发送并识别").setCta().setDisabled(!this.selection).onClick(recognize);
      picker.onchange = () => {
        this.clipboardImage = undefined;
        this.selection = picker.files?.[0];
        button.setDisabled(!this.selection);
        status.setText(this.selection ? "已选 1 张图片。" : "");
      };
      if (this.clipboardImage) void recognize();
    });
  }

  private confirm(rows: ReturnType<typeof parseTradeScreenshotRows>, digest: string, preview: TradeScreenshotPreview, current: () => void): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "确认截图里的交易" });
    contentEl.createEl("p", { text: `可保存 ${preview.ready} 笔。请逐笔核对日期、时区、金额后勾选保存。重算值可用时，入账按重算值。` });
    const list = contentEl.createEl("ul");
    const choices = new Map<number, HTMLInputElement>();
    let updateButton = () => {};
    const picked = () => [...choices].filter(([, field]) => field.checked).map(([line]) => line);
    for (const row of preview.rows) {
      if (row.kind === "invalid") {
        list.createEl("li", { text: `第 ${row.line} 笔 · 不保存 · ${row.reason}` });
        continue;
      }
      const { draft, multiplier } = row;
      const time = draft.openedAtPrecision ? draft.openedAt.slice(0, 10) : draft.openedAt.replace("T", " ");
      const item = list.createEl("li", { text: [`第 ${row.line} 笔`, row.kind === "duplicate" ? "重复，跳过" : "可保存",
        draft.symbol, draft.market, draft.direction === "long" ? "多" : "空", `开仓 ${time}`, draft.closedAt && `平仓 ${draft.closedAt.replace("T", " ")}`,
        `数量 ${draft.qty ?? "未知"}${draft.qtyUnit ? " " + draft.qtyUnit : ""}`, `${draft.entry ?? "?"} → ${draft.exit ?? "?"}`,
        `费用 ${draft.fees ?? "未显示，重算按 0"}`, `乘数 ${multiplier}`].filter(Boolean).join(" · ") });
      if (row.inferredTimeZone) item.createEl("p", { text: "时区按市场推定 · " + row.inferredTimeZone, cls: "lifeops-warning" });
      if (row.kind === "ready") {
        const select = item.createEl("input", { attr: { type: "checkbox", "aria-label": `保存第 ${row.line} 笔 ${draft.symbol}` } });
        select.onchange = () => updateButton();
        choices.set(row.line, select);
      }
      const label = (amount?: number) => amount === undefined ? "未知" : `${tradeNumber(amount)} ${draft.currency}`;
      const unverified = row.screenshotPnl !== undefined && row.computedPnl === undefined;
      const detail = unverified ? "。缺少重算所需字段，盈亏暂不入账。" : row.mismatch ? "。两者不一致，请先核对。" : "";
      item.createEl("p", { text: `截图净盈亏：${label(row.screenshotPnl)}；本地重算：${label(row.computedPnl)}${detail}`,
        cls: unverified || row.mismatch ? "lifeops-warning" : "" });
    }
    const feedback = contentEl.createEl("p", { attr: { role: "status" } });
    let confirming = false;
    let refreshing = false;
    new Setting(contentEl)
      .addButton(button => button.setButtonText("重选截图").onClick(() => { this.clipboardImage = undefined; this.choose(); }))
      .addButton(button => button.setButtonText("刷新核对").onClick(async () => {
        if (confirming || refreshing) return;
        refreshing = true;
        button.setDisabled(true);
        updateButton();
        try {
          current();
          const { trades } = await readTradeDatabase(this.host.store);
          current();
          if (!feedback.isConnected) return;
          const fresh = previewTradeScreenshot(rows, digest, trades, this.host.settings.tradingContractMultipliers);
          this.confirm(rows, digest, fresh, current);
        } catch (error) {
          if (feedback.isConnected) feedback.setText(error instanceof Error ? error.message : "暂时无法重新核对。");
        } finally {
          refreshing = false;
          if (feedback.isConnected) { button.setDisabled(false); updateButton(); }
        }
      }))
      .addButton(button => {
        updateButton = () => {
          const count = picked().length;
          button.setButtonText(`确认保存 ${count} 笔`).setDisabled(!count || refreshing || confirming);
        };
        updateButton();
        button.setCta().onClick(async () => {
          if (button.buttonEl.disabled) return;
          confirming = true;
          button.setDisabled(true);
          for (const input of choices.values()) input.disabled = true;
          try {
            const count = await confirmTradeScreenshot(this.host, rows, digest, preview, picked(), current);
            try { current(); this.close(); } catch { /* A replacement view owns its own picker. */ }
            new Notice(`已保存并核对 ${count} 笔交易。可以使用撤销。`);
          } catch (error) {
            confirming = false;
            if (!feedback.isConnected) return;
            feedback.setText(error instanceof Error ? error.message : "没有保存，请重新核对。");
            for (const input of choices.values()) input.disabled = false;
            updateButton();
          }
        });
      });
  }
}
