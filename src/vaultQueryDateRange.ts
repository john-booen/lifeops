import {addDays,formatDate,normalizeJournalDate,startOfWeek} from './date';
import {resolveStatsRange,serializedDateRange,type DayRange,type StatsRange} from './features/stats/rangeInput';

/** Parameter failures can be repaired without implying a source or ledger failure. */
export class VaultQueryParameterError extends Error {}
export type JournalQueryRange=StatsRange|'week';

/** Resolve once before either vault is opened. This parses tool parameters only;
 * it neither classifies user intent nor chooses a tool, source, or write action. */
export function resolveVaultQueryDateRange(input:{domain:string;date?:string;range?:unknown},now:Date):DayRange|undefined{
 const fail=(text:string):never=>{throw new VaultQueryParameterError(text);};
 if(input.domain!=='journal'){
  if(input.range!==undefined&&(!(input.domain==='task'||input.domain==='habit')||!['today','week'].includes(String(input.range))))
   fail('range 日期范围仅用于日记；任务/习惯仅支持 today、week，跨期数字请用 get_stats。');
  return;
 }
 if(input.date!==undefined&&typeof input.date!=='string')fail('日记日期无效，请填写有效日期。');
 const rawDate=input.date?.trim(),date=rawDate?normalizeJournalDate(rawDate,formatDate(now)):undefined;
 if(rawDate&&!date)fail('日记日期无效：'+rawDate+'。请提供有效日期后再读取。');
 if(input.range===undefined)return date?{from:date,to:date}:undefined;
 if(!Number.isFinite(now.getTime()))fail('日记查询范围的基准日期无效。');
 const anchor=date??formatDate(now);
 if(input.range==='today')return{from:anchor,to:anchor};
 // Retain the original whole-week API, including an explicit anchor and Sunday.
 if(input.range==='week'){const from=startOfWeek(anchor);return{from,to:addDays(from,6)};}
 if(rawDate)fail('日记的 date 与此 range 范围不能同时填写；逐日用 date，跨期用 range。');
 try{
  const range=serializedDateRange(input.range)??input.range;
  if(range&&typeof range==='object'&&(Array.isArray(range)||Object.keys(range).sort().join(',')!=='from,to'))
   fail('日记查询区间仅允许 from、to 两个日期。');
  return resolveStatsRange(range as StatsRange,now);
 }catch(error){if(error instanceof VaultQueryParameterError)throw error;return fail('日记查询范围无效：'+(error instanceof Error?error.message:'请填写有效区间。'));}
}
