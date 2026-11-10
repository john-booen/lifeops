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
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  parseYaml: (yaml: string) => JSON.parse(yaml), stringifyYaml: (fields: unknown) => JSON.stringify(fields)
}));
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { DiskVault } = await import("./helpers/diskVault");
const { listIdeas } = await import("../src/features/ideas/notes");
const { prepareIdeaAdvance } = await import("../src/features/ideas/advance");
const { prepareLearningPlan } = await import("../src/features/learning/plans");
const { subscribeReadingNotes } = await import("../src/features/reading/capture");
const { captureReadingSource, readReadingIndex, relatedReading, summarizeReadingSource } = await import("../src/features/reading/index");

const now = new Date("2026-11-12T20:00:00+08:00");
const readingFolder = "虚构阅读/文章", mappedNote = readingFolder + "/镜头一致性.md", metadataNote = "虚构资料/人物卡.md";
const mappedRaw = "# 镜头一致性\r\n\r\n用角色设定表维持镜头一致性。  \r\n";
const metadataRaw = "---\n" + JSON.stringify({ source: "虚构来源", other: [1, 2] }) + "\n---\n\n# 人物卡\n\n用人物卡定义外观。\n";
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
const host = {
  async saveLocalOperation(name: string, args: Record<string, unknown>, run: (scope: StoreHost) => Promise<unknown>, options?: FactOperationOptions) {
    const result = await runtime.executeLocalOperation(name, args, run, undefined, options);
    if (!result.success) throw new Error(result.output);
  },
  refreshViews: async () => undefined
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-reading-"));
  vault = new DiskVault(root);
  Object.assign(vault, { adapter: { getBasePath: () => root } });
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
  store.settings.readingSourceFolders = [readingFolder];
  store.settings.ai.provider = "openai-compatible";
  store.settings.ai.dataDisclosureAccepted = true;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

async function createFictionalIdea() {
  const result = await runtime.executeAiToolCall({ name: "upsert_idea", id: "new-fictional-idea",
    arguments: { title: "AI 漫剧", description: "虚构计划，先验证两种角色一致性方案。" } }, "kimi");
  expect(result.success, result.output).toBe(true);
  return (await listIdeas(store))[0];
}

it("indexes mapped and attributed notes once, preserves originals, and surfaces their articles for ideas and learning", async () => {
  const idea = await createFictionalIdea();
  await vault.seed(mappedNote, mappedRaw);
  await vault.seed(metadataNote, metadataRaw);
  await vault.seed("虚构资料/普通备忘.md", "普通备忘不能作为阅读笔记。");
  const excluded = readingFolder + "/私密/不能发送.md";
  await vault.seed(excluded, "虚构私密原文。");
  store.settings.privacy!.excludedVaultPrefixes = [readingFolder + "/私密"];
  const model = vi.fn<import("../src/features/reading/index").ReadingRequest>(async (messages, options) => {
    await options.beforeTextRequest?.();
    const prompt = JSON.parse(messages[1].content as string);
    expect(prompt.ideas).toMatchObject([{ id: idea.ideaId, title: "AI 漫剧" }]);
    expect(prompt.excerpt).not.toContain("虚构私密");
    return JSON.stringify({ summary: "这篇笔记说明用设定表维持画面风格。", keywords: ["角色", "镜头", "设定表"],
      ideaIds: [idea.ideaId, "idea-fake-id-123456"], trackIds: ["english", "invalid"] });
  });
  const events = new LifeOpsEventBus(), dispose = subscribeReadingNotes(host, store, events, model);
  const publish = (path: string) => events.publish({ type: "vault.modified", source: "vault", payload: { path } });
  try {
    for (const path of [mappedNote, mappedNote, metadataNote, excluded, "虚构资料/普通备忘.md"]) publish(path);
    await vi.waitFor(async () => expect((await readReadingIndex(store)).entries).toHaveLength(2));
    expect(model).toHaveBeenCalledTimes(2);
    expect(await vault.bytes(mappedNote)).toBe(mappedRaw);
    expect(await vault.bytes(metadataNote)).toBe(metadataRaw);
    const reply = await runtime.executeAiToolCall({ name: "search_reading", id: "read-about-manga", arguments: { query: "AI 漫剧" } },
      "kimi", "最近读的文章有哪个和 AI 漫剧有关");
    expect(reply.success, reply.output).toBe(true);
    expect(JSON.parse(reply.output).articles).toEqual(expect.arrayContaining([
      expect.objectContaining({ link: "[[" + mappedNote.slice(0, -3) + "]]", ideas: [{ id: idea.ideaId, title: idea.title, link: "[[" + idea.path.slice(0, -3) + "]]" }] }),
      expect.objectContaining({ link: "[[" + metadataNote.slice(0, -3) + "]]", tracks: [{ id: "english", name: "英语" }] })
    ]));
    await prepareIdeaAdvance(store, idea.ideaId, "advance-linked-reading", async messages => {
      expect(messages[1].content).toContain("用角色设定表维持镜头一致性");
      expect(messages[1].content).toContain("用人物卡定义外观");
      return JSON.stringify({ summary: "可先整理设定表。", steps: [{ title: "摘出三个角色设定要点", minutes: 20 }] });
    });
    const plan = await prepareLearningPlan(store, "english", "initialize", async messages => {
      expect(messages[1].content).toContain("用角色设定表维持镜头一致性");
      return JSON.stringify({ goal: "练习读写", weeklyMinutes: 90, units: Array.from({ length: 8 }, (_, index) => "练习 " + (index + 1)) });
    });
    expect(plan.sourcePaths).toContain(mappedNote);
    store.settings.readingSourceFolders = [];
    expect((await relatedReading(store, { ideaId: idea.ideaId })).map(entry => entry.path)).toEqual([metadataNote]);
  } finally { dispose(); }
});

it("ignores stale, disabled, and excluded reading data at the time it would be summarized or queried", async () => {
  await vault.seed(mappedNote, mappedRaw);
  const source = await captureReadingSource(store, mappedNote);
  expect(source).toBeDefined();
  const model = vi.fn<import("../src/features/reading/index").ReadingRequest>(async (_messages, options) => {
    await options.beforeTextRequest?.();
    await vault.seed(mappedNote, "原笔记在模型运行时更新。");
    return JSON.stringify({ summary: "旧摘要。", ideaIds: [], trackIds: [], keywords: ["甲", "乙", "丙"] });
  });
  await expect(summarizeReadingSource(store, source!, model)).rejects.toThrow("原文或允许范围已变化");
  expect((await readReadingIndex(store)).entries).toEqual([]);
  const events = new LifeOpsEventBus(), dispose = subscribeReadingNotes(host, store, events, model);
  try {
    store.settings.ai.dataDisclosureAccepted = false;
    events.publish({ type: "vault.modified", source: "vault", payload: { path: mappedNote } });
    store.settings.ai.dataDisclosureAccepted = true;
    store.settings.privacy!.excludedVaultPrefixes = [readingFolder];
    events.publish({ type: "vault.modified", source: "vault", payload: { path: mappedNote } });
    expect(await captureReadingSource(store, mappedNote)).toBeUndefined();
    expect(await relatedReading(store)).toEqual([]);
    expect(model).toHaveBeenCalledTimes(1);
  } finally { dispose(); }
});
