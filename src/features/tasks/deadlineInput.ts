import {normalizeJournalDate} from "../../date";
import {timeMinutes} from "../../taskSchedule";
import type {LifeOpsTask} from "../../types";

export const TASK_DEADLINE_PROPERTIES = {
  dueDate: {type:"string",description:"另有必须交付或约定的硬截止日期才填，可用明确相对日期；与安排/计划完成独立，不复制计划结束。修改时空串清除日期和截止时刻，省略保留。"},
  dueTime: {type:"string",description:"必须截止的HH:mm，须有截止日期；不是计划结束时刻。修改时空串清除，省略保留。"}
};

/** Validate all supplied deadline fields before any write; omitted fields retain their meaning. */
export function taskDeadlineInput(row:Record<string,unknown>,before?:Pick<LifeOpsTask,"dueDate"|"dueTime">,baseDate?:string):Partial<Pick<LifeOpsTask,"dueDate"|"dueTime">> {
  if(row.dueDate===undefined&&row.dueTime===undefined)return{};
  const patch:Partial<Pick<LifeOpsTask,"dueDate"|"dueTime">>={};
  if(row.dueDate!==undefined){
    if(typeof row.dueDate!=="string")throw Error("必须截止日期须为文字，本次未保存。");
    const value=row.dueDate.trim(),date=value?normalizeJournalDate(value,baseDate):"";
    if(value&&!date)throw Error("必须截止日期无效，本次未保存。");
    patch.dueDate=date;
    if(!date)patch.dueTime="";
  }
  if(row.dueTime!==undefined){
    if(typeof row.dueTime!=="string")throw Error("必须截止时刻须为文字，本次未保存。");
    const value=row.dueTime.trim();
    if(value&&timeMinutes(value)===undefined)throw Error("必须截止时刻须为有效HH:mm，本次未保存。");
    patch.dueTime=value;
  }
  if((patch.dueTime??before?.dueTime)&&!(patch.dueDate??before?.dueDate))throw Error("必须截止时刻须同时有截止日期，本次未保存。");
  return patch;
}
export function taskDeadlineLabel(task:Pick<LifeOpsTask,"dueDate"|"dueTime">):string {
  return task.dueDate?`必须截止${task.dueDate}${task.dueTime?` ${task.dueTime}`:""}`:"";
}
