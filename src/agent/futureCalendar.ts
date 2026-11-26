import {addDays,formatDate,normalizeJournalDate,startOfWeek} from '../date';

export const NEXT_STEP_HEADING=/(?:^|\n)\s*(?:#{1,6}\s+)?(?:\*\*)?下一步(?:[（(]建议[）)])?/u;
/** Keep generated advice under the heading used by the calendar and history
 * guards. Quoted source text and code blocks retain their original wording. */
export function normalizeAdviceHeadings(answer:string):string{
 let fence='';return answer.split('\n').map(line=>{
  const marker=line.trim().match(/^(`{3,}|~{3,})/u)?.[1];if(marker){if(!fence)fence=marker;else if(fence[0]===marker[0]&&marker.length>=fence.length&&!line.trim().slice(marker.length).trim())fence='';return line;}
  if(fence||/^\s*>/u.test(line))return line;
  return line.replace(/^(\s*)(#{1,6}\s+|\*\*)(?:改进(?:[（(]有依据[）)])?|建议)(?=\*\*|\s*[：:]|\s*$)/u,'$1$2下一步（建议）')
    .replace(/^(\s*)(?:改进(?:[（(]有依据[）)])?|建议)([：:])/u,'$1下一步（建议）$2');
 }).join('\n');
}
const weekdays=['一','二','三','四','五','六','日'] as const;

/** Calendar data only: no availability, plan, historical fact or write authority. */
export function futureCalendarReference(asOf?:string){
 if(!asOf)return;const now=new Date(asOf);if(!Number.isFinite(now.getTime()))return;
 const today=formatDate(now),start=addDays(startOfWeek(today),7);
 return{scope:'future_calendar_reference_only',asOf,today,nextWeek:{from:start,to:addDays(start,6),
  weekdays:Object.fromEntries(weekdays.map((day,index)=>['周'+day,addDays(start,index)]))}};
}

/** Check generated advice labels, never user intent or source narration. */
export function futureCalendarConflicts(answer:string,asOf?:string){
 const calendar=futureCalendarReference(asOf),heading=NEXT_STEP_HEADING.exec(answer);
 if(!calendar||!heading)return[];
 const advice=answer.slice(heading.index),conflicts=[];
 for(const match of advice.matchAll(/下周([一二三四五六日天])[\s（(]*((?:\d{4}-)?\d{2}-\d{2}|\d{1,2}月\d{1,2}[日号])/gu)){
  const weekday=match[1]==='天'?'日':match[1],calendarDate=calendar.nextWeek.weekdays['周'+weekday];
  const token=match[2],reportedDate=normalizeJournalDate(token.length===5?calendarDate.slice(0,5)+token:token,calendarDate);
  if(reportedDate!==calendarDate)conflicts.push({quote:match[0],reportedDate:reportedDate||token,calendarDate,
   basis:'下周以本轮当前日期'+calendar.today+'计算，不以回顾范围的结束日计算；这只是日历参照，不代表已经安排或完成。'});
 }
 return conflicts;
}
