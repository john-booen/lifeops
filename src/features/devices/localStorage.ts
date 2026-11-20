import type { App } from "obsidian";
import { fileRevision } from "../../operationIdentity";
import type { LocalDeviceStorage, LocalDeviceState } from "./execution";

const KEY = "lifeops.device.local.v1";
/** App-scoped vault storage is available since 1.8.7; the fallback preserves older supported Obsidian. */
export function localDeviceStorage(app: App): LocalDeviceStorage {
  if (typeof app.loadLocalStorage === "function" && typeof app.saveLocalStorage === "function") {
    return { load: () => app.loadLocalStorage(KEY), save: value => app.saveLocalStorage(KEY, value) };
  }
  const storage = globalThis.localStorage;
  const adapter = app.vault.adapter as { getBasePath?: () => string };
  const vault = adapter.getBasePath?.() ?? app.vault.getName();
  const key = KEY + ":" + fileRevision(vault);
  if (!storage) throw Error("本机设备设置暂时无法保存，请重新打开 Obsidian。");
  return {
    load: () => {
      const raw = storage.getItem(key);
      if (raw === null) return null;
      try { return JSON.parse(raw); } catch { throw Error("本机设备设置需要核对。"); }
    },
    save: (value: LocalDeviceState) => storage.setItem(key, JSON.stringify(value))
  };
}
