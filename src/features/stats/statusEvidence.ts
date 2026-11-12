const RECENT_STATUS_QUESTIONS = [
  /^(?:(?:说说|说一下|讲讲|看看|总结一下)我?|我)?(?:最近|近期)的?(?:整体)?状态(?:怎么样|怎样|如何)?$/u,
  /^我(?:最近|近期)过得(?:怎么样|怎样|如何)$/u
];

export function asksForRecentStatus(message: string): boolean {
  const question = message.trim().replace(/^请[问你]?[，, ]*/u, "").replace(/[。！？!?]+$/u, "");
  return RECENT_STATUS_QUESTIONS.some(pattern => pattern.test(question));
}

export const recentStatusDomains = ["tasks", "habits", "journal"] as const;

interface StatusStats {
  domain: typeof recentStatusDomains[number];
  plannedCount?: number;
  completedPlannedCount?: number;
  habits?: { doneCount?: number }[];
  count?: number;
  signalAverages?: Record<string, number | null>;
  scope?: string;
  tradeGoals?: string;
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function formatRecentStatus(outputs: string[], range: { from: string; to: string }): string {
  const stats = new Map<StatusStats["domain"], StatusStats>();
  for (const output of outputs) {
    let data: StatusStats;
    try { data = JSON.parse(output); } catch { continue; }
    if (data && recentStatusDomains.includes(data.domain)) stats.set(data.domain, data);
  }
  const tasks = stats.get("tasks");
  const habits = stats.get("habits");
  const journal = stats.get("journal");
  const taskLine = count(tasks?.plannedCount) && count(tasks.completedPlannedCount) && tasks.completedPlannedCount <= tasks.plannedCount
    ? `安排了 ${tasks.plannedCount} 项任务，完成其中 ${tasks.completedPlannedCount} 项。` : "任务记录暂不可用。";
  const habitLine = Array.isArray(habits?.habits) && habits.habits.every(row => count(row?.doneCount))
    ? `${habits.habits.filter(row => (row.doneCount ?? 0) > 0).length} 项习惯有达标记录，共 ${habits.habits.length} 项纳入统计。`
      + (habits.tradeGoals ? "交易目标进度暂不可用。" : "")
    : "习惯记录暂不可用。";
  const signalLabels = { energy: "精力", mood: "情绪", stress: "压力", sleepHours: "睡眠", sleepQuality: "睡眠质量" };
  const signals = Object.entries(signalLabels).flatMap(([field, label]) => {
    const value = journal?.signalAverages?.[field];
    return typeof value === "number" && Number.isFinite(value) ? [`${label} ${value}${field === "sleepHours" ? " 小时" : " / 5"}`] : [];
  });
  const journalLine = count(journal?.count)
    ? `有 ${journal.count} 篇日记。${signals.length ? `有记录项目的平均值为${signals.join("、")}。` : "没有可核对的状态数值。"}`
    : "日记状态暂不可用。";
  const scope = [...stats.values()].some(item => item.scope) ? "\n\n仅统计允许读取的资料。" : "";
  return `近 7 天（${range.from} 至 ${range.to}）\n\n- ${taskLine}\n- ${habitLine}\n- ${journalLine}${scope}`;
}
