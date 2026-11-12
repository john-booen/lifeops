# LifeOps Assistant

LifeOps 是一个 Obsidian 插件。用同一个面板管理任务、打卡、日记和复盘。日常记录保存在你选择的库里；需要文字 AI 或语音时，可以自行配置服务。

![LifeOps 今日管家，展示虚构的任务与打卡记录](docs/images/lifeops-overview.png)

## 安装

1. 从你信任的发布渠道拿到同一版本的 `main.js`、`manifest.json` 和 `styles.css`。开发者可按下方命令自己构建。
2. 在一个 Obsidian 库的 `.obsidian/plugins/lifeops-assistant/` 放入这三个文件。打开该库（如果库已经打开，复制完先重载该库），在「设置 → 第三方插件」启用 LifeOps Assistant。
3. 在首次向导里选「开始本地使用」。在命令面板输入「打开 LifeOps」进入面板，试建一项任务，再到「最近操作」撤销。
4. 可选：到「设置 → LifeOps Assistant」配置文字 AI 或语音。打开对应的数据发送开关前，先核对服务和发送范围。

在新库试用时，任务、日记、习惯和报告放在 `LifeOps/` 下。使用已有库前，先备份库文件和插件设置。当前安装流程在 macOS 上的 Obsidian 1.15.0 验证过。交易功能用于记录和复盘。

## 模型与数据

- 「开始本地使用」可以手动管理任务、打卡和日记，无需模型账号。使用文字 AI 时，在「设置 → LifeOps Assistant → 文字 AI」填写所选服务的接口、模型和自己的 API Key，再核对并打开文本发送开关。启用后，问题和本次功能所需的库内内容会发给配置的服务，例如 Kimi。
- 语音可在「语音对话」配置百炼，按所选模式发送音频或用于朗读的文字。Breeze 本地朗读需要自行配置 Python、模型和参考音频。启用视觉或向量检索时，所选图片或文本会按对应设置发送给配置的服务。
- 插件当前无强制付费或 LifeOps 账号。第三方服务可能要求账号和付费。当前版本将已配置的密钥保存在插件的本地设置文件 `data.json`，不要把它或含密钥的备份随代码分享。
- 可选的「外部只读资料库」仅访问你配置的库和目录，用于查阅资料。默认空库不接外部目录。启用 AI 后，发送范围仍由各功能的授权和排除目录控制。

## 开发

```sh
npm ci --ignore-scripts --no-audit
npm run typecheck
npm test
npm run release:prepare
```

开发和反馈只使用虚构资料。参见 [使用指南](docs/USER_GUIDE.md)、[数据格式](docs/DATA_MODEL.md)、[贡献指南](CONTRIBUTING.md)和[版本记录](CHANGELOG.md)。

## English

LifeOps is an Obsidian plugin for local tasks, habits, journals, and reviews. Optional text and voice services require explicit configuration and consent. Build it from source or install the three plugin files into a test vault, then follow the first-run guide. It does not place trades.
