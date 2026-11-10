import type { LifeOpsSettings } from "../../types";

export function isTradeVaultPath(path: string): boolean {
  return !!path && !/^[~/]|^[a-z][a-z\d+.-]*:|[\\\u0000-\u001f]/i.test(path)
    && path.split("/").every(part => part && !part.startsWith("."));
}

export function parseTradingSourceFolders(value: string): string[] {
  const paths = value.split(/\r?\n/).map(line => line.trim().replace(/\\/g, "/").replace(/\/+$/, ""));
  return [...new Set(paths.filter(isTradeVaultPath))];
}

export function getTradingSourceFolders(settings: Pick<LifeOpsSettings, "folders" | "tradingSourceFolders">): string[] {
  const stored = settings.tradingSourceFolders;
  const paths = Array.isArray(stored) ? stored : [settings.folders.tradingReviews, settings.folders.tradingModels];
  return parseTradingSourceFolders(paths.filter(path => typeof path === "string").join("\n"));
}
