import { journalDateFromPath } from "../../journalResolver";
import { isVaultPathExcluded } from "../../privacy";
import { isContextSourcePath } from "../../sourceReferences";
import type { StoreHost } from "../../store/settingsSlice";
import type { JournalSignal } from "../journal/signals";

/** Local source metadata only. Never adds unselected diary text to a request. */
export function journalSignalCoverage(store: StoreHost, date: string, signals: JournalSignal[]) {
  const paths = new Set(store.app.vault.getMarkdownFiles().map(file => file.path).filter(path =>
    isContextSourcePath(path) && store.isManagedSourcePath(path)
    && !isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)
    && journalDateFromPath(path, store.settings.folders.dailyRoot) === date));
  const covered = new Set(signals.flatMap(signal => signal.sources.map(source => source.path)).filter(path => paths.has(path)));
  return { scope: "readable-managed-local-journals" as const, journalFiles: paths.size,
    withCurrentSignals: covered.size, missingSignals: paths.size - covered.size, fullOriginalsReviewed: false as const };
}

export function journalCoverageText(coverage?: ReturnType<typeof journalSignalCoverage>): string {
  if (!coverage?.journalFiles) return "";
  return ["## 日记资料范围", "",
    `可读日记${coverage.journalFiles}篇，其中${coverage.withCurrentSignals}篇已提供可用整理内容。`,
    ...(coverage.missingSignals ? [`${coverage.missingSignals}篇日记尚未纳入整理；不代表原文没有计划或实际没有行动。`] : []),
    "正文依据已登记资料、提取信号和用户对话；原话未逐篇核对，细节可按需查询。"
  ].join("\n");
}
