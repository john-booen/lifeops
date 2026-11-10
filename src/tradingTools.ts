import {executeStoredQuery} from "./storedQueryRead";
import type { LifeOpsToolDefinition, ToolExecutionContext } from "./toolRegistry";
import type { AgentActionSuggestion } from "./types";
import type { StoreHost } from "./store/settingsSlice";
import { createHash } from "node:crypto";
import { isVaultPathExcluded } from "./privacy";
import { safeProjectPath } from "./projectContinuity";
import { todayString } from "./date";
import { tradingDocumentPath, tradingHash, tradingVersion, tradingCaseSources, tradingCaseContent, tradingCaseSourceKey, tradingSavedAt,
  tradingFields, TRADING_MODEL_FIELDS, TRADING_CASE_FIELDS, TRADING_LABELS, validTradingCaseInput, validTradingModelInput,
  type TradingCommand, type TradingSnapshot, type TradingVersion, type TradingCase, type TradingModelInput } from "./tradingResearch";
import { formatTradingRule, TRADING_RULE_KINDS } from "./features/trading/rules";
import { assertTradingRuleSources, isConfiguredTradingNote, listTradingRuleSources } from "./features/trading/ruleSources";

type Capability={hash:string;assertCurrent:()=>void};
const capabilities=new WeakMap<StoreHost,Map<string,Capability>>();
const error=(cause:unknown)=>({success:false,output:cause instanceof Error?cause.message:"交易研究核对失败，未保存。",actions:[]});
const policy=(store:StoreHost)=>tradingHash({folders:store.settings.folders,privacy:store.settings.privacy,tradingSourceFolders:store.settings.tradingSourceFolders});
function allowedDocument(store:StoreHost):void{if(isVaultPathExcluded(tradingDocumentPath(store),store.settings.privacy?.excludedVaultPrefixes))throw new Error("交易研究已设为不提供给AI，未读取或生成变更。");}
function allowedSource(store:StoreHost,path:string):void{if(!path)return;if(!safeProjectPath(path)||!(store.isManagedSourcePath(path)||isConfiguredTradingNote(store,path))||!store.getFile(path)||isVaultPathExcluded(path,store.settings.privacy?.excludedVaultPrefixes))throw new Error("交易原文来源不可读取或已排除，请重新核对。");}
export function visibleTradingVersion(store:StoreHost,version:TradingVersion,document:TradingSnapshot["document"]):boolean {
  let current:TradingVersion|undefined=version;
  while(current){if(current.sourcePath&&isVaultPathExcluded(current.sourcePath,store.settings.privacy?.excludedVaultPrefixes)
    ||current.rules?.some(rule=>!isConfiguredTradingNote(store,rule.sourcePath)||rule.reviewPath&&isVaultPathExcluded(rule.reviewPath,store.settings.privacy?.excludedVaultPrefixes)))return false;current=current.previousVersionId?tradingVersion(document,current.previousVersionId):undefined;}
  return true;
}
export function visibleTradingCase(store:StoreHost,snapshot:TradingSnapshot,entry:TradingCase):boolean{return [...entry.revisions,entry].every(item=>{const version=tradingVersion(snapshot.document,item.versionId);return !!version&&visibleTradingVersion(store,version,snapshot.document)&&(!item.sourcePath||!isVaultPathExcluded(item.sourcePath,store.settings.privacy?.excludedVaultPrefixes));});}
async function memoryState(store:StoreHost){
  const {readPersonalMemoryWithSources}=await import("./personalMemorySources");
  const {createPersonalMemoryContextFilter,personalMemoryContextRevision}=await import("./personalMemoryContext");
  const {records}=await readPersonalMemoryWithSources(store);
  return {revision:personalMemoryContextRevision(records),filter:createPersonalMemoryContextFilter(records)};
}
async function sourceState(store:StoreHost,snapshot:TradingSnapshot,command?:TradingCommand):Promise<string>{
  const paths=new Set([...snapshot.document.models.flatMap(model=>model.versions.flatMap(version=>[version.sourcePath,...(version.rules??[]).flatMap(rule=>[rule.sourcePath,rule.reviewPath??""])])),
    ...snapshot.document.cases.flatMap(tradingCaseSources),command?.input.sourcePath??"",
    ...(command?.kind==="save_model"?command.input.rules??[]:[]).flatMap(rule=>[rule.sourcePath,rule.reviewPath??""])].filter(Boolean));
  const readSources=async()=>{const sources=[];for(const path of [...paths].sort()){if(isVaultPathExcluded(path,store.settings.privacy?.excludedVaultPrefixes)){sources.push([path,"excluded"]);continue;}try{sources.push([path,(store.isManagedSourcePath(path)||isConfiguredTradingNote(store,path))&&store.getFile(path)?createHash("sha256").update(await store.readPath(path),"utf8").digest("hex"):"unavailable"]);}catch{sources.push([path,"unavailable"]);}}return sources;};
  const first=await readSources(),memory=await memoryState(store),sources=await readSources();
  // Memory projection can await other files. Do not publish or bless source
  // bytes captured before that wait if the actual files changed meanwhile.
  if(tradingHash(first)!==tradingHash(sources))throw new Error("读取记忆期间交易原文变化，请重新核对。");
  return tradingHash({sources,memory:memory.revision});
}
export async function tradingContextRevision(store:StoreHost,command?:TradingCommand,ownedPreparingOperation?:string):Promise<string>{
  allowedDocument(store);const first=policy(store);
  const {hasPendingFactOperation,factRecoveryPath}=await import("./dataFoundation/factOperation");
  if(await hasPendingFactOperation(store)){
    // Only the host's current Fact operation, before any business write, may
    // prepare its own guard. Pending receipts never authorize a public read.
    const pending=ownedPreparingOperation?JSON.parse(await store.readPath(factRecoveryPath(store))):undefined;
    if(!pending||pending.operationId!==ownedPreparingOperation||pending.entries.length!==0)throw new Error("上次保存中断，交易研究暂不作为已保存事实提供；请先检查并恢复未完成操作。");
  }
  const snapshot=await store.getTradingSnapshot(),sources=await sourceState(store,snapshot,command);if(policy(store)!==first)throw new Error("读取期间交易资料权限变化，请重新核对。");return tradingHash({revision:snapshot.revision,sources,policy:first});
}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("请提供具体交易研究字段。");return value as Record<string,unknown>;}
function keys(value:Record<string,unknown>,allowed:readonly string[]){if(Object.keys(value).some(key=>!allowed.includes(key)))throw new Error("交易研究包含不支持的字段，不会执行交易。");}
function string(value:unknown,fallback=""):string{if(value===undefined)return fallback;if(typeof value!=="string")throw new Error("交易研究字段须为文字；未知条件不要补数值。");return value.trim();}
function optionalIdentity(value:unknown):string|undefined{if(value===undefined)return undefined;if(typeof value!=="string"||!value||value!==value.trim())throw new Error("请使用查询返回的准确交易记录编号；空白或变形编号不能代替省略。");return value;}
export function normalizeTradingCommand(value:unknown,store:StoreHost,snapshot:TradingSnapshot):TradingCommand{
  allowedDocument(store);const raw=object(value),kind=string(raw.kind),input=object(raw.input);
  if(kind==="save_model"){keys(raw,["kind","modelId","input"]);keys(input,[...TRADING_MODEL_FIELDS,"rules"]);const modelId=optionalIdentity(raw.modelId),model=modelId===undefined?undefined:snapshot.document.models.find(m=>m.id===modelId);if(modelId!==undefined&&!model)throw new Error("原模型不存在，请先查询精确ID。");const previous=model?.versions.at(-1);if(previous&&!visibleTradingVersion(store,previous,snapshot.document))throw new Error("原规则或历史来源已排除，未生成变更卡。");
    const fields={...Object.fromEntries(TRADING_MODEL_FIELDS.map(key=>[key,string(input[key],previous?.[key]??"")])),
      rules:input.rules===undefined?previous?.rules??[]:input.rules} as TradingModelInput;
    if(!validTradingModelInput(fields))throw new Error("请填写模型名称并核对规则字段。");allowedSource(store,fields.sourcePath);return {kind,...(modelId===undefined?{}:{modelId}),input:fields};
  }
  if(kind!=="save_case")throw new Error("交易研究只支持规则版本和案例记录，不支持交易执行。");keys(raw,["kind","caseId","input"]);keys(input,TRADING_CASE_FIELDS);const caseId=optionalIdentity(raw.caseId),previous=caseId===undefined?undefined:snapshot.document.cases.find(e=>e.id===caseId);
  if(caseId!==undefined&&!previous)throw new Error("原案例不存在，请先查询精确ID。");if(previous&&!visibleTradingCase(store,snapshot,previous))throw new Error("案例或历史规则来源已排除，未生成更正卡。");
  const versionId=optionalIdentity(input.versionId===undefined?previous?.versionId:input.versionId);
  const fields=Object.fromEntries(TRADING_CASE_FIELDS.map(key=>[key,key==="versionId"?versionId??"":string(input[key],previous?.[key]??"")])) as import("./tradingResearch").TradingCaseInput;
  const version=tradingVersion(snapshot.document,fields.versionId);if(!version||!visibleTradingVersion(store,version,snapshot.document))throw new Error("请选择可提供给AI的已保存具体规则版本，不使用猜测ID或最新版替代。");
  if(!validTradingCaseInput(fields))throw new Error("请填写有效案例日期和至少一项实际记录。");allowedSource(store,fields.sourcePath);return {kind,...(caseId===undefined?{}:{caseId}),input:fields};
}
export function tradingReview(command:TradingCommand,snapshot:TradingSnapshot):Pick<AgentActionSuggestion,"title"|"description"|"content">{
  const previous=command.kind==="save_model"?snapshot.document.models.find(m=>m.id===command.modelId)?.versions.at(-1):snapshot.document.cases.find(e=>e.id===command.caseId);
  const fields=command.kind==="save_model"?TRADING_MODEL_FIELDS:TRADING_CASE_FIELDS;
  const lines=fields.map(key=>`${TRADING_LABELS[key]}：${previous?`${(previous as unknown as Record<string,string>)[key]||"未知/未提供"} → `:""}${(command.input as unknown as Record<string,string>)[key]||"未知/未提供"}`);
  if(command.kind==="save_model")lines.unshift(`模型：${command.modelId||"新建"}；${previous?`原版本 ${previous.id} 保留，本次追加版本`:"本次建立第一版规则"}`);
  else{const version=tradingVersion(snapshot.document,command.input.versionId)!;lines.unshift(`案例：${command.caseId||"新建"}；模型：${version.title}（${version.modelId}）；具体版本：${version.id}`,`本版入场：${version.entry||"未知"}；退出：${version.exit||"未知"}；失效：${version.invalid||"未知"}`,`本版风险预算：${version.riskBudget||"未知"}；环境：${version.environment||"未知"}；费用：${version.costs||"未知"}`);}
  if(command.kind==="save_model"&&command.input.rules?.length)lines.push(`本版规则清单\n${command.input.rules.map(rule=>`${formatTradingRule(rule)}\n原文「${rule.quote}」`).join("\n\n")}`);
  lines.push("未知保持未知；只保存研究记录，不下单，不验证盈利。规则评估、实际执行与结果分别记录。更正保留旧版本、来源与确认历史。");
  return {title:command.kind==="save_model"?`${previous?"追加规则版本":"建立交易研究模型"}：${command.input.title}`:`${previous?"更正":"记录"}交易案例`,description:"请核对所有字段和具体版本，点击确认后才保存；旧手写原文保持。",content:lines.join("\n\n")};
}
function reviewHash(action:AgentActionSuggestion):string{return tradingHash({id:action.id,title:action.title,description:action.description,content:action.content,command:action.tradingCommand,revision:action.tradingRevision,context:action.tradingContextRevision});}
export function assertTradingConfirmation(action:AgentActionSuggestion,store:StoreHost):void{const cap=capabilities.get(store)?.get(action.id);if(action.type!=="trading_change"||!action.tradingCommand||!cap||cap.hash!==reviewHash(action)||action.tradingReviewHash!==cap.hash)throw new Error("交易确认卡已失效或与内容不一致，请重新生成；未保存。");cap.assertCurrent();}
export async function prepareTradingAction(value:unknown,context:ToolExecutionContext,proposalId:string):Promise<AgentActionSuggestion>{
  context.assertCurrent?.();const store=context.store,before=await tradingContextRevision(store),snapshot=await store.getTradingSnapshot(),command=normalizeTradingCommand(value,store,snapshot),preview=tradingReview(command,snapshot),memory=await memoryState(store);
  if(command.kind==="save_model"&&command.input.rules?.length){const old=snapshot.document.models.find(model=>model.id===command.modelId)?.versions.at(-1)?.rules??[];
    if(JSON.stringify(command.input.rules)!==JSON.stringify(old))await assertTradingRuleSources(store,command.input.rules);}
  if(memory.filter(preview.content)!==preview.content)throw new Error("交易卡包含已更正、遗忘或不可用依据，请重新核对。");const revision=await tradingContextRevision(store,command);
  if(await tradingContextRevision(store)!==before||await tradingContextRevision(store,command)!==revision)throw new Error("生成交易卡期间资料变化，请重新读取。");context.assertCurrent?.();
  const action:AgentActionSuggestion={id:`proposal:${proposalId}:0`,type:"trading_change",...preview,date:todayString(),tradingCommand:structuredClone(command),tradingRevision:snapshot.revision,tradingContextRevision:revision};action.tradingReviewHash=reviewHash(action);
  let caps=capabilities.get(store);if(!caps){caps=new Map();capabilities.set(store,caps);}const existing=caps.get(action.id);if(existing&&existing.hash!==action.tradingReviewHash)throw new Error("交易卡标识已对应另一份内容，请重新提出。");caps.set(action.id,{hash:action.tradingReviewHash,assertCurrent:context.assertCurrent??(()=>undefined)});while(caps.size>128)caps.delete(caps.keys().next().value!);return structuredClone(action);
}
export type TradingWriteGuard=(()=>Promise<void>)&{assertPolicy:()=>void};
export async function prepareTradingWriteGuard(action:AgentActionSuggestion,context:ToolExecutionContext):Promise<TradingWriteGuard>{
  const store=context.store;assertTradingConfirmation(action,store);allowedDocument(store);
  // Capture policy before any awaited read, and compare the exact baseline we
  // will protect. A second read must never bless changed inputs as a new base.
  const baselinePolicy=policy(store),command=action.tradingCommand!,operationId=`confirmed:${action.id}`;
  await tradingContextRevision(store,command,operationId);
  const snapshot=await store.getTradingSnapshot(),baseline=await sourceState(store,snapshot,command);
  if(policy(store)!==baselinePolicy||tradingHash({revision:snapshot.revision,sources:baseline,policy:baselinePolicy})!==action.tradingContextRevision)throw new Error("交易记录、规则、来源或记忆已变化，请重新确认；未保存旧卡。");
  const changed=()=>{throw new Error("保存期间交易来源、隐私或记忆变化，已停止本次变更；原文保留。");};
  const assertPolicy=()=>{assertTradingConfirmation(action,store);context.assertCurrent?.();if(policy(store)!==baselinePolicy)changed();};
  const guard=Object.assign(async()=>{assertPolicy();const first=await sourceState(store,snapshot,command),last=await sourceState(store,snapshot,command);assertPolicy();if(first!==baseline||last!==baseline)changed();},{assertPolicy});await guard();return guard;
}
export async function executeConfirmedTradingChange(action:AgentActionSuggestion,context:ToolExecutionContext){await context.store.applyTradingCommand(action.tradingCommand!,action.tradingRevision!,`confirmed:${action.id}`);return {output:"交易研究记录已核验保存；规则版本和案例历史保留，没有执行交易。"};}
type CaseSide={value:TradingCase["revisions"][number];index:number};
function caseComparisonBlock(entry:TradingCase,sides:CaseSide[],snapshot:TradingSnapshot,status:Record<string,string>):string{
  const ordered=[...sides].reverse(),versions=ordered.map(side=>tradingVersion(snapshot.document,side.value.versionId)!);
  const fields:{domain:string;label:string;values:string[];quote:boolean}[]=[
    {domain:"案例及绑定规则",label:"模型ID",values:ordered.map(side=>side.value.modelId),quote:false},
    ...TRADING_CASE_FIELDS.filter(key=>key!=="versionId").map(key=>({domain:"案例",label:TRADING_LABELS[key],values:ordered.map(side=>side.value[key]),quote:true})),
    {domain:"案例",label:"确认记录时间",values:ordered.map(side=>tradingSavedAt(side.value)),quote:false},
    {domain:"案例",label:"来源状态",values:ordered.map(side=>status[snapshot.sources[tradingCaseSourceKey(entry.id,side.index)]]),quote:false},
    ...TRADING_MODEL_FIELDS.map(key=>({domain:"绑定规则",label:TRADING_LABELS[key],values:versions.map(version=>version[key]),quote:true})),
    ...(versions.some(version=>version.rules?.length)?[{domain:"绑定规则",label:"规则清单",values:versions.map(version=>(version.rules??[]).map(formatTradingRule).join("\n")),quote:false}]:[]),
    {domain:"绑定规则",label:"来源状态",values:versions.map(version=>status[snapshot.sources[version.id]]),quote:false}
  ];
  // Compare raw values across every returned side, before rendering an empty
  // value. A saved literal "未知/未提供" is distinct from a missing field.
  const shared=(field:typeof fields[number])=>field.values.every(value=>value===field.values[0]);
  const render=(field:typeof fields[number],value:string)=>value?field.quote?`“${value}”`:value:"未知/未提供";
  const lines=[`案例 ${entry.id}；更正历史 ${entry.revisions.length} 条`,"以下各侧均是本次匹配的已保存记录。所有历史更正前记录已被后续更正，不能当作当前案例或当前执行事实。"];
  for(const [i,side] of ordered.entries()){
    const version=versions[i],latest=version===snapshot.document.models.find(model=>model.id===version.modelId)?.versions.at(-1);
    lines.push(`${side.value===entry?"当前记录":`原记录（历史更正前记录 ${side.index+1}）`}：规则版本 ${side.value.versionId}（本条案例固定绑定的完整规则；${latest?"当前最新记录":"历史固定版本"}）`);
    for(const domain of ["案例及绑定规则","案例","绑定规则"]){const own=fields.filter(field=>field.domain===domain&&!shared(field));if(own.length)lines.push(`${domain}字段：\n${own.map(field=>`${field.label}：${render(field,field.values[i])}`).join("\n")}`);}
  }
  const common=fields.filter(shared);
  if(common.length)lines.push("共同字段（逐项同时适用于上述全部匹配侧的对应案例或绑定规则，不替代各侧固定版本）：");
  for(const domain of ["案例及绑定规则","案例","绑定规则"]){
    const known=common.filter(field=>field.domain===domain&&field.values[0]),missing=common.filter(field=>field.domain===domain&&!field.values[0]);
    if(known.length)lines.push(`${domain}共同已知：\n${known.map(field=>`${field.label}：${render(field,field.values[0])}`).join("\n")}`);
    if(missing.length)lines.push(`${domain}共同未知/未提供：${missing.map(field=>field.label).join("、")}。`);
  }
  return lines.join("\n\n");
}
export async function buildTradingResearchContext(store:StoreHost,query="",record?:import("./sourceReferences").ContextSourceRecorder):Promise<string>{
  allowedDocument(store);
  if(query.length>200)throw new Error("请用模型名称或具体ID缩小查询，最多200字。");
  const before=await tradingContextRevision(store),snapshot=await store.getTradingSnapshot();
  const status={unchanged:"原文与保存时字节一致",changed:"原文后来变化，旧规则未重新核验",unavailable:"原文暂不可用",not_provided:"未提供原文"};
  const versionBlock=(version:TradingVersion)=>[
    `模型 ${version.modelId} / 版本 ${version.id}${version===snapshot.document.models.find(m=>m.id===version.modelId)?.versions.at(-1)?"（当前最新记录）":"（历史固定版本）"}`,
    ...TRADING_MODEL_FIELDS.map(key=>`${TRADING_LABELS[key]}：${version[key]||"未知/未提供"}`),
    ...(version.rules?.length?[`规则清单\n${version.rules.map(formatTradingRule).join("\n")}`]:[]),
    `来源状态：${status[snapshot.sources[version.id]]}`
  ].join("\n\n");
  const blocks:string[]=[],comparisons=new Map<number,{members:string[];block:string}>();
  // Include a case and its exact rule together. A case-ID query must not leave
  // the model to guess its old rules from the latest version.
  for(const entry of [...snapshot.document.cases].reverse()){
    if(!visibleTradingCase(store,snapshot,entry))continue;
    // Each confirmed revision carries its own fields, source and fixed rule.
    // Matching a historical field must not substitute the current case values.
    const revisions=[{value:entry,index:entry.revisions.length},...entry.revisions.map((value,index)=>({value,index})).reverse()];
    const start=blocks.length,matched:CaseSide[]=[];
    for(const {value,index} of revisions){
      if(query&&!entry.id.includes(query)&&!JSON.stringify(tradingCaseContent(value)).includes(query))continue;
      matched.push({value,index});
      blocks.push([
        `案例 ${entry.id} / 模型 ${value.modelId} / 固定版本 ${value.versionId}（${value===entry?"当前记录":`历史更正前记录 ${index+1}`}）`,
        ...TRADING_CASE_FIELDS.map(key=>`${TRADING_LABELS[key]}：${value[key]||"未知/未提供"}`),
        `确认记录时间：${tradingSavedAt(value)||"未知"}；来源状态：${status[snapshot.sources[tradingCaseSourceKey(entry.id,index)]]}；更正历史 ${entry.revisions.length} 条`,
        ...(value===entry?[]:["这条历史记录已被后续更正，不能当作当前案例或当前执行事实。"]),
        "本条案例记录绑定的完整固定规则：",versionBlock(tradingVersion(snapshot.document,value.versionId)!)
      ].join("\n\n"));
    }
    if(query===entry.id&&matched.length>=2)comparisons.set(start,{members:blocks.slice(start),block:caseComparisonBlock(entry,matched,snapshot,status)});
  }
  for(const model of [...snapshot.document.models].reverse())for(const version of [...model.versions].reverse()){
    if(visibleTradingVersion(store,version,snapshot.document)&&(!query||JSON.stringify({id:version.id,modelId:version.modelId,...tradingFields(version,TRADING_MODEL_FIELDS)}).includes(query)))blocks.push(versionBlock(version));
  }
  const lines=["## 交易研究记录","以下是用户保存的规则与案例，不代表已验证、盈利或交易执行权限。未知不能补成零风险/免费；案例盈亏不证明规则好坏。查询仅覆盖本次可提供给AI且匹配条件的资料，未返回不能证明不存在；排除来源所影响的规则及案例不会提供。"];
  const budget=query?80000:16000,memory=await memoryState(store),rendered:string[]=[];let length=lines.join("\n\n").length,included=0;
  let compare=comparisons.size>0;
  if(compare){
    const legacy=[...lines];let legacyLength=length,legacyIncluded=0;
    for(const block of blocks){if(legacyLength+block.length+2>budget)continue;legacy.push(block);legacyLength+=block.length+2;legacyIncluded++;}
    if(legacyIncluded<blocks.length)legacy.push(`本次容量限制省略${blocks.length-legacyIncluded}组完整记录，未截断规则字段；请按模型名称、案例ID或具体版本ID缩小查询，不能据省略推断不存在。`);
    const original=legacy.join("\n\n");
    // Reformatting must also preserve suppression across the query header or
    // a preceding record, not only inside the proposed comparison group.
    compare=memory.filter(original)===original;
  }
  for(let index=0;index<blocks.length;index++){
    const comparison=comparisons.get(index);
    // Preserve the old individual-block path if either layout is filtered or
    // the original complete group cannot fit the remaining budget. Reordering
    // must not evade memory suppression or omit a previously usable side.
    if(compare&&comparison&&length+comparison.members.reduce((sum,block)=>sum+block.length+2,0)<=budget&&length+comparison.block.length+2<=budget
      &&memory.filter(comparison.members.join("\n\n"))===comparison.members.join("\n\n")&&memory.filter(comparison.block)===comparison.block){
      lines.push(comparison.block);rendered.push(comparison.block);length+=comparison.block.length+2;included+=comparison.members.length;index+=comparison.members.length-1;continue;
    }
    const block=blocks[index];if(length+block.length+2>budget)continue;lines.push(block);rendered.push(block);length+=block.length+2;included++;
  }
  if(included<blocks.length)lines.push(`本次容量限制省略${blocks.length-included}组完整记录，未截断规则字段；请按模型名称、案例ID或具体版本ID缩小查询，不能据省略推断不存在。`);
  const output=memory.filter(lines.join("\n\n"));
  if(record){const {recordTradingSnapshotSource}=await import("./store/tradingSlice");for(const block of rendered)if(output.includes(block))recordTradingSnapshotSource(store,snapshot,record,block);}
  if(await tradingContextRevision(store)!==before)throw new Error("查询期间交易资料变化，未返回旧内容。");return output;
}
export const TRADING_TOOLS:LifeOpsToolDefinition[]=[
  {name:"list_trading_rule_sources",description:"列出设置允许的交易原始笔记。用于选择规则提取来源。",safety:"safe",parameters:{type:"object",additionalProperties:false,properties:{}},
    async execute(_args,context){const paths=listTradingRuleSources(context.store);return {success:true,output:JSON.stringify({paths:paths.slice(0,50),total:paths.length}),actions:[]};}},
  {name:"query_trading_research",description:"只读查询已保存交易研究模型、固定规则版本与案例及精确ID。规则、执行、结果分开；不是行情、下单或收益保证。",safety:"safe",parameters:{type:"object",additionalProperties:false,properties:{query:{type:"string"}}},execute:async(args,context)=>executeStoredQuery("query_trading_research",args,context)},
  {name:"propose_trading_research_change",description:"生成交易研究确认卡，点击才保存。save_model追加模型版本，rules使用提取结果。save_case绑定具体版本。未知省略，空串清空。",safety:"ui-confirm",
    parameters:{type:"object",additionalProperties:false,properties:{command:{type:"object",additionalProperties:false,properties:{
      kind:{type:"string",enum:["save_model","save_case"]},modelId:{type:"string"},caseId:{type:"string"},input:{type:"object",additionalProperties:false,properties:{
        ...Object.fromEntries([...new Set([...TRADING_MODEL_FIELDS,...TRADING_CASE_FIELDS])].map(key=>[key,{type:"string",description:TRADING_LABELS[key]}])),
        rules:{type:"array",items:{type:"object",additionalProperties:false,properties:{id:{type:"string"},text:{type:"string"},kind:{type:"string",enum:[...TRADING_RULE_KINDS]},
          checkable:{type:"boolean"},sourcePath:{type:"string"},quote:{type:"string"}},required:["id","text","kind","checkable","sourcePath","quote"]}}
      }}},required:["kind","input"]}},required:["command"]},
    execute:async()=>error(new Error("交易研究须先生成完整确认卡，点击后才保存。")),prepareConfirmation:async(args,context,request)=>{try{keys(args,["command"]);return {success:true,output:"已生成交易研究确认卡，尚未保存。",actions:[await prepareTradingAction(args.command,context,request.operationId)]};}catch(cause){return error(cause);}}}
];

export async function queryTradingText(store:StoreHost,args:Record<string,unknown>,record?:import("./sourceReferences").ContextSourceRecorder):Promise<string>{
  keys(args,["query"]);return buildTradingResearchContext(store,string(args.query),record);
}
