import { randomUUID } from "node:crypto";
import { DeviceWorkspaceConflictError } from "./syncConflict";

export const DEVICE_WORKSPACE_PATH = "输入/设备协作.json";
export const DEVICE_SETUP_OPERATION = "scheduled_configure_device_execution";
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u;
export interface DeviceWorkspace { version: 1; workspaceId: string; executionDeviceId: string }
export interface LocalDeviceState {
  version: 1;
  deviceId: string;
  role: "setup" | "writer" | "capture";
  workspaceId?: string;
}
export interface LocalDeviceStorage { load(): unknown; save(value: LocalDeviceState): void }
export type DeviceWriteIdentity = { operationId: string };
export type DeviceWriteTarget = { path: string; kind: "file" | "folder" };
export type DeviceSetupWriter = (policy: DeviceWorkspace, operationId: string,
  current: () => void) => Promise<void>;

function invalid(): never { throw Error("设备设置需要核对，当前没有执行写入。"); }
function localState(value: unknown): LocalDeviceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as LocalDeviceState;
  if (row.version !== 1 || !UUID.test(row.deviceId ?? "") || !["setup", "writer", "capture"].includes(row.role)
    || row.workspaceId !== undefined && !UUID.test(row.workspaceId)
    || row.role === "writer" && !row.workspaceId
    || Object.keys(row).some(key => !["version", "deviceId", "role", "workspaceId"].includes(key))) invalid();
  return { ...row };
}
export function parseDeviceWorkspace(value: unknown): DeviceWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as DeviceWorkspace;
  if (Object.keys(row).length !== 3 || row.version !== 1 || !UUID.test(row.workspaceId ?? "")
    || !UUID.test(row.executionDeviceId ?? "")) invalid();
  return Object.freeze({ ...row });
}

/** Device role and identity stay outside the synced vault. The shared file names only its fixed executor. */
export class DeviceExecution {
  private local: LocalDeviceState;
  private workspace: DeviceWorkspace | null = null;
  private ready = false;
  private configuring?: { operationId: string; policy: DeviceWorkspace };
  private stopped = false;
  private conflictMessage = "";
  constructor(private readonly storage: LocalDeviceStorage, private readonly readWorkspace: () => Promise<unknown | null>,
    private readonly configurationPaths: () => readonly string[] = () => [DEVICE_WORKSPACE_PATH]) {
    const saved = storage.load();
    this.local = saved === null || saved === undefined
      ? { version: 1, deviceId: randomUUID(), role: "setup" } : localState(saved);
    if (saved === null || saved === undefined) storage.save(this.local);
  }
  get deviceId(): string { return this.local.deviceId; }
  get role(): LocalDeviceState["role"] { return this.local.role; }
  get needsSetup(): boolean { return this.local.role === "setup"; }
  get mayCapture(): boolean { return !this.stopped && this.local.role !== "setup"; }
  get hasExecutor(): boolean { return this.ready && this.workspace !== null; }
  get problemMessage(): string { return this.conflictMessage; }
  get canWriteFacts(): boolean {
    return !this.stopped && this.ready && this.local.role === "writer"
      && this.workspace?.executionDeviceId === this.local.deviceId
      && this.workspace.workspaceId === this.local.workspaceId;
  }
  assertActive(): void { if (this.stopped) throw Error("设备会话已停止。"); }
  stop(): void { this.stopped = true; this.ready = false; }
  async refresh(): Promise<void> {
    if (this.stopped) throw Error("设备会话已停止。");
    let value: unknown;
    try { value = await this.readWorkspace(); }
    catch (error) {
      this.ready = false;
      if (error instanceof DeviceWorkspaceConflictError) { this.conflictMessage = error.message; return; }
      throw error;
    }
    if (this.stopped) throw Error("设备会话已停止。");
    let next: DeviceWorkspace | null;
    try {
      next = value === null ? null : parseDeviceWorkspace(value);
      if (this.local.workspaceId && next && this.local.workspaceId !== next.workspaceId) invalid();
    } catch (error) { this.ready = false; throw error; }
    this.workspace = next; this.ready = true; this.conflictMessage = "";
  }
  async assertWriteAllowed(identity?: DeviceWriteIdentity, target?: DeviceWriteTarget): Promise<void> {
    await this.refresh();
    if (this.conflictMessage) throw Error(this.conflictMessage);
    const setup = this.configuring;
    const configurationTarget = target && this.configurationPaths().some(path => target.kind === "file"
      ? target.path === path : path.startsWith(target.path + "/"));
    if (setup && (identity?.operationId === setup.operationId || !identity && configurationTarget)
      && (this.workspace === null || this.workspace.workspaceId === setup.policy.workspaceId
        && this.workspace.executionDeviceId === setup.policy.executionDeviceId)) return;
    if (!this.canWriteFacts) throw Error("这台设备负责记录和同步，保存由执行端处理。");
  }
  async useCaptureMode(): Promise<void> {
    if (this.configuring) throw Error("设备设置正在保存，请稍候。");
    await this.refresh();
    if (this.configuring) throw Error("设备设置正在保存，请稍候。");
    const next = { ...this.local, role: "capture" as const, ...(this.workspace ? { workspaceId: this.workspace.workspaceId } : {}) };
    this.storage.save(next); this.local = next;
  }
  async useWriterMode(save: DeviceSetupWriter): Promise<void> {
    if (this.configuring) throw Error("设备设置正在保存，请稍候。");
    await this.refresh();
    if (this.conflictMessage) throw Error(this.conflictMessage);
    if (this.configuring) throw Error("设备设置正在保存，请稍候。");
    if (this.workspace && this.workspace.executionDeviceId !== this.local.deviceId) {
      throw Error("此库已有执行端。这台设备可以记录和同步，不能同时接管保存。");
    }
    if (!this.workspace && this.local.workspaceId) {
      throw Error("设备协作记录暂未同步到本机，请等同步完成后再继续。");
    }
    const policy = this.workspace ?? { version: 1 as const, workspaceId: randomUUID(), executionDeviceId: this.local.deviceId };
    if (!this.workspace) {
      const operationId = "local:configure-device:" + randomUUID();
      this.configuring = { operationId, policy };
      try {
        await save(policy, operationId, () => {
          if (this.stopped || this.configuring?.operationId !== operationId) throw Error("设备设置已停止。");
        });
        await this.assertWriteAllowed({ operationId });
        if (!this.workspace) throw Error("设备协作记录未读回。");
      } finally { this.configuring = undefined; }
    }
    const next = { ...this.local, role: "writer" as const, workspaceId: policy.workspaceId };
    this.storage.save(next); this.local = next;
  }
}
