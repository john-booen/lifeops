export const RECORDED_DATA_SCOPE = {
  population: "permitted_registered_records",
  unrecordedActivity: "unknown",
  explanation: "仅统计本轮允许读取的登记记录；空记录不能证明现实中没有行动、没有交易，或绩效稳定。"
} as const;

export const COMPLETION_INTERVAL_MEANING = "任务登记到完成的经过时间，包含等待和跨日间隔，不是实测工作工时。";

export const TASK_METRIC_DEFINITIONS = {
  completedTaskCount: {
    unit: "tasks", identity: "taskId", dateBasis: "completion_registration_date",
    description: "按完成登记日期落在所问区间的任务编号去重数，与计划日期无关。同名不同编号仍分别计算；同一任务在多个日期完成，不把分日个数相加作区间总数。"
  },
  completedCount: {
    unit: "completion_events", dateBasis: "completion_registration_date",
    description: "所问区间的完成登记次数；同一任务可以登记多次，不能将次数当成不同任务个数。"
  },
  plannedCount: {
    unit: "tasks", dateBasis: "planned_date",
    description: "计划日期落在所问区间的任务数；不能用它筛选区间内登记完成的任务个数。跨月计划的任务在本月完成，仍计入本月完成数。"
  },
  averageCompletionMin: {
    unit: "minutes", from: "createdAt", to: "completedAt", isWorkingTime: false,
    description: "完成事件落在所问区间的有效记录，从任务登记到完成的平均经过时间；可能包含等待、睡眠和跨日间隔，不能据此断言拖延或临时需求挤占计划。"
  },
  completionPercent: {
    numerator: "completedPlannedCount", denominator: "plannedCount",
    description: "按本次统计区间的计划日期和完成记录计算；计划日期与完成日期都在本区间内，就计为区间计划内完成。同周隔天完成仍属该周计划内完成，同月跨天完成仍属该月计划内完成。隔天完成不等于周或月计划外，分日结果不能替代整个区间的计划完成率。"
  },
  plannedTime: {
    fields: ["estimateMin", "startTime", "endTime"], isWorkingTime: false,
    description: "任务估时与计划起止时段属于计划信息，均不是实测工作工时；本统计没有实际工作计时数据。"
  }
} as const;

/** Summary names are aliases of the same computed metrics, never a new basis. */
export const SUMMARY_TASK_METRIC_DEFINITIONS = {
  tasksCompleted: TASK_METRIC_DEFINITIONS.completedTaskCount,
  taskCompletionEvents: TASK_METRIC_DEFINITIONS.completedCount,
  taskCompletionPercent: TASK_METRIC_DEFINITIONS.completionPercent
} as const;

export const RECORDED_METRIC_REPLY_GUIDANCE = "数字口径：completedTaskCount和tasksCompleted均按完成登记日期、任务编号去重，与计划日期无关；completedCount/taskCompletionEvents是登记次数。计划日期只用于计划数及计划完成率，不把完成数称为按计划日期统计。各期间分别使用其range/through，不把本月截至目前说成整月。按用户所问指标、币种和分组简短对照；工具附带其他字段不代表需要全部汇报。只问数字时不附计划量、完成率、胜负笔数、规则遵守率、盈亏原因、收益评价或补记/修改邀请；明确要求分析或建议时才按证据补充。习惯、任务和项目等名称保留本轮记录中的原标签，解释含义时仍带原名，不能只换成同义词。批评和建议也受证据限制：原因没有登记就说明未核对，不用睡眠、情绪或完成率推断动机、精力取舍或因果。";
