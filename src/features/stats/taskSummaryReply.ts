import {normalizeJournalDate} from '../../date';

/** A numeric overview is not an explanation, an on-time rate, or a cause. */
export function taskSummaryReply(output:string,asOf:string):string|undefined{
  let row;try{row=JSON.parse(output);}catch{return;}
  if(!row||typeof row!=='object'||Array.isArray(row)||row.domain!=='tasks')return;
  const {from,to}=row.range??{};
  if(typeof from!=='string'||typeof to!=='string'||from>to||normalizeJournalDate(from)!==from
    ||normalizeJournalDate(to)!==to||normalizeJournalDate(asOf)!==asOf)return;
  const {plannedCount:planned,completedPlannedCount:done,completedTaskCount:tasks,completedCount:events,overdueCount:overdue}=row;
  if(![planned,done,tasks,events,overdue].every(value=>Number.isSafeInteger(value)&&value>=0)
    ||done>planned||done>tasks||tasks>events||overdue>planned)return;
  const rate=planned?Math.round((done/planned*100)*100)/100:null;
  if(row.completionPercent!==rate||row.scope!==undefined&&typeof row.scope!=='string')return;
  return [
    `${from===to?from:from+' 至 '+to} · 任务完成登记`,
    planned?`区间内计划 ${planned} 项，区间计划内完成 ${done} 项，计划完成率 ${rate}%。`
      :'区间内没有计划登记，无法计算计划完成率。',
    `区间内登记完成 ${tasks} 个任务${tasks!==events?'（共 '+events+' 次完成记录）':''}。`,
    `截至本次查询（${asOf}），上述计划中仍未完成且已过期 ${overdue} 项；这不是该区间结束时的历史过期数。`,
    '计划内完成按整个所问区间计算，不是每天按时完成率；跨日完成仍可能计入该周或该月。',
    (row.scope?'本次只包含允许读取的部分记录。':'以上只包含登记记录。')+'未登记情况未知。'
  ].join('\n\n');
}
