import {expect,it} from 'vitest';
import {currentEvaluationRoute} from './eval/routes';
const safety=(name:string)=>name==='read'?'safe' as const:name==='write'?'direct-write' as const:undefined;
it('separates a local current read from model calls in its prelude',()=>{
  const route=currentEvaluationRoute({requestsBefore:3,requestsAfter:3,toolNames:['read'],before:[{id:'prior'}],after:[{id:'prior'}],safety});
  expect(route).toMatchObject({kind:'local-read-only',productRequests:0,taskChanges:{created:0,removed:0,updated:0}});
});
it('shows a held write route without claiming tasks were saved',()=>{
  expect(currentEvaluationRoute({requestsBefore:0,requestsAfter:0,toolNames:['write'],before:[],after:[],safety}))
    .toMatchObject({kind:'local-write-route',taskChanges:{created:0,removed:0,updated:0}});
  expect(currentEvaluationRoute({requestsBefore:0,requestsAfter:0,toolNames:['confirm'],before:[],after:[],safety:()=> 'ui-confirm'}))
    .toMatchObject({kind:'local-write-route',taskChanges:{created:0,removed:0,updated:0}});
});
it('reports actual task changes separately even when no current model request was made',()=>{
  const before=[{id:'remove',title:'虚构删除'},{id:'edit',title:'虚构原名'}],after=[{id:'edit',title:'虚构改名'},{id:'new',title:'虚构新建'}];
  expect(currentEvaluationRoute({requestsBefore:2,requestsAfter:2,toolNames:[],before,after,safety}))
    .toMatchObject({kind:'local-write-route',taskChanges:{created:1,removed:1,updated:1}});
});
it('does not infer policy for unknown tools and refuses inconsistent counters',()=>{
  expect(currentEvaluationRoute({requestsBefore:1,requestsAfter:1,toolNames:['unknown'],before:[],after:[],safety}).kind).toBe('local-unknown');
  expect(currentEvaluationRoute({requestsBefore:1,requestsAfter:1,toolNames:['blocked'],before:[],after:[],safety:()=> 'forbidden'}).kind).toBe('local-unknown');
  expect(()=>currentEvaluationRoute({requestsBefore:2,requestsAfter:1,toolNames:[],before:[],after:[],safety})).toThrow('backwards');
});
