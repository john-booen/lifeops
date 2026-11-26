import {createHash} from 'node:crypto';
import type {EvalQuestion} from './scoring';
import type {EvalResult} from './report';
import {evaluationRouteLabels} from './routes';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ParaphraseCase {question:EvalQuestion;baseId:string;variant:0|1|2;checksSha256:string}

/** A sidecar changes only the input and display ID. All fixtures, histories,
 * preludes, voice modes and checks remain exact copies of the original. */
export function paraphraseCases(questions:EvalQuestion[],sidecar:unknown):ParaphraseCase[]{
 if(!Array.isArray(sidecar)||sidecar.length!==24)throw Error('Expected exactly24 paraphrase groups');
 const ids=new Set<string>(),cases:ParaphraseCase[]=[];
 for(const row of sidecar){
  if(!row||typeof row!=='object'||Object.keys(row).sort().join(',')!=='id,inputs'
   ||typeof row.id!=='string'||ids.has(row.id)||!Array.isArray(row.inputs)||row.inputs.length!==2
   ||row.inputs.some((input:unknown)=>typeof input!=='string'||!input.trim()||input.length>500))throw Error('Invalid paraphrase group');
  const matches=questions.filter(question=>question.id===row.id);if(matches.length!==1)throw Error('Unknown or duplicate base question');
  const original=matches[0],inputs=[original.input,...row.inputs];if(new Set(inputs).size!==3)throw Error('Paraphrases must differ');
  ids.add(row.id);
  inputs.forEach((input,variant)=>cases.push({baseId:original.id,variant:variant as 0|1|2,checksSha256:digest(original.checks),
   question:{...structuredClone(original),input,id:variant?original.id+'::p'+variant:original.id}}));
 }
 return cases;
}

/** Never updates baseline/latest or substitutes for the original release gate. */
export function paraphraseReport(cases:ParaphraseCase[],results:EvalResult[]):{text:string;data:unknown}{
 if(cases.length!==72||results.length!==72||new Set(results.map(row=>row.id)).size!==72)throw Error('Incomplete paraphrase comparison');
 const cells=cases.map(item=>{
  const result=results.find(row=>row.id===item.question.id);if(!result?.route)throw Error('Missing actual current-turn route');
  return{...item,result};
 });
 const cell=(row:typeof cells[number])=>`${row.result.passed?'通过':'未过'} / ${evaluationRouteLabels[row.result.route!.kind]} / ${row.result.route!.productRequests}次`;
 const clean=(s:string)=>s.replace(/[|\r\n]/g,' ');
 const text=['# 日常改写句对照（独立诊断）','','24题各两种日常改写；原句也在相同源码重新运行，原检查、夹具、前序和语音模式逐项相同。',
  '这里只计本轮实际产品请求；本地写入工具路线与实际任务差分分列。失败照实保留，不据此写发布基线或拼接原86题成绩。','',
  '| 原题 | 原句：结果 / 路线 / 请求 | 改写一：结果 / 路线 / 请求 | 改写二：结果 / 路线 / 请求 |',
  '|---|---|---|---|',...cells.filter(row=>row.variant===0).map(row=>'| '+row.baseId+' | '+[0,1,2].map(variant=>cell(cells.find(other=>other.baseId===row.baseId&&other.variant===variant)!)).join(' | ')+' |'),
  '','| 句子编号 | 实际输入 | 任务新增/删除/更新 | 未过原因 |','|---|---|---|---|',
  ...cells.map(row=>`| ${row.question.id} | ${clean(row.question.input)} | ${Object.values(row.result.route!.taskChanges).join('/')} | ${clean(row.result.issues.join('；'))} |`)].join('\n')+'\n';
 return{text,data:{releaseGate:false,originalChecksCopied:true,groups:24,cases:cells}};
}
