import {expect,it} from 'vitest';
import {taskSummaryReply} from '../src/features/stats/taskSummaryReply';
const asOf='2026-11-12',data=(change:Record<string,unknown>={})=>JSON.stringify({domain:'tasks',range:{from:'2026-11-02',to:'2026-11-08'},plannedCount:37,completedPlannedCount:26,completedTaskCount:26,completedCount:26,completionPercent:70.27,overdueCount:0,...change});
it('labels whole-period completion and present overdue counts without inferring daily punctuality or reasons',()=>{
 const reply=taskSummaryReply(data(),asOf)!;
 for(const value of ['计划 37 项','完成 26 项','70.27%','完成 26 个任务','2026-11-12','不是该区间结束时','不是每天按时完成率','未登记情况未知'])expect(reply).toContain(value);
 for(const value of ['说明收尾','工作时长','平均间隔','需要我','？'])expect(reply).not.toContain(value);
});
it('keeps an empty sample unknown and distinguishes repeat events from tasks',()=>{
 const empty=taskSummaryReply(data({plannedCount:0,completedPlannedCount:0,completedTaskCount:0,completedCount:0,completionPercent:null}),asOf)!;
 expect(empty).toContain('无法计算');expect(empty).not.toContain('0%');expect(empty).toContain('未登记情况未知');
 const repeated=taskSummaryReply(data({completedTaskCount:26,completedCount:28,scope:'partial'}),asOf)!;
 expect(repeated).toContain('26 个任务（共 28 次完成记录）');expect(repeated).toContain('部分记录');
});
it('refuses inconsistent counts, percentages, dates and source scope',()=>{
 for(const change of [{completionPercent:99},{completedPlannedCount:38},{completedTaskCount:25},{overdueCount:38},{plannedCount:-1},{scope:true},{range:{from:'2026-11-31',to:'2026-11-31'}}])expect(taskSummaryReply(data(change),asOf)).toBeUndefined();
 for(const raw of ['null','[]','{'])expect(taskSummaryReply(raw,asOf)).toBeUndefined();
 expect(taskSummaryReply(data(),'not-a-date')).toBeUndefined();
});
