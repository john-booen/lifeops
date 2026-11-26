import { addDays, datesBetween, formatDate } from "../../date";
import { hasPendingFactOperation } from "../../dataFoundation/factOperation";
import { journalDateFromPath } from "../../journalResolver";
import { MEMORY_CONTEXT_OMISSION } from "../../personalMemoryContext";
import { isVaultPathExcluded } from "../../privacy";
import type { StoreHost } from "../../store/settingsSlice";
import { produceVaultQueryRead } from "../../vaultQueryRead";
import { readSummary, readSummaryScope, summaryPath, summaryPathAllowed, summaryMetricNames, type SummaryMetrics } from "./notes";
import { resolveSummaryRange, summaryLevels, summaryPeriod, summaryPeriodsInRange, type SummaryLevel } from "./periods";
import { evidenceCoverage } from "./evidenceCoverage";
import { noteCalendar } from "./noteCalendar";
import { RECORDED_DATA_SCOPE, SUMMARY_TASK_METRIC_DEFINITIONS } from "../stats/definitions";

/** Read historical evidence without regenerating summaries or confirming memory. */
export async function readSummaryQueryWithSources(store: StoreHost, args: Record<string, unknown>) {
  const level = args.level as SummaryLevel;
  if (!summaryLevels.includes(level)) throw Error("请选择日、周或月摘要。");
  if (args.includeOriginals !== undefined && typeof args.includeOriginals !== "boolean") throw Error("原文读取选项需要是开或关。");
  const metrics = args.metrics;
  if (metrics !== undefined && (!Array.isArray(metrics) || !metrics.length || metrics.length > summaryMetricNames.length
    || new Set(metrics).size !== metrics.length || !metrics.every(key => summaryMetricNames.includes(key as keyof SummaryMetrics)))) {
    throw Error("摘要指标需要选择有效、不重复的指标字段。");
  }
  const selectedMetrics = metrics as readonly (keyof SummaryMetrics)[] | undefined;
  if (args.query !== undefined && (typeof args.query !== "string" || !args.query.trim() || args.query.length>120)) throw Error("请提供一段不超过120字的主题关键词。");
  const query = typeof args.query === "string" ? args.query.trim() : undefined;
  const allowOriginals = !selectedMetrics || args.includeOriginals === true || query !== undefined;
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
    ...(allowOriginals ? journalFiles().map(({file})=>({path:file.path,version:JSON.stringify(file.stat)})) : [])
  ], async reader => {
    const summaries = [], missingPeriods: string[] = [];
    for (const period of selectedPeriods) {
      const note = await readSummary(store, period, scope.hash);
      if (!note) { missingPeriods.push(period.key); continue; }
      const item = {
        period: period.key, from: period.from, through: note.properties.through, complete: note.properties.complete,
        generatedBy: note.properties.generatedBy, edited: note.edited, inputCount: note.properties.inputCount,
        metrics: selectedMetrics ? Object.fromEntries(selectedMetrics.map(key=>[key,note.properties.metrics[key]??null])) : note.properties.metrics,
        ...(!selectedMetrics ? {summary: scope.protect(note.text).slice(0,1600)} : {}), path: note.path
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
    if (allowOriginals && (missingPeriods.length || args.includeOriginals === true || query)) {
      const wantsDate = (date:string) => args.includeOriginals===true || query!==undefined || missingPeriods.includes(summaryPeriod(level,date).key);
      const files = journalFiles().filter(({date})=>wantsDate(date));
      const selected = files.slice(-28), limit = Math.min(1600,Math.floor(12000/Math.max(1,selected.length)));
      const notes: Array<{date:string;path:string;text:string;truncated:boolean;calendar:ReturnType<typeof noteCalendar>}> = [];
      const knownDates = new Set(files.map(row=>row.date));
      const unavailableDates = new Set<string>(), limitedDates = new Set(files.slice(0,Math.max(0,files.length-28)).map(row=>row.date));
      let unavailable = 0;
      for (const {file,date} of selected) {
        // Large originals stay available through exact-path query_vault paging.
        if (file.stat.size > 32768) { unavailable++;unavailableDates.add(date);continue; }
        const raw = await reader.read(file);
        if (Buffer.byteLength(raw,"utf8") > 32768) { unavailable++;unavailableDates.add(date);continue; }
        const protectedText = scope.protect(raw).trim();
        if (!protectedText || protectedText === MEMORY_CONTEXT_OMISSION) { unavailable++;unavailableDates.add(date);continue; }
        const searchable = protectedText.toLocaleLowerCase();
        if (!terms.every(term=>searchable.includes(term))) continue;
        const match = terms.length ? searchable.indexOf(terms[0]) : 0;
        const start = Math.max(0,match-100);
        const item = {date,path:file.path,text:protectedText.slice(start,start+limit),truncated:start>0||protectedText.length>limit,calendar:noteCalendar(date)};
        reader.contributed(file.path,JSON.stringify(item));notes.push(item);
      }
      const dated = new Set(notes.map(note=>note.date));
      const wantedDates = from<=through ? datesBetween(from,through).filter(wantsDate) : [];
      const coverageByDate = wantedDates.map(date => ({date,
        status: dated.has(date)?"已返回可读片段":unavailableDates.has(date)?"有日记，片段暂不可核对":limitedDates.has(date)?"有日记，本次未读齐":knownDates.has(date)?"有日记，可读正文未命中主题":"允许范围未找到日记"}));
      const counted = evidenceCoverage(range, coverageByDate, notes.length, !!query);
      originalEvidence = {from,to:through,...(query?{query}:{}),notes,unavailable,
        coverageByDate,counts:counted.counts,coverageSummary:counted.summary,
        missingDates: wantedDates.filter(date=>!knownDates.has(date)),
        unmatchedDates: query ? wantedDates.filter(date=>knownDates.has(date)&&!dated.has(date)&&!unavailableDates.has(date)&&!limitedDates.has(date)) : [],
        unavailableDates: [...unavailableDates].filter(date=>!dated.has(date)),
        limitedDates: [...limitedDates].filter(date=>!dated.has(date)),
        limited: from>range.from||files.length>selected.length||notes.some(note=>note.truncated),
        eventDates:"未核对",
        coverage:"仅核对所问范围内最近28天、最多28篇日记片段。missingDates表示允许范围未找到该日日记；unmatchedDates表示已有日记但可读正文未命中主题，不能说成没有日记。unavailableDates或limitedDates表示依据未读齐。以上均不能推出当天没做；截断不能当全文，可用准确path续查。笔记日期不等于事件日期，历史表现不能证明因果或当前偏好；后续安排以当前已确认记忆为准。"};
    }
    await noPending();
    if ((await readSummaryScope(store)).hash!==scope.hash) throw Error("摘要可读取的资料范围有变化，请重试。");
    return JSON.stringify({level,range,summaries,...(selectedMetrics?{requestedMetrics:selectedMetrics}:{}),recordScope:RECORDED_DATA_SCOPE,metricDefinitions:SUMMARY_TASK_METRIC_DEFINITIONS,
      interpretationBoundary:{summary:"模型或本地生成的二手总结，不是直接事件证明；edited表示生成后有编辑，不能仅凭它认定原文已核对。",
        complete:"周期完成标记，不是原始记录齐全的证明。",inputCount:"已完成的子摘要份数，不是日记篇数或有行为的天数。",
        dates:"原文中的相对日期以该段叙述的时点理解，笔记日期与事件日期分开；不能改为当前读取日。",
        suggestions:"建议不等于事实、已定计划或修改现有目标与规则的授权。"},...(missingPeriods.length?{missingPeriods}:{}),
      ...(coverage.length?{coverage:coverage.join(" ")} : {}),...(originalEvidence?{originalEvidence}:{})});
  });
  try { await noPending();await read.assertSourcesCurrent();return read; }
  catch(error) { read.dispose();throw error; }
}
