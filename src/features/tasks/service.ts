import { Notice } from "obsidian";
import type LifeOpsPlugin from "../../main";
import { taskOverloadNotice } from "./capacity";
import { TaskActionsModal, TaskModal } from "../../modals";
import { assertRecordRevision, recordRevision } from "../../operationIdentity";
import type { LocalOperationHost } from "../serviceHost";
import type { LifeOpsTask, LifeOpsTaskInput, LifeOpsTaskQuadrant } from "../../types";

type TaskUiHost = Pick<LifeOpsPlugin,
  "app" | "createTask" | "updateTask" | "openTaskEditModal" | "completeTask" | "completeTaskAndLog"
  | "abandonTask" | "skipRepeatedTask" | "moveTaskToDate" | "postponeTask" | "duplicateTaskToDate"
  | "moveTaskOrder" | "deleteTask"
>;

export function openTaskModal(this: TaskUiHost): void {
  new TaskModal(this.app, async (task) => {
    await this.createTask(task);
  }).open();
}

export function openTaskModalWithDefaults(this: TaskUiHost, defaults: Partial<LifeOpsTaskInput>): void {
  new TaskModal(this.app, async (task) => {
    await this.createTask(task);
  }, defaults).open();
}

export function openTaskEditModal(this: TaskUiHost, task: LifeOpsTask): void {
  new TaskModal(
    this.app,
    async (input) => {
      await this.updateTask(task.id, input, recordRevision(task));
      new Notice("LifeOps 已更新任务");
    },
    taskToInput(task),
    { title: "编辑任务", submit: "保存修改" }
  ).open();
}

export function openTaskActionsModal(this: TaskUiHost, task: LifeOpsTask): void {
  new TaskActionsModal(this.app, task, {
    complete: async (note) => {
      await this.completeTask(task.id, note);
    },
    completeAndLog: async (note) => {
      await this.completeTaskAndLog(task.id, note);
    },
    edit: () => this.openTaskEditModal(task),
    abandon: async () => {
      await this.abandonTask(task.id);
    },
    skipRepeat: async () => {
      await this.skipRepeatedTask(task.id);
    },
    stopRepeat: async () => {
      await this.updateTask(task.id, {
        ...taskToInput(task),
        repeatUnit: "none",
        repeatInterval: 1,
        repeatUntil: ""
      }, recordRevision(task));
    },
    moveToDate: async (date) => {
      await this.moveTaskToDate(task.id, date);
    },
    postpone: async (days) => {
      await this.postponeTask(task.id, days);
    },
    duplicateToDate: async (date) => {
      await this.duplicateTaskToDate(task.id, date);
    },
    moveOrder: async (direction) => {
      await this.moveTaskOrder(task.id, direction);
    },
    delete: async () => {
      await this.deleteTask(task.id);
    }
  }).open();
}

export async function createTask(this: LocalOperationHost, task: LifeOpsTaskInput): Promise<void> {
  let loadNotice = "", taskId = "";
  await this.saveLocalOperation("local_createTask", { arguments: [task] }, async store => {
    const before = (await store.readTaskDb({ readOnly: true })).tasks;
    taskId = (await store.createTask(task)).id;
    loadNotice = taskOverloadNotice(before, (await store.readTaskDb({ readOnly: true })).tasks, new Date());
  });
  if (loadNotice) this.onTaskOverload?.(taskId, loadNotice);
  await this.refreshViews();
  new Notice("LifeOps 已创建任务。" + loadNotice);
}

export async function updateTask(this: LocalOperationHost, taskId: string, task: LifeOpsTaskInput, expectedRevision?: string): Promise<void> {
  await this.saveLocalOperation("local_updateTaskDetails", { arguments: [taskId, task], expectedRevision }, async store => {
    assertRecordRevision(await store.getTask(taskId), expectedRevision);
    await store.updateTaskDetails(taskId, task);
  });
  await this.refreshViews();
}

