import { parseYaml, type TFile } from "obsidian";
import { datesBetween, formatDate, normalizeJournalDate } from "../../date";
import { waitForFactOperations } from "../../dataFoundation/factOperation";
import { journalDateFromPath } from "../../journalResolver";
import { fileRevision } from "../../operationIdentity";
import { memorySourcePolicy } from "../../personalMemorySources";
import type { StoreHost } from "../../store/settingsSlice";
import { readSummary, readSummaryScope, summaryPath, summaryPathAllowed } from "./notes";
import { summaryLevels, summaryPeriod, summaryPeriodsInRange, type SummaryLevel, type SummaryPeriod } from "./periods";

export const SUMMARY_EVIDENCE_FILE_LIMIT = 200;
export interface SummaryEvidenceNote { path: string; date: string; }
export interface SummaryEvidenceChild { path: string; period: SummaryPeriod; generatedBy: string; edited: boolean; complete: boolean; }
export interface SummaryEvidence {
  path: string;
  period: SummaryPeriod;
  through: string;
  generatedBy: string;
  edited: boolean | null;
  savedInputCount: number;
  sourceScopeCurrent: boolean;
  days: { date: string; files: number; notes: SummaryEvidenceNote[] }[];
  journalFiles: number;
  journalDays: number;
  omittedFiles: number;
  children: SummaryEvidenceChild[];
  assertDisplayCurrent(): void;
  assertCurrent(): Promise<void>;
  fileFor(path: string): Promise<TFile>;
}

export function summaryEvidencePathAllowed(store: StoreHost, path: string): boolean {
  return path.startsWith(store.path(store.settings.folders.aiReports, "摘要") + "/") && path.endsWith(".md")
    && summaryPathAllowed(store, path) && store.getFile(path)?.path === path;
}

function reportPeriod(store: StoreHost, path: string, raw: string, today: string) {
  const front = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  let value;
  try { value = front ? parseYaml(front[1]) : null; }
  catch { throw Error("摘要头部暂不可读取，请先核对原笔记。"); }
  if (!value || value.lifeops !== "lifeops-summary" || !summaryLevels.includes(value.level)
    || typeof value.from !== "string" || typeof value.to !== "string" || typeof value.through !== "string"
    || ![value.from, value.to, value.through].every(day => /^\d{4}-\d{2}-\d{2}$/.test(day) && normalizeJournalDate(day, today) === day)
    || value.from > value.through || value.through > value.to || value.through > today
    || !Number.isSafeInteger(value.inputCount) || value.inputCount < 0) throw Error("这份笔记不是范围完整的LifeOps摘要，请先核对摘要日期。");
  const period = summaryPeriod(value.level as SummaryLevel, value.from);
  if (period.from !== value.from || period.to !== value.to || summaryPath(store, period) !== path) throw Error("摘要日期与位置不一致，请先核对原笔记。");
  return { period, through: value.through as string, inputCount: value.inputCount as number,
    generatedBy: value.generatedBy === "model" || value.generatedBy === "local" ? value.generatedBy : "unknown" };
}

/** A local index of current files, never a reconstruction of an old model request. */
export async function readSummaryEvidence(store: StoreHost, path: string,
  options: { signal?: AbortSignal; assertCurrent?: () => void; now?: Date } = {}): Promise<SummaryEvidence> {
  const policy = memorySourcePolicy(store);
  const active = () => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    if (memorySourcePolicy(store) !== policy || !summaryEvidencePathAllowed(store, path)) throw Error("资料范围已变化，请刷新后重新查看。");
  };
  active(); await waitForFactOperations(store, { signal: options.signal, assertCurrent: active }); active();
  const raw = await store.readPath(path); active();
  const report = reportPeriod(store, path, raw, formatDate(options.now ?? new Date()));
  const childPeriods = report.period.level === "day" ? [] : summaryPeriodsInRange(report.period.level === "week" ? "day" : "week",
    { from: report.period.from, to: report.through });
  const journals = () => [...new Map(store.app.vault.getMarkdownFiles().flatMap(file => {
    if (!store.isManagedSourcePath(file.path) || !summaryPathAllowed(store, file.path)
      || file.path.startsWith(store.settings.folders.aiReports + "/") || store.getFile(file.path)?.path !== file.path) return [];
    const date = journalDateFromPath(file.path, store.settings.folders.dailyRoot);
    return date && date >= report.period.from && date <= report.through ? [[file.path, { path: file.path, date, file }] as const] : [];
  })).values()].sort((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path));
  const meta = (file: TFile | null) => file ? [file.path, file.stat.mtime, file.stat.size] : null;
  const catalog = () => JSON.stringify([meta(store.getFile(path)),
    journals().map(row => meta(row.file)), childPeriods.map(period => {
      const source = summaryPath(store, period);
      return summaryPathAllowed(store, source) ? meta(store.getFile(source)) : null;
    })]);
  const capturedCatalog = catalog(), originals = journals(), scope = await readSummaryScope(store); active();
  const saved = await readSummary(store, report.period, scope.hash); active();
  const children: SummaryEvidenceChild[] = [], versions = new Map([[path, fileRevision(raw)]]);
  for (const period of childPeriods) {
    active(); const child = await readSummary(store, period, scope.hash); active();
    if (!child) continue;
    versions.set(child.path, child.revision);
    children.push({ path: child.path, period, generatedBy: child.properties.generatedBy, edited: child.edited, complete: child.properties.complete });
  }
  const assertDisplayCurrent = () => {
    active();
    if (catalog() !== capturedCatalog) throw Error("资料已经变化，请刷新后重新查看。");
  };
  const assertCurrent = async () => {
    assertDisplayCurrent();
    await waitForFactOperations(store, { signal: options.signal, assertCurrent: active });
    assertDisplayCurrent();
    if ((await readSummaryScope(store)).hash !== scope.hash) throw Error("可用资料已变化，请刷新后重新查看。");
    for (const [source, version] of versions) {
      if (!summaryPathAllowed(store, source) || store.getFile(source)?.path !== source || fileRevision(await store.readPath(source)) !== version) {
        throw Error("摘要内容已变化，请刷新后重新查看。");
      }
      assertDisplayCurrent();
    }
  };
  await assertCurrent();
  const visible = originals.slice(0, SUMMARY_EVIDENCE_FILE_LIMIT).map(({ path: source, date }) => ({ path: source, date }));
  const allowed = new Set([path, ...visible.map(row => row.path), ...children.map(row => row.path)]);
  return {
    path, ...report, savedInputCount: report.inputCount, sourceScopeCurrent: !!saved, edited: saved?.edited ?? null,
    days: datesBetween(report.period.from, report.through).map(date => ({ date,
      files: originals.filter(row => row.date === date).length, notes: visible.filter(row => row.date === date) })),
    journalFiles: originals.length, journalDays: new Set(originals.map(row => row.date)).size,
    omittedFiles: originals.length - visible.length, children, assertDisplayCurrent, assertCurrent,
    async fileFor(source) {
      await assertCurrent();
      if (!allowed.has(source) || !summaryPathAllowed(store, source)) throw Error("这份来源不在本次可回看范围内。");
      const file = store.getFile(source);
      if (file?.path !== source) throw Error("来源已移动或删除，请刷新后重新查看。");
      return file;
    }
  };
}
