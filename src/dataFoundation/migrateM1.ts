import { newLocalOperationId } from "../operationIdentity";
import { normalizeHabitDefinitions, type HabitDatabase, type StoreHost, type TaskDatabase } from "../store/settingsSlice";
import type { HabitDefinition, LifeOpsTask } from "../types";
import { OperationLedger } from "./operationLedger";

const missingCategory = (task: LifeOpsTask) => typeof task.category !== "string" || !task.category.trim();
const missingHabitFields = (habit: HabitDefinition) => habit.target === undefined || habit.punishment === undefined;

async function migrationInputs(store: StoreHost) {
  const [tasks, habits] = await Promise.all([
    store.getFile(store.taskDbPath()) ? store.readJson<TaskDatabase>(store.taskDbPath(), { tasks: [] }) : undefined,
    store.readJson<HabitDatabase>(store.habitDbPath(), { habits: [], checkins: [] })
  ]);
  return {
    tasks, habits,
    taskCount: tasks?.tasks.filter(missingCategory).length ?? 0,
    habitCount: habits.habits.filter(missingHabitFields).length
  };
}

export async function migrateM1Fields(store: StoreHost, assertCurrent?: () => void): Promise<{ tasks: number; habits: number }> {
  if (!store.runFactOperation) return { tasks: 0, habits: 0 };
  assertCurrent?.();
  const before = await migrationInputs(store);
  if (!before.taskCount && !before.habitCount) return { tasks: 0, habits: 0 };

  assertCurrent?.();
  const ledger = new OperationLedger(store);
  const operationId = newLocalOperationId("m1-migration");
  const claim = await ledger.claim({ operationId, toolName: "migrate_m1_fields", source: "system", arguments: { version: 1 } });
  if (claim.kind !== "execute") throw Error("数据迁移尚未就绪。");
  try {
    return await store.runFactOperation({ operationId }, async scope => {
      const { tasks, habits, taskCount, habitCount } = await migrationInputs(scope);
      if (taskCount && tasks) {
        const snapshot = await scope.readTaskDb({ readOnly: true });
        await scope.writeTaskDb({ ...snapshot, tasks: tasks.tasks.map(task => missingCategory(task) ? { ...task, category: "work" } : task) });
      }
      if (habitCount) {
        normalizeHabitDefinitions(habits.habits);
        await scope.writeHabitDb({ ...habits, habits: habits.habits.map(habit => missingHabitFields(habit) ? {
          ...habit, target: habit.target ?? { kind: "boolean" }, punishment: habit.punishment ?? { enabled: false, rules: [] }
        } : habit) });
      }
      return { tasks: taskCount, habits: habitCount };
    }, async result => {
      await ledger.verify(operationId, { success: true, actions: [],
        output: `已兼容 ${result.tasks} 项任务和 ${result.habits} 项习惯。` });
    }, { assertCurrent });
  } catch (error) {
    await ledger.failClaim(claim.record, "迁移未完成，请检查原记录或恢复备份。").catch(() => undefined);
    throw error;
  }
}
