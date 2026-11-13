# 参与开发

从一个空库或仓库自带的虚构库开始。提交前运行 `npm run typecheck`、`npm test` 和 `npm run verify:privacy`。每次提交解决一个问题，提供能复现的虚构输入和期望结果。

维护者先运行 `git config core.hooksPath .githooks`，并用 `LIFEOPS_SENSITIVE_TERMS_FILE` 指向代码仓库外的敏感词清单。私人库内容、API Key、日常库路径和日志不要放进提交、议题或截图。CI 会独立检查通用密钥格式、个人路径和禁止的文件。

准备推送前，在完整克隆中运行 `npm run verify:privacy -- --history`，检查历史文件、提交说明和附注标签。

正式模型评测需要一个明确标为全虚构的隔离库。可在该库内另行授权模型服务，然后以 `LIFEOPS_EVAL_PROVIDER_CONFIG` 指向其插件设置运行 `npm run eval`。不要向评测提供日用库设置或数据。日用安装脚本只从代码仓库外的 `LIFEOPS_PRIVATE_RELEASE_CONFIG` 读取目标与备份目录。
