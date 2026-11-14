import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { isVaultPathExcluded } from "../../privacy";
import type { StoreHost } from "../../store/settingsSlice";

export async function assertSelectedFileAllowed(store: StoreHost, file: File, fromClipboard: boolean): Promise<void> {
  let selected = (file as File & { path?: string }).path;
  if (!selected) {
    try {
      const electron = require("electron") as { webUtils?: { getPathForFile(file: File): string } };
      selected = electron.webUtils?.getPathForFile(file);
    } catch { /* Older Electron exposes File.path instead. */ }
  }
  if (!selected && fromClipboard) return;
  const vault = (store.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
  if (!selected || !isAbsolute(selected) || !vault || !isAbsolute(vault)) throw Error("无法核对这张图片的位置，请重新从文件选择器选取。");
  const [root, target] = await Promise.all([realpath(vault), realpath(selected)])
    .catch(() => { throw Error("无法读取所选图片，请重新选择。"); });
  for (const path of [relative(vault, selected), relative(root, target)]) {
    if (path && path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path)
      && isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)) {
      throw Error("这张图片在禁止发送的目录内。");
    }
  }
}

