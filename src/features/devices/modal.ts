import { App, Modal, Notice } from "obsidian";
import type { DeviceCoordinator } from "./coordinator";

export interface DeviceUiHost {
  app: App;
  devices: DeviceCoordinator;
  chooseWriter(): Promise<void>;
  chooseCapture(): Promise<void>;
  receipts(): void;
}
export class DeviceSettingsModal extends Modal {
  constructor(private readonly host: DeviceUiHost) { super(host.app); }
  onOpen(): void {
    this.setTitle("多设备协作");
    const el = this.contentEl;
    const role = this.host.devices.execution;
    el.createEl("p", { text: role.canWriteFacts ? "这台 Mac 负责处理记录和发送提醒。" : role.needsSetup
      ? "先选择这台 Mac 的用途。每个记录库保留一台负责处理的 Mac。" : "这台 Mac 负责记录和查看同步结果。" });
    el.createEl("p", { text: "将两台 Mac 和手机的同一记录库交给一个同步服务。常开的 Mac 统一处理任务，其他设备用随手记提交；离线时先留在本机，联网并完成同步后处理。" });
    el.createEl("p", { text: "先在常开 Mac 完成设置和首次同步，再在另一台选择“只记录并同步”。模型密钥保留在处理端；请勿同步第三方插件设置。" });
    this.button("这台负责处理", () => this.host.chooseWriter());
    this.button("这台只记录并同步", () => this.host.chooseCapture());
    this.button("查看设备回执", async () => { this.host.receipts(); });
  }
  private button(text: string, action: () => Promise<void>): void {
    const button = this.contentEl.createEl("button", { text });
    button.onclick = async () => {
      button.disabled = true;
      try { await action(); this.close(); }
      catch (error) { new Notice(error instanceof Error ? error.message : "设备用途未保存，请重试。"); }
      finally { button.disabled = false; }
    };
  }
}
export class DeviceCaptureModal extends Modal {
  constructor(private readonly host: DeviceUiHost) { super(host.app); }
  onOpen(): void {
    this.setTitle("设备随手记");
    this.contentEl.createEl("p", { text: "写下要记录或安排的事情，也可以使用系统听写。保存后等待常开 Mac 处理；确认和撤销请到处理端的设备回执操作。" });
    const text = this.contentEl.createEl("textarea", { attr: { rows: "6", placeholder: "例如：明天提醒我整理学习笔记" } });
    const status = this.contentEl.createEl("p", { attr: { role: "status" } });
    const save = this.contentEl.createEl("button", { text: "保存待处理记录" });
    save.onclick = async () => {
      save.disabled = true;
      try {
        await this.host.devices.queueCapture(text.value);
        status.setText("原始记录已保存在本机，等待同步到处理端。任务是否入账以回执为准。");
        text.value = "";
      } catch (error) { status.setText(error instanceof Error ? error.message : "记录未保存，请重试。"); }
      finally { save.disabled = false; }
    };
    const receipts = this.contentEl.createEl("button", { text: "查看处理回执" });
    receipts.onclick = () => this.host.receipts();
    text.focus();
  }
}
