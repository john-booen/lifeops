/** A new task's legacy start clock plus an explicit end is one unambiguous interval. */
export function newTaskScheduleInput(row:Record<string,unknown>):Record<string,unknown> {
  const next={...row};
  if(typeof row.time==="string"&&row.time.trim()&&typeof row.endTime==="string"&&row.endTime.trim()){
    if(row.startTime!==undefined&&(typeof row.startTime!=="string"||row.startTime.trim()&&row.startTime.trim()!==row.time.trim())){
      throw Error("开始时刻time与startTime不一致，请核对；本次未保存。");
    }
    next.startTime=row.time.trim();next.time="";
  }
  return next;
}
