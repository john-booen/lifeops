// Fixed synthetic, first-response evaluation. Returned tools are recorded, never executed.
import assert from 'node:assert/strict';
import {readFile, writeFile, rename, mkdir, readdir, lstat, realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, join, dirname, basename} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';
import {execFileSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputRoot=join(root,'dist','daily-quality');
const phaseDay='20260922';
const firstBatch=`daily-quality-${phaseDay}-01`;
const batchNamePattern=/^daily-quality-20260922-(?:0[1-9]|[1-9][0-9]{1,3})$/;
export function resolveBatch(name=firstBatch,outputDir=outputRoot){
  assert.ok(typeof name==='string' && name===name.trim() && batchNamePattern.test(name),'Invalid evaluation batch basename');
  return join(resolve(outputDir),name);
}
export const batch=resolveBatch(process.env.LIFEOPS_EVAL_BATCH ?? firstBatch);
export const ENDPOINT='https://api.moonshot.cn/v1/chat/completions';
export const MODEL='kimi-k2.6';
export const LIMITS=Object.freeze({calls:8,cny:1,outputTokens:800,timeoutMs:45000,responseBytes:131072});
export const PRICE=Object.freeze({checked:'2026-09-22',input:6.5,output:27,source:'https://platform.kimi.com/docs/pricing/chat'});
export const sha=value=>createHash('sha256').update(value).digest('hex');
const rounded=n=>Number(n.toFixed(8));
const cost=(input,output)=>rounded((input*PRICE.input+output*PRICE.output)/1e6);

async function localBatch(dir,outputDir){
  const resolved=resolve(dir),base=resolve(outputDir);
  assert.equal(resolved,resolveBatch(basename(resolved),base),'Batch must be inside the project output directory');
  assert.equal(await realpath(base),base,'Output directory must not resolve elsewhere');
  assert.equal(await realpath(resolved),resolved,'Batch directory must not resolve elsewhere');
  assert.ok((await lstat(resolved)).isDirectory(),'Batch must be a regular directory');
  return resolved;
}
async function regularText(path){
  assert.ok((await lstat(path)).isFile(),'Evaluation evidence must be a regular file');
  return readFile(path,'utf8');
}
async function regularJson(path){return JSON.parse(await regularText(path));}

// Re-read the fixed phase authorization and every immutable same-day reservation.
// Stopped/failed batches retain their full reservation; reported spending never frees it.
export async function assertPhaseBudget(dir,outputDir=outputRoot){
  const base=resolve(outputDir),selected=await localBatch(dir,base);
  const anchor=await localBatch(join(base,firstBatch),base);
  const authorization=await regularJson(join(anchor,'phase-budget.json'));
  assert.equal(authorization.approved,true,'Phase authorization is required');
  assert.equal(authorization.max_cny,100,'Phase ceiling must remain 100 CNY');
  assert.equal(authorization.authorization_date,'2026-09-22','Phase authorization date changed');
  assert.equal(authorization.no_auto_topup,true,'Automatic budget top-up is forbidden');
  assert.ok(typeof authorization.authorization==='string' && authorization.authorization.trim().length>0,'Phase authorization evidence is required');
  let total=0,count=0,selectedFound=false;
  for(const entry of await readdir(base,{withFileTypes:true})){
    if(!batchNamePattern.test(entry.name))continue;
    assert.ok(entry.isDirectory(),'Same-day batch must be a regular directory');
    const candidate=await localBatch(join(base,entry.name),base);
    let plan;
    try{plan=await regularJson(join(candidate,'evaluation-plan.json'));}
    catch(e){
      if(e.code!=='ENOENT')throw e;
      const files=await readdir(candidate);
      assert.ok(!files.some(name=>name==='live-results.json'||/^attempt-.*\.started$/.test(name)),'Attempt evidence without a reserved plan');
      continue;
    }
    validatePlan(plan);total+=plan.reserve_cny;count++;
    if(candidate===selected)selectedFound=true;
  }
  assert.ok(selectedFound,'Current batch must have a reserved plan');
  total=rounded(total);
  assert.ok(total<=authorization.max_cny,'Same-day reservations exceed the 100 CNY phase ceiling');
  return {phase_max_cny:authorization.max_cny,total_reserved_cny:total,batch_count:count};
}

export function makePlan(preview, ids) {
  assert.equal(preview.synthetic,true);
  assert.equal(preview.schema_version,1);
  assert.ok(ids.length>0 && ids.length<=LIMITS.calls && new Set(ids).size===ids.length);
  const requests=ids.map(id=>{
    const item=preview.requests.find(item=>item.id===id);
    assert.ok(item,'Unknown fixture');
    const body=structuredClone(item.request.body);
    assert.equal(sha(JSON.stringify(body)),item.body_sha256,'Fixture body changed');
    assert.equal(body.model,MODEL);
    assert.ok(Array.isArray(body.messages) && body.messages.length>1);
    assert.deepEqual(body.thinking,{type:'disabled'});
    assert.ok(!body.n || body.n===1);
    assert.ok(Number.isSafeInteger(body.max_tokens) && body.max_tokens>0);
    const originalMaxTokens=body.max_tokens;
    body.stream=false;
    body.max_tokens=Math.min(originalMaxTokens,LIMITS.outputTokens);
    // Whole serialized body bytes plus framing is deliberately conservative;
    // includes tool definitions, not just user-visible message characters.
    const inputReserve=Buffer.byteLength(JSON.stringify(body),'utf8')+2048;
    return {id,title:item.title,user_message:item.user_message,provided_facts:item.provided_facts,
      criteria:item.criteria,allowed_tools:item.allowed_tools,original_body_sha256:item.body_sha256,
      changes:{stream:false,original_max_tokens:originalMaxTokens,evaluation_max_tokens:body.max_tokens},
      body,input_token_reserve:inputReserve,reserve_cny:cost(inputReserve,body.max_tokens)};
  });
  const reserve=rounded(requests.reduce((sum,r)=>sum+r.reserve_cny,0));
  assert.ok(reserve<=LIMITS.cny,'Conservative total exceeds 1 CNY; select a smaller reviewed batch');
  return {schema_version:1,status:'prepared_not_authorized',synthetic:true,endpoint:ENDPOINT,model:MODEL,
    limits:LIMITS,price:PRICE,reserve_cny:reserve,requests,
    scope:'First model response / tool selection only. No tool execution, multi-round product acceptance, devices or personal records.'};
}

export function validatePlan(plan) {
  assert.equal(plan.synthetic,true);assert.equal(plan.endpoint,ENDPOINT);assert.equal(plan.model,MODEL);
  assert.deepEqual(plan.limits,LIMITS);assert.deepEqual(plan.price,PRICE);
  assert.ok(plan.requests.length>0 && plan.requests.length<=LIMITS.calls);
  assert.equal(new Set(plan.requests.map(r=>r.id)).size,plan.requests.length);
  for(const r of plan.requests){
    assert.match(r.id,/^[a-z0-9-]+$/);assert.equal(r.body.model,MODEL);
    assert.equal(r.body.stream,false);assert.deepEqual(r.body.thinking,{type:'disabled'});
    assert.ok(!r.body.n || r.body.n===1,'Only one completion is budgeted');
    assert.ok(Object.keys(r.body).every(key=>['model','messages','thinking','max_tokens','stream','tools','tool_choice','n'].includes(key)),'Unexpected request option');
    assert.ok(Number.isSafeInteger(r.body.max_tokens) && r.body.max_tokens>0 && r.body.max_tokens<=LIMITS.outputTokens);
    assert.equal(r.input_token_reserve,Buffer.byteLength(JSON.stringify(r.body),'utf8')+2048);
    assert.equal(r.reserve_cny,cost(r.input_token_reserve,r.body.max_tokens));
  }
  assert.equal(plan.reserve_cny,rounded(plan.requests.reduce((sum,r)=>sum+r.reserve_cny,0)));
  assert.ok(plan.reserve_cny<=LIMITS.cny);
}

export function parseResponse(response, request, key='') {
  assert.equal(response?.model,MODEL,'Unexpected response model');
  assert.equal(response?.choices?.length,1);
  const choice=response.choices[0], rawMessage=choice.message;
  assert.ok(['stop','tool_calls'].includes(choice.finish_reason),'Response incomplete');
  assert.ok(rawMessage && !rawMessage.function_call,'Unsupported legacy tool response');
  const redact=text=>key ? text.replaceAll(key,'[REDACTED]') : text;
  const content=redact(typeof rawMessage.content==='string'?rawMessage.content:'');
  const toolCalls=(rawMessage.tool_calls ?? []).map(call=>{
    assert.equal(call.type,'function');assert.equal(typeof call.function?.name,'string');
    const args=JSON.parse(call.function.arguments);
    assert.ok(args && typeof args==='object' && !Array.isArray(args));
    return {name:redact(call.function.name),arguments:JSON.parse(redact(JSON.stringify(args)))};
  });
  assert.ok(toolCalls.length<=8);assert.ok(content.trim() || toolCalls.length,'Empty reply');
  const input=response.usage?.prompt_tokens,output=response.usage?.completion_tokens;
  assert.ok(Number.isSafeInteger(input) && input>0 && input<=request.input_token_reserve,'Input usage unverifiable');
  assert.ok(Number.isSafeInteger(output) && output>=0 && output<=request.body.max_tokens,'Output usage unverifiable');
  return {content,tool_calls:toolCalls,finish_reason:choice.finish_reason,
    usage:{prompt_tokens:input,completion_tokens:output},cost_cny_uncached:cost(input,output)};
}

export function assertReady(plan, digest, state, reviews, authorization, now=new Date()) {
  validatePlan(plan);
  assert.equal(authorization.approved,true,'New batch needs explicit authorization');
  assert.equal(authorization.plan_sha256,digest);assert.equal(authorization.max_calls,plan.requests.length);
  assert.equal(authorization.max_cny,LIMITS.cny);assert.equal(authorization.model,MODEL);
  assert.ok(typeof authorization.user_confirmation==='string' && authorization.user_confirmation.trim().length>0);
  assert.equal(state.plan_sha256,digest);assert.ok(Array.isArray(state.attempts));
  assert.ok(state.attempts.length<plan.requests.length,'All approved calls consumed');
  const checked=Date.parse(`${PRICE.checked}T00:00:00+08:00`);
  assert.ok(now.getTime()>=checked && now.getTime()-checked<48*3600000,'Refresh pricing before a later batch');
  let spent=0;
  for(const [i,a] of state.attempts.entries()){
    assert.equal(a.id,plan.requests[i].id);assert.equal(a.status,'responded','Uncertain attempt: never retry');
    assert.equal(a.response_sha256,sha(JSON.stringify(a.result)),'Stored response changed');
    const r=a.result;
    const parsed=parseResponse({model:MODEL,choices:[{finish_reason:r.finish_reason,message:{content:r.content,
      tool_calls:r.tool_calls.map(t=>({type:'function',function:{name:t.name,arguments:JSON.stringify(t.arguments)}}))}}],usage:r.usage},plan.requests[i]);
    assert.deepEqual(parsed,r,'Stored usage or cost changed');
    const matched=reviews.filter(v=>v.id===a.id);
    assert.equal(matched.length,1,'Exactly one semantic review needed');
    assert.equal(matched[0].response_sha256,a.response_sha256);assert.equal(matched[0].pass,true,'Review failed: stop batch');
    assert.ok(typeof matched[0].note==='string' && matched[0].note.trim().length>=10,'Review must explain evidence');
    spent+=r.cost_cny_uncached;
  }
  assert.ok(spent+plan.requests.slice(state.attempts.length).reduce((sum,r)=>sum+r.reserve_cny,0)<=LIMITS.cny);
}

async function saveState(dir,state){
  const temp=join(dir,'live-results.json.tmp');
  await writeFile(temp,JSON.stringify(state,null,2)+'\n',{flag:'wx',mode:0o600});
  await rename(temp,join(dir,'live-results.json'));
}
async function smallJson(response){
  assert.ok(response.body);const reader=response.body.getReader();let bytes=0;const parts=[];
  try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;assert.ok(bytes<=LIMITS.responseBytes);parts.push(Buffer.from(r.value));}}
  finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
