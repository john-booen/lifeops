import type { App } from "obsidian";

const folder = "输入";
const prefix = "输入/设备协作.sync-conflict-";

export class DeviceWorkspaceConflictError extends Error {
  constructor() {
    super("设备协作出现同步冲突，处理与提醒已暂缓。请先备份并核对「输入」中的设备协作文件；原始随手记仍可保存。");
  }
}

/** Syncthing retains competing files under this name. Neither copy elects an executor. */
export function isDeviceWorkspaceConflict(path: string): boolean {
  return path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && path.endsWith(".json");
}

export async function assertDeviceWorkspaceUncontested(app: App): Promise<void> {
  if (!await app.vault.adapter.exists(folder)) return;
  const listing = await app.vault.adapter.list(folder);
  if (listing.files.some(isDeviceWorkspaceConflict)) {
    throw new DeviceWorkspaceConflictError();
  }
}
