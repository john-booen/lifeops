import { normalizeJournalDate, todayString, weekDates } from "./date";
import type { StoreHost } from "./store/settingsSlice";
import { taskScheduleLabel } from "./taskSchedule";
import type { VaultQuery } from "./vaultQuery";
import type { VaultQueryReader } from "./vaultQueryRead";

export function dailyQueryPaths(store: StoreHost, domain: "task" | "habit"): string[] {
  return domain === "task" ? [store.taskDbPath(), store.taskMirrorPath()] : [store.habitDbPath()];
}

export async function readDailyQuery(store: StoreHost, input: VaultQuery, reader: VaultQueryReader): Promise<string> {
  if (input.path || input.period) throw Error("任务和习惯查询使用日期或关键词，无需指定原文路径。");
  const date = input.date ? normalizeJournalDate(input.date) : todayString();
  if (!date) throw Error("查询日期无效，请提供有效日期。");
  const query = input.query?.trim().toLowerCase() ?? "";
  if (input.operation === "search" && !query) throw Error("搜索关键词为空，请提供关键词。");
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw Error("分页位置必须为非负整数。");
  const limit = Math.min(12, Math.max(1, Math.trunc(input.limit ?? 5) || 5));
  const days = input.range === "week" ? weekDates(date).filter(day => day <= date) : [date];
  const byDate = input.date !== undefined && input.date !== "" || input.range !== undefined;
  const range = days.length > 1 ? `${days[0]} 至 ${date}` : date;
  const [{ readContextHabits, readContextTasks }, { readPersonalMemoryWithSources }, { createPersonalMemoryContextFilter }] = await Promise.all([
    import("./contextData"), import("./personalMemorySources"), import("./personalMemoryContext")
  ]);
  const protect = createPersonalMemoryContextFilter((await readPersonalMemoryWithSources(store)).records);
  if (input.domain === "task") {
    const data = await readContextTasks(store);
    if (!data.available) return "任务记录未提供，当前状态未知。";
    const items = data.tasks.filter(task => (query ? `${task.title} ${task.id}`.toLowerCase().includes(query) : task.status === "active")
      && (!byDate || days.includes(task.date) || days.includes(task.dueDate)));
    const output = protect(page(`${byDate ? range : "全部"}任务（${data.filtered ? "仅限允许读取的记录" : "来自任务库"}）`, items.map(task => {
      const schedule = [task.date, taskScheduleLabel(task)].filter(Boolean).join(" ");
      return `- ${singleLine(task.title)} [${task.id}] · ${task.status}${schedule ? ` · ${schedule}` : ""}`;
    }), offset, limit));
    for (const source of data.reads ?? []) reader.dependOn(source.path, source.hash);
    if (data.source) reader.contributed(data.source.path, output, data.source.hash);
    return output;
  }
  const data = await readContextHabits(store);
  if (!data.available) return "习惯记录未提供，当前状态未知。";
  const { habits, checkins } = data.database;
  const items = habits.filter(habit => !query || `${habit.name} ${habit.id}`.toLowerCase().includes(query));
  const output = protect(page(`${range} 习惯打卡`, items.map(habit => {
    if (habit.source === "trades" && habit.target?.kind === "number" && habit.target.perDay) {
      const progress = data.tradeUnavailable ? "进度暂不可用" : "用 get_stats 的 habits 查询实际进度";
      return `- ${singleLine(habit.name)} [${habit.id}] · 每天 ${habit.target.perDay} 笔 · 从交易记录计算 · ${progress}`;
    }
    const records = checkins.filter(item => item.habitId === habit.id && days.includes(item.date));
    const completed = records.filter(item => item.status === "done");
    const count = completed.reduce((total, item) => total + (item.count ?? 1), 0);
    const missed = records.filter(item => item.status === "missed").length;
    const leave = records.filter(item => item.status === "leave").length;
    return `- ${singleLine(habit.name)} [${habit.id}] · 已完成${completed.length}天/${count}次 · 已记未完成${missed}天 · 请假${leave}天 · 目标${habit.targetCount}次/周期`;
  }), offset, limit));
  if (data.source) reader.contributed(data.source.path, output, data.source.hash);
  return output;
}

function singleLine(value: string): string { return value.replace(/\s+/gu, " ").trim(); }

function page(label: string, rows: string[], offset: number, limit: number): string {
  const shown = rows.slice(offset, offset + limit);
  return [`${label}，共${rows.length}项。`, ...shown,
    offset + shown.length < rows.length ? `后续位置 offset=${offset + shown.length}` : ""].filter(Boolean).join("\n");
}
