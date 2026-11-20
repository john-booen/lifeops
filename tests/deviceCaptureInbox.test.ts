import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatResult, AiToolCall, ChatMessage } from "../src/ai";
import type { AgentLoopHost, AgentTurnInput } from "../src/agent/AgentLoop";
import type { StoreHost } from "../src/store/settingsSlice";
import type { OperationLedgerDocument } from "../src/dataFoundation/operationLedger";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { createDeviceCapture, deviceCaptureOperationId, deviceCapturePath, serializeDeviceCapture } from "../src/features/phoneInbox/deviceCapture";
import { deviceCaptureSource } from "../src/features/phoneInbox/source";

vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {},
  Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  parseYaml: (yaml: string) => JSON.parse(yaml), stringifyYaml: (fields: unknown) => JSON.stringify(fields),
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: vi.fn()
}));
const { createFsApp } = await import("./helpers/fsApp");
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { AgentLoop } = await import("../src/agent/AgentLoop");
const { PhoneInbox } = await import("../src/features/phoneInbox/service");
const { bindDeviceCaptureSource } = await import("../src/features/phoneInbox/deviceBinding");
const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
const { runConfirmedToolAction } = await import("../src/toolRegistry");
const deviceA = "0138e995-6341-4ff6-a82c-5710b7186912", deviceB = "11ec4614-9488-4c39-b75c-a5cd3a72e1b7";
const capturedAt = new Date("2066-01-03T17:20:30.000Z"), processedAt = new Date("2066-01-10T04:00:00.000Z");
let root: string, store: StoreHost, host: AgentLoopHost, runtime: InstanceType<typeof AgentRuntime>;
let inbox: InstanceType<typeof PhoneInbox>, enabled: boolean, beforeModel: (() => Promise<void>) | undefined;
let answers: AiChatResult[], requests: ChatMessage[][];
const call = (name: string, args: Record<string, unknown>): AiToolCall => ({ id: "fictional-call", name, arguments: args });
function answer(name: string, args: Record<string, unknown>): AiChatResult {
  return { content: "", toolCalls: [call(name, args)], reportedModel: "synthetic-model" };
}
function options() {
  return { store: () => store, enabled: () => enabled,
    bindSource: (line: import("../src/features/phoneInbox/model").PhoneInboxLine,
      guards: import("../src/features/phoneInbox/deviceBinding").DeviceSourceGuards) => bindDeviceCaptureSource({ store, saveLocalOperation: async (name, args, execute, control) => {
      const result = await runtime.executeLocalOperation(name, args, execute, undefined, control);
      if (!result.success) throw Error("Fictional source seal did not settle");
    } }, line, guards),
    submit: async (message: string, phoneInbox: NonNullable<AgentTurnInput["phoneInbox"]>, signal: AbortSignal) => {
      const result = await new AgentLoop(host).run({ message, history: [], source: "system", now: processedAt, phoneInbox, signal });
      return { reply: result.text, receipts: result.receipts, actions: result.confirmations, toolCalls: result.toolCalls };
    },
    confirm: async (action: Parameters<typeof runConfirmedToolAction>[0], turn: NonNullable<AgentTurnInput["phoneInbox"]>) => {
      await runConfirmedToolAction(action, { store, refreshViews: async () => {}, assertCurrent: turn.assertCurrent }, turn.assertLineCurrent);
    }, undo: (id: string) => runtime.undoOperation(id), notify: () => {}
  };
}
async function capture(deviceId: string, text: string) {
  const row = createDeviceCapture(deviceId, text, capturedAt, "Asia/Shanghai");
  const path = deviceCapturePath(row), raw = serializeDeviceCapture(row);
  await store.ensureFile(path, raw);
  return { row, path, raw };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-device-capture-inbox-"));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.ai = { ...settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", model: "synthetic-model", dataDisclosureAccepted: true };
  settings.privacy = { excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
  store = new LifeOpsStore(createFsApp(root), settings) as unknown as StoreHost;
  await store.initializeVault();
  runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  answers = []; requests = []; enabled = true; beforeModel = undefined;
  host = { settings, store,
    aiForRole: () => ({ agentTurnStream: vi.fn(async (messages: ChatMessage[], onText: (text: string) => void) => {
      requests.push(structuredClone(messages));
      const hook = beforeModel; beforeModel = undefined; await hook?.();
      const result = answers.shift();
      if (!result) throw Error("Missing synthetic response");
      if (result.content) onText(result.content);
      return result;
    }) }),
    executeTools: async (calls, message, signal, onResult) => {
      const results = [];
      for (const tool of calls) {
        const result = await runtime.executeAiToolCall(tool, "kimi", message, { assertCurrent: () => signal?.throwIfAborted() });
        onResult(tool, result); results.push(result);
      }
      return results;
    }, offlineFallback: vi.fn(async () => null)
  };
  inbox = new PhoneInbox(options(), new LifeOpsEventBus(), deviceCaptureSource);
});
afterEach(async () => { inbox.stop(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("device capture through the existing agent, ledger and receipts", () => {
  it("processes separate devices on their captured date once and keeps targeted undo after replay", async () => {
    const a = await capture(deviceA, "明天下午三点提醒我核对虚构甲纸盒");
    const b = await capture(deviceB, "明天提醒我核对虚构乙蓝纸");
    answers.push(answer("create_task", { title: "虚构甲纸盒", date: "明天", time: "15:00" }),
      answer("create_task", { title: "虚构乙蓝纸", date: "明天" }));
    await Promise.all([inbox.scan(), inbox.scan()]);
    const tasks = (await store.readTaskDb()).tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks.every(task => task.date === "2066-01-05")).toBe(true);
    const receipts = await inbox.list();
    expect(new Set(receipts.map(row => row.operationId))).toEqual(new Set([deviceCaptureOperationId(a.row), deviceCaptureOperationId(b.row)]));
    expect(receipts.every(row => row.status === "saved")).toBe(true);
    expect(requests).toHaveLength(2);
    expect(await store.readPath(a.path)).toBe(a.raw);
    expect(await store.readPath(b.path)).toBe(b.raw);
    const selected = receipts.find(row => row.sourcePath === a.path)!;
    await inbox.resolve(selected.id, "undo");
    expect((await store.readTaskDb()).tasks.map(task => task.title)).toEqual(["虚构乙蓝纸"]);
    inbox.stop(); inbox = new PhoneInbox(options(), new LifeOpsEventBus(), deviceCaptureSource);
    await inbox.scan();
    expect(requests).toHaveLength(2);
    expect((await inbox.list()).find(row => row.id === selected.id)?.undone).toBe(true);
  });
  it("requires explicit approval for a delete and can undo that confirmed operation", async () => {
    const old = await store.createTask({ title: "虚构旧纸盒", date: "2066-01-04" });
    await capture(deviceA, "请删除待办虚构旧纸盒");
    answers.push(answer("delete_task", { taskIdOrTitle: old.id }));
    await inbox.scan();
    const [shown] = await inbox.list();
    expect(shown.status).toBe("confirm");
    expect((await store.readTaskDb()).tasks).toHaveLength(1);
    await inbox.resolve(shown.id, "confirm");
    expect((await store.readTaskDb()).tasks).toHaveLength(0);
    await inbox.resolve(shown.id, "undo");
    expect((await store.readTaskDb()).tasks[0].title).toBe("虚构旧纸盒");
  });
  it("rejects confirmation when a valid request with the same ID was subsequently edited", async () => {
    const old = await store.createTask({ title: "虚构保留物", date: "2066-01-04" });
    const source = await capture(deviceA, "请删除虚构保留物");
    answers.push(answer("delete_task", { taskIdOrTitle: old.id }));
    await inbox.scan();
    const [shown] = await inbox.list();
    const edited = createDeviceCapture(deviceA, "这条请求已经改过", capturedAt, "Asia/Shanghai", source.row.requestId);
    await store.app.vault.modify(store.getFile(source.path)!, serializeDeviceCapture(edited));
    expect((await inbox.list())[0].sourceEditing).toBe(true);
    await expect(inbox.resolve(shown.id, "confirm")).rejects.toThrow("设备原记录已变化");
    expect((await store.readTaskDb()).tasks).toHaveLength(1);
  });
  it("does not save a tool result after the source changes while the model is answering", async () => {
    const source = await capture(deviceA, "明天核对虚构绿纸");
    answers.push(answer("create_task", { title: "虚构绿纸", date: "明天" }));
    beforeModel = async () => {
      const edited = createDeviceCapture(deviceA, "原话已经改动", capturedAt, "Asia/Shanghai", source.row.requestId);
      await store.app.vault.modify(store.getFile(source.path)!, serializeDeviceCapture(edited));
    };
    await inbox.scan();
    expect((await store.readTaskDb()).tasks).toHaveLength(0);
    expect((await inbox.list())[0].status).toBe("review");
  });
  it("leaves malformed partial input for review and processes it once after sync finishes", async () => {
    const source = await capture(deviceA, "明天核对虚构白纸");
    await store.app.vault.modify(store.getFile(source.path)!, "{");
    await inbox.scan();
    expect(requests).toHaveLength(0);
    expect((await inbox.list())[0].status).toBe("review");
    await store.app.vault.modify(store.getFile(source.path)!, source.raw);
    answers.push(answer("create_task", { title: "虚构白纸", date: "明天" }));
    await inbox.scan();
    expect((await store.readTaskDb()).tasks).toHaveLength(1);
    await inbox.scan();
    expect(requests).toHaveLength(1);
  });
  it("does not send or write a capture when the local execution host is disabled", async () => {
    await capture(deviceA, "明天核对虚构红纸"); enabled = false;
    await inbox.scan();
    expect(requests).toHaveLength(0);
    expect((await store.readTaskDb()).tasks).toHaveLength(0);
  });
});

it("restores a lost receipt from the actual operation ledger without asking the model again", async () => {
  await capture(deviceA, "明天检查虚构粉纸");
  answers.push(answer("create_task", { title: "虚构粉纸", date: "明天" }));
  await inbox.scan();
  const path = store.path(store.settings.folders.aiReports, "System", "device-inbox.json");
  await store.app.vault.delete(store.getFile(path)!);
  inbox.stop(); inbox = new PhoneInbox(options(), new LifeOpsEventBus(), deviceCaptureSource);
  await inbox.scan();
  expect(requests).toHaveLength(1);
  expect((await store.readTaskDb()).tasks).toHaveLength(1);
  expect((await inbox.list())[0].status).toBe("saved");
  expect((await inbox.list())[0].sourcePath).toContain(deviceA);
});

it("does not recreate an undone request when both the receipt and input are synchronized again", async () => {
  const source = await capture(deviceA, "明天检查虚构紫纸");
  answers.push(answer("create_task", { title: "虚构紫纸", date: "明天" }));
  await inbox.scan();
  const [shown] = await inbox.list();
  await inbox.resolve(shown.id, "undo");
  const path = store.path(store.settings.folders.aiReports, "System", "device-inbox.json");
  await store.app.vault.delete(store.getFile(path)!);
  await store.app.vault.modify(store.getFile(source.path)!, source.raw);
  inbox.stop(); inbox = new PhoneInbox(options(), new LifeOpsEventBus(), deviceCaptureSource);
  await inbox.scan();
  expect(requests).toHaveLength(1);
  expect((await store.readTaskDb()).tasks).toHaveLength(0);
  expect((await inbox.list())[0].undone).toBe(true);
});

it("settles a request once when two inbox instances share the same execution store", async () => {
  await capture(deviceA, "明天检查虚构同一纸盒");
  answers.push(answer("create_task", { title: "虚构同一纸盒", date: "明天" }));
  const other = new PhoneInbox(options(), new LifeOpsEventBus(), deviceCaptureSource);
  try { await Promise.all([inbox.scan(), other.scan()]); }
  finally { other.stop(); }
  expect(requests).toHaveLength(1);
  expect((await store.readTaskDb()).tasks).toHaveLength(1);
  expect(await inbox.list()).toHaveLength(1);
});

it("stops before a fact write if the local execution host changes during the model request", async () => {
  const source = await capture(deviceA, "明天检查虚构橙纸");
  answers.push(answer("create_task", { title: "虚构橙纸", date: "明天" }));
  beforeModel = async () => { enabled = false; };
  await expect(inbox.scan()).rejects.toThrow("已停止");
  expect((await store.readTaskDb()).tasks).toHaveLength(0);
  expect(await store.readPath(source.path)).toBe(source.raw);
});

it("honors a per-device source exclusion and processes it only after the exclusion is removed", async () => {
  const a = await capture(deviceA, "明天检查虚构可读纸");
  const b = await capture(deviceB, "明天检查虚构隐藏纸");
  store.settings.privacy!.excludedVaultPrefixes = [b.path.slice(0, b.path.lastIndexOf("/"))];
  answers.push(answer("create_task", { title: "虚构可读纸", date: "明天" }));
  await inbox.scan();
  expect((await store.readTaskDb()).tasks.map(task => task.title)).toEqual(["虚构可读纸"]);
  expect(await store.readPath(a.path)).toBe(a.raw);
  expect(requests).toHaveLength(1);
  store.settings.privacy!.excludedVaultPrefixes = [];
  answers.push(answer("create_task", { title: "虚构隐藏纸", date: "明天" }));
  await inbox.scan();
  expect((await store.readTaskDb()).tasks).toHaveLength(2);
  expect(requests).toHaveLength(2);
});

it("keeps a configured credential in the fictional input out of the model request", async () => {
  store.settings.ai.apiKey = "fictional-device-key-not-real";
  const source = await capture(deviceA, "虚构文本里带 fictional-device-key-not-real 需要核对");
  await inbox.scan();
  expect(requests).toHaveLength(0);
  expect((await inbox.list())[0]).toMatchObject({ status: "review", message: expect.stringContaining("疑似含密钥") });
  expect((await store.readTaskDb()).tasks).toHaveLength(0);
  expect(await store.readPath(source.path)).toBe(source.raw);
});

it("does not reattribute a lost receipt to an edited original request with the same identity", async () => {
  const source = await capture(deviceA, "明天检查虚构原始纸");
  answers.push(answer("create_task", { title: "虚构原始纸", date: "明天" }));
  await inbox.scan();
  const receipt = store.path(store.settings.folders.aiReports, "System", "device-inbox.json");
  await store.app.vault.delete(store.getFile(receipt)!);
  const changed = createDeviceCapture(deviceA, "明天检查另一份纸", capturedAt, "Asia/Shanghai", source.row.requestId);
  await store.app.vault.modify(store.getFile(source.path)!, serializeDeviceCapture(changed));
  inbox.stop(); inbox = new PhoneInbox(options(), new LifeOpsEventBus(), deviceCaptureSource);
  await inbox.scan();
  expect(requests).toHaveLength(1);
  expect((await store.readTaskDb()).tasks.map(task => task.title)).toEqual(["虚构原始纸"]);
  const [shown] = await inbox.list();
  expect(shown).toMatchObject({ status: "review", message: expect.stringContaining("签收版本无法核对") });
  await inbox.resolve(shown.id, "undo");
  expect((await store.readTaskDb()).tasks).toHaveLength(0);
});

it("keeps the durable source seal when an old operation has left the rolling ledger", async () => {
  const source = await capture(deviceA, "明天检查虚构久远纸");
  answers.push(answer("create_task", { title: "虚构久远纸", date: "明天" }));
  await inbox.scan();
  const receipt = store.path(store.settings.folders.aiReports, "System", "device-inbox.json");
  await store.app.vault.delete(store.getFile(receipt)!);
  const { OperationLedger } = await import("../src/dataFoundation/operationLedger");
  const ledger = new OperationLedger(store);
  const document = await store.readJson<OperationLedgerDocument>(ledger.filePath, { version: 1, records: [] });
  document.records = document.records.filter(row => row.operationId !== deviceCaptureOperationId(source.row));
  await store.writeJson(ledger.filePath, document);
  inbox.stop(); inbox = new PhoneInbox(options(), new LifeOpsEventBus(), deviceCaptureSource);
  await inbox.scan();
  expect(requests).toHaveLength(1);
  expect((await store.readTaskDb()).tasks).toHaveLength(1);
  expect((await inbox.list())[0]).toMatchObject({ status: "review", message: expect.stringContaining("原请求已签收") });
});

it("refuses automatic device processing when no durable source binder is installed", async () => {
  await capture(deviceA, "明天检查虚构未签收纸");
  inbox.stop(); const settings = options();
  const withoutBinder = { ...settings, bindSource: undefined };
  inbox = new PhoneInbox(withoutBinder, new LifeOpsEventBus(), deviceCaptureSource);
  await inbox.scan();
  expect(requests).toHaveLength(0);
  expect((await store.readTaskDb()).tasks).toHaveLength(0);
  expect((await inbox.list())[0].message).toContain("签收尚未启用");
});
