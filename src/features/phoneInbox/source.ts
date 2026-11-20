import { readScopedMarkdown } from "../../dataFoundation/markdownSources";
import { fileRevision } from "../../operationIdentity";
import { isVaultPathExcluded } from "../../privacy";
import type { StoreHost } from "../../store/settingsSlice";
import { deviceCaptureLineId, isDeviceCapturePath, parseDeviceCapture, DEVICE_CAPTURE_ROOT } from "./deviceCapture";
import { DEVICE_INBOX_STATE, PHONE_INBOX_PATH, PHONE_INBOX_STATE, parsePhoneInbox, type PhoneInboxLine } from "./model";

export { DEVICE_INBOX_STATE } from "./model";
export interface PhoneInboxSource {
  readonly entryPath: string;
  readonly stateFile: string;
  readonly requiresBinding?: true;
  matches(path: string): boolean;
  exists(store: StoreHost): boolean;
  allowed(store: StoreHost): boolean;
  read(store: StoreHost, includeUnterminated: boolean, referenceDate: string): Promise<PhoneInboxLine[]>;
  create(store: StoreHost): Promise<void>;
}

export const phoneInboxSource: PhoneInboxSource = Object.freeze({
  entryPath: PHONE_INBOX_PATH, stateFile: PHONE_INBOX_STATE,
  matches: (path: string) => path === PHONE_INBOX_PATH,
  exists: (store: StoreHost) => !!store.getFile(PHONE_INBOX_PATH),
  allowed: (store: StoreHost) => !isVaultPathExcluded(PHONE_INBOX_PATH, store.settings.privacy?.excludedVaultPrefixes),
  read: async (store: StoreHost, include: boolean, date: string) =>
    parsePhoneInbox(await readScopedMarkdown(store, PHONE_INBOX_PATH), date, include),
  create: async (store: StoreHost) => { await store.ensureFile(PHONE_INBOX_PATH, "# 手机随手记\n"); }
});

/** The host must enable this source only on its local execution device. */
export const deviceCaptureSource: PhoneInboxSource = Object.freeze({
  entryPath: DEVICE_CAPTURE_ROOT, stateFile: DEVICE_INBOX_STATE, requiresBinding: true,
  matches: isDeviceCapturePath,
  exists: (store: StoreHost) => !!store.app.vault.getAbstractFileByPath(DEVICE_CAPTURE_ROOT),
  allowed: (store: StoreHost) => !isVaultPathExcluded(DEVICE_CAPTURE_ROOT, store.settings.privacy?.excludedVaultPrefixes),
  read: async (store: StoreHost) => {
    const prefixes = store.settings.privacy?.excludedVaultPrefixes;
    const allowed = (path: string) => !isVaultPathExcluded(path, prefixes)
      && !isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes);
    if (!allowed(DEVICE_CAPTURE_ROOT)) throw Error("设备收件目录不允许读取。");
    const root = await store.app.vault.adapter.list(DEVICE_CAPTURE_ROOT);
    const paths: string[] = [];
    for (const folder of root.folders) {
      if (!isDeviceCapturePath(folder + "/00000000-0000-0000-0000-000000000000.json") || !allowed(folder)) continue;
      const listed = await store.app.vault.adapter.list(folder);
      paths.push(...listed.files.filter(path => isDeviceCapturePath(path) && allowed(path)));
    }
    if (paths.length > 2000) throw Error("设备原记录较多，请先核对并归档已处理的原记录。");
    const rows: Array<PhoneInboxLine & { recordedAt: string }> = [];
    for (const path of paths.sort()) {
      let raw = "";
      try {
        raw = await readScopedMarkdown(store, path, 74_000);
        if (!allowed(path)) throw Error("设备原记录不允许读取。");
        const request = parseDeviceCapture(raw, path);
        rows.push({ id: deviceCaptureLineId(request), line: 1, text: request.text, date: request.date,
          terminated: true, sourcePath: path, sourceRevision: fileRevision(raw), recordedAt: request.recordedAt });
      } catch {
        if (!allowed(path)) continue;
        rows.push({ id: fileRevision("invalid-device-capture:" + path + ":" + fileRevision(raw)) + ":1",
          line: 1, text: "", date: "", terminated: true, sourcePath: path, sourceRevision: fileRevision(raw),
          invalidReason: "设备原记录尚未完整同步或格式需核对，未执行。", recordedAt: "" });
      }
    }
    return rows.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.sourcePath!.localeCompare(b.sourcePath!));
  },
  create: async (store: StoreHost) => { await store.ensureFolder(DEVICE_CAPTURE_ROOT); }
});
