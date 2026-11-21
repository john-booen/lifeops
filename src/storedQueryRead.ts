import type { StoreHost } from "./store/settingsSlice";
import type { ToolExecutionContext, ToolExecutionResult } from "./toolRegistry";
import { produceVaultQueryRead, type VaultQueryRead } from "./vaultQueryRead";
import { projectFileName } from "./projectContinuity";
import { tradingDocumentPath } from "./tradingResearch";
import { isVaultPathExcluded } from "./privacy";

export type StoredQueryName = "query_projects" | "query_trading_research" | "list_personal_memory_candidates" | "get_summaries";
const owners = new WeakMap<VaultQueryRead, StoreHost>();
export function isOwnedStoredQueryRead(store: StoreHost, read: VaultQueryRead): boolean {
  return owners.get(read) === store;
}

export async function readStoredQueryWithSources(store: StoreHost, name: StoredQueryName, args: Record<string, unknown>): Promise<VaultQueryRead> {
  const fixed = structuredClone(args);
  if (name === "get_summaries") {
    const read = await (await import("./features/summaries/read")).readSummaryQueryWithSources(store, fixed);
    owners.set(read, store);
    return read;
  }
  const path = name === "query_projects" ? store.path(store.settings.folders.goals, projectFileName())
    : name === "query_trading_research" ? tradingDocumentPath(store) : store.personalMemoryPath();
  if (!isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)) {
    const file = store.getFile(path);
    if (file && file.path !== path) throw Error("查询原文路径身份不一致，已停止读取。");
  }
  const read = await produceVaultQueryRead(store, () => [], async reader => {
    if (name === "query_projects") return (await import("./projectTools")).queryProjectsText(store, fixed, reader.contributed);
    if (name === "query_trading_research") return (await import("./tradingTools")).queryTradingText(store, fixed, reader.contributed);
    return (await import("./toolRegistry")).personalMemoryCandidatesText(fixed, { store, refreshViews: async () => {} }, reader.contributed);
  }, name !== "list_personal_memory_candidates");
  owners.set(read, store);
  return read;
}

export async function executeStoredQuery(name: StoredQueryName, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  let read: VaultQueryRead | undefined;
  let transferred = false;
  try {
    read = await readStoredQueryWithSources(context.store, name, args);
    context.onVaultQueryRead?.(read);
    transferred = !!context.onVaultQueryRead;
    return { success: true, output: read.text, actions: [] };
  } catch (error) {
    return { success: false, output: error instanceof Error ? error.message : "查询暂无法核对，请重新读取。", actions: [] };
  } finally {
    if (!transferred) read?.dispose();
  }
}
