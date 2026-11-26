import { expect, it } from "vitest";
import type { AiToolCall } from "../src/ai";
import { bindHistoricalDateReference } from "../src/agent/historicalDateReference";
import type { SummaryQueryRange } from "../src/agent/summaryQueryScope";
const selection: SummaryQueryRange = { level: "day", range: { from: "2026-10-26", to: "2026-11-08" } };
const call: AiToolCall = { id: "fictional-wrong-range", name: "get_summaries", arguments: {
  level: "week", range: { from: "2026-11-02", to: "2026-11-12" }, includeOriginals: true, query: "纸样" } };
it.each(["按刚更正的时间，接着这两周给一条下周建议。", "继续这两个星期的回顾", "用刚才的日期范围", "继续上述区间"])("binds a date reference to the checked selection: %s", message => {
  const before = JSON.stringify([call, selection]), [bound] = bindHistoricalDateReference([call], message, [selection]);
  expect(bound.arguments).toEqual({ ...call.arguments, ...selection });
  expect(bound.id).not.toBe(call.id); expect(JSON.stringify([call, selection])).toBe(before);
});
it.each(["接着这两周，改看2025-10-26至2025-11-08", "不看这两周，改看上周", "改为上个月，不用刚才的范围", "这两周中的第二周", "先看最近七天，再比较上述范围", "写一段问候"])("preserves explicit new, partial or unrelated requests: %s", message => {
  expect(bindHistoricalDateReference([call], message, [selection])).toEqual([call]);
});
it("keeps both sides of a checked comparison and never changes write calls", () => {
  const earlier: SummaryQueryRange = { level: "week", range: { from: "2026-10-12", to: "2026-10-25" } };
  const write = { ...call, name: "reschedule_task" };
  const result = bindHistoricalDateReference([call, write], "接着上述范围", [earlier, selection]);
  expect(result.map(row => row.arguments.range)).toEqual([earlier.range, selection.range, call.arguments.range]);
  expect(result[2]).toBe(write); expect(new Set(result.map(row => row.id)).size).toBe(3);
  expect(bindHistoricalDateReference([call], "接着这两周", [])).toEqual([call]);
});

const asOf=new Date('2026-11-23T12:00:00+08:00');
it.each(['tasks','habits','trades','journal','ideas','learning','health'])('binds %s statistics to the owned dates without changing the domain or grouping',domain=>{
 const stats:AiToolCall={id:'fictional-stats-'+domain,name:'get_stats',arguments:{domain,range:'last_week',groupBy:'day'}};
 const before=JSON.stringify(stats),[result]=bindHistoricalDateReference([stats],'接着这两周的登记统计',[selection],asOf);
 expect(result.name).toBe('get_stats');expect(result.arguments).toEqual({...stats.arguments,range:selection.range});expect(result.arguments).not.toHaveProperty('level');expect(JSON.stringify(stats)).toBe(before);
});
it('keeps both comparison periods, removes repeated equivalent statistics, and preserves a separate future planning read',()=>{
 const earlier:SummaryQueryRange={level:'week',range:{from:'2026-10-12',to:'2026-10-25'}};
 const first:AiToolCall={id:'fictional-stats-one',name:'get_stats',arguments:{domain:'tasks',range:'last_week',groupBy:'week'}};
 const second:AiToolCall={id:'fictional-stats-two',name:'get_stats',arguments:{groupBy:'week',range:'last_7d',domain:'tasks'}};
 const future:AiToolCall={id:'fictional-future-stats',name:'get_stats',arguments:{domain:'tasks',range:{from:'2026-11-30',to:'2026-12-06'}}};
 const write:AiToolCall={id:'fictional-untouched-write',name:'create_task',arguments:{title:'虚构未来安排',date:'2026-11-30'}};
 const result=bindHistoricalDateReference([first,second,future,write],'接着这两周回顾，再给下周安排建议。',[earlier,selection],asOf);
 expect(result).toHaveLength(4);expect(result.slice(0,2).map(row=>row.arguments.range)).toEqual([earlier.range,selection.range]);
 expect(result[2]).toBe(future);expect(result[3]).toBe(write);expect(new Set(result.map(row=>row.id)).size).toBe(4);
});
it.each(['改看2026年11月2日至12日','这两周中的第二周','不用刚才的范围，改看上个月'])('keeps an explicit new or partial statistics selection: %s',message=>{
 const stats:AiToolCall={id:'fictional-specific-stats',name:'get_stats',arguments:{domain:'tasks',range:{from:'2026-11-02',to:'2026-11-12'}}};
 expect(bindHistoricalDateReference([stats],message,[selection],asOf)).toEqual([stats]);
});
it("re-reads the checked original range when the provider uses a broad journal search instead of summaries", () => {
  const search: AiToolCall = { id: "fictional-search", name: "query_vault", arguments: { domain: "journal", operation: "search", query: "纸样归档", range: "all", limit: 10 } };
  const [bound] = bindHistoricalDateReference([search], "接着这两周给一条下周建议", [selection]);
  expect(bound.name).toBe("get_summaries"); expect(bound.arguments).toEqual({ ...selection, includeOriginals: true, query: "纸样归档" });
  for (const extra of [{ operation: "get", path: "specific.md" }, { offset: 3 }, { domain: "memory" }, { limit: 0 }, { query: "x".repeat(121) }, { range: "year" }]) {
    const specific = { ...search, arguments: { ...search.arguments, ...extra } };
    expect(bindHistoricalDateReference([specific], "接着这两周", [selection])).toEqual([specific]);
  }
});
