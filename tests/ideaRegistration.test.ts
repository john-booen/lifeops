import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App, TFile } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { FactOperationOptions } from "../src/dataFoundation/factOperation";
import type { SignalRequest } from "../src/features/journal/signalStore";
import { fileRevision } from "../src/operationIdentity";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  parseYaml: (yaml: string) => JSON.parse(yaml), stringifyYaml: (fields: unknown) => JSON.stringify(fields)
}));
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { DiskVault } = await import("./helpers/diskVault");
const { listIdeas, readIdeaProperties, splitIdeaNote, updateIdeaNote } = await import("../src/features/ideas/notes");
const { listIdeaCandidates, readIdeaDecisions, scanIdeaJournals } = await import("../src/features/ideas/candidates");
const { registerIdeaCandidates, ignoreIdeaCandidate } = await import("../src/features/ideas/service");
const { prepareIdeaAdvance, confirmIdeaAdvance } = await import("../src/features/ideas/advance");
const { findIdea, ideaIsStalled, recordIdeaReminder } = await import("../src/features/ideas/progress");
const { screenIdeaCandidates } = await import("../src/features/ideas/screening");
const { signalDocumentPath } = await import("../src/features/journal/signalStore");

const now = new Date("2026-11-12T20:00:00+08:00");
const ideasFolder = DEFAULT_SETTINGS.folders.ideas;
const oldPath = ideasFolder + "/虚构独立想法.md";
const oldBody = "\r\n# 虚构独立想法\r\n\r\n正文包括空白、尾随空格和换行。  \r\n";
const oldText = "\ufeff---\r\n" + JSON.stringify({ tags: ["虚构"], unrelated: { keep: true } }) + "\r\n---\r\n" + oldBody;
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
const nativeFrontmatter = vi.fn(async (file: TFile, update: (fields: Record<string, unknown>) => void) => {
  await vault.process(file, raw => {
    const fields = readIdeaProperties(raw);
    update(fields);
    return "---\n" + JSON.stringify(fields) + "\n---\n" + splitIdeaNote(raw).body;
  });
});
const host = {
  async saveLocalOperation(name: string, args: Record<string, unknown>, execute: (scope: StoreHost) => Promise<unknown>, options?: FactOperationOptions) {
    const result = await runtime.executeLocalOperation(name, args, execute, undefined, options);
    if (!result.success) throw new Error(result.output);
  },
  refreshViews: async () => undefined
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-ideas-"));
  vault = new DiskVault(root);
  Object.assign(vault, { adapter: { getBasePath: () => root } });
  const settings = structuredClone(DEFAULT_SETTINGS);
  const app = { vault, fileManager: { processFrontMatter: nativeFrontmatter } } as unknown as App;
  store = new LifeOpsStore(app, settings) as unknown as StoreHost;
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
  nativeFrontmatter.mockClear();
});
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

async function seedIdea(title: string, status = "exploring", sources: string[] = []) {
  const path = ideasFolder + "/" + title + ".md";
  await vault.seed(path, "---\n" + JSON.stringify({ lifeops: "idea", status, created: "2026-10-20",
    lastProgress: "2026-10-20", nextAction: "写一页边界说明", nextReview: "2026-10-28", sources })
    + "\n---\n\n# " + title + "\n\n纯虚构计划正文。\n");
  return (await listIdeas(store)).find(note => note.path === path)!;
}

const ideaPlan = (titles: string[] = ["整理两份公开样例", "写一页选择依据"], minutes = 30) =>
  JSON.stringify({ summary: "资料已收集，待核对样例。", steps: titles.map(title => ({ title, minutes })) });

