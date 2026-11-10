import type { DashboardStats, TaskDashboardData } from "../types";
import { taskScheduleLabel } from "../taskSchedule";
import type { LocalRecordKind } from "../localRecordNotes";
import type { NeuralDomain } from "./neuralRecordsModel";

export const HOME_MODULES = [
  { id: "life", label: "日记生活", color: "#c3bcf2", filter: "hue-rotate(215deg) saturate(1.1)" },
  { id: "tasks", label: "任务习惯", color: "#e2e5e8", filter: "hue-rotate(185deg) saturate(.3) brightness(1.15)" },
  { id: "learning", label: "学习写作", color: "#ace0cf", filter: "hue-rotate(118deg)" },
  { id: "projects", label: "事业项目", color: "#ecc98f", filter: "saturate(1)" },
  { id: "trading", label: "交易复盘", color: "#acd6e8", filter: "hue-rotate(158deg)" }
] as const;

export interface HomeBranch {
  id: string;
  title: string;
  meta: string;
  body: string;
  action: { label: string; kind: "tasks"; filter: string }
    | { label: string; kind: "habits" }
    | { label: string; kind: "record"; record: LocalRecordKind }
    | { label: string; kind: "library"; domain: NeuralDomain };
}

/** Only the already-loaded dashboard is read here; selecting a branch has no side effects. */
export function homeBranches(domain: NeuralDomain, stats: DashboardStats, board: TaskDashboardData): HomeBranch[] {
  if (domain === "tasks") {
    const seen = new Set<string>();
    const tasks = [...board.today, ...board.overdue, ...board.noDate].filter(task => {
      if (seen.has(task.id)) return false;
      seen.add(task.id); return true;
    });
    return [
      ...tasks.map(task => ({
        id: `task:${task.id}`, title: task.title,
        meta: [task.date ? `${task.date}${task.endDate && task.endDate !== task.date ? ` → ${task.endDate}` : ""}` : "未定日期", taskScheduleLabel(task), task.dueDate ? `截止 ${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ""}` : "", task.status === "completed" ? "已完成" : task.status === "abandoned" ? "已放弃" : "待完成"].filter(Boolean).join(" · "),
        body: [task.project ? `项目：${task.project}` : "", task.category ? `分类：${task.category}` : "", task.note || "暂无任务备注。"].filter(Boolean).join("\n\n"),
        action: { label: "在事务中查看", kind: "tasks" as const, filter: board.overdue.some(x => x.id === task.id) ? "overdue" : board.noDate.some(x => x.id === task.id) ? "no-date" : "today" }
      })),
      ...board.habits.map(item => ({
        id: `habit:${item.habit.id}`, title: item.habit.name,
        meta: item.status === "done" ? "已打卡" : item.status === "leave" ? "已请假" : item.status === "missed" ? "未完成" : "待打卡",
        body: `频率：每${item.habit.frequencyInterval === 1 ? "" : item.habit.frequencyInterval}${item.habit.frequencyUnit === "week" ? "周" : "天"}${item.habit.targetCount}次\n\n${item.periodLabel}：${item.periodDone} / ${item.periodTarget} 次\n\n连续完成 ${item.streak} 天。`,
        action: { label: "查看习惯与热图", kind: "habits" as const }
      }))
    ];
  }
  if (domain === "life") return [
    { id: "morning", title: "晨间日记", meta: board.date, body: stats.morningNoteExists ? "今天的晨间日记已有记录。打开原文继续阅读。" : "今天尚未记录晨间日记，可打开原入口。", action: { label: "打开晨间日记", kind: "record", record: "morning" } },
    { id: "evening", title: "晚间日记", meta: board.date, body: stats.eveningNoteExists ? "今天的晚间日记已有记录。打开原文继续阅读。" : "今天尚未记录晚间日记，可打开原入口。", action: { label: "打开晚间日记", kind: "record", record: "evening" } },
    libraryBranch(domain, "生活记录", "在记录库阅读已保存的日记与生活记录。")
  ];
  if (domain === "trading") return [
    { id: "trading-review", title: "今日交易复盘", meta: board.date, body: "打开原有复盘入口，记录过程、证据与纪律。", action: { label: "打开交易复盘", kind: "record", record: "trading-review" } },
    libraryBranch(domain, "复盘记录", "在记录库阅读已保存的交易复盘。")
  ];
  return [libraryBranch(domain, domain === "learning" ? "学习与写作记录" : "事业与项目记录",
    domain === "learning" ? "在记录库阅读已保存的学习、知识与写作原文。" : "在记录库阅读已保存的目标与项目记录。")];
}

function libraryBranch(domain: NeuralDomain, title: string, body: string): HomeBranch {
  return { id: `library:${domain}`, title, meta: "记录库", body, action: { label: "在记录库浏览", kind: "library", domain } };
}
