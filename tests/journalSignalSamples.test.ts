import {expect,it} from 'vitest';
import {getStats,type JournalStatsEntry} from '../src/features/stats/stats';
const range={from:'2026-11-09',to:'2026-11-12'},now=new Date('2026-11-12T20:00:00+08:00');
it('distinguishes eight diary records from six numeric samples on three days without changing the existing mean',()=>{
 const journal:JournalStatsEntry[]=['09','10','11','12'].flatMap(day=>[0,1].map(()=>({date:'2026-11-'+day,...(day==='09'?{}:{signals:{sleepHours:5.5}})})));
 const result=getStats({domain:'journal',range},{journal},now);
 expect(result).toMatchObject({count:8,journalDays:4,signalAverages:{sleepHours:5.5},signalSamples:{sleepHours:{records:6,days:3,diaryRecordsMissingValue:2,diaryDaysMissingValue:1}}});
});
it('counts a recorded zero while leaving absent and nonfinite values unknown for each individual signal',()=>{
 const journal:JournalStatsEntry[]=[{date:'2026-11-10',signals:{energy:0,mood:3}},{date:'2026-11-10',signals:{energy:4,mood:NaN}},{date:'2026-11-11',signals:{energy:Infinity}},{date:'2026-11-12'}];
 expect(getStats({domain:'journal',range},{journal},now)).toMatchObject({count:4,journalDays:3,signalAverages:{energy:2,mood:3,sleepHours:null},
  signalSamples:{energy:{records:2,days:1,diaryRecordsMissingValue:2,diaryDaysMissingValue:2},mood:{records:1,days:1,diaryRecordsMissingValue:3,diaryDaysMissingValue:2},sleepHours:{records:0,days:0,diaryRecordsMissingValue:4,diaryDaysMissingValue:3}}});
});
it('keeps record-weighted means and distinct dates separate for daily and weekly groups across a month boundary',()=>{
 const journal:JournalStatsEntry[]=[{date:'2026-10-31',signals:{energy:2}},{date:'2026-10-31',signals:{energy:4}},{date:'2026-11-01'},{date:'2026-11-02',signals:{energy:6}},{date:'2026-11-03',signals:{energy:100}}];
 const request={domain:'journal' as const,range:{from:'2026-10-31',to:'2026-11-02'}};
 expect(getStats({...request,groupBy:'day'},{journal},now)).toMatchObject({signalAverages:{energy:4},signalSamples:{energy:{records:3,days:2}},groups:[
  {date:'2026-10-31',journalDays:1,signalAverages:{energy:3},signalSamples:{energy:{records:2,days:1}}},
  {date:'2026-11-01',journalDays:1,signalAverages:{energy:null},signalSamples:{energy:{records:0,days:0}}},
  {date:'2026-11-02',journalDays:1,signalAverages:{energy:6},signalSamples:{energy:{records:1,days:1}}}]});
 expect(getStats({...request,groupBy:'week'},{journal},now)).toMatchObject({count:4,journalDays:3,groups:[
  {date:'2026-10-26',count:3,journalDays:2,signalSamples:{energy:{records:2,days:1,diaryDaysMissingValue:1}}},
  {date:'2026-11-02',count:1,journalDays:1,signalSamples:{energy:{records:1,days:1}}}]});
});
it('reports an empty denominator without claiming zero sleep or all requested days had diaries',()=>{
 expect(getStats({domain:'journal',range},{},now)).toMatchObject({count:0,journalDays:0,signalAverages:{sleepHours:null},signalSamples:{sleepHours:{records:0,days:0,diaryRecordsMissingValue:0,diaryDaysMissingValue:0}}});
});
