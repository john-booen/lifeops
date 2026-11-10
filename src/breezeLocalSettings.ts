import { Setting } from "obsidian";
import type { LifeOpsSettings } from "./types";
import { checkBreezeLocalInstallation } from "./breezeLocalConfig";

export function renderBreezeLocalSettings(container: HTMLElement, plugin: { settings: LifeOpsSettings; saveSettings(): Promise<void> }): void {
  const breeze = plugin.settings.realtimeVoice.breeze ??= { home: "", python: "", referenceAudio: "", referenceText: "" };
  container.createEl("h4", { text: "Breeze 本地朗读" });
  const fields = [
    ["home", "Breeze 目录", "包含 work/breeze-model-4bit 的安装目录。"],
    ["python", "Python 路径", "本地 Breeze 环境的 Python 可执行文件。"],
    ["referenceAudio", "参考音频路径", "要使用的本地参考音频。"],
    ["referenceText", "参考文本", "参考音频里实际说的话。"]
  ] as const;
  for (const [key, name, description] of fields) {
    new Setting(container).setName(name).setDesc(description).addText(text => {
      text.setValue(breeze[key]).onChange(async value => { breeze[key] = value.trim(); await plugin.saveSettings(); });
    });
  }
  const status = container.createDiv({ cls: "setting-item-description" });
  new Setting(container).setName("检查本地朗读配置").setDesc("检查路径和 Python，不下载模型。").addButton(button => {
    button.setButtonText("检查").onClick(async () => {
      button.setDisabled(true); status.setText("检查中…");
      try { status.setText(await checkBreezeLocalInstallation(plugin.settings.realtimeVoice)); }
      catch (error) { status.setText(error instanceof Error ? error.message : "检查未完成，请核对配置。"); }
      finally { button.setDisabled(false); }
    });
  });
}
