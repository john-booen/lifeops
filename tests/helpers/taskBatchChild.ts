import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { AgentRuntime } from "../../src/agentRuntime";
import { LifeOpsStore } from "../../src/store";
import { DEFAULT_SETTINGS } from "../../src/defaults";
import { PHONE_INBOX_PATH, parsePhoneInbox, phoneInboxWriteId } from "../../src/features/phoneInbox/model";
import { createFsApp } from "./fsApp";
import type { StoreHost } from "../../src/store/settingsSlice";
const [root, phase] = process.argv.slice(2);
mkdirSync(join(root, "vault"), { recursive: true });
const app = createFsApp(join(root, "vault")), settings = structuredClone(DEFAULT_SETTINGS);
const store = new LifeOpsStore(app, settings) as unknown as StoreHost;
await store.initializeVault();
await store.createTask({ title: "虚构保留的独立任务" });
const raw = "[2066-01-10 10:00] 纯虚构：请把五项纸样工作安排今天并一次保存。\n";
await store.ensureFile(PHONE_INBOX_PATH, raw);
const operationId = phoneInboxWriteId(parsePhoneInbox(raw, "2066-01-10")[0].id);
function crash(): never { process.kill(process.pid, "SIGKILL"); throw Error("Fictional child did not stop"); }
const createTask = LifeOpsStore.prototype.createTask;
let creations = 0;
LifeOpsStore.prototype.createTask = async function (...args) {
  const result = await createTask.apply(this, args);
  if (++creations === 3 && phase === "after-third-task") crash();
  return result;
};
const create = app.vault.create.bind(app.vault), processFile = app.vault.process.bind(app.vault);
const after = (path: string, text: string) => {
  if (phase === "after-marker" && path.includes("/System/TaskBatches/")) crash();
  if (phase === "after-audit" && path.endsWith("/Operations/operation-ledger.json")
    && JSON.parse(text).records.some((row: { operationId: string; status: string }) => row.operationId === operationId && row.status === "verified")) crash();
};
app.vault.create = async (path, text) => { const file = await create(path, text); after(path, text); return file; };
app.vault.process = async (file, updater) => { const next = await processFile(file, updater); after(file.path, next); return next; };
await new AgentRuntime({ store, refreshViews: async () => {} }).executeAiToolCall({ id: operationId, name: "schedule_task_batch",
  arguments: { date: "2066-01-10", tasks: Array.from({ length: 5 }, (_, i) => ({ title: `虚构断电恢复纸样${i}`, estimateMin: 20 })) } }, "kimi");
throw Error("Fictional process did not reach its planned kill point");
