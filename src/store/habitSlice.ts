import { acknowledgeAccountability, hasPendingAccountability } from "../accountability";
import { randomUUID } from "node:crypto";
import { addDays, datesBetween, formatDate, parseLocalDate, todayString, weekDates } from "../date";
import { isContextDataProjection } from "../contextData";
import { firstUncheckedHabitDay, planHabitPunishments } from "../features/habits/punishments";
import { advanceCompensationDebt } from "../features/habits/compensationDebt";
import { assertTradeHabitSource, tradeHabitProgress } from "../features/habits/tradeProgress";
import { habitMeasurementUnit, habitRecordedAmount, numericHabitPeriods, validateHabitPunishment, validateHabitTarget } from "../features/habits/targets";
import { isVaultPathExcluded } from "../privacy";
import { buildTaskFromInput } from "../vaultApi";
import type {
  HabitCheckin,
  HabitCheckinStatus,
  HabitDefinition,
  HabitInput,
  TaskDashboardData
} from "../types";
import {
  habitFrequencyLabel,
  habitPeriodProgress,
  habitStatusLabel,
  isHabitRequiredOn,
  isHabitWeekClosed,
  isPastHabitDay,
  normalizeHabitDefinitions,
  weeklyHabitFailures,
  type HabitDatabase,
  type StoreHost
} from "./settingsSlice";

type StoreConstructor = { prototype: object };

export interface HabitSliceApi {
  createHabit(input: HabitInput): Promise<HabitDefinition>;
  updateHabitDetails(habitId: string, input: HabitInput): Promise<void>;
  deleteHabit(habitId: string): Promise<void>;
  clearHabitCheckin(habitId: string, date?: string): Promise<void>;
  recordHabitStatus(habitId: string, status: HabitCheckinStatus, date?: string, note?: string, value?: number, unit?: string): Promise<void>;
  checkPunishments(now?: Date, acknowledgeLegacy?: boolean): Promise<void>;
  acceptPunishments(): Promise<void>;
  getWeeklyFailures(date: string, database?: HabitDatabase): Promise<Record<string, number>>;
  hasOpenPunishment(): Promise<boolean>;
  buildHabitDashboard(checkins: HabitCheckin[], date: string, database?: HabitDatabase, tradeUnavailable?: boolean): Promise<TaskDashboardData["habits"]>;
  countHabitStreak(checkins: HabitCheckin[], habitId: string, date: string): number;
  readHabitDb(): Promise<HabitDatabase>;
  writeHabitDb(db: HabitDatabase): Promise<void>;
  getHabitDefinitions(): Promise<HabitDefinition[]>;
  writeHabitMirror(habits: HabitDefinition[], checkins: HabitCheckin[]): Promise<void>;
}

