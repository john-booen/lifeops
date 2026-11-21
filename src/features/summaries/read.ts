import { addDays, datesBetween, formatDate } from "../../date";
import { hasPendingFactOperation } from "../../dataFoundation/factOperation";
import { journalDateFromPath } from "../../journalResolver";
import { MEMORY_CONTEXT_OMISSION } from "../../personalMemoryContext";
import { isVaultPathExcluded } from "../../privacy";
import type { StoreHost } from "../../store/settingsSlice";
import { produceVaultQueryRead } from "../../vaultQueryRead";
import { readSummary, readSummaryScope, summaryPath, summaryPathAllowed } from "./notes";
import { resolveSummaryRange, summaryLevels, summaryPeriod, summaryPeriodsInRange, type SummaryLevel } from "./periods";

/** Read historical evidence without regenerating summaries or confirming memory. */
export async function readSummaryQueryWithSources(store: StoreHost, args: Record<string, unknown>) {
  const level = args.level as SummaryLevel;
  if (!summaryLevels.includes(level)) throw Error("请选择日、周或月摘要。");
  if (args.includeOriginals !== undefined && typeof args.includeOriginals !== "boolean") throw Error("原文读取选项需要是开或关。");
  if (args.query !== undefined && (typeof args.query !== "string" || !args.query.trim() || args.query.length>120)) throw Error("请提供一段不超过120字的主题关键词。");
  const query = typeof args.query === "string" ? args.query.trim() : undefined;
  const terms = query?.toLocaleLowerCase().split(/\s+/u).sort((a,b)=>b.length-a.length) ?? [];
  if (terms.length>8) throw Error("一次最多用8个主题关键词。");
  const range = resolveSummaryRange(args.range as Parameters<typeof resolveSummaryRange>[0], new Date());
  const periods = summaryPeriodsInRange(level, range), selectedPeriods = periods.slice(-14);
  const scope = await readSummaryScope(store);
  const through = [range.to, formatDate(new Date())].sort()[0];
  const from = [range.from, addDays(through, -27)].sort().at(-1)!;
  const journalFiles = () => store.app.vault.getMarkdownFiles().flatMap(file => {
    if (!summaryPathAllowed(store, file.path) || !store.isManagedSourcePath(file.path)
      || file.path.startsWith(store.settings.folders.aiReports + "/")
      || isVaultPathExcluded(file.path, store.settings.privacy?.excludedVaultPrefixes)) return [];
    const date = journalDateFromPath(file.path, store.settings.folders.dailyRoot);
    return date && date >= from && date <= through ? [{ file, date }] : [];
  }).sort((a,b)=>a.date.localeCompare(b.date)||a.file.path.localeCompare(b.file.path));
  const noPending = async () => {
    if (await hasPendingFactOperation(store)) throw Error("保存尚未结束，请等待或恢复后再读取历史依据。");
  };
  await noPending();
  const read = await produceVaultQueryRead(store, () => [
    ...selectedPeriods.map(period => summaryPath(store, period)).filter(path=>summaryPathAllowed(store,path))
      .map(path=>({path,version:JSON.stringify(store.getFile(path)?.stat??"absent")})),
    ...journalFiles().map(({file})=>({path:file.path,version:JSON.stringify(file.stat)}))
  ], async reader => {
    const summaries = [], missingPeriods: string[] = [];
    for (const period of selectedPeriods) {
      const note = await readSummary(store, period, scope.hash);
      if (!note) { missingPeriods.push(period.key); continue; }
      const item = {
        period: period.key, from: period.from, through: note.properties.through, complete: note.properties.complete,
        generatedBy: note.properties.generatedBy, metrics: note.properties.metrics,
        summary: scope.protect(note.text).slice(0,1600), path: note.path
      };
      reader.dependOn(note.path,note.revision);reader.contributed(note.path,JSON.stringify(item));
      summaries.push(item);
    }
    const coverage: string[] = [];
    if (periods.length > 14) coverage.push("只读取最近 14 个周期，查询较早日期请缩小区间。");
    if (missingPeriods.length) coverage.push(summaries.length
      ? "部分周期没有可读取的摘要，可以按 missingPeriods 查原始记录。"
      : "这个区间没有可读取的摘要，可以查原始记录。");
    let originalEvidence;
    if (missingPeriods.length || args.includeOriginals === true || query) {
      const files = journalFiles().filter(({date})=>args.includeOriginals===true||query||missingPeriods.includes(summaryPeriod(level,date).key));
      const selected = files.slice(-28), limit = Math.min(1600,Math.floor(12000/Math.max(1,selected.length)));
      const notes: Array<{date:string;path:string;text:string;truncated:boolean}> = [];
      let unavailable = 0;
      for (const {file,date} of selected) {
        // Large originals stay available through exact-path query_vault paging.
        if (file.stat.size > 32768) { unavailable++; continue; }
        const raw = await reader.read(file);
        if (Buffer.byteLength(raw,"utf8") > 32768) { unavailable++; continue; }
        const protectedText = scope.protect(raw).trim();
        if (!protectedText || protectedText === MEMORY_CONTEXT_OMISSION) { unavailable++; continue; }
        const searchable = protectedText.toLocaleLowerCase();
        if (!terms.every(term=>searchable.includes(term))) continue;
        const match = terms.length ? searchable.indexOf(terms[0]) : 0;
        const start = Math.max(0,match-100);
        const item = {date,path:file.path,text:protectedText.slice(start,start+limit),truncated:start>0||protectedText.length>limit};
        reader.contributed(file.path,JSON.stringify(item));notes.push(item);
      }
      const dated = new Set(notes.map(note=>note.date));
      originalEvidence = {from,to:through,...(query?{query}:{}),notes,unavailable,
        missingDates: from<=through?datesBetween(from,through).filter(date=>!dated.has(date)):[],
        limited: from>range.from||files.length>selected.length||notes.some(note=>note.truncated),
        eventDates:"未核对",
        coverage:"仅核对所问范围内最近28天、最多28篇日记片段。没有可读记录不能推出当天没做；截断不能当全文，可用准确path续查。笔记日期不等于事件日期，历史表现不能证明因果或当前偏好；后续安排以当前已确认记忆为准。"};
    }
    await noPending();
    if ((await readSummaryScope(store)).hash!==scope.hash) throw Error("摘要可读取的资料范围有变化，请重试。");
    return JSON.stringify({level,range,summaries,...(missingPeriods.length?{missingPeriods}:{}),
      ...(coverage.length?{coverage:coverage.join(" ")} : {}),...(originalEvidence?{originalEvidence}:{})});
  });
  try { await noPending();await read.assertSourcesCurrent();return read; }
  catch(error) { read.dispose();throw error; }
}
