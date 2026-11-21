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
  Platform: { isDesktopApp: true }, setIcon: vi.fn(), requestUrl: vi.fn(),
  normalizePath: (s: string) => s.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { createFsApp } = await import("../helpers/fsApp");
const { DeviceCoordinator } = await import("../../src/features/devices/coordinator");
const { AgentRuntime } = await import("../../src/agentRuntime");
const { AgentLoop } = await import("../../src/agent/AgentLoop");
const { PhoneInbox } = await import("../../src/features/phoneInbox/service");
const { bindDeviceCaptureSource } = await import("../../src/features/phoneInbox/deviceBinding");
const { deviceCaptureSource } = await import("../../src/features/phoneInbox/source");
const { LifeOpsEventBus } = await import("../../src/lifeOpsEventBus");
// @ts-expect-error The JavaScript runner accepts only a binary and creates fresh fictional vaults.
const { createTransportFixture } = await import("../../scripts/eval/sync-transport-runner.mjs");

it("transfers a whole five-task input, complete receipt, replay, undo and delayed batch over actual Syncthing", async () => {
  const binary = process.env.LIFEOPS_SYNCTHING_BINARY;
  if (!binary) throw Error("Provide a previously verified LIFEOPS_SYNCTHING_BINARY; no automatic download or service installation.");
  const transport = await createTransportFixture(binary), inboxes: InstanceType<typeof PhoneInbox>[] = [];
  const now = new Date(), date = formatDate(now), delayedDate = addDays(date, -2);
  const titles = Array.from({ length: 5 }, (_, i) => `虚构同步整批纸样${i}`);
  async function device(peer: { vault: string }) {
    const settings = structuredClone(DEFAULT_SETTINGS), app = createFsApp(peer.vault);
    settings.ai = { ...settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", apiKey: "fictional-key",
      model: "synthetic", dataDisclosureAccepted: true };
    settings.privacy = { excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
    settings.proactive.enabled = false;
    let local: LocalDeviceState | null = null;
    const devices = new DeviceCoordinator(app, () => settings, { load: () => local, save: value => { local = structuredClone(value); } });
    await devices.execution.refresh(); const store = devices.createStore() as unknown as StoreHost;
    return { settings, app, devices, store, runtime: new AgentRuntime({ store, refreshViews: async () => {} }) };
  }
  try {
    const a = await transport.prepare("executor"), b = await transport.prepare("companion");
    await transport.start(a); await transport.start(b); await transport.configure(a, b); await transport.configure(b, a);
    const owner = await device(a); await owner.devices.chooseWriter(owner.runtime); await owner.store.initializeVault();
    await owner.store.createTask({ title: titles[0], date });
    const existing = (await owner.store.readTaskDb()).tasks[0]; await owner.store.completeTask(existing.id);
    const preserved = await owner.store.getTask(existing.id);
    await transport.transferred(a, b, "输入/设备协作.json");
    const companion = await device(b); await companion.devices.execution.useCaptureMode();
    const first = await companion.devices.queueCapture("纯虚构：把五项纸样工作全部安排今天，一次保存。", now, "Asia/Shanghai");
    const raw = await readFile(join(b.vault, first), "utf8"); await transport.transferred(b, a, first);
    let modelCalls = 0;
    const host: AgentLoopHost = { settings: owner.settings, store: owner.store,
      aiForRole: () => ({ agentTurnStream: async () => {
        if (++modelCalls > 2) throw Error("A synchronized replay reached the model again");
        return { content: "模型文本不作为入账回执。", toolCalls: [{ id: "fictional-synced-batch", name: "schedule_task_batch",
          arguments: { date: "今天", tasks: titles.map(title => ({ title, estimateMin: 20 })) } }] } as AiChatResult;
      } }),
      executeTools: async (calls, message, signal, onResult) => {
        const results = [];
        for (const call of calls) { const result = await owner.runtime.executeAiToolCall(call, "kimi", message,
          { assertCurrent: () => signal?.throwIfAborted() }); onResult(call, result); results.push(result); }
        return results;
      }, offlineFallback: async () => null };
    const options = { store: () => owner.store, enabled: () => true, canProcess: () => owner.devices.execution.canWriteFacts,
      bindSource: (line: import("../../src/features/phoneInbox/model").PhoneInboxLine,
        guards: import("../../src/features/phoneInbox/deviceBinding").DeviceSourceGuards) => bindDeviceCaptureSource({ store: owner.store,
        saveLocalOperation: async (name, args, execute, control) => {
          const result = await owner.runtime.executeLocalOperation(name, args, execute, undefined, control);
          if (!result.success) throw Error(result.output);
        } }, line, guards),
      submit: async (message: string, phoneInbox: NonNullable<AgentTurnInput["phoneInbox"]>, signal: AbortSignal) => {
        const result = await new AgentLoop(host).run({ message, history: [], source: "system", now, phoneInbox, signal });
        return { reply: result.text, receipts: result.receipts, actions: result.confirmations, toolCalls: result.toolCalls };
      }, confirm: async () => { throw Error("No confirmation is expected for a new batch"); },
      undo: (id: string) => owner.runtime.undoOperation(id), notify: () => {} };
    const inbox = new PhoneInbox(options, new LifeOpsEventBus(), deviceCaptureSource); inboxes.push(inbox);
    await inbox.scan(); await inbox.scan(); expect(modelCalls).toBe(1);
    const [receipt] = await inbox.list(); expect(receipt).toMatchObject({ status: "saved", taskBatch: { created: 4, existing: 1 } });
    expect(await owner.store.getTask(existing.id)).toEqual(preserved);
    expect((await owner.store.readTaskDb()).tasks).toHaveLength(5);
    const receiptPath = owner.store.path(owner.settings.folders.aiReports, "System", "device-inbox.json");
    const ledgerPath = owner.store.path(owner.settings.folders.aiReports, "Operations", "operation-ledger.json");
    for (const path of [owner.store.taskDbPath(), owner.store.taskMirrorPath(), receiptPath, ledgerPath]) await transport.transferred(a, b, path);
    const viewer = new PhoneInbox({ ...options, store: () => companion.store, canProcess: () => false }, new LifeOpsEventBus(), deviceCaptureSource);
    inboxes.push(viewer); const snapshot = await viewer.snapshot(); expect(snapshot.resolve).toBeUndefined();
    expect(snapshot.receipts[0].taskBatch).toEqual({ created: 4, existing: 1 });
    const detail = await viewer.batchDetails(receipt.id); expect(detail).toContain("实际保存4项"); expect(detail).toContain(titles[4]);
    await writeFile(join(b.vault, first), raw); await transport.transferred(b, a, first); await inbox.scan(); expect(modelCalls).toBe(1);
    await inbox.resolve(receipt.id, "undo");
    for (const path of [owner.store.taskDbPath(), owner.store.taskMirrorPath(), receiptPath, ledgerPath]) await transport.transferred(a, b, path);
    expect((await companion.store.readTaskDb({ readOnly: true })).tasks).toEqual([preserved]);
    expect((await viewer.snapshot()).receipts[0].undone).toBe(true); expect(await readFile(join(a.vault, first), "utf8")).toBe(raw);
    await transport.stop(b);
    const offline = await companion.devices.queueCapture("纯虚构：今天五项纸样工作全部保存。", new Date(delayedDate + "T10:00:00"), "Asia/Shanghai");
    expect(await transport.bytes(a, offline)).toBeNull(); await transport.start(b); await transport.transferred(b, a, offline);
    await inbox.scan(); await inbox.scan(); expect(modelCalls).toBe(2);
    const delayed = (await owner.store.readTaskDb()).tasks.filter(row => row.date === delayedDate);
    expect(delayed).toHaveLength(5); expect(delayed.every(row => !row.startTime && !row.endTime)).toBe(true);
    expect(await owner.store.getTask(existing.id)).toEqual(preserved);
    transport.result.checks.productionBatchAndExistingTask = true;
    transport.result.checks.completeReceiptReturnedToCompanion = true;
    transport.result.checks.batchReplayNotRedispatched = true;
    transport.result.checks.batchUndoPreservesOriginalCompletedTask = true;
    transport.result.checks.offlineBatchKeepsDateWithoutBackdatedSlots = true;
    transport.result.passed = true;
  } catch (error) { transport.result.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { inboxes.forEach(inbox => inbox.stop()); await transport.finish(); process.stdout.write(JSON.stringify(transport.result) + "\n"); }
});