it("previews concrete tasks on non-overloaded days, atomically saves the idea links, and updates progress on task completion", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const article = "虚构阅读/公开样例.md", privatePath = "虚构保密/内部.md";
  await vault.seed(article, "用于建议的虚构出处。");
  await vault.seed(privatePath, "不允许进入模型请求。");
  store.settings.privacy!.excludedVaultPrefixes = ["虚构保密"];
  const idea = await seedIdea("虚构方案", "exploring", ["[[虚构阅读/公开样例]]", "[[虚构保密/内部]]"]);
  for (const date of ["2026-11-09", "2026-11-10", "2026-11-11"]) {
    const task = await store.createTask({ title: "历史虚构 " + date, date, estimateMin: 40 });
    const completedAt = date + "T09:00:00+08:00";
    await store.updateTask(task.id, current => ({ ...current, status: "completed", completedAt, completionLog: [{ completedAt, note: "" }] }));
  }
  await store.createTask({ title: "今天已满", date: "2026-11-12", estimateMin: 45 });
  const request = vi.fn<NonNullable<import("../src/toolRegistry").ToolExecutionContext["requestIdeaPlan"]>>(async (messages, options) => {
    await options.beforeTextRequest?.();
    expect(messages[1].content).toContain("用于建议的虚构出处。");
    expect(messages[1].content).toContain("纯虚构计划正文。");
    expect(messages[1].content).not.toContain("虚构保密");
    return ideaPlan();
  });
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined, requestIdeaPlan: request });
  const listed = await runtime.executeAiToolCall({ id: "list-idea-status", name: "list_ideas", arguments: {} }, "kimi", "我的想法进展怎样");
  expect(JSON.parse(listed.output).ideas[0]).toMatchObject({ id: idea.ideaId, stalled: true, daysStalled: 23 });
  const stats = await runtime.executeAiToolCall({ id: "idea-counts", name: "get_stats", arguments: { domain: "ideas", range: "this_week" } }, "kimi");
  expect(JSON.parse(stats.output)).toMatchObject({ currentByStatus: { exploring: 1 }, stalled: 1, created: 0, progressed: 0 });
  const draft = await runtime.executeAiToolCall({ id: "advance-idea", name: "advance_idea", arguments: { id: idea.ideaId } }, "kimi", "请推进虚构方案");
  expect(draft.success, draft.output).toBe(true);
  const [action] = draft.actions;
  expect(action.content).toContain("2026-11-13 · 整理两份公开样例 · 30 分钟");
  expect(action.content).toContain("2026-11-14 · 写一页选择依据 · 30 分钟");
  expect((await store.readTaskDb()).tasks.filter(task => task.ideaId)).toEqual([]);
  const before = await vault.bytes(idea.path);
  await expect(confirmIdeaAdvance(store, runtime, { ...action, content: "伪造修改" })).rejects.toThrow("失效");
  expect(await confirmIdeaAdvance(store, runtime, action)).toContain("已创建 2 个任务");
  const tasks = (await store.readTaskDb()).tasks.filter(task => task.ideaId === idea.ideaId);
  expect(tasks).toMatchObject([{ date: "2026-11-13", category: "idea", estimateMin: 30 }, { date: "2026-11-14", category: "idea", estimateMin: 30 }]);
  expect(await store.readPath(store.taskMirrorPath())).toContain("想法ID=" + idea.ideaId);
  expect(await findIdea(store, idea.ideaId)).toMatchObject({ nextAction: tasks[0].title, nextReview: "2026-11-15", lastProgress: "2026-10-20" });
  expect(splitIdeaNote(await vault.bytes(idea.path)).body).toBe(splitIdeaNote(before).body);

  const complete = await runtime.executeAiToolCall({ id: "complete-idea-task", name: "complete_task", arguments: { taskIdOrTitle: tasks[0].id } }, "kimi");
  expect(complete.success, complete.output).toBe(true);
  expect(await findIdea(store, idea.ideaId)).toMatchObject({ lastProgress: "2026-11-12", ideaReminderDays: [] });
  await runtime.undoOperation("complete-idea-task");
  expect(await findIdea(store, idea.ideaId)).toMatchObject({ lastProgress: "2026-10-20" });
  expect((await store.getTask(tasks[0].id)).status).toBe("active");
  await runtime.undoOperation("confirmed:" + action.id);
  expect(await vault.bytes(idea.path)).toBe(before);
  expect((await store.readTaskDb()).tasks.filter(task => task.ideaId)).toEqual([]);
});

