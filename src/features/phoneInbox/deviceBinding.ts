import { readScopedMarkdown } from "../../dataFoundation/markdownSources";
import { isVaultPathExcluded } from "../../privacy";
import type { StoreHost } from "../../store/settingsSlice";
import type { LocalOperationHost } from "../serviceHost";
import { isDeviceCapturePath } from "./deviceCapture";
import { phoneInboxWriteId, type PhoneInboxLine } from "./model";

export interface DeviceSourceGuards {
  assertCurrent(): void;
  assertSourceCurrent(): Promise<void>;
}

/** A durable, content-free seal outlives the rolling operation ledger and receipts. */
export async function bindDeviceCaptureSource(host: Pick<LocalOperationHost, "saveLocalOperation"> & { store: StoreHost },
  line: PhoneInboxLine, guards: DeviceSourceGuards): Promise<{ previouslyBound: boolean }> {
  if (!line.sourcePath || !isDeviceCapturePath(line.sourcePath) || !/^[a-f\d]{64}:1$/u.test(line.id)
    || !/^[a-f\d]{64}$/u.test(line.sourceRevision ?? "")) throw Error("设备原记录身份需要核对。");
  const store = host.store, folder = store.settings.folders.aiReports;
  const path = store.path(folder, "DeviceInbox", "Sources", line.id.slice(0, 64) + ".json");
  const expected = JSON.stringify({ version: 1, id: line.id, sourcePath: line.sourcePath,
    sourceRevision: line.sourceRevision, operationId: phoneInboxWriteId(line.id) }) + "\n";
  const current = () => {
    guards.assertCurrent();
    if (store.settings.folders.aiReports !== folder || isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)) {
      throw Error("设备签收记录目录已变化或不允许读取。");
    }
  };
  const exists = async (scope: StoreHost) => {
    current();
    if (!scope.getFile(path)) return false;
    const raw = await readScopedMarkdown(scope, path, 4000);
    current();
    if (raw !== expected) throw Error("设备原记录与首次签收的版本不同，未重复执行。");
    return true;
  };
  await guards.assertSourceCurrent();
  if (await exists(store)) return { previouslyBound: true };
  let operationStore: StoreHost | undefined, previouslyBound = false;
  await host.saveLocalOperation("scheduled_device_capture_source", { id: line.id, sourcePath: line.sourcePath,
    sourceRevision: line.sourceRevision }, async scope => {
    operationStore = scope;
    await guards.assertSourceCurrent();
    previouslyBound = await exists(scope);
    if (!previouslyBound) await scope.writeFile(path, expected);
  }, { assertCurrent: current, assertBeforeCommit: async () => {
    await guards.assertSourceCurrent();
    if (!operationStore || !await exists(operationStore)) throw Error("设备签收版本未能核对。");
  } });
  return { previouslyBound };
}
