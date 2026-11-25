import {normalizeJournalDate} from '../../date';
import {validateTaskSchedule} from '../../taskSchedule';
import type {LifeOpsTaskInput} from '../../types';
import {taskDeadlineInput} from './deadlineInput';
import {newTaskScheduleInput} from './newScheduleInput';

type Fields=Pick<LifeOpsTaskInput,'date'|'time'|'endDate'|'startTime'|'endTime'|'scheduleMode'|'dueDate'|'dueTime'|'estimateMin'>;
function clock(value:unknown):string {
  if(value===undefined||value==='')return '';
  if(typeof value!=='string')throw Error('计划时刻须为文字，没有保存任务。');
  const text=value.trim(),colon=text.match(/^(\d{1,2})[:：](\d{2})$/u);if(colon)return `${colon[1].padStart(2,'0')}:${colon[2]}`;
  const hour=text.match(/(\d{1,2})\s*点(半|(\d{1,2})分?)?/u);if(!hour)throw Error('计划时刻无法识别，没有保存任务。');
  return `${hour[1].padStart(2,'0')}:${hour[2]==='半'?'30':(hour[3]??'0').padStart(2,'0')}`;
}
/** One parser for chat, form and frozen creation cards; plan and hard due stay independent. */
export function taskScheduleInput(input:Record<string,unknown>,options:{baseDate?:string;reminderClock?:string}={}):Fields {
  const row=newTaskScheduleInput(input),result:Fields={date:'',time:''};
  for(const key of ['date','endDate'] as const){
    if(row[key]===undefined)continue;if(typeof row[key]!=='string')throw Error('计划日期须为文字，没有保存任务。');
    const text=row[key].trim(),date=text?normalizeJournalDate(text,options.baseDate):'';
    if(text&&!date)throw Error('任务日期无法识别或不存在，没有保存任务。');result[key]=date;
  }
  if(row.scheduleMode!==undefined){if(row.scheduleMode!=='fixed'&&row.scheduleMode!=='window')throw Error('任务安排方式无效，没有保存任务。');result.scheduleMode=row.scheduleMode;}
  result.time=clock(row.time);
  for(const key of ['startTime','endTime'] as const){if(row[key]===undefined)continue;if(typeof row[key]!=='string')throw Error('计划时刻须为文字，没有保存任务。');result[key]=row[key].trim();}
  if(row.estimateMin!==undefined){if(typeof row.estimateMin!=='number')throw Error('估计时长须为分钟数。');result.estimateMin=row.estimateMin;}
  if(!result.time&&result.endTime&&!result.startTime&&!result.endDate&&row.estimateMin===undefined&&(row.time===undefined||row.time==='')&&options.reminderClock===result.endTime){result.time=result.endTime;delete result.endTime;}
  Object.assign(result,taskDeadlineInput(row,undefined,options.baseDate));
  validateTaskSchedule({...result,date:result.date??'',time:result.time??'',endDate:result.endDate??''});return result;
}
