import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {App} from "obsidian";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {DEFAULT_SETTINGS} from "../src/defaults";
import type {StoreHost} from "../src/store/settingsSlice";
import type {AgentActionSuggestion} from "../src/types";
import {tradingDocumentPath} from "../src/dataFoundation/tradingPersistence";
import {migrateTradingHistory} from "../src/dataFoundation/migrateM2";
import {tradingCaseSourceKey,validateTradingDocument} from "../src/tradingResearch";
vi.mock("obsidian",()=>({App:class{},TFile:class{},TFolder:class{},Notice:class{},normalizePath:(path:string)=>path.replace(/\\/g,"/").replace(/\/{2,}/g,"/")}));
const {LifeOpsStore}=await import("../src/store"),{DiskVault}=await import("./helpers/diskVault"),{AgentRuntime}=await import("../src/agentRuntime");
const {runConfirmedToolAction,getLifeOpsTool,agentToolsForRealtime}=await import("../src/toolRegistry");
const {buildTradingResearchContext}=await import("../src/tradingTools");
const {OperationLedger}=await import("../src/dataFoundation/operationLedger");
const {createPersonalMemory,reviewPersonalMemoryRecord}=await import("../src/personalMemory");
let root:string,vault:InstanceType<typeof DiskVault>,store:StoreHost,runtime:InstanceType<typeof AgentRuntime>,live:boolean,serial=0;
const context=()=>({store,refreshViews:async()=>{},assertCurrent:()=>{if(!live)throw Error("宿主已关闭");}});
function reopen(){store=new LifeOpsStore({vault} as unknown as App,structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;live=true;runtime=new AgentRuntime(context());}
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"lifeops-trading-research-"));vault=new DiskVault(root);reopen();});
afterEach(async()=>{vi.restoreAllMocks();await rm(root,{recursive:true,force:true});});
async function propose(command:unknown,id=`trade-proposal-${++serial}`){return runtime.executeAiToolCall({id,name:"propose_trading_research_change",arguments:{command}},"kimi","先给我核对研究记录");}
async function card(command:unknown){const result=await propose(command);expect(result.success,result.output).toBe(true);expect(result.actions).toHaveLength(1);return result.actions[0];}
const confirm=(action:AgentActionSuggestion)=>runConfirmedToolAction(action,context());
async function model(extra:Record<string,string>={}){await confirm(await card({kind:"save_model",input:{title:"纯虚构规则甲",entry:"只研究触发条件甲",...extra}}));const snapshot=await store.getTradingSnapshot();return snapshot.document.models[0].versions[0];}
describe("versioned trading research in a new fictional disk vault",()=>{
  it("keeps read and full proposal readonly, preserves unknowns and never edits old markdown",async()=>{
    const legacy=store.path(store.settings.folders.tradingModels,"旧手写模型.md");await vault.seed(legacy,"纯虚构旧手写原文\n");const before=vault.writes.length;
    expect((await store.getTradingSnapshot()).document.models).toEqual([]);const action=await card({kind:"save_model",input:{title:"纯虚构规则甲",entry:"条件甲"}});
    expect(action.content).toContain("风险预算：未知/未提供");expect(action.content).toContain("不下单");expect(vault.writes.length).toBe(before);expect(store.getFile(tradingDocumentPath(store))).toBeNull();
    await confirm(action);const version=(await store.getTradingSnapshot()).document.models[0].versions[0];expect(version).toMatchObject({entry:"条件甲",exit:"",invalid:"",riskBudget:"",costs:""});expect(await vault.bytes(legacy)).toBe("纯虚构旧手写原文\n");
  });
  it("appends rules while existing cases retain the exact old model and version after reopening",async()=>{
    const first=await model({exit:"退出甲",sourcePath:""});const oldVersion=structuredClone(first);
    await confirm(await card({kind:"save_case",input:{versionId:first.id,date:"2026-10-04",execution:"未按规则等待",result:"虚构亏损",review:"一次结果不足以评价规则"}}));
    const before=(await store.getTradingSnapshot()).document.cases[0];await confirm(await card({kind:"save_model",modelId:first.modelId,input:{entry:"条件乙",exit:""}}));
    const raw=await vault.bytes(tradingDocumentPath(store));reopen();const document=(await store.getTradingSnapshot()).document;
    expect(document.models[0].versions).toHaveLength(2);expect(document.models[0].versions[0]).toEqual(oldVersion);expect(document.models[0].versions[1]).toMatchObject({entry:"条件乙",exit:"",title:first.title,previousVersionId:first.id});
    expect(document.cases[0]).toEqual(before);expect(before.versionId).toBe(first.id);expect(before.receipt).toBeUndefined();expect(await vault.bytes(tradingDocumentPath(store))).toBe(raw);
  });
  it("corrects cases with complete original fields, version and source evidence retained; no automatic refresh",async()=>{
    const first=await model(),source=store.path(store.settings.folders.tradingReviews,"纯虚构案例原文.md");await vault.seed(source,"原文一");
    await confirm(await card({kind:"save_case",input:{versionId:first.id,date:"2026-10-04",execution:"执行一",result:"结果一",sourcePath:source}}));const previous=(await store.getTradingSnapshot()).document.cases[0];
    await vault.seed(source,"后来手写原文二");const sourceRaw=await vault.bytes(source),action=await card({kind:"save_case",caseId:previous.id,input:{review:"更正说明",sourcePath:""}});expect(action.content).toContain(`${source} → 未知/未提供`);
    await confirm(action);reopen();const snapshot=await store.getTradingSnapshot(),entry=snapshot.document.cases[0];
    expect(entry).toMatchObject({versionId:first.id,execution:"执行一",result:"结果一",sourcePath:"",review:"更正说明",revision:2});expect(entry.revisions[0]).toMatchObject({versionId:first.id,sourcePath:source,sourceHash:previous.sourceHash,updatedAt:previous.updatedAt,revision:1});expect(snapshot.sources[tradingCaseSourceKey(entry.id,0)]).toBe("changed");expect(await vault.bytes(source)).toBe(sourceRaw);
  });
  it("keeps historical source exclusions through successor versions and corrected case paths",async()=>{
    const ruleSource=store.path(store.settings.folders.tradingModels,"纯虚构私密规则.md"),caseSource=store.path(store.settings.folders.tradingReviews,"纯虚构私密案例.md");await vault.seed(ruleSource,"规则原文");await vault.seed(caseSource,"案例原文");
    const first=await model({sourcePath:ruleSource});await confirm(await card({kind:"save_model",modelId:first.modelId,input:{entry:"继承后规则",sourcePath:""}}));const latest=(await store.getTradingSnapshot()).document.models[0].versions[1];
    await confirm(await card({kind:"save_case",input:{versionId:latest.id,date:"2026-10-04",result:"私密结果",sourcePath:caseSource}}));const entry=(await store.getTradingSnapshot()).document.cases[0];
    await confirm(await card({kind:"save_case",caseId:entry.id,input:{review:"新说明",sourcePath:""}}));store.settings.privacy!.excludedVaultPrefixes=[ruleSource];
    let query=await buildTradingResearchContext(store);expect(query).not.toContain(first.modelId);expect(query).not.toContain(latest.id);expect(query).not.toContain("私密结果");expect((await propose({kind:"save_model",modelId:first.modelId,input:{title:"不能绕过"}})).success).toBe(false);
    store.settings.privacy!.excludedVaultPrefixes=[caseSource];query=await buildTradingResearchContext(store);expect(query).toContain(latest.id);expect(query).not.toContain(entry.id);expect(query).not.toContain("私密结果");expect((await propose({kind:"save_case",caseId:entry.id,input:{review:"不能绕过"}})).success).toBe(false);
  });
  it.each([{kind:"save_model",input:{title:"虚构",riskBudget:0}},{kind:"save_model",modelId:"guessed",input:{title:"虚构"}},{kind:"save_case",input:{versionId:"latest",date:"2026-10-04",result:"虚构"}},{kind:"save_case",input:{versionId:"guessed",date:"2026-02-30",result:"虚构"}},{kind:"place_order",input:{title:"虚构"}},{kind:"save_model",input:{title:"虚构",order:"buy"}}])("rejects unreviewable or execution/guessed fields %j",async command=>{const before=vault.writes.length;expect((await propose(command)).success).toBe(false);expect(vault.writes.length).toBe(before);});
  it.each(["content","tradingCommand","tradingReviewHash","tradingRevision","id"])("denies tampered %s before an operation is claimed",async field=>{const action=await card({kind:"save_model",input:{title:"虚构"}});if(field==="tradingCommand")action.tradingCommand!.input.sourcePath="hidden";else (action as any)[field]="tampered";const before=vault.writes.length;await expect(confirm(action)).rejects.toThrow(/不一致|失效/);expect(vault.writes.length).toBe(before);});
  it("denies copied capabilities on a new host and stop before confirmation",async()=>{const action=await card({kind:"save_model",input:{title:"虚构"}});live=false;await expect(confirm(action)).rejects.toThrow("关闭");live=true;reopen();await expect(confirm(action)).rejects.toThrow("失效");expect(store.getFile(tradingDocumentPath(store))).toBeNull();});
  it("deduplicates repeated confirmation and stops resurrection after undo",async()=>{const action=await card({kind:"save_model",input:{title:"纯虚构可撤销规则"}});await confirm(action);const raw=await vault.bytes(tradingDocumentPath(store));await confirm(action);expect(await vault.bytes(tradingDocumentPath(store))).toBe(raw);
    await runtime.undoLatestOperation();expect(store.getFile(tradingDocumentPath(store))).toBeNull();await expect(confirm(action)).rejects.toThrow(/撤销|重复/);expect(store.getFile(tradingDocumentPath(store))).toBeNull();});
  it.each(["document","source","privacy","folders","memory"])("invalidates old card after %s changes and retains external facts",async cause=>{
    const source=store.path(store.settings.folders.tradingModels,"纯虚构来源.md");await vault.seed(source,"原文一");await model();const action=await card({kind:"save_model",input:{title:"第二虚构模型",sourcePath:source}});
    if(cause==="document")await confirm(await card({kind:"save_model",input:{title:"第三虚构模型"}}));if(cause==="source")await vault.seed(source,"外部原文二");if(cause==="privacy")store.settings.privacy!.excludedVaultPrefixes=[source];if(cause==="folders")store.settings.folders.tradingModels="新目录";
    if(cause==="memory"){const result=await runtime.executeLocalOperation("synthetic-memory",{},async s=>{const record=await s.upsertPersonalMemory({kind:"current_state",content:"虚构当前依据",truth:"explicit_fact",sourceRefs:[{sourceId:"fiction-source",path:source,capturedAt:new Date().toISOString()}]});await s.reviewPersonalMemory(record.id,{decision:"confirm"});},`local:memory-${++serial}`);expect(result.success,result.output).toBe(true);}
    const path=store.path(DEFAULT_SETTINGS.folders.tradingModels,"LifeOps交易研究.json"),raw=await vault.bytes(path);await expect(confirm(action)).rejects.toThrow(/变化|排除/);expect(await vault.bytes(path)).toBe(raw);
  });
  it.each(["source","privacy","stop"])("checks %s after final audit waiting and rolls back only its new research bytes",async cause=>{
    const source=store.path(store.settings.folders.tradingModels,"纯虚构提交来源.md");await vault.seed(source,"原文一");await model();const path=tradingDocumentPath(store),before=await vault.bytes(path),action=await card({kind:"save_model",input:{title:"竞态虚构规则",sourcePath:source}});
    const original=OperationLedger.prototype.verify;let changed=false;vi.spyOn(OperationLedger.prototype,"verify").mockImplementation(async function(this:InstanceType<typeof OperationLedger>,...args){const result=await original.apply(this,args);if(args[0]===`confirmed:${action.id}`&&!changed){changed=true;if(cause==="source")await vault.seed(source,"外部提交原文二");if(cause==="privacy")store.settings.privacy!.excludedVaultPrefixes=[source];if(cause==="stop")live=false;}return result;});
    await expect(confirm(action)).rejects.toThrow(/变化|关闭/);expect(changed).toBe(true);expect(await vault.bytes(path)).toBe(before);expect(await vault.bytes(source)).toBe(cause==="source"?"外部提交原文二":"原文一");
  });
  it("protects a concurrent edit at the actual process callback",async()=>{await model();const path=tradingDocumentPath(store),action=await card({kind:"save_model",input:{title:"迟到虚构规则"}}),external=JSON.parse(await vault.bytes(path));external.extension="外部后来编辑保留";const raw=JSON.stringify(external),process=vault.process.bind(vault);vi.spyOn(vault,"process").mockImplementation(async(file,update)=>{if(file.path===path)vault.beforeProcess=async()=>{await vault.seed(path,raw);};return process(file,update);});await expect(confirm(action)).rejects.toThrow("变化");expect(await vault.bytes(path)).toBe(raw);});
  it.each(["version","schema","record_schema","version_content","case_binding","revision"])("preserves malformed or unknown %s data",async cause=>{const first=await model();await confirm(await card({kind:"save_case",input:{versionId:first.id,date:"2026-10-04",result:"虚构结果"}}));const path=tradingDocumentPath(store),document=JSON.parse(await vault.bytes(path));if(cause==="version")document.version=99;if(cause==="schema")document.schemaVersion=1;if(cause==="record_schema")document.models[0].schemaVersion=1;if(cause==="version_content")document.models[0].versions[0].entry=77;if(cause==="case_binding")document.cases[0].versionId="未知版本";if(cause==="revision")document.cases[0].revision=2;const raw=JSON.stringify(document);await vault.seed(path,raw);expect(validateTradingDocument(document)).toBe(false);await expect(store.getTradingSnapshot()).rejects.toThrow("未覆盖");expect(await vault.bytes(path)).toBe(raw);});
  it("loads legacy versions and cases without requiring receipt hashes and carries their history into the next write",async()=>{
    const first=await model();await confirm(await card({kind:"save_case",input:{versionId:first.id,date:"2026-10-04",result:"虚构结果"}}));
    const path=tradingDocumentPath(store),legacy=JSON.parse(await vault.bytes(path));
    const legacyTime="2026-10-04T09:00:00+08:00";
    for(const item of [legacy.models[0].versions[0],legacy.cases[0]]) {
      delete item.updatedAt;delete item.revision;delete item.rules;
      item.receipt={kind:"user_confirmation",recordedAt:legacyTime,operationId:"legacy",commandHash:"old",contentHash:"old"};
    }
    legacy.cases[0].versionHash="old";const raw=JSON.stringify(legacy);await vault.seed(path,raw);
    expect((await store.getTradingSnapshot()).document.cases[0]).toMatchObject({revision:1,updatedAt:legacyTime,versionId:first.id});
    expect(await vault.bytes(path)).toBe(raw);
    await confirm(await card({kind:"save_model",modelId:first.modelId,input:{entry:"新规则"}}));
    const next=(await store.getTradingSnapshot()).document;
    expect(next.models[0].versions).toMatchObject([{revision:1,updatedAt:legacyTime,rules:[],receipt:legacy.models[0].versions[0].receipt},{revision:2,entry:"新规则"}]);
    expect(next.models[0].versions[1].receipt).toBeUndefined();expect(next.cases[0].versionId).toBe(first.id);
  });
  it("migrates stored research history once without changing the source or old version binding", async () => {
    const source = store.path(store.settings.folders.tradingModels, "虚构迁移原文.md");
    await vault.seed(source, "需要保留的虚构原文。");
    const first = await model({ sourcePath: source });
    await confirm(await card({ kind: "save_case", input: { versionId: first.id, date: "2026-10-04", result: "虚构结果" } }));
    const path = tradingDocumentPath(store);
    const old = JSON.parse(await vault.bytes(path));
    const time = "2026-10-04T09:00:00+08:00";
    for (const item of [old.models[0].versions[0], old.cases[0]]) {
      delete item.updatedAt;
      delete item.revision;
      delete item.rules;
      item.receipt = { kind: "user_confirmation", recordedAt: time, operationId: item.id };
    }
    await vault.seed(path, JSON.stringify(old));
    expect(await migrateTradingHistory(store)).toBe(true);
    const migrated = await vault.bytes(path);
    expect(JSON.parse(migrated)).toMatchObject({
      models: [{ versions: [{ id: first.id, revision: 1, updatedAt: time, rules: [], receipt: old.models[0].versions[0].receipt }] }],
      cases: [{ revision: 1, updatedAt: time, versionId: first.id, receipt: old.cases[0].receipt }]
    });
    reopen();
    const writes = vault.writes.length;
    expect(await migrateTradingHistory(store)).toBe(false);
    expect(vault.writes).toHaveLength(writes);
    expect(await vault.bytes(path)).toBe(migrated);
    expect(await vault.bytes(source)).toBe("需要保留的虚构原文。");
  });
  it("preserves compatible extension metadata while adding a version",async()=>{const first=await model(),path=tradingDocumentPath(store),document=JSON.parse(await vault.bytes(path));document.extension={keep:true};document.models[0].custom="保留";await vault.seed(path,JSON.stringify(document));await confirm(await card({kind:"save_model",modelId:first.modelId,input:{exit:"新退出规则"}}));const after=(await store.getTradingSnapshot()).document;expect(after.extension).toEqual({keep:true});expect(after.models[0].custom).toBe("保留");});
  it("separates read cache by trading revision and keeps new write tools out of realtime",async()=>{await model();let result=await runtime.executeAiToolCall({id:"same-trade-query",name:"query_trading_research",arguments:{}},"kimi");expect(result.output).toContain("纯虚构规则甲");await confirm(await card({kind:"save_model",input:{title:"后来虚构规则乙"}}));result=await runtime.executeAiToolCall({id:"same-trade-query",name:"query_trading_research",arguments:{}},"kimi");expect(result.output).toContain("后来虚构规则乙");expect(agentToolsForRealtime().some(tool=>String(tool.name).includes("trading_research"))).toBe(false);expect((await getLifeOpsTool("propose_trading_research_change")!.execute({},context(),{operationId:"direct",source:"system"})).success).toBe(false);});
  it("returns exact bound old rules with a case-ID query after the model has a new version",async()=>{
    const first=await model({exit:"旧退出条件甲"});await confirm(await card({kind:"save_case",input:{versionId:first.id,date:"2026-10-04",result:"纯虚构结果"}}));
    const entry=(await store.getTradingSnapshot()).document.cases[0];await confirm(await card({kind:"save_model",modelId:first.modelId,input:{entry:"新条件乙",exit:"新退出乙"}}));
    const output=await buildTradingResearchContext(store,entry.id);expect(output).toContain(entry.id);expect(output).toContain(first.id);expect(output).toContain("只研究触发条件甲");expect(output).toContain("旧退出条件甲");expect(output).not.toContain("新条件乙");
  });
  it.each(["case-id", "old-result", "old-version"])("reads corrected case history with its own fixed rules after reopening by %s",async route=>{
    const first=await model({entry:"历史入场甲",exit:"历史退出甲"});
    await confirm(await card({kind:"save_case",input:{versionId:first.id,date:"2026-10-04",result:"更正前结果甲",execution:"更正前执行甲"}}));
    const entry=(await store.getTradingSnapshot()).document.cases[0];
    await confirm(await card({kind:"save_model",modelId:first.modelId,input:{entry:"当前入场乙",exit:"当前退出乙"}}));
    const latest=(await store.getTradingSnapshot()).document.models[0].versions.at(-1)!;
    await confirm(await card({kind:"save_case",caseId:entry.id,input:{versionId:latest.id,result:"当前结果乙",execution:"当前执行乙"}}));
    const before=await vault.bytes(tradingDocumentPath(store));reopen();
    const output=await buildTradingResearchContext(store,route==="case-id"?entry.id:route==="old-result"?"更正前结果甲":first.id);
    expect(output).toContain("历史更正前记录");expect(output).toContain("更正前结果甲");expect(output).toContain("更正前执行甲");expect(output).toContain("历史入场甲");expect(output).toContain("历史退出甲");
    if(route==="case-id"){expect(output).toContain("当前记录");expect(output).toContain("当前结果乙");expect(output).toContain("当前入场乙");}
    else{expect(output).not.toContain("当前结果乙");expect(output).not.toContain("当前入场乙");}
    expect(await vault.bytes(tradingDocumentPath(store))).toBe(before);
  });
  it.each(["changed", "missing"])("reports the original case source as %s after a source-free correction",async state=>{
    const source=store.path(store.settings.folders.tradingReviews,"纯虚构历史案例原文.md");await vault.seed(source,"最初原文");
    const first=await model();await confirm(await card({kind:"save_case",input:{versionId:first.id,date:"2026-10-04",result:"历史结果",sourcePath:source}}));
    const entry=(await store.getTradingSnapshot()).document.cases[0];await confirm(await card({kind:"save_case",caseId:entry.id,input:{result:"当前结果",sourcePath:""}}));
    if(state==="changed")await vault.seed(source,"后来原文");else await vault.delete(store.getFile(source)!);
    const output=await buildTradingResearchContext(store,entry.id);
    expect(output).toContain("历史结果");expect(output).toContain(state==="changed"?"原文后来变化，旧规则未重新核验":"原文暂不可用");expect(output).toContain("未提供原文");
  });
  it("explains the visible query scope without revealing excluded historical records",async()=>{
    const source=store.path(store.settings.folders.tradingReviews,"纯虚构私密案例来源.md");await vault.seed(source,"私密原文");
    const first=await model();await confirm(await card({kind:"save_case",input:{versionId:first.id,date:"2026-10-04",result:"私密旧结果",sourcePath:source}}));
    const entry=(await store.getTradingSnapshot()).document.cases[0];await confirm(await card({kind:"save_case",caseId:entry.id,input:{result:"当前结果",sourcePath:""}}));
    store.settings.privacy!.excludedVaultPrefixes=[source];const output=await buildTradingResearchContext(store,entry.id);
    expect(output).toContain("未返回不能证明不存在");for(const value of [source,entry.id,"私密旧结果","当前结果"])expect(output).not.toContain(value);
  });
  it("omits oversized complete rules in routine context and allows an exact-ID query without truncating fields",async()=>{
    const fullEntry=`完整开头${"虚构条件".repeat(800)}完整结尾`;const first=await model({entry:fullEntry,exit:fullEntry,invalid:fullEntry,rationale:fullEntry,riskBudget:fullEntry,costs:fullEntry});
    const routine=await buildTradingResearchContext(store);expect(routine.length).toBeLessThan(17000);expect(routine).toContain("容量限制省略1组完整记录");expect(routine).not.toContain("完整开头");
    const exact=await buildTradingResearchContext(store,first.id);expect(exact).toContain(fullEntry);expect(exact).toContain(first.id);expect(exact).not.toContain("容量限制省略");
    await expect(buildTradingResearchContext(store,"长".repeat(201))).rejects.toThrow("最多200字");
  });
});

