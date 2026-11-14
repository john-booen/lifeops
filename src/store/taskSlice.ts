import { addDays, datesBetween, formatDate, normalizeJournalDate, todayString } from "../date";
import { buildTaskFromInput, parseVaultTasks } from "../vaultApi";
import { TaskConflictError, taskReadSnapshot, readTaskFile, validateTaskRecords, validateTaskMirrorRevision, persistTaskDatabase, persistTaskMirror } from "../dataFoundation/taskPersistence";
import type { LifeOpsTask, LifeOpsTaskInput, LifeOpsTaskQuadrant, TaskDashboardData } from "../types";
import {
  isTaskOnDate,
  isTaskOverdue,
  nextRepeatedTaskDates,
  normalizeTasks,
  sortTasks,
  type StoreHost,
  type TaskDatabase
} from "./settingsSlice";
import { bindDashboardContextData, contextDataPolicy, readContextHabits, readContextTasks } from "../contextData";
import { automaticHabitProgress } from "../features/habits/tradeProgress";
import { isHealthHabitSource } from "../features/health/habitSources";
import { advanceCompensationDebt } from "../features/habits/compensationDebt";
import { isVaultPathExcluded } from "../privacy";
import { taskCompletionDay } from "../taskSchedule";

type StoreConstructor = { prototype: object };