it("persists a maximum of two advances per day even when a third preview exists", async () => {
  const [first, second, third] = await Promise.all(["虚构一", "虚构二", "虚构三"].map(title => seedIdea(title)));
  const draft = async (ideaId: string, id: string) => prepareIdeaAdvance(store, ideaId, id,
    async () => ideaPlan(["写一条验证标准"]), {}, now);
  const one = await draft(first.ideaId, "one"), two = await draft(second.ideaId, "two"), three = await draft(third.ideaId, "three");
  await confirmIdeaAdvance(store, runtime, one, undefined, () => now);
  await confirmIdeaAdvance(store, runtime, two, undefined, () => now);
  await expect(confirmIdeaAdvance(store, new AgentRuntime({ store, refreshViews: async () => undefined }), three, undefined, () => now))
    .rejects.toThrow("今天已推进两个想法");
  const provider = vi.fn(async () => ideaPlan());
  await expect(prepareIdeaAdvance(store, third.ideaId, "over-limit", provider, {}, now)).rejects.toThrow("今天已推进两个想法");
  expect(provider).not.toHaveBeenCalled();
  expect((await store.readTaskDb()).tasks).toHaveLength(2);
});

it("requires a fresh idea preview when linked sources or the proposed dates change", async () => {
  const source = "虚构阅读/来源.md";
  await vault.seed(source, "第一版虚构来源");
  const stale = await seedIdea("虚构易变方案", "seed", ["[[虚构阅读/来源]]"]);
  const history = await store.createTask({ title: "已完成的虚构任务", date: "2026-11-11", estimateMin: 40 });
  const completedAt = "2026-11-11T09:00:00+08:00";
  await store.updateTask(history.id, current => ({ ...current, status: "completed", completedAt, completionLog: [{ completedAt, note: "" }] }));
  const action = await prepareIdeaAdvance(store, stale.ideaId, "stale-source", async () => ideaPlan(), {}, now);
  await vault.seed(source, "第二版虚构来源");
  await expect(confirmIdeaAdvance(store, runtime, action, undefined, () => now)).rejects.toThrow("来源笔记已修改");
  const reschedule = await prepareIdeaAdvance(store, stale.ideaId, "stale-schedule", async () => ideaPlan(), {}, now);
  await store.createTask({ title: "新加入的安排", date: "2026-11-12", estimateMin: 45 });
  await expect(confirmIdeaAdvance(store, runtime, reschedule, undefined, () => now)).rejects.toThrow("任务负荷已变化");
  expect((await store.readTaskDb()).tasks.some(task => task.ideaId)).toBe(false);
  await expect(prepareIdeaAdvance(store, stale.ideaId, "over-duration", async () => ideaPlan(["虚构"], 121), {}, now))
    .rejects.toThrow("两小时");
});

