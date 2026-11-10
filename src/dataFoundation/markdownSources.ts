import { readBoundedVaultFile } from "../legacyMemoryReview";
import { isVaultPathExcluded } from "../privacy";
import { isContextSourcePath } from "../sourceReferences";
import type { StoreHost } from "../store/settingsSlice";

export async function readScopedMarkdown(store: StoreHost, path: string, maxBytes = 256_000): Promise<string> {
  const allowed = () => isContextSourcePath(path) && !path.split("/").some(part => part.startsWith("."))
    && !isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes) && store.getFile(path)?.path === path;
  if (!allowed()) throw new Error("来源已经变化或不允许读取。");
  const adapter = store.app.vault.adapter as { getBasePath?: () => string } | undefined;
  const result = typeof adapter?.getBasePath === "function"
    ? await readBoundedVaultFile(store, path, maxBytes, () => { throw new Error("来源已修改，请重新读取。"); })
    : { raw: await store.readPath(path) };
  if (!("raw" in result) || result.raw === null || Buffer.byteLength(result.raw, "utf8") > maxBytes || !allowed()) {
    throw new Error("来源过大或不允许读取。");
  }
  return result.raw;
}
