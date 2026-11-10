import { LifeOpsStore } from "../../src/store";
import { AgentRuntime } from "../../src/agentRuntime";
import { DEFAULT_SETTINGS } from "../../src/defaults";
import { DiskVault } from "./diskVault";
import { runConfirmedToolAction } from "../../src/toolRegistry";
import { recoverFactOperation, factRecoveryPath } from "../../src/dataFoundation/factOperation";
import type { App } from "obsidian";
import type { StoreHost } from "../../src/store/settingsSlice";
const [root, mode, phase = "none", identity = "initial"] = process.argv.slice(2);
const vault = new DiskVault(root), store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
const context = { store, refreshViews: async () => {} }, runtime = new AgentRuntime(context), path = "Notes/2026-10-01.md";
const query = () => runtime.executeAiToolCall({ id: `fiction-weekly-process-read-${identity}`, name: "inspect_weekly_review_sources", arguments: { startDate: "2026-10-01", endDate: "2026-10-07", paths: [path] } }, "kimi");
if (mode === "inspect") {
  const result = await query(), drafts = vault.getMarkdownFiles().filter(file => file.path.includes("/周回顾/")).map(file => file.path);
  console.log(JSON.stringify({ querySucceeded: result.success, drafts, memories: (await store.readPersonalMemories()).records.length }));
} else if (mode === "recover") console.log(JSON.stringify({ recovery: await recoverFactOperation(store) }));
else {
  const read = await query(); if (!read.success) throw Error(read.output);
  const prepared = await runtime.executeAiToolCall({ id: `fiction-weekly-process-propose-${identity}`, name: "propose_weekly_review", arguments: {
    sourceToken: JSON.parse(read.output).sourceToken, hypotheses: [{ claim: "纯虚构可能先做一件事有帮助", supports: [{ path, excerpt: "纯虚构我想先完成一件事。" }], counterexamples: [], uncertainties: ["只有一条记录，事件日期和长期代表性未知"] }]
  } }, "kimi");
  if (!prepared.success || prepared.actions.length !== 1) throw Error(prepared.output);
  const action = prepared.actions[0], operationId = `confirmed:${action.id}`, processFile = vault.process.bind(vault), create = vault.create.bind(vault);
  const crash = () => process.kill(process.pid, "SIGKILL");
  function after(path: string, content: string) {
    if (phase === "after-draft" && path === action.weeklyReviewPath) crash();
    if (phase === "after-audit" && path.endsWith("operation-ledger.json") && JSON.parse(content).records.some((record: any) => record.operationId === operationId && record.status === "verified")) crash();
    if (phase === "after-wal" && path === factRecoveryPath(store) && JSON.parse(content).operationId === operationId && JSON.parse(content).status === "committed") crash();
  }
  vault.process = async (file, update) => { const result = await processFile(file, update); after(file.path, result); return result; };
  vault.create = async (path, content) => { const file = await create(path, content); after(path, content); return file; };
  console.log(JSON.stringify({ saved: await runConfirmedToolAction(action, context), path: action.weeklyReviewPath }));
}
