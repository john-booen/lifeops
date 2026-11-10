import { createHash } from "node:crypto";
import type { DataAdapter, PluginManifest } from "obsidian";

const loadMessages = {
  program: "无法读取插件程序",
  startup: "插件启动失败",
  settingsPermissions: "无法保护设置文件权限",
  styles: "插件样式加载失败",
  recovery: "资料恢复状态需要检查",
  data: "资料初始化失败",
  dashboard: "面板资料读取失败"
} as const;

export type ReleaseLoadIssue = keyof typeof loadMessages;
const defaultReports = "LifeOps/Output/AI";
function heartbeatFolder(reports: string | undefined): string {
  const allowed = reports && !reports.includes("\\") && reports.split("/").every(part => part.trim() && !part.startsWith("."));
  return (allowed ? reports : defaultReports) + "/System";
}

export function captureReleaseHeartbeat(
  adapter: DataAdapter,
  manifest: PluginManifest,
  isCurrent: () => boolean,
  reports: () => string | undefined = () => undefined
): (issues: readonly ReleaseLoadIssue[]) => Promise<void> {
  if (!manifest?.dir || typeof adapter?.readBinary !== "function") return async () => {};
  const version = manifest.version;
  const program = adapter.readBinary(`${manifest.dir}/main.js`)
    .then((bytes) => createHash("sha256").update(Buffer.from(bytes)).digest("hex"), () => "");
  return async (issues) => {
    try {
      const mainSha256 = await program;
      if (!isCurrent()) return;
      const errors = (mainSha256 ? issues : [...issues, "program" as const])
        .map((type) => ({ type, message: loadMessages[type] }));
      const heartbeat = heartbeatFolder(reports());
      let folder = "";
      for (const part of heartbeat.split("/")) {
        folder = folder ? `${folder}/${part}` : part;
        if (!(await adapter.exists(folder)) && isCurrent()) {
          try { await adapter.mkdir(folder); }
          catch (error) { if (!(await adapter.exists(folder))) throw error; }
        }
      }
      if (isCurrent()) {
        await adapter.write(`${heartbeat}/heartbeat.json`, JSON.stringify({
          version, mainSha256, loadedAt: new Date().toISOString(), ok: errors.length === 0, errors
        }));
      }
    } catch {
      if (isCurrent()) console.error("LifeOps 无法记录插件加载心跳。");
    }
  };
}