it("only escalates after three reminders without progress, and stops reminders after pause", async () => {
  const idea = await seedIdea("虚构提醒", "seed");
  const notYet = { ...idea, lastProgress: "2026-11-01", nextReview: "2026-11-20" };
  expect(ideaIsStalled(notYet, "2026-11-15")).toBe(false);
  expect(ideaIsStalled(notYet, "2026-11-16")).toBe(true);
  expect(ideaIsStalled({ ...notYet, status: "validating" }, "2026-11-09")).toBe(true);
  expect(ideaIsStalled({ ...notYet, nextReview: "2026-11-03" }, "2026-11-04")).toBe(true);
  const remind = async (date: string) => {
    let message: string | undefined;
    await host.saveLocalOperation("local_remind_idea", { date }, async scope => { message = await recordIdeaReminder(scope, idea.ideaId, date); });
    return message;
  };
  for (const day of ["2026-11-08", "2026-11-09", "2026-11-10"]) expect(await remind(day)).not.toContain("继续、暂停还是放弃");
  expect(await remind("2026-11-10")).toBeUndefined();
  expect(await remind("2026-11-11")).toContain("继续、暂停还是放弃");
  const paused = await runtime.executeAiToolCall({ id: "park-idea", name: "set_idea_status", arguments: { id: idea.ideaId, status: "parked" } },
    "kimi", "暂停虚构提醒");
  expect(paused.success, paused.output).toBe(true);
  expect(await remind("2026-11-12")).toBeUndefined();
  expect(await findIdea(store, idea.ideaId)).toMatchObject({ status: "parked", ideaReminderDays: [] });
});

it("registers an old note only on confirmation, preserving its body and unrelated metadata and supporting undo", async () => {
  await vault.seed(oldPath, oldText);
  Object.assign(vault, { readBinary: async (file: TFile) => new TextEncoder().encode(await vault.bytes(file.path)).buffer });
  const nativeTextRead = vault.read.bind(vault);
  vi.spyOn(vault, "read").mockImplementation(async file => {
    const raw = await nativeTextRead(file);
    return file.path === oldPath ? raw.replace(/^\ufeff/, "").replace(/\r\n/g, "\n") : raw;
  });
  await vault.seed(ideasFolder + "/每日记录/2026-11-12.md", "# 虚构活动记录");
  const candidates = await listIdeaCandidates(store, now);
  expect(candidates).toMatchObject([{ kind: "note", title: "虚构独立想法", path: oldPath }]);
  expect(nativeFrontmatter).not.toHaveBeenCalled();
  expect(await vault.bytes(oldPath)).toBe(oldText);
  const [registered] = await registerIdeaCandidates(host, store, [{ candidate: candidates[0] }]);
  expect(nativeFrontmatter).toHaveBeenCalledTimes(1);
  expect(nativeFrontmatter.mock.calls[0][0].path).toContain("/System/LifeOps属性暂存-");
  expect(store.getFile(nativeFrontmatter.mock.calls[0][0].path)).toBeNull();
  const updated = await vault.bytes(oldPath);
  expect(updated.startsWith("\ufeff---\r\n")).toBe(true);
  expect(splitIdeaNote(updated).body).toBe(oldBody);
  expect(readIdeaProperties(updated)).toMatchObject({ lifeops: "idea", status: "seed", tags: ["虚构"], unrelated: { keep: true } });
  expect((await listIdeas(store))[0]).toMatchObject({ ideaId: registered.ideaId, status: "seed", path: oldPath });
  expect(await listIdeaCandidates(store, now)).toEqual([]);
  await host.saveLocalOperation("local_set_idea_status", {}, scope => updateIdeaNote(scope, registered, { status: "building" }));
  expect((await listIdeas(store))[0].status).toBe("building");
  expect(splitIdeaNote(await vault.bytes(oldPath)).body).toBe(oldBody);
  await runtime.undoLatestOperation();
  expect(await vault.bytes(oldPath)).toBe(updated);
  await runtime.undoLatestOperation();
  expect(await vault.bytes(oldPath)).toBe(oldText);
  expect((await readIdeaDecisions(store)).registered).toEqual([]);
});

