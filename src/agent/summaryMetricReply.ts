import type{ChatMessage}from'../ai';import{formatDate,addDays}from'../date';import{summaryPeriod}from'../features/summaries/periods';import{summaryMetricNames,type SummaryMetrics}from'../features/summaries/notes';
type Metric=keyof SummaryMetrics;
type Row={period:string;from:string;through:string;metrics:Partial<SummaryMetrics>;selected:boolean;conflicted?:boolean};
export type SummaryMetricConflict={period:string;metric:string;expected?:number|null;reported?:string;reason:string};
const labels:Record<Metric,string>={tasksCompleted:'任务完成数（项）',taskCompletionEvents:'完成登记次数',taskCompletionPercent:'计划完成率（%）',energy:'精力',tradePnlCny:'人民币净盈亏（CNY）',tradePnlUsd:'美元净盈亏（USD）'};
const clean=(s:string)=>s.replace(/[*`_]/g,'').trim();
function records(messages:ChatMessage[],question=''):Row[]{
 if(question){for(let i=messages.length-1;i>=0;i--)if(messages[i].role==='user'&&messages[i].content===question){messages=messages.slice(i);break;}}
 const ids=new Set(messages.flatMap(m=>m.tool_calls??[]).filter(c=>c.function.name==='get_summaries').map(c=>c.id)),rows=new Map<string,Row>();
 for(const m of messages){if(m.role!=='tool'||!ids.has(m.tool_call_id??''))continue;try{const data=JSON.parse(m.content);for(const item of Array.isArray(data.summaries)?data.summaries:[]){
  if(!/^(?:\d{4}-\d{2}(?:-\d{2})?|\d{4}-W\d{2})$/.test(item?.period??'')||!/^\d{4}-\d{2}-\d{2}$/.test(item.from??'')||!/^\d{4}-\d{2}-\d{2}$/.test(item.through??'')||item.from>item.through||!item.metrics||typeof item.metrics!=='object')continue;
  const metrics:Partial<SummaryMetrics>={};for(const key of summaryMetricNames)if(Object.hasOwn(item.metrics,key)&&(item.metrics[key]===null||typeof item.metrics[key]==='number'&&Number.isFinite(item.metrics[key])))metrics[key]=item.metrics[key];
  const before=rows.get(item.period),selected=Array.isArray(data.requestedMetrics);if(!before){rows.set(item.period,{period:item.period,from:item.from,through:item.through,metrics,selected});continue;}
  if(before.from!==item.from||before.through!==item.through)before.conflicted=true;
  for(const key of summaryMetricNames)if(Object.hasOwn(metrics,key)){if(Object.hasOwn(before.metrics,key)&&before.metrics[key]!==metrics[key])before.conflicted=true;else before.metrics[key]=metrics[key];}before.selected&&=selected;
 }}catch{/* Only actual typed readbacks can provide numerical evidence. */}}
 return[...rows.values()].sort((a,b)=>a.from.localeCompare(b.from)||a.period.localeCompare(b.period));
}
function metric(text:string):Metric|undefined{
 const s=clean(text);if(/(?:完成登记次数|完成记录次数|taskCompletionEvents)/iu.test(s))return'taskCompletionEvents';
 if(/(?:任务完成率|计划完成率|taskCompletionPercent)/iu.test(s))return'taskCompletionPercent';
 if(/(?:任务完成数|完成任务数|已完成任务|任务数|tasksCompleted)/iu.test(s))return'tasksCompleted';
 if(/(?:人民币|CNY|RMB)/iu.test(s)&&!/(?:SGD|美元)/iu.test(s))return'tradePnlCny';
 if(/(?:美元|USD)/iu.test(s)&&!/(?:SGD|人民币|CNY)/iu.test(s))return'tradePnlUsd';
 if(/(?:精力|energy)/iu.test(s))return'energy';return;
}
function aliases(row:Row,all:Row[],now?:Date){
 const result=[row.from+' 至 '+row.through,row.from+'—'+row.through,row.from+'–'+row.through];let match=row.period.match(/^(\d{4})-(\d{2})$/);if(match){const[y,m]=[match[1],String(Number(match[2]))];result.push(y+'年'+m+'月',y+'年'+match[2]+'月');if(all.filter(r=>r.period.endsWith('-'+match![2])&&r.period.length===7).length===1)result.push(m+'月');if(now){const date=formatDate(now);if(row.period===date.slice(0,7))result.push('本月','这个月');if(row.period===addDays(date.slice(0,8)+'01',-1).slice(0,7))result.push('上月','上个月');}}
 match=row.period.match(/^(\d{4})-W(\d{2})$/);if(match){result.push('W'+match[2],match[1]+'年第'+Number(match[2])+'周');if(now){const date=formatDate(now);if(row.period===summaryPeriod('week',date).key)result.push('本周','这周');if(row.period===summaryPeriod('week',addDays(date,-7)).key)result.push('上周');}}
 return result;
}
function period(text:string,all:Row[],now?:Date){
 const s=clean(text),direct=all.filter(row=>new RegExp('(?:^|[^0-9A-Za-z])'+row.period+'(?![0-9A-Za-z-])','u').test(s));if(direct.length)return direct.length===1?direct[0]:undefined;
 const found=all.filter(row=>aliases(row,all,now).some(alias=>{const index=s.indexOf(alias);return index>=0&&!(alias.endsWith('月')&&/^\d{1,2}[日号]/u.test(s.slice(index+alias.length)));}));return found.length===1?found[0]:undefined;
}
/** Check generated value attribution, never infer user intent or recalculate metrics. */
export function summaryMetricConflicts(messages:ChatMessage[],answer:string,question='',now?:Date):SummaryMetricConflict[]{
 const rows=records(messages,question);if(!rows.length)return[];const conflicts:SummaryMetricConflict[]=[],seen=new Set<string>();
 for(const row of rows)if(row.conflicted)conflicts.push({period:row.period,metric:'source',reason:'同一期间读回了不一致的指标或截至日期'});
 const verify=(row:Row,key:Metric,cell:string)=>{
  const expected=row.metrics[key],value=clean(cell),match=value.replace(/,/g,'').match(/[-+−]?\d+(?:\.\d+)?/),id=row.period+':'+key;seen.add(id);
  if(expected===undefined){conflicts.push({period:row.period,metric:key,reported:value,reason:'本轮未读回该期间的该指标'});return;}
  if(expected===null){if(match)conflicts.push({period:row.period,metric:key,expected,reported:value,reason:'未知指标被写成数值'});return;}
  const received=match?Number(match[0].replace('−','-')):NaN,places=match?.[0].split('.')[1]?.length??0,tolerance=key==='tasksCompleted'||key==='taskCompletionEvents'?0:0.5*10**-Math.max(places,key==='tradePnlCny'||key==='tradePnlUsd'?2:1);
  if(!Number.isFinite(received)||Math.abs(received-expected)>tolerance+1e-9)conflicts.push({period:row.period,metric:key,expected,reported:value,reason:'数值与所属期间/指标不一致'});
 };
 let columns:Array<Row|undefined>=[],fields:Array<Metric|undefined>=[],inTable=false,current:Row|undefined,advice=false;
 for(const raw of answer.split('\n')){
  if(advice)continue;const text=clean(raw);if(/^(?:#{1,6}\s*)?(?:下一步|建议|改进)/u.test(text)){current=undefined;columns=[];fields=[];inTable=false;advice=true;continue;}
  if(raw.includes('|')){
   const cells=raw.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(clean);if(cells.every(c=>/^:?-{2,}:?$/.test(c)))continue;
   const mapped=cells.map(c=>period(c,rows,now)),named=cells.map(metric);
   if(mapped.some((r,i)=>i>0&&r)){columns=mapped;fields=[];inTable=true;continue;}
   if(named.some((r,i)=>i>0&&r)){fields=named;columns=[];inTable=true;continue;}
   const key=metric(cells[0]??''),row=period(cells[0]??'',rows,now);
   if(key&&columns.length)columns.forEach((p,i)=>{if(p)verify(p,key,cells[i]??'');});
   else if(row&&fields.length)fields.forEach((k,i)=>{if(k)verify(row,k,cells[i]??'');});continue;
  }
  if(inTable){columns=[];fields=[];inTable=false;}
  const row=period(text,rows,now);if(row)current=row;
  const key=metric(text);if(key&&current){const part=text.split(/[：:]/).at(-1)!;if(part!==text)verify(current,key,part);}
 }
 // A deliberately selected multi-period numeric view must account for each
 // returned field. An opaque comparison gets one bounded rewrite, then facts.
 if(rows.length>1&&rows.every(r=>r.selected))for(const row of rows)for(const key of summaryMetricNames)if(Object.hasOwn(row.metrics,key)&&!seen.has(row.period+':'+key))conflicts.push({period:row.period,metric:key,expected:row.metrics[key],reason:'未能核对该指标与期间的对应，请明确列出期间表头与指标行'});
 return conflicts.slice(0,40);
}
export function summaryMetricEvidence(messages:ChatMessage[],question=''):string{
 const rows=records(messages,question).filter(r=>r.selected&&!r.conflicted);if(!rows.length)return'';const keys=summaryMetricNames.filter(k=>rows.some(r=>Object.hasOwn(r.metrics,k)));if(!keys.length)return'';
 return'以下数字直接来自本轮摘要工具读回，按各自期间列出：\n\n| 指标 | '+rows.map(r=>r.period+'（'+r.from+' 至 '+r.through+'）').join(' | ')+' |\n|---|'+rows.map(()=>'---:').join('|')+'|\n'+keys.map(k=>'| '+labels[k]+' | '+rows.map(r=>typeof r.metrics[k]==='number'?String(r.metrics[k]):'暂不可核对').join(' | ')+' |').join('\n')+'\n\n摘要是二手记录；未登记活动未知，当前未结束期间只统计到各列表头日期。';
}
