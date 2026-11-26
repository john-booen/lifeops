import {normalizeJournalDate} from '../../date';

/** Pure readback of distinct tasks, separate from repeat completion events. */
export function completedTasksReply(output: string, today: string): string | undefined {
  let value: {domain?: string;range?:{from:string;to:string};completedTaskCount?:number;completedCount?:number;scope?:string};
  try { value=JSON.parse(output); } catch { return; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const {from,to}=value.range??{},count=value.completedTaskCount,events=value.completedCount;
  if(value.domain!=='tasks'||typeof from!=='string'||typeof to!=='string'||from>to
    ||!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)
    ||normalizeJournalDate(from)!==from||normalizeJournalDate(to)!==to
    ||typeof count!=='number'||!Number.isSafeInteger(count)||count<0
    ||typeof events!=='number'||!Number.isSafeInteger(events)||events<count)return;
  const when=from===to?(from===today?'今天':from):`${from} 至 ${to}`;
  const repeated=events!==count?`（共 ${events} 次完成记录）`:'';
  const scope=value.scope?'仅统计本轮允许读取的登记记录。':'';
  return `按登记，${when}已完成 ${count} 个任务${repeated}。${count===0?'未登记情况未知，不能据此判断没有行动。':''}${scope}`;
}
