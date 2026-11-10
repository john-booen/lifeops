import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import { createPersonalMemory, personalMemoriesToMarkdown, reviewPersonalMemoryRecord, type PersonalMemoryKind } from "../src/personalMemory";
import { confirmedMemoryContextSourcePaths, formatConfirmedPersonalMemoryContext } from "../src/personalMemoryContext";
import { readPersonalMemoryWithSources } from "../src/personalMemorySources";

vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(),
  requestUrl: () => { throw Error("Network forbidden"); }
}));
const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { runConfirmedToolAction } = await import("../src/toolRegistry");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, app: App, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
let serial = 0;
const content = "纯虚构今天偏头痛，暂停跑步。";
const context = () => ({ store, refreshViews: async () => {}, assertCurrent: () => {} });

beforeEach(async () => {
  vi.stubGlobal("window", globalThis);
  root = await mkdtemp(join(tmpdir(), "lifeops-memory-time-"));
  vault = new DiskVault(root);
  app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
  runtime = new AgentRuntime(context());
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

async function confirmFromOriginal(path: string, kind: PersonalMemoryKind = "current_state", text = content) {
  const raw = `# 纯虚构原文\n\n${text}\n`;
  await vault.seed(path, raw);
  const read = await runtime.executeAiToolCall({ id: `time-read-${++serial}`, name: "inspect_note_understanding_source", arguments: { path } }, "kimi");
  expect(read.success, read.output).toBe(true);
  const proposal = await runtime.executeAiToolCall({ id: `time-propose-${++serial}`, name: "propose_note_understanding", arguments: {
    path, sourceToken: JSON.parse(read.output).sourceToken, candidates: [{ kind, content: text, excerpt: text }]
  } }, "kimi");
  expect(proposal.success, proposal.output).toBe(true);
  await runConfirmedToolAction(proposal.actions[0], context());
  const candidate = (await store.readPersonalMemories()).records.find(record => record.content === text)!;
  expect(candidate.status).toBe("candidate");
  expect(await store.buildPersonalMemoryContext()).not.toContain(text);
  const review = await runtime.executeAiToolCall({ id: `time-confirm-${++serial}`, name: "review_personal_memory", arguments: { memoryId: candidate.id, decision: "confirm" } }, "kimi");
  expect(review.success, review.output).toBe(true);
  await runConfirmedToolAction(review.actions[0], context());
  return { record: (await store.readPersonalMemories()).records.find(record => record.id === candidate.id)!, raw };
}

function mainFixture() {
  const reply = vi.fn(async (_context: string) => ({ content: "纯虚构固定回复；未验证模型理解。", toolCalls: [] }));
  return Object.assign(Object.create(LifeOpsPlugin.prototype), {
    app, store, settings: store.settings, updateStatusBar: vi.fn(async () => {}),
    lifeOpsEvents: { publish: vi.fn() }, buildSemanticContext: vi.fn(async () => ""),
    ai: { agentReply: reply, agentReplyStream: reply, delegatedReplyStream: reply, agentReplyAfterToolResultsStream: reply },
    executeToolCalls: vi.fn(async () => ({ replies: [], actions: [], results: [] }))
  });
}

describe("confirmed memory temporal meaning in production context", () => {

  it("does not replace an undated original or unknown event date with the capture date", async () => {
    const path = "Notes/undated.md";
    const { record, raw } = await confirmFromOriginal(path);
    expect(record.sourceRefs[0].observedDate).toBeUndefined();
    const projected = await store.buildPersonalMemoryContext();
    expect(projected).toContain(`原记录日期: ${path}：未注明`);
    expect(projected).toContain("事件日期: 未核对");
    expect(projected).toContain(`${record.sourceRefs[0].capturedAt}（来源采集／登记时间）`);
    expect(await vault.bytes(path)).toBe(raw);
  });

  it("does not equate an episode's document date with a claimed event date", async () => {
    const path = "Notes/2026-09-29晚.md";
    const { record } = await confirmFromOriginal(path, "episode", "纯虚构昨天完成第一次徒步。");
    const projected = await store.buildPersonalMemoryContext();
    expect(projected).toContain("### 已确认事件记录");
    expect(projected).toContain(`原记录日期: ${path}：2026-09-29`);
    expect(projected).toContain("事件日期: 未核对");
    expect(projected).toContain("原记录日期不等于事件发生日");
    expect(projected).toContain(`确认时间: ${record.confirmedAt}`);
  });

  it("keeps dates bound to each source and does not infer a legacy source date from its filename", () => {
    const readAt = "2026-10-08T00:00:00Z";
    const initial = createPersonalMemory({ kind: "current_state", content, sourceRefs: [
      { sourceId: "one", path: "Notes/2026-09-28晚.md", capturedAt: readAt, observedDate: "2026-09-28" },
      { sourceId: "two", path: "Notes/2026-09-30早.md", capturedAt: readAt, observedDate: "2026-09-30" },
      { sourceId: "legacy", path: "Notes/2026-09-25晚.md", capturedAt: readAt }
    ] }, readAt);
    const records = reviewPersonalMemoryRecord([initial], initial.id, { decision: "confirm" }, readAt);
    const before = JSON.stringify(records), projected = personalMemoriesToMarkdown(records);
    expect(projected).toContain("Notes/2026-09-28晚.md：2026-09-28");
    expect(projected).toContain("Notes/2026-09-30早.md：2026-09-30");
    expect(projected).toContain("Notes/2026-09-25晚.md：未注明");
    expect(formatConfirmedPersonalMemoryContext(records)).not.toContain("Notes/2026-09-25晚.md");
    expect(JSON.stringify(records)).toBe(before);
  });

  it("preserves explicit expiry and excludes expired records without manufacturing expiry for old states", async () => {
    const { record } = await confirmFromOriginal("Notes/2026-09-30晚.md");
    const future = { ...record, expiresAt: "2999-10-01T00:00:00Z" };
    const before = JSON.stringify(future);
    expect(personalMemoriesToMarkdown([future])).toContain("记忆使用截至 2999-10-01T00:00:00Z");
    expect(JSON.stringify(future)).toBe(before);
    expect(personalMemoriesToMarkdown([{ ...record, expiresAt: "2000-10-01T00:00:00Z" }])).toBe("");
    expect(personalMemoriesToMarkdown([record])).toContain(content);
    expect(record.expiresAt).toBeUndefined();
  });

  it.each(["纯虚构当时只是短暂不适。", "纯虚构今天已经恢复跑步。"])("retains full-block audit and protected correction/forgetting after reopening: %s", async correctedContent => {
    const path = "Notes/2026-09-30晚.md", { record, raw } = await confirmFromOriginal(path);
    const assessed = (await readPersonalMemoryWithSources(store)).records;
    const projected = formatConfirmedPersonalMemoryContext(assessed);
    expect(confirmedMemoryContextSourcePaths(assessed, "", projected)).toEqual([
      path, store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json")
    ]);
    expect(confirmedMemoryContextSourcePaths(assessed, "", projected.split("  - sources:")[0])).toEqual([]);
    await vault.seed(path, raw + "\n纯虚构原文后来修改。\n");
    expect(await store.buildPersonalMemoryContext()).not.toContain(content);
    await vault.seed(path, raw);
    const correct = await runtime.executeAiToolCall({ id: `time-correct-${++serial}`, name: "review_personal_memory", arguments: { memoryId: record.id, decision: "correct", correctedContent } }, "kimi");
    expect(correct.success, correct.output).toBe(true);
    await runConfirmedToolAction(correct.actions[0], context());
    store = new LifeOpsStore(app, structuredClone(store.settings)) as unknown as StoreHost;
    const corrected = await store.buildPersonalMemoryContext();
    expect(corrected).toContain(correctedContent);
    expect(corrected).not.toContain(content);
    const reloaded = (await store.readPersonalMemories()).records;
    expect(formatConfirmedPersonalMemoryContext(reloaded)).toContain("后来纠正不能只凭来源记录日期确定事件日");
    expect(formatConfirmedPersonalMemoryContext(reloaded)).not.toContain("应以原文叙述时点理解");
    expect(reloaded[0].sourceRefs.find(source => source.path === path)!.observedDate).toBe("2026-09-30");
    runtime = new AgentRuntime(context());
    const forget = await runtime.executeAiToolCall({ id: `time-forget-${++serial}`, name: "review_personal_memory", arguments: { memoryId: record.id, decision: "forget" } }, "kimi");
    expect(forget.success, forget.output).toBe(true);
    await runConfirmedToolAction(forget.actions[0], context());
    store = new LifeOpsStore(app, structuredClone(store.settings)) as unknown as StoreHost;
    expect(await store.buildPersonalMemoryContext()).not.toContain(correctedContent);
    expect(await vault.bytes(path)).toBe(raw);
  });
});
