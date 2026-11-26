import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
import type {EvalQuestion} from './eval/scoring';
import type {EvalResult} from './eval/report';
import {paraphraseCases,paraphraseReport} from './eval/paraphrases';

const originals=JSON.parse(await readFile('tests/eval/questions.json','utf8')) as EvalQuestion[];
const pairs=JSON.parse(await readFile('tests/eval/paraphrases.json','utf8'));
const ids=['today-unfinished-01','today-priority-02','today-overload-03','create-client-06','weekend-haircut-07',
 'week-habits-09','undo-last-12','greeting-15','today-completed-16','monthly-task-rate-17','stalled-manga-idea-30',
 'undo-after-compensation-41','recent-state-direct-42','recent-state-correction-43','short-acknowledgement-44',
 'short-correction-45','undo-after-automatic-memory-47','voice-count-period-correction-48','voice-bare-undo-49',
 'voice-delete-after-undo-50','voice-named-reminder-51','today-due-and-overdue-52','device-sleep-55','undo-recent-modification-65'];

it('covers the audited24 questions and copies all original checks and setup into both everyday rewrites',()=>{
 const before=JSON.stringify(originals),cases=paraphraseCases(originals,pairs);
 expect(cases).toHaveLength(72);expect(cases.filter(row=>!row.variant).map(row=>row.baseId)).toEqual(ids);
 for(const row of cases){
  const original=originals.find(question=>question.id===row.baseId)!;
  expect({...row.question,id:original.id,input:original.input}).toEqual(original);
  expect(row.question.checks).not.toBe(original.checks);
  expect(row.checksSha256).toMatch(/^[a-f0-9]{64}$/);
 }
 cases[1].question.checks.maxConfirmations=999;expect(JSON.stringify(originals)).toBe(before);
});

it.each(['missing','duplicate','unknown','same-input','extra-checks','invalid-input'])('refuses a malformed %s sidecar instead of weakening an original',mode=>{
 const bad=structuredClone(pairs);
 if(mode==='missing')bad.pop();
 if(mode==='duplicate')bad[1].id=bad[0].id;
 if(mode==='unknown')bad[0].id='fictional-unknown';
 if(mode==='same-input')bad[0].inputs[0]=originals[0].input;
 if(mode==='extra-checks')bad[0].checks={maxConfirmations:999};
 if(mode==='invalid-input')bad[0].inputs[1]=' ';
 expect(()=>paraphraseCases(originals,bad)).toThrow();
});

const result=(id:string,index:number):EvalResult=>({id,passed:index%3!==2,issues:index%3===2?['虚构失败保留']:[],totalMs:1,models:[],tools:[],requests:index%3===1?2:0,confirmationActions:[],transportFailures:0,
 route:{scope:'current-turn',kind:index%3===1?'model':index%3===2?'local-write-route':'local-read-only',productRequests:index%3===1?2:0,
  toolNames:[],taskChanges:{created:index%3===2?1:0,removed:0,updated:0}}});
it('compares original and rewrites using actual routes and task differences without a release score',()=>{
 const cases=paraphraseCases(originals,pairs),report=paraphraseReport(cases,cases.map((row,index)=>result(row.question.id,index)));
 expect(report.text).toContain('本地只读工具路线');expect(report.text).toContain('模型作答');expect(report.text).toContain('本地写入工具路线');
 expect(report.text).toContain('虚构失败保留');expect(report.text).toContain('1/0/0');
 expect(report.data).toMatchObject({releaseGate:false,groups:24,originalChecksCopied:true});
});
it('refuses incomplete, duplicate or unmeasured comparisons',()=>{
 const cases=paraphraseCases(originals,pairs),results=cases.map((row,index)=>result(row.question.id,index));
 expect(()=>paraphraseReport(cases,results.slice(1))).toThrow();
 const duplicate=structuredClone(results);duplicate[1].id=duplicate[0].id;expect(()=>paraphraseReport(cases,duplicate)).toThrow();
 const unmeasured=structuredClone(results);delete unmeasured[0].route;expect(()=>paraphraseReport(cases,unmeasured)).toThrow();
});
