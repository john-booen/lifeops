import { LifeOpsStore } from "../../src/store";
import { AgentRuntime } from "../../src/agentRuntime";
import { DEFAULT_SETTINGS } from "../../src/defaults";
import { DiskVault } from "./diskVault";
import { runConfirmedToolAction } from "../../src/toolRegistry";
import { recoverFactOperation, factRecoveryPath } from "../../src/dataFoundation/factOperation";
import { readPersonalMemoryWithSources } from "../../src/personalMemorySources";
import { personalMemorySourceAssessment, selectPersonalMemories } from "../../src/personalMemory";
import type { App } from "obsidian";
import type { StoreHost } from "../../src/store/settingsSlice";
const [root, mode, phase = "none", identity = "initial"] = process.argv.slice(2);
const vault = new DiskVault(root), store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
const context = { store, refreshViews: async () => {} }, runtime = new AgentRuntime(context);
if (mode === "inspect") {
  const document = await readPersonalMemoryWithSources(store);
  const query = await runtime.executeAiToolCall({ id: "fictional-process-query", name: "list_personal_memory_candidates", arguments: {} }, "kimi");
  console.log(JSON.stringify({ candidateQuerySucceeded: query.success, activeCount: selectPersonalMemories(document.records).length,
    records: document.records.map(record => ({ id: record.id, status: record.status, usable: record[personalMemorySourceAssessment]?.usable })) }));
} else if (mode === "recover") console.log(JSON.stringify({ recovery: await recoverFactOperation(store) }));
else {
  const request = mode === "candidate" ? { id: `fictional-process-candidate-${identity}`, name: "propose_note_understanding", arguments: {
    path: "Notes/纯虚构进程来源.md", candidates: [{ kind: "current_state", content: "纯虚构可能想先完成一件事", excerpt: "纯虚构我想先完成一件事。" }] } }
    : { id: `fictional-process-confirm-${identity}`, name: "review_personal_memory", arguments: { memoryId: (await store.readPersonalMemories()).records[0].id, decision: "confirm" } };
  const prepared = await runtime.executeAiToolCall(request, "kimi");
  if (!prepared.success || prepared.actions.length !== 1) throw new Error(prepared.output);
  const action = prepared.actions[0], operationId = `confirmed:${action.id}`, processFile = vault.process.bind(vault), create = vault.create.bind(vault);
  const crash = () => process.kill(process.pid, "SIGKILL");
  function after(path: string, content: string) {
    if (phase === "after-memory" && path === store.personalMemoryPath()) crash();
    if (phase === "after-audit" && path.endsWith("operation-ledger.json") && JSON.parse(content).records.some((record: any) => record.operationId === operationId && record.status === "verified")) crash();
    if (phase === "after-wal" && path === factRecoveryPath(store) && JSON.parse(content).operationId === operationId && JSON.parse(content).status === "committed") crash();
  }
  vault.process = async (file, update) => { const result = await processFile(file, update); after(file.path, result); return result; };
  vault.create = async (path, content) => { const file = await create(path, content); after(path, content); return file; };
  console.log(JSON.stringify({ saved: await runConfirmedToolAction(action, context) }));
}
