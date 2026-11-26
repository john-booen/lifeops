import{expect,it}from'vitest';
import{futureCalendarReference,futureCalendarConflicts}from'../src/agent/futureCalendar';
import{historicalAnswerMessages}from'../src/agent/historicalAnswer';
const now='2026-11-12T12:00:00Z';
it('computes next week from the current day rather than the historical query end',()=>{
 expect(futureCalendarReference(now)).toMatchObject({today:'2026-11-12',nextWeek:{from:'2026-11-16',to:'2026-11-22',weekdays:{周三:'2026-11-18'}}});
 expect(futureCalendarConflicts('**下一步（建议）**：下周三（2026-11-11）19:30归档。',now)).toMatchObject([{reportedDate:'2026-11-11',calendarDate:'2026-11-18'}]);
 expect(futureCalendarConflicts('**下一步（建议）**：下周三（2026-11-18）19:30归档。',now)).toEqual([]);
 expect(futureCalendarConflicts('下一步：下周三（2026-11-40）归档。',now)).toMatchObject([{reportedDate:'2026-11-40',calendarDate:'2026-11-18'}]);
});
it('retains year boundaries and date shorthand',()=>{
 const asOf='2026-12-31T12:00:00Z';expect(futureCalendarReference(asOf)?.nextWeek.weekdays.周三).toBe('2027-01-06');
 expect(futureCalendarConflicts('下一步（建议）：下周三（01-06）归档。',asOf)).toEqual([]);
 expect(futureCalendarConflicts('下一步（建议）：下周三（1月6日）归档。',asOf)).toEqual([]);
 expect(futureCalendarConflicts('下一步（建议）：下周天（2027-01-09）归档。',asOf)).toMatchObject([{calendarDate:'2027-01-10'}]);
});
it.each([undefined,'','invalid'])('does not invent a current calendar: %s',asOf=>{
 expect(futureCalendarReference(asOf)).toBeUndefined();expect(futureCalendarConflicts('下一步：下周三（2026-11-11）归档。',asOf)).toEqual([]);
});
it('does not reinterpret historical quoted next-week words, or add a date to undated advice',()=>{
 expect(futureCalendarConflicts('11月4日原话：“下周三（2026-11-11）归档”。\n下一步（建议）：下周三19:30归档。',now)).toEqual([]);
});
it('keeps calendar reference separate from original evidence and current personal records',()=>{
 const messages=historicalAnswerMessages([{role:'user',content:'回顾两周并给下周建议。'}],{asOf:now,currentPlanningContext:'周三19:30，25分钟。'});
 const calendar=messages.find(message=>message.content.startsWith('未来建议的日历参照'))!;
 expect(JSON.parse(calendar.content.slice(calendar.content.indexOf('\n')+1))).toMatchObject({scope:'future_calendar_reference_only',today:'2026-11-12'});
 expect(calendar.content).not.toContain('25分钟');expect(calendar.content).toContain('不是历史证据');
});

it.each(['## 下一步（建议）','### **下一步（建议）**'])('accepts Markdown advice headings without promoting dates into historical evidence: %s',async heading=>{
 const {unreadHistoricalDates}=await import('../src/agent/historicalAnswer');
 const answer='历史来源2026-11-04。\n'+heading+'\n建议下周三（2026-11-18）19:30做25分钟。';
 const messages=[{role:'user' as const,content:'回顾2026-11-04，给出下一步建议。'}];
 expect(unreadHistoricalDates(messages,answer,messages[0].content,now)).toEqual([]);
 expect(futureCalendarConflicts(answer,now)).toEqual([]);
 expect(futureCalendarConflicts(answer.replace('2026-11-18','2026-11-11'),now)).toMatchObject([{calendarDate:'2026-11-18'}]);
 expect(unreadHistoricalDates(messages,'历史事实2026-11-18。\n'+heading+'\n建议归档。',messages[0].content,now)).toEqual(['2026-11-18']);
});
