import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/defaults";
import { addDays, formatDate } from "../../src/date";
import type { AiChatResult } from "../../src/ai";
import type { AgentLoopHost, AgentTurnInput } from "../../src/agent/AgentLoop";
import type { StoreHost } from "../../src/store/settingsSlice";
import type { LocalDeviceState } from "../../src/features/devices/execution";

vi.mock("obsidian", () => ({ App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
  WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, Setting: class {},
  Platform: { isDesktopApp: true }, setIcon: vi.fn(),
  normalizePath: (s: string) => s.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  requestUrl: vi.fn(), parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { createFsApp } = await import("../helpers/fsApp");
const { DeviceCoordinator } = await import("../../src/features/devices/coordinator");
const { AgentRuntime } = await import("../../src/agentRuntime");
const { AgentLoop } = await import("../../src/agent/AgentLoop");
const { PhoneInbox } = await import("../../src/features/phoneInbox/service");
const { bindDeviceCaptureSource } = await import("../../src/features/phoneInbox/deviceBinding");
const { deviceCaptureSource } = await import("../../src/features/phoneInbox/source");
const { LifeOpsEventBus } = await import("../../src/lifeOpsEventBus");
const { runConfirmedToolAction } = await import("../../src/toolRegistry");
// @ts-expect-error The explicit JavaScript runner creates only fresh, marked temporary fixtures.
const { createTransportFixture } = await import("../../scripts/eval/sync-transport-runner.mjs");

it("syncs actual device inputs, committed tasks, receipts and targeted undo over a real loopback transport", async () => {
  const binary = process.env.LIFEOPS_SYNCTHING_BINARY;
  if (!binary) throw Error("Explicitly provide a previously verified LIFEOPS_SYNCTHING_BINARY; no binary is downloaded automatically.");
  const transport = await createTransportFixture(binary);
  const inboxes: InstanceType<typeof PhoneInbox>[] = [];
  let inbox: InstanceType<typeof PhoneInbox> | undefined;
  const now = new Date(), recordedDate = formatDate(now), processedAt = new Date(addDays(recordedDate, 2) + "T12:00:00");
  const makeDevice = async (peer: { vault: string }) => {
    const settings = structuredClone(DEFAULT_SETTINGS), app = createFsApp(peer.vault);
    settings.ai = { ...settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", apiKey: "fictional-local-only", model: "synthetic", dataDisclosureAccepted: true };
    settings.privacy = { excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
    settings.proactive.enabled = false;
    let local: LocalDeviceState | null = null;
    const devices = new DeviceCoordinator(app, () => settings, {
      load: () => local, save: value => { local = structuredClone(value); }
    });
    await devices.execution.refresh();
    const store = devices.createStore() as unknown as StoreHost;
    const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    return { settings, store, runtime, devices };
  };
  try {
    const a = await transport.prepare("executor"), b = await transport.prepare("companion");
    await transport.start(a); await transport.start(b);
    await transport.configure(a, b); await transport.configure(b, a);
    const owner = await makeDevice(a);
    await owner.devices.chooseWriter(owner.runtime); await owner.store.initializeVault();
    await transport.transferred(a, b, "输入/设备协作.json");
    await transport.transferred(a, b, owner.store.taskDbPath());
    await transport.transferred(a, b, owner.store.taskMirrorPath());
    const companion = await makeDevice(b); await companion.devices.execution.useCaptureMode();
    expect(companion.devices.execution.deviceId).not.toBe(owner.devices.execution.deviceId);
    await expect(companion.store.createTask({ title: "虚构禁止直接改事实" })).rejects.toThrow("执行端");
    await expect(companion.devices.chooseWriter(companion.runtime)).rejects.toThrow("已有执行端");
    const first = await companion.devices.queueCapture("明天核对虚构蓝纸", now, "Asia/Shanghai");
    const raw = await readFile(join(b.vault, first), "utf8");
    await transport.transferred(b, a, first);
    let modelCalls = 0;
    const titles = ["核对虚构蓝纸", "核对虚构离线纸盒"];
    const host: AgentLoopHost = {
      settings: owner.settings, store: owner.store,
      aiForRole: () => ({ agentTurnStream: async () => {
        const title = titles[modelCalls++]; if (!title) throw Error("Unexpected replay reached the synthetic model");
        return { content: "", toolCalls: [{ id: "fictional-sync", name: "create_task", arguments: { title, date: "明天" } }] } as AiChatResult;
      } }),
      executeTools: async (calls, message, signal, onResult) => {
        const results = [];
        for (const call of calls) {
          const result = await owner.runtime.executeAiToolCall(call, "kimi", message, { assertCurrent: () => signal?.throwIfAborted() });
          onResult(call, result); results.push(result);
        }
        return results;
      }, offlineFallback: async () => null
    };
    const options = {
      store: () => owner.store, enabled: () => true, canProcess: () => owner.devices.execution.canWriteFacts,
      bindSource: (line: import("../../src/features/phoneInbox/model").PhoneInboxLine,
        guards: import("../../src/features/phoneInbox/deviceBinding").DeviceSourceGuards) => bindDeviceCaptureSource({ store: owner.store,
        saveLocalOperation: async (name, args, execute, control) => {
          const result = await owner.runtime.executeLocalOperation(name, args, execute, undefined, control);
          if (!result.success) throw Error(result.output);
        } }, line, guards),
      submit: async (message: string, phoneInbox: NonNullable<AgentTurnInput["phoneInbox"]>, signal: AbortSignal) => {
        const result = await new AgentLoop(host).run({ message, history: [], source: "system", now: processedAt, phoneInbox, signal });
        return { reply: result.text, receipts: result.receipts, actions: result.confirmations, toolCalls: result.toolCalls };
      }, confirm: async (action: Parameters<typeof runConfirmedToolAction>[0], turn: NonNullable<AgentTurnInput["phoneInbox"]>) => {
        await runConfirmedToolAction(action, { store: owner.store, refreshViews: async () => {}, assertCurrent: turn.assertCurrent }, turn.assertLineCurrent);
      }, undo: (id: string) => owner.runtime.undoOperation(id), notify: () => {}
    };
    inbox = new PhoneInbox(options, new LifeOpsEventBus(), deviceCaptureSource); inboxes.push(inbox);
    await inbox.scan(); await inbox.scan();
    expect(modelCalls).toBe(1);
    expect((await owner.store.readTaskDb()).tasks).toMatchObject([{ title: titles[0], date: addDays(recordedDate, 1) }]);
    const receiptPath = owner.store.path(owner.settings.folders.aiReports, "System", "device-inbox.json");
    await transport.transferred(a, b, owner.store.taskDbPath());
    await transport.transferred(a, b, owner.store.taskMirrorPath());
    await transport.transferred(a, b, receiptPath);
    expect((await companion.store.readTaskDb({ readOnly: true })).tasks).toHaveLength(1);
    const viewer = new PhoneInbox({ ...options, store: () => companion.store, canProcess: () => false }, new LifeOpsEventBus(), deviceCaptureSource);
    inboxes.push(viewer);
    const snapshot = await viewer.snapshot(); expect(snapshot.resolve).toBeUndefined(); expect(snapshot.receipts[0].status).toBe("saved");
    await writeFile(join(b.vault, first), raw); await transport.transferred(b, a, first); await inbox.scan(); expect(modelCalls).toBe(1);
    await owner.runtime.executeAiToolCall({ id: "fictional-unrelated-sync", name: "create_task", arguments: { title: "虚构保留的独立任务" } }, "kimi");
    await inbox.resolve((await inbox.list())[0].id, "undo");
    await transport.transferred(a, b, owner.store.taskDbPath()); await transport.transferred(a, b, owner.store.taskMirrorPath());
    expect((await companion.store.readTaskDb({ readOnly: true })).tasks.map(t => t.title)).toEqual(["虚构保留的独立任务"]);
    expect(await readFile(join(a.vault, first), "utf8")).toBe(raw);
    await transport.stop(b);
    const offline = await companion.devices.queueCapture("明天核对虚构离线纸盒", now, "Asia/Shanghai");
    expect(await transport.bytes(a, offline)).toBeNull();
    await transport.start(b); await transport.transferred(b, a, offline);
    inbox.stop(); inbox = new PhoneInbox(options, new LifeOpsEventBus(), deviceCaptureSource); inboxes.push(inbox);
    await inbox.scan(); await inbox.scan(); expect(modelCalls).toBe(2);
    expect((await owner.store.readTaskDb()).tasks.find(t => t.title === titles[1])?.date).toBe(addDays(recordedDate, 1));
    expect((await inbox.list()).find(r => r.sourcePath === first)?.undone).toBe(true);
    transport.result.checks.productionDeviceRoles = true;
    transport.result.checks.productionTaskReceiptAndReplay = true;
    transport.result.checks.targetedUndoPreservesOtherTasks = true;
    transport.result.checks.offlineInputKeepsRecordedDate = true;
    transport.result.passed = true;
  } catch (error) { transport.result.error = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    inboxes.forEach(inbox => inbox.stop());
    await transport.finish();
    process.stdout.write(JSON.stringify({ root: transport.root, passed: transport.result.passed, checks: transport.result.checks, exits: transport.result.exits }) + "\n");
  }
});
