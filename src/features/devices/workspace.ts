import type { FolderSettings, LifeOpsSettings } from "../../types";
import { DEVICE_WORKSPACE_PATH, parseDeviceWorkspace, type DeviceWorkspace } from "./execution";

const FOLDERS = ["dailyRoot", "inbox", "tasks", "habits", "ideas", "tradingModels", "tradingReviews", "health", "aiReports", "goals", "outputs"] as const;
export interface DeviceLayout { folders: FolderSettings }
export interface DeviceWorkspaceFile extends DeviceWorkspace { layout: DeviceLayout }
const invalid = (): never => { throw Error("设备共享目录设置需要核对，当前没有执行写入。"); };
function folder(value: unknown): string {
  if (typeof value !== "string" || value.length > 240 || value.includes("\\")
    || /[\x00-\x1f]/u.test(value) || value.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("."))) invalid();
  return value as string;
}
/** Share the record locations only. Credentials, providers, disclosures and device identity stay local. */
export function deviceLayout(settings: Pick<LifeOpsSettings, "folders">): DeviceLayout {
  return { folders: Object.fromEntries(FOLDERS.map(key => [key, folder(settings.folders[key])])) as unknown as FolderSettings };
}
export function parseDeviceWorkspaceFile(value: unknown): DeviceWorkspaceFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as DeviceWorkspaceFile;
  if (Object.keys(row).length !== 4 || !row.layout || Object.keys(row.layout).join() !== "folders"
    || !row.layout.folders || Object.keys(row.layout.folders).length !== FOLDERS.length
    || Object.keys(row).some(key => !["version", "workspaceId", "executionDeviceId", "layout"].includes(key))) invalid();
  const policy = parseDeviceWorkspace({ version: row.version, workspaceId: row.workspaceId, executionDeviceId: row.executionDeviceId });
  return { ...policy, layout: deviceLayout(row.layout) };
}
export function validDeviceWorkspaceFile(value: unknown): boolean {
  try { parseDeviceWorkspaceFile(value); return true; } catch { return false; }
}
export function isDeviceConfigurationWrite(path: string, operationId: string): boolean {
  return path === DEVICE_WORKSPACE_PATH && /^local:configure-device:[a-f\d-]{36}$/u.test(operationId);
}
export function isDeviceInputWrite(path: string, operationId: string): boolean {
  const match = /^local:device-capture:([a-f\d-]{36}):([a-f\d-]{36})$/u.exec(operationId);
  return Boolean(match && path === `输入/设备随手记/${match[1]}/${match[2]}.json`);
}
