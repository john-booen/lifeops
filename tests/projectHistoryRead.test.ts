import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import { projectDocumentPath } from "../src/dataFoundation/projectPersistence";
import { captureContextSources, contextSourceHash, preparedContextSourcePaths } from "./helpers/sourceReferences";
import { readStoredQueryWithSources } from "../src/storedQueryRead";
import { createPersonalMemory, reviewPersonalMemoryRecord } from "../src/personalMemory";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { AgentRuntime } = await import("../src/agentRuntime");
const { runConfirmedToolAction } = await import("../src/toolRegistry");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>, projectId: string, serial = 0;
const original = "纯虚构第一份报告正文，不等同于产出摘要。";
const longText = "纯虚构早期产出：" + "甲".repeat(1450) + "较早记录尾部证据";
let artifactPath: string;
const context = () => ({ store, refreshViews: async () => {} });
async function confirm(command: unknown) {
  const result = await runtime.executeAiToolCall({ id: `history-save-${++serial}`, name: "propose_project_change", arguments: { command } }, "kimi");
  expect(result.success, result.output).toBe(true);
  expect(await runConfirmedToolAction(result.actions[0], context())).toBe(true);
}
const query = (args: Record<string, unknown>) => runtime.executeAiToolCall({ id: `history-read-${++serial}`, name: "query_projects", arguments: args }, "kimi");
const reopen = () => { store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; runtime = new AgentRuntime(context()); };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-project-history-")); vault = new DiskVault(root); reopen();
  artifactPath = store.path(store.settings.folders.outputs, "纯虚构早期报告.md");
  await confirm({ kind: "save_goal", input: { title: "纯虚构持续研究目标", reason: "核对前后证据" } });
  const goalId = (await store.getProjectSnapshot()).document.goals[0].id;
  await confirm({ kind: "save_project", input: { title: "纯虚构长期研究", goalId } });
  projectId = (await store.getProjectSnapshot()).document.projects[0].id;
  await vault.seed(artifactPath, original);
  for (let index = 0; index < 8; index++) await confirm({ kind: "add_entry", projectId, entryKind: index === 0 ? "review" : "output", text: index === 0 ? longText : `纯虚构近期产出${index}`, path: index === 0 ? artifactPath : "", nextStep: index === 0 ? "纯虚构长回顾下一步" + "乙".repeat(1350) + "下一步尾部依据" : "" });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
