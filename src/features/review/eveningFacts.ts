import { dashboardContextData } from "../../contextData";
import type { TaskDashboardData } from "../../types";
import { isTaskScheduledForDay, isTaskWindow } from "../../taskSchedule";
import { isHabitRequiredOn } from "../habits/targets";

/** Keep reminder targets identical to the tasks named by the original review. */
export function eveningTaskCandidates(board: TaskDashboardData) {
  return [...new Map([...board.today.filter(task => !isTaskWindow(task) || isTaskScheduledForDay(task, board.date)), ...board.overdue].map(task => [task.id, task])).values()];
}

/** Read the original dashboard projection; never assess or change habits here. */
export function eveningReason(board: TaskDashboardData): string {
  const context = dashboardContextData(board);
  const habits = board.habits.filter(item => item.habit.source !== "trades" && isHabitRequiredOn(item.habit, board.date));
  const excusedHabits = habits.filter(item => item.status === "leave").length;
  const missingHabits = habits.filter(item => item.status !== "leave" && item.healthUnrecorded).length;
  const recordedHabits = habits.filter(item => item.status !== "leave" && !item.healthUnrecorded);
  const trades = board.habits.filter(item => item.habit.source === "trades" && (item.requiredToday
    || item.periodUnavailable && isHabitRequiredOn(item.habit, board.date)));
  const tradeProgress = trades.map(item => item.habit.name + " " + (item.periodUnavailable ? "暂不可用"
    : item.periodDone + "/" + item.periodTarget + (item.periodUnit ?? "笔"))).join("、");
  const penalties = board.tasks.filter(task => task.status === "active" && task.habitPunishment?.judgedDate === board.date);
  const tasks = eveningTaskCandidates(board);
  const examples = tasks.slice(0, 3).map(task => task.title).join("、");
  const taskLine = context?.tasks.available === false ? "任务和补偿记录暂不可用。"
    : (context?.tasks.filtered ? "可读任务中还有 " : "还有 ") + tasks.length + " 项今日或逾期任务"
      + (examples ? "，包括" + examples + "。" : "。")
      + (penalties.length ? "今天新生成 " + penalties.length + " 项补偿：" + penalties.map(task => task.title).slice(0, 3).join("、") + "。"
        : "今天暂无新补偿。");
  if (context?.habits.available === false) return taskLine + "习惯和交易目标记录暂不可用。";
  const habitLine = recordedHabits.length
    ? "习惯已完成 " + recordedHabits.filter(item => item.status === "done").length + "/" + recordedHabits.length + " 项。" : "";
  const leaveLine = excusedHabits ? excusedHabits + " 项习惯已请假。" : "";
  const missingLine = missingHabits ? missingHabits + " 项设备习惯缺少读数。" : "";
  return taskLine + (tradeProgress ? "交易目标 " + tradeProgress + "。" : "今日没有待核对的交易目标。")
    + (habits.length ? habitLine + leaveLine + missingLine : "今日没有需核对的习惯。");
}

