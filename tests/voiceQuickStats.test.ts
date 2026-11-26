import {expect,it} from 'vitest';
import {getStats} from '../src/features/stats/stats';
import {formatVoiceStats} from '../src/voice/quickStats';
import type {LifeOpsTask} from '../src/types';

const args={domain:'tasks',range:'this_month',voiceAnswer:'completed_tasks'};
it('speaks distinct task IDs rather than repeat completion events from the real statistics',()=>{
  const task={id:'fictional-voice-repeat',title:'虚构同名纸盒',date:'2026-11-01',status:'active',createdAt:'',
    completionLog:[{completedAt:'2026-11-02',note:''},{completedAt:'2026-11-03',note:''}]} as LifeOpsTask;
  const second={...task,id:'fictional-voice-other',completionLog:[{completedAt:'2026-11-04',note:''}]};
  const output=JSON.stringify(getStats({domain:'tasks',range:'this_month'},{tasks:[task,second]},new Date('2026-11-12T12:00:00+08:00')));
  expect(formatVoiceStats(output,args)).toBe('这个月已完成 2 个任务（共 3 次完成记录）。');
});

it.each([
  {completedCount:3},
  {completedTaskCount:-1,completedCount:3},
  {completedTaskCount:4,completedCount:3}
])('does not turn an unverified task count into a voice answer (%j)',metrics=>{
  expect(formatVoiceStats(JSON.stringify({domain:'tasks',...metrics}),args)).toBeUndefined();
});

it('keeps a measured zero and the readable-record scope',()=>{
  expect(formatVoiceStats(JSON.stringify({domain:'tasks',completedTaskCount:0,completedCount:0,scope:'partial'}),args))
    .toBe('这个月已完成 0 个任务。按允许读取的记录计算。');
});
