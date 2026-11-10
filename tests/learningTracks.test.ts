import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { FactOperationOptions } from "../src/dataFoundation/factOperation";
import { LifeOpsEventBus } from "../src/lifeOpsEventBus";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}));
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { DiskVault } = await import("./helpers/diskVault");
const { existingLearningTrack, learningPath, readLearningDocument } = await import("../src/features/learning/store");
const { prepareLearningPlan, saveLearningPlan } = await import("../src/features/learning/plans");
const { subscribeLearningNotes } = await import("../src/features/learning/capture");
const { countDueQuizCards, quizPath, readQuizDocument } = await import("../src/features/learning/quiz");
const { applyQuizGrade } = await import("../src/features/learning/quizModel");
const { agentToolsForRealtime } = await import("../src/toolRegistry");
const { getTodayCard } = await import("../src/features/today/service");

const now = new Date("2026-11-12T20:00:00+08:00");
const units = Array.from({ length: 8 }, (_, index) => "虚构学习单元 " + (index + 1));
const modelDraft = JSON.stringify({ goal: "完成虚构基础练习", weeklyMinutes: 90, units });
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
const host = {
  async saveLocalOperation(name: string, args: Record<string, unknown>, run: (scope: StoreHost) => Promise<unknown>, options?: FactOperationOptions) {
    const result = await runtime.executeLocalOperation(name, args, run, undefined, options);
    if (!result.success) throw new Error(result.output);
  },
  refreshViews: async () => undefined
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-learning-"));
  vault = new DiskVault(root);
  Object.assign(vault, { adapter: { getBasePath: () => root } });
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

it("previews a grounded learning plan, accepts user edits, and retains completed units on next-week adjustment", async () => {
  const folder = DEFAULT_SETTINGS.folders.tradingModels;
  const source = folder + "/虚构练习.md";
  await vault.seed(source, "用于草案的虚构公开练习。");
  await vault.seed(folder + "/隐藏/虚构资料.md", "这个内容不得发给模型。");
  store.settings.privacy!.excludedVaultPrefixes = [folder + "/隐藏"];
  const request = vi.fn<import("../src/features/learning/plans").LearningPlanRequest>(async (messages, options) => {
    await options.beforeTextRequest?.();
    expect(messages[1].content).toContain("用于草案的虚构公开练习");
    expect(messages[1].content).not.toContain("隐藏");
    return modelDraft;
  });
  const preview = await prepareLearningPlan(store, "trading", "initialize", request);
  expect(preview.draft.units).toHaveLength(8);
  expect(preview.sourcePaths).toEqual([source]);
  expect(store.getFile(learningPath(store))).toBeNull();
  await expect(saveLearningPlan(host, store, preview, preview.draft, () => { throw new Error("取消确认"); })).rejects.toThrow("取消确认");
  expect(store.getFile(learningPath(store))).toBeNull();
  await saveLearningPlan(host, store, preview, { ...preview.draft, goal: "用户修改后的虚构目标", weeklyMinutes: 100, targetDate: "2026-12-01" });
  const getTrack = async () => existingLearningTrack(store, await readLearningDocument(store), "trading");
  const track = await getTrack(), first = track.units[0];
  expect(track).toMatchObject({ goal: "用户修改后的虚构目标", weeklyMinutes: 100, targetDate: "2026-12-01", folders: [folder] });
  const complete = await runtime.executeAiToolCall({ id: "finish-learning-unit", name: "update_learning_unit",
    arguments: { trackId: "trading", unitId: first.id, status: "done" } }, "kimi", "第一个学习单元完成了");
  expect(complete.success, complete.output).toBe(true);
  const adjust = await prepareLearningPlan(store, "trading", "adjust", async messages => {
    expect(JSON.parse(messages[1].content as string).progress).toMatchObject({ completedUnits: 1, totalUnits: 8, weeklyMinutes: 100 });
    return JSON.stringify({ goal: track.goal, weeklyMinutes: 65, units: [units[1], "下周的新虚构练习"] });
  });
  await saveLearningPlan(host, store, adjust, adjust.draft);
  expect(await getTrack()).toMatchObject({ weeklyMinutes: 100, nextPlan: { from: "2026-11-16", weeklyMinutes: 65 } });
  expect((await getTrack()).units).toHaveLength(8);
  const nextWeek = await runtime.executeAiToolCall({ id: "next-learning-week", name: "learning_progress", arguments: { trackId: "trading" } }, "kimi");
  expect(JSON.parse(nextWeek.output)).toMatchObject([{ weeklyMinutes: 100, nextWeek: { from: "2026-11-16", weeklyMinutes: 65,
    remaining: [{ title: units[1] }, { title: "下周的新虚构练习" }] } }]);
  vi.setSystemTime(new Date("2026-11-16T08:00:00+08:00"));
  expect((await getTrack()).units).toMatchObject([
    { id: first.id, status: "done", doneAt: "2026-11-12" }, { id: track.units[1].id, title: units[1], status: "todo" },
    { title: "下周的新虚构练习", status: "todo" }
  ]);
  expect((await getTrack()).weeklyMinutes).toBe(65);
  expect(await vault.bytes(source)).toBe("用于草案的虚构公开练习。");
  await runtime.undoLatestOperation();
  expect((await getTrack()).units).toHaveLength(8);
});

it("blocks stale learning sources and keeps private paths out of note capture", async () => {
  const folder = DEFAULT_SETTINGS.folders.tradingModels, path = folder + "/虚构观察.md", privatePath = folder + "/私密/样本.md";
  await vault.seed(path, "虚构笔记第一版。");
  await vault.seed(privatePath, "虚构私密笔记。");
  store.settings.privacy!.excludedVaultPrefixes = [folder + "/私密"];
  const draft = await prepareLearningPlan(store, "trading", "initialize", async () => modelDraft);
  await vault.seed(path, "虚构笔记第二版。");
  await expect(saveLearningPlan(host, store, draft, draft.draft)).rejects.toThrow("资料已更新");
  expect(store.getFile(learningPath(store))).toBeNull();

  const events = new LifeOpsEventBus(), dispose = subscribeLearningNotes(host, store, events);
  const getTrack = async () => existingLearningTrack(store, await readLearningDocument(store), "trading");
  try {
    events.publish({ type: "vault.created", source: "vault", payload: { path }, occurredAt: now.toISOString() });
    events.publish({ type: "vault.modified", source: "vault", payload: { path }, occurredAt: now.toISOString() });
    events.publish({ type: "vault.created", source: "vault", payload: { path: privatePath }, occurredAt: now.toISOString() });
    await vi.waitFor(async () => expect((await getTrack()).sessions).toHaveLength(1));
    expect((await getTrack()).sessions[0]).toMatchObject({ date: "2026-11-12", notePath: path });
    expect((await getTrack()).sessions[0].minutes).toBeUndefined();
    events.publish({ type: "vault.modified", source: "vault", payload: { path }, occurredAt: "2026-11-13T09:00:00+08:00" });
    await vi.waitFor(async () => expect((await getTrack()).sessions).toHaveLength(2));
  } finally { dispose(); }
  expect((await getTrack()).sessions.map(session => session.notePath)).toEqual([path, path]);
});

it("records explicitly spoken minutes and completion of a linked learning task with no guessed duration, then undoes completion", async () => {
  const log = await runtime.executeAiToolCall({ id: "record-learning-40", name: "record_learning", arguments: { trackId: "english", minutes: 40 } },
    "kimi", "我今天学了 40 分钟英语");
  expect(log.success, log.output).toBe(true);
  const getTrack = async () => existingLearningTrack(store, await readLearningDocument(store), "english");
  expect((await getTrack()).sessions).toMatchObject([{ date: "2026-11-12", minutes: 40 }]);
  const created = await runtime.executeAiToolCall({ id: "new-learning-task", name: "create_task",
    arguments: { title: "做一组虚构听力题", learningTrackId: "english", estimateMin: 60 } }, "kimi", "建一个英语听力任务");
  expect(created.success, created.output).toBe(true);
  const [task] = (await store.readTaskDb()).tasks;
  expect(task).toMatchObject({ category: "learning", learningTrackId: "english", estimateMin: 60 });
  expect(await store.readPath(store.taskMirrorPath())).toContain("学习轨道=english");
  const completed = await runtime.executeAiToolCall({ id: "done-learning-task", name: "complete_task", arguments: { taskIdOrTitle: task.id } }, "kimi");
  expect(completed.success, completed.output).toBe(true);
  expect((await getTrack()).sessions).toMatchObject([{ minutes: 40 }, { summary: task.title }]);
  expect((await getTrack()).sessions[1].minutes).toBeUndefined();
  const progress = await runtime.executeAiToolCall({ id: "learning-progress", name: "learning_progress", arguments: { trackId: "english" } }, "kimi");
  expect(JSON.parse(progress.output)).toMatchObject([{ recordedMinutes: 40, sessionCount: 2, sessionsWithoutMinutes: 1,
    nextWeek: { from: "2026-11-16", to: "2026-11-22", remaining: [] } }]);
  await runtime.undoOperation("done-learning-task");
  expect((await getTrack()).sessions).toHaveLength(1);
  expect((await store.getTask(task.id)).status).toBe("active");
});

const quizFolder = "虚构学习/量化";
const quizNote = quizFolder + "/练习.md";
const quizQuote = "样本外数据不参与参数选择。";
const quizAnswer = "参考答案：样本外数据不参与参数选择";

async function seedQuizSources() {
  await vault.seed(quizNote, quizQuote + "\n本笔记仅含虚构学习资料。");
  await vault.seed(quizFolder + "/私密/禁止进入模型.md", "这段笔记已排除。");
  store.settings.privacy!.excludedVaultPrefixes = [quizFolder + "/私密"];
  const preview = await prepareLearningPlan(store, "quant", "initialize", async () => modelDraft);
  await saveLearningPlan(host, store, preview, { ...preview.draft, folders: [quizFolder] });
}

function quizResponse() {
  return JSON.stringify({ cards: [
    { path: quizNote, question: "无依据的题目", answer: "无依据", quote: "笔记中没有这句" },
    ...Array.from({ length: 4 }, (_, index) => ({
      path: quizNote, question: "虚构问题 " + (index + 1), answer: quizAnswer, quote: quizQuote
    }))
  ] });
}

it("generates at most three grounded cards per note, resumes due cards, and grades a spoken answer without giving away answers on start", async () => {
  await seedQuizSources();
  expect(agentToolsForRealtime().map(tool => tool.name)).toEqual(expect.arrayContaining(["start_quiz", "current_quiz", "grade_answer"]));
  const review = vi.fn<NonNullable<import("../src/toolRegistry").ToolExecutionContext["requestQuizReview"]>>(async (messages, options) => {
    await options.beforeTextRequest?.();
    const data = JSON.parse(messages[1].content as string);
    if (data.notes) {
      expect(data.notes).toMatchObject([{ path: quizNote, slots: 3 }]);
      return quizResponse();
    }
    expect(data).toMatchObject({ userAnswer: "用没参加参数选择的数据", answer: quizAnswer, quote: quizQuote });
    return JSON.stringify({ correct: true, explanation: "准确说明了样本外数据与参数选择分离。" });
  });
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined, requestQuizReview: review });
  const request = { name: "start_quiz", arguments: { trackId: "quant", count: 4 } };
  const first = await runtime.executeAiToolCall({ ...request, id: "start-quant-quiz" }, "kimi", "考我四道量化题");
  expect(first.success, first.output).toBe(true);
  expect(first.output).not.toContain(quizAnswer);
  const { cards } = JSON.parse(first.output);
  expect(cards).toHaveLength(3);
  expect(cards[0]).toMatchObject({ number: 1, question: "虚构问题 1", source: "[[" + quizNote.slice(0, -3) + "]]" });
  expect(await countDueQuizCards(store)).toBe(3);
  const second = await runtime.executeAiToolCall({ ...request, id: "reopen-quant-quiz" }, "qwen-omni", "继续量化测验");
  expect(second.success, second.output).toBe(true);
  expect(JSON.parse(second.output).cards).toEqual(cards);
  expect(review).toHaveBeenCalledTimes(1);
  const current = await runtime.executeAiToolCall({ name: "current_quiz", arguments: {}, id: "get-quiz-context" }, "qwen-omni", "我第一题的回答");
  const active = JSON.parse(current.output).cards;
  const cardId = active[0].id;
  const reply = await runtime.executeAiToolCall({ name: "grade_answer", id: "grade-quant-1",
    arguments: { cardId, userAnswer: "用没参加参数选择的数据" } }, "qwen-omni", "第一题，我答用没参加参数选择的数据");
  expect(reply.success, reply.output).toBe(true);
  expect(JSON.parse(reply.output)).toMatchObject({ result: "答对了", nextReview: "2026-11-13", intervalDays: 1 });
  expect((await readQuizDocument(store)).cards.find(card => card.id === cardId)).toMatchObject({ due: "2026-11-13", ease: 3,
    history: [{ correct: true, userAnswer: "用没参加参数选择的数据" }] });
  expect((await getTodayCard(store, await store.getTaskDashboard("2026-11-12"))).quizDueCount).toBe(2);
  await runtime.undoOperation("grade-quant-1");
  expect(await countDueQuizCards(store)).toBe(3);
  store.settings.privacy!.excludedVaultPrefixes = [quizFolder];
  expect(await countDueQuizCards(store)).toBe(0);
});

