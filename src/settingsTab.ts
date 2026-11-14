import { Notice, Platform, PluginSettingTab, Setting, type TextComponent } from "obsidian";
import type LifeOpsPlugin from "./main";
import type { LifeOpsSettings } from "./types";
import { openSetupWizard } from "./features/setup/wizard";
import { credentialStorageRiskMessage } from "./credentialSecurity";
import { parseExcludedVaultPrefixes } from "./privacy";
import { renderBreezeLocalSettings } from "./breezeLocalSettings";
import { migrateRealtimeVoiceSettings } from "./settingsMigration";
import { textAiReadiness, realtimeVoiceReadiness } from "./capabilityReadiness";
import { getTradingSourceFolders, parseTradingSourceFolders } from "./features/trading/sourceFolders";
import { parseTradeMultipliers } from "./features/trading/pnl";
import { tradeBreakEven } from "./features/stats/trades";
import { parseReadingFolders } from "./features/reading/model";
import { renderHabitCompensationSettings } from "./features/habits/formFields";
import type { ProactiveTone } from "./proactivePolicy";
import { renderExternalVaultSettings, type ExternalVaultHost } from "./features/externalVault/ui";
import { voiceVadSilenceMs } from "./voice/continuousInput";
import { asrHotwords } from "./voice/realtimeAsrOptions";
import { linkedNoteName, normalizeLinkedNoteName } from "./linkedNoteSettings";

export class LifeOpsSettingTab extends PluginSettingTab {

