import {expect,it} from 'vitest';
import {resolveStatsRange,type StatsRange} from '../src/features/stats/stats';
import {resolveSummaryRange} from '../src/features/summaries/periods';

const now=new Date(2026,10,26,9);
it('uses the exact encoded from/to range for statistics and original-summary reads',()=>{
 const range={from:'2026-10-26',to:'2026-11-08'},encoded=JSON.stringify(range) as StatsRange;
 expect(resolveStatsRange(encoded,now)).toEqual(range);
 expect(resolveSummaryRange(encoded,now)).toEqual(range);
});
it.each([
 '{"from":"2026-02-30","to":"2026-11-08"}',
 '{"from":"2026-11-09","to":"2026-11-08"}',
 '{"from":"2026-10-26","to":"2026-11-08","paths":["other"]}',
 '{"from":20261026,"to":"2026-11-08"}',
 '{"from":"2026-10-26"}',
 '{broken}',
 '{"from":"'+ 'x'.repeat(256) +'","to":"2026-11-08"}',
 '[]', 'null'
])('keeps invalid, widened or non-date JSON ranges rejected: %s',range=>{
 expect(()=>resolveStatsRange(range as StatsRange,now)).toThrow();
});
it('retains the summary one-year bound after decoding',()=>{
 expect(()=>resolveSummaryRange('{"from":"2024-10-26","to":"2026-11-08"}' as StatsRange,now)).toThrow('一年');
});
it('retains existing named and ISO interval ranges',()=>{
 expect(resolveStatsRange('last_week',now)).toEqual({from:'2026-11-16',to:'2026-11-22'});
 expect(resolveStatsRange('2026-10-26..2026-11-08',now)).toEqual({from:'2026-10-26',to:'2026-11-08'});
});
