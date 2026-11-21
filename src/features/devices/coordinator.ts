import { recoverInitialDeviceSetup } from "./setupRecovery";
import { randomUUID } from "node:crypto";
import type { App, EventRef, TAbstractFile } from "obsidian";
import { AgentRuntime } from "../../agentRuntime";
import { configuredCredentials } from "../../credentialSecurity";
import { readBoundedVaultFile } from "../../legacyMemoryReview";
import { isVaultPathExcluded } from "../../privacy";
import { LifeOpsStore } from "../../store";
import type { StoreHost } from "../../store/settingsSlice";
import type { LifeOpsSettings } from "../../types";
import { createDeviceCapture, deviceCapturePath, serializeDeviceCapture } from "../phoneInbox/deviceCapture";
import { DEVICE_SETUP_OPERATION, DEVICE_WORKSPACE_PATH, DeviceExecution, type LocalDeviceStorage } from "./execution";
import { localDeviceStorage } from "./localStorage";
import { deviceLayout, parseDeviceWorkspaceFile, type DeviceWorkspaceFile } from "./workspace";
import { assertDeviceWorkspaceUncontested, isDeviceWorkspaceConflict } from "./syncConflict";

export class DeviceCoordinator {
  readonly execution: DeviceExecution;
  private wire: DeviceWorkspaceFile | null = null;
  private captureQueue: Promise<unknown> = Promise.resolve();
  private watching = false;
  constructor(private readonly app: App, private readonly settings: () => LifeOpsSettings,
    storage: LocalDeviceStorage = localDeviceStorage(app)) {
    this.execution = new DeviceExecution(storage, async () => {
      if (isVaultPathExcluded(DEVICE_WORKSPACE_PATH, this.settings().privacy?.excludedVaultPrefixes)) {
        throw Error("设备协作目录不允许读取，处理已暂缓。");
      }
      const reader = new LifeOpsStore(app, this.settings()) as unknown as StoreHost;
      const result = await readBoundedVaultFile(reader, DEVICE_WORKSPACE_PATH, 16_000);
      if ("unavailable" in result) throw Error("设备协作记录尚未完整同步，请稍后重试。");
      await assertDeviceWorkspaceUncontested(app);
      this.wire = result.raw === null ? null : parseDeviceWorkspaceFile(JSON.parse(result.raw));
      if (this.wire && this.execution.role !== "writer") this.settings().folders = { ...this.wire.layout.folders };
      return this.wire && { version: 1, workspaceId: this.wire.workspaceId, executionDeviceId: this.wire.executionDeviceId };
    }, () => {
      const root = this.settings().folders.aiReports;
      return [DEVICE_WORKSPACE_PATH, root + "/Operations/operation-ledger.json", root + "/Operations/write-recovery.json"];
    });
  }
  watch(registerEvent: (event: EventRef) => void, register: (cleanup: () => void) => void, refresh: () => Promise<void>): void {
    if (this.watching) return;
    this.watching = true;
    let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
    const changed = (file: Pick<TAbstractFile, "path">) => {
      if (stopped || file.path.split("/").some(part => part.startsWith("."))) return;
      if (this.execution.canWriteFacts && file.path !== DEVICE_WORKSPACE_PATH && !isDeviceWorkspaceConflict(file.path)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void this.execution.refresh().catch(() => undefined).then(() => stopped ? undefined : refresh()).catch(() => undefined);
      }, 350);
    };
    registerEvent(this.app.vault.on("create", changed));
    registerEvent(this.app.vault.on("modify", changed));
    registerEvent(this.app.vault.on("delete", changed));
    registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      changed(file);
      if (oldPath === DEVICE_WORKSPACE_PATH || isDeviceWorkspaceConflict(oldPath)) changed({ path: oldPath });
    }));
    register(() => { stopped = true; clearTimeout(timer); this.watching = false; });
  }
  createStore(): LifeOpsStore {
    return new LifeOpsStore(this.app, this.settings(), {
      canWriteFacts: () => this.execution.canWriteFacts,
      assertWriteAllowed: (identity, target) => this.execution.assertWriteAllowed(identity, target)
    });
  }
  async chooseWriter(runtime: AgentRuntime): Promise<void> {
    const settings = this.settings();
    await recoverInitialDeviceSetup(this.app, settings, this.execution.deviceId, () => {
      this.execution.assertActive();
      if (this.settings() !== settings) throw Error("设备设置已经变化，请重新打开。");
    });
    await this.execution.useWriterMode(async (policy, operationId, current) => {
      const wire = { ...policy, layout: deviceLayout(this.settings()) };
      const result = await runtime.executeLocalOperation(DEVICE_SETUP_OPERATION, { workspaceId: policy.workspaceId, executionDeviceId: policy.executionDeviceId },
        scope => scope.writeJson(DEVICE_WORKSPACE_PATH, wire), operationId, { assertCurrent: current });
      if (!result.success) throw Error(result.output);
    });
  }
  async publishLayout(runtime: AgentRuntime): Promise<void> {
    await this.execution.assertWriteAllowed();
    if (!this.wire) throw Error("设备共享记录尚未就绪。");
    const wire = { ...this.wire, layout: deviceLayout(this.settings()) };
    if (JSON.stringify(wire) === JSON.stringify(this.wire)) return;
    const result = await runtime.executeLocalOperation(DEVICE_SETUP_OPERATION, { workspaceId: wire.workspaceId },
      scope => scope.writeJson(DEVICE_WORKSPACE_PATH, wire), "local:configure-device:" + randomUUID());
    if (!result.success) throw Error(result.output);
    await this.execution.refresh();
  }
  /** Each device owns its input and its input journal; it never touches the executor's fact databases. */
  queueCapture(text: string, now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Promise<string> {
    const run = this.captureQueue.catch(() => undefined).then(() => this.saveCapture(text, now, timeZone));
    this.captureQueue = run;
    return run;
  }
  private async saveCapture(text: string, now: Date, timeZone: string): Promise<string> {
    if (!this.execution.mayCapture) throw Error("请先选择这台设备的用途。");
    if (configuredCredentials(this.settings()).some(secret => text.includes(secret))) throw Error("这段内容含有已配置的密钥，请移除后再保存。");
    const row = createDeviceCapture(this.execution.deviceId, text, now, timeZone), path = deviceCapturePath(row);
    const root = `输入/设备随手记/${row.deviceId}/管理`;
    const operationId = `local:device-capture:${row.deviceId}:${row.requestId}`;
    const allowed = (target: string, kind: "file" | "folder") => kind === "file"
      ? target === path || target.startsWith(root + "/")
      : path.startsWith(target + "/") || root === target || root.startsWith(target + "/") || target.startsWith(root + "/");
    const current = () => {
      if (!this.execution.mayCapture || isVaultPathExcluded(path, this.settings().privacy?.excludedVaultPrefixes)
        || isVaultPathExcluded(root, this.settings().privacy?.excludedVaultPrefixes)) throw Error("本机记录已停止，或记录目录不允许读取。");
    };
    current();
    for (const target of [path, root + "/Operations/operation-ledger.json", root + "/Operations/write-recovery.json"]) {
      const result = await readBoundedVaultFile(new LifeOpsStore(this.app, this.settings()) as unknown as StoreHost, target, 16_000);
      if ("unavailable" in result && (target === path || result.unavailable !== "too_large")
        || target === path && "raw" in result && result.raw !== null) throw Error("本机记录目录需要核对，未保存或覆盖原文。");
    }
    const settings = { ...this.settings(), folders: { ...this.settings().folders, aiReports: root } };
    let active = true;
    const store = new LifeOpsStore(this.app, settings, {
      canWriteFacts: () => false,
      assertWriteAllowed: async (identity, target) => {
        current();
        if (!active || identity && identity.operationId !== operationId || target && !allowed(target.path, target.kind)) {
          throw Error("设备随手记只能保存这次原始输入。");
        }
      }
    }) as unknown as StoreHost;
    const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    try {
      const result = await runtime.executeLocalOperation("scheduled_device_input", { requestId: row.requestId, textRevision: row.textRevision },
        async scope => {
          current();
          if (scope.getFile(path)) throw Error("这条设备记录已经存在，未覆盖原文。");
          await scope.writeFile(path, serializeDeviceCapture(row));
        }, operationId, { assertCurrent: current });
      if (!result.success) throw Error(result.output);
      return path;
    } finally { active = false; }
  }
}
