import { Notice } from "obsidian";
import type LifeOpsPlugin from "../../main";
import { HabitCheckinModal, HabitDetailModal, HabitModal } from "../../modals";
import { isHealthHabitSource } from "../health/habitSources";
import { addDays, formatDate } from "../../date";
import { assertRecordRevision, recordRevision } from "../../operationIdentity";
import { isVaultPathExcluded } from "../../privacy";
import type { StoreHost } from "../../store/settingsSlice";
import type { HabitCheckinStatus, HabitDashboardItem, HabitDefinition, HabitInput } from "../../types";
import type { LocalOperationHost } from "../serviceHost";
import { advanceCompensationDebt } from "./compensationDebt";
import { firstUncheckedHabitDay, habitDayGoalMet } from "./punishments";

type HabitUiHost = Pick<LifeOpsPlugin, "app" | "createHabit" | "updateHabit">;
type HabitCheckinHost = Pick<LifeOpsPlugin, "app"> & LocalOperationHost;

export function openHabitModal(this: HabitUiHost): void {
  new HabitModal(this.app, async (habit) => {
    await this.createHabit(habit);
    new Notice("LifeOps 已创建习惯");
  }).open();
}

export function openHabitEditModal(this: HabitUiHost, habit: HabitDefinition): void {
  new HabitModal(
    this.app,
    async (input) => {
      await this.updateHabit(habit.id, input, recordRevision(habit));
      new Notice("LifeOps 已更新习惯");
    },
    habitToInput(habit),
    { title: "编辑习惯", submit: "保存修改" }
  ).open();
}

export function openHabitDetailModal(this: HabitUiHost, item: HabitDashboardItem): void {
  new HabitDetailModal(this.app, item).open();
}

export function openHabitCheckinModal(this: HabitCheckinHost, habit: HabitDefinition, defaults: { status?: HabitCheckinStatus; date?: string; note?: string } = {}): void {
  new HabitCheckinModal(this.app, habit, async (input) => {
    const args = [habit.id, input.status, input.date, input.note, input.value] as const;
    await this.saveLocalOperation("local_recordHabitStatus", { arguments: args }, store => store.recordHabitStatus(...args));
    await this.refreshViews();
    new Notice("LifeOps 已保存打卡记录");
  }, defaults).open();
}

export async function recordHabit(this: LocalOperationHost, habit: HabitDefinition): Promise<void> {
  await this.saveLocalOperation("local_recordHabit", { arguments: [habit.id] }, store => store.recordHabit(habit.id));
  await this.refreshViews();
}

export async function recordHabitStatus(this: LocalOperationHost, habitId: string, status: HabitCheckinStatus, date?: string, note = ""): Promise<void> {
  await this.saveLocalOperation("local_recordHabitStatus", { arguments: [habitId, status, date, note] }, store => store.recordHabitStatus(habitId, status, date, note));
  await this.refreshViews();
}

export async function clearHabitCheckin(this: LocalOperationHost, habitId: string, date?: string): Promise<void> {
  await this.saveLocalOperation("local_clearHabitCheckin", { arguments: [habitId, date] }, store => store.clearHabitCheckin(habitId, date));
  await this.refreshViews();
}

export async function createHabit(this: LocalOperationHost, habit: HabitInput): Promise<void> {
  await this.saveLocalOperation("local_createHabit", { arguments: [habit] }, store => store.createHabit(habit));
  await this.refreshViews();
}

export async function updateHabit(this: LocalOperationHost, habitId: string, habit: HabitInput, expectedRevision?: string): Promise<void> {
  await this.saveLocalOperation("local_updateHabitDetails", { arguments: [habitId, habit], expectedRevision }, async store => {
    assertRecordRevision((await store.getHabitDefinitions()).find(item => item.id === habitId), expectedRevision);
    await store.updateHabitDetails(habitId, habit);
  });
  await this.refreshViews();
}

export async function deleteHabit(this: LocalOperationHost, habitId: string): Promise<void> {
  await this.saveLocalOperation("local_deleteHabit", { arguments: [habitId] }, store => store.deleteHabit(habitId));
  await this.refreshViews();
}

export async function acceptPunishments(this: LocalOperationHost): Promise<void> {
  await this.saveLocalOperation("local_acceptPunishments", { arguments: [] }, store => store.acceptPunishments());
  await this.refreshViews();
}

