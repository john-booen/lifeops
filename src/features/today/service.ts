import { Notice } from "obsidian";
import { normalizeJournalDate } from "../../date";
import { fileRevision } from "../../operationIdentity";
import type { StoreHost } from "../../store/settingsSlice";
import type { TaskDashboardData } from "../../types";
import { readJournalSignals } from "../journal/signalStore";
import { listIdeaCandidates } from "../ideas/candidates";
import { countDueQuizCards } from "../learning/quiz";
import type { SignalSource } from "../journal/signals";
import type { LocalOperationHost } from "../serviceHost";
import { taskOverloadNotice } from "../tasks/capacity";
import { buildTodayCard, existingJournalPlanTask, journalPlanChoices, journalPlanTaskSource, type JournalPlanChoice } from "./model";

export async function getTodayCard(store: StoreHost, board: TaskDashboardData) {
  const now = new Date();
  const [signals, ideas, quizDueCount] = await Promise.all([
    readJournalSignals(store, board.date).catch(() => []), listIdeaCandidates(store, now).catch(() => undefined),
    countDueQuizCards(store, board.date).catch(() => undefined)
  ]);
  return { ...buildTodayCard(board, signals, now), ...(ideas?.length ? { ideaCandidateCount: ideas.length } : {}),
    ...(quizDueCount !== undefined ? { quizDueCount } : {}) };
}

export async function addJournalPlanTask(host: LocalOperationHost, baseStore: StoreHost, plan: JournalPlanChoice): Promise<void> {
  if (normalizeJournalDate(plan.journalDate) !== plan.journalDate) throw Error("日记日期无效，请刷新今日卡片。");
  const selected = structuredClone(plan);
  let created = false, notice = "", taskId = "";
  let savedSource: SignalSource | undefined;
  const assertSource = async (store: StoreHost, source: SignalSource) => {
    if (!store.isManagedSourcePath(source.path) || !store.getFile(source.path)
      || fileRevision(await store.readPath(source.path)) !== source.sha256 || !store.isManagedSourcePath(source.path)) {
      throw Error("这条日记计划已变更，请刷新后再添加。");
    }
  };
  await host.saveLocalOperation("local_addJournalPlanTask", { source: journalPlanTaskSource(selected), title: selected.title }, async store => {
    created = false; notice = ""; savedSource = undefined;
    const notes = await readJournalSignals(store, selected.journalDate);
    const current = journalPlanChoices(notes).find(candidate => journalPlanTaskSource(candidate) === journalPlanTaskSource(selected)
      && candidate.source.sha256 === selected.source.sha256);
    if (!current) throw Error("这条日记计划已变更，请刷新后再添加。");
    const before = (await store.readTaskDb({ readOnly: true })).tasks;
    if (existingJournalPlanTask(before, current)) return;
    await assertSource(store, current.source);
    taskId = (await store.createTask({
      title: current.title, date: current.date, source: journalPlanTaskSource(current),
      sourceNotePath: current.source.path
    })).id;
    created = true;
    savedSource = current.source;
    notice = taskOverloadNotice(before, (await store.readTaskDb({ readOnly: true })).tasks, new Date());
  }, { assertBeforeCommit: async () => { if (savedSource) await assertSource(baseStore, savedSource); } });
  if (created && notice) host.onTaskOverload?.(taskId, notice);
  new Notice(created ? "已将日记计划加到任务。" + notice : "已有这项任务。");
  await host.refreshViews();
}
