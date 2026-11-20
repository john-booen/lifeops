import { describe, expect, it } from "vitest";
import { DeviceExecution, parseDeviceWorkspace, type DeviceWorkspace, type LocalDeviceState } from "../src/features/devices/execution";

function local() {
  let state: LocalDeviceState | null = null;
  return { load: () => state, save: (value: LocalDeviceState) => { state = structuredClone(value); } };
}
function pair() {
  let workspace: DeviceWorkspace | null = null;
  const first = local(), second = local();
  const a = new DeviceExecution(first, async () => workspace), b = new DeviceExecution(second, async () => workspace);
  const save = async (policy: DeviceWorkspace) => { workspace = structuredClone(policy); };
  return { a, b, first, second, save, workspace: () => workspace, replace: (value: DeviceWorkspace | null) => { workspace = value; } };
}
describe("one fixed execution device with local-only roles", () => {
  it("gives a new device a distinct identity and waits for explicit setup", async () => {
    const { a, b } = pair();
    expect(a.deviceId).not.toBe(b.deviceId);
    expect(a.needsSetup).toBe(true);
    expect(a.canWriteFacts).toBe(false);
    expect(a.mayCapture).toBe(false);
    await expect(a.assertWriteAllowed()).rejects.toThrow("执行端");
  });
  it("lets the selected executor write and a companion capture without taking ownership", async () => {
    const { a, b, save } = pair();
    await a.useWriterMode(save);
    await b.useCaptureMode();
    expect(a.canWriteFacts).toBe(true);
    expect(b.canWriteFacts).toBe(false);
    expect(b.mayCapture).toBe(true);
    await a.assertWriteAllowed();
    await expect(b.assertWriteAllowed()).rejects.toThrow("执行端");
    await expect(b.useWriterMode(save)).rejects.toThrow("已有执行端");
  });
  it("persists each device role locally across restarts without copying it through the shared policy", async () => {
    const { a, b, save, first, second, workspace } = pair();
    await a.useWriterMode(save); await b.useCaptureMode();
    const restartedA = new DeviceExecution(first, async () => workspace());
    const restartedB = new DeviceExecution(second, async () => workspace());
    await restartedA.refresh(); await restartedB.refresh();
    expect(restartedA.deviceId).toBe(a.deviceId);
    expect(restartedA.canWriteFacts).toBe(true);
    expect(restartedB.canWriteFacts).toBe(false);
    expect(Object.keys(workspace()!)).toEqual(["version", "workspaceId", "executionDeviceId"]);
  });
  it("stops writing when the workspace record temporarily disappears instead of becoming a new writer", async () => {
    const { a, save, replace } = pair();
    await a.useWriterMode(save); replace(null);
    await expect(a.assertWriteAllowed()).rejects.toThrow("执行端");
    await expect(a.useWriterMode(save)).rejects.toThrow("暂未同步");
    expect(a.canWriteFacts).toBe(false);
  });
  it("checks a changed executor again on every write", async () => {
    const { a, b, save, workspace, replace } = pair();
    await a.useWriterMode(save);
    replace({ ...workspace()!, executionDeviceId: b.deviceId });
    await expect(a.assertWriteAllowed()).rejects.toThrow("执行端");
    expect(a.canWriteFacts).toBe(false);
  });
  it("never regains write ownership from an old shared file after choosing capture mode", async () => {
    const { a, save, workspace, replace } = pair();
    await a.useWriterMode(save); const old = structuredClone(workspace()!);
    await a.useCaptureMode(); replace(old);
    await expect(a.assertWriteAllowed()).rejects.toThrow("执行端");
    expect(a.role).toBe("capture");
  });
  it("allows the first-party setup operation only for its exact temporary identity", async () => {
    const { a, replace } = pair();
    await a.useWriterMode(async (policy, operationId, current) => {
      current();
      await a.assertWriteAllowed({ operationId });
      await expect(a.assertWriteAllowed({ operationId: operationId + "-other" })).rejects.toThrow("执行端");
      replace(policy);
      await a.assertWriteAllowed({ operationId });
    });
    expect(a.canWriteFacts).toBe(true);
  });
  it("does not grant ownership when the shared file changes during first-time setup", async () => {
    const { a, b, replace } = pair();
    await expect(a.useWriterMode(async policy => { replace({ ...policy, executionDeviceId: b.deviceId }); }))
      .rejects.toThrow("执行端");
    expect(a.role).toBe("setup");
    expect(a.canWriteFacts).toBe(false);
  });
  it("blocks a different workspace and malformed policy without erasing local state", async () => {
    const { a, save, replace, workspace } = pair();
    await a.useWriterMode(save);
    replace({ ...workspace()!, workspaceId: "89c10643-2a09-4f6e-905b-519f0b3fe547" });
    await expect(a.refresh()).rejects.toThrow("需要核对");
    expect(a.canWriteFacts).toBe(false);
    expect(() => parseDeviceWorkspace({ ...workspace(), role: "writer" })).toThrow("需要核对");
  });
  it("keeps a failed or stopped setup from enabling facts", async () => {
    const { a } = pair();
    await expect(a.useWriterMode(async () => { throw Error("fictional disk failure"); })).rejects.toThrow("disk failure");
    expect(a.role).toBe("setup");
    await expect(a.useWriterMode(async () => { a.stop(); })).rejects.toThrow("已停止");
    expect(a.canWriteFacts).toBe(false);
  });
});
it.each(["writer", "capture"] as const)("does not let a simultaneous %s selection replace an in-flight initial setup", async second => {
 const { a, save } = pair(); let release!: () => void, calls = 0;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const writer = async (policy: DeviceWorkspace) => { calls++; await gate; await save(policy); };
 const first = a.useWriterMode(writer);
 const other = second === "writer" ? a.useWriterMode(writer) : a.useCaptureMode();
 const refused = expect(other).rejects.toThrow("正在保存");
 await refused; release(); await first;
 expect(calls).toBe(1); expect(a.role).toBe("writer"); expect(a.canWriteFacts).toBe(true);
});
it("does not grant executor rights when the device-role setting cannot be persisted", async () => {
  let state: LocalDeviceState | null = null, workspace: DeviceWorkspace | null = null;
  const storage = { load: () => state, save: (value: LocalDeviceState) => {
    if (value.role === "writer") throw Error("fictional full local storage");
    state = structuredClone(value);
  } };
  const device = new DeviceExecution(storage, async () => workspace);
  await expect(device.useWriterMode(async value => { workspace = value; })).rejects.toThrow("local storage");
  expect(device.canWriteFacts).toBe(false); expect(device.role).toBe("setup");
});