it("uses the last 90 days of grounded diary candidates, merging a duplicate and remembering an ignore decision", async () => {
  const date = "2026-11-08", path = DEFAULT_SETTINGS.folders.dailyRoot + "/2026/11/" + date + "早.md";
  const quote = "想做一个 AI 漫剧，先观察同类作品。", second = "另一个想法是做虚构笔记索引。";
  const raw = quote + "\n" + second + "\n";
  await vault.seed(path, raw);
  const signal = { date, period: "晨", energy: null, mood: null, stress: null, sleepHours: null, sleepQuality: null, keyEvents: [],
    plans: [], ideas: [{ text: "AI 漫剧", quote }, { text: "虚构笔记索引", quote: second }], worries: [], quotes: [], sources: [{ path, sha256: fileRevision(raw) }] };
  await vault.seed(signalDocumentPath(store, date), JSON.stringify({ version: 1, date, 晨: [signal], 晚: [] }));
  const input = { title: "AI 漫剧", description: "虚构想法核心", nextAction: "看一个同类作品" };
  const result = await runtime.executeAiToolCall({ id: "idea-chat-write", name: "upsert_idea", arguments: input }, "kimi");
  expect(result.success, result.output).toBe(true);
  const [idea] = await listIdeas(store);
  const before = splitIdeaNote(await vault.bytes(idea.path)).body;
  const candidates = await listIdeaCandidates(store, now);
  const matching = candidates.find(candidate => candidate.title === "AI 漫剧")!;
  const [merged] = await registerIdeaCandidates(host, store, [{ candidate: matching, mergeId: idea.ideaId, mergeRevision: idea.revision }]);
  expect(merged.ideaId).toBe(idea.ideaId);
  expect(merged.sources).toContain("[[" + path.slice(0, -3) + "]]");
  expect(await listIdeas(store)).toHaveLength(1);
  expect(splitIdeaNote(await vault.bytes(idea.path)).body).toBe(before);
  const [ignored] = await listIdeaCandidates(store, now);
  expect(ignored.title).toBe("虚构笔记索引");
  await ignoreIdeaCandidate(host, ignored);
  expect(await listIdeaCandidates(store, now)).toEqual([]);
  await runtime.undoLatestOperation();
  expect((await listIdeaCandidates(store, now)).map(item => item.title)).toEqual(["虚构笔记索引"]);
  expect(await vault.bytes(path)).toBe(raw);
});

it("rejects a stale batch confirmation before changing any of the selected notes", async () => {
  const second = ideasFolder + "/虚构第二条.md";
  await vault.seed(oldPath, oldText);
  await vault.seed(second, "# 第二篇虚构原文\n");
  const candidates = await listIdeaCandidates(store, now);
  expect(candidates).toHaveLength(2);
  await vault.seed(second, "# 用户已经修改第二篇\n");
  await expect(registerIdeaCandidates(host, store, candidates.map(candidate => ({ candidate })))).rejects.toThrow("来源已变化");
  expect(await vault.bytes(oldPath)).toBe(oldText);
  expect(await vault.bytes(second)).toBe("# 用户已经修改第二篇\n");
  expect(await listIdeas(store)).toEqual([]);
  expect((await readIdeaDecisions(store)).registered).toEqual([]);
});