  constructor(private readonly plugin: LifeOpsPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "LifeOps Assistant" });
    new Setting(containerEl).setName("初次设置").addButton(button =>
      button.setButtonText("打开向导").onClick(() => openSetupWizard(this.plugin)));
    for (const [kind, label] of [["knowledge", "知识沉淀笔记"], ["trading", "交易模型笔记"]] as const) {
      new Setting(containerEl).setName(label).setDesc("填写文件名。改名后从下次写入生效。")
        .addText(field => {
          field.setValue(linkedNoteName(this.plugin.settings, kind));
          field.inputEl.addEventListener("change", async () => {
            const name = normalizeLinkedNoteName(field.getValue());
            if (!name) {
              new Notice("请填写有效的笔记文件名。");
              field.setValue(linkedNoteName(this.plugin.settings, kind));
              return;
            }
            const settings = this.plugin.settings;
            settings.linkedNoteNames = { knowledge: linkedNoteName(settings, "knowledge"), trading: linkedNoteName(settings, "trading"), [kind]: name };
            field.setValue(name);
            await this.plugin.saveSettings();
          });
        });
    }

    if (Platform.isDesktopApp) {
      new Setting(containerEl).setName("手机随手记")
        .setDesc("自动把「输入/手机随手记.md」的新行交给已配置并授权的文字模型。回执保存在本库。")
        .addToggle(toggle => toggle.setValue(this.plugin.settings.phoneInboxEnabled === true).onChange(async enabled => {
          this.plugin.settings.phoneInboxEnabled = enabled;
          await this.plugin.saveSettings();
          await this.plugin.refreshViews();
        }))
        .addButton(button => button.setButtonText("打开回执").onClick(() => this.plugin.openPhoneInbox()));
    }

    new Setting(containerEl).setName("主动提醒").setDesc("在 LifeOps 面板和 Obsidian 内显示。23:00 到次日 7:00 静默。")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.proactive.enabled).onChange(async enabled => {
        this.plugin.settings.proactive.enabled = enabled;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("提醒语气")
      .addDropdown(dropdown => dropdown.addOption("gentle", "温和").addOption("direct", "直接").addOption("strict", "严厉")
        .setValue(this.plugin.settings.proactive.tone ?? "direct").onChange(async value => {
          this.plugin.settings.proactive.tone = value as ProactiveTone;
          await this.plugin.saveSettings();
        }));
    renderExternalVaultSettings(containerEl, this.plugin as unknown as ExternalVaultHost, () => this.display());

    containerEl.createEl("h3", { text: "文字 AI 与语音" });
    const readiness = containerEl.createDiv();
    const jumpTo = (section: "text" | "voice"): void => {
      const heading = containerEl.querySelector<HTMLElement>(`[data-lifeops-settings="${section}"]`);
      heading?.scrollIntoView({ block: "start", behavior: "auto" });
      heading?.focus({ preventScroll: true });
    };
    const refreshReadiness = (): void => {
      readiness.empty();
      new Setting(readiness)
        .setName("文字 AI")
        .setDesc(textAiReadiness(this.plugin.settings).message)
        .addButton(button => button.setButtonText("文字 AI 设置").onClick(() => jumpTo("text")));
      new Setting(readiness)
        .setName("语音对话")
        .setDesc(realtimeVoiceReadiness(this.plugin.settings).message)
        .addButton(button => button.setButtonText("语音设置").onClick(() => jumpTo("voice")));
    };
    refreshReadiness();
    new Setting(containerEl)
      .setName("配置完成后检查")
      .setDesc("这里只核对配置是否齐全，不发送资料或启动麦克风。实际连接和听说效果还需要验证。")
      .addButton(button => button.setButtonText("刷新状态").onClick(refreshReadiness));

    new Setting(containerEl)
      .setName("我了解 API Key 的本地明文存储风险")
      .setDesc(credentialStorageRiskMessage())
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.privacy?.plaintextCredentialStorageAccepted === true).onChange(async (value) => {
          this.plugin.settings.privacy = {
            excludedVaultPrefixes: this.plugin.settings.privacy?.excludedVaultPrefixes ?? [],
            plaintextCredentialStorageAccepted: value
          };
          this.plugin.settings.realtimeVoice.plaintextCredentialStorageAccepted = value;
          if (!value) {
            this.plugin.settings.ai.dataDisclosureAccepted = false;
            this.plugin.settings.embedding.dataDisclosureAccepted = false;
            this.plugin.settings.vision.remoteDataDisclosureAccepted = false;
            this.plugin.settings.vision.tradeScreenshotDisclosureAccepted = false;
            this.plugin.settings.vision.healthScreenshotDisclosureAccepted = false;
            this.plugin.settings.voice.dataDisclosureAccepted = false;
            this.plugin.settings.realtimeVoice.dataDisclosureAccepted = false;
          }
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("禁止发送的 Vault 目录")
      .setDesc("每行一个 Vault 相对目录。这些目录仍可正常使用，但不会加入模型检索或 Embedding 索引；.obsidian 永远排除。")
      .addTextArea((text) => {
        text
          .setPlaceholder("私人资料\n财务/密钥")
          .setValue((this.plugin.settings.privacy?.excludedVaultPrefixes ?? []).join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.privacy = {
              excludedVaultPrefixes: parseExcludedVaultPrefixes(value),
              plaintextCredentialStorageAccepted: this.plugin.settings.privacy?.plaintextCredentialStorageAccepted === true
            };
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("阅读来源文件夹")
      .setDesc("每行一个库内文件夹。带 source 或 url 属性的阅读笔记也会进入索引。")
      .addTextArea(text => text
        .setValue(Array.isArray(this.plugin.settings.readingSourceFolders) ? this.plugin.settings.readingSourceFolders.join("\n") : "")
        .onChange(async value => {
          this.plugin.settings.readingSourceFolders = parseReadingFolders(value);
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("交易来源文件夹")
      .setDesc("每行一个当前库的相对文件夹，用于选取交易复盘和模型笔记。清空后停用这份列表，绝对路径和隐藏目录会忽略。")
      .addTextArea(text => text
        .setValue(getTradingSourceFolders(this.plugin.settings).join("\n"))
        .onChange(async value => {
          this.plugin.settings.tradingSourceFolders = parseTradingSourceFolders(value);
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("交易合约乘数")
      .setDesc("每行填写一个品种和乘数，例如 IF=300。使用正数，未设置的品种按 1 计算。")
      .addTextArea(text => text
        .setValue(Object.entries(this.plugin.settings.tradingContractMultipliers ?? {}).map(([symbol, value]) => `${symbol}=${value}`).join("\n"))
        .onChange(async value => {
          this.plugin.settings.tradingContractMultipliers = parseTradeMultipliers(value);
          await this.plugin.saveSettings();
        }));
    for (const currency of ["CNY", "USD"] as const) {
      new Setting(containerEl).setName(`交易持平阈值（${currency}）`).setDesc("盈亏绝对值小于阈值时，按持平计算胜率。")
        .addText(text => text.setValue(String(tradeBreakEven(currency, this.plugin.settings.tradingBreakEven))).onChange(async value => {
          const number = value.trim() ? Number(value) : undefined;
          if (number !== undefined && (!Number.isFinite(number) || number < 0)) return;
          this.plugin.settings.tradingBreakEven = { ...this.plugin.settings.tradingBreakEven, [currency]: number };
          await this.plugin.saveSettings();
        }));
    }
    new Setting(containerEl).setName("手动汇率（1 USD 等于多少 CNY）").setDesc("仅在要求把人民币和美元盈亏合计为美元时使用。")
      .addText(text => text.setValue(String(this.plugin.settings.tradingCnyPerUsd ?? "")).onChange(async value => {
        const number = value.trim() ? Number(value) : undefined;
        if (number !== undefined && (!Number.isFinite(number) || number <= 0)) return;
        this.plugin.settings.tradingCnyPerUsd = number;
        await this.plugin.saveSettings();
      }));

    containerEl.createEl("h3", { text: "文字 AI 设置", attr: { "data-lifeops-settings": "text", tabindex: "-1" } });
    let refreshTextDisclosure = (): void => {};
    const updateTextConnection = async <K extends "provider" | "endpoint" | "fallbackProvider" | "fallbackEndpoint">(
      field: K, value: LifeOpsSettings["ai"][K]
    ): Promise<void> => {
      const ai = this.plugin.settings.ai;
      if (ai[field] === value) return;
      ai[field] = value;
      ai.dataDisclosureAccepted = false;
      refreshTextDisclosure();
      refreshReadiness();
      await this.plugin.saveSettings();
    };
    new Setting(containerEl)
      .setName("AI Provider")
      .setDesc("选择已有的文字服务。Kimi使用兼容接口选项；服务地址、模型和密钥分别填写，更换服务后需重新确认发送范围。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("off", "关闭")
          .addOption("openai-compatible", "OpenAI-compatible")
          .addOption("deepseek", "DeepSeek")
          .addOption("minimax", "MiniMax")
          .addOption("qwen", "Qwen / 百炼")
          .addOption("custom", "自定义")
          .setValue(this.plugin.settings.ai.provider)
          .onChange(value => updateTextConnection("provider", value as LifeOpsSettings["ai"]["provider"]));
      });

    const textDisclosure = new Setting(containerEl).setName("允许文本发送给当前 AI Provider");
    textDisclosure.addToggle(toggle => {
      refreshTextDisclosure = () => {
        const ai = this.plugin.settings.ai;
        const allowed = ai.dataDisclosureAccepted === true;
        textDisclosure.setDesc(`当前 Provider：${ai.provider}。会发送用户消息、必要对话历史和筛选后的库文本。日记信号会自动处理允许读取的日记，每篇最多 6000 字。摘要和健康统计问答会使用允许读取的健康指标。被排除目录不会发送。更换主用或备用服务类型、地址后自动撤销授权。`);
        toggle.setValue(allowed);
        toggle.toggleEl.setAttribute("aria-checked", String(allowed));
      };
      refreshTextDisclosure();
      toggle.onChange(async value => {
        this.plugin.settings.ai.dataDisclosureAccepted = value;
        refreshTextDisclosure();
        refreshReadiness();
        await this.plugin.saveSettings();
      });
    });

    new Setting(containerEl)
      .setName("AI Endpoint")
      .addText((text) => {
        text.setValue(this.plugin.settings.ai.endpoint).onChange(value => updateTextConnection("endpoint", value.trim()));
      });

    new Setting(containerEl)
      .setName("AI Model")
      .addText((text) => {
        text.setValue(this.plugin.settings.ai.model).onChange(async (value) => {
          this.plugin.settings.ai.model = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("AI API Key")
      .setDesc("保存在 Obsidian 插件配置里。个人使用可以先这样，团队场景建议换成更安全的密钥管理。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.ai.apiKey).onChange((value) => this.saveCredential(value, (clean) => {
          this.plugin.settings.ai.apiKey = clean;
        }));
      });

    new Setting(containerEl)
      .setName("AI Fallback Provider")
      .setDesc("主文字服务失败时使用的备用服务。可保持关闭；开启前需核对备用地址、模型、密钥及发送范围。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("off", "关闭")
          .addOption("openai-compatible", "OpenAI-compatible")
          .addOption("deepseek", "DeepSeek")
          .addOption("minimax", "MiniMax")
          .addOption("qwen", "Qwen / 百炼")
          .addOption("custom", "自定义")
          .setValue(this.plugin.settings.ai.fallbackProvider)
          .onChange(value => updateTextConnection("fallbackProvider", value as LifeOpsSettings["ai"]["fallbackProvider"]));
      });

    new Setting(containerEl)
      .setName("AI Fallback Endpoint")
      .addText((text) => {
        text.setValue(this.plugin.settings.ai.fallbackEndpoint).onChange(value => updateTextConnection("fallbackEndpoint", value.trim()));
      });

    new Setting(containerEl)
      .setName("AI Fallback Model")
      .addText((text) => {
        text.setValue(this.plugin.settings.ai.fallbackModel).onChange(async (value) => {
          this.plugin.settings.ai.fallbackModel = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("AI Fallback API Key")
      .setDesc("只保存在本地插件配置里，不写入源码或项目文档。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.ai.fallbackApiKey).onChange((value) => this.saveCredential(value, (clean) => {
          this.plugin.settings.ai.fallbackApiKey = clean;
        }));
      });

    new Setting(containerEl)
      .setName("分类置信度阈值")
      .setDesc("低于阈值会进入 Inbox/待确认.md。")
      .addSlider((slider) => {
        slider
          .setLimits(0.5, 0.95, 0.01)
          .setValue(this.plugin.settings.ai.confidenceThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.ai.confidenceThreshold = value;
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "语义检索 / Embedding（实验功能 Experimental）" });
    new Setting(containerEl)
      .setName("允许文本发送给当前 Embedding Provider")
      .setDesc(`当前 Provider：${this.plugin.settings.embedding.provider}。会发送用于建索引或查询的 Vault 文本片段；被排除目录不会进入索引。更换 Provider 后自动撤销授权。`)
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.embedding.dataDisclosureAccepted === true).onChange(async (value) => {
          this.plugin.settings.embedding.dataDisclosureAccepted = value;
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName("Embedding Provider")
      .setDesc("实验功能，默认关闭；开启后可重建向量索引，AI 会优先读取语义相近的笔记。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("off", "关闭")
          .addOption("openai-compatible", "OpenAI-compatible")
          .addOption("deepseek", "DeepSeek")
          .addOption("qwen", "Qwen / 百炼")
          .addOption("dashscope", "DashScope / 百炼")
          .addOption("custom", "自定义")
          .setValue(this.plugin.settings.embedding.provider)
          .onChange(async (value) => {
            this.plugin.settings.embedding.provider = value as "off" | "openai-compatible" | "deepseek" | "qwen" | "dashscope" | "custom";
            this.plugin.settings.embedding.dataDisclosureAccepted = false;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Embedding Endpoint")
      .setDesc("填写兼容 OpenAI /v1/embeddings 的接口地址。")
      .addText((text) => {
        text.setValue(this.plugin.settings.embedding.endpoint).onChange(async (value) => {
          this.plugin.settings.embedding.endpoint = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Embedding Model")
      .addText((text) => {
        text.setValue(this.plugin.settings.embedding.model).onChange(async (value) => {
          this.plugin.settings.embedding.model = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Embedding API Key")
      .setDesc("只保存在本地插件配置里，不写入源码或文档。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.embedding.apiKey).onChange((value) => this.saveCredential(value, (clean) => {
          this.plugin.settings.embedding.apiKey = clean;
        }));
      });

    new Setting(containerEl)
      .setName("Semantic Top K")
      .setDesc("每次问题最多取多少条语义命中的笔记。")
      .addSlider((slider) => {
        slider
          .setLimits(3, 12, 1)
          .setValue(this.plugin.settings.embedding.topK)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.embedding.topK = value;
            await this.plugin.saveSettings();
          });
      });

    this.renderTradeScreenshotSettings(containerEl);
    containerEl.createEl("h3", { text: "实时语音对话", attr: { "data-lifeops-settings": "voice", tabindex: "-1" } });
    new Setting(containerEl)
      .setName("允许音频和 TTS 文本发送给 Realtime Provider")
      .setDesc(`当前 Provider：${this.plugin.settings.realtimeVoice.provider}。会发送麦克风音频，启用云端朗读时还会发送回复文本。使用热词识别时，会向百炼发送手填热词、习惯名、近七天任务关键词和交易品种。更换服务或识别方式后需重新确认。`)
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.realtimeVoice.dataDisclosureAccepted === true).onChange(async (value) => {
          this.plugin.settings.realtimeVoice.dataDisclosureAccepted = value;
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName("Realtime Voice Provider")
      .setDesc("AI 管家右侧面板的语音对话入口。百炼 Qwen-Omni 是正式方向；浏览器本地实时草稿只是实验性 fallback，Obsidian 环境可能不可用。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("off", "关闭")
          .addOption("browser-live", "浏览器本地实时草稿（实验）")
          .addOption("qwen-omni-realtime", "百炼 Qwen-Omni Realtime")
          .setValue(this.plugin.settings.realtimeVoice.provider)
          .onChange(async (value) => {
            this.plugin.settings.realtimeVoice.provider = value as "off" | "browser-live" | "qwen-omni-realtime";
            this.plugin.settings.realtimeVoice.dataDisclosureAccepted = false;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("语音流程")
      .setDesc("识别语音后由 LifeOps 管家回答，再用已配置的声音朗读。");

    const voiceSettings = this.plugin.settings.realtimeVoice;
    if (voiceSettings.provider === "qwen-omni-realtime" && (voiceSettings.mode ?? "cascade") === "cascade") {
      new Setting(containerEl).setName("语音识别方式")
        .setDesc("自动模式在支持即时热词的百炼地址优先使用热词识别。也可单独选择百炼实时识别。")
        .addDropdown(dropdown => dropdown
          .addOption("realtime", "自动识别（默认）")
          .addOption("streaming-hotwords", "百炼热词识别")
          .addOption("realtime-only", "百炼实时识别")
          .setValue(voiceSettings.asrEngine ?? "realtime")
          .onChange(async value => {
            voiceSettings.asrEngine = value === "streaming-hotwords" || value === "realtime-only" ? value : "realtime";
            voiceSettings.dataDisclosureAccepted = false;
            await this.plugin.saveSettings();
            this.display();
          }));
      if (voiceSettings.asrEngine !== "realtime-only") {
        new Setting(containerEl).setName("语音热词")
          .setDesc("填写愿意发给百炼的词，按换行或逗号分隔。会和习惯名、近七天任务关键词、交易品种一起去重，最多 50 个。")
          .addTextArea(field => {
            field.inputEl.maxLength = 8000;
            field.setValue(voiceSettings.asrHotwords ?? "").onChange(async value => {
              voiceSettings.asrHotwords = asrHotwords(value).join("\n");
              await this.plugin.saveSettings();
            });
            field.inputEl.addEventListener("blur", () => field.setValue(voiceSettings.asrHotwords ?? ""));
          });
      }
    }

    new Setting(containerEl).setName("说完判定的静音时长")
      .setDesc("毫秒，300 至 3000。默认 700 毫秒，百炼在这段安静时间后判定一句说完。")
      .addText(text => {
        const settings = this.plugin.settings.realtimeVoice;
        text.setValue(String(voiceVadSilenceMs(settings.vadSilenceMs))).onChange(async value => {
          const duration = Number(value.trim());
          if (duration !== voiceVadSilenceMs(duration)) return;
          settings.vadSilenceMs = duration;
          await this.plugin.saveSettings();
        });
        text.inputEl.addEventListener("blur", () => text.setValue(String(voiceVadSilenceMs(settings.vadSilenceMs))));
      });

    new Setting(containerEl)
      .setName("Realtime Voice Endpoint")
      .setDesc("百炼实时语音 WebSocket 默认地址。浏览器本地实时草稿模式下不会调用它。")
      .addText((text) => {
        text.setValue(this.plugin.settings.realtimeVoice.endpoint).onChange(async (value) => {
          this.plugin.settings.realtimeVoice.endpoint = value.trim() || "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Realtime Voice Model")
      .setDesc("实时听写入口当前仍使用百炼 Realtime；如要继续压低转写延迟，后面会优先围绕这条链路优化。")
      .addText((text) => {
        text.setValue(this.plugin.settings.realtimeVoice.model).onChange(async (value) => {
          this.plugin.settings.realtimeVoice.model = value.trim() || "qwen3.5-omni-plus-realtime-2026-03-15";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Realtime Voice API Key")
      .setDesc("填百炼 / DashScope API Key。不要写进源码，只保存在本地 Vault 插件配置里。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.realtimeVoice.apiKey).onChange((value) => this.saveCredential(value, (clean) => {
          this.plugin.settings.realtimeVoice.apiKey = clean;
        }));
      });

    new Setting(containerEl)
      .setName("Qwen-Omni E2E Voice")
      .setDesc("只用于新端到端链路。Qwen3.5-Omni Realtime 默认 Tina；建议先用 Tina、Ethan 或 Serena。")
      .addText((text) => {
        text.setValue(this.plugin.settings.realtimeVoice.omniVoice ?? "Tina").onChange(async (value) => {
          this.plugin.settings.realtimeVoice.omniVoice = value.trim() || "Tina";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("语音回复声音")
      .setDesc("选择 BreezeBlue 会把需要朗读的回复文字发给 BreezeBlue，使用账户积分和钥匙串中的音色；不会发送麦克风音频。遇到连接失败会用本地 Breeze，超 120 字可用系统朗读。语音识别和聊天模型保持原设置。")
      .addDropdown((dropdown) => {
        dropdown.addOption("bailian", "现有语音").addOption("breeze-local", "Breeze 本地声音").addOption("breeze-blue", "BreezeBlue 线上 · 温柔轻御姐")
          .setValue(this.plugin.settings.realtimeVoice.ttsEngine ?? "bailian")
          .onChange(async (value) => {
            this.plugin.settings.realtimeVoice.ttsEngine = value === "breeze-local" || value === "breeze-blue" ? value : "bailian";
            this.plugin.settings.realtimeVoice = migrateRealtimeVoiceSettings(this.plugin.settings.realtimeVoice);
            await this.plugin.saveSettings();
            this.display();
          });
      });

    renderBreezeLocalSettings(containerEl, this.plugin);

    if (this.plugin.settings.realtimeVoice.ttsEngine === "breeze-local") {
      new Setting(containerEl)
        .setName("本地声音失败时")
        .setDesc("默认用系统朗读。选择百炼备用会把本次需要朗读的回复文字发送给百炼。")
        .addDropdown(dropdown => dropdown.addOption("system", "系统朗读").addOption("bailian", "百炼在线朗读")
          .setValue(this.plugin.settings.realtimeVoice.localTtsFallback ?? "system")
          .onChange(async value => {
            this.plugin.settings.realtimeVoice.localTtsFallback = value === "bailian" ? "bailian" : "system";
            await this.plugin.saveSettings();
          }));
    }

    new Setting(containerEl)
      .setName("Realtime TTS Model")
      .setDesc("AI 管家语音回复使用的百炼实时语音合成模型。建议先用 qwen3-tts-flash-realtime。")
      .addText((text) => {
        text.setValue(this.plugin.settings.realtimeVoice.ttsModel).onChange(async (value) => {
          this.plugin.settings.realtimeVoice.ttsModel = value.trim() || "qwen3-tts-flash-realtime";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Realtime TTS Voice")
      .setDesc("百炼语音回复音色。默认 Cherry；后续你可以在官方音色表里继续挑更喜欢的。")
      .addText((text) => {
        text.setValue(this.plugin.settings.realtimeVoice.ttsVoice).onChange(async (value) => {
          this.plugin.settings.realtimeVoice.ttsVoice = value.trim() || "Cherry";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Realtime TTS Sample Rate")
      .setDesc("百炼实时语音回复采样率，默认 24000。")
      .addText((text) => {
        text.setValue(String(this.plugin.settings.realtimeVoice.ttsSampleRate)).onChange(async (value) => {
          const parsed = Number.parseInt(value.trim(), 10);
          this.plugin.settings.realtimeVoice.ttsSampleRate = Number.isFinite(parsed) && parsed > 0 ? parsed : 24000;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Realtime Voice Language")
      .addText((text) => {
        text.setValue(this.plugin.settings.realtimeVoice.language).onChange(async (value) => {
          this.plugin.settings.realtimeVoice.language = value.trim() || "zh-CN";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("停止后自动发送")
      .setDesc("开启后，说完点击停止，会直接把已识别文字发给 AI 管家。关闭后只填入输入框，方便你编辑。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.realtimeVoice.autoSendOnStop).onChange(async (value) => {
          this.plugin.settings.realtimeVoice.autoSendOnStop = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("云端转写 fallback")
      .setDesc("实时语音尚未接通或本地实时草稿不可用时，退回下面的 Voice Provider 转写。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.realtimeVoice.cloudFallback).onChange(async (value) => {
          this.plugin.settings.realtimeVoice.cloudFallback = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("语音对话朗读回复")
      .setDesc("关闭后仍可语音输入和自动发送，但 AI 回复只显示文字，不播放语音。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.realtimeVoice.speakReplies).onChange(async (value) => {
          this.plugin.settings.realtimeVoice.speakReplies = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("语音触发词")
      .setDesc("默认关闭。关闭后，点开语音就直接连续对话；开启后才需要先说触发词。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.realtimeVoice.triggerEnabled).onChange(async (value) => {
          this.plugin.settings.realtimeVoice.triggerEnabled = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("触发词列表")
      .setDesc("用逗号分隔。建议使用中文触发词；英文缩写在中文语音识别里不稳定。识别到触发词后，只把后面的内容发给 AI。")
      .addText((text) => {
        text.setValue(this.plugin.settings.realtimeVoice.triggerPhrases).onChange(async (value) => {
          this.plugin.settings.realtimeVoice.triggerPhrases = value.trim() || "小管家";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("连续对话免触发时间")
      .setDesc("触发后多少秒内，后续语音会直接发送给 AI。超过这个时间需要重新说触发词。默认 45 秒。")
      .addText((text) => {
        text.setValue(String(this.plugin.settings.realtimeVoice.triggerSessionTimeoutSec)).onChange(async (value) => {
          const parsed = Number.parseInt(value.trim(), 10);
          this.plugin.settings.realtimeVoice.triggerSessionTimeoutSec = Number.isFinite(parsed) && parsed > 0 ? parsed : 45;
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("h3", { text: "语音转写" });
    new Setting(containerEl)
      .setName("允许录音发送给当前 Voice Provider")
      .setDesc(`当前 Provider：${this.plugin.settings.voice.provider}。会发送本次麦克风录音用于转写。更换 Provider 后自动撤销授权。`)
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.voice.dataDisclosureAccepted === true).onChange(async (value) => {
          this.plugin.settings.voice.dataDisclosureAccepted = value;
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName("Voice Provider")
      .setDesc("用于快速记录里的录音转文字，使用已配置的兼容转写接口。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("off", "关闭")
          .addOption("openai-compatible", "OpenAI-compatible audio transcription")
          .setValue(this.plugin.settings.voice.provider)
          .onChange(async (value) => {
            this.plugin.settings.voice.provider = value as "off" | "openai-compatible";
            this.plugin.settings.voice.dataDisclosureAccepted = false;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Voice Endpoint")
      .setDesc("默认兼容 OpenAI /v1/audio/transcriptions。")
      .addText((text) => {
        text.setValue(this.plugin.settings.voice.endpoint).onChange(async (value) => {
          this.plugin.settings.voice.endpoint = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Voice Model")
      .addText((text) => {
        text.setValue(this.plugin.settings.voice.model).onChange(async (value) => {
          this.plugin.settings.voice.model = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Voice API Key")
      .setDesc("可以和 AI API Key 相同，也可以单独配置。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.voice.apiKey).onChange((value) => this.saveCredential(value, (clean) => {
          this.plugin.settings.voice.apiKey = clean;
        }));
      });

    new Setting(containerEl)
      .setName("Voice Language")
      .setDesc("中文建议填写 zh。")
      .addText((text) => {
        text.setValue(this.plugin.settings.voice.language).onChange(async (value) => {
          this.plugin.settings.voice.language = value.trim() || "zh";
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("h3", { text: "习惯" });
    new Setting(containerEl)
      .setName("习惯管理")
      .setDesc("习惯现在从 LifeOps 面板里的“新建习惯”按钮添加，支持每天、每几天、每周和目标次数统计。这里不再手写配置。");
    renderHabitCompensationSettings(containerEl, this.plugin.settings.habitCompensation, async patch => {
      const prior = this.plugin.settings.habitCompensation;
      this.plugin.settings.habitCompensation = { ...prior, ...patch,
        exerciseOverflowCny: { ...prior?.exerciseOverflowCny, ...patch.exerciseOverflowCny } };
      await this.plugin.saveSettings();
    });

    containerEl.createEl("h3", { text: "外部输入网关" });
    new Setting(containerEl)
      .setName("Gateway inbox file")
      .setDesc("不支持（Excluded）。Gateway 不属于 0.2，当前只保留旧收件箱路径供迁移识别；不会启动服务。")
      .addText((text) => {
        text.setValue(this.plugin.settings.gateway.inboxFile).onChange(async (value) => {
          this.plugin.settings.gateway.inboxFile = value.trim() || "Inbox/外部输入.md";
          await this.plugin.saveSettings();
        });
      });

  }

  private renderTradeScreenshotSettings(parent: HTMLElement): void {
    const vision = this.plugin.settings.vision;
    parent.createEl("h3", { text: "截图识别" });
    new Setting(parent).setName("视觉服务")
      .setDesc("仅识别你手动选择并点击发送的图片。")
      .addDropdown(dropdown => {
        dropdown.addOption("off", "关闭").addOption("qwen-vl", "百炼视觉")
          .addOption("openai-compatible", "兼容接口");
        if (!["off", "qwen-vl", "openai-compatible"].includes(vision.provider)) dropdown.addOption(vision.provider, "当前兼容服务");
        dropdown.setValue(vision.provider).onChange(async value => {
          vision.provider = value as typeof vision.provider;
          vision.tradeScreenshotDisclosureAccepted = false;
          vision.healthScreenshotDisclosureAccepted = false;
          await this.plugin.saveSettings();
          this.display();
        });
      });
    if (vision.provider === "off") return;
    let uncheck = () => {};
    let uncheckHealth = () => {};
    const revoke = () => {
      vision.tradeScreenshotDisclosureAccepted = false;
      vision.healthScreenshotDisclosureAccepted = false;
      uncheck();
      uncheckHealth();
    };
    new Setting(parent).setName("视觉服务地址").setDesc("完整的 HTTPS /chat/completions 地址。").addText(text => {
      text.setValue(vision.endpoint).onChange(async value => {
        vision.endpoint = value.trim(); revoke(); await this.plugin.saveSettings();
      });
    });
    new Setting(parent).setName("视觉模型").addText(text => {
      text.setValue(vision.model).onChange(async value => {
        vision.model = value.trim(); revoke(); await this.plugin.saveSettings();
      });
    });
    new Setting(parent).setName("视觉 API Key").addText(text => {
      text.inputEl.type = "password";
      text.setValue(vision.apiKey).onChange(value => this.saveCredential(value, clean => {
        vision.apiKey = clean; revoke();
      }));
    });
    new Setting(parent).setName("允许发送手动选中的交易截图")
      .setDesc("在 LifeOps 聊天框粘贴图片会立即识别。通过文件选择器选图后，点击「发送并识别」才发送。更改服务、模型、地址或密钥后需要重新确认。")
      .addToggle(toggle => {
        uncheck = () => { toggle.setValue(false); };
        toggle.setValue(vision.tradeScreenshotDisclosureAccepted === true).onChange(async allowed => {
          vision.tradeScreenshotDisclosureAccepted = allowed;
          await this.plugin.saveSettings();
        });
      });
    new Setting(parent).setName("允许发送手动选中的健康截图")
      .setDesc("只在你选择图片并点击「发送并识别」时，将原图发送到这里配置的服务。更改服务配置后需要重新确认。")
      .addToggle(toggle => {
        uncheckHealth = () => { toggle.setValue(false); };
        toggle.setValue(vision.healthScreenshotDisclosureAccepted === true).onChange(async allowed => {
          vision.healthScreenshotDisclosureAccepted = allowed;
          await this.plugin.saveSettings();
        });
      });
  }

  private async saveCredential(value: string, apply: (clean: string) => void): Promise<void> {
    const clean = value.trim();
    if (clean && this.plugin.settings.privacy?.plaintextCredentialStorageAccepted !== true) {
      new Notice("请先确认页面顶部的 API Key 本地明文存储风险，再填写 Key。");
      this.display();
      return;
    }
    apply(clean);
    await this.plugin.saveSettings();
  }
}