export async function correctYesterdayHabit(host: LocalOperationHost, taskId: string, value?: number, now = new Date()): Promise<void> {
  const date = formatDate(now), yesterday = addDays(date, -1);
  await host.saveLocalOperation("local_correctYesterdayHabit", { taskId, date: yesterday, value }, async store => {
    const tasks = await store.readTaskDb({ readOnly: true });
    const task = tasks.tasks.find(row => row.id === taskId);
    const penalty = task?.habitPunishment;
    if (!task || task.status !== "active" || penalty?.period !== "day" || penalty.judgedDate !== yesterday) {
      throw Error("这条补偿已变更，请刷新后再核对。");
    }
    const db = await store.readHabitDb();
    const habit = db.habits.find(row => row.id === penalty.habitId);
    if (!habit || habit.source === "trades") throw Error("这项习惯无法手动补记。");
    if ([store.habitDbPath(), store.taskDbPath()].some(path => isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes))) {
      throw Error("习惯或任务记录不可用。");
    }
    if (!habitDayGoalMet(habit, db.checkins, yesterday)) {
      await store.recordHabitStatus(habit.id, "done", yesterday, "昨晚补记", value);
      if (habit.target?.kind !== "number") {
        const updated = await store.readHabitDb();
        const checkin = updated.checkins.find(row => row.habitId === habit.id && row.date === yesterday)!;
        if (checkin.count < habit.targetCount) {
          checkin.count = habit.targetCount;
          await store.writeHabitDb(updated);
          await store.writeHabitMirror(updated.habits, updated.checkins);
        }
      }
    }
    if (!habitDayGoalMet(habit, (await store.readHabitDb()).checkins, yesterday)) return;
    const remaining = tasks.tasks.map(row => row.id === task.id
      ? { ...row, status: "abandoned" as const, updatedAt: now.toISOString() } : row);
    await store.writeTaskDb({ ...tasks, tasks: advanceCompensationDebt(remaining, db.habits, date, store.settings.habitCompensation) });
  });
  await host.refreshViews();
}

export async function confirmYesterdayHabit(this: HabitCheckinHost, store: StoreHost, taskId: string): Promise<void> {
  const task = (await store.readTaskDb({ readOnly: true })).tasks.find(row => row.id === taskId);
  const habit = (await store.readHabitDb()).habits.find(row => row.id === task?.habitPunishment?.habitId);
  if (!habit || task?.status !== "active") throw Error("这条补偿已变更，请刷新后再核对。");
  if (habit.target?.kind !== "number") return correctYesterdayHabit(this, taskId);
  const date = task.habitPunishment!.judgedDate;
  new HabitCheckinModal(this.app, habit, async entry => {
    if (entry.status !== "done" || entry.date !== date) throw Error("请填写昨晚完成的实际数值。");
    await correctYesterdayHabit(this, taskId, entry.value);
  }, { status: "done", date }).open();
}

export async function runScheduledPunishmentCheck(
  host: LocalOperationHost, store: StoreHost, now: Date, assertCurrent: () => void
): Promise<void> {
  const excluded = store.settings.privacy?.excludedVaultPrefixes;
  if ([store.habitDbPath(), store.taskDbPath()].some(path => isVaultPathExcluded(path, excluded))) return;
  const date = formatDate(now), db = await store.readHabitDb();
  const through = now.getHours() >= 21 ? date : addDays(date, -1);
  if (!db.habits.some(habit => habit.punishment?.enabled && !isHealthHabitSource(habit.source) && firstUncheckedHabitDay(db, habit, date) <= through)
    && !(await store.readTaskDb({ readOnly: true })).tasks.some(task => task.status === "active"
      && task.habitPunishment?.rule && task.habitPunishment.debt?.appliedOn !== date)) return;
  await host.saveLocalOperation("local_checkHabitPunishments", { date }, scope => scope.checkPunishments(now), { assertCurrent });
  await host.refreshViews();
}

function habitToInput(habit: HabitDefinition): HabitInput {
  return {
    name: habit.name,
    frequencyUnit: habit.frequencyUnit,
    frequencyInterval: habit.frequencyInterval,
    targetCount: habit.targetCount,
    target: habit.target,
    punishment: habit.punishment,
    startDate: habit.startDate,
    penaltyThreshold: habit.penaltyThreshold,
    color: habit.color,
    source: habit.source
  };
}
