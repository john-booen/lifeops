import { activityNotePath } from "../../src/activityRecords";
import { LifeOpsStore } from "../../src/store";
import { DEFAULT_SETTINGS } from "../../src/defaults";
import { AgentRuntime } from "../../src/agentRuntime";
import { recoverFactOperation } from "../../src/dataFoundation/factOperation";
import { DiskVault } from "./diskVault";
import type { App } from "obsidian";
import type { StoreHost } from "../../src/store/settingsSlice";

const [root, mode, phase, targetId] = process.argv.slice(2);
const vault = new DiskVault(root);
const store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
const runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
function crash(): never { process.kill(process.pid, "SIGKILL"); throw new Error("SIGKILL did not stop the child"); }
const processFile = vault.process.bind(vault), create = vault.create.bind(vault), rename = vault.rename.bind(vault);
let businessWrites = 0;
const business = (path: string): boolean => !path.includes("/Operations/");
vault.process = async (file, updater) => {
  if (mode === "intermediate" && phase === "before-second-write" && business(file.path) && businessWrites === 1) crash();
  if (business(file.path) && phase === "before-first-write" && businessWrites === 0) crash();
  if (mode === "undo" && phase === "before-audit" && file.path.endsWith("operation-ledger.json")) crash();
  const result = await processFile(file, updater);
  if (business(file.path)) {
    businessWrites++;
    if (phase === "after-first-write" && businessWrites === 1) crash();
  }
  if (phase === "after-audit" && file.path.endsWith("operation-ledger.json")) {
    const ledger = JSON.parse(await vault.bytes(file.path));
    if (ledger.records.some((record: { operationId: string; status: string }) => record.operationId === "crash-operation" && record.status === (mode === "undo" ? "reverted" : "verified"))) crash();
  }
  return result;
};
vault.create = async (path, content) => {
  const file = await create(path, content);
  if (business(path)) {
    businessWrites++;
    if (phase === "after-new-journal" && path === activityNotePath(store, "tasks", "2026-09-09")) crash();
    if (phase === "after-first-write" && businessWrites === 1) crash();
  }
  return file;
};
vault.rename = async (file, path) => { await rename(file, path); if (phase === "after-removal-rename") crash(); };

if (mode === "recover") console.log(JSON.stringify({ status: await recoverFactOperation(store) }));
else if (mode === "undo") { await runtime.undoOperation("crash-operation"); console.log(JSON.stringify({ status: "undone" })); }
else if (mode === "intermediate") {
  const path = store.path(store.settings.folders.ideas, "纯虚构中间写入.md");
  const result = await runtime.executeLocalOperation("append_note", {}, async scoped => {
    await scoped.writeFile(path, "intermediate B");
    await scoped.writeFile(path, "intended C");
  }, "crash-operation");
  if (!result.success) throw new Error("Synthetic intermediate operation failed");
  console.log(JSON.stringify({ status: "saved" }));
}
else {
  const result = await runtime.executeLocalOperation("complete-repeat", { taskId: targetId }, scoped => scoped.completeTaskAndLog(targetId, "2026-09-09", "完成学习"), "crash-operation");
  if (!result.success) throw new Error("Synthetic operation failed");
  console.log(JSON.stringify({ status: "saved" }));
}
