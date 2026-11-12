# LifeOps Assistant

LifeOps 是一个 Obsidian 插件。用同一个面板管理任务、打卡、日记和复盘。日常记录保存在你选择的库里；需要文字 AI 或语音时，可以自行配置服务。

![LifeOps 今日管家，展示虚构的任务与打卡记录](docs/images/lifeops-overview.png)

## 安装

1. 从你信任的发布渠道拿到同一版本的 `main.js`、`manifest.json` 和 `styles.css`。开发者可按下方命令自己构建。
2. 在一个 Obsidian 库的 `.obsidian/plugins/lifeops-assistant/` 放入这三个文件。打开该库（如果库已经打开，复制完先重载该库），在「设置 → 第三方插件」启用 LifeOps Assistant。
3. 在首次向导里选「开始本地使用」。在命令面板输入「打开 LifeOps」进入面板，试建一项任务，再到「最近操作」撤销。
4. 可选：到「设置 → LifeOps Assistant」配置文字 AI 或语音。打开对应的数据发送开关前，先核对服务和发送范围。

在新库试用时，任务、日记、习惯和报告放在 `LifeOps/` 下。使用已有库前，备份库文件和插件设置。交易功能只记录和复盘。

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