it("scans only allowed diary notes within 90 days and reuses unchanged extracted signals", async () => {
  const recent = DEFAULT_SETTINGS.folders.dailyRoot + "/2026/11/2026-11-11晚.md";
  const old = DEFAULT_SETTINGS.folders.dailyRoot + "/2026/08/2026-08-14晚.md";
  const excluded = DEFAULT_SETTINGS.folders.dailyRoot + "/2026/11/2026-11-10晚.md";
  const quote = "虚构想法是做一个复习工具。";
  const raw = "\ufeff# 虚构晚记\r\n\r\n" + quote + "\r\n";
  await vault.seed(recent, raw);
  const nativeTextRead = vault.read.bind(vault);
  vi.spyOn(vault, "read").mockImplementation(async file => {
    const text = await nativeTextRead(file);
    return file.path === recent ? text.replace(/^\ufeff/, "").replace(/\r\n/g, "\n") : text;
  });
  await vault.seed(old, "虚构太旧的日记");
  await vault.seed(excluded, "虚构排除的日记");
  store.settings.privacy!.excludedVaultPrefixes = [excluded];
  const request = vi.fn<SignalRequest>(async (messages, options) => {
    await options.beforeTextRequest?.();
    expect(messages.at(-1)?.content).toContain(quote);
    return JSON.stringify({ date: "2026-11-11", period: "晚", ideas: [{ text: "复习工具", quote }] });
  });
  const signal = new AbortController().signal;
  expect(await scanIdeaJournals(store, request, signal, () => undefined, now)).toEqual({ examined: 1, unavailable: 0 });
  expect(await scanIdeaJournals(store, request, signal, () => undefined, now)).toEqual({ examined: 1, unavailable: 0 });
  expect(request).toHaveBeenCalledTimes(1);
  const candidates = await listIdeaCandidates(store, now);
  expect(candidates).toMatchObject([{ kind: "journal", title: "复习工具", path: recent, revision: fileRevision(raw) }]);
  expect(await listIdeas(store)).toEqual([]);
  await registerIdeaCandidates(host, store, [{ candidate: candidates[0] }]);
  expect(await listIdeas(store)).toMatchObject([{ title: "复习工具" }]);
  expect(await vault.bytes(recent)).toBe(raw);
});

it("screens cached diary excerpts in a reversible batch while retaining unclear and user-authored note candidates", async () => {
  const date = "2026-11-11", path = DEFAULT_SETTINGS.folders.dailyRoot + "/2026/11/" + date + "晚.md";
  const excerpts = ["设计一个可比较两种资料索引的工具。", "每天饭后散步二十分钟。", "晚上联系上周已约好的供应商。", "想过再调整一下方向。"];
  const raw = "# 虚构晚记\n\n仅原文有的一段。\n" + excerpts.join("\n") + "\n";
  await vault.seed(path, raw);
  await vault.seed(oldPath, oldText);
  const signal = { date, period: "晚", energy: null, mood: null, stress: null, sleepHours: null, sleepQuality: null, keyEvents: [],
    plans: [], ideas: excerpts.map(quote => ({ text: quote, quote })), worries: [], quotes: [], sources: [{ path, sha256: fileRevision(raw) }] };
  await vault.seed(signalDocumentPath(store, date), JSON.stringify({ version: 1, date, 晨: [], 晚: [signal] }));
  const candidates = await listIdeaCandidates(store, now);
  await expect(screenIdeaCandidates(host, store, candidates, async () => '{"items":[]}')).rejects.toThrow("不完整");
  expect(await listIdeaCandidates(store, now)).toHaveLength(5);
  const result = await screenIdeaCandidates(host, store, candidates, async (messages, options) => {
    await options.beforeTextRequest?.();
    expect(messages[1].content).not.toContain(path);
    expect(messages[1].content).not.toContain("仅原文有的一段");
    const sent = JSON.parse(messages[1].content as string) as { id: number; quote: string }[];
    expect(sent.map(item => item.quote)).toEqual(excerpts);
    return JSON.stringify({ items: sent.map((item, index) => ({ id: item.id, category: ["idea", "routine", "task", "unclear"][index] })) });
  });
  expect(result).toEqual({ checked: 4, hidden: 2 });
  const visible = await listIdeaCandidates(store, now);
  expect(visible).toHaveLength(3);
  expect(visible.filter(item => item.kind === "journal")).toMatchObject([{ quote: excerpts[0], screened: true }, { quote: excerpts[3], screened: true }]);
  expect(visible.find(item => item.kind === "note")).toMatchObject({ path: oldPath });
  const decisions = await readIdeaDecisions(store);
  expect(decisions.ignored).toEqual([]);
  expect(decisions.screened).toHaveLength(4);
  expect(await vault.bytes(path)).toBe(raw);
  await runtime.undoLatestOperation();
  expect(await listIdeaCandidates(store, now)).toHaveLength(5);
  expect((await readIdeaDecisions(store)).screened).toBeUndefined();
});
