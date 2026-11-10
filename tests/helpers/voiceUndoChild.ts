import type { App } from "obsidian";
import { AgentRuntime } from "../../src/agentRuntime";
import { DEFAULT_SETTINGS } from "../../src/defaults";
import { factRecoveryPath, recoverFactOperation } from "../../src/dataFoundation/factOperation";
import { LifeOpsStore } from "../../src/store";
import type { StoreHost } from "../../src/store/settingsSlice";
import { DiskVault } from "./diskVault";

const [root, mode, phase = "none"] = process.argv.slice(2);
const vault = new DiskVault(root);
const store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
const originalId = "fiction-original", undoId = "fiction-voice-undo";
const ledgerPath = store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
const recoveryPath = factRecoveryPath(store);
const processFile = vault.process.bind(vault);
let cancelled = false;
const cancellationPhase = phase === "after-rollback-required" || phase === "after-rollback-complete"
  || phase === "before-own-release" || phase === "after-own-release";
type Audit = { records: Array<{ operationId: string; status: string }> };
function auditStates(text: string) {
  const audit = JSON.parse(text) as Audit;
  return { original: audit.records.find(record => record.operationId === originalId)?.status,
    own: audit.records.find(record => record.operationId === undoId)?.status };
}
function crash(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not stop the child");
}

// These hooks stop real writes to the temporary disk. They do not manufacture
// an audit or recovery document, and do not turn a caught exception into a kill.
vault.process = async (file, updater) => {
  const result = await processFile(file, text => {
    const next = updater(text);
    if (file.path === ledgerPath) {
      const state = auditStates(next);
      if (phase === "before-undo-audit" && state.original === "reverted") crash();
      if (phase === "before-own-release" && cancelled && state.original === "verified" && state.own === "failed") crash();
    }
    return next;
  });
  if (file.path === ledgerPath) {
    const state = auditStates(result);
    if (state.original === "reverted") {
      if (phase === "after-undo-audit") crash();
      if (cancellationPhase) cancelled = true;
    }
    if (phase === "after-own-release" && cancelled && state.original === "verified" && state.own === "failed") crash();
  }
  if (file.path === recoveryPath) {
    const recovery = JSON.parse(result) as { status: string; rollbackRequired?: boolean; rollbackComplete?: boolean };
    if (recovery.status === "pending" && recovery.rollbackRequired) {
      if (phase === "after-rollback-required") crash();
      if (phase === "after-rollback-complete" && recovery.rollbackComplete) crash();
    }
  }
  return result;
};

if (mode === "recover") {
  console.log(JSON.stringify({ status: await recoverFactOperation(store) }));
} else if (mode === "undo") {
  const runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
  const result = await runtime.executeToolCall({
    toolName: "undo_latest_operation", arguments: {}, source: "qwen-omni",
    callId: undoId, userMessage: "请撤销上一步"
  }, { assertCurrent: () => { if (cancelled) throw new Error("fiction voice turn cancelled"); } });
  console.log(JSON.stringify({ result }));
} else {
  throw new Error(`Unknown child mode: ${mode}`);
}
