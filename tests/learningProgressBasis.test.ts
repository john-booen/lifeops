import {expect,it} from 'vitest';
import {learningProgress,type LearningTrack} from '../src/features/learning/model';

it('counts this week from registered units even when next week has a different plan',()=>{
  const units=Array.from({length:8},(_,i)=>({id:`fictional-unit-${i}`,title:`虚构单元${i}`,status:i<2?'done' as const:'todo' as const}));
  const track:LearningTrack={id:'english',name:'虚构英语',goal:'虚构目标',folders:[],weeklyMinutes:150,units,
    sessions:[{date:'2026-11-10',minutes:45},{date:'2026-11-11',minutes:30},{date:'2026-11-17',minutes:90}],
    nextPlan:{from:'2026-11-16',goal:'虚构下周目标',folders:[],weeklyMinutes:100,units:Array.from({length:10},(_,i)=>({id:`fictional-next-${i}`,title:`虚构下周${i}`,status:'todo'}))}};
  const before=structuredClone(track),progress=learningProgress(track,new Date('2026-11-12T12:00:00+08:00'));
  expect(progress).toMatchObject({completedUnits:2,totalUnits:8,completionPercent:25,unitCountBasis:'current_registered_units',unitProgressLabel:'2/8 单元（25%）',recordedMinutes:75,weeklyMinutes:150,nextWeek:{weeklyMinutes:100}});
  expect(progress.nextWeek.remaining).toHaveLength(10);expect(track).toEqual(before);
});
it('does not invent a denominator or zero percent when no units have been registered',()=>{
  const result=learningProgress({id:'ai',name:'虚构AI',goal:'',folders:[],weeklyMinutes:0,units:[],sessions:[]},new Date('2026-11-12T12:00:00+08:00'));
  expect(result).toMatchObject({completedUnits:0,totalUnits:0,completionPercent:null,unitProgressLabel:'尚未登记学习单元，完成率未知',weeklyMinutes:null});
});
