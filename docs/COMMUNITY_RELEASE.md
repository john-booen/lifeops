# 发布到 Obsidian 社区目录

GitHub Release 已提供桌面端手动安装。本页供维护者准备社区目录提交。是否已可从 Obsidian 内搜索安装，以社区目录的实际状态为准。

## 已确定的项目信息

| 字段 | 内容 |
| --- | --- |
| GitHub 仓库 | https://github.com/john-booen/lifeops |
| 插件 ID | lifeops-assistant |
| 名称 | LifeOps Assistant |
| 维护者 | john-booen |
| 许可 | MIT |
| 平台 | 桌面端 |
| 简介 | Manage daily plans, habits, journals and reviews in your vault, with optional AI services. |

## 每个发布批次

1. 先完成针对性验证，再对准备安装的同一批次运行完整检查、虚构对话评测与同包隔离安装、重开、回退。
2. 为已验收的源码提交保留安装包指纹。新功能继续进入 dev 时，安装与发布仍采用该批次固定的提交和包。
3. 日用安装并核对心跳后，将该批次源码同步到 main。为实际版本建立不带 v 的标签，例如 0.5.90，并发布同名 Release；兼容的 v 标签可同时保留。
4. Release 附上 main.js、manifest.json、styles.css，以及许可证和校验文件。下载后逐项核对与已验收包一致。
5. 核对 main 的 manifest 版本、Release 标签及安装包版本相同，线上 CI 通过。自动检查成功与社区审核通过分别记录。

## 首次社区提交

1. 在 [Obsidian Community](https://community.obsidian.md) 登录 Obsidian 账号，连接拥有仓库的 GitHub 账号。
2. 在目录中添加插件，仓库填上面的地址，所有者选择实际维护者。目录会读取默认分支的清单，版本应指向已上传的 Release。
3. 选择免费项目，说明第三方模型可能收费；以 README 中的数据发送范围为准。截图仅使用仓库内已审核的虚构界面图。
4. 查看 Manifest、Releases、Source code 和 Build verification 的审核结果。需要修正时，按批提交并发布新版本，重新核对审核状态。审核通过后才在安装说明中加入社区目录入口。

首次提交需要 Obsidian 账号及 GitHub 连接。这里不代替账号登录、目录所有权或最终审核。

官方依据：[插件清单](https://docs.obsidian.md/Reference/Manifest)、[提交插件](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)、[账号与所有权](https://docs.obsidian.md/community-directory/set-up-and-claim)、[提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)、[管理审核](https://docs.obsidian.md/community-directory/manage-entry)。
