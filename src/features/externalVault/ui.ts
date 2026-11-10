import { Modal, Notice, Setting, type App } from "obsidian";
import type LifeOpsPlugin from "../../main";
import type { StoreHost } from "../../store/settingsSlice";
import type { LifeOpsSettings } from "../../types";
import type { LocalOperationHost } from "../serviceHost";
import { defaultExternalFolders, externalVaultReader, externalVaultScope, externalVaultSettings, indexedExternalVault } from "./catalog";
import { extractExternalJournalSignals } from "./journals";
import { normalizeExternalVault, type ExternalVaultSettings } from "./readOnly";

export interface ExternalVaultHost extends LocalOperationHost {
  app: App;
  store: StoreHost;
  settings: LifeOpsSettings;
  saveSettings: LifeOpsPlugin["saveSettings"];
  observeProvider: LifeOpsPlugin["observeProvider"];
  register(callback: () => void): void;
}

async function rebuildIndex(host: ExternalVaultHost, config: ExternalVaultSettings): Promise<void> {
  const base = host.store, scope = externalVaultScope(base);
  let count = 0;
  const current = () => {
    if (host.store !== base || externalVaultScope(base) !== scope) throw Error("外部库配置已变化，请重新建索引。");
  };
  await host.saveLocalOperation("external_vault_index", { name: config.name }, async operation => {
    current();
    count = (await indexedExternalVault(operation, config)).files;
  }, { assertCurrent: current });
  new Notice("已建立「" + config.name + "」索引，" + count + " 篇笔记。");
  await host.refreshViews().catch(() => undefined);
}

export function renderExternalVaultSettings(container: HTMLElement, host: ExternalVaultHost, refresh: () => void): void {
  container.createEl("h3", { text: "外部只读资料库" });
  const configs = externalVaultSettings(host.settings);
  const open = (config?: ExternalVaultSettings) => {
    const modal = new ExternalVaultSettingsModal(host, refresh, config);
    host.register(() => modal.close());
    modal.open();
  };
  new Setting(container).setName("接入外部资料")
    .setDesc("选择要读取的目录。索引写在日用库，查询会标明原私人库来源。")
    .addButton(button => button.setButtonText("添加外部库").onClick(() => open()));
  for (const config of configs) {
    new Setting(container).setName(config.name).setDesc(config.folders.join("、"))
      .addButton(button => button.setButtonText("编辑").onClick(() => open(config)))
      .addButton(button => button.setButtonText("重建索引").onClick(() => {
        void rebuildIndex(host, config).catch(error => new Notice(error instanceof Error ? error.message : "外部索引暂未完成。"));
      }))
      .addButton(button => button.setButtonText("断开").onClick(async () => {
        host.settings.externalVaults = externalVaultSettings(host.settings).filter(item => item.name !== config.name);
        await host.saveSettings();
        refresh();
      }));
  }
  if (configs.length) new Setting(container).setName("提取外部日记信号")
    .setDesc("由你开始扫描，使用已配置的模型。关闭窗口可以停止，已保存的信号可继续使用。")
    .addButton(button => button.setButtonText("查看扫描范围").onClick(() => openExternalJournalScan(host)));
}

class ExternalVaultSettingsModal extends Modal {
  constructor(private readonly host: ExternalVaultHost, private readonly refresh: () => void, private readonly config?: ExternalVaultSettings) {
    super(host.app);
  }

  onOpen(): void {
    this.titleEl.setText(this.config ? "编辑外部只读库" : "添加外部只读库");
    const makeInput = (label: string, value: string) => {
      const field = this.contentEl.createEl("label", { text: label });
      const input = field.createEl("input", { attr: { type: "text" } });
      input.value = value;
      return input;
    };
    const name = makeInput("库名", this.config?.name ?? "原私人库");
    const path = makeInput("绝对路径", this.config?.path ?? "");
    const folders = this.contentEl.createEl("textarea", { attr: { rows: "6", "aria-label": "要读取的目录，每行一个" } });
    folders.value = (this.config?.folders ?? defaultExternalFolders).join("\n");
    const feedback = this.contentEl.createEl("p", { attr: { role: "status" } });
    const save = this.contentEl.createEl("button", { text: "保存并建索引", cls: "mod-cta" });
    save.onclick = async () => {
      save.disabled = true;
      try {
        const config = normalizeExternalVault({ name: name.value, path: path.value, folders: folders.value.split(/\r?\n/).filter(line => line.trim()) });
        const before = externalVaultSettings(this.host.settings), remaining = before.filter(item => item.name !== this.config?.name);
        if (remaining.some(item => item.name === config.name)) throw Error("库名已存在，请换一个名称。");
        await externalVaultReader(this.host.store, config).listMarkdown();
        this.host.settings.externalVaults = [...remaining, config];
        try { await this.host.saveSettings(); }
        catch (error) { this.host.settings.externalVaults = before; throw error; }
        this.close();
        this.refresh();
        await rebuildIndex(this.host, config).catch(() => new Notice("外部库已保存，索引可在设置里重建。"));
      } catch (error) {
        feedback.setText(error instanceof Error ? error.message : "外部库暂时无法接入。");
      } finally { save.disabled = false; }
    };
  }

  onClose(): void { this.contentEl.empty(); }
}

export function openExternalJournalScan(host: ExternalVaultHost): void {
  const modal = new ExternalJournalScanModal(host);
  host.register(() => modal.close());
  modal.open();
}

class ExternalJournalScanModal extends Modal {
  private readonly controller = new AbortController();
  constructor(private readonly host: ExternalVaultHost) { super(host.app); }

  onOpen(): void {
    this.titleEl.setText("提取外部日记信号");
    const { contentEl } = this, settings = this.host.store.settings.ai;
    const names = externalVaultSettings(this.host.store.settings).map(config => config.name).join("、");
    if (!names || settings.provider === "off" || !settings.dataDisclosureAccepted || !settings.endpoint || !settings.model) {
      contentEl.createEl("p", { text: "请先设置外部库、模型及资料使用权限。" });
      return;
    }
    contentEl.createEl("p", { text: "会把「" + names + "」已选日记中的每篇最多 6000 字发送给 " + settings.model
      + (settings.fallbackProvider !== "off" && settings.fallbackModel ? "，必要时回退到 " + settings.fallbackModel : "")
      + "。信号保存到日用库。关闭即可停止。" });
    const status = contentEl.createEl("p", { attr: { role: "status" } });
    const start = contentEl.createEl("button", { text: "确认扫描外部日记", cls: "mod-cta" });
    start.onclick = async () => {
      start.disabled = true;
      try {
        const result = await this.host.observeProvider("daily_review", "text", (request, _store, ai, current) =>
          extractExternalJournalSignals(this.host.store, (messages, options) => ai.extractJournalSignals(messages, { ...request, ...options }),
            request.signal ?? this.controller.signal, current, new Date(),
            (done, total) => status.setText("已检查 " + done + " / " + total + " 篇。")), this.controller.signal);
        status.setText("已检查 " + result.examined + " 篇，新保存 " + result.saved + " 篇，暂不可用 " + result.unavailable + " 篇。");
        await this.host.refreshViews().catch(() => undefined);
      } catch {
        if (!this.controller.signal.aborted) status.setText("扫描暂时中断，已有信号可保留并续跑。");
      } finally { start.disabled = false; }
    };
  }

  onClose(): void { this.controller.abort(); this.contentEl.empty(); }
}
