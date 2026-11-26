import { parseYaml, stringifyYaml } from "obsidian";
import { fileRevision } from "../../operationIdentity";
import { createPersonalMemoryContextFilter, personalMemoryContextRevision } from "../../personalMemoryContext";
import { readPersonalMemoryWithSources } from "../../personalMemorySources";
import { isVaultPathExcluded } from "../../privacy";
import { isContextSourcePath } from "../../sourceReferences";
import type { StoreHost } from "../../store/settingsSlice";
import { summaryFolders, type SummaryPeriod } from "./periods";

const summaryMarker = "lifeops-summary";
export type SummaryMetrics = {
  taskCompletionPercent: number | null;
  tasksCompleted: number | null;
  /** Absent on legacy summaries; never infer distinct task IDs from events. */
  taskCompletionEvents?: number | null;
  energy: number | null;
  tradePnlCny: number | null;
  tradePnlUsd: number | null;
};
export const summaryMetricNames = ["tasksCompleted", "taskCompletionEvents", "taskCompletionPercent", "energy", "tradePnlCny", "tradePnlUsd"] as const satisfies readonly (keyof SummaryMetrics)[];
export type SummaryKind = "model" | "local";
type SummaryProperties = {
  lifeops: typeof summaryMarker;
  level: SummaryPeriod["level"];
  from: string;
  to: string;
  through: string;
  sourceScope: string;
  inputCount: number;
  inputRevision?: string;
  complete: boolean;
  generatedBy: SummaryKind;
  metrics: SummaryMetrics;
};
export type SavedSummary = {
  path: string;
  text: string;
  revision: string;
  properties: SummaryProperties;
  edited: boolean;
};

export function summaryPath(store: StoreHost, period: SummaryPeriod): string {
  return store.path(store.settings.folders.aiReports, "摘要", summaryFolders[period.level], period.key + ".md");
}

export async function readSummaryScope(store: StoreHost) {
  const prefixes = store.settings.privacy?.excludedVaultPrefixes ?? [];
  const { records } = await readPersonalMemoryWithSources(store);
  const suppressed = records.filter(record => record.status === "forgotten"
    || record.revisions.some(revision => revision.reason === "corrected"));
  return {
    hash: fileRevision(JSON.stringify([store.settings.folders, [...new Set(prefixes)].sort(), personalMemoryContextRevision(suppressed),
      store.settings.externalVaults ?? []])),
    protect: createPersonalMemoryContextFilter(records)
  };
}

export function summaryPathAllowed(store: StoreHost, path: string): boolean {
  return isContextSourcePath(path) && !isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes);
}

export async function readSummary(store: StoreHost, period: SummaryPeriod, sourceScope: string): Promise<SavedSummary | undefined> {
  const path = summaryPath(store, period);
  if (!summaryPathAllowed(store, path) || store.getFile(path)?.path !== path) return undefined;
  const raw = await store.readPath(path);
  if (!summaryPathAllowed(store, path)) return undefined;
  const header = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!header) return undefined;
  let properties: Partial<SummaryProperties>;
  try { properties = parseYaml(header[1]); } catch { return undefined; }
  if (properties?.lifeops !== summaryMarker || properties.sourceScope !== sourceScope || properties.level !== period.level
    || properties.from !== period.from || properties.to !== period.to || typeof properties.through !== "string"
    || typeof properties.inputCount !== "number" || typeof properties.complete !== "boolean" || !properties.metrics
    || properties.inputRevision !== undefined && (typeof properties.inputRevision !== "string" || !/^[a-f0-9]{64}$/.test(properties.inputRevision))) return undefined;
  const body = raw.slice(header[0].length);
  const marker = body.match(/^<!-- LifeOps 指纹 ([a-f0-9]{64}) -->\r?\n/);
  const stored = body.slice(marker?.[0].length ?? 0);
  const input = stored.match(/^<!-- LifeOps 摘要输入 ([a-f0-9]{64}) -->\r?\n/);
  const text = stored.slice(input?.[0].length ?? 0);
  const edited = marker?.[1] !== fileRevision(header[0] + stored);
  return { path, text: text.trim(), revision: fileRevision(raw),
    properties: { ...properties, inputRevision: input?.[1] ?? properties.inputRevision } as SummaryProperties, edited };
}

export function renderSummary(period: SummaryPeriod, through: string, sourceScope: string, metrics: SummaryMetrics,
  inputCount: number, complete: boolean, kind: SummaryKind, body: string, inputRevision?: string): string {
  const text = body.trim();
  const properties: SummaryProperties = {
    lifeops: summaryMarker, level: period.level, from: period.from, to: period.to, through,
    sourceScope, inputCount, complete, generatedBy: kind, metrics
  };
  const header = "---\n" + stringifyYaml(properties).trimEnd() + "\n---\n";
  const bodyText = (inputRevision ? "<!-- LifeOps 摘要输入 " + inputRevision + " -->\n" : "") + "\n" + text + "\n";
  return header + "<!-- LifeOps 指纹 " + fileRevision(header + bodyText) + " -->\n" + bodyText;
}