function shiftedPlanEndDate(task: LifeOpsTask, newDate: string): string {
  if ((!task.startTime && !task.endTime) || !task.endDate) return "";
  if (!normalizeJournalDate(newDate) || normalizeJournalDate(task.date) !== task.date
    || normalizeJournalDate(task.endDate) !== task.endDate) throw new Error("请先确认跨天安排的日期。");
  const utcDay = (value: string) => { const [y, m, d] = value.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return addDays(normalizeJournalDate(newDate), (utcDay(task.endDate) - utcDay(task.date)) / 86400000);
}

export interface TaskSliceApi {
  createTask(input: LifeOpsTaskInput): Promise<LifeOpsTask>;
  completeTask(taskId: string, note?: string, completionDate?: string): Promise<void>;
  completeTaskAndLog(taskId: string, date?: string, note?: string, completionDate?: string): Promise<void>;
  abandonTask(taskId: string): Promise<void>;
  moveTaskToQuadrant(taskId: string, quadrant: LifeOpsTaskQuadrant): Promise<void>;
  postponeTask(taskId: string, days: number): Promise<void>;
  postponeTasks(taskIds: string[], days: number): Promise<void>;
  skipRepeatedTask(taskId: string): Promise<void>;
  moveTaskToDate(taskId: string, date: string): Promise<void>;
  duplicateTaskToDate(taskId: string, date: string): Promise<void>;
  updateTaskDetails(taskId: string, input: LifeOpsTaskInput): Promise<void>;
  moveTaskOrder(taskId: string, direction: "up" | "down"): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  getTaskDashboard(date?: string, options?: { forContext?: boolean }): Promise<TaskDashboardData>;
  updateTask(taskId: string, updater: (task: LifeOpsTask) => LifeOpsTask): Promise<void>;
  getTask(taskId: string): Promise<LifeOpsTask>;
  createNextRepeatedTask(task: LifeOpsTask, completedAt: string): Promise<void>;
  readTaskDb(options?: { readOnly?: boolean }): Promise<TaskDatabase>;
  writeTaskDb(db: TaskDatabase): Promise<void>;
  writeTaskMirror(tasks: LifeOpsTask[]): Promise<void>;
}

const taskSlice = {
async createTask(this: StoreHost, input: LifeOpsTaskInput): Promise<LifeOpsTask> {
    if (input.category?.trim() === "punishment" && !input.habitPunishment) {
      throw Error("补偿待办由习惯规则生成，请在习惯面板配置。");
    }
    const db = await this.readTaskDb();
    const task = buildTaskFromInput(input, new Date(), () => `task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    db.tasks.push(task);
    await this.writeTaskDb(db);
    return task;
  },

async completeTask(this: StoreHost, taskId: string, note: string = "", completionDate?: string): Promise<void> {
    const now = new Date(), today = formatDate(now);
    if (completionDate !== undefined && (!completionDate || normalizeJournalDate(completionDate) !== completionDate || completionDate > today)) {
      throw Error("完成日期须为有效的今天或过去日期。");
    }
    const day = completionDate ?? today, updatedAt = now.toISOString();
    const completedAt = completionDate ?? updatedAt;
    const db = await this.readTaskDb();
    const index = db.tasks.findIndex(task => task.id === taskId);
    if (index < 0 || db.tasks[index].status !== "active") throw new Error("未找到可完成的进行中任务");
    if (db.tasks[index].habitPunishment?.rule) {
      const excluded = this.settings.privacy?.excludedVaultPrefixes;
      const habits = isVaultPathExcluded(this.habitDbPath(), excluded) ? [] : (await this.readHabitDb()).habits;
      db.tasks = advanceCompensationDebt(db.tasks, habits, day, this.settings.habitCompensation);
    }
    const task = db.tasks[index];
    if (task.ideaId) {
      const { completeLinkedIdeaTask } = await import("../features/ideas/progress");
      await completeLinkedIdeaTask(this, task.ideaId, day);
    }
    if (task.category === "learning" && (task.learningTrackId || task.sourceNotePath)) {
      const { recordLearningTask } = await import("../features/learning/store");
      await recordLearningTask(this, task, day, note);
    }
    db.tasks[index] = { ...task, status: "completed", completedAt, updatedAt,
      completionLog: [...task.completionLog, { completedAt, note: note.trim() }] };
    await this.writeTaskDb(db);
    await this.createNextRepeatedTask(task, updatedAt);
  },

async completeTaskAndLog(this: StoreHost, taskId: string, date: string = todayString(), note: string = "", completionDate?: string): Promise<void> {
    const task = await this.getTask(taskId);
    const completionNote = note.trim();
    await this.completeTask(taskId, completionNote, completionDate);
    await this.appendActivity("tasks", date, "已完成", `- [x] ${task.title}${completionNote ? `：${completionNote}` : ""}`);
  },

async abandonTask(this: StoreHost, taskId: string): Promise<void> {
    await this.updateTask(taskId, (task) => ({
      ...task,
      status: "abandoned"
    }));
  },

async moveTaskToQuadrant(this: StoreHost, taskId: string, quadrant: LifeOpsTaskQuadrant): Promise<void> {
    await this.updateTask(taskId, (task) => ({
      ...task,
      quadrant
    }));
  },

async postponeTask(this: StoreHost, taskId: string, days: number): Promise<void> {
    await this.updateTask(taskId, (task) => {
      const baseDate = task.date || todayString();
      return {
        ...task,
        date: addDays(baseDate, days),
        endDate: task.endDate ? addDays(task.endDate, days) : "",
        dueDate: task.dueDate ? addDays(task.dueDate, days) : ""
      };
    });
  },

async postponeTasks(this: StoreHost, taskIds: string[], days: number): Promise<void> {
    const ids = new Set(taskIds);
    if (ids.size === 0) return;

    const db = await this.readTaskDb();
    let changed = false;
    const now = new Date().toISOString();
    db.tasks = db.tasks.map((task) => {
      if (!ids.has(task.id) || task.status !== "active") return task;
      const baseDate = task.date || todayString();
      changed = true;
      return {
        ...task,
        date: addDays(baseDate, days),
        endDate: task.endDate ? addDays(task.endDate, days) : "",
        dueDate: task.dueDate ? addDays(task.dueDate, days) : "",
        updatedAt: now
      };
    });
    if (!changed) return;
    await this.writeTaskDb(db);
    await this.writeTaskMirror(db.tasks);
  },

async skipRepeatedTask(this: StoreHost, taskId: string): Promise<void> {
    await this.updateTask(taskId, (task) => {
      if (task.repeatUnit === "none") {
        throw new Error("只有重复任务才能跳过本次");
      }
      const next = nextRepeatedTaskDates(task);
      if (task.repeatUntil && next.date > task.repeatUntil) {
        return {
          ...task,
          status: "abandoned",
          note: task.note ? `${task.note}\n\n已跳过最后一次重复任务。` : "已跳过最后一次重复任务。"
        };
      }
      return {
        ...task,
        date: next.date,
        endDate: next.endDate,
        dueDate: next.dueDate
      };
    });
  },

async moveTaskToDate(this: StoreHost, taskId: string, date: string): Promise<void> {
    const value = date.trim();
    if (!value) {
      throw new Error("日期不能为空");
    }
    await this.updateTask(taskId, (task) => ({
      ...task,
      date: value,
      endDate: shiftedPlanEndDate(task, value)
    }));
  },

async duplicateTaskToDate(this: StoreHost, taskId: string, date: string): Promise<void> {
    const task = await this.getTask(taskId);
    await this.createTask({
      title: task.title,
      priority: task.priority,
      quadrant: task.quadrant,
      category: task.category,
      estimateMin: task.estimateMin,
      ideaId: task.ideaId,
      learningTrackId: task.learningTrackId,
      project: task.project,
      date,
      endDate: shiftedPlanEndDate(task, date),
      time: task.time,
      startTime: task.startTime,
      endTime: task.endTime,
      dueDate: task.dueDate,
      dueTime: task.dueTime,
      repeatUnit: task.repeatUnit,
      repeatInterval: task.repeatInterval,
      repeatUntil: task.repeatUntil,
      parentTaskId: task.parentTaskId || task.id,
      note: task.note,
      source: task.source,
      sourceNotePath: task.sourceNotePath
    });
  },

async updateTaskDetails(this: StoreHost, taskId: string, input: LifeOpsTaskInput): Promise<void> {
    const title = input.title.trim();
    if (!title) {
      throw new Error("任务标题不能为空");
    }

    await this.updateTask(taskId, (task) => {
      if (input.category?.trim() === "punishment" && task.category !== "punishment") throw Error("补偿待办由习惯规则生成。");
      if (task.habitPunishment && input.repeatUnit && input.repeatUnit !== "none") throw Error("补偿待办按每次习惯判定生成。");
      return {
        ...task,
        title,
        priority: input.priority ?? task.priority,
        quadrant: input.quadrant ?? task.quadrant,
        category: input.category === undefined ? task.category : input.category.trim() || "work",
        ...(Object.hasOwn(input, "learningTrackId") || input.category && input.category !== "learning" ? { learningTrackId: input.learningTrackId } : {}),
        ...(Object.hasOwn(input, "estimateMin") ? { estimateMin: input.estimateMin } : {}),
        project: input.project === undefined ? task.project : input.project.trim() || "默认",
        date: input.date === undefined ? task.date : input.date.trim(),
        endDate: input.endDate === undefined ? task.endDate : input.endDate.trim() || "",
        time: input.time === undefined ? task.time : input.time.trim() || "",
        ...(input.startTime === undefined ? {} : { startTime: input.startTime.trim() }),
        ...(input.endTime === undefined ? {} : { endTime: input.endTime.trim() }),
        dueDate: input.dueDate === undefined ? task.dueDate : input.dueDate.trim() || "",
        dueTime: input.dueTime === undefined ? task.dueTime : input.dueTime.trim() || "",
        repeatUnit: input.repeatUnit ?? task.repeatUnit,
        repeatInterval: Math.max(1, input.repeatInterval ?? task.repeatInterval ?? 1),
        repeatUntil: input.repeatUntil === undefined ? task.repeatUntil : input.repeatUntil.trim() || "",
        note: input.note === undefined ? task.note : input.note.trim() || ""
      };
    });
  },

async moveTaskOrder(this: StoreHost, taskId: string, direction: "up" | "down"): Promise<void> {
    const db = await this.readTaskDb();
    const tasks = db.tasks.slice().sort(sortTasks);
    const index = tasks.findIndex((task) => task.id === taskId);
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || swapIndex < 0 || swapIndex >= tasks.length) return;

    const current = tasks[index];
    const other = tasks[swapIndex];
    const currentOrder = current.sortOrder;
    current.sortOrder = other.sortOrder;
    other.sortOrder = currentOrder;
    current.updatedAt = new Date().toISOString();
    other.updatedAt = current.updatedAt;
    await this.writeTaskDb(db);
    await this.writeTaskMirror(db.tasks);
  },

async deleteTask(this: StoreHost, taskId: string): Promise<void> {
    const db = await this.readTaskDb();
    const nextTasks = db.tasks.filter((task) => task.id !== taskId);
    if (nextTasks.length === db.tasks.length) {
      throw new Error("未找到任务");
    }
    db.tasks = nextTasks;
    await this.writeTaskDb(db);
    await this.writeTaskMirror(db.tasks);
  },

async getTaskDashboard(this: StoreHost, date: string = todayString(), options: { forContext?: boolean } = {}): Promise<TaskDashboardData> {
    const policy = options.forContext ? contextDataPolicy(this) : undefined;
    const taskContext = options.forContext ? await readContextTasks(this) : undefined;
    const habitContext = options.forContext ? await readContextHabits(this) : undefined;
    const db = taskContext ? { tasks: taskContext.tasks } : await this.readTaskDb();
    const habitDb = habitContext ? habitContext.database : await this.readHabitDb();
    const progress = habitContext ? { checkins: habitDb.checkins, unavailable: habitContext.tradeUnavailable, healthPartial: habitContext.healthPartial }
      : await automaticHabitProgress(this, habitDb);
    const tasks = (options.forContext ? db.tasks.slice()
      : advanceCompensationDebt(db.tasks, habitDb.habits, todayString(), this.settings.habitCompensation)).sort(sortTasks);
    const allActive = tasks.filter((task) => task.status === "active");
    const tomorrow = addDays(date, 1);
    const nextSeven = addDays(date, 7);
    const quadrants: Record<LifeOpsTaskQuadrant, LifeOpsTask[]> = {
      "important-urgent": [],
      "important-not-urgent": [],
      "not-important-urgent": [],
      "not-important-not-urgent": []
    };
    for (const task of allActive) {
      quadrants[task.quadrant].push(task);
    }

    const dashboard: TaskDashboardData = {
      date,
      tasks,
      today: allActive.filter((task) => isTaskOnDate(task, date)),
      tomorrow: allActive.filter((task) => isTaskOnDate(task, tomorrow)),
      nextSevenDays: allActive.filter((task) => task.date && task.date > date && task.date <= nextSeven),
      overdue: allActive.filter((task) => isTaskOverdue(task, date)),
      completedToday: tasks.filter((task) => task.status === "completed" && taskCompletionDay(task.completedAt) === date),
      noDate: allActive.filter((task) => !task.date),
      allActive,
      quadrants,
      calendar: datesBetween(date, nextSeven).map((day) => ({
        date: day,
        tasks: allActive.filter((task) => isTaskOnDate(task, day))
      })),
      habits: await this.buildHabitDashboard(progress.checkins, date, { ...habitDb, checkins: progress.checkins }, progress.unavailable)
    };
    // Only a saved habit entry can be undone from the habit card.
    const savedToday = new Set(habitDb.checkins.filter(entry => entry.date === date).map(entry => entry.habitId));
    for (const item of dashboard.habits) {
      if (!isHealthHabitSource(item.habit.source)) continue;
      if (progress.healthPartial) item.healthCoveragePartial = true;
      if (!options.forContext && item.checkin && !savedToday.has(item.habit.id)) item.checkinFromHealth = true;
    }
    if (taskContext && habitContext && policy) {
      if (contextDataPolicy(this) !== policy) throw new Error("当前记录权限变化，无法核对上下文。");
      bindDashboardContextData(dashboard, { tasks: taskContext, habits: habitContext, policy });
    }
    return dashboard;
  },

async updateTask(this: StoreHost, taskId: string, updater: (task: LifeOpsTask) => LifeOpsTask): Promise<void> {
    const db = await this.readTaskDb();
    const index = db.tasks.findIndex((task) => task.id === taskId);
    if (index === -1) {
      throw new Error("未找到任务");
    }
    db.tasks[index] = { ...updater(db.tasks[index]), updatedAt: new Date().toISOString() };
    await this.writeTaskDb(db);
    await this.writeTaskMirror(db.tasks);
  },

async getTask(this: StoreHost, taskId: string): Promise<LifeOpsTask> {
    const db = await this.readTaskDb();
    const task = db.tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error("未找到任务");
    }
    return task;
  },

async createNextRepeatedTask(this: StoreHost, task: LifeOpsTask, completedAt: string): Promise<void> {
    if (task.repeatUnit === "none") return;

    const next = nextRepeatedTaskDates(task);
    if (task.repeatUntil && next.date > task.repeatUntil) return;

    await this.createTask({
      title: task.title,
      priority: task.priority,
      quadrant: task.quadrant,
      category: task.category,
      estimateMin: task.estimateMin,
      ideaId: task.ideaId,
      learningTrackId: task.learningTrackId,
      project: task.project,
      date: next.date,
      endDate: next.endDate,
      time: task.time,
      startTime: task.startTime,
      endTime: task.endTime,
      dueDate: next.dueDate,
      dueTime: task.dueTime,
      repeatUnit: task.repeatUnit,
      repeatInterval: task.repeatInterval,
      repeatUntil: task.repeatUntil,
      parentTaskId: task.parentTaskId || task.id,
      note: task.note,
      source: task.source,
      sourceNotePath: task.sourceNotePath,
      sortOrder: new Date(completedAt).getTime()
    });
  },

async readTaskDb(this: StoreHost, options: { readOnly?: boolean } = {}): Promise<TaskDatabase> {
    const json = await readTaskFile(this, this.taskDbPath());
    const mirror = await readTaskFile(this, this.taskMirrorPath());
    const db = await this.readJson<TaskDatabase>(this.taskDbPath(), { tasks: [] });
    validateTaskMirrorRevision(db);
    if (db.tasks.length === 0 && mirror && /^\s*-\s+\[[ xX]\]/m.test(mirror)
      && (json !== null || parseVaultTasks(mirror).length === 0)) throw new TaskConflictError();
    const useMirror = json === null && db.tasks.length === 0 && mirror !== null;
    const records = useMirror ? parseVaultTasks(mirror!) : db.tasks;
    validateTaskRecords(records);
    const tasks = normalizeTasks(records);
    // Reading never repairs a file. A symbol carries the exact read revision through
    // object spreads, while JSON serialization never writes it into user data.
    return { ...db, tasks, [taskReadSnapshot]: { json, mirror, source: useMirror ? "mirror" : "json" } };
  },

async writeTaskDb(this: StoreHost, db: TaskDatabase): Promise<void> {
    await persistTaskDatabase(this, db);
  },

async writeTaskMirror(this: StoreHost, tasks: LifeOpsTask[]): Promise<void> {
    await persistTaskMirror(this, tasks);
  }

};

export function applyTaskSlice(Store: StoreConstructor): void {
  Object.assign(Store.prototype, taskSlice);
}