describe("project history through guarded reads of real synthetic files", () => {
  it("states the default five-record coverage and does not claim to provide artifact bodies", async () => {
    const text = await store.buildProjectContext();
    expect(text).toContain("共8条"); expect(text).toContain("较早3条未提供");
    expect(text).toContain("产出来源正文未提供");
    expect(text).not.toContain(longText); expect(text).not.toContain(original);
  });
  it("reads older records of one exact project and retains current source audit after reopening", async () => {
    const first = await query({ projectId, entryLimit: 5 }); expect(first.success, first.output).toBe(true);
    const revision = (await store.getProjectSnapshot()).revision;
    expect(first.output).toContain(`历史版本：${revision}`); expect(first.output).not.toContain("纯虚构早期产出");
    const before = await vault.bytes(projectDocumentPath(store)); reopen();
    const read = await readStoredQueryWithSources(store, "query_projects", { projectId, entryOffset: 5, entryLimit: 5, historyRevision: revision });
    try {
      expect(read.text).toContain("纯虚构早期产出"); expect(read.text).toContain("纯虚构近期产出1"); expect(read.text).not.toContain("纯虚构近期产出7");
      expect(read.text).toContain("较早0条未提供");
      expect(preparedContextSourcePaths([read.sources], read.text)).toContain(artifactPath);
      expect(read.text).not.toContain(original); await read.assertSourcesCurrent(); read.assertCurrent();
    } finally { read.dispose(); }
    expect(await vault.bytes(projectDocumentPath(store))).toBe(before); expect(await vault.bytes(artifactPath)).toBe(original);
  });
  it.each(["text", "nextStep"] as const)("reads a saved %s field beyond its first thousand characters without treating confirmation as an event date", async entryField => {
    const snapshot = await store.getProjectSnapshot(), entry = snapshot.document.projects[0].entries[0];
    const first = await query({ projectId, entryId: entry.id, entryField, maxChars: 1000 }); expect(first.success, first.output).toBe(true);
    expect(first.output).toContain("确认／最近更正时间"); expect(first.output).toContain("不等于事件发生日");
    expect(first.output).not.toContain(entryField === "text" ? "较早记录尾部证据" : "下一步尾部依据");
    const next = await query({ projectId, entryId: entry.id, entryField, textOffset: 1000, maxChars: 1000, historyRevision: snapshot.revision });
    expect(next.success, next.output).toBe(true); expect(next.output).toContain(entryField === "text" ? "较早记录尾部证据" : "下一步尾部依据");
    expect(next.output).toContain("本字段已读到末尾"); expect(next.output).not.toContain(original);
    const read = await readStoredQueryWithSources(store, "query_projects", { projectId, entryId: entry.id, entryField, textOffset: 1000, maxChars: 1000, historyRevision: snapshot.revision });
    try {
      const tail = entry[entryField].slice(1000), block = read.sources.blocks.find(block => block.path === projectDocumentPath(store) && block.fragment.includes(tail));
      expect(block).toBeDefined(); expect(block!.sourceHash).toBe(contextSourceHash(await vault.bytes(projectDocumentPath(store))));
      expect(preparedContextSourcePaths([read.sources], read.text)).toContain(projectDocumentPath(store));
    } finally { read.dispose(); }
  });
  it.each(["new-record", "correction"])("rejects cross-page revisions after %s without replacing an old project", async mutation => {
    const snapshot = await store.getProjectSnapshot();
    const entryId = snapshot.document.projects[0].entries[0].id;
    if (mutation === "new-record") await confirm({ kind: "add_entry", projectId, entryKind: "output", text: "纯虚构后来追加", path: "", nextStep: "" });
    else await confirm({ kind: "correct_entry", projectId, entryId, text: "纯虚构只更正旧记录，位置不变", path: artifactPath, nextStep: "纯虚构更正下一步" });
    const after = await vault.bytes(projectDocumentPath(store));
    const result = await query({ projectId, entryOffset: 5, historyRevision: snapshot.revision });
    expect(result.success).toBe(false); expect(result.output).not.toContain("纯虚构早期产出");
    expect((await query({ projectId, entryId, textOffset: 1000, maxChars: 1000, historyRevision: snapshot.revision })).success).toBe(false);
    expect(await vault.bytes(projectDocumentPath(store))).toBe(after);
  });
  it.each([{ projectId: "missing-project" }, { projectId: "" }, { projectId: "project-prefix" }, { projectId: "placeholder", entryId: "missing-entry" }])("does not guess a project or record: %j", async args => {
    const before = await vault.bytes(projectDocumentPath(store));
    const result = await query({ ...args, projectId: args.projectId === "placeholder" ? projectId : args.projectId });
    expect(result.success).toBe(false); expect(result.output).not.toContain("纯虚构近期产出"); expect(await vault.bytes(projectDocumentPath(store))).toBe(before);
  });
  it.each([
    { entryOffset: 1 }, { entryOffset: -1 }, { entryOffset: 0.5 }, { entryLimit: 0 }, { entryLimit: 11 },
    { textOffset: 3 }, { maxChars: 0 }, { entryField: "unknown" }, { historyRevision: "invented" }, { entryOffset: 5, query: "另一个项目" }
  ])("rejects invalid or ambiguous pagination parameters: %j", async options => {
    const result = await query({ projectId, ...options }); expect(result.success).toBe(false); expect(result.output).not.toContain("纯虚构早期产出");
  });
  it.each(["excluded-artifact", "excluded-history-source", "excluded-goal-source"])("does not expose private historical text through %s", async state => {
    if (state === "excluded-goal-source") {
      const goalPath = store.path(store.settings.folders.goals, "纯虚构目标原文.md"); await vault.seed(goalPath, "纯虚构目标原文");
      const goal = (await store.getProjectSnapshot()).document.goals[0]; await confirm({ kind: "save_goal", id: goal.id, input: { sourcePath: goalPath } });
      store.settings.privacy!.excludedVaultPrefixes = [goalPath];
    } else store.settings.privacy!.excludedVaultPrefixes = [state === "excluded-artifact" ? artifactPath : projectDocumentPath(store)];
    const snapshot = await store.getProjectSnapshot(), result = await query({ projectId, entryId: snapshot.document.projects[0].entries[0].id });
    expect(result.output).not.toContain("纯虚构早期产出"); expect(result.output).not.toContain(artifactPath); expect(result.output).not.toContain("较早记录尾部证据");
  });
  it("retains source changes until final publication and grants copied snapshots no source authority", async () => {
    const snapshot = await store.getProjectSnapshot(), args = { projectId, entryId: snapshot.document.projects[0].entries[0].id };
    const read = await readStoredQueryWithSources(store, "query_projects", args);
    try { await vault.seed(artifactPath, "纯虚构来源改变"); await expect(read.assertSourcesCurrent()).rejects.toThrow(); } finally { read.dispose(); }
    const current = await store.getProjectSnapshot(); vi.spyOn(store, "getProjectSnapshot").mockResolvedValue(structuredClone(current));
    const copied = await captureContextSources(record => store.buildProjectContext("", 6, record, args));
    expect(copied.text).toContain("纯虚构早期产出"); expect(copied.blocks).toEqual([]);
  });
  it("uses original array positions across hidden records and does not read excluded artifact bodies", async () => {
    const snapshot = await store.getProjectSnapshot();
    store.settings.privacy!.excludedVaultPrefixes = [artifactPath];
    const readPath = vi.spyOn(store, "readPath");
    const result = await query({ projectId, entryOffset: 5, entryLimit: 5, historyRevision: snapshot.revision });
    expect(result.success, result.output).toBe(true);
    expect(result.output).toContain("原文已排除"); expect(result.output).toContain("纯虚构近期产出1"); expect(result.output).toContain("纯虚构近期产出2");
    expect(result.output).not.toContain("纯虚构近期产出3");
    expect(readPath.mock.calls.some(([path]) => path === artifactPath)).toBe(false);
  });
  it("does not expose a corrected entry whose old source has been excluded", async () => {
    const entry = (await store.getProjectSnapshot()).document.projects[0].entries[0];
    await confirm({ kind: "correct_entry", projectId, entryId: entry.id, text: "纯虚构更正后的当前记录", path: "", nextStep: "纯虚构更正下一步" });
    store.settings.privacy!.excludedVaultPrefixes = [artifactPath];
    const result = await query({ projectId, entryId: entry.id });
    expect(result.output).not.toContain("纯虚构更正后的当前记录"); expect(result.output).not.toContain("纯虚构更正下一步"); expect(result.output).not.toContain(artifactPath);
  });
  it.each(["correct", "forget"] as const)("filters an entire saved field before slicing a %s phrase across the page boundary", async decision => {
    const phrase = "纯虚构我喜欢简短回复", text = "丙".repeat(995) + phrase + "丁".repeat(600);
    await confirm({ kind: "add_entry", projectId, entryKind: "output", text, path: "", nextStep: "" });
    const initial = createPersonalMemory({ kind: "core_profile", content: phrase, sourceRefs: [{ sourceId: "fiction-source", path: artifactPath, capturedAt: "2026-10-01T00:00:00Z" }] });
    let records = reviewPersonalMemoryRecord([initial], initial.id, { decision: "confirm" });
    records = reviewPersonalMemoryRecord(records, initial.id, decision === "forget" ? { decision } : { decision, content: "纯虚构研究时喜欢详细回复" });
    const document = await store.readPersonalMemories(); await store.writePersonalMemories({ ...document, records });
    const snapshot = await store.getProjectSnapshot(), entry = snapshot.document.projects[0].entries.at(-1)!;
    for (const textOffset of [0, 1000]) {
      const result = await query({ projectId, entryId: entry.id, textOffset, maxChars: 1000, historyRevision: snapshot.revision });
      expect(result.success, result.output).toBe(true); expect(result.output).not.toContain("纯虚构我喜欢"); expect(result.output).not.toContain("简短回复"); expect(result.output).toContain("该字段本轮未提供");
    }
  });
  it("does not split an emoji or silently accept a position beyond a saved field", async () => {
    const text = "戊".repeat(999) + "🙂" + "纯虚构字符尾段";
    await confirm({ kind: "add_entry", projectId, entryKind: "output", text, path: "", nextStep: "" });
    const snapshot = await store.getProjectSnapshot(), entry = snapshot.document.projects[0].entries.at(-1)!;
    const first = await query({ projectId, entryId: entry.id, maxChars: 1000 });
    expect(first.success, first.output).toBe(true); expect(first.output).toContain(`文本页：0-999/${text.length}`);
    const next = await query({ projectId, entryId: entry.id, textOffset: 999, maxChars: 1000, historyRevision: snapshot.revision });
    expect(next.success, next.output).toBe(true); expect(next.output).toContain("🙂纯虚构字符尾段");
    for (const textOffset of [1000, text.length + 1]) expect((await query({ projectId, entryId: entry.id, textOffset, historyRevision: snapshot.revision })).success).toBe(false);
  });
});
