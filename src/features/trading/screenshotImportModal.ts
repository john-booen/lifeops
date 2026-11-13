import { Modal, Notice, Setting, type App } from "obsidian";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { isVaultPathExcluded } from "../../privacy";
import type { StoreHost } from "../../store/settingsSlice";
import type { LifeOpsSettings } from "../../types";
import type { LocalOperationHost } from "../serviceHost";
import { readTradeDatabase } from "./persistence";
import { tradeNumber } from "./pnl";
import { confirmTradeScreenshot, previewTradeScreenshot, readTradeScreenshot, TRADE_SCREENSHOT_MAX_BYTES,
  type parseTradeScreenshotRows, type TradeScreenshot, type TradeScreenshotPreview } from "./screenshotImport";
import { assertTradeScreenshotReady } from "./screenshotVision";

async function assertSelectedFileAllowed(store: StoreHost, file: File): Promise<void> {
  let selected = (file as File & { path?: string }).path;
  if (!selected) {
    try {
      const electron = require("electron") as { webUtils?: { getPathForFile(file: File): string } };
      selected = electron.webUtils?.getPathForFile(file);
    } catch { /* Older Electron exposes File.path instead. */ }
  }
  const vault = (store.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
  if (!selected || !isAbsolute(selected) || !vault || !isAbsolute(vault)) throw Error("无法核对这张图片的位置，请重新从文件选择器选取。");
  const [root, target] = await Promise.all([realpath(vault), realpath(selected)])
    .catch(() => { throw Error("无法读取所选图片，请重新选择。"); });
  for (const path of [relative(vault, selected), relative(root, target)]) {
    if (path && path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path)
      && isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)) {
      throw Error("这张图片在禁止发送的目录内。");
    }
  }
}

export interface TradeScreenshotHost extends LocalOperationHost {
  app: App;
  store: StoreHost;
  settings: LifeOpsSettings;
  register(callback: () => void): void;
  recognizeTradeScreenshot(image: TradeScreenshot, signal: AbortSignal): Promise<ReturnType<typeof parseTradeScreenshotRows>>;
}

export function openTradeScreenshotImport(host: TradeScreenshotHost): void {
  const modal = new TradeScreenshotImportModal(host);
  host.register(() => modal.close());
  modal.open();
}

class TradeScreenshotImportModal extends Modal {
  private selection?: File;
  private request?: AbortController;
  private openGeneration = 0;

  constructor(private readonly host: TradeScreenshotHost) { super(host.app); }

  onOpen(): void { this.choose(); }
  onClose(): void {
    this.openGeneration++;
    this.request?.abort("trade screenshot closed");
    this.request = undefined;
    this.selection = undefined;
    this.contentEl.empty();
  }

  private choose(): void {
    const generation = ++this.openGeneration;
    this.request?.abort("trade screenshot replaced");
    this.request = undefined;
    this.selection = undefined;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lifeops-form-modal");
    contentEl.createEl("h2", { text: "截图记交易" });
    contentEl.createEl("p", { text: "只发送你选中的这张图片。建议先裁掉账号、姓名和无关内容。确认前不会入账，图片不会存入库。" });
    try { assertTradeScreenshotReady(this.host.settings); }
    catch (error) { contentEl.createEl("p", { text: (error as Error).message }); return; }
    const picker = contentEl.createEl("input", { attr: { type: "file", accept: "image/png,image/jpeg", "aria-label": "选择交易截图" } });
    const status = contentEl.createEl("p", { attr: { role: "status" } });
    new Setting(contentEl).addButton(button => {
      button.setButtonText("发送并识别").setCta().setDisabled(true).onClick(async () => {
        const selected = this.selection, store = this.host.store;
        if (!selected || generation !== this.openGeneration || this.request) return;
        const request = this.request = new AbortController();
        const current = () => {
          if (request.signal.aborted || this.openGeneration !== generation || this.host.store !== store) {
            throw Error("截图确认已失效，请重新选择。");
          }
        };
        button.setDisabled(true);
        picker.disabled = true;
        status.setText("正在识别这张截图…");
        try {
          assertTradeScreenshotReady(this.host.settings);
          if (selected.size > TRADE_SCREENSHOT_MAX_BYTES) throw Error("截图请裁到 4 MB 以内。");
          await assertSelectedFileAllowed(store, selected);
          current();
          const image = readTradeScreenshot(await selected.arrayBuffer());
          current();
          const rows = await this.host.recognizeTradeScreenshot(image, request.signal);
          current();
          const preview = previewTradeScreenshot(rows, image.digest, (await readTradeDatabase(store)).trades,
            this.host.settings.tradingContractMultipliers);
          current();
          this.selection = undefined;
          this.confirm(rows, image.digest, preview, current);
        } catch (error) {
          if (!request.signal.aborted && this.openGeneration === generation) {
            status.setText(error instanceof Error ? error.message : "识别未完成，请换一张清晰截图重试。");
            picker.disabled = false;
            button.setDisabled(false);
          }
        } finally { if (this.request === request) this.request = undefined; }
      });
      picker.onchange = () => {
        this.selection = picker.files?.[0];
        button.setDisabled(!this.selection);
        status.setText(this.selection ? "已选 1 张图片。确认已裁去无关信息后再发送。" : "");
      };
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
    new Setting(contentEl)
      .addButton(button => button.setButtonText("重选截图").onClick(() => this.choose()))
      .addButton(button => {
        updateButton = () => { const count = picked().length; button.setButtonText(`确认保存 ${count} 笔`).setDisabled(!count); };
        updateButton();
        button.setCta().onClick(async () => {
          button.setDisabled(true);
          for (const input of choices.values()) input.disabled = true;
          try {
            const count = await confirmTradeScreenshot(this.host, rows, digest, preview, picked(), current);
            try { current(); this.close(); } catch { /* A replacement view owns its own picker. */ }
            new Notice(`已保存并核对 ${count} 笔交易。可以使用撤销。`);
          } catch (error) {
            feedback.setText(error instanceof Error ? error.message : "没有保存，请重新核对。");
          }
        });
      });
  }
}
