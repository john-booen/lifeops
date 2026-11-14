# LifeOps 架构

LifeOps 运行在 Obsidian 桌面插件内。日记和笔记存为 Markdown，任务、习惯、交易和学习记录存为库内 JSON。目录从设置读取，报表和检索索引从原始记录生成。手动记录和浏览可以在本地使用。

## 从输入到回执

1. [插件入口](../src/main.ts)注册面板、命令、设置和定时任务。「今天」等界面从本地记录读取进度。定时提醒由[调度器](../src/scheduler.ts)和[提醒生命周期](../src/proactiveLifecycle.ts)管理。
2. [文字和串联语音](../src/agent/run.ts)进入 [AgentLoop](../src/agent/AgentLoop.ts)。它组装本轮所需的上下文、请求所选模型并分派工具。独立的[实时语音](../src/voice/voiceRealtime.ts)可以调用同一个[工具执行入口](../src/agent/service.ts)。语音层负责转写、播放和插话；长报告的完整文字留在面板，朗读使用经数字核对的短稿。 端到端试验的模型提示、原生语音响应和工具回调在 [Omni E2E](../src/voice/omniE2e/) 中。串联语音启动时只配置转写链路。
3. [工具注册表](../src/toolRegistry.ts)声明工具参数与用途，[运行时](../src/agentRuntime.ts)核对调用和确认要求，再调用本地功能。统计、盈亏和补偿金额由功能代码计算。导入、删除和超过三项的批量修改先出确认卡。
4. [数据存储](../src/store.ts)通过 Obsidian 读写文件。用户操作经[写入保护](../src/dataFoundation/factOperation.ts)和[操作账本](../src/dataFoundation/operationLedger.ts)提交，回执展示实际结果。受管理的写入有恢复记录，可处理保存途中中断；已完成的用户操作可从「最近操作」撤销。

## 数据与服务

- [数据格式](DATA_MODEL.md)列出各类记录和位置。外部库使用用户指定的目录作只读来源。
- [功能可用性检查](../src/capabilityReadiness.ts)核对服务配置与授权。[隐私模块](../src/privacy.ts)处理排除目录与发送日志；日志记录服务、用途和大小，省略请求正文。
- [截图记交易](../src/features/trading/screenshotImportModal.ts)仅发送手动选择并确认的图片。模型返回候选字段，插件再做确认预览、去重和盈亏重算。保存后的交易沿用本地记录格式。

修改行为后，用仓库中的虚构夹具跑相关测试。公开仓只保留代码、虚构夹具和说明，日用安装路径从独立配置读取。测试和打包入口见[贡献指南](../CONTRIBUTING.md)。
