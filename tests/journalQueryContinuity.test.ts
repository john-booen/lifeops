import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DEFAULT_SETTINGS} from '../src/defaults';
import type {StoreHost} from '../src/store/settingsSlice';
import type {AiToolCall} from '../src/ai';
import {readVaultQueryWithSources} from '../src/vaultQuery';
import {captureSummaryQueryScope,summaryQuerySelections,continueJournalQueryDates} from '../src/agent/summaryQueryScope';
vi.mock('obsidian',()=>({App:class{},Notice:class{},TFile:class{},TFolder:class{},Modal:class{},Plugin:class{},
 WorkspaceLeaf:class{},ItemView:class{},PluginSettingTab:class{},Setting:class{},Platform:{isDesktopApp:true},setIcon:vi.fn(),
 normalizePath:(p:string)=>p.replace(/\\/g,'/'),parseYaml:JSON.parse,stringifyYaml:JSON.stringify,
 requestUrl:()=>{throw Error('Only fictional scripted providers are allowed');}}));
const {LifeOpsStore}=await import('../src/store');
const {DiskVault}=await import('./helpers/diskVault');
const {LifeOpsAi}=await import('../src/ai');
const {default:Plugin}=await import('../src/main');
let root:string,store:StoreHost,vault:InstanceType<typeof DiskVault>,plugin:InstanceType<typeof Plugin>;
beforeEach(async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-12T20:00:00+08:00'));vi.stubGlobal('window',globalThis);
 root=await mkdtemp(join(tmpdir(),'lifeops-fictional-query-continuity-'));vault=new DiskVault(root);
 store=new LifeOpsStore({vault,workspace:{getLeavesOfType:()=>[]}}as any,structuredClone(DEFAULT_SETTINGS))as unknown as StoreHost;await store.initializeVault();
 store.settings.ai={...store.settings.ai,provider:'custom',endpoint:'https://fiction.invalid/chat',model:'synthetic',apiKey:'fictional-key',dataDisclosureAccepted:true};store.settings.privacy!.plaintextCredentialStorageAccepted=true;
 plugin=Object.assign(Object.create(Plugin.prototype),{app:store.app,store,settings:store.settings,lifecycleGeneration:1,unloaded:false,
  ai:new LifeOpsAi(store.settings),updateStatusBar:async()=>{},refreshViews:async()=>{},lifeOpsEvents:{publish:()=>{}},buildSemanticContext:async()=>''});
 await vault.seed(store.dailyNotePath('2026-11-03','晚'),'虚构蓝盒归档原话 INSIDE-WEEK');await vault.seed(store.dailyNotePath('2026-11-12','晚'),'虚构蓝盒另一期原话 OUTSIDE-WEEK');
});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();await rm(root,{recursive:true,force:true});});
const read=(id:string,args:Record<string,unknown>)=>({id,name:'query_vault',arguments:{domain:'journal',operation:'search',query:'虚构蓝盒',...args}});
async function scripted(calls:ReturnType<typeof read>[],question:string){
 let step=0;const outputs:string[]=[];vi.spyOn(LifeOpsAi.prototype,'agentTurnStream').mockImplementation(async(messages,onText)=>{
  outputs.splice(0,outputs.length,...messages.filter(m=>m.role==='tool').map(m=>m.content));
  if(step<calls.length)return{content:'',toolCalls:[calls[step++]]};const answer='已核对虚构蓝盒的原话，按实际笔记日期说明，不修改任务。';onText(answer);return{content:answer,toolCalls:[]};
 });
 const execution=vi.spyOn(plugin as unknown as {executeToolCalls:(calls:AiToolCall[],...args:unknown[])=>Promise<unknown>},'executeToolCalls'),tasks=await vault.bytes(store.taskDbPath());
 const result=await plugin.submitAgentMessageStream(question,[],()=>{},{source:'text',selfTest:true});
 expect(result.actions).toEqual([]);expect(result.receipts).toEqual([]);expect(await vault.bytes(store.taskDbPath())).toBe(tasks);
 return{result,outputs,actual:execution.mock.calls.flatMap(call=>call[0])};
}
it('keeps the last-week window when an empty topic search is followed by a looser keyword search',async()=>{
 const {actual,outputs}=await scripted([read('fictional-nothing',{range:'last_week',query:'虚构蓝盒 暂无这个连续词'}),read('fictional-looser',{})],
  '核对上周虚构蓝盒的原话，没有命中时减少关键词继续查，不修改任务。');
 expect(actual[1].arguments.range).toEqual({from:'2026-11-02',to:'2026-11-08'});
 expect(outputs.join('\n')).toContain('INSIDE-WEEK');expect(outputs.join('\n')).not.toContain('OUTSIDE-WEEK');
});
it('honors an explicit all-history selection and clears the former implicit period for later searches',async()=>{
 const {actual,outputs}=await scripted([read('fictional-week',{range:'last_week'}),read('fictional-all',{range:'all'}),read('fictional-after-all',{})],
  '先核对上周虚构蓝盒，再明确查全部日期，最后减少关键词继续全局查询，不修改任务。');
 expect(actual[1].arguments.range).toBe('all');expect(actual[2].arguments.range).toBeUndefined();expect(outputs[1]).toContain('OUTSIDE-WEEK');expect(outputs.at(-1)).toContain('OUTSIDE-WEEK');
});
it('keeps a newly selected explicit day instead of replacing it with an earlier week',async()=>{
 const {actual,outputs}=await scripted([read('fictional-first',{range:'last_week'}),read('fictional-day',{date:'2026-11-12'})],
  '先核对上周虚构蓝盒，再单独核对2026年11月12日的原话，不修改任务。');
 expect(actual[1].arguments.date).toBe('2026-11-12');expect(actual[1].arguments.range).toBeUndefined();expect(outputs.at(-1)).toContain('OUTSIDE-WEEK');
});
it('attests only an owned diary date selection and invalidates it after a source-policy change',async()=>{
 const read=await readVaultQueryWithSources(store,{domain:'journal',operation:'list',range:'last_week'});
 const token=captureSummaryQueryScope(store,read);expect(token).toBeDefined();expect(summaryQuerySelections(store,[token!])).toEqual([{level:'day',range:{from:'2026-11-02',to:'2026-11-08'}}]);
 expect(captureSummaryQueryScope(store,{...read})).toBeUndefined();read.dispose();
 store.settings.privacy!.excludedVaultPrefixes=[store.settings.folders.dailyRoot];expect(summaryQuerySelections(store,[token!])).toEqual([]);
});
it('does not change explicit constraints, other tools or a comparison of multiple selected periods',()=>{
 const selection=[{level:'day' as const,range:{from:'2026-11-02',to:'2026-11-08'}}],call=read('fictional-keyword',{}),before=JSON.stringify(call);
 expect(continueJournalQueryDates([call],selection)[0].arguments.range).toEqual(selection[0].range);expect(JSON.stringify(call)).toBe(before);
 for(const extra of [{range:'all'},{range:'last_month'},{date:'2026-11-12'},{path:'selected.md'},{offset:0},{domain:'note'},{from:'2026-11-01'}]){
  const chosen={...call,arguments:{...call.arguments,...extra}};expect(continueJournalQueryDates([chosen],selection)[0]).toBe(chosen);
 }
 const other={...call,name:'get_stats'};expect(continueJournalQueryDates([other],selection)[0]).toBe(other);
 expect(continueJournalQueryDates([call],[...selection,{level:'day',range:{from:'2026-10-01',to:'2026-10-31'}}])[0]).toBe(call);
});
