import { Notice } from "obsidian";
import type LifeOpsPlugin from "../../main";
import { HabitCheckinModal, HabitDetailModal, HabitModal } from "../../modals";
import { formatDate } from "../../date";
import { assertRecordRevision, recordRevision } from "../../operationIdentity";
import { isVaultPathExcluded } from "../../privacy";
import type { StoreHost } from "../../store/settingsSlice";
import type { HabitCheckinStatus, HabitDashboardItem, HabitDefinition, HabitInput } from "../../types";
import type { LocalOperationHost } from "../serviceHost";

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

export async function runScheduledPunishmentCheck(
  host: LocalOperationHost, store: StoreHost, now: Date, assertCurrent: () => void
): Promise<void> {
  const excluded = store.settings.privacy?.excludedVaultPrefixes;
  if ([store.habitDbPath(), store.taskDbPath()].some(path => isVaultPathExcluded(path, excluded))) return;
  const date = formatDate(now), db = await store.readHabitDb();
  if (db.lastPunishmentDate === date) return;
  if (!db.habits.some(habit => habit.punishment?.enabled)
    && !(await store.readTaskDb({ readOnly: true })).tasks.some(task => task.status === "active" && task.habitPunishment?.rule)) return;
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
