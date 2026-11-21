import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { StoreHost } from "../src/store/settingsSlice";
import type { VaultQueryRead } from "../src/vaultQueryRead";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { prepareSparseSummaryFixture } from "./eval/sparseSummaryFixture";
import { prepareTaskIntervalFixture } from "./eval/taskIntervalFixture";
vi.mock("obsidian",()=>({App:class{},TFile:class{},TFolder:class{},Modal:class{},Notice:class{},normalizePath:(p:string)=>p.replace(/\\/g,"/"),parseYaml:JSON.parse,stringifyYaml:JSON.stringify}));
const { LifeOpsStore }=await import("../src/store");
const { AgentRuntime }=await import("../src/agentRuntime");
const { DiskVault }=await import("./helpers/diskVault");
const { summaryPath,renderSummary,readSummaryScope }=await import("../src/features/summaries/notes");
const { summaryPeriod }=await import("../src/features/summaries/periods");
let root:string,store:StoreHost,vault:InstanceType<typeof DiskVault>,runtime:InstanceType<typeof AgentRuntime>;
const range={from:"2026-11-02",to:"2026-11-15"};
const original="纯虚构纸样归档只能安排周三09:30。",corrected="纯虚构纸样归档只能安排周三19:30。";
const journal=(day:string,suffix="晚")=>store.path(store.settings.folders.dailyRoot,"2026","11",day+suffix+".md");
beforeEach(async()=>{
 vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-11-21T12:00:00+08:00"));
 root=await mkdtemp(join(tmpdir(),"lifeops-summary-evidence-"));vault=new DiskVault(root);
 store=new LifeOpsStore({vault} as unknown as App,structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
 await store.initializeVault();runtime=new AgentRuntime({store,refreshViews:async()=>{}});
});
afterEach(async()=>{vi.useRealTimers();vi.restoreAllMocks();await rm(root,{recursive:true,force:true});});
async function query(id="fictional-summary-evidence",args:Record<string,unknown>={},onRead?:(read:VaultQueryRead)=>void){
 return runtime.executeAiToolCall({id,name:"get_summaries",arguments:{level:"week",range,...args}},"kimi","",{
  assertCurrent:()=>{},...(onRead?{onQueryRead:(_result,read)=>onRead(read)}:{})
 });
}
async function seedSummary(day:string,text:string){const period=summaryPeriod("week",day),scope=await readSummaryScope(store);
 await vault.seed(summaryPath(store,period),renderSummary(period,period.to,scope.hash,{tasksCompleted:2,taskCompletionPercent:100,energy:null,tradePnlCny:null,tradePnlUsd:null},2,true,"model",text));
}
async function memory(){
 const path=store.path(store.settings.folders.ideas,"纯虚构归档偏好.md");await vault.seed(path,original);
 const row=await store.upsertPersonalMemory({kind:"user_rule",content:original,sourceRefs:[{sourceId:"fictional-availability",path,capturedAt:new Date().toISOString()}]});
 await store.reviewPersonalMemory(row.id,{decision:"confirm"});return row.id;
}

it("refuses to prepare sparse evidence without a fictional marker before changing any records", async () => {
 await store.createTask({title:"虚构应保留任务",date:"2026-11-04"});
 await vault.seed(journal("2026-11-04"),"虚构应保留原文。");const before=await store.readTaskDb();
 await expect(prepareSparseSummaryFixture(store)).rejects.toThrow("全虚构夹具");
 expect(await store.readTaskDb()).toEqual(before);expect(await vault.bytes(journal("2026-11-04"))).toBe("虚构应保留原文。");
});

it("seeds a contradictory legacy summary with one dated original and preserves out-of-week files", async () => {
 await vault.seed("TEST_VAULT_ONLY.md","内容全部为虚构数据。");
 await vault.seed(journal("2026-11-04"),"虚构待清理的旧模板。");
 await vault.seed(journal("2026-11-11"),"虚构其他周原文应保留。");
 await prepareSparseSummaryFixture(store);
 const result=await query("fictional-sparse-summary",{range:{from:"2026-11-02",to:"2026-11-08"},includeOriginals:true});
 expect(result.success,result.output).toBe(true);const output=JSON.parse(result.output);
 expect(output.summaries).toHaveLength(1);expect(output.summaries[0]).toMatchObject({generatedBy:"model",complete:true,inputCount:1,edited:false});
 expect(output.recordScope).toMatchObject({population:"permitted_registered_records",unrecordedActivity:"unknown"});
 expect(output.summaries[0].summary).toContain("本周一张也没有归档");
 expect(output.originalEvidence.notes).toEqual([expect.objectContaining({date:"2026-11-03",text:expect.stringContaining("10张")})]);
 expect((await store.readTaskDb()).tasks).toEqual([]);expect((await store.readHabitDb()).checkins).toEqual([]);
 expect(await vault.bytes(journal("2026-11-11"))).toBe("虚构其他周原文应保留。");
});

it("rejects task interval preparation before changing records without the fictional marker",async()=>{
 await store.createTask({title:"虚构应保留登记",date:"2026-11-04"});await seedSummary("2026-11-04","虚构旧统计正文。");
 const before=await store.readTaskDb(),path=summaryPath(store,summaryPeriod("week","2026-11-04")),bytes=await vault.bytes(path);
 await expect(prepareTaskIntervalFixture(store)).rejects.toThrow("全虚构夹具");
 expect(await store.readTaskDb()).toEqual(before);expect(await vault.bytes(path)).toBe(bytes);
});

it("removes unrelated old totals only for the isolated task interval scenario's week",async()=>{
 await vault.seed("TEST_VAULT_ONLY.md","内容全部为虚构数据。");
 await seedSummary("2026-11-04","虚构旧任务群体完成26项，完成率70.27%。");
 await seedSummary("2026-11-11","虚构另一周统计应保留。");
 const other=summaryPath(store,summaryPeriod("week","2026-11-11")),bytes=await vault.bytes(other);
 await prepareTaskIntervalFixture(store);
 expect(store.getFile(summaryPath(store,summaryPeriod("week","2026-11-04")))).toBeNull();
 expect(await vault.bytes(other)).toBe(bytes);
 const result=await runtime.executeAiToolCall({id:"fictional-interval-metrics",name:"get_stats",arguments:{domain:"tasks",range:{from:"2026-11-02",to:"2026-11-08"},groupBy:"day"}},"kimi");
 expect(result.success,result.output).toBe(true);
 expect(JSON.parse(result.output)).toMatchObject({plannedCount:1,completedPlannedCount:1,completionPercent:100,averageCompletionMin:1980,completionIntervalSampleCount:1});
});

it("reports edited summary provenance without overwriting the user's additions",async()=>{
 await seedSummary("2026-11-04","纯虚构模型摘要正文。");
 const path=summaryPath(store,summaryPeriod("week","2026-11-04"));
 const edited=(await vault.bytes(path))+"\n\n虚构手工补充：此处等待原文核对。\n";await vault.seed(path,edited);
 const result=await query("fictional-edited-provenance",{range:{from:"2026-11-02",to:"2026-11-08"}});
 expect(result.success,result.output).toBe(true);const output=JSON.parse(result.output);
 expect(output.summaries[0]).toMatchObject({generatedBy:"model",edited:true,inputCount:2});
 expect(output.summaries[0].summary).toContain("虚构手工补充");
 expect(await vault.bytes(path)).toBe(edited);expect(result.receipt).toBeUndefined();
});

it("provides calendar-day counts from actual morning and evening files without changing the originals",async()=>{
 for(let i=2;i<=15;i++)for(const suffix of ["早","晚"])await vault.seed(journal("2026-11-"+String(i).padStart(2,"0"),suffix),
   i===4||i===11?"虚构纸样归档：连续25分钟。":"虚构其他主题。");
 const result=await query("fictional-counted-originals",{includeOriginals:true,query:"纸样 归档"});
 expect(result.success,result.output).toBe(true);const evidence=JSON.parse(result.output).originalEvidence;
 expect(evidence.notes).toHaveLength(4);
 expect(evidence.counts).toMatchObject({requestedDays:14,scopeDays:14,withJournalDays:14,matchedDays:2,unmatchedDays:12,missingDays:0,returnedNotes:4});
 expect(evidence.coverageSummary).toContain("本次覆盖14天");expect(evidence.coverageSummary).toContain("4篇片段");
 expect(await vault.bytes(journal("2026-11-04"))).toBe("虚构纸样归档：连续25分钟。");
});

it("keeps dated original evidence from both weeks when a correction makes the old summaries unavailable",async()=>{
 const id=await memory();
 await vault.seed(journal("2026-11-04"),"纯虚构蓝纸样：完整25分钟完成12张，碎片时间只完成4张。\n\n"+original);
 await vault.seed(journal("2026-11-11"),"纯虚构黄纸样：完整25分钟完成11张，碎片时间只完成3张。");
 await seedSummary("2026-11-04","纯虚构旧摘要与上午时段建议。");await seedSummary("2026-11-11","纯虚构旧摘要与上午时段建议。");
 await store.reviewPersonalMemory(id,{decision:"correct",content:corrected});
 const result=await query();expect(result.success,result.output).toBe(true);const output=JSON.parse(result.output);
 expect(output.summaries).toEqual([]);expect(output.missingPeriods).toEqual(["2026-W45","2026-W46"]);
 expect(output.originalEvidence.notes).toEqual(expect.arrayContaining([
  expect.objectContaining({date:"2026-11-04",path:journal("2026-11-04"),text:expect.stringContaining("12张")}),
  expect.objectContaining({date:"2026-11-11",path:journal("2026-11-11"),text:expect.stringContaining("11张")})
 ]));
 expect(result.output).not.toContain(original);expect(result.output).not.toContain("上午时段建议");
 expect(output.originalEvidence.coverage).toContain("不能");expect(result.receipt).toBeUndefined();expect(result.actions).toEqual([]);
});

it("revalidates the same tool ID after memory corrections and original edits",async()=>{
 const id=await memory();await seedSummary("2026-11-04","纯虚构旧周摘要");
 await vault.seed(journal("2026-11-04"),"纯虚构最新日记原文甲。");
 const first=await query("fictional-repeated-id");expect(JSON.parse(first.output).summaries).toHaveLength(1);
 await store.reviewPersonalMemory(id,{decision:"correct",content:corrected});
 const second=await query("fictional-repeated-id");expect(second.success,second.output).toBe(true);
 expect(second.output).not.toContain("纯虚构旧周摘要");expect(second.output).toContain("原文甲");
 await vault.seed(journal("2026-11-04"),"纯虚构最新日记原文乙。");
 const third=await query("fictional-repeated-id");expect(third.success,third.output).toBe(true);
 expect(third.output).toContain("原文乙");expect(third.output).not.toContain("原文甲");
});

it("holds the actual original versions and refuses later changes before a dependent write",async()=>{
 await vault.seed(journal("2026-11-04"),"纯虚构已核对版本。");let read:VaultQueryRead|undefined;
 const result=await query("fictional-held-summary",{},value=>{read=value;});
 expect(result.success,result.output).toBe(true);expect(read).toBeDefined();
 try{await read!.assertSourcesCurrent();await vault.seed(journal("2026-11-04"),"纯虚构后来改动。");await expect(read!.assertSourcesCurrent()).rejects.toThrow();}
 finally{read?.dispose();}
});

it("does not read excluded, generated, out-of-range or future notes",async()=>{
 const allowed=journal("2026-11-04"),excluded=journal("2026-11-11"),outside=journal("2026-11-01");
 await vault.seed(allowed,"纯虚构允许证据。");await vault.seed(excluded,"纯虚构禁止证据。");await vault.seed(outside,"纯虚构越界证据。");
 await vault.seed(journal("2026-11-22"),"纯虚构未来证据。");
 const generated=store.path(store.settings.folders.aiReports,"Conversations","2026-11-04.md");await vault.seed(generated,"纯虚构生成对话。");
 store.settings.privacy!.excludedVaultPrefixes=[excluded];
 const read=vi.spyOn(vault,"read"),result=await query();expect(result.success,result.output).toBe(true);
 expect(result.output).toContain("纯虚构允许证据");
 for(const path of [excluded,outside,generated,journal("2026-11-22")])expect(read.mock.calls.some(([file])=>file.path===path)).toBe(false);
 expect(result.output).not.toContain("禁止证据");expect(result.output).not.toContain("越界证据");
});

it("requires an explicit request to add originals when all summaries are readable",async()=>{
 await seedSummary("2026-11-04","纯虚构第一周摘要");await seedSummary("2026-11-11","纯虚构第二周摘要");
 await vault.seed(journal("2026-11-04"),"纯虚构完整原话证据。");
 const read=vi.spyOn(vault,"read");expect(JSON.parse((await query()).output).originalEvidence).toBeUndefined();
 expect(read.mock.calls.some(([file])=>file.path===journal("2026-11-04"))).toBe(false);
 const result=await query("fictional-explicit-originals",{includeOriginals:true});
 expect(result.success,result.output).toBe(true);expect(result.output).toContain("纯虚构完整原话证据");
});

it("retains explicit coverage for missing and truncated original evidence without changing notes",async()=>{
 const path=journal("2026-11-04"),raw="纯虚构长篇片段。".repeat(230);await vault.seed(path,raw);
 const result=await query();expect(result.success,result.output).toBe(true);const evidence=JSON.parse(result.output).originalEvidence;
 expect(evidence.notes[0]).toMatchObject({path,truncated:true});expect(evidence.limited).toBe(true);
 expect(evidence.missingDates).toContain("2026-11-05");expect(evidence.missingDates).not.toContain("2026-11-04");
 expect(evidence.eventDates).toBe("未核对");expect(await vault.bytes(path)).toBe(raw);
});

it.each(["虚构纸样归档","纸样 归档 纸样归档"])("finds %s after a long template without presenting its excerpt as the full note",async queryText=>{
 const path=journal("2026-11-04"),raw="纯虚构日记模板与其他内容。".repeat(180)+"\n\n虚构纸样归档：完整25分钟完成11张，碎片时间完成3张。";
 await vault.seed(path,raw);await vault.seed(journal("2026-11-11"),"纯虚构其他主题，不作为纸样证据。");
 const result=await query("fictional-topic-snippet",{query:queryText});expect(result.success,result.output).toBe(true);
 const evidence=JSON.parse(result.output).originalEvidence;
 expect(evidence.notes).toHaveLength(1);expect(evidence.notes[0]).toMatchObject({path,truncated:true,text:expect.stringContaining("完成11张")});
 expect(evidence.query).toBe(queryText);expect(await vault.bytes(path)).toBe(raw);
});

it("explains the single-week tool boundary without incorrectly claiming the operation ledger is damaged",async()=>{
 const result=await runtime.executeAiToolCall({id:"fictional-cross-week-wrong-tool",name:"inspect_weekly_review_sources",
  arguments:{startDate:range.from,endDate:range.to,paths:[journal("2026-11-04")]}},"kimi");
 expect(result.success).toBe(false);expect(result.output).toContain("get_summaries");
 expect(result.output).not.toContain("操作记录无法安全读取");
});

it("distinguishes a topic miss in an existing diary from a date without an available diary",async()=>{
 await vault.seed(journal("2026-11-04"),"虚构纸样归档：25分钟完成12张。");
 await vault.seed(journal("2026-11-11"),"纯虚构今天整理读书卡片，没有提及所问主题。");
 const result=await query("fictional-topic-date-coverage",{query:"纸样归档"});expect(result.success,result.output).toBe(true);
 const evidence=JSON.parse(result.output).originalEvidence;
 expect(evidence.notes).toHaveLength(1);expect(evidence.missingDates).toContain("2026-11-05");
 expect(evidence.missingDates).not.toContain("2026-11-11");expect(evidence.unmatchedDates).toContain("2026-11-11");
 expect(evidence.coverageByDate).toContainEqual({date:"2026-11-11",status:"有日记，可读正文未命中主题"});
});

it("does not describe the already covered summary week as missing original evidence",async()=>{
 await seedSummary("2026-11-04","纯虚构已可读取的第一周总结。");
 await vault.seed(journal("2026-11-04"),"纯虚构不需重复读取的第一周日记。");
 await vault.seed(journal("2026-11-11"),"纯虚构第二周日记可作为补证。");
 const read=vi.spyOn(vault,"read"),result=await query("fictional-covered-week");expect(result.success,result.output).toBe(true);
 const evidence=JSON.parse(result.output).originalEvidence;
 expect(evidence.notes.map((note:{date:string})=>note.date)).toEqual(["2026-11-11"]);
 expect(evidence.missingDates).not.toContain("2026-11-04");
 expect(read.mock.calls.some(([file])=>file.path===journal("2026-11-04"))).toBe(false);
});
