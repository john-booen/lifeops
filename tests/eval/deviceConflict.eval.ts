import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/defaults";
import type { StoreHost } from "../../src/store/settingsSlice";
import type { LocalDeviceState } from "../../src/features/devices/execution";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
  normalizePath: (s: string) => s.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  requestUrl: vi.fn(), parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { createFsApp } = await import("../helpers/fsApp");
const { DeviceCoordinator } = await import("../../src/features/devices/coordinator");
const { AgentRuntime } = await import("../../src/agentRuntime");
const { DEVICE_WORKSPACE_PATH } = await import("../../src/features/devices/execution");
const { isDeviceWorkspaceConflict } = await import("../../src/features/devices/syncConflict");
// @ts-expect-error The explicit runner creates fresh temporary fixtures only.
const { createTransportFixture } = await import("../../scripts/eval/sync-transport-runner.mjs");

it("holds both executors when real Syncthing produces a competing workspace policy", async () => {
  const binary = process.env.LIFEOPS_SYNCTHING_BINARY;
  if (!binary) throw Error("Explicitly provide a previously verified LIFEOPS_SYNCTHING_BINARY.");
  const transport = await createTransportFixture(binary);
  const makeDevice = async (peer: { vault: string }) => {
    const app = createFsApp(peer.vault), settings = structuredClone(DEFAULT_SETTINGS);
    settings.proactive.enabled = false;
    let local: LocalDeviceState | null = null;
    const devices = new DeviceCoordinator(app, () => settings, {
      load: () => local, save: state => { local = structuredClone(state); }
    });
    await devices.execution.refresh();
    const store = devices.createStore() as unknown as StoreHost;
    const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    await devices.chooseWriter(runtime); await store.initializeVault();
    return { devices, store, runtime, original: await store.readPath(DEVICE_WORKSPACE_PATH) };
  };
  try {
    const a = await transport.prepare("first"), b = await transport.prepare("second");
    await transport.start(a); await transport.start(b);
    // Both devices initially elect themselves while disconnected. Do not elect a second writer in a real vault.
    const first = await makeDevice(a), second = await makeDevice(b);
    expect(first.original).not.toBe(second.original);
    await transport.configure(a, b, { paused: true }); await transport.configure(b, a, { paused: true });
    for (const peer of [a, b]) {
      await transport.waitFor(async () => {
        const status = await transport.request(peer, "/rest/db/status?folder=lifeops-fictional-transport-v1");
        return status.state === "idle" && status.localFiles > 0;
      }, "offline fixture index");
      const indexed = await transport.request(peer,
        "/rest/db/file?folder=lifeops-fictional-transport-v1&file=" + encodeURIComponent(DEVICE_WORKSPACE_PATH));
      expect(indexed.local?.version?.length).toBeGreaterThan(0);
    }
    await transport.request(a, "/rest/config/devices/" + b.deviceId, "PATCH", { paused: false });
    await transport.request(b, "/rest/config/devices/" + a.deviceId, "PATCH", { paused: false });
    let names: string[] = [];
    await transport.waitFor(async () => {
      names = (await readdir(join(a.vault, "输入"))).map(name => "输入/" + name).filter(isDeviceWorkspaceConflict);
      return names.length > 0;
    }, "real workspace conflict");
    for (const path of names) await transport.transferred(a, b, path);
    await first.devices.execution.refresh(); await second.devices.execution.refresh();
    for (const device of [first, second]) {
      expect(device.devices.execution.canWriteFacts).toBe(false);
      expect(device.devices.execution.problemMessage).toContain("同步冲突");
      await expect(device.store.createTask({ title: "虚构冲突时禁止写入" })).rejects.toThrow("同步冲突");
    }
    for (const peer of [a, b]) {
      const copies = await Promise.all([DEVICE_WORKSPACE_PATH, ...names].map(path => readFile(join(peer.vault, path), "utf8")));
      expect(new Set(copies)).toEqual(new Set([first.original, second.original]));
    }
    const capture = await first.devices.queueCapture("虚构：冲突期间保留这份原始输入");
    await transport.transferred(a, b, capture);
    expect(await readFile(join(b.vault, capture), "utf8")).toContain("保留这份原始输入");
    transport.result.checks.realWorkspaceConflictPreservesBothPolicies = true;
    transport.result.checks.bothExecutorsHeld = true;
    transport.result.checks.rawCaptureStillSyncs = true;
    transport.result.passed = true;
  } catch (error) { transport.result.error = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    await transport.finish();
    process.stdout.write(JSON.stringify({ root: transport.root, passed: transport.result.passed,
      checks: transport.result.checks, exits: transport.result.exits }) + "\n");
  }
});
