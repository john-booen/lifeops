# LifeOps 数据格式

路径均相对当前库，目录从设置读取。日期用本地 `YYYY-MM-DD`，时间点用带时区的 ISO 字符串。

## 存储与职责

| 数据 | 文件 | 写入方 | 读取方 | 性质 |
|---|---|---|---|---|
| 日记原文 | `folders.dailyRoot`，沿用晨晚命名 | 用户、明确要求的追加工具 | 日记、信号提取 | 用户原文 |
| 日记信号 | `folders.aiReports/Signals/YYYY-MM-DD.json` | 信号提取服务 | 上下文、统计、今日卡片 | 带出处的派生结果 |
| 任务 | `folders.tasks/LifeOps任务库.json` | 表单、任务工具、惩罚判定 | 排序、容量、统计、任务视图 | 用户安排与完成事实 |
| 习惯与打卡 | `folders.habits/LifeOps打卡库.json` | 表单、打卡工具、数值记录 | 习惯、统计、惩罚判定 | 目标配置与打卡事实 |
| 手机随手记原文 | `输入/手机随手记.md` | 手机或用户 | 桌面收件箱 | 逐行追加的用户原文 |
| 手机处理回执 | `folders.aiReports/System/phone-inbox.json` | 桌面收件箱 | 回执面板 | 行哈希、处理结果、待确认动作及操作 ID |
| 健康 | `folders.health/YYYY-MM-DD.md` | 本人手填或确认后的导入 | 今日卡片、习惯、摘要和统计 | 一天可有多次记录，各指标取最后有效值 |
| 交易 | `folders.tradingReviews/LifeOps交易记录.json` | 对话、表单、确认后的导入或回填 | 交易统计、纪律、复盘 | 用户记录与代码计算值 |
| 想法 | `folders.ideas/*.md` | 用户、新建想法工具、确认后的旧笔记登记 | 想法面板、督促、阅读关联 | 原文及登记元数据 |
| 学习轨道 | `folders.goals/LifeOps学习轨道.json` | 确认后的计划、学习记录工具 | 学习面板、统计、测验 | 计划与学习事实 |
| 复习卡 | `folders.goals/LifeOps复习卡.json` | 出题、判分及复习服务 | 测验、今日卡片 | 出处、题目和作答记录 |

任务和打卡沿用现有 JSON 顶层 `tasks`、`habits/checkins`。交易使用 `{version:1,trades:[]}`。学习轨道与复习卡分别使用 `{version:1,tracks:[]}`、`{version:1,cards:[]}`。学习两文件的默认父目录选用已有目标目录，纳入发布流程的 `LifeOps*.json` 备份。

## 日记、任务和习惯

**日记信号**按晨、晚分别保存。每段包含 `date`、`period`、`energy`、`mood`、`stress`、`sleepHours`、`sleepQuality`、`keyEvents[]`、`plans[{text,when}]`、`ideas[{text,quote}]`、`worries[]`、`quotes[{field,text}]`、`sources[{path,sha256}]`。原文未提供的信号用 `null`，列表缺失用空列表。原文和出处保留在各自文件，提取结果携带对应哈希。

**任务**沿用 `LifeOpsTask` 的身份、四象限、日期、时间区间、重复规则、来源、完成时间及 `completionLog`。新增 `estimateMin?:number`。分类推荐值为 `work|life|learning|trading|idea|punishment`，已有自定义 `category` 原值保留，缺失时默认 `work`。时长缺失按同类历史中位数，再缺失按 30 分钟计算。负荷和排序作为派生结果，原安排通过任务写入接口更新。

**习惯**沿用身份、名称、频率、目标次数和颜色。新增以下配置。

- `target?:{kind:"boolean"}|{kind:"number",unit:string,perDay?:number,perWeek?:number}`。
- `punishment?:{enabled:boolean,rules:PunishmentRule[]}`。
- 打卡沿用 `habitId/date/status/count/updatedAt/note`。实测量用 `value?:number` 和 `valueUnit?:string` 保存，数值目标沿用配置单位。按次数的习惯也可附记明确的实际量和单位。`count` 继续表示完成次数。

**补偿规则**分为存钱（`save_money`）、写反思（`reflection`）和加量运动（`extra_exercise`）。存钱和写反思可设 `dailyIncrease`，默认人民币每天加 50 元、反思每天加 100 字。生成的任务使用 `category:"punishment"`，以 `habitPunishment` 关联习惯与判定周期，并记录上次计算日期。欠账每天累加，直至完成。

运动按公里和分钟分别限制，旧账先分配。默认日限额按对应日目标的两倍计算，无同单位日目标时按补偿基数计算。单次硬上限为 3 公里或 30 分钟，同日累计硬上限为 5 公里或 60 分钟。超限部分默认按 20 元/公里、3 元/分钟折为存钱，可在设置中调整。字段和默认值见[类型定义](../src/types.ts)与[补偿计算](../src/features/habits/compensationDebt.ts)。

## 交易

**交易 Trade**包含以下字段。

- 身份与时间为 `id/openedAt/closedAt?/createdAt/updatedAt`。
- 标的为 `market:A股|美股|期货|外汇|加密`、`symbol`、`direction:long|short`、`qty?/qtyUnit?`。
- 金额为 `entry?/exit?/stop?/target?/fees?/pnl?`、`pnlSource:stated|computed|unknown`、`currency:CNY|USD`、`riskAmount?/rMultiple?/pnlMismatch?`。
- 依据为 `modelId?/modelVersionId?`、`planned:boolean|null`、`ruleViolations:string[]`、`emotion?/notes?`、`attachments:string[]`、`source:{kind:chat|form|csv|backfill,ref?}`。

盈亏和 R 倍数由代码计算，合约乘数从品种设置读取。普通录入若同时给出盈亏和可重算字段，明示盈亏保留，偏差超过 5% 时标记待核对。截图导入按本地重算值入账。字段不足时，截图盈亏仅写备注。每日 Markdown 镜像位于 `folders.tradingReviews/LifeOps交易/YYYY-MM-DD.md`，由 JSON 生成。

## 想法和学习

**想法 frontmatter**为 `lifeops:idea`、`status:seed|exploring|validating|building|parked|dropped`、`created`、`lastProgress`、`nextAction`、`nextReview`、`sources:string[]`。旧笔记登记经确认卡添加元数据，用户正文保留。日记或笔记发现的想法进入候选，对话明确提出的新想法直接登记。

**LearningTrack**为 `id/name/goal/targetDate?/weeklyMinutes/folders[]`、`units[{id,title,status:todo|doing|done,doneAt?}]`、`sessions[{date,minutes?,notePath?,summary?}]`。计划草案及调整使用确认卡，学习记录走现有低风险写入与撤销。进度和时长由代码计算。

**复习卡**为 `id/trackId/question/answer/sourcePath/ease/intervalDays/due/history[]`，历史项使用 `{at,userAnswer,correct,explanation}`。答对间隔按 1、3、7、15、30 天递增，答错回到 1 天并降低 `ease`。

## 写入、迁移与恢复

- 所有写入使用现有操作记录和撤销，删除、超过三项的批量变更、旧原文修改和导入使用确认卡。
- 新字段迁移先备份，重复执行保持相同结果。旧任务和打卡缺少新字段时使用兼容默认值。
- 写入时核对读取版本，冲突后重新读取并重试一次，仍冲突则告知用户。
- 日记、原笔记和用户事实各自保存，派生统计及模型解读携带出处。

各模块如何读写这些记录，见[架构说明](ARCHITECTURE.md)。
