import type {ToolSafetyLevel} from '../../src/toolRegistry';

export type EvaluationRouteKind = 'local-read-only'|'local-write-route'|'model'|'local-unknown';
export interface EvaluationRoute {
  scope:'current-turn';
  kind:EvaluationRouteKind;
  productRequests:number;
  toolNames:string[];
  taskChanges:{created:number;removed:number;updated:number};
}

/** Counter deltas exclude fixture/prelude calls; task changes are separate
 * from declared write tools, including writes that only proposed a card. */
export function currentEvaluationRoute(input:{requestsBefore:number;requestsAfter:number;toolNames:string[];
  before:readonly {id:string}[];after:readonly {id:string}[];
  safety:(name:string)=>ToolSafetyLevel|undefined}):EvaluationRoute {
  const productRequests=input.requestsAfter-input.requestsBefore;
  if(!Number.isSafeInteger(productRequests)||productRequests<0)throw Error('Product request counters moved backwards');
  const before=new Map(input.before.map(row=>[row.id,row])),after=new Map(input.after.map(row=>[row.id,row]));
  const taskChanges={created:[...after.keys()].filter(id=>!before.has(id)).length,
    removed:[...before.keys()].filter(id=>!after.has(id)).length,
    updated:[...after].filter(([id,row])=>before.has(id)&&JSON.stringify(before.get(id))!==JSON.stringify(row)).length};
  const policies=input.toolNames.map(input.safety);
  const kind:EvaluationRouteKind=productRequests?'model':Object.values(taskChanges).some(Boolean)||policies.some(value=>value==='direct-write'||value==='ui-confirm')
    ?'local-write-route':policies.some(value=>value===undefined||value==='forbidden')?'local-unknown':'local-read-only';
  return {scope:'current-turn',kind,productRequests,toolNames:[...input.toolNames],taskChanges};
}
export const evaluationRouteLabels:Record<EvaluationRouteKind,string>={
  'local-read-only':'本地只读工具路线','local-write-route':'本地写入工具路线',model:'模型作答','local-unknown':'本地路线未核实'
};
