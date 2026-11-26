import{mkdtemp,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import type{App}from'obsidian';import{beforeEach,afterEach,it,expect,vi}from'vitest';
import{DEFAULT_SETTINGS}from'../src/defaults';import type{StoreHost}from'../src/store/settingsSlice';
vi.mock('obsidian',()=>({App:class{},Notice:class{},TFile:class{},TFolder:class{},normalizePath:(path:string)=>path,parseYaml:JSON.parse,stringifyYaml:JSON.stringify}));
const{LifeOpsStore}=await import('../src/store');const{DiskVault}=await import('./helpers/diskVault');
const{readSummaryQueryWithSources}=await import('../src/features/summaries/read');const{summaryPeriod}=await import('../src/features/summaries/periods');const{readSummaryScope,summaryPath,renderSummary}=await import('../src/features/summaries/notes');
let root:string,vault:InstanceType<typeof DiskVault>,store:StoreHost;const period=summaryPeriod('month','2026-11-01'),body='虚构完整回顾：交易三胜两负，规则遵守率90%，还有一个未被询问的安排。',journal='虚构原话：今天只在卡片上画了一只纸鹤。';
beforeEach(async()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-12T20:00:00+08:00'));root=await mkdtemp(join(tmpdir(),'lifeops-summary-metric-projection-'));vault=new DiskVault(root);store=new LifeOpsStore({vault}as unknown as App,structuredClone(DEFAULT_SETTINGS))as unknown as StoreHost;await store.initializeVault();await vault.seed(store.dailyNotePath('2026-11-11','晚'),journal);});
afterEach(async()=>{vi.useRealTimers();vi.restoreAllMocks();await rm(root,{recursive:true,force:true});});
async function seed(){const scope=await readSummaryScope(store);await vault.seed(summaryPath(store,period),renderSummary(period,'2026-11-12',scope.hash,{tasksCompleted:46,taskCompletionPercent:57.5,energy:7,tradePnlCny:180,tradePnlUsd:120},2,false,'local',body));}
async function query(extra:Record<string,unknown>={}){const read=await readSummaryQueryWithSources(store,{level:'month',range:'this_month',...extra});try{return JSON.parse(read.text);}finally{read.dispose();}}
it('returns only the selected metric values with the original period and through, without review text or diary reads',async()=>{
 await seed();const read=vi.spyOn(vault,'read'),before=await store.readPath(store.taskDbPath()),fields=['tasksCompleted','tradePnlCny','tradePnlUsd'];read.mockClear();const data=await query({metrics:fields});expect(data.requestedMetrics).toEqual(fields);expect(data.summaries).toHaveLength(1);expect(data.summaries[0]).toMatchObject({period:'2026-11',from:'2026-11-01',through:'2026-11-12',complete:false,metrics:{tasksCompleted:46,tradePnlCny:180,tradePnlUsd:120}});expect(data.summaries[0].summary).toBeUndefined();expect(Object.keys(data.summaries[0].metrics).sort()).toEqual([...fields].sort());expect(JSON.stringify(data)).not.toContain(body);expect(JSON.stringify(data)).not.toContain(journal);expect(data.originalEvidence).toBeUndefined();expect(read.mock.calls.some(([file])=>file.path===store.dailyNotePath('2026-11-11','晚'))).toBe(false);expect(await store.readPath(store.taskDbPath())).toBe(before);
});
it('keeps the full review unchanged when metric selection was not requested',async()=>{
 await seed();const data=await query();expect(data.requestedMetrics).toBeUndefined();expect(data.summaries[0].summary).toContain(body);expect(data.summaries[0].metrics).toMatchObject({taskCompletionPercent:57.5,energy:7,tasksCompleted:46});
});
it('reports a legacy absent metric as unknown and never substitutes another metric or zero',async()=>{
 await seed();const data=await query({metrics:['taskCompletionEvents']});expect(data.summaries[0].metrics).toEqual({taskCompletionEvents:null});expect(data.summaries[0].summary).toBeUndefined();
});
it('missing summaries in a metric query do not silently read diary bodies or turn missing periods into zero',async()=>{
 const read=vi.spyOn(vault,'read'),data=await query({metrics:['tasksCompleted']});expect(data.summaries).toEqual([]);expect(data.missingPeriods).toEqual(['2026-11']);expect(data.originalEvidence).toBeUndefined();expect(JSON.stringify(data)).not.toContain(journal);expect(read.mock.calls.some(([file])=>file.path===store.dailyNotePath('2026-11-11','晚'))).toBe(false);
});
it('still reads allowed originals when explicitly requested with selected metrics',async()=>{
 await seed();const data=await query({metrics:['tasksCompleted'],includeOriginals:true});expect(data.summaries[0].metrics).toEqual({tasksCompleted:46});expect(data.summaries[0].summary).toBeUndefined();expect(data.originalEvidence.notes.some((note:{text:string})=>note.text.includes(journal))).toBe(true);
});
it('retains source continuity after projecting numeric fields',async()=>{
 await seed();const read=await readSummaryQueryWithSources(store,{level:'month',range:'this_month',metrics:['tasksCompleted']});try{await vault.seed(summaryPath(store,period),(await store.readPath(summaryPath(store,period)))+'\n虚构源在读回后变化');await expect(read.assertSourcesCurrent()).rejects.toThrow();}finally{read.dispose();}
});
for(const metrics of [[],['tasksCompleted','tasksCompleted'],['not_a_metric'],['__proto__'],'tasksCompleted',[null]])it('rejects malformed metric selection before any source read: '+JSON.stringify(metrics),async()=>{
 await seed();const read=vi.spyOn(vault,'read');await expect(query({metrics})).rejects.toThrow('指标');expect(read).not.toHaveBeenCalled();
});