async function optionalJson(path,fallback){try{return await regularJson(path);}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}

// Offline tests inject their own transport and directory. The CLI uses its fixed dist directory.
export async function runNext(dir,key,transport=fetch,now=new Date(),outputDir=outputRoot){
  await assertPhaseBudget(dir,outputDir);
  assert.ok(typeof key==='string' && key.length>=20 && !/[\r\n]/.test(key),'Missing session credential');
  const raw=await regularText(join(dir,'evaluation-plan.json')),digest=sha(raw),plan=JSON.parse(raw);
  const auth=await regularJson(join(dir,'authorization.json'));
  const state=await optionalJson(join(dir,'live-results.json'),{plan_sha256:digest,attempts:[]});
  const reviews=await optionalJson(join(dir,'reviews.json'),[]);
  assertReady(plan,digest,state,reviews,auth,now);
  const request=plan.requests[state.attempts.length];
  // Exclusive markers survive process crashes and concurrent runners. They are never removed.
  await writeFile(join(dir,`attempt-${request.id}.started`),now.toISOString(),{flag:'wx',mode:0o600});
  const attempt={id:request.id,status:'started',started_at:now.toISOString()};
  state.attempts.push(attempt);await saveState(dir,state);
  try{
    const response=await transport(ENDPOINT,{method:'POST',redirect:'error',signal:AbortSignal.timeout(LIMITS.timeoutMs),
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(request.body)});
    if(!response.ok){attempt.http_status=response.status;throw Error('HTTP failed');}
    const result=parseResponse(await smallJson(response),request,key);
    Object.assign(attempt,{status:'responded',result,response_sha256:sha(JSON.stringify(result)),finished_at:new Date().toISOString()});
    await saveState(dir,state);return {status:'awaiting_semantic_review',attempt};
  }catch(e){
    Object.assign(attempt,{status:'stopped_unverified',failure_class:e?.name==='TimeoutError'?'timeout':'request_or_response_rejected',finished_at:new Date().toISOString()});
    await saveState(dir,state);return {status:attempt.status,id:attempt.id,http_status:attempt.http_status,failure_class:attempt.failure_class};
  }
}

