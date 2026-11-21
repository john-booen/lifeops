import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiChatResult, AiToolDefinition } from "../src/ai";
import type { AgentTurnHost } from "../src/agent/run";
import type { AgentHost } from "../src/agent/service";
import type { StoreHost } from "../src/store/settingsSlice";
import type { PhoneInboxTurn } from "../src/features/phoneInbox/model";
import { DEFAULT_SETTINGS } from "../src/defaults";
vi.mock("obsidian", () => ({ App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
  WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, Setting: class {},
  Platform: { isDesktopApp: true }, setIcon: vi.fn(), requestUrl: vi.fn(),
  normalizePath: (s: string) => s.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { createFsApp } = await import("./helpers/fsApp");
const { LifeOpsStore } = await import("../src/store");
const { LifeOpsAi } = await import("../src/ai");
const { AgentRuntime } = await import("../src/agentRuntime");
const { runAgentTurn } = await import("../src/agent/run");
const { executeToolCalls } = await import("../src/agent/service");
const { PhoneInbox, summarizePhoneInbox } = await import("../src/features/phoneInbox/service");
const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
const { phoneInboxSource, deviceCaptureSource } = await import("../src/features/phoneInbox/source");
const { bindDeviceCaptureSource } = await import("../src/features/phoneInbox/deviceBinding");
const { createDeviceCapture, deviceCapturePath, serializeDeviceCapture } = await import("../src/features/phoneInbox/deviceCapture");
const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
const { taskBatchManifestPath } = await import("../src/features/tasks/batchWrite");
let root: string, store: StoreHost, app: ReturnType<typeof createFsApp>, runtime: InstanceType<typeof AgentRuntime>;
let inbox: InstanceType<typeof PhoneInbox>, ai: InstanceType<typeof LifeOpsAi>, plugin: AgentTurnHost;
let answers: AiChatResult[], catalogs: AiToolDefinition[][];
const date = "2066-01-10", text = "纯虚构：把五项纸样工作全部安排今天，排好时间并一次创建。";
const tasks = Array.from({ length: 5 }, (_, i) => ({ title: `虚构整批纸样步骤${i}`, estimateMin: 20 }));
const batch = (args: Record<string, unknown> = {}): AiChatResult => ({ content: "不能把模型这句当成保存回执。",
  toolCalls: [{ id: "fictional-batch", name: "schedule_task_batch", arguments: { date: "今天", tasks, ...args } }] });
function start(kind: "phone" | "device" = "phone") {
  inbox?.stop();
  inbox = new PhoneInbox({ store: () => store, enabled: () => true,
    submit: (message: string, phoneInbox: PhoneInboxTurn, signal: AbortSignal) =>
      runAgentTurn.call(plugin, message, [], () => {}, { phoneInbox, signal }),
    bindSource: (line, guards) => bindDeviceCaptureSource({ store, saveLocalOperation: async (name, args, execute, control) => {
      const result = await runtime.executeLocalOperation(name, args, execute, undefined, control);
      if (!result.success) throw Error(result.output);
    } }, line, guards),
    confirm: async () => { throw Error("No confirmation expected in this fictional batch"); },
    undo: id => runtime.undoOperation(id), notify: () => {}
  }, new LifeOpsEventBus(), kind === "phone" ? phoneInboxSource : deviceCaptureSource);
}
async function source(kind: "phone" | "device" = "phone", capturedAt = new Date()) {
  start(kind);
  if (kind === "phone") {
    const raw = `[${date} 10:00] ${text}\n`;
    await store.ensureFile(PHONE_INBOX_PATH, raw);
    return { path: PHONE_INBOX_PATH, raw };
  }
  const capture = createDeviceCapture("0138e995-6341-4ff6-a82c-5710b7186912", text, capturedAt, "Asia/Shanghai");
  const path = deviceCapturePath(capture), raw = serializeDeviceCapture(capture);
  await store.ensureFile(path, raw); return { path, raw };
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2066, 0, 10, 10));
  root = await mkdtemp(join(tmpdir(), "lifeops-phone-batch-"));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.ai = { ...settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", apiKey: "fictional-key",
    model: "synthetic", fallbackProvider: "off", dataDisclosureAccepted: true };
  settings.privacy = { excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
  app = createFsApp(root); store = new LifeOpsStore(app, settings) as unknown as StoreHost;
  await store.initializeVault(); runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  ai = new LifeOpsAi(settings); answers = []; catalogs = [];
  vi.spyOn(ai, "agentTurnStream").mockImplementation(async (_messages, _onText, options) => {
    catalogs.push(options?.tools ?? []);
    const result = answers.shift(); if (!result) throw Error("Unexpected synthetic model call"); return result;
  });
  const bridge = { settings, store, ai, activeProviderRequests: new Set(), unloaded: false,
    finiteProviderRevision: () => "synthetic", createAgentRuntime: () => runtime,
    executeToolCalls: (...args: Parameters<typeof executeToolCalls>) => executeToolCalls.apply(bridge as unknown as AgentHost, args) };
  plugin = bridge as unknown as AgentTurnHost;
});
afterEach(async () => { inbox?.stop(); vi.restoreAllMocks(); vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

it.each(["phone", "device"] as const)("saves five %s tasks at once and recovers/undoes only this batch after replay", async kind => {
  const input = await source(kind); answers.push(batch());
  await inbox.scan(); await inbox.scan();
  const rows = (await store.readTaskDb()).tasks;
  expect(rows).toHaveLength(5); expect(rows.every(row => row.date === date && row.startTime! > "10:00")).toBe(true);
  expect(new Set(rows.map(row => row.source)).size).toBe(5);
  const [receipt] = await inbox.list();
  expect(receipt).toMatchObject({ status: "saved", tool: "create_task", taskBatch: { created: 5, existing: 0 } });
  expect(receipt.message).toContain("实际保存5项"); expect(receipt.message).not.toContain("模型这句");
  expect(summarizePhoneInbox([receipt])).toContain("新建任务 5 项");
  expect(catalogs).toHaveLength(1); expect(catalogs[0].filter(tool => tool.name === "schedule_task_batch")).toHaveLength(1);
  expect(await store.readPath(input.path)).toBe(input.raw);
  const receiptPath = store.path(store.settings.folders.aiReports, "System", kind === "phone" ? "phone-inbox.json" : "device-inbox.json");
  await app.vault.delete(store.getFile(receiptPath)!); start(kind); await inbox.scan();
  const [recovered] = await inbox.list();
  expect(recovered).toMatchObject({ operationId: receipt.operationId, status: "saved", taskBatch: { created: 5, existing: 0 } });
  expect(catalogs).toHaveLength(1);
  await runtime.executeAiToolCall({ id: "fictional-unrelated", name: "create_task", arguments: { title: "虚构保留独立任务" } }, "kimi");
  await inbox.resolve(receipt.id, "undo");
  expect((await store.readTaskDb()).tasks.map(row => row.title)).toEqual(["虚构保留独立任务"]);
  expect(store.getFile(taskBatchManifestPath(store, receipt.operationId!))).toBeNull();
  await app.vault.delete(store.getFile(receiptPath)!); start(kind); await inbox.scan();
  expect((await inbox.list())[0].undone).toBe(true); expect(catalogs).toHaveLength(1);
  expect(await store.readPath(input.path)).toBe(input.raw);
});

it("keeps an all-existing second request settled without recreating or undoing the original five", async () => {
  const input = await source(); answers.push(batch()); await inbox.scan();
  await app.vault.modify(store.getFile(input.path)!, input.raw + input.raw); answers.push(batch()); await inbox.scan();
  const [second] = await inbox.list();
  expect(second.taskBatch).toEqual({ created: 0, existing: 5 }); expect(second.status).toBe("saved");
  expect(summarizePhoneInbox(await inbox.list())).toContain("新建任务 5 项");
  expect(summarizePhoneInbox(await inbox.list())).toContain("沿用已有任务 5 项");
  await inbox.resolve(second.id, "undo"); expect((await store.readTaskDb()).tasks).toHaveLength(5);
});

it("preserves completed/existing rows and keeps overflow on the requested date", async () => {
  await store.createTask({ title: tasks[0].title, date });
  const old = (await store.readTaskDb()).tasks[0]; await store.completeTask(old.id);
  const before = await store.getTask(old.id);
  await source(); answers.push(batch({ availableEnd: "10:30" })); await inbox.scan();
  expect(await store.getTask(old.id)).toEqual(before);
  expect((await inbox.list())[0].taskBatch).toEqual({ created: 4, existing: 1 });
  const rows = (await store.readTaskDb()).tasks;
  expect(rows).toHaveLength(5); expect(rows.every(row => row.date === date)).toBe(true);
  expect(rows.filter(row => row.status === "active" && !row.startTime)).toHaveLength(3);
  expect((await inbox.list())[0].message).toContain("3项在剩余时间内放不下");
});

it.each(["phone", "device"] as const)("retains the captured day for delayed %s batches without inventing past time slots", async kind => {
  const captured = new Date(2066, 0, 10, 10); await source(kind, captured);
  vi.setSystemTime(new Date(2066, 0, 12, 16)); answers.push(batch()); await inbox.scan();
  const rows = (await store.readTaskDb()).tasks;
  expect(rows).toHaveLength(5); expect(rows.every(row => row.date === date && !row.startTime && !row.endTime)).toBe(true);
  expect((await inbox.list())[0].message).toContain("未倒填过去的时段");
});

it("rolls back all tasks and the receipt marker if the third creation fails", async () => {
  await source(); const original = LifeOpsStore.prototype.createTask;
  const before = await store.readPath(store.taskDbPath()), mirror = await store.readPath(store.taskMirrorPath());
  let calls = 0;
  vi.spyOn(LifeOpsStore.prototype, "createTask").mockImplementation(async function (this: InstanceType<typeof LifeOpsStore>, ...args) {
    const result = await original.apply(this, args); if (++calls === 3) throw Error("Fictional storage failure"); return result;
  });
  answers.push(batch()); await inbox.scan();
  expect(calls).toBe(3); expect(await store.readPath(store.taskDbPath())).toBe(before);
  expect(await store.readPath(store.taskMirrorPath())).toBe(mirror);
  const [row] = await inbox.list(); expect(row.status).toBe("review"); expect(row.operationId).toBeUndefined();
});

it.each(["phone", "device"] as const)("rolls back the whole %s batch if its source is edited during saving", async kind => {
  const input = await source(kind), original = LifeOpsStore.prototype.createTask;
  let calls = 0, edited = "";
  vi.spyOn(LifeOpsStore.prototype, "createTask").mockImplementation(async function (this: InstanceType<typeof LifeOpsStore>, ...args) {
    const result = await original.apply(this, args);
    if (++calls === 3) {
      if (kind === "phone") edited = input.raw.replace(text, "纯虚构：原文已改动，不要采用旧安排。");
      else {
        const row = JSON.parse(input.raw); row.text = "纯虚构：原文已改动";
        const { fileRevision } = await import("../src/operationIdentity"); row.textRevision = fileRevision(row.text); edited = JSON.stringify(row);
      }
      await app.vault.modify(store.getFile(input.path)!, edited);
    }
    return result;
  });
  answers.push(batch()); await inbox.scan();
  expect((await store.readTaskDb()).tasks).toEqual([]);
  expect(await store.readPath(input.path)).toBe(edited);
  expect((await inbox.list()).some(row => row.status === "review")).toBe(true);
});

it("does not recreate a committed batch when only its inbox receipt write failed", async () => {
  await source(); const process = app.vault.process.bind(app.vault); let failOnce = true;
  vi.spyOn(app.vault, "process").mockImplementation(async (file, updater) => {
    if (file.path.endsWith("/phone-inbox.json")) {
      const next = updater(await app.vault.read(file));
      if (next.includes('"saved"') && failOnce) { failOnce = false; throw Error("Fictional receipt write outage"); }
      return process(file, () => next);
    }
    return process(file, updater);
  });
  answers.push(batch()); await expect(inbox.scan()).rejects.toThrow();
  expect((await store.readTaskDb()).tasks).toHaveLength(5);
  vi.restoreAllMocks(); start(); await inbox.scan();
  expect((await inbox.list())[0]).toMatchObject({ status: "saved", taskBatch: { created: 5, existing: 0 } });
  expect((await store.readTaskDb()).tasks).toHaveLength(5); expect(catalogs).toHaveLength(1);
});

it("keeps all twenty task receipts available beyond the short inbox preview", async () => {
  const input = await source();
  const many = Array.from({ length: 20 }, (_, i) => ({ title: `虚构步骤${i}：` + "核对蓝色纸样的边缘与标记".repeat(3), estimateMin: 10 }));
  await app.vault.modify(store.getFile(input.path)!, `[${date} 10:00] 请安排并保存今天这20项：${many.map(row => row.title).join("；")}\n`);
  answers.push(batch({ tasks: many })); await inbox.scan();
  const [row] = await inbox.list(); expect(row.taskBatch).toEqual({ created: 20, existing: 0 });
  const detail = await inbox.batchDetails(row.id);
  expect(detail.length).toBeGreaterThan(2000); expect(detail).toContain(many[19].title);
  expect((await store.readTaskDb()).tasks).toHaveLength(20);
  store.settings.privacy!.excludedVaultPrefixes = [store.path(store.settings.folders.aiReports, "Operations")];
  await expect(inbox.batchDetails(row.id)).rejects.toThrow("不允许读取");
});

it.each([false, true])("rejects an excluded batch marker directory before/during the transaction (mid-save: %s)", async midSave => {
  await source();
  const exclude = () => { store.settings.privacy!.excludedVaultPrefixes = [store.path(store.settings.folders.aiReports, "System", "TaskBatches")]; };
  if (midSave) {
    const original = LifeOpsStore.prototype.createTask; let calls = 0;
    vi.spyOn(LifeOpsStore.prototype, "createTask").mockImplementation(async function (this: InstanceType<typeof LifeOpsStore>, ...args) {
      const result = await original.apply(this, args); if (++calls === 3) exclude(); return result;
    });
  } else exclude();
  answers.push(batch()); await inbox.scan();
  expect((await store.readTaskDb()).tasks).toEqual([]);
  expect((await inbox.list())[0].status).toBe("review");
});

it("rejects a new model plan reusing an already committed batch identity", async () => {
  await source(); answers.push(batch()); await inbox.scan();
  const [row] = await inbox.list();
  const result = await runtime.executeAiToolCall({ id: row.operationId, name: "schedule_task_batch",
    arguments: { date, tasks: [{ title: "虚构不应被新加的任务" }] } }, "kimi");
  expect(result.success).toBe(false); expect(result.output).toContain("冲突");
  expect((await store.readTaskDb()).tasks).toHaveLength(5);
});
