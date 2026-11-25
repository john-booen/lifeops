import type {ChatMessage} from '../ai';
import {normalizeJournalDate} from '../date';
import {noteCalendar} from '../features/summaries/noteCalendar';

interface Source {date:string;path:string;text:string}
export interface HistoricalDateConflict {sourcePath:string;noteDate:string;quote:string;reportedDate:string;calendarDate:string;basis:string}

/** Check literal source quotations in event-date tables. This is an output
 * consistency check, not an intent route or an assertion about an ambiguous
 * narrator's time. A repair must reread the same evidence before deciding. */
export function historicalDateConflicts(messages:ChatMessage[],answer:string,question=''):HistoricalDateConflict[]{
 if(question){for(let index=messages.length-1;index>=0;index--)if(messages[index].role==='user'&&messages[index].content===question){messages=messages.slice(index);break;}}
 const calls=new Map(messages.flatMap(message=>message.tool_calls??[]).map(call=>[call.id,call.function]));
 const sources:Source[]=[];
 const add=(date:unknown,path:unknown,text:unknown)=>{
  if(typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&normalizeJournalDate(date)===date
   &&typeof path==='string'&&path&&typeof text==='string'&&text)sources.push({date,path,text});
 };
 for(const message of messages){
  if(message.role!=='tool')continue;const call=calls.get(message.tool_call_id??'');if(!call)continue;
  if(call.name==='get_summaries'){
   try{for(const row of JSON.parse(message.content).originalEvidence?.notes??[])add(row.date,row.path,row.text);}catch{/* Invalid output supplies no source. */}
  }else if(call.name==='query_vault'&&message.content.startsWith('### Journal Source\n')){
   try{const args=JSON.parse(call.arguments);if(args.domain!=='journal'||args.operation!=='get')continue;
    const end=message.content.indexOf('\n\n');if(end<0)continue;const header=message.content.slice(0,end);
    add(header.match(/^- date: (\d{4}-\d{2}-\d{2})$/mu)?.[1],header.match(/^- path: (.+)$/mu)?.[1],message.content.slice(end+2).split('### Journal Source\n',1)[0]);
   }catch{/* A failed call cannot define source identity. */}
  }
 }
 const conflicts=new Map<string,HistoricalDateConflict>();let dateColumn=-1;
 for(const line of answer.split('\n')){
  if(!line.trim().startsWith('|')){dateColumn=-1;continue;}
  const cells=line.trim().split('|').slice(1,-1).map(cell=>cell.trim());
  const heading=cells.findIndex(cell=>/(?:事件.*日期|发生.*日期)/u.test(cell));if(heading>=0){dateColumn=heading;continue;}
  if(dateColumn<0)continue;const dates=cells[dateColumn]?.match(/\b\d{4}-\d{2}-\d{2}\b/gu)??[];
  if(dates.length!==1||/[至到→—~～]/u.test(cells[dateColumn].replace(dates[0],'')))continue;
  const reportedDate=dates[0];
  for(const source of sources){
   const name=source.path.split('/').at(-1)!.replace(/\.md$/iu,'');if(!line.includes(source.path)&&!line.includes(name))continue;
   const calendar=noteCalendar(source.date);
   for(const match of source.text.matchAll(/(昨晚|昨天|今早|今天凌晨|今天|明天)\s*\d{1,2}:\d{2}[^，。；！？\n“”‘’"']{0,80}/gu)){
    const quote=match[0].trim(),calendarDate=calendar.relativeWords[match[1] as keyof typeof calendar.relativeWords];
    if(!line.includes(quote)||reportedDate===calendarDate)continue;
    const value={sourcePath:source.path,noteDate:source.date,quote,reportedDate,calendarDate,basis:calendar.basis};conflicts.set(JSON.stringify(value),value);
   }
  }
 }
 return [...conflicts.values()].slice(0,28);
}