async function main(){
  const [mode='check',...args]=process.argv.slice(2);
  await localBatch(batch,outputRoot);
  if(mode==='prepare'){
    const preview=await regularJson(join(batch,'requests-preview.json'));
    const ids=args.length?args:preview.requests.map(r=>r.id);
    const plan=makePlan(preview,ids);await mkdir(batch,{recursive:true});
    const raw=JSON.stringify(plan,null,2)+'\n';
    await writeFile(join(batch,'evaluation-plan.json'),raw,{flag:'wx',mode:0o600});
    await writeFile(join(batch,'authorization.example.json'),JSON.stringify({approved:false,plan_sha256:sha(raw),model:MODEL,max_calls:ids.length,max_cny:1,user_confirmation:''},null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({status:'prepared_not_authorized',cases:ids.length,reserve_cny:plan.reserve_cny,plan_sha256:sha(raw),providerCalls:0}));return;
  }
  assert.ok(['check','live-session','review'].includes(mode),'Use prepare/check/live-session/review');
  const raw=await regularText(join(batch,'evaluation-plan.json')),plan=JSON.parse(raw);validatePlan(plan);
  if(mode==='check'){console.log(JSON.stringify({status:'validated_offline',cases:plan.requests.length,reserve_cny:plan.reserve_cny,plan_sha256:sha(raw),providerCalls:0,credentialRead:false}));return;}
  if(mode==='review'){
    const [decision,...words]=args;assert.ok(['pass','fail'].includes(decision));const note=words.join(' ');assert.ok(note.length>=10);
    const state=await regularJson(join(batch,'live-results.json'));assert.equal(state.plan_sha256,sha(raw));const attempt=state.attempts.at(-1);
    assert.equal(attempt?.status,'responded');assert.equal(attempt.response_sha256,sha(JSON.stringify(attempt.result)));
    const reviews=await optionalJson(join(batch,'reviews.json'),[]);assert.ok(!reviews.some(r=>r.id===attempt.id),'Already reviewed');
    reviews.push({id:attempt.id,response_sha256:attempt.response_sha256,pass:decision==='pass',note,reviewed_at:new Date().toISOString()});
    await writeFile(join(batch,'reviews.json'),JSON.stringify(reviews,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({id:attempt.id,pass:decision==='pass'}));return;
  }
  assert.equal(args.length,0);
  await assertPhaseBudget(batch);
  if(process.stdin.isTTY){const mode=execFileSync('stty',['-a'],{stdio:[0,'pipe','pipe'],encoding:'utf8'});assert.match(mode,/(?:^|[\s;])-echo(?:[\s;]|$)/,'Disable terminal echo');}
  const input=createInterface({input:process.stdin,terminal:false});let key;
  console.log(JSON.stringify({status:'awaiting_ephemeral_credential',providerCalls:0}));
  try{for await(const line of input){
    if(key===undefined){assert.match(line,/^sk-[A-Za-z0-9_-]{20,200}$/);key=line;console.log('{"status":"credential_in_memory","commands":"NEXT or STOP"}');}
    else if(line==='STOP')break;
    else{assert.equal(line,'NEXT');const result=await runNext(batch,key);console.log(JSON.stringify(result));if(result.status!=='awaiting_semantic_review')break;
      const state=await regularJson(join(batch,'live-results.json'));if(state.attempts.length===plan.requests.length)break;}
  }}finally{key=undefined;input.close();process.stdin.destroy();console.log('{"status":"session_closed"}');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){main().catch(()=>{console.error('Preflight rejected; no further call attempted. Inspect non-secret local evidence.');process.exitCode=1;});}