const habitSlice = {
async createHabit(this: StoreHost, input: HabitInput): Promise<HabitDefinition> {
    const name = input.name.trim();
    if (!name) {
      throw new Error("习惯名称不能为空");
    }

    const db = await this.readHabitDb();
    const now = new Date().toISOString();
    const habit: HabitDefinition = {
      id: `habit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      frequencyUnit: input.frequencyUnit,
      frequencyInterval: Math.max(1, input.frequencyInterval || 1),
      targetCount: Math.max(1, input.targetCount || 1),
      target: validateHabitTarget(input.target),
      punishment: validateHabitPunishment(input.punishment),
      startDate: input.startDate?.trim() || todayString(),
      penaltyThreshold: input.penaltyThreshold ?? 3,
      color: input.color || "#27ae60",
      createdAt: now,
      source: input.source
    };
    assertTradeHabitSource(habit.source, habit.target, habit.frequencyUnit, habit.frequencyInterval);

    db.habits.push(habit);
    await this.writeHabitDb(db);
    await this.writeHabitMirror(db.habits, db.checkins);
    return habit;
  },

async updateHabitDetails(this: StoreHost, habitId: string, input: HabitInput): Promise<void> {
    const name = input.name.trim();
    if (!name) {
      throw new Error("习惯名称不能为空");
    }

    const db = await this.readHabitDb();
    const habit = db.habits.find((item) => item.id === habitId);
    if (!habit) {
      throw new Error("未找到习惯");
    }
    const target = Object.hasOwn(input, "target") ? validateHabitTarget(input.target) : habit.target;
    const source = Object.hasOwn(input, "source") ? input.source || undefined : habit.source;
    const interval = Math.max(1, input.frequencyInterval || 1);
    assertTradeHabitSource(source, target, input.frequencyUnit, interval);
    if (source === "trades" && habit.source !== "trades" && db.checkins.some(item => item.habitId === habitId)) {
      throw new Error("这项习惯已有手动记录，请另外新建交易笔数习惯。");
    }
    if (habit.target?.kind === "number" && (target?.kind !== "number" || target.unit !== habit.target.unit)
      && db.checkins.some(item => item.habitId === habitId && item.value !== undefined)) {
      throw Error("已有数值记录。请保留原单位，或为另一单位新建习惯。");
    }
    Object.assign(habit, {
      name,
      frequencyUnit: input.frequencyUnit,
      frequencyInterval: interval,
      targetCount: Math.max(1, input.targetCount || 1),
      target,
      ...(Object.hasOwn(input, "punishment") ? { punishment: validateHabitPunishment(input.punishment) } : {}),
      startDate: input.startDate?.trim() || habit.startDate,
      penaltyThreshold: input.penaltyThreshold ?? habit.penaltyThreshold,
      color: input.color || habit.color,
      source
    });
    await this.writeHabitDb(db);
    await this.writeHabitMirror(db.habits, db.checkins);
  },

async deleteHabit(this: StoreHost, habitId: string): Promise<void> {
    const db = await this.readHabitDb();
    const nextHabits = db.habits.filter((habit) => habit.id !== habitId);
    if (nextHabits.length === db.habits.length) {
      throw new Error("未找到习惯");
    }
    db.habits = nextHabits;
    db.checkins = db.checkins.filter((checkin) => checkin.habitId !== habitId);
    if (db.habitPunishmentCheckedThrough) delete db.habitPunishmentCheckedThrough[habitId];
    await this.writeHabitDb(db);
    await this.writeHabitMirror(db.habits, db.checkins);
  },

async clearHabitCheckin(this: StoreHost, habitId: string, date: string = todayString()): Promise<void> {
    const db = await this.readHabitDb();
    const nextCheckins = db.checkins.filter((checkin) => !(checkin.habitId === habitId && checkin.date === date));
    if (nextCheckins.length === db.checkins.length) {
      throw new Error("今天还没有这项打卡记录");
    }
    db.checkins = nextCheckins;
    await this.writeHabitDb(db);
    await this.writeHabitMirror(db.habits, db.checkins);
  },

async recordHabitStatus(this: StoreHost,
    habitId: string,
    status: HabitCheckinStatus,
    date: string = todayString(),
    note: string = "",
    value?: number,
    unit?: string
  ): Promise<void> {
    const db = await this.readHabitDb();
    const habit = db.habits.find((item) => item.id === habitId);
    if (!habit) {
      throw new Error("未找到习惯");
    }
    if (habit.source === "trades" && status !== "leave") throw new Error("交易笔数由交易记录自动计算，可在这里请假。");

    const existing = db.checkins.find((item) => item.habitId === habitId && item.date === date);
    const configuredUnit = habit.target?.kind === "number" ? habit.target.unit : undefined;
    const suppliedUnit = habitMeasurementUnit(unit);
    const valueUnit = configuredUnit ?? suppliedUnit;
    if (configuredUnit && status === "done" && value === undefined) throw Error(`请填写本次实际数值（${configuredUnit}）。`);
    if (value !== undefined) {
      if (status !== "done" || !Number.isFinite(value) || value < 0 || !valueUnit || unit !== undefined && !suppliedUnit) {
        throw Error("记录实际量时需要非负数值、明确单位和完成状态。");
      }
      if (configuredUnit && suppliedUnit && configuredUnit !== suppliedUnit) throw Error(`请按${configuredUnit}记录这项习惯。`);
      if (existing?.value !== undefined && (existing.valueUnit ?? configuredUnit) !== valueUnit) {
        throw Error("同一天已有不同单位的数值记录，请先核对。");
      }
    }
    const priorValue = typeof existing?.value === "number" && Number.isFinite(existing.value) ? Math.max(0, existing.value) : 0;
    const nextValue = value === undefined ? existing?.value : priorValue + value;
    if (nextValue !== undefined && !Number.isFinite(nextValue)) throw Error("累计数值超出可记录范围。");
    const count = existing?.count ?? 0;
    const nextCount = status !== "done" ? count : configuredUnit ? count + 1 : Math.min(habit.targetCount, count + 1);
    const updated: HabitCheckin = {
      habitId,
      date,
      status,
      count: nextCount,
      ...(nextValue === undefined ? {} : { value: nextValue }),
      ...(value === undefined || !valueUnit ? {} : { valueUnit }),
      updatedAt: new Date().toISOString(),
      note: note.trim()
    };

    if (existing) {
      Object.assign(existing, updated);
    } else {
      db.checkins.push(updated);
    }

    await this.writeHabitDb(db);
    await this.writeHabitMirror(db.habits, db.checkins);

    const quantity = value !== undefined ? ` ${value} ${valueUnit}` : "";
    const suffix = quantity + (note.trim() ? `：${note.trim()}` : "");
    const marker =
      status === "done" ? `- [x] ${habit.name}${suffix}` : status === "missed" ? `- [ ] ${habit.name}（未完成）${suffix}` : `- ${habit.name}（请假）${suffix}`;
    await this.appendActivity("habits", date, "打卡", marker);
  },

async checkPunishments(this: StoreHost, now: Date = new Date(), acknowledgeLegacy = false): Promise<void> {
    if (acknowledgeLegacy) {
      const file = this.getFile(this.path(this.settings.folders.habits, "Punishments.md"));
      if (file) await this.app.vault.process(file, acknowledgeAccountability);
    }
    const excluded = this.settings.privacy?.excludedVaultPrefixes;
    if ([this.habitDbPath(), this.taskDbPath()].some(path => isVaultPathExcluded(path, excluded))) return;
    const db = await this.readHabitDb();
    const date = formatDate(now);
    const through = now.getHours() >= 21 ? date : addDays(date, -1);
    const tasks = await this.readTaskDb({ readOnly: true });
    const progress = await tradeHabitProgress(this, db, true);
    const eligible = db.habits.filter(habit => habit.punishment?.enabled && !(progress.unavailable && habit.source === "trades"));
    const checked: Record<string, string> = Object.assign(Object.create(null), db.habitPunishmentCheckedThrough);
    const windows = eligible.map(habit => ({ habit, from: firstUncheckedHabitDay(db, habit, date) }));
    const nextTasks = tasks.tasks.slice();
    for (const day of datesBetween(addDays(date, -7), through)) {
      const due = windows.filter(({ habit, from }) => day >= from
        || day === date && habit.source === "trades" && checked[habit.id] === day);
      if (!due.length) continue;
      const judged = parseLocalDate(day);
      judged.setHours(21);
      const generated = planHabitPunishments(due.map(({ habit }) => habit), progress.checkins, nextTasks, judged);
      for (const task of generated) nextTasks.push(buildTaskFromInput(task, now, () => `task-${now.getTime()}-${randomUUID()}`));
      for (const { habit } of due) checked[habit.id] = day;
    }
    const next = advanceCompensationDebt(nextTasks, db.habits, date, this.settings.habitCompensation);
    if (next.length !== tasks.tasks.length || next.some((task, index) => task !== tasks.tasks[index])) {
      await this.writeTaskDb({ ...tasks, tasks: next });
    }
    if (Object.entries(checked).some(([habitId, day]) => db.habitPunishmentCheckedThrough?.[habitId] !== day)) {
      await this.writeHabitDb({ ...db, lastPunishmentDate: through, habitPunishmentCheckedThrough: checked });
    }
  },

async acceptPunishments(this: StoreHost): Promise<void> {
    await this.checkPunishments(undefined, true);
  },

async getWeeklyFailures(this: StoreHost, date: string, database?: HabitDatabase): Promise<Record<string, number>> {
    const failures: Record<string, number> = {};
    const raw = database ?? await this.readHabitDb();
    const progress = database ? undefined : await tradeHabitProgress(this, raw);
    const habits = progress?.unavailable ? raw.habits.filter(habit => habit.source !== "trades") : raw.habits;
    for (const habit of habits) {
      failures[habit.name] = 0;
    }

    const habitDb = progress ? { ...raw, checkins: progress.checkins } : raw;
    for (const habit of habits) {
      if (habit.target?.kind === "number") {
        const days = weekDates(date).filter(day => day <= date && isHabitRequiredOn(habit, day));
        const entries = new Map(habitDb.checkins.filter(item => item.habitId === habit.id).map(item => [item.date, item]));
        const { perDay, perWeek } = habit.target;
        if (perDay) failures[habit.name] += days.filter(day => {
          const checkin = entries.get(day);
          return checkin?.status === "missed" || isPastHabitDay(day) && checkin?.status !== "leave" && habitRecordedAmount(habit, checkin) < perDay;
        }).length;
        if (perWeek && days.length && date >= weekDates(date)[6] && isHabitWeekClosed(date)
          && days.some(day => entries.get(day)?.status !== "leave")
          && weekDates(date).filter(day => day >= habit.startDate && day <= date)
            .reduce((sum, day) => sum + habitRecordedAmount(habit, entries.get(day)), 0) < perWeek) failures[habit.name]++;
        continue;
      }
      if (habit.frequencyUnit === "week") {
        failures[habit.name] = weeklyHabitFailures(habit, habitDb.checkins, date);
        continue;
      }

      for (const day of weekDates(date)) {
        if (day > date) continue;
        if (!isHabitRequiredOn(habit, day)) continue;
        const checkin = habitDb.checkins.find((item) => item.habitId === habit.id && item.date === day);
        if (checkin?.status === "missed" || (!checkin && isPastHabitDay(day))) {
          failures[habit.name] += 1;
        }
      }
    }
    return failures;
  },

async hasOpenPunishment(this: StoreHost): Promise<boolean> {
    const text = await this.readPath(this.path(this.settings.folders.habits, "Punishments.md"));
    return hasPendingAccountability(text);
  },

async buildHabitDashboard(this: StoreHost, checkins: HabitCheckin[], date: string, database?: HabitDatabase, tradeUnavailable = false): Promise<TaskDashboardData["habits"]> {
    const weeklyFailures = await this.getWeeklyFailures(date, tradeUnavailable && database
      ? { ...database, habits: database.habits.filter(habit => habit.source !== "trades") } : database);
    const habits = database?.habits ?? await this.getHabitDefinitions();
    return habits.map((habit) => {
      const checkin = checkins.find((item) => item.habitId === habit.id && item.date === date);
      const period = habitPeriodProgress(habit, checkins, date);
      const periodFailures = weeklyFailures[habit.name] ?? 0;
      const weekly = period.label === "本周";
      const auto = habit.source === "trades", unavailable = auto && tradeUnavailable;
      const status = habit.target?.kind === "number"
        ? checkin?.status === "leave" || checkin?.status === "missed" ? checkin.status : period.done >= period.target ? "done" : "pending"
        : checkin?.status ?? (weekly && period.done >= period.target ? "done" : weekly && periodFailures > 0 ? "missed" : "pending");
      return {
        habit,
        checkin,
        status,
        streak: this.countHabitStreak(auto ? checkins.filter(entry => habitRecordedAmount(habit, entry) >= period.target) : checkins, habit.id, date),
        weeklyFailures: periodFailures,
        totalDone: checkins
          .filter((item) => item.habitId === habit.id && item.status === "done")
          .reduce((sum, item) => sum + Math.max(1, item.count || 1), 0),
        requiredToday: !unavailable && isHabitRequiredOn(habit, date) && (!weekly || period.done < period.target),
        periodDone: period.done,
        periodTarget: period.target,
        periodLabel: period.label,
        ...(period.unit ? { periodUnit: period.unit } : {}),
        ...(unavailable ? { periodUnavailable: true } : {}),
        history: checkins.filter((item) => item.habitId === habit.id)
      };
    });
  },

countHabitStreak(this: StoreHost, checkins: HabitCheckin[], habitId: string, date: string): number {
    let streak = 0;
    let cursor = date;
    while (true) {
      const checkin = checkins.find((item) => item.habitId === habitId && item.date === cursor);
      if (checkin?.status !== "done") break;
      streak += 1;
      cursor = addDays(cursor, -1);
    }
    return streak;
  },

async readHabitDb(this: StoreHost): Promise<HabitDatabase> {
    const db = await this.readJson<Partial<HabitDatabase>>(this.habitDbPath(), { habits: [], checkins: [] });
    return {
      ...db,
      habits: normalizeHabitDefinitions(db.habits ?? []),
      checkins: db.checkins ?? []
    };
  },

async writeHabitDb(this: StoreHost, db: HabitDatabase): Promise<void> {
    if (isContextDataProjection(db)) throw new Error("AI上下文只读副本不能写回习惯记录。");
    await this.writeJson(this.habitDbPath(), db);
  },

async getHabitDefinitions(this: StoreHost): Promise<HabitDefinition[]> {
    return (await this.readHabitDb()).habits;
  },

async writeHabitMirror(this: StoreHost, habits: HabitDefinition[], checkins: HabitCheckin[]): Promise<void> {
    const markdown = [
      "# LifeOps 习惯打卡",
      "",
      "> 这个文件由 LifeOps 插件维护。插件用它保留可读快照，正式统计以 LifeOps 打卡库为准。",
      "",
      ...habits.map((habit) => {
        const numericTarget = habit.target?.kind === "number" ? habit.target : undefined;
        const targets = numericHabitPeriods(habit).map(({ period, goal }) => `- ${period === "day" ? "每日" : "每周"}目标：${goal} ${numericTarget?.unit}`);
        const rows = checkins
          .filter((item) => item.habitId === habit.id)
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, 30)
          .map(item => {
            const unit = item.valueUnit ?? numericTarget?.unit;
            const measured = unit && item.value !== undefined ? `，${item.value} ${unit}` : "";
            return `- ${item.date}：${habitStatusLabel(item.status)}${measured}${item.note ? `，${item.note}` : ""}`;
          });
        return [
          `## ${habit.name}`,
          "",
          `- 频率：${habitFrequencyLabel(habit)}`,
          ...(targets.length ? targets : [`- 目标次数：${habit.targetCount}`]),
          `- 开始日期：${habit.startDate}`,
          "",
          rows.length > 0 ? rows.join("\n") : "- 暂无记录"
        ].join("\n");
      }),
      ""
    ].join("\n");
    await this.writeFile(this.habitMirrorPath(), markdown);
  }
};

export function applyHabitSlice(Store: StoreConstructor): void {
  Object.assign(Store.prototype, habitSlice);
}