it("does not write questions if the source changes while the model is responding", async () => {
  await seedQuizSources();
  const review = vi.fn<NonNullable<import("../src/toolRegistry").ToolExecutionContext["requestQuizReview"]>>(async (_messages, options) => {
    await options.beforeTextRequest?.();
    await vault.seed(quizNote, "模型处理期间换成另一版。");
    return quizResponse();
  });
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined, requestQuizReview: review });
  const result = await runtime.executeAiToolCall({ name: "start_quiz", id: "stale-quiz", arguments: { trackId: "quant" } }, "kimi", "考我三道量化题");
  expect(result.success).toBe(false);
  expect(result.output).toContain("学习笔记或允许范围已变化");
  expect(store.getFile(quizPath(store))).toBeNull();
});

it("grows correct review intervals to thirty days and resets the interval and ease after a wrong answer", () => {
  let card: import("../src/features/learning/quizModel").QuizCard = { id: "quiz-fiction", trackId: "quant", question: "虚构题目", answer: quizAnswer,
    sourcePath: quizNote, sourceQuote: quizQuote, ease: 3, intervalDays: 0, due: "2026-11-12", history: [] };
  for (const interval of [1, 3, 7, 15, 30, 30]) {
    card = applyQuizGrade(card, { date: card.due, userAnswer: "虚构回答", correct: true, explanation: "虚构正确解释" });
    expect(card.intervalDays).toBe(interval);
  }
  card = applyQuizGrade(card, { date: "2027-03-01", userAnswer: "虚构错误", correct: false, explanation: "虚构错误解释" });
  expect(card).toMatchObject({ ease: 2, due: "2027-03-02", intervalDays: 1 });
  expect(card.history).toHaveLength(7);
});
