import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentLoop, type AgentLoopHost } from "../src/agent/AgentLoop";
import { AgentRuntime } from "../src/agentRuntime";
import { OperationLedger } from "../src/dataFoundation/operationLedger";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
  normalizePath: (s: string) => s.replace(/\\/g, "/"), parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { createFsApp } = await import("./helpers/fsApp");
const { LifeOpsStore } = await import("../src/store");
let root: string, store: StoreHost, runtime: AgentRuntime, host: AgentLoopHost;
const model = vi.fn();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-recent-change-"));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.ai = { ...settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", model: "fiction", apiKey: "fiction", dataDisclosureAccepted: true };
  settings.privacy = { ...settings.privacy, excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
  store = new LifeOpsStore(createFsApp(root), settings) as unknown as StoreHost; await store.initializeVault();
  runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  model.mockReset().mockResolvedValue({ content: "这是讨论内容，没有执行撤销。", toolCalls: [] });
  host = { settings, store, aiForRole: () => ({ agentTurnStream: model }), offlineFallback: async () => null,
    executeTools: async (calls, message, _signal, onResult) => Promise.all(calls.map(async call => {
      const result = await runtime.executeAiToolCall(call, "kimi", message); onResult(call, result); return result;
    })) };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function changedTask() {
  expect((await runtime.executeAiToolCall({ id: "created", name: "create_task", arguments: { title: "给林小葵送样品盒", date: "2026-11-22", time: "15:15" } }, "kimi")).success).toBe(true);
  const prior = (await store.readTaskDb()).tasks[0];
  expect((await runtime.executeAiToolCall({ id: "changed", name: "reschedule_task", arguments: { taskIdOrTitle: prior.id, time: "16:00" } }, "kimi")).success).toBe(true);
  return prior;
}
for (const source of ["text", "voice"] as const) {
  it.each(["撤销刚才的修改。", "撤销刚刚的修改！"])(`restores only the latest modification locally in ${source}: %s`, async message => {
    const prior = await changedTask();
    const unrelated = await store.createTask({ title: "稍后同步的无关虚构任务", note: "必须保留" });
    const result = await new AgentLoop(host).run({ source, message, history: [], now: new Date("2026-11-21T18:00:00+08:00") });
    expect(result.text).toContain("已撤销这次待办改期「给林小葵送样品盒」"); expect(model).not.toHaveBeenCalled();
    const tasks = (await store.readTaskDb()).tasks;
    expect(tasks).toHaveLength(2); expect(tasks.find(t => t.id === prior.id)).toEqual(prior);
    expect(tasks.find(t => t.id === unrelated.id)).toEqual(unrelated);
    const ledger = JSON.parse((await store.readPath(new OperationLedger(store).filePath))!);
    expect(ledger.records.find((r: { operationId: string }) => r.operationId === "changed")?.status).toBe("reverted");
  });
}
it.each(["不要撤销刚才的修改。", "撤销刚才的修改是什么意思？", "请记录：撤销刚才的修改。", "如果有错，撤销刚才的修改。", "撤销刚才的修改，先等我确认。"])("does not treat quoted, conditional or negated text as a local command: %s", async message => {
  await changedTask(); const before = (await store.readTaskDb()).tasks;
  const result = await new AgentLoop(host).run({ source: "text", message, history: [], now: new Date("2026-11-21T18:00:00+08:00") });
  expect(model).toHaveBeenCalled(); expect(result.toolCalls).toEqual([]); expect((await store.readTaskDb()).tasks).toEqual(before);
});