export async function deleteTask(this: LocalOperationHost, taskId: string): Promise<void> {
  await this.saveLocalOperation("local_deleteTask", { arguments: [taskId] }, store => store.deleteTask(taskId));
  await this.refreshViews();
}

export async function postponeTask(this: LocalOperationHost, taskId: string, days: number): Promise<void> {
  await this.saveLocalOperation("local_postponeTask", { arguments: [taskId, days] }, store => store.postponeTask(taskId, days));
  await this.refreshViews();
}

export async function postponeTasks(this: LocalOperationHost, taskIds: string[], days: number): Promise<void> {
  await this.saveLocalOperation("local_postponeTasks", { arguments: [taskIds, days] }, store => store.postponeTasks(taskIds, days));
  await this.refreshViews();
}

export async function skipRepeatedTask(this: LocalOperationHost, taskId: string): Promise<void> {
  await this.saveLocalOperation("local_skipRepeatedTask", { arguments: [taskId] }, store => store.skipRepeatedTask(taskId));
  await this.refreshViews();
}

export async function moveTaskToDate(this: LocalOperationHost, taskId: string, date: string): Promise<void> {
  await this.saveLocalOperation("local_moveTaskToDate", { arguments: [taskId, date] }, store => store.moveTaskToDate(taskId, date));
  await this.refreshViews();
}

export async function duplicateTaskToDate(this: LocalOperationHost, taskId: string, date: string): Promise<void> {
  await this.saveLocalOperation("local_duplicateTaskToDate", { arguments: [taskId, date] }, store => store.duplicateTaskToDate(taskId, date));
  await this.refreshViews();
}

export async function moveTaskOrder(this: LocalOperationHost, taskId: string, direction: "up" | "down"): Promise<void> {
  await this.saveLocalOperation("local_moveTaskOrder", { arguments: [taskId, direction] }, store => store.moveTaskOrder(taskId, direction));
  await this.refreshViews();
}

export async function completeTask(this: LocalOperationHost, taskId: string, note = ""): Promise<void> {
  await this.saveLocalOperation("local_completeTask", { arguments: [taskId, note] }, store => store.completeTask(taskId, note));
  await this.refreshViews();
}

export async function completeTaskAndLog(this: LocalOperationHost, taskId: string, note = ""): Promise<void> {
  await this.saveLocalOperation("local_completeTaskAndLog", { arguments: [taskId, undefined, note] }, store => store.completeTaskAndLog(taskId, undefined, note));
  await this.refreshViews();
}

export async function abandonTask(this: LocalOperationHost, taskId: string): Promise<void> {
  await this.saveLocalOperation("local_abandonTask", { arguments: [taskId] }, store => store.abandonTask(taskId));
  await this.refreshViews();
}

export async function moveTaskToQuadrant(this: LocalOperationHost, taskId: string, quadrant: LifeOpsTaskQuadrant): Promise<void> {
  await this.saveLocalOperation("local_moveTaskToQuadrant", { arguments: [taskId, quadrant] }, store => store.moveTaskToQuadrant(taskId, quadrant));
  await this.refreshViews();
}

function taskToInput(task: LifeOpsTask): LifeOpsTaskInput {
  return {
    title: task.title,
    priority: task.priority,
    quadrant: task.quadrant,
    category: task.category,
    estimateMin: task.estimateMin,
    learningTrackId: task.learningTrackId,
    project: task.project,
    date: task.date,
    endDate: task.endDate,
    scheduleMode: task.scheduleMode,
    time: task.time,
    startTime: task.startTime,
    endTime: task.endTime,
    dueDate: task.dueDate,
    dueTime: task.dueTime,
    repeatUnit: task.repeatUnit,
    repeatInterval: task.repeatInterval,
    repeatUntil: task.repeatUntil,
    parentTaskId: task.parentTaskId,
    note: task.note,
    source: task.source,
    sourceNotePath: task.sourceNotePath,
    sortOrder: task.sortOrder
  };
}
