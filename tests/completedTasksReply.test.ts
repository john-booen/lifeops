import {expect,it} from 'vitest';
import {completedTasksReply} from '../src/features/stats/completedTasksReply';
import {getStats} from '../src/features/stats/stats';
import type {LifeOpsTask} from '../src/types';

const today='2026-11-26';
const data=(values:Record<string,unknown>={})=>JSON.stringify({domain:'tasks',range:{from:today,to:today},completedTaskCount:3,completedCount:3,...values});
it('reports measured zero and explicit dates, and marks partial source scope',()=>{
  expect(completedTasksReply(data(),today)).toBe('今天已完成 3 个任务。');
  expect(completedTasksReply(data({completedTaskCount:0,completedCount:0,scope:'partial'}),today)).toBe('今天已完成 0 个任务。仅统计本轮允许读取的登记记录。');
  expect(completedTasksReply(data({range:{from:'2026-11-01',to:'2026-11-20'}}),today)).toContain('2026-11-01 至 2026-11-20');
});
it('never substitutes completion event count for distinct tasks or accepts malformed statistics',()=>{
  for(const raw of ['null','[]','"fictional"','{'])expect(completedTasksReply(raw,today)).toBeUndefined();
  expect(completedTasksReply(data({completedTaskCount:undefined}),today)).toBeUndefined();
  for(const change of [{completedTaskCount:-1},{completedCount:2},{range:{from:'2026-11-31',to:'2026-11-31'}},{domain:'habits'}])expect(completedTasksReply(data(change),today)).toBeUndefined();
});
it('counts a repeated task once while retaining both real completion events',()=>{
  const task:LifeOpsTask={id:'fictional-repeat',title:'虚构重复任务',status:'active',date:today,createdAt:'2026-11-26T08:00:00+08:00',completionLog:[{completedAt:'2026-11-26T09:00:00+08:00',note:''},{completedAt:'2026-11-26T10:00:00+08:00',note:''}],
    priority:'none',quadrant:'important-not-urgent',category:'work',project:'',endDate:'',time:'',dueDate:'',dueTime:'',repeatUnit:'day',repeatInterval:1,repeatUntil:'',parentTaskId:'',note:'',source:'manual',sourceNotePath:'',updatedAt:'',completedAt:'',sortOrder:0};
  const result=getStats({domain:'tasks',range:'today'},{tasks:[task]},new Date('2026-11-26T12:00:00+08:00'));
  expect(result).toMatchObject({completedCount:2,completedTaskCount:1});
  expect(completedTasksReply(JSON.stringify(result),today)).toBe('今天已完成 1 个任务（共 2 次完成记录）。');
});
