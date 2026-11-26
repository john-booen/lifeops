export const RECORDED_DATA_SCOPE = {
  population: "permitted_registered_records",
  unrecordedActivity: "unknown",
  explanation: "仅统计本轮允许读取的登记记录；空记录不能证明现实中没有行动、没有交易，或绩效稳定。"
} as const;

export const COMPLETION_INTERVAL_MEANING = "任务登记到完成的经过时间，包含等待和跨日间隔，不是实测工作工时。";

export const TASK_METRIC_DEFINITIONS = {
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
