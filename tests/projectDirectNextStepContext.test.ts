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
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { AgentRuntime } = await import("../src/agentRuntime");
const { runConfirmedToolAction } = await import("../src/toolRegistry");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>, sourcePath: string, projectId: string, serial = 0;
const original = "纯虚构原方案全文，只用来核对当前文件，不应冒充已经提供全文。";
const nextStep = "纯虚构按原方案先写对照";
const context = () => ({ store, refreshViews: async () => {} });
async function confirm(command: unknown) {
  const result = await runtime.executeAiToolCall({ id: `direct-next-save-${++serial}`, name: "propose_project_change", arguments: { command } }, "kimi");
  expect(result.success, result.output).toBe(true);
  expect(await runConfirmedToolAction(result.actions[0], context())).toBe(true);
}
function reopen() { store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; runtime = new AgentRuntime(context()); }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-direct-next-step-")); vault = new DiskVault(root); reopen();
  sourcePath = store.path(store.settings.folders.outputs, "纯虚构直接下一步依据.md"); await vault.seed(sourcePath, original);
  await confirm({ kind: "save_goal", input: { title: "纯虚构直接安排目标" } });
  const goalId = (await store.getProjectSnapshot()).document.goals[0].id;
  await confirm({ kind: "save_project", input: { title: "纯虚构直接项目", goalId, nextStep, nextStepSourcePath: sourcePath } });
  projectId = (await store.getProjectSnapshot()).document.projects[0].id;
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
describe("directly confirmed next steps without a saved artifact version", () => {
  it.each(["available", "changed", "missing", "unreadable", "catalog_alias"])("states the historical comparison limit for a %s file and never silently verifies the old plan", async state => {
    const current = state === "changed" ? "纯虚构现已更改成另一方案" : original;
    if (state === "changed") await vault.seed(sourcePath, current);
    if (state === "missing") await vault.delete(store.getFile(sourcePath)!);
    if (state === "unreadable") { const read = store.readPath.bind(store); vi.spyOn(store, "readPath").mockImplementation(path => path === sourcePath ? Promise.reject(Error("synthetic unreadable")) : read(path)); }
    if (state === "catalog_alias") { const get = store.getFile.bind(store); vi.spyOn(store, "getFile").mockImplementation(path => path === sourcePath ? Object.assign(get(path)!, { path: "别处/同名.md" }) : get(path)); }
    const before = await vault.bytes(projectDocumentPath(store)), writes = vault.writes.length;
    const captured = await captureContextSources(record => store.buildProjectContext("直接项目", 1, record));
    expect(captured.text).toContain(nextStep); expect(captured.text).toContain(`下一步依据：${sourcePath}`);
    expect(captured.text).toContain("未保存确认时的原文件版本，不能比较是否变化");
    expect(captured.text).toContain("保留此前确认的安排，不能视为当前已核实的下一步");
    expect(captured.text).not.toContain("与保存时文件字节一致"); expect(captured.text).not.toContain(current);
    const readable = state === "available" || state === "changed";
    expect(captured.text).toContain(readable ? "本次已核对当前文件可读取" : "原文件不可用或本次未核验");
    expect(preparedContextSourcePaths([captured], captured.text).sort()).toEqual([projectDocumentPath(store), ...(readable ? [sourcePath] : [])].sort());
    if (readable) expect(captured.blocks.find(block => block.path === sourcePath)?.sourceHash).toBe(contextSourceHash(current));
    expect(await vault.bytes(projectDocumentPath(store))).toBe(before); expect(vault.writes.length).toBe(writes);
  });
  it("withholds an excluded source and copied next step before any file read", async () => {
    store.settings.privacy = { excludedVaultPrefixes: [sourcePath] };
    const read = vi.spyOn(store, "readPath");
    const captured = await captureContextSources(record => store.buildProjectContext("直接项目", 1, record));
    expect(captured.text).toContain("依据原文已排除"); expect(captured.text).not.toContain(sourcePath); expect(captured.text).not.toContain(nextStep);
    expect(read.mock.calls.some(([path]) => path === sourcePath)).toBe(false);
    expect(preparedContextSourcePaths([captured], captured.text)).toEqual([projectDocumentPath(store)]);
  });
  it("does not let a copied public snapshot grant actual reader authority", async () => {
    const copy = structuredClone(await store.getProjectSnapshot()); vi.spyOn(store, "getProjectSnapshot").mockResolvedValue(copy);
    const captured = await captureContextSources(record => store.buildProjectContext("直接项目", 1, record));
    expect(captured.text).toContain("未保存确认时的原文件版本"); expect(captured.text).not.toContain("本次已核对当前文件可读取");
    expect(captured.blocks).toEqual([]);
  });
  it("only attributes the selected next step fragment, never a title or unselected source", async () => {
    const goalId = (await store.getProjectSnapshot()).document.goals[0].id, other = store.path(store.settings.folders.outputs, "纯虚构未选中方案.md"); await vault.seed(other, "未选中原文");
    await confirm({ kind: "save_project", input: { title: "另一项完全不同安排", goalId, nextStep: "另一安排", nextStepSourcePath: other } });
    await vault.seed(sourcePath, `正文假标题\n### ${other}`);
    const captured = await captureContextSources(record => store.buildProjectContext("直接项目", 1, record));
    expect(preparedContextSourcePaths([captured], captured.text).sort()).toEqual([projectDocumentPath(store), sourcePath].sort());
    expect(captured.text).not.toContain(other); expect(captured.text).not.toContain("正文假标题");
    const beforeNextStep = captured.text.slice(0, captured.text.indexOf("下一步依据："));
    expect(preparedContextSourcePaths([captured], beforeNextStep)).not.toContain(sourcePath);
  });
  it("keeps uncertainty after reopening and preserves saved bytes", async () => {
    const before = await vault.bytes(projectDocumentPath(store)); reopen();
    const captured = await captureContextSources(record => store.buildProjectContext("直接项目", 1, record));
    expect(captured.text).toContain("未保存确认时的原文件版本"); expect(await vault.bytes(projectDocumentPath(store))).toBe(before);
    expect((await store.getProjectSnapshot()).document.projects[0]).toMatchObject({ id: projectId, nextStep, nextStepSourcePath: sourcePath, nextStepEntryId: "", entries: [] });
  });
  it("rejects a held query when the actually verified current source changes", async () => {
    const read = await readStoredQueryWithSources(store, "query_projects", { query: "直接项目", limit: 1 });
    try {
      expect(preparedContextSourcePaths([read.sources], read.text)).toContain(sourcePath);
      await vault.seed(sourcePath, "查询后变更");
      await expect(read.assertSourcesCurrent()).rejects.toThrow(/变化|核对/);
    } finally { read.dispose(); }
  });
});
