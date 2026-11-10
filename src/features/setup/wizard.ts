import { Modal, Notice, Setting } from "obsidian";
import type LifeOpsPlugin from "../../main";

export function openSetupWizard(plugin: LifeOpsPlugin): void {
  new SetupWizard(plugin).open();
}

class SetupWizard extends Modal {
  constructor(private readonly plugin: LifeOpsPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "开始使用 LifeOps" });
    contentEl.createEl("p", { text: "可以先在本地记任务、打卡和写日记。" });
    const folders = this.plugin.settings.folders;
    const list = contentEl.createEl("ul");
    for (const [label, path] of [["任务", folders.tasks], ["日记", folders.dailyRoot], ["打卡", folders.habits], ["报告", folders.aiReports]]) {
      list.createEl("li", { text: label + "：" + path });
    }
    new Setting(contentEl).setName("文字 AI 和语音")
      .setDesc("需要时，到「设置 → LifeOps Assistant」配置模型并确认发送范围。这个向导不会发资料或打开麦克风。");
    new Setting(contentEl).addButton(button => button.setButtonText("开始本地使用").setCta().onClick(async () => {
      const wasComplete = this.plugin.settings.setupComplete;
      this.plugin.settings.setupComplete = true;
      try {
        await this.plugin.saveSettings();
        this.close();
      } catch {
        this.plugin.settings.setupComplete = wasComplete;
        new Notice("设置没有保存，请重试。");
      }
    }));
  }

  onClose(): void { this.contentEl.empty(); }
}
