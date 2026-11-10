import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import { tradingDocumentPath } from "../src/dataFoundation/tradingPersistence";
import { runFactOperation } from "../src/dataFoundation/factOperation";
import type { TradingCommand } from "../src/tradingResearch";

vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { AgentRuntime } = await import("../src/agentRuntime");
const { runConfirmedToolAction } = await import("../src/toolRegistry");
const { normalizeTradingCommand, buildTradingResearchContext } = await import("../src/tradingTools");

let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: InstanceType<typeof AgentRuntime>;
let modelId: string, versionId: string, caseId: string, serial = 0;
const context = () => ({ store, refreshViews: async () => {} });
const propose = (command: unknown) => runtime.executeAiToolCall({ id: `trading-identity-${++serial}`, name: "propose_trading_research_change", arguments: { command } }, "kimi", "请先给我核对纯虚构研究记录");
function reopen() { store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; runtime = new AgentRuntime(context()); }
async function confirm(command: unknown) {
  const result = await propose(command); expect(result.success, result.output).toBe(true); expect(result.actions).toHaveLength(1);
  expect(await runConfirmedToolAction(result.actions[0], context())).toBe(true); return result.actions[0];
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-trading-identity-")); vault = new DiskVault(root); reopen();
  await confirm({ kind: "save_model", input: { title: "纯虚构原模型", entry: "保留原条件", exit: "保留原退出" } });
  const first = (await store.getTradingSnapshot()).document.models[0].versions[0]; modelId = first.modelId; versionId = first.id;
  await confirm({ kind: "save_case", input: { versionId, date: "2026-10-04", execution: "保留原执行", result: "保留原结果" } });
  caseId = (await store.getTradingSnapshot()).document.cases[0].id;
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function assertRefused(command: unknown) {
  const path = tradingDocumentPath(store), raw = await vault.bytes(path), writes = vault.writes.length;
  const result = await propose(command); expect(result.success, result.output).toBe(false); expect(result.actions).toEqual([]);
  expect(await vault.bytes(path)).toBe(raw); expect(vault.writes.length).toBe(writes); return result;
}
const invalidIds: unknown[] = ["", " ", "\t\n", null, 0, false, {}, []];

describe("trading mutations bind raw exact model, case and version IDs", () => {
  it.each(invalidIds)("does not turn invalid optional target %j into creation", async id => {
    await assertRefused({ kind: "save_model", modelId: id, input: { title: "不应另建模型" } });
    await assertRefused({ kind: "save_case", caseId: id, input: { versionId, date: "2026-10-04", result: "不应另建案例" } });
  });
  it.each(["model", "case", "version"] as const)("does not trim a padded %s ID into an existing record", async field => {
    for (const pad of [(id: string) => ` ${id}`, (id: string) => `${id} `, (id: string) => `\t${id}\n`]) {
      const command = field === "model" ? { kind: "save_model", modelId: pad(modelId), input: { entry: "不能改原条件" } }
        : field === "case" ? { kind: "save_case", caseId: pad(caseId), input: { review: "不能改原案例" } }
        : { kind: "save_case", input: { versionId: pad(versionId), date: "2026-10-04", result: "不能归到变形版本" } };
      await assertRefused(command);
    }
  });
  it.each(invalidIds)("rejects an explicit invalid version %j instead of inheriting the old version", async id => {
    await assertRefused({ kind: "save_case", caseId, input: { versionId: id, review: "不能忽略错误版本" } });
  });
  it.each(["model", "case", "version"] as const)("refuses a missing %s ID without echoing it or creating a replacement", async field => {
    const missing = `unknown-private-${field}-identity`;
    const command = field === "model" ? { kind: "save_model", modelId: missing, input: { title: "不另建" } }
      : field === "case" ? { kind: "save_case", caseId: missing, input: { versionId, date: "2026-10-04", result: "不另建" } }
      : { kind: "save_case", input: { versionId: missing, date: "2026-10-04", result: "不换版本" } };
    expect((await assertRefused(command)).output).not.toContain(missing);
  });
  it("keeps omitted and native undefined optional IDs as explicit new model and case creation", async () => {
    for (const includeUndefined of [false, true]) {
      await confirm({ kind: "save_model", ...(includeUndefined ? { modelId: undefined } : {}), input: { title: `纯虚构新模型${includeUndefined}` } });
      await confirm({ kind: "save_case", ...(includeUndefined ? { caseId: undefined } : {}), input: { versionId, date: "2026-10-04", result: `纯虚构新案例${includeUndefined}` } });
    }
    reopen(); const document = (await store.getTradingSnapshot()).document;
    expect(document.models).toHaveLength(3); expect(document.cases).toHaveLength(3); expect(document.models[0].versions).toHaveLength(1);
    expect(new Set(document.cases.map(entry => entry.id)).size).toBe(3); expect(document.cases.every(entry => entry.versionId === versionId)).toBe(true);
  });
  it("requires a specific saved version for new cases even if versionId is omitted or undefined", async () => {
    await assertRefused({ kind: "save_case", input: { date: "2026-10-04", result: "没有版本" } });
    await assertRefused({ kind: "save_case", input: { versionId: undefined, date: "2026-10-04", result: "没有版本" } });
  });
  it("preserves exact append, old-case version inheritance, reopened facts and undo", async () => {
    const initialRaw = await vault.bytes(tradingDocumentPath(store));
    const initial = structuredClone((await store.getTradingSnapshot()).document);
    const ruleAction = await confirm({ kind: "save_model", modelId, input: { entry: "新条件", exit: "" } });
    const afterRuleRaw = await vault.bytes(tradingDocumentPath(store));
    const caseAction = await confirm({ kind: "save_case", caseId, input: { versionId: undefined, review: "明确更正" } });
    reopen(); const document = (await store.getTradingSnapshot()).document;
    expect(document.models).toHaveLength(1); expect(document.cases).toHaveLength(1); expect(document.models[0].versions).toHaveLength(2);
    expect(document.models[0].versions[0]).toEqual(initial.models[0].versions[0]);
    expect(document.models[0].versions[1]).toMatchObject({ modelId, previousVersionId: versionId, title: "纯虚构原模型", entry: "新条件", exit: "" });
    expect(document.cases[0]).toMatchObject({ id: caseId, modelId, versionId, execution: "保留原执行", result: "保留原结果", review: "明确更正", revision: 2 });
    expect(document.cases[0].revisions[0]).toMatchObject({ versionId, execution: "保留原执行", review: "", revision: 1, updatedAt: initial.cases[0].updatedAt });
    const query = await buildTradingResearchContext(store, caseId); expect(query).toContain("保留原条件"); expect(query).not.toContain("新条件");
    await runtime.undoLatestOperation(); expect(await vault.bytes(tradingDocumentPath(store))).toBe(afterRuleRaw);
    await expect(runConfirmedToolAction(caseAction, context())).rejects.toThrow(/失效|撤销|重复/);
    await runtime.undoLatestOperation(); expect(await vault.bytes(tradingDocumentPath(store))).toBe(initialRaw);
    await expect(runConfirmedToolAction(ruleAction, context())).rejects.toThrow(/失效|撤销|重复/);
  });
  it("allows an explicitly chosen different saved version while retaining the original case binding in history", async () => {
    await confirm({ kind: "save_model", input: { title: "纯虚构另一个模型", entry: "另一条件" } });
    const other = (await store.getTradingSnapshot()).document.models[1].versions[0];
    const before = await vault.bytes(tradingDocumentPath(store));
    await confirm({ kind: "save_case", caseId, input: { versionId: other.id, review: "明确改绑另一具体版本" } });
    reopen(); const entry = (await store.getTradingSnapshot()).document.cases[0];
    expect(entry).toMatchObject({ id: caseId, modelId: other.modelId, versionId: other.id });
    expect(entry.revisions[0]).toMatchObject({ modelId, versionId });
    await runtime.undoLatestOperation(); expect(await vault.bytes(tradingDocumentPath(store))).toBe(before);
  });
  it("does not silently ignore old entryId on an append or a contradictory target type", async () => {
    await assertRefused({ kind: "save_case", entryId: caseId, input: { versionId, date: "2026-10-04", result: "不能忽略旧ID" } });
    await assertRefused({ kind: "save_model", caseId, input: { title: "不能忽略案例ID" } });
  });
});

describe("guarded trading Store validates identity even without the proposal normalizer", () => {
  it.each(invalidIds)("rejects invalid optional Store IDs %j before changing research facts", async id => {
    for (const kind of ["save_model", "save_case"] as const) {
      const snapshot = await store.getTradingSnapshot();
      const command = normalizeTradingCommand(kind === "save_model" ? { kind, modelId, input: { entry: "不保存" } } : { kind, caseId, input: { review: "不保存" } }, store, snapshot);
      Object.assign(command, kind === "save_model" ? { modelId: id } : { caseId: id });
      const raw = await vault.bytes(tradingDocumentPath(store)), operationId = `local:trading-invalid-${++serial}`;
      await expect(runFactOperation(store, { operationId }, scoped => scoped.applyTradingCommand(command, snapshot.revision, operationId), async () => {})).rejects.toThrow("编号");
      expect(await vault.bytes(tradingDocumentPath(store))).toBe(raw);
    }
  });
  it.each(["model", "case", "version"] as const)("rejects a padded %s in guarded Store without normalizing it", async field => {
    const snapshot = await store.getTradingSnapshot();
    const command: TradingCommand = normalizeTradingCommand(field === "model" ? { kind: "save_model", modelId, input: { entry: "不保存" } } : { kind: "save_case", caseId, input: { review: "不保存" } }, store, snapshot);
    if (field === "model") Object.assign(command, { modelId: ` ${modelId} ` });
    else if (field === "case") Object.assign(command, { caseId: ` ${caseId} ` });
    else Object.assign(command.input, { versionId: ` ${versionId} ` });
    const raw = await vault.bytes(tradingDocumentPath(store)), operationId = `local:trading-padded-${++serial}`;
    await expect(runFactOperation(store, { operationId }, scoped => scoped.applyTradingCommand(command, snapshot.revision, operationId), async () => {})).rejects.toThrow("编号");
    expect(await vault.bytes(tradingDocumentPath(store))).toBe(raw);
  });
});