describe("complete exact-case comparison without repeated shared evidence",()=>{
  const ruleFields={market:"共同市场与品种",exit:"共同退出",invalid:"共同失效",riskBudget:"共同预算",environment:"共同市场环境",costs:"共同费用",rationale:"共同待验证依据"};
  async function pair(oldCase:Record<string,string>={},newCase:Record<string,string>={},oldRule:Record<string,string>={},newRule:Record<string,string>={}){
    const first=await model({entry:"原规则：条件A；预算？",...ruleFields,...oldRule});
    await confirm(await card({kind:"save_case",input:{versionId:first.id,date:"2026-10-04",result:"原结果：描述A",...oldCase}}));
    const original=(await store.getTradingSnapshot()).document.cases[0];
    await confirm(await card({kind:"save_model",modelId:first.modelId,input:{entry:"当前规则：条件B；预算？",...newRule}}));
    const latest=(await store.getTradingSnapshot()).document.models[0].versions.at(-1)!;
    await confirm(await card({kind:"save_case",caseId:original.id,input:{versionId:latest.id,result:"当前结果：描述B",...newCase}}));
    return {first,latest,entry:(await store.getTradingSnapshot()).document.cases[0]};
  }
  function sections(output:string){const old=output.indexOf("原记录（历史更正前记录"),current=output.indexOf("当前记录：规则版本"),common=output.indexOf("共同字段（");expect(old).toBeGreaterThan(0);expect(current).toBeGreaterThan(old);expect(common).toBeGreaterThan(current);return {old:output.slice(old,current),current:output.slice(current,common),common:output.slice(common)};}
  const occurrences=(text:string,value:string)=>text.split(value).length-1;
  it("keeps all distinct case and rule fields, exact punctuation and multiline text under their own fixed versions",async()=>{
    const oldCase={date:"2026-10-01",ruleAssessment:"原评估：不作结论",execution:"原执行：先等\n后观察",result:"原结果：亏损，不能推断规则差",review:"原复盘：待验证"},newCase={date:"2026-10-02",ruleAssessment:"当前评估：仍未知",execution:"当前执行：仅记录",result:"当前结果：上涨，不能推断规则好",review:"当前复盘：未验证"};
    const oldRule=Object.fromEntries(Object.keys(ruleFields).map(key=>[key,`原${key}：数值？`])),newRule=Object.fromEntries(Object.keys(ruleFields).map(key=>[key,`当前${key}：数值？`]));
    const {first,latest,entry}=await pair(oldCase,newCase,oldRule,newRule),raw=await vault.bytes(tradingDocumentPath(store)),writes=vault.writes.length,output=await buildTradingResearchContext(store,entry.id),s=sections(output);
    for(const value of Object.values(oldCase).concat(Object.values(oldRule),first.entry,first.id))expect(s.old).toContain(value);
    for(const value of Object.values(newCase).concat(Object.values(newRule),latest.entry,latest.id))expect(s.current).toContain(value);
    expect(s.old).not.toContain(latest.id);expect(s.current).not.toContain(first.id);expect(output).toContain("不能当作当前案例或当前执行事实");expect(await vault.bytes(tradingDocumentPath(store))).toBe(raw);expect(vault.writes.length).toBe(writes);
  });
  it("lists shared known values and each missing case/rule field once with explicit applicability",async()=>{
    const empty=Object.fromEntries(Object.keys(ruleFields).map(key=>[key,""])),{entry}=await pair({}, {},empty,empty),output=await buildTradingResearchContext(store,entry.id),s=sections(output);
    for(const label of ["规则评估（用户记录）","实际执行与偏离","复盘与待验证问题","市场与品种","退出条件","失效条件","风险预算","市场环境","费用与滑点","规则依据与待验证问题"])expect(occurrences(output,label)).toBe(1);
    expect(occurrences(output,"纯虚构规则甲")).toBe(1);expect(occurrences(output,"2026-10-04")).toBe(1);expect(s.common).toContain("逐项同时适用于上述全部匹配侧");expect(output).toContain("案例共同未知/未提供");expect(output).toContain("绑定规则共同未知/未提供");
  });
  it("compares all three revision sides before declaring anything shared",async()=>{
    const {entry,latest}=await pair({}, {},{market:"前两侧共同市场"},{market:"前两侧共同市场"});
    await confirm(await card({kind:"save_model",modelId:latest.modelId,input:{market:"第三侧不同市场",entry:"第三侧规则"}}));
    const third=(await store.getTradingSnapshot()).document.models[0].versions.at(-1)!;
    await confirm(await card({kind:"save_case",caseId:entry.id,input:{versionId:third.id,result:"第三侧结果"}}));
    const output=await buildTradingResearchContext(store,entry.id),s=sections(output);expect(output).toContain("历史更正前记录 1");expect(output).toContain("历史更正前记录 2");expect(output).toContain("更正历史 2 条");expect(occurrences(output,"前两侧共同市场")).toBe(2);expect(s.current).toContain("第三侧不同市场");expect(s.common).not.toContain("市场与品种");
  });
  it("does not merge empty fields with a saved literal unknown marker",async()=>{
    const {entry}=await pair({execution:"未知/未提供"},{execution:""},{exit:"未知/未提供"},{exit:""}),s=sections(await buildTradingResearchContext(store,entry.id));
    expect(s.old).toContain("实际执行与偏离：“未知/未提供”");expect(s.current).toContain("实际执行与偏离：未知/未提供");expect(s.old).toContain("退出条件：“未知/未提供”");expect(s.current).toContain("退出条件：未知/未提供");expect(s.common).not.toContain("退出条件");
  });
  it("retains both associations when only the case result changes under the same rule version",async()=>{
    const first=await model({entry:"同一完整规则：条件甲，风险未知"});await confirm(await card({kind:"save_case",input:{versionId:first.id,date:"2026-10-04",result:"原独有结果"}}));
    const entry=(await store.getTradingSnapshot()).document.cases[0];await confirm(await card({kind:"save_case",caseId:entry.id,input:{result:"当前独有结果"}}));
    const output=await buildTradingResearchContext(store,entry.id),s=sections(output);expect(s.old).toContain(first.id);expect(s.current).toContain(first.id);expect(s.old).toContain("原独有结果");expect(s.current).toContain("当前独有结果");expect(occurrences(output,first.entry)).toBe(1);
  });
  it("keeps different models and case/rule domains separate when a corrected case changes its binding",async()=>{
    const first=await model({market:"原品种"});await confirm(await card({kind:"save_case",input:{versionId:first.id,date:"2026-10-04",result:"原模型案例"}}));const entry=(await store.getTradingSnapshot()).document.cases[0];
    await confirm(await card({kind:"save_model",input:{title:"另一个完整模型",market:"当前品种",entry:"另一个完整入场规则"}}));const other=(await store.getTradingSnapshot()).document.models[1].versions[0];
    await confirm(await card({kind:"save_case",caseId:entry.id,input:{versionId:other.id,result:"当前模型案例"}}));const s=sections(await buildTradingResearchContext(store,entry.id));expect(s.old).toContain(first.modelId);expect(s.old).toContain(first.title);expect(s.current).toContain(other.modelId);expect(s.current).toContain(other.title);expect(s.common).not.toContain("模型ID");
  });
  it("keeps different receipt times and source states even when original source paths are equal",async()=>{
    vi.useFakeTimers({toFake:["Date"]});try{
      vi.setSystemTime(new Date("2026-10-01T01:00:00Z"));const source=store.path(store.settings.folders.tradingReviews,"相同路径原文.md");await vault.seed(source,"原始字节");const first=await model({sourcePath:source});
      await confirm(await card({kind:"save_case",input:{versionId:first.id,date:"2026-10-04",result:"原结果",sourcePath:source}}));const entry=(await store.getTradingSnapshot()).document.cases[0];
      vi.setSystemTime(new Date("2026-10-02T01:00:00Z"));await vault.seed(source,"更正字节");await confirm(await card({kind:"save_model",modelId:first.modelId,input:{entry:"新规则",sourcePath:source}}));const latest=(await store.getTradingSnapshot()).document.models[0].versions.at(-1)!;await confirm(await card({kind:"save_case",caseId:entry.id,input:{versionId:latest.id,result:"当前结果",sourcePath:source}}));
      const output=await buildTradingResearchContext(store,entry.id),s=sections(output);expect(s.old).toContain("2026-10-01T01:00:00.000Z");expect(s.current).toContain("2026-10-02T01:00:00.000Z");expect(s.old).toContain("原文后来变化，旧规则未重新核验");expect(s.current).toContain("原文与保存时字节一致");expect(occurrences(output,source)).toBe(2);
    }finally{vi.useRealTimers();}
  });
  it("does not label the current case's historical fixed version as the latest rule",async()=>{
    const {entry,latest}=await pair();await confirm(await card({kind:"save_model",modelId:latest.modelId,input:{entry:"不应代替案例的未来规则"}}));const s=sections(await buildTradingResearchContext(store,entry.id));expect(s.current).toContain("历史固定版本");expect(s.current).not.toContain("当前最新记录");expect(s.current).not.toContain("不应代替案例的未来规则");
  });
  it.each(["partial-id","body-match","standalone-version","routine"])("keeps the original individual query format for %s",async route=>{
    const {entry,first}=await pair(),query=route==="partial-id"?entry.id.slice(0,-1):route==="body-match"?"原结果：描述A":route==="standalone-version"?first.id:"",output=await buildTradingResearchContext(store,query);expect(output).not.toContain("共同字段（");expect(output).toContain("入场条件：原规则：条件A；预算？");if(route!=="standalone-version")expect(output).toContain("本条案例记录绑定的完整固定规则");if(route==="body-match"||route==="standalone-version")expect(output).not.toContain("当前结果：描述B");
  });
  it.each(["single-side","shared","legacy-cross-paragraph"])("falls back before formatting can evade memory suppression of %s",async kind=>{
    const {entry,first}=await pair(),text=kind==="single-side"?"原结果：描述A":kind==="shared"?first.title:"结果（不代替规则评估）：原结果：描述A\n\n复盘与待验证问题：未知/未提供";
    const stamp="2026-10-03T01:00:00.000Z",source=store.path(store.settings.folders.ideas,"合成遗忘依据.md");await vault.seed(source,text);const memory=createPersonalMemory({kind:"user_rule",truth:"explicit_fact",content:text,sourceRefs:[{sourceId:"synthetic-forget-source",path:source,capturedAt:stamp}]},stamp),confirmed=reviewPersonalMemoryRecord([memory],memory.id,{decision:"confirm"},stamp),forgotten=reviewPersonalMemoryRecord(confirmed,memory.id,{decision:"forget"},stamp);await vault.seed(store.personalMemoryPath(),JSON.stringify({version:1,updatedAt:stamp,records:forgotten}));
    const output=await buildTradingResearchContext(store,entry.id);expect(output).not.toContain("共同字段（");expect(output).toContain("已省略暂不可使用的历史片段");if(kind==="legacy-cross-paragraph")expect(output).toBe((await import("../src/personalMemoryContext")).MEMORY_CONTEXT_OMISSION);else{expect(output).toContain("本条案例记录绑定的完整固定规则");expect(output).not.toContain(text);}
  });
  it("certifies the complete new fragment from the owned raw snapshot and rejects later raw-byte changes",async()=>{
    const {entry}=await pair(),path=tradingDocumentPath(store),raw=await vault.bytes(path),{readStoredQueryWithSources,isOwnedStoredQueryRead}=await import("../src/storedQueryRead"),{preparedContextSourcePaths}=await import("./helpers/sourceReferences");
    const {captureContextSources,contextSourceHash}=await import("./helpers/sourceReferences"),captured=await captureContextSources(record=>buildTradingResearchContext(store,entry.id,record));expect(captured.blocks).toHaveLength(1);expect(captured.blocks[0].path).toBe(path);expect(captured.blocks[0].sourceHash).toBe(contextSourceHash(raw));expect(captured.blocks[0].fragment).toContain("共同字段（");expect(captured.text).toContain(captured.blocks[0].fragment);
    const read=await readStoredQueryWithSources(store,"query_trading_research",{query:entry.id});try{expect(read.text).toContain("共同字段（");expect(isOwnedStoredQueryRead(store,read)).toBe(true);expect(preparedContextSourcePaths([read.sources],read.text)).toContain(path);expect(await vault.bytes(path)).toBe(raw);await vault.seed(path,raw+" ");await expect(read.assertSourcesCurrent()).rejects.toThrow();}finally{read.dispose();}
  });
  it.each(["query-header","previous-record"])("keeps old full-output suppression across the %s boundary",async kind=>{
    const {entry,latest}=await pair();
    if(kind==="previous-record")await confirm(await card({kind:"save_case",input:{versionId:latest.id,date:"2026-10-04",result:"先返回的另一个案例",review:entry.id}}));
    const currentHeader=`案例 ${entry.id} / 模型 ${latest.modelId} / 固定版本 ${latest.id}（当前记录）`,text=(kind==="query-header"?"排除来源所影响的规则及案例不会提供。":"来源状态：未提供原文")+"\n\n"+currentHeader,stamp="2026-10-03T01:00:00.000Z",source=store.path(store.settings.folders.ideas,"合成跨段遗忘依据.md");await vault.seed(source,text);
    const memory=createPersonalMemory({kind:"user_rule",truth:"explicit_fact",content:text,sourceRefs:[{sourceId:"synthetic-cross-boundary",path:source,capturedAt:stamp}]},stamp),confirmed=reviewPersonalMemoryRecord([memory],memory.id,{decision:"confirm"},stamp),forgotten=reviewPersonalMemoryRecord(confirmed,memory.id,{decision:"forget"},stamp);await vault.seed(store.personalMemoryPath(),JSON.stringify({version:1,updatedAt:stamp,records:forgotten}));
    const {captureContextSources}=await import("./helpers/sourceReferences"),captured=await captureContextSources(record=>buildTradingResearchContext(store,entry.id,record));expect(captured.text).toBe((await import("../src/personalMemoryContext")).MEMORY_CONTEXT_OMISSION);expect(captured.blocks).toEqual([]);
  });
  it("keeps an individually usable current record when the complete original group exceeds capacity",async()=>{
    const big="完整大字段".repeat(750),rule=Object.fromEntries(Object.keys(ruleFields).map(key=>[key,big])),{entry}=await pair({execution:big,ruleAssessment:big,review:big},{execution:big,ruleAssessment:big,review:big},{...rule,entry:big},{...rule,entry:big});
    const output=await buildTradingResearchContext(store,entry.id);expect(output).not.toContain("共同字段（");expect(output).toContain("当前记录");expect(output).toContain("当前结果：描述B");expect(output).toContain(big);expect(output).toContain("容量限制省略");expect(output).not.toContain("原结果：描述A");
  });
  it("uses the actual remaining budget after an earlier matched case and preserves the old partial return",async()=>{
    const big="完整预算字段".repeat(660),rule=Object.fromEntries(Object.keys(ruleFields).map(key=>[key,big])),{entry}=await pair({}, {},{entry:big,exit:big,invalid:big,riskBudget:big},{entry:big,exit:big,invalid:big,riskBudget:big});
    await confirm(await card({kind:"save_model",input:{title:"先匹配的巨大模型",entry:big,...rule}}));const other=(await store.getTradingSnapshot()).document.models.at(-1)!.versions[0];await confirm(await card({kind:"save_case",input:{versionId:other.id,date:"2026-10-04",ruleAssessment:big,execution:big,result:big,review:entry.id+big}}));
    const output=await buildTradingResearchContext(store,entry.id);expect(output).not.toContain("共同字段（");expect(output).toContain("先匹配的巨大模型");expect(output).toContain("当前结果：描述B");expect(output).not.toContain("原结果：描述A");expect(output).toContain("容量限制省略");
  });
});
